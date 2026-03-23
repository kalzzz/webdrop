/**
 * WebDrop - P2P File Transfer Frontend
 */

// ============================================
// Constants
// ============================================
const WS_URL = `ws://${window.location.host}/ws`;
// 使用国内可访问的 STUN 服务器，关闭 VPN 后应该可用
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
const PROTO = { V2HEAD: 0x10, BLOCK: 0x01, END: 0x04 };

// ============================================
// State
// ============================================
const state = {
    ws: null, deviceId: null, deviceName: null, connected: false,
    devices: new Map(), selectedDeviceId: null, selectedFiles: [],
    pendingOffers: new Map(), pendingCandidates: new Map(),
    activeTransfers: new Map(), transferHistory: [],
    peerConnections: new Map(), dataChannels: new Map(),
    incomingChannels: new Map(), outgoingFiles: new Map(), receiveBuffers: new Map(),
    dcReady: new Map(), v2HeadSent: new Map(), transferAccepted: new Map()
};

// ============================================
// Utilities
// ============================================
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
    const ext = name.split('.').pop()?.toLowerCase() || '';
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
// CRC32-C
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
            // Log all incoming messages except REGISTERED/DEVICE_LIST/DEVICE_JOINED/DEVICE_LEFT (noisy)
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
    // Defensive: ignore messages with missing type
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
            // Server confirms our own ID; append random suffix to platform name for uniqueness
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
        case MSG.ICE: console.log('[handleMsg] ICE from=', msg.from, 'connId=', msg.connId); handleIce(msg); break;
        case MSG.FILE_OFFER: {
            console.warn('!!! FILE_OFFER case reached !!!');
            console.log('!!! handleFileOffer type:', typeof handleFileOffer);
            handleFileOffer(msg);
            console.log('!!! handleFileOffer returned');
            break;
        }
        case MSG.FILE_ACCEPT: handleFileAccept(msg); break;
        case MSG.FILE_REJECT: handleFileReject(msg); break;
        case MSG.FILE_CANCEL: handleFileCancel(msg); break;
    }
}

// ============================================
// WebRTC
// ============================================
// Reverse the first two segments of a connId to find the matching connId.
// connId = {id1}-{id2}-{ts} where id1/id2 are 9-char strings without dashes
function reverseConnId(c) {
    const p = c.split('-');
    return p.length >= 3 ? `${p[1]}-${p[0]}-${p[2]}` : c;
}

async function handleOffer(msg) {
    const { from, connId, payload } = msg;
    console.log('[handleOffer] from=', from, 'connId=', connId);

    const pc = createPC(connId);
    console.log('[handleOffer] PC created');

    // Listen for incoming DataChannel
    pc.ondatachannel = (e) => {
        console.log('[handleOffer] DataChannel received from=', from, 'label=', e.channel.label);
        setupDC(e.channel, connId, 'receiver');
    };

    // Send ICE candidates as they are gathered
    pc.onicecandidate = (e) => {
        if (e.candidate) {
            console.log('[handleOffer] sending ice candidate to=', from, 'connId=', connId);
            send({ type: MSG.ICE, from: state.deviceId, to: from, connId, payload: e.candidate });
        }
    };

    // Set remote description FIRST, then create and send answer
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    console.log('[handleOffer] remoteDesc set, creating answer');

    // Drain any queued candidates for this connId
    const queued = state.pendingCandidates.get(connId) || [];
    state.pendingCandidates.delete(connId);
    for (const c of queued) {
        console.log('[handleOffer] draining queued candidate:', JSON.stringify(c)?.substring(0, 80));
        await pc.addIceCandidate(new RTCIceCandidate(c));
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    send({ type: MSG.ANSWER, from: state.deviceId, to: from, connId, payload: { sdp: pc.localDescription } });
    console.log('[handleOffer] answer sent to=', from);
}

async function handleAnswer(msg) {
    // PC was stored by startTransfer under connId = {caller}-{callee}-{ts}
    // msg.connId = {callee}-{caller}-{ts} (reversed). Try both directions.
    const offerConnId = reverseConnId(msg.connId);
    const altConnId = msg.connId;
    console.log('[handleAnswer] selfId=', state.deviceId, 'answer connId=', altConnId, 'offerConnId=', offerConnId, 'stored PCs=', Array.from(state.peerConnections.keys()));
    let pc = state.peerConnections.get(altConnId) || state.peerConnections.get(offerConnId);
    if (!pc) { console.warn('[handleAnswer] no PC for', altConnId, 'or', offerConnId); return; }

    // Ensure PC is stored under both possible connIds for ICE routing
    state.peerConnections.set(altConnId, pc);
    state.peerConnections.set(offerConnId, pc);

    await pc.setRemoteDescription(new RTCSessionDescription(msg.payload.sdp));
    console.log('[handleAnswer] remote desc set, draining candidates');

    // Drain all queued candidates
    for (const key of [altConnId, offerConnId]) {
        const cands = state.pendingCandidates.get(key) || [];
        state.pendingCandidates.delete(key);
        for (const c of cands) {
            console.log('[handleAnswer] draining candidate:', JSON.stringify(c)?.substring(0, 80));
            await pc.addIceCandidate(new RTCIceCandidate(c));
        }
    }
    console.log('[handleAnswer] done, ICE state:', pc.iceConnectionState);
}

async function handleIce(msg) {
    const { connId, payload, lan_ip } = msg;

    let candidateStr = payload.candidate;

    // 若存在 lan_ip 且 candidate 中包含 .local，替换 mDNS 地址
    if (lan_ip && candidateStr && candidateStr.includes('.local')) {
        candidateStr = replaceMDNSWithLANIP(candidateStr, lan_ip);
        console.log('[handleIce] mDNS replaced:', candidateStr.substring(0, 80) + '...');
    }

    // Build the ICE candidate object (may have been modified)
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

function createPC(connId) {
    console.log('[createPC] connId=', connId, 'selfId=', state.deviceId);
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
        if (pc.iceConnectionState === 'connected') {
            console.log('[ICE connected] ICE 连接建立，等待 DC open 或 file_accept...');
        }
        if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
            xferFailed(connId);
        }
    };

    // ICE 候选收集后自动发送；connId = {caller}-{callee}-{ts}
    pc.onicecandidate = e => {
        if (!e.candidate) {
            console.log('[ICE complete]', connId);
            return;
        }
        const p = connId.split('-');
        const isOfferSide = p[0] === state.deviceId;
        const target = isOfferSide ? p[1] : p[0];
        if (!target || target === state.deviceId) return;
        send({
            type: MSG.ICE,
            from: state.deviceId,
            to: target,
            connId,
            payload: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex }
        });
    };

    return pc;
}

function setupDC(channel, connId, role) {
    console.log('[setupDC] connId=', connId, 'role=', role, 'label=', channel.label);
    channel.binaryType = 'arraybuffer';
    state.dataChannels.set(connId, channel);
    channel.onopen = () => {
        const pc = state.peerConnections.get(connId);
        console.log('[DC open]', connId, 'role=', role, 'ICE=', pc?.iceConnectionState, 'PC=', pc?.connectionState);
        // 发送端：DC 打开后自动发送文件头
        if (role === 'sender') {
            const f = state.outgoingFiles.get(connId);
            if (f) {
                console.log('[DC open] 触发 sendV2Head, connId=', connId);
                sendV2Head(connId, f);
            } else {
                console.warn('[DC open] 无待发送文件, connId=', connId);
            }
        }
    };
    channel.onmessage = e => { if (e.data instanceof ArrayBuffer) handleBinary(connId, e.data); };
    channel.onclose = () => {
        const pc = state.peerConnections.get(connId);
        console.log('[DC close]', connId, 'ICE=', pc?.iceConnectionState, 'PC=', pc?.connectionState);
        state.dataChannels.delete(connId);
    };
    channel.onerror = e => {
        const pc = state.peerConnections.get(connId);
        console.error('[DC error]', connId, 'ICE=', pc?.iceConnectionState, 'error=', e, 'message=', e?.message);
        xferFailed(connId);
    };
}

// ============================================
// Sending
// ============================================
async function startTransfer(targetId, files) {
    for (const file of files) {
        const connId = generateConnId(state.deviceId, targetId);
        const pc = createPC(connId);
        const hash = await computeFileHash(file);
        state.outgoingFiles.set(connId, { file, fileName: file.name, fileSize: file.size, totalBlocks: Math.ceil(file.size / CHUNK_SIZE), fileHash: hash, sent: 0, startTime: Date.now() });
        addTransferUI(connId, { name: file.name, size: file.size, direction: 'outgoing', deviceName: state.devices.get(targetId)?.payload || '未知设备' });
        // ⚠️ 关键：createDataChannel 必须在 createOffer 之前，否则 ICE 不会收集 candidate
        const dc = pc.createDataChannel('ft', { ordered: false });
        dc.onopen = () => {
            console.log('[DC open] DC 已就绪，等待 file_accept, connId=', connId);
            state.dcReady.set(connId, true);
            // 必须同时满足：DC open + 已收到 file_accept（transferAccepted）
            const ch = state.dataChannels.get(connId);
            if (ch && ch.readyState === 'open' && state.transferAccepted.get(connId) && !state.v2HeadSent.get(connId)) {
                const f = state.outgoingFiles.get(connId);
                if (f) sendV2Head(connId, f);
            }
        };
        dc.onerror = e => {
            console.error('[DC error]', e);
            xferFailed(connId);
        };
        console.log('[startTransfer] createDataChannel 完成, iceGatheringState=', pc.iceGatheringState);
        const offer = await pc.createOffer();
        console.log('[startTransfer] createOffer 完成, iceGatheringState=', pc.iceGatheringState);
        await pc.setLocalDescription(offer);
        console.log('[startTransfer] setLocalDescription 完成, iceGatheringState=', pc.iceGatheringState, 'localDesc type=', pc.localDescription?.type);
        console.log('[startTransfer] selfId=', state.deviceId, 'targetId=', targetId, 'connId=', connId, 'ua=', navigator.userAgent);
        state.dataChannels.set(connId, dc);
        console.log('[startTransfer] DC stored in state.dataChannels, waiting for file_accept');
        send({ type: MSG.FILE_OFFER, from: state.deviceId, to: targetId, connId, payload: { v2head: { filename: file.name, fsize: file.size, blocks: Math.ceil(file.size / CHUNK_SIZE), MD5: hash } } });
        send({ type: MSG.OFFER, from: state.deviceId, to: targetId, connId, payload: { sdp: pc.localDescription } });
    }
    clearFiles();
}

function sendV2Head(connId, info) {
    const { fileName, fileSize, totalBlocks, fileHash } = info;
    const ch = state.dataChannels.get(connId);
    console.log('[sendV2Head] connId=', connId, 'ch.readyState=', ch?.readyState, 'sentV2Head=', state.outgoingFiles.get(connId)?.sentV2Head);
    if (!ch || ch.readyState !== 'open') { console.warn('[sendV2Head] channel not open, bailing'); return; }
    const outFiles = state.outgoingFiles.get(connId);
    if (!outFiles || outFiles.sentV2Head) { console.warn('[sendV2Head] already sent or not found'); return; }
    outFiles.sentV2Head = true;

    const nb = new TextEncoder().encode(fileName);
    // V2Head layout: [nameLen:4][filename][fileSize_hi:4][fileSize_lo:4][totalBlocks:4][MD5:16][crc32:4]
    const crc32Pos = 4 + nb.length + 8 + 4 + 16;  // offset where crc32 will be written
    const hdr = new ArrayBuffer(crc32Pos + 4);
    const v = new DataView(hdr), u = new Uint8Array(hdr);
    let o = 0;
    v.setUint32(o, nb.length, false); o += 4;  // big-endian nameLen
    u.set(nb, o); o += nb.length;              // filename
    const hi = (Math.floor(fileSize / 0x100000000)) >>> 0;
    const lo = fileSize >>> 0;
    v.setUint32(o, hi, false); o += 4;         // fileSize hi
    v.setUint32(o, lo, false); o += 4;         // fileSize lo
    v.setUint32(o, totalBlocks, false); o += 4; // totalBlocks
    const mh = (fileHash || '').padEnd(32, '0').slice(0, 32);
    for (let i = 0; i < 16; i++) u[o + i] = parseInt(mh.substr(i * 2, 2), 16);
    // 计算 CRC32（不包含 CRC 字段自身）
    const crc = crc32c(hdr.slice(0, crc32Pos));
    v.setUint32(crc32Pos, crc, false);         // CRC32 at end
    console.log('[sendV2Head] sending hdr bytes=', hdr.byteLength, 'nameLen=', nb.length, 'fsize=', fileSize, 'blocks=', totalBlocks, 'crc=', crc);
    ch.send(hdr);
    console.log('[sendV2Head] hdr sent, queuing sendBlock');
    setTimeout(() => sendBlock(connId), 0);
}

function sendBlock(connId) {
    const f = state.outgoingFiles.get(connId);
    const pc = state.peerConnections.get(connId);
    console.log('[sendBlock] connId=', connId, 'f=', !!f, 'f.sent=', f?.sent, 'f.fileSize=', f?.fileSize, 'ICE=', pc?.iceConnectionState, 'PC=', pc?.connectionState);
    if (!f) return;
    const { file, sent, fileSize } = f;
    const ch = state.dataChannels.get(connId);
    console.log('[sendBlock] ch=', !!ch, 'ch.readyState=', ch?.readyState, 'ICE=', pc?.iceConnectionState);
    if (!ch || ch.readyState !== 'open') return;
    if (sent >= fileSize) { sendEnd(connId, f); return; }
    const idx = Math.floor(sent / CHUNK_SIZE);
    const rem = fileSize - sent;
    const cs = Math.min(CHUNK_SIZE, rem);
    const r = new FileReader();
    r.onload = e => {
        const dt = e.target.result, crc = crc32c(dt);
        const buf = new ArrayBuffer(1 + 4 + 4 + 4 + cs);
        const v = new DataView(buf), u = new Uint8Array(buf);
        let o = 0; u[o] = PROTO.BLOCK; o++;
        v.setUint32(o, idx, false); o += 4;  // big-endian
        v.setUint32(o, cs, false); o += 4;  // big-endian
        v.setUint32(o, crc, false); o += 4;  // big-endian (CRC32-C as uint32)
        u.set(new Uint8Array(dt), o);
        ch.send(u);
        f.sent += cs; state.outgoingFiles.set(connId, f);
        const p = Math.round((f.sent / fileSize) * 100);
        updateProgress(connId, p, f.sent / ((Date.now() - f.startTime) / 1000));
        setTimeout(() => sendBlock(connId), 0);
    };
    r.onerror = () => xferFailed(connId);
    r.readAsArrayBuffer(file.slice(sent, sent + cs));
}

function sendEnd(connId, f) {
    // END = [0x04][MD5(16)] to match handleBinary's type-byte-aware parsing
    const buf = new Uint8Array(17);
    buf[0] = PROTO.END;
    const mh = (f.fileHash || '').padEnd(32, '0').slice(0, 32);
    for (let i = 0; i < 16; i++) buf[i + 1] = parseInt(mh.substr(i * 2, 2), 16);
    const ch = state.dataChannels.get(connId);
    if (ch?.readyState === 'open') ch.send(buf);
    completeXfer(connId, true);
}

// ============================================
// Receiving
// ============================================
function handleFileOffer(msg) {
    const { from, connId, payload } = msg;
    // payload might be a JSON string if sent via json.RawMessage in Go
    let p = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const v2h = typeof p.v2head === 'string' ? JSON.parse(p.v2head) : p.v2head;
    showPendingDlg(connId, { fileName: v2h.filename, fileSize: v2h.fsize, totalBlocks: v2h.blocks, fileHash: v2h.MD5, fromDeviceId: from, fromDeviceName: state.devices.get(from)?.payload || '未知设备' });
}

function showPendingDlg(connId, info) {
    const m = document.getElementById('pendingModal');
    document.getElementById('modalFileName').textContent = info.fileName;
    document.getElementById('modalFileSize').textContent = formatBytes(info.fileSize);
    document.getElementById('modalFileFrom').textContent = info.fromDeviceName;
    m.hidden = false;
    let t = PENDING_TIMEOUT;
    const te = document.getElementById('modalTimer');
    te.textContent = t; te.classList.remove('warning');
    const ti = setInterval(() => { t--; te.textContent = t; if (t <= 10) te.classList.add('warning'); if (t <= 0) { clearInterval(ti); hideDlg(); rejectOffer(connId, info.fromDeviceId); } }, 1000);
    const pending = { ...info, timer: ti, accept: () => { clearInterval(ti); hideDlg(); acceptOffer(connId, info); }, reject: () => { clearInterval(ti); hideDlg(); rejectOffer(connId, info.fromDeviceId); } };
    state.pendingOffers.set(connId, pending);
    document.getElementById('acceptBtn').onclick = pending.accept;
    document.getElementById('rejectBtn').onclick = pending.reject;
}

function hideDlg() { document.getElementById('pendingModal').hidden = true; }

function acceptOffer(connId, info) {
    send({ type: MSG.FILE_ACCEPT, from: state.deviceId, to: info.fromDeviceId, connId, payload: {} });
    addTransferUI(connId, { name: info.fileName, size: info.fileSize, direction: 'incoming', deviceName: info.fromDeviceName });
    state.incomingChannels.set(connId, { fileName: info.fileName, fileSize: info.fileSize, totalBlocks: info.totalBlocks, expectedHash: info.fileHash, received: 0, blocks: new Map(), startTime: Date.now() });
    state.pendingOffers.delete(connId);
}

function rejectOffer(connId, fromId) { send({ type: MSG.FILE_REJECT, from: state.deviceId, to: fromId, connId, payload: {} }); state.pendingOffers.delete(connId); }

function handleFileAccept(msg) {
    const { connId } = msg;
    console.log('[handleFileAccept] 已收到 file_accept, connId=', connId, 'dcReady=', state.dcReady.get(connId));
    // 标记已接受，DC open 后才能发数据
    state.transferAccepted.set(connId, true);
    // 等 DC open 后才发数据（dc.onopen 会检查 transferAccepted）
    if (state.dcReady.get(connId)) {
        const ch = state.dataChannels.get(connId);
        if (ch && ch.readyState === 'open' && !state.v2HeadSent.get(connId)) {
            const f = state.outgoingFiles.get(connId);
            if (f) {
                console.log('[handleFileAccept] DC 已就绪，立即发送 V2Head, connId=', connId);
                sendV2Head(connId, f);
            }
        }
    }
    // 若 DC 尚未 open，dc.onopen 会处理（见 dc.onopen 中的检查逻辑）
}

function handleFileReject(msg) {
    const pc = state.peerConnections.get(msg.connId);
    if (pc) { pc.close(); state.peerConnections.delete(msg.connId); }
    state.dataChannels.delete(msg.connId);
    state.outgoingFiles.delete(msg.connId);
    state.dcReady.delete(msg.connId);
    state.v2HeadSent.delete(msg.connId);
    state.transferAccepted.delete(msg.connId);
    removeTransferUI(msg.connId);
    addHist({ name: '未知文件', direction: 'outgoing', status: 'rejected' });
}

function handleFileCancel(msg) {
    cleanup(msg.connId);
    removeTransferUI(msg.connId);
    const name = state.incomingChannels.get(msg.connId)?.fileName || '未知文件';
    state.incomingChannels.delete(msg.connId);
    state.receiveBuffers.delete(msg.connId);
    addHist({ name, direction: 'incoming', status: 'cancelled' });
}

function handleBinary(connId, buf) {
    const u = new Uint8Array(buf);
    console.log('[handleBinary] connId=', connId, 'len=', buf.byteLength, 'hex=', buf.byteLength <= 32 ? Array.from(u).map(b => b.toString(16).padStart(2,'0')).join(' ') : 'too long to show', 'has receiveBuffers=', state.receiveBuffers.has(connId));
    try {
    // V2Head has NO type byte; first 4 bytes = nameLen (big-endian uint32).
    // nameLen is always >= 1 and filename[0] is never 0x00 for text filenames.
    // BLOCK starts with 0x01, END with 0x04 — strip type byte for those.
    // V2Head starts with nameLen which has u[0]=0x00 for filenames < 256 chars.
    if (u[0] === 0x00) {
        // V2Head: no type byte, pass full buffer
        recvV2Head(connId, u);
    } else if (u[0] === PROTO.BLOCK) {
        recvBlock(connId, u.slice(1));
    } else if (u[0] === PROTO.END) {
        recvEnd(connId, u.slice(1));
    } else {
        console.warn('[handleBinary] unknown type 0x' + u[0].toString(16), 'len=' + buf.byteLength);
    }
    } catch(e) {
        console.error('[handleBinary] error:', e.message);
    }
}

function recvV2Head(connId, d) {
    console.log('[recvV2Head] connId=', connId, 'd.len=', d.length, 'd.byteOffset=', d.byteOffset, 'd.buffer.byteLength=', d.buffer.byteLength);
    try {
        // CRC32 校验（header 长度 = 总长度 - 4 字节 CRC）
        const dataLen = d.length - 4;
        const recvCrc = new DataView(d.buffer, d.byteOffset + dataLen, 4).getUint32(0, false);
        const calcCrc = crc32c(d.buffer.slice(d.byteOffset, d.byteOffset + dataLen));
        console.log('[recvV2Head] recvCrc=', recvCrc, 'calcCrc=', calcCrc);
        if (recvCrc !== calcCrc) {
            console.error('[recvV2Head] CRC 校验失败！recvCrc=', recvCrc, 'calcCrc=', calcCrc, '数据在传输中损坏');
            return;
        }
        console.log('[recvV2Head] CRC 校验通过');

        const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
        let o = 0;
        const nl = v.getUint32(o, false); o += 4;
        console.log('[recvV2Head] nameLen=', nl, 'buffer剩余=', d.length - o);
        if (nl > 1000 || nl > dataLen) { console.error('[recvV2Head] nameLen 异常:', nl); return; }
        const fn = new TextDecoder().decode(d.slice(o, o + nl)); o += nl;
        console.log('[recvV2Head] fileName=', fn, 'buffer剩余=', dataLen - o);
        // 打印 fileSize 位置的 8 个原始字节
        const fsBytes = Array.from(d.slice(o, o + 8)).map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log('[recvV2Head] fileSize bytes at offset', o, ':', fsBytes);
        // 注意：sendV2Head 写的是 hi(0) 在 offset 31，lo 在 offset 35
        // 所以 fsLo（高32位）要从 offset 35 读，fsHi（低32位）要从 offset 31 读
        const fsHi = v.getUint32(o, false);       // offset 31 → hi (0)
        const fsLo = v.getUint32(o + 4, false);  // offset 35 → lo (14484155)
        console.log('[recvV2Head] fsHi=', fsHi, '(bytes', o, '-', o+3, ') fsLo=', fsLo, '(bytes', o+4, '-', o+7, ')');
        const fs = fsLo + fsHi * 0x100000000; o += 8;
        const bl = v.getUint32(o, false); o += 4;
        const mh = Array.from(d.slice(o, o + 16)).map(b => b.toString(16).padStart(2, '0')).join('');
        // 校验：fileSize 上限 10GB，totalBlocks 上限 100000
        if (fs > 10 * 1024 * 1024 * 1024 || bl > 100000) {
            console.error('[recvV2Head] 文件信息异常，拒绝接收: fileSize=', fs, 'totalBlocks=', bl);
            state.dataChannels.get(connId)?.close();
            return;
        }
        console.log('[recvV2Head] parsed: fileSize=', fs, 'totalBlocks=', bl, 'MD5=', mh.substring(0, 8) + '...');
        if (!state.receiveBuffers.has(connId)) state.receiveBuffers.set(connId, { fileName: fn, fileSize: fs, totalBlocks: bl, expectedHash: mh, received: 0, blocks: new Map(), startTime: Date.now() });
    } catch(e) {
        console.error('[recvV2Head] parse error:', e.message, 'buffer:', d);
    }
}

function recvBlock(connId, d) {
    const r = state.receiveBuffers.get(connId);
    if (!r) return;
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    let o = 0;
    const idx = v.getUint32(o, false); o += 4;
    const sz = v.getUint32(o, false); o += 4;
    const crc = v.getUint32(o, false); o += 4;
    const bd = d.slice(o, o + sz);
    if (crc32c(bd) !== crc) { state.receiveBuffers.delete(connId); xferFailed(connId); return; }
    r.blocks.set(idx, bd);
    r.received += sz;
    const p = Math.round((r.received / r.fileSize) * 100);
    updateProgress(connId, p, r.received / ((Date.now() - r.startTime) / 1000));
}

async function recvEnd(connId, d) {
    const r = state.receiveBuffers.get(connId);
    if (!r) return;
    const mh = Array.from(d.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join('');
    const total = new Uint8Array(r.fileSize);
    let off = 0;
    for (let i = 0; i < r.totalBlocks; i++) { const b = r.blocks.get(i); if (b) { total.set(b, off); off += b.length; } }
    const calc = md5Hex(total.buffer);
    if (calc === mh || calc === r.expectedHash) {
        downloadBlob(new Blob([total]), r.fileName);
        completeXfer(connId, true);
        addHist({ name: r.fileName, direction: 'incoming', status: 'complete' });
    } else { xferFailed(connId); addHist({ name: r.fileName, direction: 'incoming', status: 'failed' }); }
    state.receiveBuffers.delete(connId);
    state.incomingChannels.delete(connId);
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
function addTransferUI(connId, info) {
    const list = document.getElementById('activeTransfers');
    const emp = list.querySelector('.transfer-empty');
    if (emp) emp.remove();
    const el = document.createElement('div');
    el.className = 'transfer-item';
    el.id = `tx-${connId}`;
    el.innerHTML = `<div class="transfer-item-header"><span class="transfer-icon">${getFileIcon(info.name)}</span><div class="transfer-info"><div class="transfer-name text-ellipsis">${info.name}</div><div class="transfer-meta"><span class="transfer-direction ${info.direction}">${info.direction === 'outgoing' ? '→' : '←'} ${info.deviceName}</span><span>${formatBytes(info.size)}</span></div></div></div><div class="transfer-progress-bar"><div class="transfer-progress-fill" id="pr-${connId}" style="width:0%"></div></div><div class="transfer-footer"><span class="transfer-progress-text" id="pt-${connId}">0%</span><span class="transfer-speed" id="sp-${connId}">0 B/s</span></div>`;
    list.appendChild(el);
    state.activeTransfers.set(connId, info);
}

function updateProgress(connId, pct, speed) {
    const pr = document.getElementById(`pr-${connId}`);
    const pt = document.getElementById(`pt-${connId}`);
    const sp = document.getElementById(`sp-${connId}`);
    if (pr) pr.style.width = `${pct}%`;
    if (pt) pt.textContent = `${pct}%`;
    if (sp) sp.textContent = formatSpeed(speed);
}

function completeXfer(connId, ok) {
    const pr = document.getElementById(`pr-${connId}`);
    if (pr) { pr.classList.add('complete'); pr.style.width = '100%'; }
    const pt = document.getElementById(`pt-${connId}`);
    if (pt) pt.textContent = ok ? '完成' : '失败';
    const info = state.activeTransfers.get(connId);
    if (info) addHist({ name: info.name, direction: info.direction, status: ok ? 'complete' : 'failed' });
    setTimeout(() => removeTransferUI(connId), 3000);
}

function xferFailed(connId) {
    const pc = state.peerConnections.get(connId);
    const dc = state.dataChannels.get(connId);
    console.log('[xferFailed]', connId);
    console.log('  PCs=', Array.from(state.peerConnections.keys()));
    console.log('  DCs=', Array.from(state.dataChannels.keys()));
    console.log('  PC.iceConnectionState=', pc?.iceConnectionState, 'PC.connectionState=', pc?.connectionState);
    console.log('  DC.readyState=', dc?.readyState);
    console.trace('[xferFailed] stack trace');
    const pt = document.getElementById(`pt-${connId}`);
    if (pt) pt.textContent = '失败';
    const info = state.activeTransfers.get(connId);
    if (info) addHist({ name: info.name, direction: info.direction, status: 'failed' });
    setTimeout(() => removeTransferUI(connId), 3000);
}

function removeTransferUI(connId) {
    const el = document.getElementById(`tx-${connId}`);
    if (el) el.remove();
    state.activeTransfers.delete(connId);
    state.peerConnections.delete(connId);
    state.dataChannels.delete(connId);
    state.outgoingFiles.delete(connId);
    state.dcReady.delete(connId);
    state.v2HeadSent.delete(connId);
    state.transferAccepted.delete(connId);
    if (state.activeTransfers.size === 0) document.getElementById('activeTransfers').innerHTML = '<div class="transfer-empty">暂无传输任务</div>';
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
    list.innerHTML = state.transferHistory.map(h => `<div class="history-item"><span class="transfer-icon">${getFileIcon(h.name)}</span><div class="transfer-info" style="flex:1"><div class="transfer-name text-ellipsis">${h.name}</div><div class="transfer-meta"><span>${h.direction === 'outgoing' ? '→' : '←'}</span><span>${formatTime(h.time)}</span></div></div><span class="history-status ${h.status}">${h.status === 'complete' ? '✓ 完成' : h.status === 'failed' ? '✗ 失败' : h.status === 'rejected' ? '✗ 已拒绝' : '✗ ' + h.status}</span></div>`).join('');
}

function renderDevices() {
    const list = document.getElementById('devicesList');
    if (state.devices.size === 0) { list.innerHTML = '<div class="devices-empty">正在搜索设备...</div>'; return; }
    list.innerHTML = Array.from(state.devices.entries())
        .filter(([id]) => id !== state.deviceId) // don't show self in the peer list
        .map(([id, d]) => `<div class="device-item ${state.selectedDeviceId === id ? 'selected' : ''}" data-id="${id}"><span class="device-icon">${getDeviceIcon(d.payload)}</span><div class="device-info"><div class="device-name-text">${d.payload || '未知设备'}</div><div class="device-status"><span class="status-dot online"></span><span>在线</span></div></div></div>`).join('');
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
    c.innerHTML = state.selectedFiles.map((f, i) => `<div class="file-item"><span class="file-item-icon">${getFileIcon(f.name)}</span><span class="file-item-name" title="${f.name}">${f.name}</span><span class="file-item-size">${formatBytes(f.size)}</span><button class="file-item-remove" data-i="${i}">✕</button></div>`).join('');
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
