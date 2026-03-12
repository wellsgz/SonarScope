package probe

import (
	"context"
	"errors"
	"net"
	"sync"
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

	mu      sync.Mutex
	results []model.PingResult
}

func (s *fakeProbeStore) ListProbeTargets(ctx context.Context, scope string, groupIDs []int64) ([]store.ProbeTarget, error) {
	items := make([]store.ProbeTarget, len(s.targets))
	copy(items, s.targets)
	return items, nil
}

func (s *fakeProbeStore) RecordPingResult(ctx context.Context, result model.PingResult) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.results = append(s.results, result)
	return nil
}

type fakePacketConn struct {
	mu      sync.Mutex
	writes  [][]byte
	readCh  chan fakeRead
	closeCh chan struct{}
	closed  bool
}

type fakeRead struct {
	payload []byte
	peer    net.Addr
	err     error
}

func newFakePacketConn() *fakePacketConn {
	return &fakePacketConn{
		readCh:  make(chan fakeRead, 32),
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
	defer c.mu.Unlock()
	if c.closed {
		return 0, net.ErrClosed
	}
	wire := make([]byte, len(b))
	copy(wire, b)
	c.writes = append(c.writes, wire)
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

func newTestEngine(st probeStore, workers int, settings model.Settings, conn *fakePacketConn) *Engine {
	engine := newEngineWithDeps(st, telemetry.NewHub(), workers, settings, func() (packetConn, error) {
		return conn, nil
	})
	engine.mu.Lock()
	engine.conn = conn
	engine.mu.Unlock()
	return engine
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

	msg, err := icmp.ParseMessage(ipv4.ICMPTypeEcho.Protocol(), wire)
	if err != nil {
		t.Fatalf("parse echo request: %v", err)
	}
	echo, ok := msg.Body.(*icmp.Echo)
	if !ok {
		t.Fatalf("unexpected message body type %T", msg.Body)
	}
	return echo
}

func TestMatchingReplyWakesOnlyRegisteredWaiter(t *testing.T) {
	conn := newFakePacketConn()
	engine := newTestEngine(&fakeProbeStore{}, 2, model.Settings{
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
	firstWrite := conn.Writes()[0]
	firstEcho := parseEchoRequest(t, firstWrite)

	ctxSecond, cancelSecond := context.WithCancel(context.Background())
	defer cancelSecond()
	go func() {
		_, replyIP, _, err := engine.sendICMPEcho(ctxSecond, "10.0.0.2", 56, 500)
		secondResult <- result{replyIP: derefString(replyIP), err: err}
	}()
	waitForWriteCount(t, conn, 2, time.Second)
	secondWrite := conn.Writes()[1]
	secondEcho := parseEchoRequest(t, secondWrite)

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
	engine := newTestEngine(&fakeProbeStore{}, 1, model.Settings{
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
	engine := newTestEngine(store, 2, model.Settings{
		PingIntervalSec: 1,
		ICMPPayloadSize: 56,
		ICMPTimeoutMs:   1000,
	}, conn)

	cancelReceiver, recvDone := startReceiver(t, engine, conn)
	defer stopReceiver(t, cancelReceiver, conn, recvDone)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		engine.runRound(ctx, 1, engine.CurrentSettings())
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

func TestLoopDoesNotStartOverlappingRounds(t *testing.T) {
	conn := newFakePacketConn()
	store := &fakeProbeStore{
		targets: []store.ProbeTarget{
			{EndpointID: 1, IP: "10.0.0.1"},
		},
	}
	engine := newEngineWithDeps(store, telemetry.NewHub(), 1, model.Settings{
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

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
