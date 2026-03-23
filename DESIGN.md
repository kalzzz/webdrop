# WebDrop 架构设计文档

**版本**：v1.0
**日期**：2026-03-21
**状态**：最终版

---

## 1. 项目概述

### 1.1 项目目标

构建一个跨平台局域网文件传输工具，通过浏览器即可使用，无需安装任何客户端或插件。设备间以 P2P 方式直传文件，服务器仅负责信令转发（设备发现、连接协商），完全不参与文件数据传输。

### 1.2 支持平台

| 平台 | 浏览器要求 | 备注 |
|------|----------|------|
| Windows | Chrome / Edge / Firefox | 桌面入口 |
| Linux | Chrome / Firefox | 桌面入口 |
| macOS | Safari / Chrome / Firefox | 桌面入口 |
| Android | Chrome / Edge | 手机端 |
| iOS | Safari / Chrome | 手机端（需 iOS 15.4+） |

### 1.3 核心约束

- **纯 P2P**：文件数据完全不经过服务器
- **零存储**：服务器内存仅存设备会话状态，无磁盘写入
- **零持久化**：传输历史仅存活在页面 Session
- **无认证**：同一局域网内无需密码即可访问
- **速率优先**：以局域网千兆带宽（~125 MB/s）为设计目标

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
│  │  设备注册表（内存）: Device { id, name, ws, connectedPeers }│ │
│  │  传输会话表（内存）: Session { connId, from, to, status }   │ │
│  │                                                            │ │
│  │  职责：                                                    │ │
│  │  1. 设备注册 / 下线广播                                    │ │
│  │  2. SDP Offer/Answer 转发                                  │ │
│  │  3. ICE Candidate 转发                                      │ │
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
│                        │         │                            │
│  ※ 每 RTCPeerConnection ↔ 独立 CWND，无队头阻塞                │
└────────────────────────┘         └────────────────────────────┘
```

### 2.2 数据路径说明

```
信令路径（经过服务器）：
[Browser A] ──WebSocket──> [Go Server] ──WebSocket──> [Browser B]
  SDP/ICE/file_offer 等信令消息

文件路径（完全不经过服务器）：
[Browser A] ◄─────── WebRTC DataChannel ────────► [Browser B]
                    直连 P2P
```

---

## 3. 协议设计

### 3.1 协议分层

```
┌──────────────────────────────────────────────────────────────┐
│                     应用层：文件传输协议                        │
│  定义：文件语义、分块结构、校验方式、传输语义                    │
├──────────────────────────────────────────────────────────────┤
│                    传输层：WebRTC DataChannel                  │
│  可靠传输，ordered:false + 无重传                             │
├──────────────────────────────────────────────────────────────┤
│                    网络层：UDP + SCTP                         │
│  WebRTC 底层                                                     │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 文件传输协议（简化 Binary V2）

沿用 LANDrop Binary V2 核心结构，去除 ACK/NACK 滑动窗口机制：

| 消息类型 | Type ID | 说明 |
|---------|---------|------|
| V2Head | 0x10 | 文件头（文件名、大小、块数、MD5） |
| Block | 0x01 | 数据块（索引、CRC32、4MB 数据） |
| End | 0x04 | 传输结束（MD5 最终校验） |

#### V2Head Payload

```
偏移    大小    字段           说明
0       4       nameLen        文件名长度（字节）
4       N       filename       文件名（UTF-8）
N+4     8       fsize          文件大小（字节）
N+12    4       blocks         总块数 = ceil(fsize / 4MB)
N+16    16      MD5            文件 MD5 校验值
```

#### Block Payload

```
偏移    大小    字段           说明
0       1       type           = 0x01
1       4       blockIdx       块索引（0 起）
5       4       size           数据大小（字节）
9       4       crc32          CRC32-C 校验值
13      M       data           原始数据（通常 4MB，最后一块可能更小）
```

#### End Payload

```
偏移    大小    字段           说明
0       16      MD5            接收方计算的文件 MD5，与 V2Head 比对
```

### 3.3 分块策略

| 参数 | 值 | 说明 |
|------|-----|------|
| ChunkSize | 4 MB | 每块数据大小（比 LANDrop 原 1MB 更大，减少 header 占比） |
| 分块数 | ceil(fsize / 4MB) | 根据文件大小计算 |
| CRC32 算法 | CRC32-C (Castagnoli) | 硬件加速，SSE4.2 可达 3-5 GB/s |
| 并行方式 | 每个 RTCPeerConnection 独立传输一个文件 | 多文件并行用多连接 |

### 3.4 传输语义

- **ordered: false** — 允许乱序交付，单块丢失不阻塞后续块
- **maxRetransmits: 0** — 禁用 SCTP 重传，丢包由应用层处理
- **CRC32 校验失败** — 丢弃该块，等待发送方重传（简化版：丢弃整个文件重新传）
- **MD5 最终校验** — 接收完毕后计算 MD5，与 V2Head 中的值比对

### 3.5 与 LANDrop Binary V2 的区别

| 特性 | LANDrop Binary V2 | WebDrop |
|------|-------------------|--------|
| 分块大小 | 1 MB | 4 MB |
| 确认机制 | ACK/NACK + 滑动窗口 | 无（依赖 WebRTC 可靠性） |
| 并行模型 | 8 workers 单连接 | 多 RTCPeerConnection |
| 适用场景 | 原生 App（TCP 直连） | 浏览器（WebRTC SCTP） |

---

## 4. 信令设计

### 4.1 WebSocket 消息类型

| 消息方向 | type | 说明 |
|---------|------|------|
| 客户端 → 服务器 | register | 设备注册（连接建立后第一条消息） |
| 服务器 → 所有客户端 | device_joined | 新设备加入广播 |
| 服务器 → 所有客户端 | device_left | 设备下线广播 |
| 服务器 → 客户端 | device_list | 推送当前在线设备列表 |
| 客户端 → 服务器 → 另一客户端 | offer | SDP Offer（发起传输请求） |
| 客户端 → 服务器 → 另一客户端 | answer | SDP Answer（响应传输请求） |
| 客户端 → 服务器 → 另一客户端 | ice | ICE Candidate（网络候选） |
| 客户端 → 服务器 → 另一客户端 | file_offer | 文件传输请求（触发弹窗） |
| 客户端 → 服务器 → 另一客户端 | file_accept | 接收方同意 |
| 客户端 → 服务器 → 另一客户端 | file_reject | 接收方拒绝 |
| 客户端 → 服务器 → 另一客户端 | file_cancel | 发送方取消 |

### 4.2 connId 设计

每对传输任务通过唯一 connId 标识：

```
格式：{发送方deviceId}-{接收方deviceId}-{时间戳}
示例：abc-def-1742541234567
```

同一对设备可以同时进行多个传输任务（各自独立 connId）。

### 4.3 设备注册流程

```
Browser A 打开页面
    │
    │ ──── WebSocket 连接 ────> Go Server
    │
    │ ──── register ─────────> Go Server
    │      { type: "register",
    │        from: "device-abc",
    │        payload: "Chrome on Android" }
    │
    │                          Go Server 存储设备信息
    │
    │ <─── device_joined ───── Go Server（广播给其他设备）
    │
    │ <─── device_list ─────── Go Server（推送当前在线设备列表）
```

### 4.4 文件传输协商流程

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

## 5. WebRTC 连接设计

### 5.1 多连接架构

```
每个文件传输 = 1 个独立 RTCPeerConnection

Browser A 同时给 B 发文件 1，给 C 发文件 2：

  A ── RTCPeerConnection 1 ──> B  （文件 1，connId: A-B-xxx）
  A ── RTCPeerConnection 2 ──> C  （文件 2，connId: A-C-xxx）

Browser B 同时给 A 发文件 3：

  B ── RTCPeerConnection 3 ──> A  （文件 3，connId: B-A-yyy）
```

**为什么不用单连接多 DataChannel**：SCTP 层队头阻塞，多 DataChannel 共享同一个 CWND，无法真正并行。

### 5.2 RTCPeerConnection 配置

```javascript
const config = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
        // LAN 场景下 STUN 通常不需要，但保留以防万一
    ]
};
```

### 5.3 DataChannel 配置

```javascript
const channelConfig = {
    ordered: false,           // 不按序交付，丢包不阻塞
    maxRetransmits: 0,        // 不重传，应用层 CRC 补偿
    maxPacketLifeTime: 500    // 500µs 超时即丢弃
};
```

### 5.4 ICE / NAT 处理

LAN 场景下（同一路由器/交换机下）：
- 大多数情况无需 NAT 穿透，设备可直接通信
- ICE 会尝试 host candidate（局域网 IP），直接直连
- 若企业网络限制，可能需要 TURN 中继（本方案暂不实现）

---

## 6. 设备发现与接入

### 6.1 发现机制

**无需额外发现协议**，所有设备打开同一 WebUI，自然汇聚：
1. 用户在桌面/服务器运行 `./webdrop`
2. 程序输出 `http://IP:45680` + QR 码
3. 手机/平板浏览器扫 QR 码或手动输入地址
4. 所有设备通过 WebSocket 连接服务器，自动看到彼此

### 6.2 设备命名

自动获取方式：
- 桌面端：浏览器 `navigator.userAgent`（如 "Chrome on Windows"）
- 移动端：浏览器 `navigator.userAgent`（如 "Safari on iOS"）

不提供用户自定义名称，简化设计。

### 6.3 QR 码生成

服务器端使用 Go 库生成 QR 码图片，嵌入启动输出和页面中。

---

## 7. 用户界面设计

### 7.1 页面布局（桌面浏览器）

```
┌─────────────────────────────────────────────────────────────┐
│  WebDrop                   [本机名称] [连接状态: ●]          │
├──────────────────┬──────────────────────────────────────────┤
│                  │                                           │
│  已连接设备        │   传输面板                                │
│  ┌────────────┐  │   ┌─────────────────────────────────┐  │
│  │ 📱 iPhone   │  │   │  正在传输                        │  │
│  │   ● 在线    │──┼──>│  example.zip → iPhone           │  │
│  └────────────┘  │   │  ████████████░░░░░  45%  450MB   │  │
│  ┌────────────┐  │   └─────────────────────────────────┘  │
│  │ 💻 MacBook  │  │   ┌─────────────────────────────────┐  │
│  │   ● 在线    │  │   │  待接收                          │  │
│  └────────────┘  │   │  photo.jpg  来自 iPhone           │  │
│                  │   │  [ 接收 ]  [ 拒绝 ]               │  │
│  ──────────────  │   └─────────────────────────────────┘  │
│                  │                                           │
│  [+ 选择文件]     │   传输历史（本会话）                      │
│  [+ 选择文件夹]   │   ┌─────────────────────────────────┐  │
│                  │   │  ✓ doc.pdf  →  iPhone   完成    │  │
│                  │   │  ✓ 1.png    ←  MacBook  完成    │  │
│                  │   └─────────────────────────────────┘  │
└──────────────────┴──────────────────────────────────────────┘
```

### 7.2 文件选择

- **多文件**：`input type="file" multiple`
- **文件夹**：`input type="file" webkitdirectory multiple`
- 选择后，选中设备后点击传输按钮发起请求

### 7.3 待接收弹窗

接收方设备收到 file_offer 后，页面弹出对话框：
- 文件名、文件大小、发送方设备名
- 两个按钮：接收 / 拒绝
- 超时（60s）未操作自动拒绝

### 7.4 传输进度

- 实时进度条（百分比 + 已传大小 / 总大小）
- 传输速度（MB/s）
- 传输完成后显示完成状态，3 秒后自动从活跃列表移除

---

## 8. 目录结构

```
webdrop/
│
├── main.go                 # 程序入口
├── go.mod                  # Go 模块定义
├── Makefile                # 构建脚本
│
├── protocol/               # 文件传输协议
│   ├── types.go           # V2Head / Block / End 编解码
│   ├── crc32.go           # CRC32-C 实现
│   └── md5.go             # MD5 封装
│
├── server/                 # Go 服务器
│   ├── http.go            # HTTP 服务器（静态文件）
│   ├── websocket.go       # WebSocket 服务器
│   ├── device.go          # 设备注册表
│   ├── signaling.go       # SDP/ICE 信令转发
│   └── msg.go             # WebSocket 消息结构
│
└── web/                    # 前端资源
    ├── embed.go           # 嵌入 static/ 目录
    └── static/
        ├── index.html     # 单页应用
        ├── style.css      # 样式表
        └── app.js         # 核心前端逻辑
```

---

## 9. 部署与使用

### 9.1 启动命令

```bash
./webdrop
```

启动后输出：
```
┌──────────────────────────────────┐
│  WebDrop 已启动                   │
│                                  │
│  📱 手机访问：                    │
│  http://192.168.1.100:45680      │
│                                  │
│  [ QR 码 ]                       │
│                                  │
│  🖥️ 桌面浏览器直接打开同上地址     │
└──────────────────────────────────┘
```

### 9.2 使用流程

```
1. 在 Windows/Linux 上运行 webdrop
2. 手机/平板浏览器打开显示的地址
3. 所有设备出现在彼此的设备列表中
4. 选择文件 → 点击目标设备 → 等待对方接收
5. 文件直接 P2P 传输，直连，速度最大化
```

---

## 10. 关键设计决策记录（ADR）

### ADR-001：传输架构

**决策**：每个文件传输任务使用独立 RTCPeerConnection。
**理由**：避免 SCTP 层队头阻塞，保证多文件并行时各自独立带宽。

### ADR-002：服务器职责

**决策**：服务器仅做 WebSocket 信令转发，文件数据完全不经过服务器。
**理由**：服务器零带宽消耗，传输速度仅取决于两端设备和网络。

### ADR-003：协议简化

**决策**：去除 ACK/NACK 滑动窗口机制，依赖 WebRTC DataChannel 可靠性。
**理由**：WebRTC SCTP 本身提供可靠性保证，简化协议减少复杂度；CRC32 校验仍保留用于检测损坏。

### ADR-004：分块大小

**决策**：ChunkSize = 4MB（LANDrop 原为 1MB）。
**理由**：减少 header 占比，提高 LAN 高带宽场景下的传输效率。

### ADR-005：设备发现

**决策**：无额外发现协议，所有设备通过 WebSocket 连接服务器后自动出现在同一设备列表。
**理由**：所有设备都需要访问服务器页面，自然汇聚，无需额外协议。

---

## 11. 已知限制

| 限制 | 说明 | 影响 |
|------|------|------|
| 企业防火墙阻断 WebRTC | 部分企业网络限制 UDP 或 STUN | 可能无法建立 P2P 连接 |
| iOS Safari WebRTC 支持 | 较旧 iOS 版本可能有问题 | 需 iOS 15.4+ |
| 单文件大小限制 | 浏览器内存限制 | 理论上无限制，实际受设备内存影响 |
| 断线重连 | 不支持断点续传 | 传输中断需重新开始 |

---

## 12. 性能预估

| 网络条件 | 理论速度 | 预估实际速度 | 备注 |
|---------|---------|------------|------|
| 千兆 LAN | 125 MB/s | ~110-120 MB/s | WebRTC 开销约 5-10% |
| Wi-Fi 5 (866 Mbps) | ~108 MB/s | ~80-90 MB/s | 无线开销+干扰 |
| Wi-Fi 6 (1.2 Gbps) | ~150 MB/s | ~100-120 MB/s | 干扰少时接近千兆 |

---

**文档结束**
