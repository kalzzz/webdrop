/**
 * WebDrop - P2P File Transfer Frontend
 * 
 * 改造版本：单 RTCPeerConnection + 多 DataChannel
 * - 每个目标设备只建立 1 个 RTCPeerConnection
 * - 每个文件创建独立的 DataChannel（通过 label 区分）
 * - 去掉 Block CRC32 校验（依赖 SCTP + MD5 最终校验）
 */

// ============================================
// Constants
// ============================================
const WS_URL = `ws://${window.location.host}/ws`;
const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.xtify.com:3478' },
];
const CHUNK_SIZE = 16 * 1024;  // 16KB - SCTP/DataChannel 单消息安全大小
const PENDING_TIMEOUT = 60;

const MSG = {
    REGISTER: 'register', REGISTERED: 'registered', DEVICE_JOINED: 'device_joined', DEVICE_LEFT: 'device_left',
    DEVICE_LIST: 'device_list', OFFER: 'offer', ANSWER: 'answer', ICE: 'ice',
    FILE_OFFER: 'file_offer', FILE_ACCEPT: 'file_accept', FILE_REJECT: 'file_reject', FILE_CANCEL: 'file_cancel'
};
const PROTO = { V2HEAD: 0x10, BLOCK: 0x01, FILE_RECEIVED: 0x05 };

// ============================================
// State
// ============================================
const state = {
    ws: null, deviceId: null, deviceName: null, connected: false,
    devices: new Map(), selectedDeviceId: null, selectedFiles: [],
    pendingOffers: new Map(), pendingCandidates: new Map(),
    activeTransfers: new Map(), transferHistory: [],
    peerConnections: new Map(),   // key: connId, value: RTCPeerConnection
    dataChannels: new Map(),      // key: fileConnId, value: DataChannel
    incomingChannels: new Map(), // key: fileConnId, value: receive state
    outgoingFiles: new Map(),     // key: fileConnId, value: send state
    receiveBuffers: new Map(),    // key: fileConnId, value: blocks map
    dcReady: new Map(),           // key: fileConnId, value: boolean
    v2HeadSent: new Map(),        // key: fileConnId, value: boolean
    transferAccepted: new Map(),   // key: fileConnId, value: boolean
    labelToConnId: new Map(),     // key: dcLabel, value: fileConnId (新增)
    // 待接收文件队列（接收端）：按 connId 分组，合并弹窗
    pendingFileOffers: new Map(),  // key: connId, value: info[] 数组
    pendingFileTimer: null          // 当前弹窗的计时器
};

// ============================================
// Utilities
// ============================================

// 每个目标设备一个 connId（复用连接）
// 查找时兼容双向：A→B 时存的是 A-B-ts，B→A 时存的是 B-A-ts
function getConnIdForTarget(targetId) {
    // 先按 selfId-targetId 找
    let existing = Array.from(state.peerConnections.keys())
        .find(k => k.startsWith(`${state.deviceId}-${targetId}-`));
    if (existing) return existing;
    // 再按 targetId-selfId 找（对方先发起的情况）
    existing = Array.from(state.peerConnections.keys())
        .find(k => k.startsWith(`${targetId}-${state.deviceId}-`));
    return existing || `${state.deviceId}-${targetId}-${Date.now()}`;
}

// 从 fileConnId 解析：connId + fileName
// fileConnId 格式：{connId}:{fileName}
function parseFileConnId(fileConnId) {
    const lastColon = fileConnId.lastIndexOf(':');
    return {
        connId: fileConnId.substring(0, lastColon),
        fileName: fileConnId.substring(lastColon + 1)
    };
}

// 获取 connId 对应的 targetId
function getTargetIdFromConnId(connId) {
    const p = connId.split('-');
    return p[0] === state.deviceId ? p[1] : p[0];
}

function generateConnId(from, to) { return `${from}-${to}-${Date.now()}`; }

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatSpeed(bps) { return formatBytes(bps) + '/s'; }

function formatTime(date) { return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }

function getDeviceIcon(ua) {
    const u = ua || '';
    if (/iPhone|iPad|iPod/i.test(u)) return '📱';
    if (/Android/i.test(u)) return '📱';
    if (/Windows/i.test(u)) return '💻';
    if (/Mac/i.test(u)) return '🖥️';
    if (/Linux/i.test(u)) return '🖥️';
    return '💻';
}

function getFileIcon(name) {
    const ext = (name || '').split('.').pop()?.toLowerCase() || '';
    const icons = {
        jpg:'🖼️',jpeg:'🖼️',png:'🖼️',gif:'🖼️',webp:'🖼️',svg:'🖼️',pdf:'📄',doc:'📝',docx:'📝',
        xls:'📊',xlsx:'📊',zip:'📦',rar:'📦',tar:'📦',gz:'📦',mp3:'🎵',mp4:'🎬',mkv:'🎬',
        js:'💻',ts:'💻',py:'💻',html:'🌐',css:'🎨',txt:'📃',md:'📃'
    };
    return icons[ext] || '📄';
}

// ============================================
// MD5 Implementation
// ============================================
function md5(buf) {
    const h = [
        0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476
    ];
    const s = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;

    const len = buf.byteLength || buf.length;
    const words = new Uint32Array(Math.ceil((len + 8) / 4));
    for (let i = 0; i < len; i++) words[i >> 2] |= (buf[i] & 0xff) << ((i & 3) << 3);
    words[len >> 2] |= 0x80 << ((len & 3) << 3);
    words[words.length - 1] = len << 3;

    const w = new Uint32Array(16);
    for (let j = 0; j < words.length; j += 16) {
        let [a, b, c, d] = h;
        for (let i = 0; i < 64; i++) {
            let f, g;
            if (i < 16) { f = (b & c) | ((~b) & d); g = i; }
            else if (i < 32) { f = (d & b) | ((~d) & c); g = (5 * i + 1) % 16; }
            else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
            else { f = c ^ (b | (~d)); g = (7 * i) % 16; }
            f = (f + a + K[i] + words[j + g]) >>> 0;
            [a, d, c, b] = [d, c, b, 0];
            a = (b + ((f << s[i]) | (f >>> (32 - s[i])))) >>> 0;
            b = (c + a) >>> 0;
            c = d >>> 0;
            d = a >>> 0;
        }
        h[0] = (h[0] + a) >>> 0;
        h[1] = (h[1] + b) >>> 0;
        h[2] = (h[2] + c) >>> 0;
        h[3] = (h[3] + d) >>> 0;
    }
    const out = new Uint8Array(16);
    for (let i = 0; i < 4; i++) {
        out[i] = (h[0] >>> (i * 8)) & 0xff;
        out[4 + i] = (h[1] >>> (i * 8)) & 0xff;
        out[8 + i] = (h[2] >>> (i * 8)) & 0xff;
        out[12 + i] = (h[3] >>> (i * 8)) & 0xff;
    }
    return out;
}

function md5Hex(buf) {
    const b = md5(buf);
    let s = '';
    for (let i = 0; i < 16; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
}

async function computeFileHash(file) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = e => { try { res(md5Hex(e.target.result)); } catch(ex) { rej(ex); } };
        r.onerror = rej;
        r.readAsArrayBuffer(file);
    });
}

// ============================================
// CRC32-C (保留但仅用于 V2Head 校验，Block 已不使用)
// ============================================
const CRC32C = (() => {
    const t = new Uint32Array(256), p = 0x82F63B78;
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (p ^ (c >>> 1)) : (c >>> 1); t[i] = c; }
    return t;
})();

function crc32c(data) {
    let crc = 0xFFFFFFFF;
    const arr = new Uint8Array(data);
    for (let i = 0; i < arr.length; i++) crc = CRC32C[(crc ^ arr[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ============================================
// WebSocket
// ============================================
function connectWebSocket() {
    if (state.ws?.readyState === WebSocket.OPEN) return;
    updateConnectionStatus(false);
    state.deviceId = Math.random().toString(36).substr(2, 9);
    try { state.ws = new WebSocket(WS_URL); }
    catch { setTimeout(connectWebSocket, 3000); return; }
    state.ws.binaryType = 'arraybuffer';
    state.ws.onopen = () => {
        state.connected = true;
        updateConnectionStatus(true);
        console.log('[ws] open, deviceId=', state.deviceId);
        send({ type: MSG.REGISTER, from: state.deviceId, payload: navigator.userAgent });
    };
    state.ws.onclose = () => {
        console.log('[ws] close');
        state.connected = false; state.deviceId = null;
        updateConnectionStatus(false); state.devices.clear(); renderDevices();
        setTimeout(connectWebSocket, 3000);
    };
    state.ws.onerror = e => console.error('[ws] error:', e);
    state.ws.onmessage = e => {
        if (e.data instanceof ArrayBuffer) return;
        try {
            const msg = JSON.parse(e.data);
            if (!['REGISTERED','DEVICE_LIST','DEVICE_JOINED','DEVICE_LEFT','ICE'].includes(msg.type)) {
                console.log('[ws->]', msg.type, 'from=', msg.from, 'connId=', msg.connId);
            }
            handleMsg(msg);
        } catch (err) { console.error('Parse error:', err); }
    };
}

function send(msg) { 
    if (state.ws?.readyState === WebSocket.OPEN) {
        const s = JSON.stringify(msg);
        console.log('[ws<-] sending', msg.type, 'to=', msg.to, 'len=', s.length);
        state.ws.send(s);
    } else {
        console.warn('[ws] send failed, ws.readyState=', state.ws?.readyState);
    }
}

function updateConnectionStatus(connected) {
    const el = document.getElementById('connectionStatus');
    const dot = el.querySelector('.status-dot');
    const txt = el.querySelector('.status-text');
    dot.className = 'status-dot ' + (connected ? 'online' : 'offline');
    txt.textContent = connected ? '已连接' : '未连接';
}

function updateSelfName() {
    const el = document.getElementById('deviceName');
    if (el && state.deviceName) el.textContent = state.deviceName;
}

// ============================================
// Message Handler
// ============================================
function handleMsg(msg) {
    if (!msg || !msg.type) { console.warn('Received message without type:', msg); return; }
    switch (msg.type) {
        case MSG.DEVICE_LIST:
            if (msg.payload && Array.isArray(msg.payload.devices)) {
                state.devices.clear();
                msg.payload.devices.forEach(d => {
                    if (d && d.id) {
                        state.devices.set(d.id, { id: d.id, payload: d.payload, connected: true });
                    }
                });
            }
            renderDevices();
            updateSelfName();
            break;
        case MSG.REGISTERED:
            if (msg.payload && msg.payload.id) {
                state.deviceId = msg.payload.id;
            }
            if (msg.payload && msg.payload.name) {
                const rand = Math.floor(Math.random() * 9000) + 1000;
                state.deviceName = msg.payload.name + '-' + rand;
                updateSelfName();
            }
            break;
        case MSG.DEVICE_JOINED:
            if (msg.payload && msg.payload.id && msg.payload.id !== state.deviceId) {
                state.devices.set(msg.payload.id, { id: msg.payload.id, payload: msg.payload.payload, connected: true });
                renderDevices();
            }
            break;
        case MSG.DEVICE_LEFT:
            if (msg.from) {
                state.devices.delete(msg.from);
                if (state.selectedDeviceId === msg.from) state.selectedDeviceId = null;
                renderDevices();
                updateSendBtn();
            }
            break;
        case MSG.OFFER: handleOffer(msg); break;
        case MSG.ANSWER: handleAnswer(msg); break;
        case MSG.ICE: handleIce(msg); break;
        case MSG.FILE_OFFER: handleFileOffer(msg); break;
        case MSG.FILE_ACCEPT: handleFileAccept(msg); break;
        case MSG.FILE_REJECT: handleFileReject(msg); break;
        case MSG.FILE_CANCEL: handleFileCancel(msg); break;
    }
}

// ============================================
// WebRTC
// ============================================

// 反转 connId 的前两部分（用于 offer/answer 两侧匹配）
function reverseConnId(c) {
    const p = c.split('-');
    return p.length >= 3 ? `${p[1]}-${p[0]}-${p[2]}` : c;
}

// 创建 PeerConnection（单连接设计，不再在此创建 DataChannel）
function createPC(connId, targetId) {
    console.log('[createPC] connId=', connId, 'targetId=', targetId);
    
    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun.xtify.com:3478' },
        ],
        iceCandidatePoolSize: 4
    });
    
    state.peerConnections.set(connId, pc);
    
    pc.oniceconnectionstatechange = () => {
        console.log('[ICE connState]', connId, '->', pc.iceConnectionState);
        if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
            cleanupAllForConnId(connId);
        }
    };
    
    pc.onicecandidate = e => {
        if (!e.candidate) {
            console.log('[ICE complete]', connId);
            return;
        }
        send({
            type: MSG.ICE,
            from: state.deviceId,
            to: targetId,
            connId,
            payload: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex }
        });
    };
    
    // 接收端：处理对方创建的 DataChannel
    pc.ondatachannel = (e) => {
        const label = e.channel.label;
        console.log('[createPC] DataChannel received, label=', label);
        
        // label 格式：file:{name}:{size}
        const parts = label.split(':');
        if (parts[0] === 'file' && parts.length >= 3) {
            const fileName = parts[1];
            const fileConnId = `${connId}:${fileName}`;
            
            setupDC(e.channel, fileConnId, 'receiver');
            state.dataChannels.set(fileConnId, e.channel);
            state.labelToConnId.set(label, fileConnId);
        }
    };
    
    return pc;
}

// 设置 DataChannel 事件处理
function setupDC(channel, fileConnId, role) {
    console.log('[setupDC] fileConnId=', fileConnId, 'role=', role, 'label=', channel.label);
    
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 512 * 1024; // 512KB
    
    channel.onbufferedamountlow = () => {
        console.log('[bufferedAmountLow]', fileConnId, 'bufferedAmount=', channel.bufferedAmount, 'role=', role);
        if (role === 'sender') {
            sendBlock(fileConnId);
        }
    };
    
    channel.onopen = () => {
        console.log('[DC open]', fileConnId, 'role=', role);
        state.dcReady.set(fileConnId, true);
        
        if (role === 'sender') {
            // 发送端：等待 file_accept 才发送
            const f = state.outgoingFiles.get(fileConnId);
            if (f && state.transferAccepted.get(fileConnId) && !state.v2HeadSent.get(fileConnId)) {
                sendV2Head(fileConnId, f);
            }
        }
    };
    
    channel.onmessage = e => {
        if (e.data instanceof ArrayBuffer) {
            console.log('[DC msg]', fileConnId, 'role=', role, 'len=', e.data.byteLength, 'readyState=', channel.readyState);
            handleBinary(fileConnId, e.data);
        }
    };
    
    channel.onclose = () => {
        console.log('[DC close]', fileConnId);
        state.dataChannels.delete(fileConnId);
    };
    
    channel.onerror = e => {
        console.error('[DC error]', fileConnId,
            'message:', e.message,
            'error:', e.error,
            'channel.readyState:', channel.readyState,
            'bufferedAmount:', channel.bufferedAmount);
        xferFailed(fileConnId);
    };
}

// 处理 offer（接收端）
async function handleOffer(msg) {
    const { from, connId, payload } = msg;
    console.log('[handleOffer] from=', from, 'connId=', connId);
    
    // 获取或创建 PC
    let pc = state.peerConnections.get(connId);
    if (!pc) {
        pc = createPC(connId, from);
        console.log('[handleOffer] PC created');
    }
    
    // 监听 DataChannel（复用已有 PC 时不重复设置 handler）
    if (!pc.ondatachannel) {
        pc.ondatachannel = (e) => {
            console.log('[handleOffer] DataChannel received from=', from, 'label=', e.channel.label);
            const label = e.channel.label;
            const parts = label.split(':');
            if (parts[0] === 'file' && parts.length >= 3) {
                const fileName = parts[1];
                const fileConnId = `${connId}:${fileName}`;
                setupDC(e.channel, fileConnId, 'receiver');
                state.dataChannels.set(fileConnId, e.channel);
                state.labelToConnId.set(label, fileConnId);
            }
        };
    }
    
    // 收集 ICE 候选（复用已有 PC 时不重复设置 handler）
    if (!pc.onicecandidate) {
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                console.log('[handleOffer] sending ice candidate to=', from, 'connId=', connId);
                send({ type: MSG.ICE, from: state.deviceId, to: from, connId, payload: e.candidate });
            }
        };
    }
    
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    console.log('[handleOffer] remoteDesc set, creating answer');
    
    // 队列候选处理
    const queued = state.pendingCandidates.get(connId) || [];
    state.pendingCandidates.delete(connId);
    for (const c of queued) {
        console.log('[handleOffer] draining queued candidate');
        await pc.addIceCandidate(new RTCIceCandidate(c));
    }
    
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    send({ type: MSG.ANSWER, from: state.deviceId, to: from, connId, payload: { sdp: pc.localDescription } });
    console.log('[handleOffer] answer sent to=', from);
}

// 处理 answer（发送端）
async function handleAnswer(msg) {
    const offerConnId = reverseConnId(msg.connId);
    const altConnId = msg.connId;
    console.log('[handleAnswer] selfId=', state.deviceId, 'answer connId=', altConnId, 'offerConnId=', offerConnId);
    
    let pc = state.peerConnections.get(altConnId) || state.peerConnections.get(offerConnId);
    if (!pc) { console.warn('[handleAnswer] no PC for', altConnId, 'or', offerConnId); return; }
    
    state.peerConnections.set(altConnId, pc);
    state.peerConnections.set(offerConnId, pc);
    
    await pc.setRemoteDescription(new RTCSessionDescription(msg.payload.sdp));
    console.log('[handleAnswer] remote desc set, draining candidates');
    
    for (const key of [altConnId, offerConnId]) {
        const cands = state.pendingCandidates.get(key) || [];
        state.pendingCandidates.delete(key);
        for (const c of cands) {
            await pc.addIceCandidate(new RTCIceCandidate(c));
        }
    }
}

// 处理 ICE 候选
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

function replaceMDNSWithLANIP(candidateStr, lanIP) {
    const parts = candidateStr.split(' ');
    for (const part of parts) {
        if (part.includes('.local')) {
            return candidateStr.replace(part, lanIP);
        }
    }
    return candidateStr;
}

// ============================================
// Sending
// ============================================

// 核心改造：单连接多 DataChannel 并发传输（各文件独立发送，互不等待）
async function startTransfer(targetId, files) {
    console.log('[startTransfer] targetId=', targetId, 'files=', files.length);
    
    // 步骤 1：获取或创建单个 PeerConnection
    const connId = getConnIdForTarget(targetId);
    let pc = state.peerConnections.get(connId);
    const isNewConnection = !pc;
    
    if (isNewConnection) {
        pc = createPC(connId, targetId);
        state.peerConnections.set(connId, pc);
        console.log('[startTransfer] 新建 PC, connId=', connId);
    }
    
    // 步骤 2：为每个文件创建独立的 DataChannel
    const fileOffers = [];
    
    for (const file of files) {
        const fileConnId = `${connId}:${file.name}`;
        const dcLabel = `file:${file.name}:${file.size}`;
        
        // 跳过已存在的 fileConnId（防止重复添加）
        if (state.outgoingFiles.has(fileConnId)) {
            console.log('[startTransfer] 跳过已存在的 fileConnId=', fileConnId);
            continue;
        }
        
        // 发起端创建 DataChannel
        const dc = pc.createDataChannel(dcLabel, {
            ordered: true
        });
        
        state.dataChannels.set(fileConnId, dc);
        state.labelToConnId.set(dcLabel, fileConnId);
        state.dcReady.set(fileConnId, false);
        state.v2HeadSent.set(fileConnId, false);
        state.transferAccepted.set(fileConnId, false);
        
        // 预先计算 MD5
        const hash = await computeFileHash(file);
        
        state.outgoingFiles.set(fileConnId, {
            file,
            fileName: file.name,
            fileSize: file.size,
            totalBlocks: Math.ceil(file.size / CHUNK_SIZE),
            fileHash: hash,
            sent: 0,
            sentIdx: undefined,  // 防止重复发送的 idx 标记
            startTime: Date.now(),
            dcLabel,
            targetId,
            connId
        });
        
        addTransferUI(fileConnId, {
            name: file.name,
            size: file.size,
            direction: 'outgoing',
            deviceName: state.devices.get(targetId)?.payload || '未知设备'
        });
        
        setupDC(dc, fileConnId, 'sender');
        
        fileOffers.push({
            name: file.name,
            size: file.size,
            blocks: Math.ceil(file.size / CHUNK_SIZE),
            MD5: hash
        });
    }
    
    // 步骤 3：新建连接时创建并发送 SDP Offer
    if (isNewConnection) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        send({
            type: MSG.OFFER,
            from: state.deviceId,
            to: targetId,
            connId,
            payload: { sdp: pc.localDescription }
        });
        console.log('[startTransfer] SDP Offer 已发送, connId=', connId);
    }
    
    // 步骤 4：发送多文件 file_offer
    send({
        type: MSG.FILE_OFFER,
        from: state.deviceId,
        to: targetId,
        connId,
        payload: { files: fileOffers }
    });
    
    clearFiles();
}

// 发送 V2Head
function sendV2Head(fileConnId, info) {
    const { fileName, fileSize, totalBlocks, fileHash } = info;
    const ch = state.dataChannels.get(fileConnId);
    
    console.log('[sendV2Head] fileConnId=', fileConnId, 'ch.readyState=', ch?.readyState);
    if (!ch || ch.readyState !== 'open') { console.warn('[sendV2Head] channel not open'); return; }
    
    const outFiles = state.outgoingFiles.get(fileConnId);
    if (!outFiles || outFiles.sentV2Head) { console.warn('[sendV2Head] already sent or not found'); return; }
    outFiles.sentV2Head = true;
    
    const nb = new TextEncoder().encode(fileName);
    // V2Head layout: [nameLen:4][filename][fileSize_hi:4][fileSize_lo:4][totalBlocks:4][MD5:16][crc32:4]
    const crc32Pos = 4 + nb.length + 8 + 4 + 16;
    const hdr = new ArrayBuffer(crc32Pos + 4);
    const v = new DataView(hdr), u = new Uint8Array(hdr);
    let o = 0;
    v.setUint32(o, nb.length, false); o += 4;
    u.set(nb, o); o += nb.length;
    const hi = (Math.floor(fileSize / 0x100000000)) >>> 0;
    const lo = fileSize >>> 0;
    v.setUint32(o, hi, false); o += 4;
    v.setUint32(o, lo, false); o += 4;
    v.setUint32(o, totalBlocks, false); o += 4;
    const mh = (fileHash || '').padEnd(32, '0').slice(0, 32);
    for (let i = 0; i < 16; i++) u[o + i] = parseInt(mh.substr(i * 2, 2), 16);
    const crc = crc32c(hdr.slice(0, crc32Pos));
    v.setUint32(crc32Pos, crc, false);
    console.log('[sendV2Head] sending hdr bytes=', hdr.byteLength);
    try {
        ch.send(hdr);
        console.log('[sendV2Head] send ok, channel.readyState=', ch.readyState, 'bufferedAmount=', ch.bufferedAmount);
    } catch (err) {
        console.error('[sendV2Head] send failed:', err);
    }
    setTimeout(() => sendBlock(fileConnId), 0);
}

// 发送 Block
function sendBlock(fileConnId) {
    const MAX_INFLIGHT = 10;  // 滑动窗口：10 blocks ≈ 160KB
    const BUFFER_HIGH = 256 * 1024;  // SCTP 发送 buffer 上限，超过则等待 onbufferedamountlow
    
    console.log('[sendBlock] ENTRY fileConnId=', fileConnId);
    const f = state.outgoingFiles.get(fileConnId);
    if (!f) { console.log('[sendBlock] no f, return'); return; }
    
    const { file, sent, fileSize } = f;
    console.log('[sendBlock] f.sent=', sent, 'fileSize=', fileSize, 'sent>=size?', f.sent >= fileSize);
    
    const ch = state.dataChannels.get(fileConnId);
    if (!ch) { console.log('[sendBlock] no ch, return'); return; }
    console.log('[sendBlock] ch.readyState=', ch.readyState);
    if (ch.readyState !== 'open') return;
    
    // 根据已发送的 idx 和已确认的 lastConfirmedIdx 计算 in-flight
    const lastConfirmed = state.dcLastConfirmed && state.dcLastConfirmed.get(fileConnId) || 0;
    const nextIdx = Math.floor(f.sent / CHUNK_SIZE);
    const inflight = nextIdx - lastConfirmed;
    console.log('[sendBlock] lastConfirmed=', lastConfirmed, 'nextIdx=', nextIdx, 'inflight=', inflight, 'MAX=', MAX_INFLIGHT);
    
    // 等待 FILE_RECEIVED 最终 ACK 的条件：
    // 1. lastConfirmed >= totalBlocks-1 → receiver 确认所有 block 已收到
    // 2. sent >= fileSize → sender 所有数据已发送
    if (f.sent >= fileSize && lastConfirmed >= f.totalBlocks - 1) {
        if (!f.waitingAck) {
            f.waitingAck = true;
            console.log('[sendBlock] ALL SENT AND ALL CONFIRMED, waiting for FILE_RECEIVED ACK, fileConnId=', fileConnId, 'lastConfirmed=', lastConfirmed, 'totalBlocks=', f.totalBlocks);
            startAckTimer(fileConnId);
        }
        return;
    }
    
    // sent >= fileSize 但 lastConfirmed 还没到顶 → 数据已发完但 receiver 还在确认中，继续等待 FLOW_ADV
    if (f.sent >= fileSize) {
        console.log('[sendBlock] ALL SENT, waiting for FLOW_ADV, fileConnId=', fileConnId, 'lastConfirmed=', lastConfirmed, 'totalBlocks=', f.totalBlocks);
        return;
    }
    
    // 滑动窗口流控：in-flight 达到上限则等待下一轮 FLOW_ADV
    if (inflight >= MAX_INFLIGHT) {
        console.log('[sendBlock] INFLIGHT FULL, waiting for FLOW_ADV. nextIdx=', nextIdx, 'lastConfirmed=', lastConfirmed, 'inflight=', inflight);
        return;
    }
    
    const idx = Math.floor(f.sent / CHUNK_SIZE);
    const rem = fileSize - f.sent;
    const cs = Math.min(CHUNK_SIZE, rem);
    
    // 防止重复发送：sentIdx 记录当前已发送的最高 idx
    if (f.sentIdx !== undefined && idx <= f.sentIdx) {
        console.log('[sendBlock] idx=', idx, 'already sent (sentIdx=', f.sentIdx, '), skip');
        return;
    }
    f.sentIdx = idx;
    console.log('[sendBlock] READY to send idx=', idx, 'cs=', cs);
    
    const r = new FileReader();
    r.onload = e => {
        console.log('[sendBlock] filereader done, idx=', idx);
        // 格式：[type:1][blockIdx:4][size:4][data:M]
        const buf = new ArrayBuffer(1 + 4 + 4 + cs);
        const v = new DataView(buf), u = new Uint8Array(buf);
        let o = 0;
        u[o] = PROTO.BLOCK; o++;
        v.setUint32(o, idx, false); o += 4;
        v.setUint32(o, cs, false); o += 4;
        u.set(new Uint8Array(e.target.result), o);
        
        console.log('[sendBlock] BEFORE send, ch.readyState=', ch.readyState);
        ch.send(u);
        console.log('[sendBlock] SENT idx=', idx, 'ch.readyState=', ch.readyState, 'bufferedAmount=', ch.bufferedAmount);
        
        f.sent += cs;
        state.outgoingFiles.set(fileConnId, f);
        
        const pct = Math.round((f.sent / fileSize) * 100);
        updateProgress(fileConnId, pct, f.sent / ((Date.now() - f.startTime) / 1000));
        
        // 文件未发完 → 继续发送下一块
        if (f.sent < fileSize) {
            // 始终用最新的 lastConfirmed，不要用闭包捕获的旧值
            const lcNow = state.dcLastConfirmed && state.dcLastConfirmed.get(fileConnId) || 0;
            const nextIdxNow = Math.floor(f.sent / CHUNK_SIZE);
            const inflightNow = nextIdxNow - lcNow;
            console.log('[sendBlock] after send: sent=', f.sent, 'nextIdxNow=', nextIdxNow, 'lcNow=', lcNow, 'inflightNow=', inflightNow, 'bufferedAmount=', ch.bufferedAmount);
            // Layer 1: 滑动窗口检查 + Layer 2: SCTP buffer 检查
            if (inflightNow >= MAX_INFLIGHT) {
                console.log('[sendBlock] inflight full, waiting for FLOW_ADV');
            } else if (ch.bufferedAmount >= BUFFER_HIGH) {
                console.log('[sendBlock] SCTP buffer high, waiting for onbufferedamountlow. bufferedAmount=', ch.bufferedAmount);
            } else {
                console.log('[sendBlock] scheduling next');
                setTimeout(() => sendBlock(fileConnId), 0);
            }
        } else {
            console.log('[sendBlock] all blocks sent!');
        }
    };
    r.onerror = () => { console.error('[sendBlock] filereader error'); xferFailed(fileConnId); };
    console.log('[sendBlock] reading file slice');
    r.readAsArrayBuffer(file.slice(f.sent, f.sent + cs));
}

// ACK 超时计时器
const ACK_TIMEOUT = 30000; // 30秒

function startAckTimer(fileConnId) {
    setTimeout(() => {
        const f = state.outgoingFiles.get(fileConnId);
        if (f && f.waitingAck) {
            console.warn('[ACK_TIMEOUT] 超时, fileConnId=', fileConnId);
            f.waitingAck = false;
            xferFailed(fileConnId);
        }
    }, ACK_TIMEOUT);
}

// 处理接收端发来的 FILE_RECEIVED ACK
function handleFileReceived(fileConnId, d) {
    const ok = d[0];
    const recvHash = Array.from(d.slice(1, 17)).map(b => b.toString(16).padStart(2, '0')).join('');
    const f = state.outgoingFiles.get(fileConnId);
    
    if (!f) return;
    
    console.log('[handleFileReceived] fileConnId=', fileConnId, 'ok=', ok, 'recvHash=', recvHash, 'expectedHash=', f.fileHash);
    
    if (ok === 1 && recvHash === f.fileHash) {
        console.log('[handleFileReceived] 传输成功');
        f.waitingAck = false;
        completeXfer(fileConnId, true);
        addHist({ name: f.fileName, direction: 'outgoing', status: 'complete' });
    } else {
        console.error('[handleFileReceived] 传输失败, ok=', ok, 'hashMatch=', recvHash === f.fileHash);
        f.waitingAck = false;
        xferFailed(fileConnId);
        addHist({ name: f.fileName, direction: 'outgoing', status: 'failed' });
    }
}

// ============================================
// Receiving
// ============================================

// 处理 file_offer（多文件版本）
function handleFileOffer(msg) {
    const { from, connId, payload } = msg;
    let p = typeof payload === 'string' ? JSON.parse(payload) : payload;
    
    // 支持新格式（files 数组）和旧格式（v2head 单文件）
    const files = p.files || (p.v2head ? [p.v2head] : []);
    
    console.log('[handleFileOffer] files count=', files.length, 'connId=', connId);
    
    // 累积到待处理队列
    if (!state.pendingFileOffers.has(connId)) {
        state.pendingFileOffers.set(connId, []);
    }
    const queue = state.pendingFileOffers.get(connId);
    
    for (const v2h of files) {
        const fileName = v2h.name || v2h.filename || 'unknown';
        const fileSize = v2h.size || v2h.fsize || 0;
        const fileConnId = `${connId}:${fileName}`;
        
        // 避免重复添加
        if (queue.some(f => f.fileConnId === fileConnId)) {
            console.log('[handleFileOffer] 跳过重复文件, fileConnId=', fileConnId);
            continue;
        }
        
        queue.push({
            fileConnId,
            fileName,
            fileSize,
            totalBlocks: v2h.blocks,
            fileHash: v2h.MD5,
            fromDeviceId: from,
            fromDeviceName: state.devices.get(from)?.payload || '未知设备',
            connId
        });
    }
    
    // 如果当前已有弹窗在显示，更新即可
    if (!document.getElementById('pendingModal').hidden) {
        console.log('[handleFileOffer] 弹窗已显示，更新列表');
        updatePendingModal();
        return;
    }
    
    showPendingModal();
}

function updatePendingModal() {
    const allFiles = [];
    for (const queue of state.pendingFileOffers.values()) {
        for (const f of queue) {
            allFiles.push(f);
        }
    }
    
    document.getElementById('modalFileCount').textContent = allFiles.length;
    document.getElementById('modalFileFrom').textContent = allFiles[0]?.fromDeviceName || '未知设备';
    
    // 渲染文件列表
    const listEl = document.getElementById('modalFileList');
    listEl.innerHTML = allFiles.map(f => `
        <div class="modal-file-list-item">
            <span class="file-icon">${getFileIcon(f.fileName)}</span>
            <div class="file-info">
                <div class="file-name">${f.fileName}</div>
                <div class="file-size">${formatBytes(f.fileSize)}</div>
            </div>
        </div>
    `).join('');
}

function showPendingModal() {
    const m = document.getElementById('pendingModal');
    updatePendingModal();
    m.hidden = false;
    
    let t = PENDING_TIMEOUT;
    const te = document.getElementById('modalTimer');
    te.textContent = t; te.classList.remove('warning');
    
    if (state.pendingFileTimer) {
        clearInterval(state.pendingFileTimer);
    }
    
    state.pendingFileTimer = setInterval(() => {
        t--;
        te.textContent = t;
        if (t <= 10) te.classList.add('warning');
        if (t <= 0) {
            clearInterval(state.pendingFileTimer);
            rejectAllPending();
        }
    }, 1000);
    
    document.getElementById('acceptBtn').onclick = () => {
        clearInterval(state.pendingFileTimer);
        acceptAllPending();
    };
    document.getElementById('rejectBtn').onclick = () => {
        clearInterval(state.pendingFileTimer);
        rejectAllPending();
    };
}

function acceptAllPending() {
    // 遍历所有 connId，初始化接收状态
    for (const [connId, queue] of state.pendingFileOffers) {
        for (const info of queue) {
            if (!state.incomingChannels.has(info.fileConnId)) {
                state.incomingChannels.set(info.fileConnId, {
                    fileName: info.fileName,
                    fileSize: info.fileSize,
                    totalBlocks: info.totalBlocks,
                    expectedHash: info.fileHash,
                    received: 0,
                    blocks: new Map(),
                    startTime: Date.now()
                });
            }
            
            addTransferUI(info.fileConnId, {
                name: info.fileName,
                size: info.fileSize,
                direction: 'incoming',
                deviceName: info.fromDeviceName
            });
        }
    }
    
    // 收集所有文件名和对应的 connId
    const allFiles = [];
    const connIdMap = new Map();  // fileName -> connId
    for (const [connId, queue] of state.pendingFileOffers) {
        for (const info of queue) {
            allFiles.push(info.fileName);
            connIdMap.set(info.fileName, connId);
        }
    }
    
    // 找到一个有效的发送目标
    let firstInfo = null;
    for (const queue of state.pendingFileOffers.values()) {
        if (queue.length > 0) {
            firstInfo = queue[0];
            break;
        }
    }
    if (!firstInfo) return;
    
    // 发送 file_accept（包含所有文件名）
    send({
        type: MSG.FILE_ACCEPT,
        from: state.deviceId,
        to: firstInfo.fromDeviceId,
        connId: firstInfo.connId,
        payload: { acceptedFiles: allFiles }
    });
    
    state.pendingFileOffers.clear();
    state.pendingOffers.clear();
    hideDlg();
}

function rejectAllPending() {
    for (const [connId, queue] of state.pendingFileOffers) {
        const allFileNames = queue.map(f => f.fileName);
        if (allFileNames.length === 0) continue;
        const firstInfo = queue[0];
        send({
            type: MSG.FILE_REJECT,
            from: state.deviceId,
            to: firstInfo.fromDeviceId,
            connId: connId,
            payload: { rejectedFiles: allFileNames }
        });
    }
    
    state.pendingFileOffers.clear();
    state.pendingOffers.clear();
    hideDlg();
}

function hideDlg() { document.getElementById('pendingModal').hidden = true; }

// 接受传输
function acceptOffer(fileConnId, info) {
    if (!info || !info.fileName) {
        console.error('[acceptOffer] invalid info:', info);
        return;
    }
    const { fromDeviceId, connId } = info;
    
    send({
        type: MSG.FILE_ACCEPT,
        from: state.deviceId,
        to: fromDeviceId,
        connId,
        payload: { acceptedFiles: [info.fileName] }
    });
    
    state.incomingChannels.set(fileConnId, {
        fileName: info.fileName,
        fileSize: info.fileSize,
        totalBlocks: info.totalBlocks,
        expectedHash: info.fileHash,
        received: 0,
        blocks: new Map(),
        startTime: Date.now()
    });
    
    addTransferUI(fileConnId, {
        name: info.fileName,
        size: info.fileSize,
        direction: 'incoming',
        deviceName: info.fromDeviceName
    });
    
    state.pendingOffers.delete(fileConnId);
}

// 拒绝传输
function rejectOffer(fileConnId, fromId, connId) {
    send({ type: MSG.FILE_REJECT, from: state.deviceId, to: fromId, connId, payload: { rejectedFiles: [fileConnId.split(':').pop()] } });
    state.pendingOffers.delete(fileConnId);
}

// 处理 file_accept（并发启动所有文件传输）
function handleFileAccept(msg) {
    const { connId, payload } = msg;
    const accepted = payload?.acceptedFiles || [];
    
    console.log('[handleFileAccept] connId=', connId, 'accepted=', accepted);
    
    for (const fileName of accepted) {
        const fileConnId = `${connId}:${fileName}`;
        state.transferAccepted.set(fileConnId, true);
        
        // 并发启动：DC 打开时由 setupDC 触发，这里只处理已打开的情况
        const ch = state.dataChannels.get(fileConnId);
        if (ch?.readyState === 'open' && !state.v2HeadSent.get(fileConnId)) {
            const f = state.outgoingFiles.get(fileConnId);
            if (f) {
                console.log('[handleFileAccept] 立即发送, fileConnId=', fileConnId);
                sendV2Head(fileConnId, f);
            }
        } else {
            console.log('[handleFileAccept] DC 未就绪，等待 onopen, fileConnId=', fileConnId);
        }
    }
}

function handleFileReject(msg) {
    const rejected = msg.payload?.rejectedFiles || [];
    for (const fileName of rejected) {
        const fileConnId = `${msg.connId}:${fileName}`;
        state.dataChannels.delete(fileConnId);
        state.outgoingFiles.delete(fileConnId);
        state.dcReady.delete(fileConnId);
        state.v2HeadSent.delete(fileConnId);
        state.transferAccepted.delete(fileConnId);
        removeTransferUI(fileConnId);
        addHist({ name: fileName, direction: 'outgoing', status: 'rejected' });
    }
}

function handleFileCancel(msg) {
    // 取消该 connId 下所有待接收文件
    const queue = state.pendingFileOffers.get(msg.connId);
    if (queue) {
        for (const info of queue) {
            state.pendingOffers.delete(info.fileConnId);
        }
        state.pendingFileOffers.delete(msg.connId);
    }
    
    cleanupAllForConnId(msg.connId);
    
    // 清理所有以该 connId 为前缀的文件
    for (const [fileConnId] of state.incomingChannels) {
        if (fileConnId.startsWith(msg.connId + ':')) {
            const name = state.incomingChannels.get(fileConnId)?.fileName || '未知文件';
            state.incomingChannels.delete(fileConnId);
            state.receiveBuffers.delete(fileConnId);
            addHist({ name, direction: 'incoming', status: 'cancelled' });
            removeTransferUI(fileConnId);
        }
    }
}

// 处理二进制数据（按 fileConnId 分发）
function handleBinary(fileConnId, buf) {
    const u = new Uint8Array(buf);
    console.log('[handleBinary] IN fileConnId=', fileConnId, 'len=', buf.byteLength, 'u[0]=0x' + (u[0]||0).toString(16));
    
    try {
        // V2Head: first byte of nameLen is typically 0x00 for filenames < 256 chars
        // Block: starts with 0x01
        // FILE_RECEIVED: starts with 0x05
        if (u[0] === 0x01) {
            recvBlock(fileConnId, u.slice(1));
        } else if (u[0] === 0x05) {
            handleFileReceived(fileConnId, u.slice(1));
        } else if (u[0] === 0x06) {
            // FLOW_ADV: receiver confirms blocks received (by last confirmed block idx)
            const flowV = new DataView(buf);
            const lastIdx = flowV.getUint32(1, false);
            const totalRecv = flowV.getUint32(5, false);
            console.log('[handleBinary] FLOW_ADV: lastIdx=', lastIdx, 'totalRecv=', totalRecv, 'fileConnId=', fileConnId);
            
            // 更新 lastConfirmed，释放滑动窗口
            if (!state.dcLastConfirmed) state.dcLastConfirmed = new Map();
            const prev = state.dcLastConfirmed.get(fileConnId) || 0;
            state.dcLastConfirmed.set(fileConnId, Math.max(prev, lastIdx));
            console.log('[handleBinary] FLOW_ADV lastConfirmed', prev, '->', lastIdx);
            
            // 触发 sendBlock 看是否能继续发
            sendBlock(fileConnId);
        } else {
            // Assume V2Head (no explicit type byte; nameLen first byte rarely 0x01/0x05)
            recvV2Head(fileConnId, u);
        }
    } catch(e) {
        console.error('[handleBinary] error:', e.message, 'stack:', e.stack);
    }
}

// 解析 V2Head
function recvV2Head(fileConnId, d) {
    console.log('[recvV2Head] fileConnId=', fileConnId, 'd.len=', d.length);
    try {
        // V2Head layout: [nameLen:4][filename:N][fileSize_hi:4][fileSize_lo:4][totalBlocks:4][MD5:16][crc32:4]
        const dataLen = d.length - 4;  // exclude crc32(4) at end
        const recvCrc = new DataView(d.buffer, d.byteOffset + dataLen, 4).getUint32(0, false);
        const calcCrc = crc32c(d.buffer.slice(d.byteOffset, d.byteOffset + dataLen));
        console.log('[recvV2Head] recvCrc=', recvCrc, 'calcCrc=', calcCrc);
        if (recvCrc !== calcCrc) {
            console.error('[recvV2Head] CRC 校验失败！');
            return;
        }
        
        const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
        let o = 0;  // no type byte, starts with nameLen directly
        const nl = v.getUint32(o, false); o += 4;
        if (nl > 1000 || nl > dataLen) { console.error('[recvV2Head] nameLen 异常'); return; }
        const fn = new TextDecoder().decode(d.slice(o, o + nl)); o += nl;
        const fsHi = v.getUint32(o, false); o += 4;
        const fsLo = v.getUint32(o, false); o += 4;
        const fs = fsLo + fsHi * 0x100000000;
        const bl = v.getUint32(o, false); o += 4;
        const mh = Array.from(d.slice(o, o + 16)).map(b => b.toString(16).padStart(2, '0')).join('');
        
        if (fs > 10 * 1024 * 1024 * 1024 || bl > 100000) {
            console.error('[recvV2Head] 文件信息异常');
            return;
        }
        
        console.log('[recvV2Head] parsed: fileName=', fn, 'fileSize=', fs, 'blocks=', bl);
        if (!state.receiveBuffers.has(fileConnId)) {
            state.receiveBuffers.set(fileConnId, { fileName: fn, fileSize: fs, totalBlocks: bl, expectedHash: mh, received: 0, blocks: new Map(), startTime: Date.now() });
        }
    } catch(e) {
        console.error('[recvV2Head] parse error:', e.message);
    }
}

// 接收 Block
function recvBlock(fileConnId, d) {
    const r = state.receiveBuffers.get(fileConnId);
    if (!r) { console.log('[recvBlock] no receiveBuffer, return'); return; }
    
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    let o = 0;
    const idx = v.getUint32(o, false); o += 4;
    const sz = v.getUint32(o, false); o += 4;
    const bd = d.slice(o, o + sz);
    
    r.blocks.set(idx, bd);
    r.received += sz;
    
    // 检查是否收齐所有块
    if (r.blocks.size === r.totalBlocks && r.received === r.fileSize) {
        console.log('[recvBlock] 所有块已收齐，开始 MD5 校验');
        doMd5AndSendAck(fileConnId);
        return;
    }
    
    const p = Math.round((r.received / r.fileSize) * 100);
    const now = Date.now();
    const elapsed = r.startTime ? Math.round((now - r.startTime) / 1000) : 0;
    console.log('[recvBlock] fileConnId=', fileConnId, 'received=', r.received, '/', r.fileSize, 'blocks=', r.blocks.size, '/', r.totalBlocks, 'pct=', p, 'elapsed=', elapsed, 's');
    updateProgress(fileConnId, p, r.received / ((now - r.startTime) / 1000));
    
    // 每收满 8 个 block 或达到 50% 进度节点，发一个 FLOW_ADV (0x06) 通知发送端可以继续发
    const ch = state.dataChannels.get(fileConnId);
    if (ch && ch.readyState === 'open') {
        r.flowCounter = r.flowCounter || 0;
        r.flowCounter++;
        if (r.flowCounter >= 1 || r.blocks.size === Math.floor(r.totalBlocks * 0.5) || r.blocks.size === r.totalBlocks) {
            const flowBuf = new ArrayBuffer(1 + 4 + 4);
            const flowU = new Uint8Array(flowBuf);
            flowU[0] = 0x06; // PROTO.FLOW_ADV
            // 发送当前已确认的 block idx (发送端可以用这个知道哪些 block 已被接收)
            const lastIdx = Math.max(...r.blocks.keys());
            const flowV = new DataView(flowBuf);
            flowV.setUint32(1, lastIdx, false); // last confirmed block idx
            flowV.setUint32(5, r.blocks.size, false); // total received blocks
            ch.send(flowBuf);
            console.log('[recvBlock] FLOW_ADV sent: lastIdx=', lastIdx, 'totalRecv=', r.blocks.size, 'counter=', r.flowCounter);
            r.flowCounter = 0;
        }
    }
    
    console.log('[recvBlock] DONE idx=', idx, 'fileConnId=', fileConnId);
}

async function doMd5AndSendAck(fileConnId) {
    const r = state.receiveBuffers.get(fileConnId);
    if (!r) return;
    
    console.log('[doMd5AndSendAck] fileConnId=', fileConnId, 'blocks=', r.blocks.size, '/', r.totalBlocks, 'received=', r.received, '/', r.fileSize);
    
    // 组装文件
    const total = new Uint8Array(r.fileSize);
    let off = 0;
    for (let i = 0; i < r.totalBlocks; i++) {
        const b = r.blocks.get(i);
        if (b) { total.set(b, off); off += b.length; }
    }
    
    // MD5 校验
    const calcHash = md5Hex(total.buffer);
    const hashMatch = (calcHash === r.expectedHash);
    
    console.log('[doMd5AndSendAck] hashMatch=', hashMatch, 'expected=', r.expectedHash, 'calc=', calcHash);
    
    // 发送 ACK
    const buf = new Uint8Array(18);
    buf[0] = PROTO.FILE_RECEIVED;
    buf[1] = hashMatch ? 1 : 0;
    const mh = calcHash.match(/.{2}/g).map(b => parseInt(b, 16));
    for (let i = 0; i < 16; i++) buf[i + 2] = mh[i];
    
    const ch = state.dataChannels.get(fileConnId);
    if (ch && ch.readyState === 'open') {
        ch.send(buf);
        console.log('[doMd5AndSendAck] ACK 已发送, ok=', hashMatch);
    }
    
    // 处理结果
    if (hashMatch) {
        downloadBlob(new Blob([total]), r.fileName);
        completeXfer(fileConnId, true);
        addHist({ name: r.fileName, direction: 'incoming', status: 'complete' });
    } else {
        console.error('[doMd5AndSendAck] MD5 校验失败');
        xferFailed(fileConnId);
        addHist({ name: r.fileName, direction: 'incoming', status: 'failed' });
    }
    
    state.receiveBuffers.delete(fileConnId);
    state.incomingChannels.delete(fileConnId);
}

function downloadBlob(blob, fn) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = u; a.download = fn;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(u);
}

// ============================================
// UI
// ============================================

function addTransferUI(fileConnId, info) {
    if (!info || !info.name) {
        console.error('[addTransferUI] invalid info:', info);
        return;
    }
    const list = document.getElementById('activeTransfers');
    const emp = list.querySelector('.transfer-empty');
    if (emp) emp.remove();
    
    const el = document.createElement('div');
    el.className = 'transfer-item';
    el.id = `tx-${fileConnId}`;
    el.innerHTML = `
        <div class="transfer-item-header">
            <span class="transfer-icon">${getFileIcon(info.name)}</span>
            <div class="transfer-info">
                <div class="transfer-name text-ellipsis">${info.name}</div>
                <div class="transfer-meta">
                    <span class="transfer-direction ${info.direction}">${info.direction === 'outgoing' ? '→' : '←'} ${info.deviceName}</span>
                    <span>${formatBytes(info.size)}</span>
                </div>
            </div>
        </div>
        <div class="transfer-progress-bar"><div class="transfer-progress-fill" id="pr-${fileConnId}" style="width:0%"></div></div>
        <div class="transfer-footer">
            <span class="transfer-progress-text" id="pt-${fileConnId}">0%</span>
            <span class="transfer-speed" id="sp-${fileConnId}">0 B/s</span>
        </div>`;
    list.appendChild(el);
    state.activeTransfers.set(fileConnId, info);
}

function updateProgress(fileConnId, pct, speed) {
    const pr = document.getElementById(`pr-${fileConnId}`);
    const pt = document.getElementById(`pt-${fileConnId}`);
    const sp = document.getElementById(`sp-${fileConnId}`);
    if (pr) pr.style.width = `${pct}%`;
    if (pt) pt.textContent = `${pct}%`;
    if (sp) sp.textContent = formatSpeed(speed);
}

function completeXfer(fileConnId, ok) {
    const pr = document.getElementById(`pr-${fileConnId}`);
    if (pr) { pr.classList.add('complete'); pr.style.width = '100%'; }
    const pt = document.getElementById(`pt-${fileConnId}`);
    if (pt) pt.textContent = ok ? '完成' : '失败';
    const info = state.activeTransfers.get(fileConnId);
    if (info) addHist({ name: info.name, direction: info.direction, status: ok ? 'complete' : 'failed' });
    setTimeout(() => removeTransferUI(fileConnId), 3000);
}

function xferFailed(fileConnId) {
    console.log('[xferFailed]', fileConnId);
    const pt = document.getElementById(`pt-${fileConnId}`);
    if (pt) pt.textContent = '失败';
    const info = state.activeTransfers.get(fileConnId);
    if (info) addHist({ name: info.name, direction: info.direction, status: 'failed' });
    setTimeout(() => removeTransferUI(fileConnId), 3000);
}

// 清理指定 connId 下的所有文件传输
function cleanupAllForConnId(connId) {
    console.log('[cleanupAllForConnId] connId=', connId);
    
    for (const [fileConnId, info] of state.outgoingFiles) {
        if (fileConnId.startsWith(connId + ':')) {
            removeTransferUI(fileConnId);
        }
    }
    for (const [fileConnId, info] of state.incomingChannels) {
        if (fileConnId.startsWith(connId + ':')) {
            removeTransferUI(fileConnId);
        }
    }
    
    const pc = state.peerConnections.get(connId);
    if (pc) { pc.close(); state.peerConnections.delete(connId); }
}

function removeTransferUI(fileConnId) {
    const el = document.getElementById(`tx-${fileConnId}`);
    if (el) el.remove();
    
    state.dataChannels.delete(fileConnId);
    state.outgoingFiles.delete(fileConnId);
    state.incomingChannels.delete(fileConnId);
    state.receiveBuffers.delete(fileConnId);
    state.dcReady.delete(fileConnId);
    state.v2HeadSent.delete(fileConnId);
    state.transferAccepted.delete(fileConnId);
    
    if (state.activeTransfers.size === 0) {
        document.getElementById('activeTransfers').innerHTML = '<div class="transfer-empty">暂无传输任务</div>';
    }
}

function cleanup(connId) {
    const pc = state.peerConnections.get(connId);
    if (pc) { pc.close(); state.peerConnections.delete(connId); }
    state.dataChannels.delete(connId);
    state.outgoingFiles.delete(connId);
    state.dcReady.delete(connId);
    state.v2HeadSent.delete(connId);
    state.transferAccepted.delete(connId);
}

function addHist(item) {
    state.transferHistory.unshift({ ...item, time: new Date() });
    if (state.transferHistory.length > 50) state.transferHistory.pop();
    renderHist();
}

function renderHist() {
    const list = document.getElementById('transferHistory');
    if (state.transferHistory.length === 0) { list.innerHTML = '<div class="transfer-empty">暂无传输记录</div>'; return; }
    list.innerHTML = state.transferHistory.map(h => `
        <div class="history-item">
            <span class="transfer-icon">${getFileIcon(h.name)}</span>
            <div class="transfer-info" style="flex:1">
                <div class="transfer-name text-ellipsis">${h.name}</div>
                <div class="transfer-meta"><span>${h.direction === 'outgoing' ? '→' : '←'}</span><span>${formatTime(h.time)}</span></div>
            </div>
            <span class="history-status ${h.status}">${h.status === 'complete' ? '✓ 完成' : h.status === 'failed' ? '✗ 失败' : h.status === 'rejected' ? '✗ 已拒绝' : '✗ ' + h.status}</span>
        </div>`).join('');
}

function renderDevices() {
    const list = document.getElementById('devicesList');
    if (state.devices.size === 0) { list.innerHTML = '<div class="devices-empty">正在搜索设备...</div>'; return; }
    list.innerHTML = Array.from(state.devices.entries())
        .filter(([id]) => id !== state.deviceId)
        .map(([id, d]) => `<div class="device-item ${state.selectedDeviceId === id ? 'selected' : ''}" data-id="${id}">
            <span class="device-icon">${getDeviceIcon(d.payload)}</span>
            <div class="device-info">
                <div class="device-name-text">${d.payload || '未知设备'}</div>
                <div class="device-status"><span class="status-dot online"></span><span>在线</span></div>
            </div>
        </div>`).join('');
    list.querySelectorAll('.device-item').forEach(el => el.addEventListener('click', () => { state.selectedDeviceId = el.dataset.id; renderDevices(); updateSendBtn(); }));
}

function updateSendBtn() {
    const btn = document.getElementById('sendBtn');
    const dev = state.devices.get(state.selectedDeviceId);
    const hasFiles = state.selectedFiles.length > 0;
    btn.disabled = !state.selectedDeviceId || !hasFiles;
    btn.textContent = state.selectedDeviceId && hasFiles ? `发送给 ${dev?.payload?.split(' ')[0] || '设备'}` : '发送至选中设备';
}

function clearFiles() { state.selectedFiles = []; renderFiles(); updateSendBtn(); }

function renderFiles() {
    const c = document.getElementById('selectedFiles');
    if (state.selectedFiles.length === 0) { c.innerHTML = '<div class="files-empty">未选择文件</div>'; return; }
    c.innerHTML = state.selectedFiles.map((f, i) => `
        <div class="file-item">
            <span class="file-item-icon">${getFileIcon(f.name)}</span>
            <span class="file-item-name" title="${f.name}">${f.name}</span>
            <span class="file-item-size">${formatBytes(f.size)}</span>
            <button class="file-item-remove" data-i="${i}">✕</button>
        </div>`).join('');
    c.querySelectorAll('.file-item-remove').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); state.selectedFiles.splice(parseInt(b.dataset.i), 1); renderFiles(); updateSendBtn(); }));
}

// ============================================
// Init
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('fileInput').addEventListener('change', e => { Array.from(e.target.files).forEach(f => { if (!state.selectedFiles.find(x => x.id === f.name + f.size)) state.selectedFiles.push({ id: f.name + f.size, file: f, name: f.name, size: f.size }); }); renderFiles(); updateSendBtn(); e.target.value = ''; });
    document.getElementById('folderInput').addEventListener('change', e => { Array.from(e.target.files).forEach(f => { if (!state.selectedFiles.find(x => x.id === f.name + f.size)) state.selectedFiles.push({ id: f.name + f.size, file: f, name: f.name, size: f.size }); }); renderFiles(); updateSendBtn(); e.target.value = ''; });
    document.getElementById('sendBtn').addEventListener('click', () => { if (state.selectedDeviceId && state.selectedFiles.length > 0) startTransfer(state.selectedDeviceId, state.selectedFiles.map(f => f.file)); });
    connectWebSocket();
});