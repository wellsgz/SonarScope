package telemetry

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestHubBroadcastReturnsPromptlyWithFullQueue(t *testing.T) {
	hub := NewHub()
	slow := &client{send: make(chan []byte, 1), done: make(chan struct{})}
	healthy := &client{send: make(chan []byte, 1), done: make(chan struct{})}

	slow.send <- []byte(`"busy"`)
	hub.registerClient(slow)
	hub.registerClient(healthy)

	started := time.Now()
	hub.Broadcast(map[string]any{
		"type":        "probe_update",
		"endpoint_id": 42,
	})
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("broadcast blocked for %s", elapsed)
	}

	if got := hub.ClientCount(); got != 1 {
		t.Fatalf("client count = %d, want 1", got)
	}
	if got := len(slow.send); got != 1 {
		t.Fatalf("slow client queue len = %d, want 1", got)
	}
	select {
	case <-slow.done:
	default:
		t.Fatal("slow client was not removed after queue overflow")
	}

	select {
	case payload := <-healthy.send:
		var event map[string]any
		if err := json.Unmarshal(payload, &event); err != nil {
			t.Fatalf("unmarshal payload: %v", err)
		}
		if got := event["type"]; got != "probe_update" {
			t.Fatalf("event type = %v, want probe_update", got)
		}
	default:
		t.Fatal("healthy client did not receive broadcast payload")
	}
}

func TestHubBroadcastRemovesSlowClientWithFullQueue(t *testing.T) {
	hub := NewHub()
	full := &client{send: make(chan []byte, 1), done: make(chan struct{})}
	full.send <- []byte(`"busy"`)
	hub.registerClient(full)

	hub.Broadcast(map[string]any{
		"type":        "probe_update",
		"endpoint_id": 1,
	})

	if got := hub.ClientCount(); got != 0 {
		t.Fatalf("client count = %d, want 0", got)
	}
	if got := len(full.send); got != 1 {
		t.Fatalf("full client queue len = %d, want 1", got)
	}
	select {
	case <-full.done:
	default:
		t.Fatal("full client was not removed")
	}
}

func TestHubWriteFailureRemovesOnlyFailingClient(t *testing.T) {
	hub := NewHub()

	failingConn, failingPeer := newPipeWebSocketConn(t)
	healthyConn, healthyPeer := newPipeWebSocketConn(t)
	defer healthyPeer.Close()

	failingClient := newClient(failingConn, hub.config.clientSendQueueSize)
	healthyClient := newClient(healthyConn, hub.config.clientSendQueueSize)
	hub.registerClient(failingClient)
	hub.registerClient(healthyClient)

	failingDone := runPump(func() { hub.writePump(failingClient) })
	healthyDone := runPump(func() { hub.writePump(healthyClient) })
	healthyWrite := awaitPeerRead(healthyPeer)

	if err := failingPeer.Close(); err != nil {
		t.Fatalf("close failing peer: %v", err)
	}

	hub.Broadcast(map[string]any{
		"type":        "probe_update",
		"endpoint_id": 7,
	})

	waitForSignal(t, failingDone, "failing write pump exit")
	waitForClientCount(t, hub, 1)

	select {
	case n := <-healthyWrite:
		if n <= 0 {
			t.Fatal("healthy peer did not receive websocket payload")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for healthy peer payload")
	}

	if got := hub.ClientCount(); got != 1 {
		t.Fatalf("client count = %d, want 1", got)
	}

	hub.Close()
	waitForClientCount(t, hub, 0)
	waitForSignal(t, healthyDone, "healthy write pump exit after close")
}

func TestHubReadPumpDisconnectAndClose(t *testing.T) {
	hub := NewHub()

	clientAConn, peerA := newPipeWebSocketConn(t)
	clientBConn, peerB := newPipeWebSocketConn(t)
	defer peerB.Close()

	clientA := newClient(clientAConn, hub.config.clientSendQueueSize)
	clientB := newClient(clientBConn, hub.config.clientSendQueueSize)
	hub.registerClient(clientA)
	hub.registerClient(clientB)

	readDoneA := runPump(func() { hub.readPump(clientA) })
	readDoneB := runPump(func() { hub.readPump(clientB) })
	writeDoneB := runPump(func() { hub.writePump(clientB) })

	if err := peerA.Close(); err != nil {
		t.Fatalf("close peerA: %v", err)
	}

	waitForSignal(t, readDoneA, "clientA read pump exit")
	waitForClientCount(t, hub, 1)

	hub.Close()
	waitForClientCount(t, hub, 0)
	waitForSignal(t, readDoneB, "clientB read pump exit after close")
	waitForSignal(t, writeDoneB, "clientB write pump exit after close")
}

func TestHubWriteClientPayloadAttemptsWriteAfterDoneClosed(t *testing.T) {
	hub := NewHub()

	conn, peer := newPipeWebSocketConn(t)
	defer peer.Close()

	c := newClient(conn, hub.config.clientSendQueueSize)
	close(c.done)

	written := awaitPeerRead(peer)
	if err := hub.writeClientPayload(c, []byte(`{"type":"probe_update","endpoint_id":99}`)); err != nil {
		t.Fatalf("write client payload: %v", err)
	}

	select {
	case n := <-written:
		if n <= 0 {
			t.Fatal("expected websocket payload bytes after done was closed")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for websocket payload")
	}
}

func TestHubKeepaliveRetainsResponsiveIdleClient(t *testing.T) {
	hub := newHubWithConfig(hubConfig{
		clientSendQueueSize: 4,
		clientWriteTimeout:  50 * time.Millisecond,
		pingInterval:        10 * time.Millisecond,
		pongWait:            35 * time.Millisecond,
	})
	serverConn, peer := newPipeWebSocketConn(t)
	defer peer.Close()

	c := newClient(serverConn, hub.config.clientSendQueueSize)
	hub.registerClient(c)

	readDone := runPump(func() { hub.readPump(c) })
	writeDone := runPump(func() { hub.writePump(c) })
	clientDone := runPeerFrameLoop(peer, true)

	time.Sleep(4 * hub.config.pingInterval)
	if got := hub.ClientCount(); got != 1 {
		t.Fatalf("client count = %d, want 1", got)
	}

	hub.Close()
	waitForClientCount(t, hub, 0)
	waitForSignal(t, readDone, "responsive keepalive read pump exit")
	waitForSignal(t, writeDone, "responsive keepalive write pump exit")
	waitForSignal(t, clientDone, "responsive keepalive client reader exit")
}

func TestHubKeepaliveRemovesClientWithoutPong(t *testing.T) {
	hub := newHubWithConfig(hubConfig{
		clientSendQueueSize: 4,
		clientWriteTimeout:  50 * time.Millisecond,
		pingInterval:        10 * time.Millisecond,
		pongWait:            35 * time.Millisecond,
	})
	serverConn, peer := newPipeWebSocketConn(t)
	defer peer.Close()

	c := newClient(serverConn, hub.config.clientSendQueueSize)
	hub.registerClient(c)

	readDone := runPump(func() { hub.readPump(c) })
	writeDone := runPump(func() { hub.writePump(c) })
	clientDone := runPeerFrameLoop(peer, false)

	waitForClientCount(t, hub, 0)
	waitForSignal(t, readDone, "no-pong read pump exit")
	waitForSignal(t, writeDone, "no-pong write pump exit")
	waitForSignal(t, clientDone, "no-pong client reader exit")
}

func newPipeWebSocketConn(t *testing.T) (*websocket.Conn, net.Conn) {
	t.Helper()

	clientSide, serverSide := net.Pipe()
	handshakeDone := make(chan error, 1)

	go func() {
		reader := bufio.NewReader(serverSide)
		req, err := http.ReadRequest(reader)
		if err != nil {
			handshakeDone <- err
			return
		}

		challengeKey := req.Header.Get("Sec-WebSocket-Key")
		response := strings.Join([]string{
			"HTTP/1.1 101 Switching Protocols",
			"Upgrade: websocket",
			"Connection: Upgrade",
			"Sec-WebSocket-Accept: " + computeAcceptKey(challengeKey),
			"",
			"",
		}, "\r\n")
		_, err = io.WriteString(serverSide, response)
		handshakeDone <- err
	}()

	u, err := url.Parse("ws://example.test/ws")
	if err != nil {
		t.Fatalf("parse websocket URL: %v", err)
	}

	conn, _, err := websocket.NewClient(clientSide, u, nil, 1024, 1024)
	if err != nil {
		t.Fatalf("new websocket client: %v", err)
	}
	if err := <-handshakeDone; err != nil {
		t.Fatalf("handshake: %v", err)
	}

	return conn, serverSide
}

func computeAcceptKey(challengeKey string) string {
	h := sha1.New()
	h.Write([]byte(challengeKey))
	h.Write([]byte("258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func awaitPeerRead(peer net.Conn) <-chan int {
	result := make(chan int, 1)
	go func() {
		buf := make([]byte, 512)
		_ = peer.SetReadDeadline(time.Now().Add(2 * time.Second))
		n, _ := peer.Read(buf)
		result <- n
	}()
	return result
}

func runPeerFrameLoop(peer net.Conn, respondToPing bool) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			opcode, payload, err := readPeerFrame(peer)
			if err != nil {
				return
			}
			if opcode == websocket.PingMessage && respondToPing {
				if err := writeMaskedControlFrame(peer, websocket.PongMessage, payload); err != nil {
					return
				}
			}
		}
	}()
	return done
}

func readPeerFrame(peer net.Conn) (int, []byte, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(peer, header); err != nil {
		return 0, nil, err
	}

	payloadLen := int64(header[1] & 0x7f)
	switch payloadLen {
	case 126:
		extended := make([]byte, 2)
		if _, err := io.ReadFull(peer, extended); err != nil {
			return 0, nil, err
		}
		payloadLen = int64(binary.BigEndian.Uint16(extended))
	case 127:
		extended := make([]byte, 8)
		if _, err := io.ReadFull(peer, extended); err != nil {
			return 0, nil, err
		}
		payloadLen = int64(binary.BigEndian.Uint64(extended))
	}

	if header[1]&0x80 != 0 {
		maskKey := make([]byte, 4)
		if _, err := io.ReadFull(peer, maskKey); err != nil {
			return 0, nil, err
		}
	}

	payload := make([]byte, payloadLen)
	if _, err := io.ReadFull(peer, payload); err != nil {
		return 0, nil, err
	}
	return int(header[0] & 0x0f), payload, nil
}

func writeMaskedControlFrame(peer net.Conn, opcode int, payload []byte) error {
	if len(payload) > 125 {
		return io.ErrShortBuffer
	}

	header := []byte{0x80 | byte(opcode), 0x80 | byte(len(payload))}
	mask := []byte{0, 0, 0, 0}
	maskedPayload := append([]byte(nil), payload...)
	for i := range maskedPayload {
		maskedPayload[i] ^= mask[i%len(mask)]
	}

	if _, err := peer.Write(header); err != nil {
		return err
	}
	if _, err := peer.Write(mask); err != nil {
		return err
	}
	if len(maskedPayload) == 0 {
		return nil
	}
	_, err := peer.Write(maskedPayload)
	return err
}

func runPump(fn func()) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		fn()
		close(done)
	}()
	return done
}

func waitForSignal(t *testing.T, signal <-chan struct{}, label string) {
	t.Helper()

	select {
	case <-signal:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %s", label)
	}
}

func waitForClientCount(t *testing.T, hub *Hub, want int) {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if hub.ClientCount() == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("client count = %d, want %d", hub.ClientCount(), want)
}
