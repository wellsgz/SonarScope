package probe

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"math/rand"
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
	timeout time.Duration

	settings atomic.Value // model.Settings
	seq      atomic.Uint32

	mu       sync.Mutex
	running  bool
	cancel   context.CancelFunc
	scope    string
	groupIDs []int64

	randMu sync.Mutex
	rand   *rand.Rand
}

func NewEngine(st *store.Store, hub *telemetry.Hub, workers int, timeout time.Duration, initialSettings model.Settings) *Engine {
	engine := &Engine{
		store:   st,
		hub:     hub,
		workers: workers,
		timeout: timeout,
		rand:    rand.New(rand.NewSource(time.Now().UnixNano())),
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
		return model.Settings{PingIntervalSec: 1, ICMPPayloadSize: 56, AutoRefreshSec: 10}
	}
	return value.(model.Settings)
}

func (e *Engine) loop(ctx context.Context) {
	settings := e.CurrentSettings()
	ticker := time.NewTicker(time.Duration(settings.PingIntervalSec) * time.Second)
	defer ticker.Stop()

	log.Printf("probe loop started interval_sec=%d payload_bytes=%d", settings.PingIntervalSec, settings.ICMPPayloadSize)
	e.runRound(ctx, settings)

	for {
		select {
		case <-ctx.Done():
			log.Printf("probe loop exited")
			return
		case <-ticker.C:
			updatedSettings := e.CurrentSettings()
			if updatedSettings.PingIntervalSec != settings.PingIntervalSec {
				ticker.Reset(time.Duration(updatedSettings.PingIntervalSec) * time.Second)
				settings = updatedSettings
			} else {
				settings = updatedSettings
			}

			e.runRound(ctx, settings)
		}
	}
}

func (e *Engine) runRound(ctx context.Context, settings model.Settings) {
	e.mu.Lock()
	scope := e.scope
	groupIDs := append([]int64{}, e.groupIDs...)
	e.mu.Unlock()

	targets, err := e.store.ListProbeTargets(ctx, scope, groupIDs)
	if err != nil {
		log.Printf("probe round target lookup failed: %v", err)
		e.hub.Broadcast(map[string]any{
			"type":      "probe_error",
			"message":   fmt.Sprintf("failed to list probe targets: %v", err),
			"timestamp": time.Now().UTC(),
		})
		return
	}
	if len(targets) == 0 {
		log.Printf("probe round skipped: no targets (scope=%s)", scope)
		return
	}
	log.Printf("probe round started: targets=%d scope=%s", len(targets), scope)

	workerCount := e.workers
	if workerCount > len(targets) {
		workerCount = len(targets)
	}
	if workerCount < 1 {
		workerCount = 1
	}

	jobs := make(chan store.ProbeTarget, len(targets))
	wg := sync.WaitGroup{}

	for i := 0; i < workerCount; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for target := range jobs {
				if ctx.Err() != nil {
					return
				}
				e.sleepJitter(ctx, settings.PingIntervalSec)
				result := e.probeTarget(ctx, target, settings)
				if err := e.store.RecordPingResult(ctx, result); err != nil {
					log.Printf("probe persist failed endpoint_id=%d ip=%s err=%v", target.EndpointID, target.IP, err)
					e.hub.Broadcast(map[string]any{
						"type":        "probe_error",
						"endpoint_id": target.EndpointID,
						"message":     fmt.Sprintf("persist ping failed: %v", err),
						"timestamp":   time.Now().UTC(),
					})
					continue
				}

				status := "failed"
				if result.Success {
					status = "succeeded"
				}
				log.Printf("probe result endpoint_id=%d ip=%s status=%s latency_ms=%v", target.EndpointID, target.IP, status, result.LatencyMs)

				e.hub.Broadcast(map[string]any{
					"type":        "probe_update",
					"endpoint_id": result.EndpointID,
					"ip":          target.IP,
					"status":      status,
					"latency_ms":  result.LatencyMs,
					"timestamp":   result.Timestamp,
				})
			}
		}()
	}

	for _, target := range targets {
		select {
		case <-ctx.Done():
			close(jobs)
			wg.Wait()
			return
		case jobs <- target:
		}
	}
	close(jobs)
	wg.Wait()
}

func (e *Engine) sleepJitter(ctx context.Context, intervalSec int) {
	maxJitterMs := 250
	if intervalSec <= 1 {
		maxJitterMs = 100
	} else if intervalSec > 1 {
		maxJitterMs = min(500, intervalSec*300)
	}

	e.randMu.Lock()
	jitterMs := e.rand.Intn(maxJitterMs + 1)
	e.randMu.Unlock()

	timer := time.NewTimer(time.Duration(jitterMs) * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-timer.C:
		return
	}
}

func (e *Engine) probeTarget(ctx context.Context, target store.ProbeTarget, settings model.Settings) model.PingResult {
	now := time.Now().UTC()
	latency, replyIP, ttl, err := e.sendICMPEcho(ctx, target.IP, settings.ICMPPayloadSize)
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
	return result
}

func (e *Engine) sendICMPEcho(ctx context.Context, ip string, payloadSize int) (*float64, *string, *int, error) {
	parsedIP := net.ParseIP(ip)
	if parsedIP == nil {
		return nil, nil, nil, fmt.Errorf("invalid target ip")
	}

	conn, err := icmp.ListenPacket("ip4:icmp", "0.0.0.0")
	if err != nil {
		return nil, nil, nil, err
	}
	defer func() { _ = conn.Close() }()

	deadline := time.Now().Add(e.timeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := conn.SetDeadline(deadline); err != nil {
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
		return nil, nil, nil, err
	}

	buffer := make([]byte, 1500)
	for {
		n, peer, err := conn.ReadFrom(buffer)
		if err != nil {
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

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
