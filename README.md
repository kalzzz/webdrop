# WebDrop 完整实现文档

**版本**：v1.0
**日期**：2026-03-24
**状态**：已实现

---

## 目录

1. [项目概述](#1-项目概述)
2. [系统架构](#2-系统架构)
3. [目录结构](#3-目录结构)
4. [协议设计](#4-协议设计)
5. [信令设计](#5-信令设计)
6. [WebRTC 实现](#6-webrtc-实现)
7. [服务端实现](#7-服务端实现)
8. [前端实现](#8-前端实现)
9. [mDNS LAN 直连增强](#9-mdns-lan-直连增强)
10. [已知问题与修复记录](#10-已知问题与修复记录)
11. [部署与使用](#11-部署与使用)

---

## 1. 项目概述

### 1.1 项目目标

构建一个**跨平台局域网文件传输工具**，通过浏览器即可使用，无需安装任何客户端或插件。设备间以 P2P 方式直传文件，服务器仅负责**信令转发**（设备发现、连接协商），完全不参与文件数据传输。

### 1.2 核心约束

| 约束 | 说明 |
|------|------|
| 纯 P2P | 文件数据完全不经过服务器 |
| 零存储 | 服务器内存仅存设备会话状态，无磁盘写入 |
| 零持久化 | 传输历史仅存活在页面 Session |
| 无认证 | 同一局域网内无需密码即可访问 |
| 速率优先 | 以局域网千兆带宽（~125 MB/s）为设计目标 |

### 1.3 支持平台

| 平台 | 浏览器要求 | 备注 |
|------|----------|------|
| Windows | Chrome / Edge / Firefox | 桌面入口 |
| Linux | Chrome / Firefox | 桌面入口 |
| macOS | Safari / Chrome / Firefox | 桌面入口 |
| Android | Chrome / Edge | 手机端 |
| iOS | Safari / Chrome | 手机端（需 iOS 15.4+）|

---

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                         Go Server                                │
│                     Port: 45680                                  │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │            WebSocket Server（仅信令，零文件传输）           │ │
│  │                                                            │ │
│  │  设备注册表（内存）: Device { id, name, lan_ip, ws }        │ │
│  │  传输会话表（内存）: Session { connId, from, to, status }  │ │
│  │                                                            │ │
│  │  职责：                                                    │ │
│  │  1. 设备注册 / 下线广播                                    │ │
│  │  2. SDP Offer/Answer 转发                                  │ │
│  │  3. ICE Candidate 转发（带 lan_ip 注入）                    │ │
│  │  4. 文件传输请求转发（file_offer / accept / reject）        │ │
│  │  5. QR 码生成（显示服务器地址）                             │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │            HTTP Server（静态文件服务）                       │ │
│  │  /            → index.html（单页应用）                      │ │
│  │  /ws          → WebSocket 升级                             │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
              │                                    │
              │ WebSocket (信令)                   │ WebSocket (信令)
              │                                    │
              ▼                                    ▼
┌────────────────────────┐         ┌────────────────────────────┐
│    Browser A (手机)      │         │      Browser B (电脑)       │
│                         │         │                            │
│  WebSocket 连接 ─────────┼─────────┼─── WebSocket 连接           │
│                         │         │                            │
│  ┌───────────────────┐ │         │ ┌────────────────────────┐ │
│  │ RTCPeerConnection │ │◄─P2P───►│ │ RTCPeerConnection     │ │
│  │ (conn-A-to-B)     │ │ WebRTC  │ │ (conn-B-to-A)         │ │
│  │                   │ │ Data    │ │                        │ │
│  │ DataChannel       │ │ Channel │ │ DataChannel            │ │
│  │  文件 A 传输       │ │         │ │  文件 B 传输            │ │
│  └───────────────────┘ │         │ └────────────────────────┘ │
└────────────────────────┘         └────────────────────────────┘
```

### 2.2 数据路径

```
信令路径（经过服务器）：
[Browser A] ──WebSocket──> [Go Server] ──WebSocket──> [Browser B]
  SDP/ICE/file_offer 等信令消息

文件路径（完全不经过服务器）：
[Browser A] ◄─────── WebRTC DataChannel ────────► [Browser B]
                    直连 P2P
```

---

## 3. 目录结构

```
webdrop/
│
├── main.go                 # 程序入口，HTTP+WebSocket 服务器
├── go.mod                  # Go 模块定义
├── go.sum                  # Go 依赖锁定
├── Makefile                # 构建脚本
│
├── protocol/               # 文件传输协议（Binary V2）
│   ├── types.go           # V2Head / Block / End 编解码
│   ├── crc32.go           # CRC32-C (Castagnoli) 实现
│   └── md5.go             # MD5 封装
│
├── server/                 # Go 服务器
│   ├── websocket.go       # WebSocket 服务器（设备注册、信令转发、LAN IP 注入）
│   ├── device.go          # 设备注册表（内存 map）
│   ├── signaling.go       # 平台名称推断（UserAgent → "iPhone" 等）
│   └── msg.go             # WebSocket 消息结构定义
│
├── web/                    # 前端资源
│   ├── embed.go           # 嵌入 static/ 目录（go:embed）
│   └── static/
│       ├── index.html     # 单页应用
│       ├── style.css      # 样式表（现代简洁风格）
│       └── app.js         # 核心前端逻辑（WebRTC + 协议）
│
├── mdns-lan-enhancement.md # mDNS LAN 直连增强方案文档
├── DESIGN.md              # 架构设计文档（原始版本）
└── 疑难问题.md            # 问题排查与修复记录
```

---

## 4. 协议设计

### 4.1 协议分层

```
┌──────────────────────────────────────────────────────────────┐
│                     应用层：文件传输协议（Binary V2）          │
│  V2Head → Block × N → End                                    │
├──────────────────────────────────────────────────────────────┤
│                    传输层：WebRTC DataChannel                  │
│  可靠传输，ordered:false + 无重传                             │
├──────────────────────────────────────────────────────────────┤
│                    网络层：UDP + SCTP / mDNS替换               │
│  WebRTC 底层                                                     │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 二进制消息格式

#### V2Head（文件头，无 type byte）

| 偏移 | 大小 | 字段 | 说明 |
|------|------|------|------|
| 0 | 4 | nameLen | 文件名长度（big-endian uint32） |
| 4 | N | filename | 文件名（UTF-8） |
| N+4 | 4 | fileSize_hi | 文件大小高 32 位 |
| N+8 | 4 | fileSize_lo | 文件大小低 32 位 |
| N+12 | 4 | blocks | 总块数 = ceil(fileSize / 16KB) |
| N+16 | 16 | MD5 | 文件 MD5 校验值 |
| N+32 | 4 | crc32 | CRC32-C 校验（不包含 CRC 自身）|

#### Block（数据块）

| 偏移 | 大小 | 字段 | 说明 |
|------|------|------|------|
| 0 | 1 | type = 0x01 | 消息类型 |
| 1 | 4 | blockIdx | 块索引（big-endian uint32，从 0 开始）|
| 5 | 4 | size | 数据大小（字节） |
| 9 | 4 | crc32 | CRC32-C 校验值 |
| 13 | M | data | 原始数据（通常 16KB）|

#### End（传输结束）

| 偏移 | 大小 | 字段 | 说明 |
|------|------|------|------|
| 0 | 1 | type = 0x04 | 消息类型 |
| 1 | 16 | MD5 | 接收方计算的文件 MD5，与 V2Head 中的值比对 |

### 4.3 分块策略

| 参数 | 值 | 说明 |
|------|-----|------|
| ChunkSize | 16 KB | 每块数据大小（解决 SCTP 单消息 16KB 限制） |
| 分块数 | ceil(fileSize / 16KB) | 根据文件大小计算 |
| CRC32 算法 | CRC32-C (Castagnoli) | 硬件加速，SSE4.2 可达 3-5 GB/s |
| 并行方式 | 每个 RTCPeerConnection 独立传输一个文件 | 多文件并行用多连接 |

### 4.4 传输语义

- **ordered: false** — 允许乱序交付，单块丢失不阻塞后续块
- **maxRetransmits: 0** — 禁用 SCTP 重传，丢包由应用层处理
- **CRC32 校验失败** — 丢弃该块，传输失败（简化版）
- **MD5 最终校验** — 接收完毕后计算 MD5，与 V2Head 中的值比对

---

## 5. 信令设计

### 5.1 WebSocket 消息类型

| 消息方向 | type | 说明 |
|---------|------|------|
| 客户端 → 服务器 | `register` | 设备注册（连接建立后第一条消息） |
| 服务器 → 客户端 | `registered` | 服务器确认设备 ID 和名称 |
| 服务器 → 所有客户端 | `device_joined` | 新设备加入广播 |
| 服务器 → 所有客户端 | `device_left` | 设备下线广播 |
| 服务器 → 客户端 | `device_list` | 推送当前在线设备列表 |
| 客户端 → 服务器 → 另一客户端 | `offer` | SDP Offer（发起传输请求） |
| 客户端 → 服务器 → 另一客户端 | `answer` | SDP Answer（响应传输请求） |
| 客户端 → 服务器 → 另一客户端 | `ice` | ICE Candidate（网络候选）|
| 客户端 → 服务器 → 另一客户端 | `file_offer` | 文件传输请求（触发弹窗） |
| 客户端 → 服务器 → 另一客户端 | `file_accept` | 接收方同意 |
| 客户端 → 服务器 → 另一客户端 | `file_reject` | 接收方拒绝 |
| 客户端 → 服务器 → 另一客户端 | `file_cancel` | 发送方取消 |

### 5.2 Message 结构体

```go
type Message struct {
    Type    MessageType     `json:"type"`
    From    string          `json:"from,omitempty"`
    To      string          `json:"to,omitempty"`
    ConnID  string          `json:"connId,omitempty"`
    LANIP   string          `json:"lan_ip,omitempty"` // 服务端注入：发送者 LAN IP（mDNS 增强）
    Payload json.RawMessage `json:"payload,omitempty"`
}
```

### 5.3 connId 设计

每对传输任务通过唯一 connId 标识：

```
格式：{发送方deviceId}-{接收方deviceId}-{时间戳}
示例：abc-def-1742541234567
```

同一对设备可以同时进行多个传输任务（各自独立 connId）。

### 5.4 设备注册流程

```
Browser A 打开页面
    │
    │ ──── WebSocket 连接 ────> Go Server
    │      r.RemoteAddr = "192.168.1.101:54321"
    │      extractLANIP() → "192.168.1.101"
    │
    │ ──── register ─────────> Go Server
    │      { type: "register",
    │        from: "device-abc",
    │        payload: "Chrome on Android" }
    │
    │                          Go Server 存储：
    │                          clients["abc"] = {
    │                            LanIP: "192.168.1.101",
    │                            WS: <conn>
    │                          }
    │
    │ <─── device_joined ───── Go Server（广播给其他设备）
    │
    │ <─── device_list ─────── Go Server（推送当前在线设备列表）
```

### 5.5 文件传输协商流程

```
A 选择文件，发给 B：

1. A ──file_offer──> Server ──> B
   { type: "file_offer",
     from: "A", to: "B",
     connId: "A-B-timestamp",
     payload: { v2head: {...} } }

2. B 弹出确认对话框，用户选择"接收"

3. B <──file_accept── Server <── B
   { type: "file_accept",
     from: "B", to: "A",
     connId: "A-B-timestamp" }

4. A 和 B 开始 WebRTC 握手（SDP/ICE 经服务器转发）

5. WebRTC 连接建立 → DataChannel 打开 → 开始传输文件
```

---

## 6. WebRTC 实现

### 6.1 多连接架构

```
每个文件传输 = 1 个独立 RTCPeerConnection

Browser A 同时给 B 发文件 1，给 C 发文件 2：

  A ── RTCPeerConnection 1 ──> B  （文件 1，connId: A-B-xxx）
  A ── RTCPeerConnection 2 ──> C  （文件 2，connId: A-C-xxx）

Browser B 同时给 A 发文件 3：

  B ── RTCPeerConnection 3 ──> A  （文件 3，connId: B-A-yyy）
```

**为什么不用单连接多 DataChannel**：SCTP 层队头阻塞，多 DataChannel 共享同一个 CWND，无法真正并行。

### 6.2 ICE 候选收集与发送

```javascript
const pc = new RTCPeerConnection({
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.xtify.com:3478' },
    ],
    iceCandidatePoolSize: 4
});

// 重要：createDataChannel 必须在 createOffer 之前
const dc = pc.createDataChannel('ft', { ordered: false });

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

// ICE 候选自动收集，通过 onicecandidate 发送
pc.onicecandidate = e => {
    if (!e.candidate) return;
    send({
        type: MSG.ICE,
        from: state.deviceId,
        to: target,
        connId,
        payload: {
            candidate: e.candidate.candidate,
            sdpMid: e.candidate.sdpMid,
            sdpMLineIndex: e.candidate.sdpMLineIndex
        }
    });
};
```

### 6.3 DataChannel 配置

```javascript
const dc = pc.createDataChannel('ft', {
    ordered: false,           // 不按序交付，丢包不阻塞
    maxRetransmits: 0         // 不重传，应用层 CRC 补偿
});
```

### 6.4 ICE 连接状态管理

```javascript
pc.oniceconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
        xferFailed(connId);
    }
};
```

### 6.5 connId 路由

WebRTC offer/answer 的 connId 方向不同，需要双向查找：

```javascript
// connId = {发送方}-{接收方}-{时间戳}
// offer 端存储的 key = {发送方}-{接收方}-{时间戳}
// answer 端收到的 connId = {接收方}-{发送方}-{时间戳}（反向）

function reverseConnId(c) {
    const p = c.split('-');
    return p.length >= 3 ? `${p[1]}-${p[0]}-${p[2]}` : c;
}

// 查找时同时尝试两个方向
let pc = state.peerConnections.get(altConnId) || state.peerConnections.get(offerConnId);
state.peerConnections.set(altConnId, pc);
state.peerConnections.set(offerConnId, pc);
```

---

## 7. 服务端实现

### 7.1 设备注册表（device.go）

```go
type Device struct {
    ID             string
    Name           string
    WS             WebSocketConn
    ConnectedPeers map[string]bool
}

var devices = make(map[string]*Device)

func RegisterDevice(ws WebSocketConn, id, name string) {
    devices[id] = &Device{ID: id, Name: name, WS: ws, ConnectedPeers: make(map[string]bool)}
    BroadcastDeviceJoined(id, name)
}
```

### 7.2 WebSocket 处理（websocket.go）

**Client 结构体**：

```go
type Client struct {
    ID     string  // 设备唯一 ID
    Name   string  // 设备名称（从 UserAgent 推断）
    LanIP  string  // WebSocket TCP 连接对端的 LAN IP
    WS     WebSocketConn
}
```

**dispatch() 转发逻辑**：

```go
func (h *DeviceHub) dispatch(client *Client, msg *Message) {
    switch msg.Type {
    case TypeOffer, TypeAnswer, TypeIce, TypeFileOffer, TypeFileAccept, TypeFileReject, TypeFileCancel:
        if msg.To != "" {
            // ICE 消息：注入发送者的 LAN IP（mDNS LAN 增强）
            if msg.Type == TypeIce {
                msg.LANIP = client.LanIP
            }
            h.SendTo(msg.To, msg)
        }
    }
}
```

**extractLANIP()**：

```go
func extractLANIP(remoteAddr string) string {
    host, _, err := net.SplitHostPort(remoteAddr)
    if err != nil {
        return remoteAddr
    }
    return host
}
```

### 7.3 平台名称推断（signaling.go）

根据 UserAgent 推断设备平台：

```go
func shortPlatform(ua string) string {
    switch {
    case strings.Contains(ua, "iPhone"): return "iPhone"
    case strings.Contains(ua, "iPad"):   return "iPad"
    case strings.Contains(ua, "Android"): return "Android"
    case strings.Contains(ua, "Windows"): return "Windows PC"
    case strings.Contains(ua, "Mac"):     return "Mac"
    case strings.Contains(ua, "Linux"):  return "Linux PC"
    case strings.Contains(ua, "Chrome"): return "Chrome Browser"
    case strings.Contains(ua, "Safari"): return "Safari Browser"
    case strings.Contains(ua, "Firefox"): return "Firefox Browser"
    case strings.Contains(ua, "Edge"), strings.Contains(ua, "Edg/"): return "Edge Browser"
    default: return ua[:strings.Index(ua, " ")]
    }
}
```

### 7.4 HTTP 服务器（main.go）

```go
mux := http.NewServeMux()
mux.Handle("/", web.NewHandler())      // 静态文件服务
mux.Handle("/ws", server.WSHandler()) // WebSocket 处理

go func() {
    http.ListenAndServe(":45680", mux)
}()
```

---

## 8. 前端实现

### 8.1 状态管理

```javascript
const state = {
    ws: null, deviceId: null, deviceName: null, connected: false,
    devices: new Map(), selectedDeviceId: null, selectedFiles: [],
    pendingOffers: new Map(), pendingCandidates: new Map(),
    activeTransfers: new Map(), transferHistory: [],
    peerConnections: new Map(), dataChannels: new Map(),
    incomingChannels: new Map(), outgoingFiles: new Map(), receiveBuffers: new Map(),
    dcReady: new Map(), v2HeadSent: new Map(), transferAccepted: new Map()
};
```

### 8.2 文件发送流程

```
用户选择文件 → startTransfer()
    │
    ├─ createPC(connId)           创建 RTCPeerConnection
    ├─ createDataChannel()        创建 DataChannel（重要：在 createOffer 之前）
    ├─ computeFileHash(file)      计算文件 MD5
    ├─ createOffer()              创建 SDP Offer
    ├─ setLocalDescription()      设置本地描述
    ├─ send(FILE_OFFER)          发送文件元数据
    └─ send(OFFER)                发送 SDP Offer
         │
         ▼
    handleFileAccept()             收到接收方同意
         │
         ├─ DC open → sendV2Head() → sendBlock() × N → sendEnd()
         │
         ▼
    文件数据通过 DataChannel P2P 传输
```

### 8.3 文件接收流程

```
handleFileOffer()         收到文件请求
    │
    └─ showPendingDlg() 弹出确认对话框（60s 超时）

用户点击"接收" → acceptOffer()
    │
    ├─ send(FILE_ACCEPT)        发送同意
    └─ addTransferUI()           显示传输进度

handleOffer()             作为接收方收到 SDP Offer
    │
    ├─ createPC(connId)
    ├─ setRemoteDescription()   设置远端描述
    ├─ createAnswer()
    ├─ setLocalDescription()
    └─ send(ANSWER)

handleIce()               收到 ICE Candidate
    │
    ├─ 检测 lan_ip 是否存在
    ├─ 若 candidate 含 .local → replaceMDNSWithLANIP()
    └─ addIceCandidate()

setupDC()                 DataChannel 打开
    │
    └─ DC open 回调触发文件接收流程

handleBinary()            收到二进制数据
    │
    ├─ u[0] === 0x00 → recvV2Head()   解析文件头
    ├─ u[0] === 0x01 → recvBlock()     接收数据块
    └─ u[0] === 0x04 → recvEnd()        传输结束，MD5 校验
```

### 8.4 mDNS 地址替换

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

async function handleIce(msg) {
    const { connId, payload, lan_ip } = msg;
    let candidateStr = payload.candidate;

    if (lan_ip && candidateStr && candidateStr.includes('.local')) {
        candidateStr = replaceMDNSWithLANIP(candidateStr, lan_ip);
    }

    const iceCandidateObj = {
        candidate: candidateStr,
        sdpMid: payload.sdpMid,
        sdpMLineIndex: payload.sdpMLineIndex
    };

    await pc.addIceCandidate(new RTCIceCandidate(iceCandidateObj));
}
```

### 8.5 UI 布局

```
┌─────────────────────────────────────────────────────────────┐
│  WebDrop                   [本机名称] [● 已连接]             │
├──────────────────┬──────────────────────────────────────────┤
│                  │                                           │
│  已连接设备        │   正在传输                                │
│  ┌────────────┐  │   ┌─────────────────────────────────┐  │
│  │ 📱 iPhone   │  │   │  example.zip → iPhone           │  │
│  │   ● 在线    │──┼──>│  ████████████░░░░░░  45%  450MB │  │
│  └────────────┘  │   └─────────────────────────────────┘  │
│  ┌────────────┐  │   ┌─────────────────────────────────┐  │
│  │ 💻 Windows  │  │   │  photo.jpg  来自 iPhone           │  │
│  │   ● 在线    │  │   │  [ 接收 ]  [ 拒绝 ]               │  │
│  └────────────┘  │   └─────────────────────────────────┘  │
│                  │                                           │
│  [+ 选择文件]     │   传输历史（本会话）                      │
│  [+ 选择文件夹]   │   ┌─────────────────────────────────┐  │
│                  │   │  ✓ doc.pdf → iPhone     完成     │  │
│                  │   │  ✓ 1.png ← MacBook     完成     │  │
│                  │   └─────────────────────────────────┘  │
└──────────────────┴──────────────────────────────────────────┘
```

---

## 9. mDNS LAN 直连增强

详见 [mdns-lan-enhancement.md](./mdns-lan-enhancement.md)。

**核心机制**：服务端从 TCP 连接中获取发送者的 LAN IP，转发 ICE 时注入 `lan_ip` 字段，前端将 `.local` 地址替换为 LAN IP 后再加入 ICE。

---

## 10. 已知问题与修复记录

详见 [疑难问题.md](./疑难问题.md)。

### 10.1 关键修复清单

| 问题 | 根因 | 修复 |
|------|------|------|
| ICE Candidate 不生成 | `createDataChannel` 在 `createOffer` 之后调用 | 调整顺序：`createDataChannel` 先于 `createOffer` |
| DC open 竞态导致传输不开始 | `handleFileAccept` 用轮询等待 DC open | `dc.onopen` 回调直接调用 `sendV2Head` |
| fileSize 解析为 62PB | send/recv 两端字节序偏移搞反 | 修正 `recvV2Head` 中 fsLo/fsHi 的偏移 |
| `ch.send()` 抛出 OperationError | SCTP 单消息 16KB 限制，4MB 分块过大 | `CHUNK_SIZE` 4MB → 16KB |
| `>>>` 优先级 bug | `>>> 0` 优先级高于 `/` | 加括号 `(Math.floor(...)) >>> 0` |
| 文件在对方同意前就开始发 | DC open 后直接发，未检查 `file_accept` | 引入 `transferAccepted` 标记双重检查 |

---

## 11. 部署与使用

### 11.1 构建

```bash
cd webdrop
go build -o webdrop .
```

### 11.2 启动

```bash
./webdrop
```

输出示例：

```
╔══════════════════════════════════════════════════════════════╗
║                      WebDrop Server                           ║
╠══════════════════════════════════════════════════════════════╣
║  URL:   http://192.168.1.100:45680                           ║
║  Local: http://127.0.0.1:45680                               ║
╠══════════════════════════════════════════════════════════════╣
║  QR Code:                                                    ║
║  ██ ██  ██ ██  ██ ██  ██ ██  ██ ██                        ║
╚══════════════════════════════════════════════════════════════╝
```

### 11.3 使用流程

```
1. 在桌面/服务器运行 ./webdrop
2. 手机/平板浏览器扫 QR 码或手动输入地址
3. 所有设备出现在彼此的设备列表中
4. 选择文件 → 点击目标设备 → 等待对方接收
5. 文件直接 P2P 传输，直连，速度最大化
```

### 11.4 Makefile

```makefile
.PHONY: build run clean

build:
	go build -o webdrop .

run:
	./webdrop

clean:
	rm -f webdrop
```

---

## 附录：性能预估

| 网络条件 | 理论速度 | 预估实际速度 |
|---------|---------|------------|
| 千兆 LAN | 125 MB/s | ~110-120 MB/s |
| Wi-Fi 5 (866 Mbps) | ~108 MB/s | ~80-90 MB/s |
| Wi-Fi 6 (1.2 Gbps) | ~150 MB/s | ~100-120 MB/s |

---

**文档结束**
