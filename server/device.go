package server

import (
	"encoding/json"
	"log"
	"sync"
)

// Global device registry.
var (
	devices   = make(map[string]*Device)
	DevicesMu sync.RWMutex
)

// Device represents a connected device in the registry.
type Device struct {
	ID              string
	Name            string
	WS              WebSocketConn
	ConnectedPeers  map[string]bool
	mu              sync.RWMutex
}

// WebSocketConn defines the interface required for WebSocket connections.
type WebSocketConn interface {
	ReadMessage() (int, []byte, error)
	WriteJSON(v interface{}) error
	Close() error
}

// RegisterDevice adds a device to the global registry and broadcasts the join event.
func RegisterDevice(ws WebSocketConn, id, name string) {
	device := &Device{
		ID:             id,
		Name:           name,
		WS:             ws,
		ConnectedPeers: make(map[string]bool),
	}

	DevicesMu.Lock()
	devices[id] = device
	DevicesMu.Unlock()

	// Broadcast device joined to all other devices.
	BroadcastDeviceJoined(id, name)
}

// UnregisterDevice removes a device from the global registry and broadcasts the leave event.
func UnregisterDevice(id string) {
	DevicesMu.Lock()
	_, ok := devices[id]
	if ok {
		delete(devices, id)
	}
	DevicesMu.Unlock()

	if ok {
		BroadcastDeviceLeft(id)
	}
}

// GetDevices returns a snapshot list of all connected devices.
func GetDevices() []DeviceInfo {
	DevicesMu.RLock()
	defer DevicesMu.RUnlock()

	list := make([]DeviceInfo, 0, len(devices))
	for id, dev := range devices {
		list = append(list, DeviceInfo{ID: id, Name: dev.Name})
	}
	return list
}

// BroadcastDeviceJoined notifies all devices (except the new one) that a device joined.
func BroadcastDeviceJoined(fromID, name string) {
	msg := Message{
		Type: TypeDeviceJoined,
		From: fromID,
	}
	payload, _ := json.Marshal(DeviceJoinedPayload{ID: fromID, Payload: name})
	msg.Payload = payload

	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("[device] marshal device_joined failed: %v", err)
		return
	}

	DevicesMu.RLock()
	defer DevicesMu.RUnlock()

	for id, dev := range devices {
		if id == fromID {
			continue
		}
		if err := dev.WS.WriteJSON(json.RawMessage(data)); err != nil {
			log.Printf("[device] send device_joined to %s failed: %v", id, err)
		}
	}
}

// BroadcastDeviceLeft notifies all remaining devices that a device left.
func BroadcastDeviceLeft(fromID string) {
	msg := Message{
		Type: TypeDeviceLeft,
		From: fromID,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("[device] marshal device_left failed: %v", err)
		return
	}

	DevicesMu.RLock()
	defer DevicesMu.RUnlock()

	for _, dev := range devices {
		if err := dev.WS.WriteJSON(json.RawMessage(data)); err != nil {
			log.Printf("[device] send device_left failed: %v", err)
		}
	}
}
