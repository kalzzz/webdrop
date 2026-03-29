package server

import "encoding/json"

// MessageType represents the type of a WebSocket message.
type MessageType string

const (
	TypeRegister     MessageType = "register"
	TypeRegistered   MessageType = "registered" // server → client: your own id and name
	TypeDeviceJoined MessageType = "device_joined"
	TypeDeviceLeft   MessageType = "device_left"
	TypeDeviceList   MessageType = "device_list"
	TypeOffer        MessageType = "offer"
	TypeAnswer       MessageType = "answer"
	TypeIce          MessageType = "ice"
	TypeFileOffer    MessageType = "file_offer"
	TypeFileAccept   MessageType = "file_accept"
	TypeFileReject   MessageType = "file_reject"
	TypeFileCancel   MessageType = "file_cancel"
)

// Message represents a generic WebSocket message.
type Message struct {
	Type    MessageType     `json:"type"`
	From    string          `json:"from,omitempty"`
	To      string          `json:"to,omitempty"`
	ConnID  string          `json:"connId,omitempty"`
	LANIP   string          `json:"lan_ip,omitempty"` // Server 注入：发送者的 LAN IP（用于 mDNS 替换）
	Payload json.RawMessage `json:"payload,omitempty"`
}

// RegisterPayload is the payload for the Register message (frontend sends raw string).
type RegisterPayload struct {
	DeviceName string `json:"deviceName"`
}

// DeviceInfo represents a connected device for list responses.
type DeviceInfo struct {
	ID   string `json:"id"`
	Name string `json:"payload"` // frontend expects "payload" field as device name
}

// DeviceListPayload is the payload for the DeviceList message.
type DeviceListPayload struct {
	Devices []DeviceInfo `json:"devices"`
}

// RegisteredPayload is sent to a client right after it registers,
// telling it its own assigned ID and display name.
type RegisteredPayload struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// DeviceJoinedPayload is the payload for the DeviceJoined message.
type DeviceJoinedPayload struct {
	ID      string `json:"id"`
	Payload string `json:"payload"`
}

// DeviceLeftPayload is just the device ID string.
type DeviceLeftPayload string

// SDPData holds SDP offer/answer data.
type SDPData struct {
	SDP string `json:"sdp"`
}

// ICEData holds ICE candidate data. Does NOT contain LANIP — LANIP is at Message top level.
type ICEData struct {
	Candidate   string `json:"candidate"`
	SDPMid      string `json:"sdpMid"`
	SDPMLineIndex int  `json:"sdpMLineIndex"`
}

// FileOfferPayload holds the v2head file metadata (旧版单文件格式).
type FileOfferPayload struct {
	V2Head json.RawMessage `json:"v2head"`
}

// FileOfferPayloadV2 holds multiple files metadata (新版多文件格式).
// 格式：{ "files": [{ "name": "...", "size": ..., "blocks": ..., "MD5": "..." }, ...] }
type FileOfferPayloadV2 struct {
	Files []FileInfo `json:"files"`
}

// FileInfo 单个文件信息
type FileInfo struct {
	Name   string `json:"name"`
	Size   uint64 `json:"size"`
	Blocks uint32 `json:"blocks"`
	MD5    string `json:"MD5"`
}

// FileAcceptPayloadV2 file_accept 的 payload（支持多文件）
type FileAcceptPayloadV2 struct {
	AcceptedFiles []string `json:"acceptedFiles,omitempty"`
}

// Encode encodes a message to JSON bytes.
func Encode(msg interface{}) ([]byte, error) {
	return json.Marshal(msg)
}

// Decode decodes JSON bytes into a Message.
func Decode(data []byte) (*Message, error) {
	var msg Message
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}
