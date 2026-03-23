package server

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

// DeviceHub manages all connected devices.
type DeviceHub struct {
	Register   chan *Client
	Unregister chan string
	clients    map[string]*Client
	mu         sync.RWMutex
}

// Client represents a single WebSocket client connection.
type Client struct {
	ID    string // 设备唯一 ID
	Name  string // 设备名称（从 UserAgent 推断）
	LanIP string // WebSocket TCP 连接对端的 LAN IP
	WS    WebSocketConn
}

// NewDeviceHub creates and returns a new DeviceHub instance.
func NewDeviceHub() *DeviceHub {
	return &DeviceHub{
		Register:   make(chan *Client, 64),
		Unregister: make(chan string, 64),
		clients:    make(map[string]*Client),
	}
}

// Run starts the device hub's main event loop.
func (h *DeviceHub) Run() {
	for {
		select {
		case client := <-h.Register:
			h.registerClient(client)
		case id := <-h.Unregister:
			h.unregisterClient(id)
		}
	}
}

func (h *DeviceHub) registerClient(client *Client) {
	h.mu.Lock()
	h.clients[client.ID] = client
	h.mu.Unlock()

	RegisterDevice(client.WS, client.ID, client.Name)

	// Tell the client its own assigned ID and display name.
	regMsg := Message{
		Type:    TypeRegistered,
		Payload: mustMarshal(RegisteredPayload{ID: client.ID, Name: client.Name}),
	}
	if err := client.WS.WriteJSON(regMsg); err != nil {
		log.Printf("[hub] send registered to %s failed: %v", client.ID, err)
	}

	// Send the new device list to the newly connected client.
	devices := GetDevices()
	listMsg := Message{
		Type:    TypeDeviceList,
		Payload: mustMarshal(DeviceListPayload{Devices: devices}),
	}
	if err := client.WS.WriteJSON(listMsg); err != nil {
		log.Printf("[hub] send device_list to %s failed: %v", client.ID, err)
	}
}

func (h *DeviceHub) unregisterClient(id string) {
	h.mu.Lock()
	if _, ok := h.clients[id]; ok {
		delete(h.clients, id)
	}
	h.mu.Unlock()
	UnregisterDevice(id)
}

// SendTo forwards a message to a specific device by ID.
func (h *DeviceHub) SendTo(toID string, msg *Message) error {
	h.mu.RLock()
	client, ok := h.clients[toID]
	h.mu.RUnlock()
	if !ok {
		return ErrDeviceNotFound
	}
	return client.WS.WriteJSON(msg)
}

func (h *DeviceHub) dispatch(client *Client, msg *Message) {
	switch msg.Type {
	case TypeOffer, TypeAnswer, TypeIce,
		TypeFileOffer, TypeFileAccept, TypeFileReject, TypeFileCancel:
		if msg.To != "" {
			// ICE 消息：注入发送者的 LAN IP（用于接收方替换 mDNS 地址）
			if msg.Type == TypeIce {
				msg.LANIP = client.LanIP
			}
			log.Printf("[dispatch] forwarding %s from=%s to=%s connId=%s", msg.Type, client.ID, msg.To, msg.ConnID)
			if err := h.SendTo(msg.To, msg); err != nil {
				log.Printf("[dispatch] forward %s to %s failed: %v", msg.Type, msg.To, err)
			}
		}
	default:
		log.Printf("[dispatch] unexpected message type from %s: %s", client.ID, msg.Type)
	}
}

// wsConnAdapter wraps a Gorilla WebSocket connection to satisfy WebSocketConn.
type wsConnAdapter struct{ *websocket.Conn }

func (a *wsConnAdapter) WriteJSON(v interface{}) error { return a.Conn.WriteJSON(v) }

// ErrDeviceNotFound is returned when a message targets an unknown device.
var ErrDeviceNotFound = &deviceNotFoundError{}

type deviceNotFoundError struct{}

func (e *deviceNotFoundError) Error() string { return "device not found" }

func mustMarshal(v interface{}) json.RawMessage {
	data, err := json.Marshal(v)
	if err != nil {
		log.Printf("[mustMarshal] error: %v", err)
		return nil
	}
	return data
}

func (h *DeviceHub) readPump(client *Client) {
	for {
		_, raw, err := client.WS.ReadMessage()
		if err != nil {
			return
		}

		var msg Message
		if err := json.Unmarshal(raw, &msg); err != nil {
			log.Printf("[readPump] decode from %s failed: %v", client.ID, err)
			continue
		}

		h.dispatch(client, &msg)
	}
}

// extractLANIP extracts the IP address from a "host:port" string.
func extractLANIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	return host
}

// Upgrader configures the WebSocket upgrader.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// WSHandler returns the http.Handler for WebSocket connections.
func (h *DeviceHub) WSHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handleWS(h, w, r)
	})
}

// handleWS handles incoming WebSocket connections.
func handleWS(hub *DeviceHub, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[ws] upgrade error: %v", err)
		return
	}

	ws := &wsConnAdapter{Conn: conn}

	// Read registration message
	_, raw, err := ws.ReadMessage()
	if err != nil {
		log.Printf("[ws] read registration failed: %v", err)
		conn.Close()
		return
	}

	var regMsg struct {
		Type    string          `json:"type"`
		From    string          `json:"from"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(raw, &regMsg); err != nil {
		log.Printf("[ws] decode registration failed: %v", err)
		conn.Close()
		return
	}
	if regMsg.Type != string(TypeRegister) || regMsg.From == "" {
		log.Printf("[ws] invalid registration message")
		conn.Close()
		return
	}

	// Parse device name from payload.
	var payload RegisterPayload
	if err := json.Unmarshal(regMsg.Payload, &payload); err != nil {
		var nameStr string
		if err := json.Unmarshal(regMsg.Payload, &nameStr); err == nil {
			payload.DeviceName = nameStr
		}
	}

	platform := shortPlatform(payload.DeviceName)
	lanIP := extractLANIP(r.RemoteAddr)

	client := &Client{
		ID:    regMsg.From,
		Name:  platform,
		LanIP: lanIP,
		WS:    ws,
	}

	log.Printf("[ws] client %s connected (%s, lanip=%s)", regMsg.From, platform, lanIP)
	hub.Register <- client
	defer func() { hub.Unregister <- client.ID }()

	hub.readPump(client)
}
