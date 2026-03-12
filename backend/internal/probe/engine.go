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

type probeStore interface {
	ListProbeTargets(ctx context.Context, scope string, groupIDs []int64) ([]store.ProbeTarget, error)
	RecordPingResult(ctx context.Context, result model.PingResult) error
}

type packetConn interface {
	Close() error
	ReadFrom(b []byte) (int, net.Addr, error)
	SetDeadline(t time.Time) error
	WriteTo(b []byte, dst net.Addr) (int, error)
}

type packetConnFactory func() (packetConn, error)

type pendingProbe struct {
	replyCh chan replyInfo
	sentAt  time.Time
}

type replyInfo struct {
	latencyMs float64
	replyIP   string
	ttl       *int
}

type roundStats struct {
	targetCount       int
	successCount      int64
	failureCount      int64
	persistErrorCount int64
}

type Engine struct {
	store   probeStore
	hub     *telemetry.Hub
	workers int

	settings          atomic.Value // model.Settings
	seq               atomic.Uint32
	roundSeq          atomic.Uint64
	engineID          int
	packetConnFactory packetConnFactory

	mu       sync.Mutex
	running  bool
	cancel   context.CancelFunc
	scope    string
	groupIDs []int64
	conn     packetConn
	recvDone chan struct{}
	loopDone chan struct{}

	pendingMu sync.Mutex
	pending   map[int]*pendingProbe
}

type Status struct {
	Running  bool
	Scope    string
	GroupIDs []int64
}

func NewEngine(st *store.Store, hub *telemetry.Hub, workers int, initialSettings model.Settings) *Engine {
	return newEngineWithDeps(st, hub, workers, initialSettings, defaultPacketConnFactory)
}

func newEngineWithDeps(st probeStore, hub *telemetry.Hub, workers int, initialSettings model.Settings, factory packetConnFactory) *Engine {
	engine := &Engine{
		store:             st,
		hub:               hub,
		workers:           workers,
		engineID:          os.Getpid() & 0xffff,
		packetConnFactory: factory,
		pending:           map[int]*pendingProbe{},
	}
	engine.settings.Store(initialSettings)
	return engine
}

func defaultPacketConnFactory() (packetConn, error) {
	return icmp.ListenPacket("ip4:icmp", "0.0.0.0")
}

func (e *Engine) Start(scope string, groupIDs []int64) error {
	if scope != "all" && scope != "groups" {
		return errors.New("scope must be all or groups")
	}
	if scope == "groups" && len(groupIDs) == 0 {
		return errors.New("group_ids required for groups scope")
	}

	e.Stop()

	conn, err := e.packetConnFactory()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithCancel(context.Background())
	recvDone := make(chan struct{})
	loopDone := make(chan struct{})

	e.clearPending()

	e.mu.Lock()
	e.cancel = cancel
	e.scope = scope
	e.groupIDs = append([]int64{}, groupIDs...)
	e.running = true
	e.conn = conn
	e.recvDone = recvDone
	e.loopDone = loopDone
	e.mu.Unlock()

	log.Printf("probe engine start scope=%s group_ids=%v", scope, groupIDs)
	go e.receiveLoop(ctx, conn, recvDone)
	go e.loop(ctx, loopDone)
	return nil
}

func (e *Engine) Stop() bool {
	e.mu.Lock()
	if !e.running {
		e.mu.Unlock()
		return false
	}

	cancel := e.cancel
	conn := e.conn
	recvDone := e.recvDone
	loopDone := e.loopDone

	e.running = false
	e.cancel = nil
	e.scope = ""
	e.groupIDs = nil
	e.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if conn != nil {
		_ = conn.Close()
	}
	if loopDone != nil {
		<-loopDone
	}
	if recvDone != nil {
		<-recvDone
	}

	e.mu.Lock()
	if e.conn == conn {
		e.conn = nil
	}
	if e.recvDone == recvDone {
		e.recvDone = nil
	}
	if e.loopDone == loopDone {
		e.loopDone = nil
	}
	e.mu.Unlock()

	e.clearPending()
	log.Printf("probe engine stopped")
	return true
}

func (e *Engine) IsRunning() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.running
}

func (e *Engine) Status() Status {
	e.mu.Lock()
	defer e.mu.Unlock()

	status := Status{
		Running:  e.running,
		Scope:    "",
		GroupIDs: []int64{},
	}
	if !e.running {
		return status
	}
	status.Scope = e.scope
	status.GroupIDs = append(status.GroupIDs, e.groupIDs...)
	return status
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

func (e *Engine) loop(ctx context.Context, done chan struct{}) {
	defer close(done)

	settings := e.CurrentSettings()
	log.Printf(
		"probe loop started interval_sec=%d payload_bytes=%d timeout_ms=%d workers=%d",
		settings.PingIntervalSec,
		settings.ICMPPayloadSize,
		settings.ICMPTimeoutMs,
		e.workers,
	)

	for {
		if ctx.Err() != nil {
			log.Printf("probe loop exited")
			return
		}

		settings = e.CurrentSettings()
		interval := time.Duration(settings.PingIntervalSec) * time.Second
		roundID := e.roundSeq.Add(1)
		started := time.Now()

		stats := e.runRound(ctx, roundID, settings)
		duration := time.Since(started)
		overrun := duration > interval

		log.Printf(
			"probe round finished round_id=%d duration_ms=%d overrun=%t targets=%d successes=%d failures=%d persist_failures=%d",
			roundID,
			duration.Milliseconds(),
			overrun,
			stats.targetCount,
			stats.successCount,
			stats.failureCount,
			stats.persistErrorCount,
		)

		wait := interval - duration
		if wait < 0 {
			wait = 0
		}

		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			log.Printf("probe loop exited")
			return
		case <-timer.C:
		}
	}
}

func (e *Engine) receiveLoop(ctx context.Context, conn packetConn, done chan struct{}) {
	defer close(done)

	buffer := make([]byte, 1500)
	for {
		n, peer, err := conn.ReadFrom(buffer)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}

			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				continue
			}

			log.Printf("probe receive failed: %v", err)
			continue
		}

		parsed, err := icmp.ParseMessage(ipv4.ICMPTypeEchoReply.Protocol(), buffer[:n])
		if err != nil || parsed.Type != ipv4.ICMPTypeEchoReply {
			continue
		}

		echo, ok := parsed.Body.(*icmp.Echo)
		if !ok || echo.ID != e.engineID {
			continue
		}

		pending := e.lookupPendingProbe(echo.Seq)
		if pending == nil {
			continue
		}

		replyIP := ""
		if ipAddr, ok := peer.(*net.IPAddr); ok && ipAddr.IP != nil {
			replyIP = ipAddr.IP.String()
		}

		reply := replyInfo{
			latencyMs: time.Since(pending.sentAt).Seconds() * 1000,
			replyIP:   replyIP,
			ttl:       nil,
		}

		select {
		case pending.replyCh <- reply:
		default:
		}
	}
}

func (e *Engine) runRound(ctx context.Context, roundID uint64, settings model.Settings) roundStats {
	e.mu.Lock()
	scope := e.scope
	groupIDs := append([]int64{}, e.groupIDs...)
	e.mu.Unlock()

	targets, err := e.store.ListProbeTargets(ctx, scope, groupIDs)
	if err != nil {
		if ctx.Err() != nil {
			return roundStats{}
		}
		log.Printf("probe round target lookup failed round_id=%d: %v", roundID, err)
		e.hub.Broadcast(map[string]any{
			"type":      "probe_error",
			"message":   fmt.Sprintf("failed to list probe targets: %v", err),
			"timestamp": time.Now().UTC(),
		})
		return roundStats{}
	}
	if len(targets) == 0 {
		log.Printf("probe round skipped round_id=%d: no targets (scope=%s)", roundID, scope)
		return roundStats{}
	}

	log.Printf(
		"probe round started round_id=%d targets=%d scope=%s timeout_ms=%d workers=%d",
		roundID,
		len(targets),
		scope,
		settings.ICMPTimeoutMs,
		e.workerCount(len(targets)),
	)

	var successCount atomic.Int64
	var failureCount atomic.Int64
	var persistErrorCount atomic.Int64

	jobs := make(chan store.ProbeTarget)
	workerCount := e.workerCount(len(targets))

	wg := sync.WaitGroup{}
	for i := 0; i < workerCount; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()

			for {
				select {
				case <-ctx.Done():
					return
				case target, ok := <-jobs:
					if !ok {
						return
					}

					result, canceled := e.probeTarget(ctx, target, settings)
					if canceled {
						return
					}

					if err := e.store.RecordPingResult(ctx, result); err != nil {
						if ctx.Err() != nil {
							return
						}

						persistErrorCount.Add(1)
						log.Printf("probe persist failed round_id=%d endpoint_id=%d ip=%s err=%v", roundID, target.EndpointID, target.IP, err)
						e.hub.Broadcast(map[string]any{
							"type":        "probe_error",
							"endpoint_id": target.EndpointID,
							"message":     fmt.Sprintf("persist ping failed: %v", err),
							"timestamp":   time.Now().UTC(),
						})
						continue
					}

					if ctx.Err() != nil {
						return
					}

					status := "failed"
					if result.Success {
						status = "succeeded"
						successCount.Add(1)
					} else {
						failureCount.Add(1)
					}

					e.hub.Broadcast(map[string]any{
						"type":        "probe_update",
						"endpoint_id": result.EndpointID,
						"ip":          target.IP,
						"status":      status,
						"latency_ms":  result.LatencyMs,
						"timestamp":   result.Timestamp,
					})
				}
			}
		}()
	}

	for _, target := range targets {
		select {
		case <-ctx.Done():
			close(jobs)
			wg.Wait()
			return roundStats{
				targetCount:       len(targets),
				successCount:      successCount.Load(),
				failureCount:      failureCount.Load(),
				persistErrorCount: persistErrorCount.Load(),
			}
		case jobs <- target:
		}
	}

	close(jobs)
	wg.Wait()

	return roundStats{
		targetCount:       len(targets),
		successCount:      successCount.Load(),
		failureCount:      failureCount.Load(),
		persistErrorCount: persistErrorCount.Load(),
	}
}

func (e *Engine) workerCount(targetCount int) int {
	if targetCount < 1 {
		return 0
	}
	if e.workers < 1 {
		return 1
	}
	if e.workers > targetCount {
		return targetCount
	}
	return e.workers
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

	conn := e.currentConn()
	if conn == nil {
		if ctx.Err() != nil {
			return nil, nil, nil, context.Canceled
		}
		return nil, nil, nil, fmt.Errorf("probe socket unavailable")
	}

	seq, pending, err := e.registerPendingProbe()
	if err != nil {
		return nil, nil, nil, err
	}
	defer e.unregisterPendingProbe(seq, pending)

	payload := bytes.Repeat([]byte{0x42}, payloadSize)
	msg := icmp.Message{
		Type: ipv4.ICMPTypeEcho,
		Code: 0,
		Body: &icmp.Echo{
			ID:   e.engineID,
			Seq:  seq,
			Data: payload,
		},
	}

	wire, err := msg.Marshal(nil)
	if err != nil {
		return nil, nil, nil, err
	}

	if _, err := conn.WriteTo(wire, &net.IPAddr{IP: parsedIP}); err != nil {
		if ctx.Err() != nil {
			return nil, nil, nil, context.Canceled
		}
		return nil, nil, nil, err
	}

	timer := time.NewTimer(time.Duration(timeoutMs) * time.Millisecond)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return nil, nil, nil, context.Canceled
	case <-timer.C:
		return nil, nil, nil, context.DeadlineExceeded
	case reply := <-pending.replyCh:
		replyIP := reply.replyIP
		if replyIP == "" {
			replyIP = ip
		}
		latency := reply.latencyMs
		return &latency, &replyIP, reply.ttl, nil
	}
}

func (e *Engine) currentConn() packetConn {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.conn
}

func (e *Engine) registerPendingProbe() (int, *pendingProbe, error) {
	e.pendingMu.Lock()
	defer e.pendingMu.Unlock()

	for attempts := 0; attempts < 65535; attempts++ {
		seq := int(e.seq.Add(1) % 65535)
		if seq == 0 {
			continue
		}
		if _, exists := e.pending[seq]; exists {
			continue
		}

		pending := &pendingProbe{
			replyCh: make(chan replyInfo, 1),
			sentAt:  time.Now(),
		}
		e.pending[seq] = pending
		return seq, pending, nil
	}

	return 0, nil, errors.New("no icmp sequence slots available")
}

func (e *Engine) lookupPendingProbe(seq int) *pendingProbe {
	e.pendingMu.Lock()
	defer e.pendingMu.Unlock()
	return e.pending[seq]
}

func (e *Engine) unregisterPendingProbe(seq int, pending *pendingProbe) {
	e.pendingMu.Lock()
	defer e.pendingMu.Unlock()

	if current, ok := e.pending[seq]; ok && current == pending {
		delete(e.pending, seq)
	}
}

func (e *Engine) clearPending() {
	e.pendingMu.Lock()
	defer e.pendingMu.Unlock()
	e.pending = map[int]*pendingProbe{}
}

func (e *Engine) pendingCount() int {
	e.pendingMu.Lock()
	defer e.pendingMu.Unlock()
	return len(e.pending)
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
