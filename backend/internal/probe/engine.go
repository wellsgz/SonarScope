package probe

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"

	"sonarscope/backend/internal/model"
	"sonarscope/backend/internal/store"
	"sonarscope/backend/internal/telemetry"
)

type Engine struct {
	store   *store.Store
	hub     *telemetry.Hub
	workers int

	settings atomic.Value // model.Settings
	seq      atomic.Uint32
	roundSeq atomic.Uint64

	activeRounds atomic.Int64

	mu       sync.Mutex
	running  bool
	cancel   context.CancelFunc
	scope    string
	groupIDs []int64
}

func NewEngine(st *store.Store, hub *telemetry.Hub, workers int, initialSettings model.Settings) *Engine {
	engine := &Engine{
		store:   st,
		hub:     hub,
		workers: workers,
	}
	engine.settings.Store(initialSettings)
	return engine
}

func (e *Engine) Start(scope string, groupIDs []int64) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if scope != "all" && scope != "groups" {
		return errors.New("scope must be all or groups")
	}
	if scope == "groups" && len(groupIDs) == 0 {
		return errors.New("group_ids required for groups scope")
	}

	if e.running {
		e.cancel()
		e.running = false
	}

	ctx, cancel := context.WithCancel(context.Background())
	e.cancel = cancel
	e.scope = scope
	e.groupIDs = append([]int64{}, groupIDs...)
	e.running = true

	log.Printf("probe engine start scope=%s group_ids=%v", scope, groupIDs)
	go e.loop(ctx)
	return nil
}

func (e *Engine) Stop() bool {
	e.mu.Lock()
	defer e.mu.Unlock()

	if !e.running {
		return false
	}
	e.cancel()
	e.running = false
	log.Printf("probe engine stopped")
	return true
}

func (e *Engine) IsRunning() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.running
}

func (e *Engine) UpdateSettings(settings model.Settings) {
	e.settings.Store(settings)
}

func (e *Engine) CurrentSettings() model.Settings {
	value := e.settings.Load()
	if value == nil {
		return model.Settings{
			PingIntervalSec: 1,
			ICMPPayloadSize: 56,
			ICMPTimeoutMs:   500,
			AutoRefreshSec:  10,
		}
	}
	return value.(model.Settings)
}

func (e *Engine) loop(ctx context.Context) {
	settings := e.CurrentSettings()
	interval := time.Duration(settings.PingIntervalSec) * time.Second
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	log.Printf("probe loop started interval_sec=%d payload_bytes=%d timeout_ms=%d", settings.PingIntervalSec, settings.ICMPPayloadSize, settings.ICMPTimeoutMs)
	e.launchRound(ctx, settings)

	for {
		select {
		case <-ctx.Done():
			log.Printf("probe loop exited")
			return
		case <-ticker.C:
			updatedSettings := e.CurrentSettings()
			if updatedSettings.PingIntervalSec != settings.PingIntervalSec {
				interval = time.Duration(updatedSettings.PingIntervalSec) * time.Second
				ticker.Reset(interval)
			}
			settings = updatedSettings
			e.launchRound(ctx, settings)
		}
	}
}

func (e *Engine) launchRound(ctx context.Context, settings model.Settings) {
	roundID := e.roundSeq.Add(1)
	active := e.activeRounds.Add(1)
	started := time.Now()
	if active > 1 {
		log.Printf("probe round overlap detected round_id=%d active_rounds=%d", roundID, active)
	}

	go func() {
		defer func() {
			duration := time.Since(started)
			remaining := e.activeRounds.Add(-1)
			overrun := duration > time.Duration(settings.PingIntervalSec)*time.Second
			log.Printf("probe round finished round_id=%d duration_ms=%d overrun=%t active_rounds=%d", roundID, duration.Milliseconds(), overrun, remaining)
		}()

		e.runRound(ctx, roundID, settings)
	}()
}

func (e *Engine) runRound(ctx context.Context, roundID uint64, settings model.Settings) {
	e.mu.Lock()
	scope := e.scope
	groupIDs := append([]int64{}, e.groupIDs...)
	e.mu.Unlock()

	targets, err := e.store.ListProbeTargets(ctx, scope, groupIDs)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		log.Printf("probe round target lookup failed round_id=%d: %v", roundID, err)
		e.hub.Broadcast(map[string]any{
			"type":      "probe_error",
			"message":   fmt.Sprintf("failed to list probe targets: %v", err),
			"timestamp": time.Now().UTC(),
		})
		return
	}
	if len(targets) == 0 {
		log.Printf("probe round skipped round_id=%d: no targets (scope=%s)", roundID, scope)
		return
	}
	log.Printf("probe round started round_id=%d targets=%d scope=%s timeout_ms=%d", roundID, len(targets), scope, settings.ICMPTimeoutMs)

	wg := sync.WaitGroup{}
	for _, target := range targets {
		if ctx.Err() != nil {
			break
		}

		currentTarget := target
		wg.Add(1)
		go func() {
			defer wg.Done()

			if ctx.Err() != nil {
				return
			}

			result, canceled := e.probeTarget(ctx, currentTarget, settings)
			if canceled {
				return
			}

			if err := e.store.RecordPingResult(ctx, result); err != nil {
				if ctx.Err() != nil {
					return
				}
				log.Printf("probe persist failed round_id=%d endpoint_id=%d ip=%s err=%v", roundID, currentTarget.EndpointID, currentTarget.IP, err)
				e.hub.Broadcast(map[string]any{
					"type":        "probe_error",
					"endpoint_id": currentTarget.EndpointID,
					"message":     fmt.Sprintf("persist ping failed: %v", err),
					"timestamp":   time.Now().UTC(),
				})
				return
			}

			if ctx.Err() != nil {
				return
			}

			status := "failed"
			if result.Success {
				status = "succeeded"
			}
			log.Printf("probe result round_id=%d endpoint_id=%d ip=%s status=%s latency_ms=%v", roundID, currentTarget.EndpointID, currentTarget.IP, status, result.LatencyMs)

			e.hub.Broadcast(map[string]any{
				"type":        "probe_update",
				"endpoint_id": result.EndpointID,
				"ip":          currentTarget.IP,
				"status":      status,
				"latency_ms":  result.LatencyMs,
				"timestamp":   result.Timestamp,
			})
		}()
	}

	wg.Wait()
}

func (e *Engine) probeTarget(ctx context.Context, target store.ProbeTarget, settings model.Settings) (model.PingResult, bool) {
	now := time.Now().UTC()
	latency, replyIP, ttl, err := e.sendICMPEcho(ctx, target.IP, settings.ICMPPayloadSize, settings.ICMPTimeoutMs)
	if err != nil && errors.Is(err, context.Canceled) {
		return model.PingResult{}, true
	}

	result := model.PingResult{
		EndpointID:   target.EndpointID,
		Timestamp:    now,
		Success:      err == nil,
		LatencyMs:    latency,
		ReplyIP:      replyIP,
		TTL:          ttl,
		PayloadBytes: settings.ICMPPayloadSize,
	}
	if err != nil {
		result.ErrorCode = mapProbeError(err)
	}
	return result, false
}

func (e *Engine) sendICMPEcho(ctx context.Context, ip string, payloadSize, timeoutMs int) (*float64, *string, *int, error) {
	parsedIP := net.ParseIP(ip)
	if parsedIP == nil {
		return nil, nil, nil, fmt.Errorf("invalid target ip")
	}
	if ctx.Err() != nil {
		return nil, nil, nil, context.Canceled
	}

	conn, err := icmp.ListenPacket("ip4:icmp", "0.0.0.0")
	if err != nil {
		return nil, nil, nil, err
	}
	defer func() { _ = conn.Close() }()

	cancelWatchDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.SetDeadline(time.Now())
		case <-cancelWatchDone:
		}
	}()
	defer close(cancelWatchDone)

	probeDeadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	if d, ok := ctx.Deadline(); ok && d.Before(probeDeadline) {
		probeDeadline = d
	}
	if err := conn.SetDeadline(probeDeadline); err != nil {
		return nil, nil, nil, err
	}

	seq := int(e.seq.Add(1) % 65535)
	id := os.Getpid() & 0xffff
	payload := bytes.Repeat([]byte{0x42}, payloadSize)

	msg := icmp.Message{
		Type: ipv4.ICMPTypeEcho,
		Code: 0,
		Body: &icmp.Echo{
			ID:   id,
			Seq:  seq,
			Data: payload,
		},
	}
	wire, err := msg.Marshal(nil)
	if err != nil {
		return nil, nil, nil, err
	}

	start := time.Now()
	if _, err := conn.WriteTo(wire, &net.IPAddr{IP: parsedIP}); err != nil {
		if ctx.Err() != nil {
			return nil, nil, nil, context.Canceled
		}
		return nil, nil, nil, err
	}

	buffer := make([]byte, 1500)
	for {
		n, peer, err := conn.ReadFrom(buffer)
		if err != nil {
			if ctx.Err() != nil {
				return nil, nil, nil, context.Canceled
			}
			return nil, nil, nil, err
		}

		parsed, err := icmp.ParseMessage(ipv4.ICMPTypeEchoReply.Protocol(), buffer[:n])
		if err != nil {
			continue
		}
		if parsed.Type != ipv4.ICMPTypeEchoReply {
			continue
		}

		echo, ok := parsed.Body.(*icmp.Echo)
		if !ok {
			continue
		}
		if echo.ID != id || echo.Seq != seq {
			continue
		}

		elapsed := time.Since(start).Seconds() * 1000
		reply := ""
		if ipAddr, ok := peer.(*net.IPAddr); ok && ipAddr.IP != nil {
			reply = ipAddr.IP.String()
		}
		if reply == "" {
			reply = ip
		}
		lat := elapsed
		return &lat, &reply, nil, nil
	}
}

func mapProbeError(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "Request Timeout"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "Request Timeout"
	}
	errText := strings.ToLower(err.Error())
	if strings.Contains(errText, "operation not permitted") || strings.Contains(errText, "permission") {
		return "Permission Denied"
	}
	return "Probe Error"
}
