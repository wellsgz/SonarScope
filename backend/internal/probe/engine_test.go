package probe

import (
	"context"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"

	"sonarscope/backend/internal/model"
	"sonarscope/backend/internal/store"
	"sonarscope/backend/internal/telemetry"
)

type fakeProbeStore struct {
	targets []store.ProbeTarget

	mu               sync.Mutex
	results          []model.PingResult
	batchCalls       []int
	batchStarted     chan struct{}
	batchStartedOnce sync.Once
	batchGate        chan struct{}
	batchDelay       time.Duration
	singleDelay      time.Duration
	failBatchCount   int
}

func (s *fakeProbeStore) ListProbeTargets(ctx context.Context, scope string, groupIDs []int64) ([]store.ProbeTarget, error) {
	items := make([]store.ProbeTarget, len(s.targets))
	copy(items, s.targets)
	return items, nil
}

func (s *fakeProbeStore) RecordPingResult(ctx context.Context, result model.PingResult) error {
	if s.singleDelay > 0 {
		time.Sleep(s.singleDelay)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.results = append(s.results, result)
	return nil
}

func (s *fakeProbeStore) RecordPingResultsBatch(ctx context.Context, results []model.PingResult) error {
	s.batchStartedOnce.Do(func() {
		if s.batchStarted != nil {
			close(s.batchStarted)
		}
	})
	if s.batchGate != nil {
		<-s.batchGate
	}
	if s.batchDelay > 0 {
		time.Sleep(s.batchDelay)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.batchCalls = append(s.batchCalls, len(results))
	if s.failBatchCount > 0 {
		s.failBatchCount--
		return errors.New("batch failed")
	}
	s.results = append(s.results, results...)
	return nil
}

func (s *fakeProbeStore) ResultCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.results)
}

func (s *fakeProbeStore) BatchCalls() []int {
	s.mu.Lock()
	defer s.mu.Unlock()
	calls := make([]int, len(s.batchCalls))
	copy(calls, s.batchCalls)
	return calls
}

type fakeBroadcaster struct {
	mu          sync.Mutex
	clientCount int
	events      []map[string]any
}

func (b *fakeBroadcaster) Broadcast(event any) {
	payload, ok := event.(map[string]any)
	if !ok {
		return
	}
	cloned := make(map[string]any, len(payload))
	for key, value := range payload {
		cloned[key] = value
	}
	b.mu.Lock()
	b.events = append(b.events, cloned)
	b.mu.Unlock()
}

func (b *fakeBroadcaster) ClientCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.clientCount
}

func (b *fakeBroadcaster) Events() []map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	events := make([]map[string]any, len(b.events))
	for i, event := range b.events {
		cloned := make(map[string]any, len(event))
		for key, value := range event {
			cloned[key] = value
		}
		events[i] = cloned
	}
	return events
}

type fakePacketConn struct {
	mu             sync.Mutex
	writes         [][]byte
	writeTimes     []time.Time
	readCh         chan fakeRead
	closeCh        chan struct{}
	closed         bool
	autoReply      bool
	autoReplyDelay time.Duration
}

type fakeRead struct {
	payload []byte
	peer    net.Addr
	err     error
}

func newFakePacketConn() *fakePacketConn {
	return &fakePacketConn{
		readCh:  make(chan fakeRead, 64),
		closeCh: make(chan struct{}),
	}
}

func (c *fakePacketConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		close(c.closeCh)
	}
	return nil
}

func (c *fakePacketConn) ReadFrom(b []byte) (int, net.Addr, error) {
	select {
	case <-c.closeCh:
		return 0, nil, net.ErrClosed
	case item := <-c.readCh:
		if item.err != nil {
			return 0, nil, item.err
		}
		copy(b, item.payload)
		return len(item.payload), item.peer, nil
	}
}

func (c *fakePacketConn) SetDeadline(t time.Time) error {
	return nil
}

func (c *fakePacketConn) WriteTo(b []byte, dst net.Addr) (int, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return 0, net.ErrClosed
	}
	wire := make([]byte, len(b))
	copy(wire, b)
	c.writes = append(c.writes, wire)
	c.writeTimes = append(c.writeTimes, time.Now())
	autoReply := c.autoReply
	autoReplyDelay := c.autoReplyDelay
	c.mu.Unlock()

	if autoReply {
		echo := parseEchoRequestWire(wire)
		peerIP := ""
		if ipAddr, ok := dst.(*net.IPAddr); ok && ipAddr.IP != nil {
			peerIP = ipAddr.IP.String()
		}
		go func() {
			if autoReplyDelay > 0 {
				time.Sleep(autoReplyDelay)
			}
			_ = c.InjectEchoReply(echo.ID, echo.Seq, peerIP)
		}()
	}

	return len(b), nil
}

func (c *fakePacketConn) WriteCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.writes)
}

func (c *fakePacketConn) Writes() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	items := make([][]byte, len(c.writes))
	for i, item := range c.writes {
		wire := make([]byte, len(item))
		copy(wire, item)
		items[i] = wire
	}
	return items
}

func (c *fakePacketConn) WriteTimes() []time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	items := make([]time.Time, len(c.writeTimes))
	copy(items, c.writeTimes)
	return items
}

func (c *fakePacketConn) Closed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

func (c *fakePacketConn) InjectEchoReply(id, seq int, peerIP string) error {
	msg := icmp.Message{
		Type: ipv4.ICMPTypeEchoReply,
		Code: 0,
		Body: &icmp.Echo{
			ID:   id,
			Seq:  seq,
			Data: []byte{0x42},
		},
	}
	wire, err := msg.Marshal(nil)
	if err != nil {
		return err
	}
	c.readCh <- fakeRead{
		payload: wire,
		peer:    &net.IPAddr{IP: net.ParseIP(peerIP)},
	}
	return nil
}

func newTestEngine(st probeStore, options Options, settings model.Settings, conn *fakePacketConn) *Engine {
	engine := newEngineWithDeps(st, telemetry.NewHub(), options, settings, func() (packetConn, error) {
		return conn, nil
	})
	engine.mu.Lock()
	engine.conn = conn
	engine.mu.Unlock()
	return engine
}

func defaultTestOptions() Options {
	return Options{
		ProbeWorkers:        4,
		ResultWorkers:       1,
		ResultQueueSize:     32,
		ResultBatchSize:     8,
		ResultFlushInterval: 25 * time.Millisecond,
	}
}

func startReceiver(t *testing.T, engine *Engine, conn *fakePacketConn) (context.CancelFunc, chan struct{}) {
	t.Helper()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go engine.receiveLoop(ctx, conn, done)
	return cancel, done
}

func stopReceiver(t *testing.T, cancel context.CancelFunc, conn *fakePacketConn, done chan struct{}) {
	t.Helper()
	cancel()
	_ = conn.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("receiver did not stop")
	}
}

func startResultPipeline(t *testing.T, engine *Engine) (chan resultEnvelope, func()) {
	t.Helper()

	resultCh := make(chan resultEnvelope, engine.resultQueueSize)
	resultDone := make(chan struct{})
	var once sync.Once
	engine.mu.Lock()
	engine.resultCh = resultCh
	engine.resultDone = resultDone
	engine.mu.Unlock()
	go engine.runResultWorkers(resultCh, resultDone)

	stop := func() {
		once.Do(func() {
			close(resultCh)
			select {
			case <-resultDone:
			case <-time.After(2 * time.Second):
				t.Fatal("result workers did not stop")
			}
			engine.mu.Lock()
			if engine.resultCh == resultCh {
				engine.resultCh = nil
			}
			if engine.resultDone == resultDone {
				engine.resultDone = nil
			}
			engine.mu.Unlock()
		})
	}

	t.Cleanup(stop)

	return resultCh, stop
}

func waitForWriteCount(t *testing.T, conn *fakePacketConn, want int, timeout time.Duration) {
	t.Helper()

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if conn.WriteCount() >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d writes; got %d", want, conn.WriteCount())
}

func waitForPendingCount(t *testing.T, engine *Engine, want int, timeout time.Duration) {
	t.Helper()

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if engine.pendingCount() == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d pending probes; got %d", want, engine.pendingCount())
}

func parseEchoRequest(t *testing.T, wire []byte) *icmp.Echo {
	t.Helper()
	return parseEchoRequestWire(wire)
}

func parseEchoRequestWire(wire []byte) *icmp.Echo {
	msg, err := icmp.ParseMessage(ipv4.ICMPTypeEcho.Protocol(), wire)
	if err != nil {
		panic(err)
	}
	echo, ok := msg.Body.(*icmp.Echo)
	if !ok {
		panic("unexpected message body")
	}
	return echo
}

func TestMatchingReplyWakesOnlyRegisteredWaiter(t *testing.T) {
	conn := newFakePacketConn()
	engine := newTestEngine(&fakeProbeStore{}, defaultTestOptions(), model.Settings{
		PingIntervalSec: 1,
		ICMPPayloadSize: 56,
		ICMPTimeoutMs:   500,
	}, conn)

	cancelReceiver, recvDone := startReceiver(t, engine, conn)
	defer stopReceiver(t, cancelReceiver, conn, recvDone)

	type result struct {
		replyIP string
		err     error
	}

	firstResult := make(chan result, 1)
	secondResult := make(chan result, 1)

	go func() {
		_, replyIP, _, err := engine.sendICMPEcho(context.Background(), "10.0.0.1", 56, 500)
		firstResult <- result{replyIP: derefString(replyIP), err: err}
	}()
	waitForWriteCount(t, conn, 1, time.Second)
	firstEcho := parseEchoRequest(t, conn.Writes()[0])

	ctxSecond, cancelSecond := context.WithCancel(context.Background())
	defer cancelSecond()
	go func() {
		_, replyIP, _, err := engine.sendICMPEcho(ctxSecond, "10.0.0.2", 56, 500)
		secondResult <- result{replyIP: derefString(replyIP), err: err}
	}()
	waitForWriteCount(t, conn, 2, time.Second)
	secondEcho := parseEchoRequest(t, conn.Writes()[1])

	if firstEcho.Seq == secondEcho.Seq {
		t.Fatal("expected unique sequence numbers")
	}

	if err := conn.InjectEchoReply(engine.engineID, firstEcho.Seq, "10.0.0.1"); err != nil {
		t.Fatalf("inject echo reply: %v", err)
	}

	select {
	case got := <-firstResult:
		if got.err != nil {
			t.Fatalf("first probe failed: %v", got.err)
		}
		if got.replyIP != "10.0.0.1" {
			t.Fatalf("unexpected reply ip: got %q", got.replyIP)
		}
	case <-time.After(time.Second):
		t.Fatal("first probe did not complete")
	}

	select {
	case got := <-secondResult:
		t.Fatalf("second probe completed unexpectedly: %+v", got)
	case <-time.After(30 * time.Millisecond):
	}

	cancelSecond()
	select {
	case got := <-secondResult:
		if !errors.Is(got.err, context.Canceled) {
			t.Fatalf("expected context cancellation, got %v", got.err)
		}
	case <-time.After(time.Second):
		t.Fatal("second probe did not exit after cancellation")
	}
}

func TestForeignAndLateRepliesDoNotLeakPendingEntries(t *testing.T) {
	conn := newFakePacketConn()
	engine := newTestEngine(&fakeProbeStore{}, defaultTestOptions(), model.Settings{
		PingIntervalSec: 1,
		ICMPPayloadSize: 56,
		ICMPTimeoutMs:   500,
	}, conn)

	cancelReceiver, recvDone := startReceiver(t, engine, conn)
	defer stopReceiver(t, cancelReceiver, conn, recvDone)

	ctxProbe, cancelProbe := context.WithCancel(context.Background())
	defer cancelProbe()

	resultCh := make(chan error, 1)
	go func() {
		_, _, _, err := engine.sendICMPEcho(ctxProbe, "10.0.0.3", 56, 500)
		resultCh <- err
	}()

	waitForWriteCount(t, conn, 1, time.Second)
	echo := parseEchoRequest(t, conn.Writes()[0])

	if err := conn.InjectEchoReply(engine.engineID+1, echo.Seq, "10.0.0.3"); err != nil {
		t.Fatalf("inject foreign reply: %v", err)
	}

	select {
	case err := <-resultCh:
		t.Fatalf("probe returned early: %v", err)
	case <-time.After(30 * time.Millisecond):
	}

	if engine.pendingCount() != 1 {
		t.Fatalf("expected 1 pending probe, got %d", engine.pendingCount())
	}

	cancelProbe()
	select {
	case err := <-resultCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected context cancellation, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("probe did not exit after cancellation")
	}

	waitForPendingCount(t, engine, 0, time.Second)

	if err := conn.InjectEchoReply(engine.engineID, echo.Seq, "10.0.0.3"); err != nil {
		t.Fatalf("inject late reply: %v", err)
	}
	time.Sleep(20 * time.Millisecond)
	if engine.pendingCount() != 0 {
		t.Fatalf("late reply recreated pending state: %d", engine.pendingCount())
	}
}

func TestRunRoundPacesDispatchAcrossSendWindow(t *testing.T) {
	conn := newFakePacketConn()
	conn.autoReply = true

	store := &fakeProbeStore{
		targets: []store.ProbeTarget{
			{EndpointID: 1, IP: "10.0.0.1"},
			{EndpointID: 2, IP: "10.0.0.2"},
			{EndpointID: 3, IP: "10.0.0.3"},
			{EndpointID: 4, IP: "10.0.0.4"},
			{EndpointID: 5, IP: "10.0.0.5"},
		},
	}

	options := defaultTestOptions()
	options.ProbeWorkers = 5
	engine := newTestEngine(store, options, model.Settings{
		PingIntervalSec: 1,
		ICMPPayloadSize: 56,
		ICMPTimeoutMs:   200,
	}, conn)

	cancelReceiver, recvDone := startReceiver(t, engine, conn)
	defer stopReceiver(t, cancelReceiver, conn, recvDone)
	_, stopResults := startResultPipeline(t, engine)
	defer stopResults()

	roundStarted := time.Now()
	tracker := newRoundTracker(1, roundStarted, time.Second)
	engine.setActiveRound(tracker)
	dispatched := engine.runRound(context.Background(), 1, roundStarted, tracker, engine.CurrentSettings())
	tracker.finishProbePhase(dispatched, time.Since(roundStarted), false)
	engine.setActiveRound(nil)

	writeTimes := conn.WriteTimes()
	if len(writeTimes) != 5 {
		t.Fatalf("expected 5 writes, got %d", len(writeTimes))
	}

	span := writeTimes[len(writeTimes)-1].Sub(writeTimes[0])
	if span < 500*time.Millisecond {
		t.Fatalf("expected paced sends across the interval, got span %v", span)
	}
	if span > 975*time.Millisecond {
		t.Fatalf("expected sends to stay within the configured send window, got span %v", span)
	}
}

func TestRunRoundHonorsConfiguredWorkerLimit(t *testing.T) {
	conn := newFakePacketConn()
	store := &fakeProbeStore{
		targets: []store.ProbeTarget{
			{EndpointID: 1, IP: "10.0.0.1"},
			{EndpointID: 2, IP: "10.0.0.2"},
			{EndpointID: 3, IP: "10.0.0.3"},
			{EndpointID: 4, IP: "10.0.0.4"},
			{EndpointID: 5, IP: "10.0.0.5"},
		},
	}

	options := defaultTestOptions()
	options.ProbeWorkers = 2
	engine := newTestEngine(store, options, model.Settings{
		PingIntervalSec: 1,
		ICMPPayloadSize: 56,
		ICMPTimeoutMs:   1000,
	}, conn)

	cancelReceiver, recvDone := startReceiver(t, engine, conn)
	defer stopReceiver(t, cancelReceiver, conn, recvDone)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		roundStarted := time.Now()
		tracker := newRoundTracker(1, roundStarted, time.Second)
		engine.setActiveRound(tracker)
		dispatched := engine.runRound(ctx, 1, roundStarted, tracker, engine.CurrentSettings())
		tracker.finishProbePhase(dispatched, time.Since(roundStarted), false)
		engine.setActiveRound(nil)
		close(done)
	}()

	waitForWriteCount(t, conn, 2, time.Second)
	time.Sleep(50 * time.Millisecond)
	if got := conn.WriteCount(); got != 2 {
		t.Fatalf("expected only 2 in-flight writes before cancellation, got %d", got)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("runRound did not exit after cancellation")
	}
}

func TestProbeWorkersContinueWhenBatchPersistenceIsBlocked(t *testing.T) {
	conn := newFakePacketConn()
	conn.autoReply = true

	batchStarted := make(chan struct{})
	batchGate := make(chan struct{})
	store := &fakeProbeStore{
		targets: []store.ProbeTarget{
			{EndpointID: 1, IP: "10.0.0.1"},
			{EndpointID: 2, IP: "10.0.0.2"},
			{EndpointID: 3, IP: "10.0.0.3"},
			{EndpointID: 4, IP: "10.0.0.4"},
		},
		batchStarted: batchStarted,
		batchGate:    batchGate,
	}

	options := defaultTestOptions()
	options.ProbeWorkers = 4
	options.ResultBatchSize = 64
	engine := newTestEngine(store, options, model.Settings{
		PingIntervalSec: 1,
		ICMPPayloadSize: 56,
		ICMPTimeoutMs:   200,
	}, conn)

	cancelReceiver, recvDone := startReceiver(t, engine, conn)
	defer stopReceiver(t, cancelReceiver, conn, recvDone)
	_, stopResults := startResultPipeline(t, engine)
	defer stopResults()

	done := make(chan struct{})
	go func() {
		roundStarted := time.Now()
		tracker := newRoundTracker(1, roundStarted, time.Second)
		engine.setActiveRound(tracker)
		dispatched := engine.runRound(context.Background(), 1, roundStarted, tracker, engine.CurrentSettings())
		tracker.finishProbePhase(dispatched, time.Since(roundStarted), false)
		engine.setActiveRound(nil)
		close(done)
	}()

	select {
	case <-batchStarted:
	case <-time.After(time.Second):
		t.Fatal("batch persistence did not start")
	}

	select {
	case <-done:
	case <-time.After(1300 * time.Millisecond):
		t.Fatal("runRound stayed blocked on persistence")
	}

	close(batchGate)
}

func TestResultWorkerFlushesOnBatchSizeAndTimer(t *testing.T) {
	t.Run("batch size", func(t *testing.T) {
		store := &fakeProbeStore{}
		engine := newTestEngine(store, defaultTestOptions(), model.Settings{}, newFakePacketConn())
		engine.resultBatchSize = 2
		engine.resultFlushInterval = time.Second
		resultCh, stopResults := startResultPipeline(t, engine)
		defer stopResults()

		tracker := newRoundTracker(1, time.Now(), time.Second)
		resultCh <- resultEnvelope{targetIP: "10.0.0.1", result: model.PingResult{EndpointID: 1}, tracker: tracker}
		resultCh <- resultEnvelope{targetIP: "10.0.0.2", result: model.PingResult{EndpointID: 2}, tracker: tracker}
		resultCh <- resultEnvelope{targetIP: "10.0.0.3", result: model.PingResult{EndpointID: 3}, tracker: tracker}

		stopResults()

		got := store.BatchCalls()
		if len(got) != 2 || got[0] != 2 || got[1] != 1 {
			t.Fatalf("unexpected batch flushes: %v", got)
		}
	})

	t.Run("timer", func(t *testing.T) {
		store := &fakeProbeStore{}
		engine := newTestEngine(store, defaultTestOptions(), model.Settings{}, newFakePacketConn())
		engine.resultBatchSize = 10
		engine.resultFlushInterval = 20 * time.Millisecond
		resultCh, stopResults := startResultPipeline(t, engine)
		defer stopResults()

		resultCh <- resultEnvelope{targetIP: "10.0.0.1", result: model.PingResult{EndpointID: 1}, tracker: newRoundTracker(1, time.Now(), time.Second)}
		time.Sleep(80 * time.Millisecond)

		got := store.BatchCalls()
		if len(got) != 1 || got[0] != 1 {
			t.Fatalf("unexpected timer flushes: %v", got)
		}
	})
}

func TestFailedBatchPersistenceFallsBackToIndividualWrites(t *testing.T) {
	store := &fakeProbeStore{
		failBatchCount: 1,
	}
	engine := newTestEngine(store, defaultTestOptions(), model.Settings{}, newFakePacketConn())
	engine.resultBatchSize = 4
	engine.resultFlushInterval = 20 * time.Millisecond
	resultCh, stopResults := startResultPipeline(t, engine)

	tracker := newRoundTracker(1, time.Now(), time.Second)
	resultCh <- resultEnvelope{targetIP: "10.0.0.1", result: model.PingResult{EndpointID: 1}, tracker: tracker}
	resultCh <- resultEnvelope{targetIP: "10.0.0.2", result: model.PingResult{EndpointID: 2}, tracker: tracker}

	stopResults()

	if store.ResultCount() != 2 {
		t.Fatalf("expected fallback to preserve both results, got %d", store.ResultCount())
	}
	got := store.BatchCalls()
	if len(got) != 1 || got[0] != 2 {
		t.Fatalf("expected a failed batch attempt before fallback, got %v", got)
	}
}

func TestProcessResultEnvelopesBroadcastsSingleProbeUpdatePerBatch(t *testing.T) {
	store := &fakeProbeStore{}
	broadcaster := &fakeBroadcaster{clientCount: 1}
	engine := newEngineWithDeps(store, broadcaster, defaultTestOptions(), model.Settings{}, func() (packetConn, error) {
		return newFakePacketConn(), nil
	})
	firstTimestamp := time.Now().UTC()
	secondTimestamp := firstTimestamp.Add(5 * time.Millisecond)

	engine.processResultEnvelopes([]resultEnvelope{
		{result: model.PingResult{EndpointID: 1, Timestamp: firstTimestamp}},
		{result: model.PingResult{EndpointID: 2, Timestamp: secondTimestamp}},
	})

	events := broadcaster.Events()
	if len(events) != 1 {
		t.Fatalf("broadcast count = %d, want 1", len(events))
	}
	if got := events[0]["type"]; got != "probe_update" {
		t.Fatalf("event type = %v, want probe_update", got)
	}
	if got := events[0]["count"]; got != 2 {
		t.Fatalf("event count = %v, want 2", got)
	}
	timestamp, ok := events[0]["timestamp"].(time.Time)
	if !ok {
		t.Fatalf("event timestamp has unexpected type %T", events[0]["timestamp"])
	}
	if !timestamp.Equal(secondTimestamp) {
		t.Fatalf("event timestamp = %s, want %s", timestamp, secondTimestamp)
	}
}

func TestProcessResultEnvelopesBroadcastsOneProbeUpdatePerFallbackWrite(t *testing.T) {
	store := &fakeProbeStore{failBatchCount: 1}
	broadcaster := &fakeBroadcaster{clientCount: 1}
	engine := newEngineWithDeps(store, broadcaster, defaultTestOptions(), model.Settings{}, func() (packetConn, error) {
		return newFakePacketConn(), nil
	})
	firstTimestamp := time.Now().UTC()
	secondTimestamp := firstTimestamp.Add(5 * time.Millisecond)

	engine.processResultEnvelopes([]resultEnvelope{
		{result: model.PingResult{EndpointID: 1, Timestamp: firstTimestamp}},
		{result: model.PingResult{EndpointID: 2, Timestamp: secondTimestamp}},
	})

	events := broadcaster.Events()
	if len(events) != 2 {
		t.Fatalf("broadcast count = %d, want 2", len(events))
	}
	for index, event := range events {
		if got := event["type"]; got != "probe_update" {
			t.Fatalf("event %d type = %v, want probe_update", index, got)
		}
		if got := event["count"]; got != 1 {
			t.Fatalf("event %d count = %v, want 1", index, got)
		}
	}

	firstEventTimestamp, ok := events[0]["timestamp"].(time.Time)
	if !ok {
		t.Fatalf("first event timestamp has unexpected type %T", events[0]["timestamp"])
	}
	secondEventTimestamp, ok := events[1]["timestamp"].(time.Time)
	if !ok {
		t.Fatalf("second event timestamp has unexpected type %T", events[1]["timestamp"])
	}
	if !firstEventTimestamp.Equal(firstTimestamp) {
		t.Fatalf("first event timestamp = %s, want %s", firstEventTimestamp, firstTimestamp)
	}
	if !secondEventTimestamp.Equal(secondTimestamp) {
		t.Fatalf("second event timestamp = %s, want %s", secondEventTimestamp, secondTimestamp)
	}
}

func TestLoopDoesNotStartOverlappingRounds(t *testing.T) {
	conn := newFakePacketConn()
	store := &fakeProbeStore{
		targets: []store.ProbeTarget{
			{EndpointID: 1, IP: "10.0.0.1"},
		},
	}

	options := defaultTestOptions()
	options.ProbeWorkers = 1
	engine := newEngineWithDeps(store, telemetry.NewHub(), options, model.Settings{
		PingIntervalSec: 1,
		ICMPPayloadSize: 56,
		ICMPTimeoutMs:   5000,
	}, func() (packetConn, error) {
		return conn, nil
	})

	if err := engine.Start("all", nil); err != nil {
		t.Fatalf("start engine: %v", err)
	}
	defer engine.Stop()

	waitForWriteCount(t, conn, 1, time.Second)
	time.Sleep(1200 * time.Millisecond)

	if got := conn.WriteCount(); got != 1 {
		t.Fatalf("expected a single in-flight round write, got %d", got)
	}
}

func TestConcurrentStartSerializesLifecycle(t *testing.T) {
	store := &fakeProbeStore{}
	options := defaultTestOptions()

	firstFactoryEntered := make(chan struct{})
	secondFactoryEntered := make(chan struct{})
	releaseFirstFactory := make(chan struct{})

	var factoryCalls atomic.Int32
	var connsMu sync.Mutex
	conns := make([]*fakePacketConn, 0, 2)

	engine := newEngineWithDeps(store, telemetry.NewHub(), options, model.Settings{
		PingIntervalSec: 1,
		ICMPPayloadSize: 56,
		ICMPTimeoutMs:   500,
	}, func() (packetConn, error) {
		conn := newFakePacketConn()

		connsMu.Lock()
		conns = append(conns, conn)
		connsMu.Unlock()

		switch factoryCalls.Add(1) {
		case 1:
			close(firstFactoryEntered)
			<-releaseFirstFactory
		case 2:
			close(secondFactoryEntered)
		}

		return conn, nil
	})

	start1 := make(chan error, 1)
	start2 := make(chan error, 1)
	go func() { start1 <- engine.Start("all", nil) }()

	select {
	case <-firstFactoryEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("first Start did not reach packetConnFactory")
	}

	go func() { start2 <- engine.Start("all", nil) }()

	select {
	case <-secondFactoryEntered:
		t.Fatal("second Start reached packetConnFactory before first Start completed")
	case <-time.After(150 * time.Millisecond):
	}

	close(releaseFirstFactory)

	select {
	case err := <-start1:
		if err != nil {
			t.Fatalf("first Start error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for first Start")
	}

	select {
	case <-secondFactoryEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("second Start did not reach packetConnFactory")
	}

	select {
	case err := <-start2:
		if err != nil {
			t.Fatalf("second Start error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for second Start")
	}

	if !engine.Stop() {
		t.Fatal("expected final Stop to stop the running engine")
	}

	connsMu.Lock()
	defer connsMu.Unlock()
	if len(conns) != 2 {
		t.Fatalf("packetConnFactory calls = %d, want 2", len(conns))
	}
	for i, conn := range conns {
		if !conn.Closed() {
			t.Fatalf("connection %d was not closed", i+1)
		}
	}
}

func TestPayloadBytesReusesCachedPayloadBySize(t *testing.T) {
	engine := newTestEngine(&fakeProbeStore{}, defaultTestOptions(), model.Settings{}, newFakePacketConn())

	first := engine.payloadBytes(56)
	second := engine.payloadBytes(56)
	other := engine.payloadBytes(64)

	if len(first) != 56 {
		t.Fatalf("first payload len = %d, want 56", len(first))
	}
	for i, b := range first {
		if b != 0x42 {
			t.Fatalf("first payload byte %d = %x, want 42", i, b)
		}
	}

	if len(second) == 0 || &first[0] != &second[0] {
		t.Fatal("expected same-size payload requests to reuse cached slice")
	}
	if len(other) == 0 || &first[0] == &other[0] {
		t.Fatal("expected different-size payload requests to use a distinct cached slice")
	}
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
