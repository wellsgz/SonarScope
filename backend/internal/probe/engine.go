package probe

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"sort"
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
	RecordPingResultsBatch(ctx context.Context, results []model.PingResult) error
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

type pacedProbeJob struct {
	target store.ProbeTarget
}

type resultEnvelope struct {
	targetIP string
	result   model.PingResult
	tracker  *roundTracker
}

type Options struct {
	ProbeWorkers        int
	ResultWorkers       int
	ResultQueueSize     int
	ResultBatchSize     int
	ResultFlushInterval time.Duration
}

type roundTracker struct {
	roundID      uint64
	startedAt    time.Time
	interval     time.Duration
	targetCount  atomic.Int64
	dispatched   atomic.Int64
	expected     atomic.Int64
	successes    atomic.Int64
	failures     atomic.Int64
	persistErrs  atomic.Int64
	backpressure atomic.Int64
	pendingPeak  atomic.Int64
	queuePeak    atomic.Int64

	firstDispatchNs atomic.Int64
	lastDispatchNs  atomic.Int64
	sendSlipMaxNs   atomic.Int64

	batchCount        atomic.Int64
	batchMax          atomic.Int64
	handledResults    atomic.Int64
	persistDurationNs atomic.Int64

	probeDurationNs atomic.Int64
	overrun         atomic.Bool
	logged          atomic.Bool
}

type Engine struct {
	store probeStore
	hub   *telemetry.Hub

	probeWorkers        int
	resultWorkers       int
	resultQueueSize     int
	resultBatchSize     int
	resultFlushInterval time.Duration

	settings          atomic.Value // model.Settings
	seq               atomic.Uint32
	roundSeq          atomic.Uint64
	engineID          int
	packetConnFactory packetConnFactory

	mu         sync.Mutex
	running    bool
	cancel     context.CancelFunc
	scope      string
	groupIDs   []int64
	conn       packetConn
	recvDone   chan struct{}
	loopDone   chan struct{}
	resultCh   chan resultEnvelope
	resultDone chan struct{}

	pendingMu sync.Mutex
	pending   map[int]*pendingProbe

	roundMu     sync.Mutex
	activeRound *roundTracker
}

type Status struct {
	Running  bool
	Scope    string
	GroupIDs []int64
}

func NewEngine(st *store.Store, hub *telemetry.Hub, options Options, initialSettings model.Settings) *Engine {
	return newEngineWithDeps(st, hub, options, initialSettings, defaultPacketConnFactory)
}

func newEngineWithDeps(st probeStore, hub *telemetry.Hub, options Options, initialSettings model.Settings, factory packetConnFactory) *Engine {
	options = normalizeOptions(options)
	engine := &Engine{
		store:               st,
		hub:                 hub,
		probeWorkers:        options.ProbeWorkers,
		resultWorkers:       options.ResultWorkers,
		resultQueueSize:     options.ResultQueueSize,
		resultBatchSize:     options.ResultBatchSize,
		resultFlushInterval: options.ResultFlushInterval,
		engineID:            os.Getpid() & 0xffff,
		packetConnFactory:   factory,
		pending:             map[int]*pendingProbe{},
	}
	engine.settings.Store(initialSettings)
	return engine
}

func normalizeOptions(options Options) Options {
	if options.ProbeWorkers < 1 {
		options.ProbeWorkers = 1
	}
	if options.ResultWorkers < 1 {
		options.ResultWorkers = 1
	}
	if options.ResultQueueSize < 1 {
		options.ResultQueueSize = 1
	}
	if options.ResultBatchSize < 1 {
		options.ResultBatchSize = 1
	}
	if options.ResultFlushInterval <= 0 {
		options.ResultFlushInterval = 25 * time.Millisecond
	}
	return options
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
	resultCh := make(chan resultEnvelope, e.resultQueueSize)
	resultDone := make(chan struct{})

	e.clearPending()

	e.mu.Lock()
	e.cancel = cancel
	e.scope = scope
	e.groupIDs = append([]int64{}, groupIDs...)
	e.running = true
	e.conn = conn
	e.recvDone = recvDone
	e.loopDone = loopDone
	e.resultCh = resultCh
	e.resultDone = resultDone
	e.mu.Unlock()

	log.Printf("probe engine start scope=%s group_ids=%v", scope, groupIDs)
	go e.receiveLoop(ctx, conn, recvDone)
	go e.runResultWorkers(resultCh, resultDone)
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
	resultCh := e.resultCh
	resultDone := e.resultDone

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
	if resultCh != nil {
		close(resultCh)
	}
	if resultDone != nil {
		<-resultDone
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
	if e.resultCh == resultCh {
		e.resultCh = nil
	}
	if e.resultDone == resultDone {
		e.resultDone = nil
	}
	e.mu.Unlock()

	e.clearPending()
	e.setActiveRound(nil)
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
		"probe loop started interval_sec=%d payload_bytes=%d timeout_ms=%d probe_workers=%d result_workers=%d result_queue=%d result_batch=%d result_flush_ms=%d",
		settings.PingIntervalSec,
		settings.ICMPPayloadSize,
		settings.ICMPTimeoutMs,
		e.probeWorkers,
		e.resultWorkers,
		e.resultQueueSize,
		e.resultBatchSize,
		e.resultFlushInterval.Milliseconds(),
	)

	for {
		if ctx.Err() != nil {
			log.Printf("probe loop exited")
			return
		}

		settings = e.CurrentSettings()
		interval := time.Duration(settings.PingIntervalSec) * time.Second
		roundID := e.roundSeq.Add(1)
		roundStarted := time.Now()
		tracker := newRoundTracker(roundID, roundStarted, interval)
		e.setActiveRound(tracker)

		dispatched := e.runRound(ctx, roundID, roundStarted, tracker, settings)
		duration := time.Since(roundStarted)
		tracker.finishProbePhase(dispatched, duration, duration > interval)
		e.setActiveRound(nil)

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

func (e *Engine) runRound(ctx context.Context, roundID uint64, roundStarted time.Time, tracker *roundTracker, settings model.Settings) int {
	e.mu.Lock()
	scope := e.scope
	groupIDs := append([]int64{}, e.groupIDs...)
	e.mu.Unlock()

	targets, err := e.store.ListProbeTargets(ctx, scope, groupIDs)
	if err != nil {
		if ctx.Err() != nil {
			return 0
		}
		log.Printf("probe round target lookup failed round_id=%d: %v", roundID, err)
		e.broadcastProbeError(0, fmt.Sprintf("failed to list probe targets: %v", err))
		return 0
	}
	if len(targets) == 0 {
		log.Printf("probe round skipped round_id=%d: no targets (scope=%s)", roundID, scope)
		return 0
	}

	sort.Slice(targets, func(i, j int) bool {
		return targets[i].EndpointID < targets[j].EndpointID
	})
	tracker.setTargetCount(len(targets))

	log.Printf(
		"probe round started round_id=%d targets=%d scope=%s timeout_ms=%d probe_workers=%d",
		roundID,
		len(targets),
		scope,
		settings.ICMPTimeoutMs,
		e.workerCount(len(targets)),
	)

	jobs := make(chan pacedProbeJob)
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
				case job, ok := <-jobs:
					if !ok {
						return
					}

					result, canceled := e.probeTarget(ctx, job.target, settings)
					if canceled {
						return
					}

					tracker.noteProbeResult(result.Success)
					e.enqueueResult(ctx, tracker, job.target.IP, result)
				}
			}
		}()
	}

	guard := time.Duration(0)
	if intervalGuard := tracker.interval / 10; intervalGuard > 0 {
		guard = intervalGuard
	}
	if guard > 100*time.Millisecond {
		guard = 100 * time.Millisecond
	}
	sendWindow := tracker.interval - guard
	if sendWindow < 0 {
		sendWindow = 0
	}

	dispatched := 0
	for i, target := range targets {
		scheduledAt := roundStarted
		if len(targets) > 1 && sendWindow > 0 {
			offsetNs := int64(sendWindow) * int64(i) / int64(len(targets))
			scheduledAt = roundStarted.Add(time.Duration(offsetNs))
		}

		if wait := time.Until(scheduledAt); wait > 0 {
			timer := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				timer.Stop()
				close(jobs)
				wg.Wait()
				return dispatched
			case <-timer.C:
			}
		}

		select {
		case <-ctx.Done():
			close(jobs)
			wg.Wait()
			return dispatched
		case jobs <- pacedProbeJob{target: target}:
			dispatched++
			tracker.noteDispatch(time.Now(), scheduledAt)
		}
	}

	close(jobs)
	wg.Wait()
	return dispatched
}

func (e *Engine) enqueueResult(ctx context.Context, tracker *roundTracker, targetIP string, result model.PingResult) {
	env := resultEnvelope{
		targetIP: targetIP,
		result:   result,
		tracker:  tracker,
	}

	resultCh := e.currentResultCh()
	if resultCh == nil {
		e.processResultEnvelopes([]resultEnvelope{env})
		return
	}

	tracker.noteResultQueueDepth(len(resultCh))
	select {
	case resultCh <- env:
		tracker.noteResultQueueDepth(len(resultCh))
	case <-ctx.Done():
		e.processFailedPersistence(env, context.Canceled)
	default:
		tracker.noteBackpressure()
		tracker.noteResultQueueDepth(e.resultQueueSize)
		e.processResultEnvelopes([]resultEnvelope{env})
	}
}

func (e *Engine) runResultWorkers(resultCh <-chan resultEnvelope, done chan struct{}) {
	var wg sync.WaitGroup
	for i := 0; i < e.resultWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			e.resultWorker(resultCh)
		}()
	}
	wg.Wait()
	close(done)
}

func (e *Engine) resultWorker(resultCh <-chan resultEnvelope) {
	buffer := make([]resultEnvelope, 0, e.resultBatchSize)
	timer := time.NewTimer(e.resultFlushInterval)
	timerCh := (<-chan time.Time)(nil)
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}

	flush := func() {
		if len(buffer) == 0 {
			return
		}
		batch := make([]resultEnvelope, len(buffer))
		copy(batch, buffer)
		buffer = buffer[:0]
		timerCh = nil
		e.processResultEnvelopes(batch)
	}

	resetTimer := func() {
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(e.resultFlushInterval)
		timerCh = timer.C
	}

	for {
		select {
		case env, ok := <-resultCh:
			if !ok {
				flush()
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				return
			}

			buffer = append(buffer, env)
			if len(buffer) == 1 {
				resetTimer()
			}
			if len(buffer) >= e.resultBatchSize {
				flush()
			}
		case <-timerCh:
			flush()
		}
	}
}

func (e *Engine) processResultEnvelopes(batch []resultEnvelope) {
	if len(batch) == 0 {
		return
	}

	results := make([]model.PingResult, len(batch))
	for i, env := range batch {
		results[i] = env.result
	}

	started := time.Now()
	if err := e.store.RecordPingResultsBatch(context.Background(), results); err == nil {
		e.noteBatchSuccess(batch, time.Since(started))
		return
	} else {
		log.Printf("probe batch persist failed batch_size=%d err=%v", len(batch), err)
	}
	for _, env := range batch {
		singleStarted := time.Now()
		err := e.store.RecordPingResult(context.Background(), env.result)
		duration := time.Since(singleStarted)
		if env.tracker != nil {
			env.tracker.notePersistBatch(1, duration)
		}
		if err != nil {
			e.processFailedPersistence(env, err)
			continue
		}
		if env.tracker != nil {
			env.tracker.markResultsHandled(1)
		}
		e.broadcastResult(env)
	}
}

func (e *Engine) noteBatchSuccess(batch []resultEnvelope, duration time.Duration) {
	grouped := make(map[*roundTracker]int)
	for _, env := range batch {
		if env.tracker == nil {
			continue
		}
		grouped[env.tracker]++
	}

	for tracker, count := range grouped {
		tracker.notePersistBatch(count, apportionedDuration(duration, count, len(batch)))
		tracker.markResultsHandled(count)
	}

	if e.hub.ClientCount() == 0 {
		return
	}
	for _, env := range batch {
		e.broadcastResult(env)
	}
}

func apportionedDuration(total time.Duration, part, whole int) time.Duration {
	if total <= 0 || part <= 0 || whole <= 0 {
		return 0
	}
	return time.Duration(int64(total) * int64(part) / int64(whole))
}

func (e *Engine) processFailedPersistence(env resultEnvelope, err error) {
	roundID := uint64(0)
	if env.tracker != nil {
		env.tracker.notePersistError(1)
		env.tracker.markResultsHandled(1)
		roundID = env.tracker.roundID
	}
	log.Printf("probe persist failed round_id=%d endpoint_id=%d ip=%s err=%v", roundID, env.result.EndpointID, env.targetIP, err)
	e.broadcastProbeError(env.result.EndpointID, fmt.Sprintf("persist ping failed: %v", err))
}

func (e *Engine) broadcastResult(env resultEnvelope) {
	if e.hub.ClientCount() == 0 {
		return
	}
	status := "failed"
	if env.result.Success {
		status = "succeeded"
	}
	e.hub.Broadcast(map[string]any{
		"type":        "probe_update",
		"endpoint_id": env.result.EndpointID,
		"ip":          env.targetIP,
		"status":      status,
		"latency_ms":  env.result.LatencyMs,
		"timestamp":   env.result.Timestamp,
	})
}

func (e *Engine) broadcastProbeError(endpointID int64, message string) {
	if e.hub.ClientCount() == 0 {
		return
	}
	payload := map[string]any{
		"type":      "probe_error",
		"message":   message,
		"timestamp": time.Now().UTC(),
	}
	if endpointID > 0 {
		payload["endpoint_id"] = endpointID
	}
	e.hub.Broadcast(payload)
}

func (e *Engine) workerCount(targetCount int) int {
	if targetCount < 1 {
		return 0
	}
	if e.probeWorkers > targetCount {
		return targetCount
	}
	return e.probeWorkers
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

func (e *Engine) currentResultCh() chan resultEnvelope {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.resultCh
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
		if tracker := e.currentActiveRound(); tracker != nil {
			tracker.notePendingCount(len(e.pending))
		}
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

func (e *Engine) setActiveRound(tracker *roundTracker) {
	e.roundMu.Lock()
	defer e.roundMu.Unlock()
	e.activeRound = tracker
}

func (e *Engine) currentActiveRound() *roundTracker {
	e.roundMu.Lock()
	defer e.roundMu.Unlock()
	return e.activeRound
}

func newRoundTracker(roundID uint64, startedAt time.Time, interval time.Duration) *roundTracker {
	return &roundTracker{
		roundID:   roundID,
		startedAt: startedAt,
		interval:  interval,
	}
}

func (t *roundTracker) setTargetCount(count int) {
	t.targetCount.Store(int64(count))
}

func (t *roundTracker) noteDispatch(actual, scheduled time.Time) {
	t.dispatched.Add(1)

	actualNs := actual.UnixNano()
	for {
		first := t.firstDispatchNs.Load()
		if first != 0 {
			break
		}
		if t.firstDispatchNs.CompareAndSwap(0, actualNs) {
			break
		}
	}

	for {
		last := t.lastDispatchNs.Load()
		if actualNs <= last {
			break
		}
		if t.lastDispatchNs.CompareAndSwap(last, actualNs) {
			break
		}
	}

	if actual.After(scheduled) {
		t.observeMax(&t.sendSlipMaxNs, actual.Sub(scheduled).Nanoseconds())
	}
}

func (t *roundTracker) noteProbeResult(success bool) {
	if success {
		t.successes.Add(1)
		return
	}
	t.failures.Add(1)
}

func (t *roundTracker) notePersistError(count int) {
	t.persistErrs.Add(int64(count))
}

func (t *roundTracker) noteBackpressure() {
	t.backpressure.Add(1)
}

func (t *roundTracker) notePendingCount(depth int) {
	t.observeMax(&t.pendingPeak, int64(depth))
}

func (t *roundTracker) noteResultQueueDepth(depth int) {
	t.observeMax(&t.queuePeak, int64(depth))
}

func (t *roundTracker) notePersistBatch(size int, duration time.Duration) {
	t.batchCount.Add(1)
	t.observeMax(&t.batchMax, int64(size))
	t.persistDurationNs.Add(duration.Nanoseconds())
}

func (t *roundTracker) markResultsHandled(count int) {
	t.handledResults.Add(int64(count))
	t.tryLog()
}

func (t *roundTracker) finishProbePhase(dispatched int, duration time.Duration, overrun bool) {
	t.expected.Store(int64(dispatched))
	t.probeDurationNs.Store(duration.Nanoseconds())
	t.overrun.Store(overrun)
	t.tryLog()
}

func (t *roundTracker) tryLog() {
	if t.probeDurationNs.Load() == 0 {
		return
	}
	expected := t.expected.Load()
	if expected > 0 && t.handledResults.Load() < expected {
		return
	}
	if !t.logged.CompareAndSwap(false, true) {
		return
	}
	t.logSummary()
}

func (t *roundTracker) logSummary() {
	sendSpanMs := int64(0)
	firstDispatch := t.firstDispatchNs.Load()
	lastDispatch := t.lastDispatchNs.Load()
	if firstDispatch > 0 && lastDispatch >= firstDispatch {
		sendSpanMs = (lastDispatch - firstDispatch) / int64(time.Millisecond)
	}

	batchCount := t.batchCount.Load()
	persistBatchAvg := 0.0
	if batchCount > 0 {
		persistBatchAvg = float64(t.handledResults.Load()) / float64(batchCount)
	}

	log.Printf(
		"probe round finished round_id=%d duration_ms=%d overrun=%t targets=%d successes=%d failures=%d persist_failures=%d backpressure=%d send_span_ms=%d send_slip_ms_max=%d pending_peak=%d result_queue_peak=%d persist_batch_avg=%.2f persist_batch_max=%d persist_duration_ms=%d",
		t.roundID,
		t.probeDurationNs.Load()/int64(time.Millisecond),
		t.overrun.Load(),
		t.targetCount.Load(),
		t.successes.Load(),
		t.failures.Load(),
		t.persistErrs.Load(),
		t.backpressure.Load(),
		sendSpanMs,
		t.sendSlipMaxNs.Load()/int64(time.Millisecond),
		t.pendingPeak.Load(),
		t.queuePeak.Load(),
		persistBatchAvg,
		t.batchMax.Load(),
		t.persistDurationNs.Load()/int64(time.Millisecond),
	)
}

func (t *roundTracker) observeMax(counter *atomic.Int64, value int64) {
	for {
		current := counter.Load()
		if value <= current {
			return
		}
		if counter.CompareAndSwap(current, value) {
			return
		}
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
