package telemetry

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	clientSendQueueSize = 16
	clientWriteTimeout  = 2 * time.Second
)

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
}

func NewHub() *Hub {
	return &Hub{
		clients: map[*client]struct{}{},
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				return true
			},
		},
	}
}

func newClient(conn *websocket.Conn) *client {
	return &client{
		conn: conn,
		send: make(chan []byte, clientSendQueueSize),
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

	client := newClient(conn)
	h.registerClient(client)

	go h.writePump(client)
	go h.readPump(client)
}

func (h *Hub) readPump(c *client) {
	defer h.unregisterClient(c)

	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
	}
}

func (h *Hub) writePump(c *client) {
	defer h.unregisterClient(c)

	for {
		select {
		case <-c.done:
			return
		case payload := <-c.send:
			if err := h.writeClientPayload(c, payload); err != nil {
				return
			}
		}
	}
}

func (h *Hub) writeClientPayload(c *client, payload []byte) error {
	if err := c.conn.SetWriteDeadline(time.Now().Add(clientWriteTimeout)); err != nil {
		return err
	}
	return c.conn.WriteMessage(websocket.TextMessage, payload)
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
