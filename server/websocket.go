package server

import (
	"encoding/json"
	"log"
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
	ID   string
	Name string
	WS   WebSocketConn
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

// Upgrader configures the WebSocket upgrader.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for now
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

	// Read registration message: { "type": "register", "from": "<deviceId>", "payload": "<userAgent>" }
	_, raw, err := ws.ReadMessage()
	if err != nil {
		log.Printf("[ws] read registration failed: %v", err)
		conn.Close()
		return
	}

	var regMsg struct {
		Type    string `json:"type"`
		From    string `json:"from"`
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
		// Try parsing as plain string
		var nameStr string
		if err := json.Unmarshal(regMsg.Payload, &nameStr); err == nil {
			payload.DeviceName = nameStr
		}
	}

	// Derive a short platform name from userAgent for cleaner display.
	platform := shortPlatform(payload.DeviceName)

	client := &Client{
		ID:   regMsg.From,
		Name: platform,
		WS:   ws,
	}

	log.Printf("[ws] client %s connected (%s)", regMsg.From, platform)
	hub.Register <- client
	defer func() { hub.Unregister <- client.ID }()

	hub.readPump(client)
}
