# WebDrop mDNS LAN 直连增强方案

**版本**：v1.1
**日期**：2026-03-24
**状态**：已实现

---

## 背景与目标

### 问题

iOS 设备在 WebRTC ICE 候选收集时，会产生 mDNS（`.local`）格式的候选地址，例如：

```
28b0dbaa-ecb4-4d4c-81f0-eaa927918aac.local
```

Windows 设备无法解析这些地址，导致 LAN 直连成功率低，连接建立失败。

### 目标

在不破坏 WebRTC 标准流程的前提下，提高 LAN 直连成功率（尤其 iOS ↔ Windows）。

### 核心策略

- 保留原始 ICE 流程，不伪造 candidate
- WebSocket 服务端获取连接者的 LAN IP，在转发 candidate 时附带发送者的 LAN IP
- 接收方将 candidate 中的 `.local` 地址替换为 LAN IP，再加入 ICE

---

## 核心原理

```
iOS 设备 ──TCP WebSocket 连接──▶ 服务端
              ↑
         源 IP = 192.168.1.101（iOS 的局域网 IP）

TCP 握手时，操作系统告诉服务端：这个连接是从哪个 IP 发来的。
服务端记录：clients["iOS-id"].LanIP = "192.168.1.101"
```

服务端不需要"推理" IP 归属，TCP 连接是谁发起的，源 IP 就是谁的。

每台设备只有一个 WebSocket 连接，服务端只记录这个连接对端的 IP。不存在"一台设备有多个 IP 需要选择"的问题。

---

## 数据结构

### Client 结构体（`server/websocket.go`）

```go
type Client struct {
    ID     string  // 设备唯一 ID（浏览器生成）
    Name   string  // 设备名称（从 UserAgent 推断）
    LanIP  string  // WebSocket TCP 连接对端的 LAN IP
    WS     WebSocketConn
}
```

### 设备表（内存 map）

```
clients = {
    "iOS-id-abc":  { LanIP: "192.168.1.101", WS: <conn> },
    "Win-id-xyz":  { LanIP: "192.168.1.102", WS: <conn> }
}
```

### Message 结构体（`server/msg.go`）

```go
type Message struct {
    Type    MessageType     `json:"type"`
    From    string          `json:"from,omitempty"`
    To      string          `json:"to,omitempty"`
    ConnID  string          `json:"connId,omitempty"`
    LANIP   string          `json:"lan_ip,omitempty"` // 服务端注入：发送者的 LAN IP
    Payload json.RawMessage `json:"payload,omitempty"`
}
```

**关键**：`lan_ip` 作为 Message 顶层字段，不侵入 `payload` 内部（`payload` 保持与前端一致的原生 ICEData 结构）。

### ICEData 结构体（`server/msg.go`）

```go
type ICEData struct {
    Candidate    string `json:"candidate"`
    SDPMid      string `json:"sdpMid"`
    SDPMLineIndex int  `json:"sdpMLineIndex"`
}
```

**注意**：`ICEData` 不包含 `LANIP`，保持干净。

---

## 服务端信令流程

### 设备连接阶段

```
  [iOS 浏览器]                   [WebSocket 服务端]
        │                               │
        │ ─── TCP 三次握手 ───────────→ │
        │   源 IP = 192.168.1.101        │
        │   (iOS 的局域网 IP)            │
        │                               │
        │ ─── HTTP GET /ws ───────────→ │
        │   r.RemoteAddr = "192.168.1.101:54321"
        │                               │
        │ ←── 101 Switching ──────────── │
        │                               │
        │ ─── register ────────────────→ │
        │   { type:"register",         │
        │     from:"iOS-id",           │
        │     payload:"Safari on iOS" } │
        │                               │
        │                    ┌─────────────────────┐
        │                    │ handleWS() 处理：   │
        │                    │                     │
        │                    │ 1. 解析 register    │
        │                    │ 2. extractLANIP(   │
        │                    │    "192.168.1.101:54321")
        │                    │    = "192.168.1.101" │
        │                    │ 3. client.LanIP =   │
        │                    │    "192.168.1.101"   │
        │                    │ 4. clients[id] =    │
        │                    │    { LanIP, WS }     │
        │                    └─────────────────────┘
        │                               │
        │ ←── registered ────────────── │
```

### ICE 转发阶段（核心改动）

```
  [iOS 设备]                    [服务端]                    [Windows 设备]
        │                         │                              │
        │ ── ICE candidate ────→ │                              │
        │   type: "ice"           │                              │
        │   from: "iOS-id"        │ dispatch(iOS-client, msg)   │
        │   to: "Win-id"          │ ┌────────────────────────┐   │
        │   payload: {            │ │ msg.LANIP =            │   │
        │     candidate: "..."     │ │   iOS-client.LanIP     │   │
        │     "...xxxx.local..."   │ │   = "192.168.1.101"    │   │
        │   }                     │ └────────────────────────┘   │
        │                         │                              │
        │                         │ ── 转发 ICE ────────────────→ │
        │                         │   type: "ice"                 │
        │                         │   from: "iOS-id"             │
        │                         │   to: "Win-id"               │
        │                         │   lan_ip: "192.168.1.101" ← 注入 │
        │                         │   payload: {                 │
        │                         │     candidate: "...local..."   │
        │                         │   }                          │
        │                         │                              │
        │                         │         ┌──────────────────────────┐
        │                         │         │ Windows handleIce():      │
        │                         │         │                          │
        │                         │         │ 1. lan_ip = "192.168.1.101"
        │                         │         │ 2. candidate 含 ".local"  │
        │                         │         │                          │
        │                         │         │ 3. 拆分字符串，按空格分    │
        │                         │         │    找到含 ".local" 的字段  │
        │                         │         │    替换为 lan_ip          │
        │                         │         │                          │
        │                         │         │ 4. RTCIceCandidate(       │
        │                         │         │    替换后字符串).add()    │
        │                         │         └──────────────────────────┘
```

---

## 关键函数实现

### extractLANIP（`server/websocket.go`）

```go
func extractLANIP(remoteAddr string) string {
    host, _, err := net.SplitHostPort(remoteAddr)
    if err != nil {
        return remoteAddr
    }
    return host
}
```

从 `r.RemoteAddr`（格式 `"192.168.1.101:54321"`）中提取 IP 部分。

### dispatch（`server/websocket.go`）

```go
func (h *DeviceHub) dispatch(client *Client, msg *Message) {
    switch msg.Type {
    case TypeOffer, TypeAnswer, TypeIce,
        TypeFileOffer, TypeFileAccept, TypeFileReject, TypeFileCancel:
        if msg.To != "" {
            // ICE 消息：注入发送者的 LAN IP
            if msg.Type == TypeIce {
                msg.LANIP = client.LanIP
            }
            h.SendTo(msg.To, msg)
        }
    default:
        log.Printf("[dispatch] unexpected message type from %s: %s", client.ID, msg.Type)
    }
}
```

其余消息类型（Offer、Answer、FileOffer 等）透传，不改动。

### replaceMDNSWithLANIP（`web/static/app.js`）

```javascript
function replaceMDNSWithLANIP(candidateStr, lanIP) {
    const parts = candidateStr.split(' ');
    for (const part of parts) {
        if (part.includes('.local')) {
            return candidateStr.replace(part, lanIP);
        }
    }
    return candidateStr;
}
```

ICE candidate 是空格分隔的字符串，mDNS 主机名是其中一个字段。直接找包含 `.local` 的字段，替换为 LAN IP。

### handleIce（`web/static/app.js`）

```javascript
async function handleIce(msg) {
    const { connId, payload, lan_ip } = msg;

    let candidateStr = payload.candidate;

    // 若存在 lan_ip 且 candidate 包含 .local，替换 mDNS 地址
    if (lan_ip && candidateStr && candidateStr.includes('.local')) {
        candidateStr = replaceMDNSWithLANIP(candidateStr, lan_ip);
        console.log('[handleIce] mDNS replaced:', candidateStr.substring(0, 80) + '...');
    }

    const iceCandidateObj = {
        candidate: candidateStr,
        sdpMid: payload.sdpMid,
        sdpMLineIndex: payload.sdpMLineIndex
    };

    // 以下队列逻辑保持不变
    let pc = state.peerConnections.get(connId);
    if (!pc) {
        if (!state.pendingCandidates.has(connId)) state.pendingCandidates.set(connId, []);
        state.pendingCandidates.get(connId).push(iceCandidateObj);
        return;
    }
    if (!iceCandidateObj.candidate) return;
    if (!pc.remoteDescription) {
        if (!state.pendingCandidates.has(connId)) state.pendingCandidates.set(connId, []);
        state.pendingCandidates.get(connId).push(iceCandidateObj);
        return;
    }
    await pc.addIceCandidate(new RTCIceCandidate(iceCandidateObj));
}
```

**mDNS 格式兼容**：
- `28b0dbaa-ecb4-4d4c-81f0-eaa927918aac.local`（无括号）
- `[28b0dbaa-ecb4-4d4c-81f0-eaa927918aac.local]`（有括号）
- `[fe80::1%25eth0].local`（IPv6 mDNS）

以上全部通过 `includes('.local')` 检测，`split(' ')` 找到字段后替换，无需逐个格式处理。

---

## 信令格式汇总

| 方向 | 格式 |
|------|------|
| Client → Server | `{"type":"ice","from":"A","to":"B","connId":"...","payload":{candidate,sdpMid,sdpMLineIndex}}` |
| Server → Client | `{"type":"ice","from":"A","to":"B","connId":"...","lan_ip":"192.168.1.101","payload":{...}}` |

Payload 内容**原样透传**，服务端只加 `lan_ip` 顶层字段。

---

## 涉及修改的文件清单

| 文件 | 改动内容 |
|------|---------|
| `server/msg.go` | `Message` 结构体加 `LANIP` 顶层字段；`ICEData` 不变（无 LANIP） |
| `server/websocket.go` | `dispatch()` 中 ICE 消息注入 `client.LanIP → msg.LANIP`；新增 `extractLANIP()` |
| `web/static/app.js` | `handleIce()` 从 `msg.lan_ip` 读取并执行 mDNS 替换；新增 `replaceMDNSWithLANIP()` |

---

## 已知限制

| 限制 | 说明 |
|------|------|
| HTTP 代理环境 | `r.RemoteAddr` 会拿到代理 IP，而非客户端真实 IP；本方案仅适用于纯局域网环境 |
| 模拟器 localhost | 模拟器通过 localhost 连接，`r.RemoteAddr` = `127.0.0.1`，无实际意义 |
| 多宿主机 | 若设备有多个网络接口，服务端只会记录 WebSocket TCP 连接对端的 IP |

---

**文档结束**
