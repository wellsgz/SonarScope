package telemetry

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	defaultClientSendQueueSize = 512
	defaultClientWriteTimeout  = 10 * time.Second
	defaultPingInterval        = 30 * time.Second
	defaultPongWait            = 45 * time.Second
)

type hubConfig struct {
	clientSendQueueSize int
	clientWriteTimeout  time.Duration
	pingInterval        time.Duration
	pongWait            time.Duration
}

type client struct {
	conn      *websocket.Conn
	send      chan []byte
	done      chan struct{}
	closeOnce sync.Once
}

type Hub struct {
	mu       sync.RWMutex
	clients  map[*client]struct{}
	upgrader websocket.Upgrader
	config   hubConfig
}

func NewHub() *Hub {
	return newHubWithConfig(hubConfig{
		clientSendQueueSize: defaultClientSendQueueSize,
		clientWriteTimeout:  defaultClientWriteTimeout,
		pingInterval:        defaultPingInterval,
		pongWait:            defaultPongWait,
	})
}

func newHubWithConfig(cfg hubConfig) *Hub {
	if cfg.clientSendQueueSize <= 0 {
		cfg.clientSendQueueSize = defaultClientSendQueueSize
	}
	if cfg.clientWriteTimeout <= 0 {
		cfg.clientWriteTimeout = defaultClientWriteTimeout
	}
	if cfg.pingInterval <= 0 {
		cfg.pingInterval = defaultPingInterval
	}
	if cfg.pongWait <= 0 {
		cfg.pongWait = defaultPongWait
	}
	return &Hub{
		clients: map[*client]struct{}{},
		upgrader: websocket.Upgrader{
			ReadBufferSize:  8192,
			WriteBufferSize: 8192,
			CheckOrigin: func(r *http.Request) bool {
				return true
			},
		},
		config: cfg,
	}
}

func newClient(conn *websocket.Conn, sendQueueSize int) *client {
	return &client{
		conn: conn,
		send: make(chan []byte, sendQueueSize),
		done: make(chan struct{}),
	}
}

func (h *Hub) registerClient(c *client) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) unregisterClient(c *client) {
	c.closeOnce.Do(func() {
		h.mu.Lock()
		delete(h.clients, c)
		h.mu.Unlock()
		close(c.done)
		if c.conn != nil {
			_ = c.conn.Close()
		}
	})
}

func (h *Hub) snapshotClients() []*client {
	h.mu.RLock()
	defer h.mu.RUnlock()

	clients := make([]*client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	return clients
}

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	// Own deadlines inside the websocket pumps rather than inheriting HTTP timeouts.
	_ = conn.SetReadDeadline(time.Time{})
	_ = conn.SetWriteDeadline(time.Time{})

	client := newClient(conn, h.config.clientSendQueueSize)
	h.registerClient(client)

	go h.writePump(client)
	go h.readPump(client)
}

func (h *Hub) readPump(c *client) {
	defer h.unregisterClient(c)

	if err := c.conn.SetReadDeadline(time.Now().Add(h.config.pongWait)); err != nil {
		return
	}
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(h.config.pongWait))
	})

	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
	}
}

func (h *Hub) writePump(c *client) {
	defer h.unregisterClient(c)

	ticker := time.NewTicker(h.config.pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-c.done:
			return
		case payload := <-c.send:
			if err := h.writeClientPayload(c, payload); err != nil {
				return
			}
		case <-ticker.C:
			if err := h.writeClientPing(c); err != nil {
				return
			}
		}
	}
}

func (h *Hub) writeClientPayload(c *client, payload []byte) error {
	if err := c.conn.SetWriteDeadline(time.Now().Add(h.config.clientWriteTimeout)); err != nil {
		return err
	}
	return c.conn.WriteMessage(websocket.TextMessage, payload)
}

func (h *Hub) writeClientPing(c *client) error {
	deadline := time.Now().Add(h.config.clientWriteTimeout)
	if err := c.conn.SetWriteDeadline(deadline); err != nil {
		return err
	}
	return c.conn.WriteControl(websocket.PingMessage, nil, deadline)
}

func (h *Hub) Broadcast(event any) {
	payload, err := json.Marshal(event)
	if err != nil {
		return
	}

	for _, c := range h.snapshotClients() {
		select {
		case <-c.done:
			continue
		default:
		}

		select {
		case c.send <- payload:
		default:
			h.unregisterClient(c)
		}
	}
}

func (h *Hub) Close() {
	for _, c := range h.snapshotClients() {
		h.unregisterClient(c)
	}
}

func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
