package signaling

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/kidandcat/voicechat/internal/auth"
	"github.com/kidandcat/voicechat/internal/channel"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Message struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type Client struct {
	UserID   int64
	Username string
	Conn     *websocket.Conn
	Send     chan []byte
}

type Hub struct {
	mu      sync.RWMutex
	clients map[int64]*Client
}

var GlobalHub = &Hub{
	clients: make(map[int64]*Client),
}

func (h *Hub) Register(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[client.UserID] = client
}

func (h *Hub) Unregister(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if _, ok := h.clients[client.UserID]; ok {
		close(client.Send)
		delete(h.clients, client.UserID)
	}
}

func (h *Hub) Broadcast(msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, client := range h.clients {
		select {
		case client.Send <- msg:
		default:
			// drop message if client is too slow
		}
	}
}

func (h *Hub) BroadcastToChannel(channelID int64, msg []byte) {
	users := channel.GetUsers(channelID)
	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, u := range users {
		if client, ok := h.clients[u.ID]; ok {
			select {
			case client.Send <- msg:
			default:
			}
		}
	}
}

func (h *Hub) SendTo(userID int64, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if client, ok := h.clients[userID]; ok {
		select {
		case client.Send <- msg:
		default:
		}
	}
}

func HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromRequest(r)
	if user == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("websocket upgrade error:", err)
		return
	}

	client := &Client{
		UserID:   user.ID,
		Username: user.Username,
		Conn:     conn,
		Send:     make(chan []byte, 256),
	}

	GlobalHub.Register(client)

	go client.writePump()
	go client.readPump()
}

func (c *Client) writePump() {
	defer c.Conn.Close()
	for msg := range c.Send {
		if err := c.Conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			return
		}
	}
}

func (c *Client) readPump() {
	defer func() {
		chID := channel.Leave(c.UserID)
		GlobalHub.Unregister(c)
		c.Conn.Close()
		if chID > 0 {
			broadcastChannelUpdate(chID)
		}
		broadcastPresence()
	}()

	for {
		_, raw, err := c.Conn.ReadMessage()
		if err != nil {
			return
		}

		var msg Message
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		handleMessage(c, msg)
	}
}

func handleMessage(c *Client, msg Message) {
	switch msg.Type {
	case "join_channel":
		var p struct {
			ChannelID int64 `json:"channel_id"`
		}
		json.Unmarshal(msg.Payload, &p)

		oldCh := channel.GetUserChannel(c.UserID)
		channel.Join(p.ChannelID, c.UserID, c.Username)

		if oldCh > 0 {
			broadcastChannelUpdate(oldCh)
		}
		broadcastChannelUpdate(p.ChannelID)
		broadcastPresence()

	case "leave_channel":
		chID := channel.Leave(c.UserID)
		if chID > 0 {
			broadcastChannelUpdate(chID)
		}
		broadcastPresence()

	case "mute":
		var p struct {
			Muted bool `json:"muted"`
		}
		json.Unmarshal(msg.Payload, &p)
		channel.SetMuted(c.UserID, p.Muted)
		chID := channel.GetUserChannel(c.UserID)
		if chID > 0 {
			broadcastChannelUpdate(chID)
		}

	case "speaking":
		var p struct {
			Speaking bool `json:"speaking"`
		}
		json.Unmarshal(msg.Payload, &p)
		channel.SetSpeaking(c.UserID, p.Speaking)
		chID := channel.GetUserChannel(c.UserID)
		if chID > 0 {
			broadcastChannelUpdate(chID)
		}
	}
}

func broadcastChannelUpdate(channelID int64) {
	users := channel.GetUsers(channelID)
	data, _ := json.Marshal(map[string]any{
		"type":       "channel_users",
		"channel_id": channelID,
		"users":      users,
	})
	GlobalHub.Broadcast(data)
}

func broadcastPresence() {
	states := channel.GetAllChannelStates()
	data, _ := json.Marshal(map[string]any{
		"type":     "presence",
		"channels": states,
	})
	GlobalHub.Broadcast(data)
}
