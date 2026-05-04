/**
 * NEXUS v2 — Production Server
 * Cross-platform local device ecosystem
 * No internet required. No external platforms.
 */

'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const qrcode = require('qrcode');
const crypto = require('crypto');

// ─── Paths ────────────────────────────────────────────────────────────────────
const ROOT_DIR = path.join(__dirname, '..');
const UPLOAD_DIR = path.join(ROOT_DIR, 'uploads');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');

[UPLOAD_DIR, DATA_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 7523;
const DISCOVERY_PORT = 7524;
const TURN_PORT = 3478;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB
const FILE_EXPIRY_MS = 48 * 60 * 60 * 1000;    // 48h
const PIN_FILE = path.join(DATA_DIR, 'pairing.json');

// ─── Embedded TURN Server credentials ─────────────────────────────────────────
const TURN_USER   = 'nexus';
const TURN_PASS   = crypto.randomBytes(12).toString('hex'); // random per-session
let turnRunning   = false;

// ─── Pairing PIN ──────────────────────────────────────────────────────────────
let pairingData = { pin: null, enabled: false };
if (fs.existsSync(PIN_FILE)) {
  try { pairingData = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')); } catch {}
}

function savePin() {
  fs.writeFileSync(PIN_FILE, JSON.stringify(pairingData), 'utf8');
}

function generatePin() {
  pairingData.pin = Math.floor(100000 + Math.random() * 900000).toString();
  pairingData.enabled = true;
  savePin();
  return pairingData.pin;
}

// ─── Embedded TURN Server ─────────────────────────────────────────────────────
// Provides ICE relay so Android ↔ Web screen share works on plain HTTP.
// Chrome generates mDNS (.local) host candidates on non-secure origins which
// Android WebRTC cannot resolve. By using the embedded TURN as relay both
// sides always have a routable candidate through the server's LAN IP.
function startTurnServer() {
  try {
    const TurnServer = require('node-turn');
    const ips = getLocalIPs();
    const listenIp = '0.0.0.0';
    const externalIp = ips[0] || '127.0.0.1';

    const turn = new TurnServer({
      listeningPort:  TURN_PORT,
      listeningIps:   [listenIp],
      relayIps:       [externalIp],
      externalIps:    { [listenIp]: externalIp },
      authMech:       'long-term',
      credentials:    { [TURN_USER]: TURN_PASS },
      realm:          'nexus.local',
      debug:          false,
      maxAllocateLifetime: 3600,
      defaultLifetime:     600,
    });

    turn.start();
    turnRunning = true;
    console.log(`[TURN] Embedded TURN relay on :${TURN_PORT} (${externalIp}) — screen share works on HTTP`);
  } catch (e) {
    console.warn('[TURN] Could not start embedded TURN server (non-fatal):', e.message);
    turnRunning = false;
  }
}

// ─── Express + HTTP/HTTPS ────────────────────────────────────────────────────
const app = express();

// Optional HTTPS: place cert.pem and key.pem in the project root to enable.
// Generate self-signed: openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=nexus-local"
// With HTTPS, ALL devices (not just localhost) can use screen share and voice.
let server;
// TLS cert lookup order:
//   1. cert.pem + key.pem  (user-provided, placed in project root)
//   2. nexus-cert.pem + nexus-key.pem (auto-generated self-signed, created on first run)
//   3. Any *.pem / *-key.pem pair in project root (legacy support — previously hardcoded IP filenames)
//   4. Plain HTTP fallback (TURN relay compensates for screen share ICE on HTTP)
function findTlsFiles() {
  // Priority 1: standard names
  const standard = [
    { cert: path.join(ROOT_DIR, 'cert.pem'),       key: path.join(ROOT_DIR, 'key.pem') },
    { cert: path.join(ROOT_DIR, 'nexus-cert.pem'), key: path.join(ROOT_DIR, 'nexus-key.pem') },
  ];
  for (const p of standard) {
    if (fs.existsSync(p.cert) && fs.existsSync(p.key)) return p;
  }
  // Priority 2: any *.pem / *-key.pem pair (legacy hardcoded-IP filenames)
  try {
    const pemFiles = fs.readdirSync(ROOT_DIR).filter(f => f.endsWith('.pem') && !f.endsWith('-key.pem'));
    for (const certFile of pemFiles) {
      const keyFile = certFile.replace('.pem', '-key.pem');
      if (fs.existsSync(path.join(ROOT_DIR, keyFile))) {
        return { cert: path.join(ROOT_DIR, certFile), key: path.join(ROOT_DIR, keyFile) };
      }
    }
  } catch (_) {}
  return null;
}

function tryAutoGenerateCert() {
  const certOut = path.join(ROOT_DIR, 'nexus-cert.pem');
  const keyOut  = path.join(ROOT_DIR, 'nexus-key.pem');
  if (fs.existsSync(certOut) && fs.existsSync(keyOut)) return { cert: certOut, key: keyOut };
  try {
    const { execSync } = require('child_process');
    const ips = getLocalIPs();
    const san = ['localhost', '127.0.0.1', ...ips]
      .map((v, i) => v.match(/^\d/) ? `IP:${v}` : `DNS:${v}`)
      .join(',');
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyOut}" -out "${certOut}" ` +
      `-days 825 -nodes -subj "/CN=nexus-local" ` +
      `-addext "subjectAltName=${san}" 2>/dev/null`,
      { stdio: 'pipe', timeout: 15000 }
    );
    console.log(`[TLS] Auto-generated self-signed cert (valid for: ${['localhost', ...ips].join(', ')})`);
    console.log('[TLS] Accept the cert in your browser once, or install it as a trusted CA for best experience.');
    return { cert: certOut, key: keyOut };
  } catch (e) {
    return null;
  }
}

let tlsFiles = findTlsFiles() || tryAutoGenerateCert();
if (tlsFiles) {
  try {
    const https = require('https');
    const tlsOptions = {
      cert: fs.readFileSync(tlsFiles.cert),
      key:  fs.readFileSync(tlsFiles.key),
    };
    server = https.createServer(tlsOptions, app);
    console.log('[TLS] HTTPS enabled — screen share & voice will work on all devices (no TURN needed)');
  } catch (e) {
    console.warn('[TLS] Failed to start HTTPS:', e.message, '— falling back to HTTP');
    tlsFiles = null;
    server = http.createServer(app);
  }
}
if (!tlsFiles) {
  server = http.createServer(app);
  console.log('[HTTP] Running plain HTTP. Embedded TURN relay compensates for screen share ICE.');
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(PUBLIC_DIR));

// Serve root-level PWA files that live outside the public/ directory
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(ROOT_DIR, 'manifest.json'));
});
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(ROOT_DIR, 'sw.js'));
});

// CORS for local network
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Device-ID, X-Pin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── File Upload ──────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\-\u0600-\u06FF]/g, '_');
    cb(null, `${Date.now()}_${uuidv4().slice(0, 8)}_${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE }
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, perMessageDeflate: false });

// ─── State ────────────────────────────────────────────────────────────────────
const devices     = new Map();     // deviceId -> { ws, info, lastSeen, trusted }
const fileRegistry = new Map();    // fileId -> fileInfo
const msgHistory   = [];           // last 500 messages (server-side log)
const clipboard    = { content: '', type: 'text', from: null, ts: 0 };

// Transfer speed tracking
const transferStats = new Map();   // deviceId -> { sent, received, speed }

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getLocalIPs() {
  const result = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const addr of ifaces) {
      if (addr.family === 'IPv4' && !addr.internal) result.push(addr.address);
    }
  }
  return result;
}

// Start TURN now that getLocalIPs is defined
startTurnServer();

function broadcast(msg, excludeId = null) {
  const data = JSON.stringify(msg);
  for (const [id, d] of devices) {
    if (id !== excludeId && d.ws.readyState === WebSocket.OPEN) {
      d.ws.send(data);
    }
  }
}

function sendTo(deviceId, msg) {
  const d = devices.get(deviceId);
  if (d?.ws.readyState === WebSocket.OPEN) {
    d.ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function deviceList() {
  return Array.from(devices.values()).map(d => ({
    id: d.info.id,
    name: d.info.name,
    platform: d.info.platform,
    type: d.info.type,
    battery: d.info.battery || null,
    online: true,
    lastSeen: d.lastSeen,
    ip: d.info.ip
  }));
}

function verifyPin(pin) {
  if (!pairingData.enabled) return true; // no PIN set = open
  return pin === pairingData.pin;
}

// ─── WebSocket Handler ────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  let deviceId = null;
  const remoteIP = (req.socket.remoteAddress || '').replace('::ffff:', '');
  let pingTimer = null;

  // Keep-alive ping
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'REGISTER': {
        // PIN check
        if (pairingData.enabled && !verifyPin(msg.pin)) {
          ws.send(JSON.stringify({ type: 'AUTH_FAILED', reason: 'Invalid PIN' }));
          ws.close();
          return;
        }

        deviceId = msg.deviceId || uuidv4();
        const info = {
          id: deviceId,
          name: (msg.name || `Device-${deviceId.slice(0,6)}`).slice(0, 48),
          platform: msg.platform || 'unknown',
          type: msg.deviceType || 'desktop',
          battery: msg.battery || null,
          ip: remoteIP,
          userAgent: (msg.userAgent || '').slice(0, 200)
        };
        devices.set(deviceId, { ws, info, lastSeen: Date.now(), trusted: true });

        // Restore file registry for reconnects
        const sharedFiles = Array.from(fileRegistry.values())
          .filter(f => fs.existsSync(f.path))
          .map(f => ({ id: f.id, name: f.name, size: f.size, mimeType: f.mimeType, from: f.from, fromName: f.fromName, downloadUrl: `/api/files/${f.id}`, timestamp: f.timestamp }));

        ws.send(JSON.stringify({
          type: 'REGISTERED',
          deviceId,
          devices: deviceList(),
          clipboard: clipboard.content ? clipboard : null,
          files: sharedFiles,
          serverName: os.hostname(),
          serverPlatform: os.platform()
        }));

        broadcast({ type: 'DEVICE_JOINED', device: info }, deviceId);
        console.log(`[+] ${info.name} (${info.platform}/${info.type}) from ${remoteIP}`);
        break;
      }

      case 'PING': {
        if (deviceId && devices.has(deviceId)) {
          devices.get(deviceId).lastSeen = Date.now();
          // Update battery if sent
          if (msg.battery !== undefined && devices.get(deviceId)) {
            devices.get(deviceId).info.battery = msg.battery;
          }
        }
        ws.send(JSON.stringify({ type: 'PONG', ts: Date.now(), devices: devices.size }));
        break;
      }

      case 'UPDATE_INFO': {
        if (deviceId && devices.has(deviceId)) {
          const d = devices.get(deviceId);
          if (msg.name) d.info.name = msg.name.slice(0, 48);
          if (msg.battery !== undefined) d.info.battery = msg.battery;
          broadcast({ type: 'DEVICE_UPDATED', device: { id: deviceId, name: d.info.name, battery: d.info.battery } });
        }
        break;
      }

      case 'CLIPBOARD_PUSH': {
        if (!deviceId) break;
        clipboard.content = (msg.content || '').slice(0, 1024 * 1024); // 1MB cap
        clipboard.type = msg.contentType || 'text';
        clipboard.from = deviceId;
        clipboard.fromName = devices.get(deviceId)?.info.name;
        clipboard.ts = Date.now();
        broadcast({
          type: 'CLIPBOARD_UPDATE',
          content: clipboard.content,
          contentType: clipboard.type,
          from: deviceId,
          fromName: clipboard.fromName,
          timestamp: clipboard.ts
        }, msg.to === 'all' ? deviceId : null);
        if (msg.to && msg.to !== 'all') sendTo(msg.to, { ...clipboard, type: 'CLIPBOARD_UPDATE' });
        break;
      }

      case 'SEND_TEXT': {
        if (!deviceId) break;
        const payload = {
          type: 'RECEIVE_TEXT',
          id: uuidv4(),
          content: (msg.content || '').slice(0, 50000),
          from: deviceId,
          fromName: devices.get(deviceId)?.info.name,
          timestamp: Date.now(),
          encrypted: msg.encrypted || false
        };
        msgHistory.push(payload);
        if (msgHistory.length > 500) msgHistory.shift();
        if (msg.to === 'all') broadcast(payload, deviceId);
        else sendTo(msg.to, payload);
        break;
      }

      case 'FILE_SENT': {
        if (!deviceId) break;
        const fi = fileRegistry.get(msg.fileId);
        if (!fi) break;
        const fPayload = {
          type: 'FILE_INCOMING',
          fileId: msg.fileId,
          name: fi.name,
          size: fi.size,
          mimeType: fi.mimeType,
          from: deviceId,
          fromName: devices.get(deviceId)?.info.name,
          downloadUrl: `/api/files/${msg.fileId}`,
          timestamp: Date.now(),
          checksum: fi.checksum
        };
        if (msg.to === 'all') broadcast(fPayload, deviceId);
        else sendTo(msg.to, fPayload);
        break;
      }

      // ── WebRTC signaling ──
      case 'SCREENSHARE_OFFER':
      case 'SCREENSHARE_ANSWER':
      case 'ICE_CANDIDATE':
      case 'SCREENSHARE_STOP':
      case 'REMOTE_CONTROL_REQUEST':
      case 'REMOTE_CONTROL_ACCEPT':
      case 'REMOTE_CONTROL_STOP':
      case 'VOICE_OFFER':
      case 'VOICE_ANSWER':
      case 'VOICE_ICE': {
        if (msg.to) {
          sendTo(msg.to, { ...msg, from: deviceId, fromName: devices.get(deviceId)?.info.name });
        }
        break;
      }

      case 'SEND_NOTIFICATION': {
        if (!deviceId) break;
        const np = {
          type: 'NOTIFICATION',
          id: uuidv4(),
          title: (msg.title || '').slice(0, 200),
          body: (msg.body || '').slice(0, 500),
          from: deviceId,
          fromName: devices.get(deviceId)?.info.name,
          timestamp: Date.now(),
          priority: msg.priority || 'normal'
        };
        if (msg.to === 'all') broadcast(np, deviceId);
        else sendTo(msg.to, np);
        break;
      }

      case 'REQUEST_FILE_LIST': {
        const files = Array.from(fileRegistry.values())
          .filter(f => fs.existsSync(f.path))
          .map(f => ({ id: f.id, name: f.name, size: f.size, mimeType: f.mimeType, from: f.from, fromName: f.fromName, downloadUrl: `/api/files/${f.id}`, timestamp: f.timestamp }));
        ws.send(JSON.stringify({ type: 'FILE_LIST', files }));
        break;
      }

      case 'GET_DEVICES': {
        ws.send(JSON.stringify({ type: 'DEVICE_LIST', devices: deviceList() }));
        break;
      }

      case 'DELETE_FILE': {
        const fi = fileRegistry.get(msg.fileId);
        if (fi && fi.from === deviceId) {
          try { fs.unlinkSync(fi.path); } catch {}
          fileRegistry.delete(msg.fileId);
          broadcast({ type: 'FILE_DELETED', fileId: msg.fileId });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (deviceId && devices.has(deviceId)) {
      const name = devices.get(deviceId).info.name;
      devices.delete(deviceId);
      broadcast({ type: 'DEVICE_LEFT', deviceId, name });
      console.log(`[-] ${name} disconnected`);
    }
  });

  ws.on('error', err => console.error('[WS Error]', err.message));
});

// Keep-alive interval
const keepAliveInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(keepAliveInterval));

// ─── REST API ─────────────────────────────────────────────────────────────────

// Upload
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  // Compute checksum (fast, streaming)
  let checksum = '';
  try {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(req.file.path);
    await new Promise((resolve, reject) => {
      stream.on('data', d => hash.update(d));
      stream.on('end', () => { checksum = hash.digest('hex'); resolve(); });
      stream.on('error', reject);
    });
  } catch {}

  const fileId = uuidv4();
  fileRegistry.set(fileId, {
    id: fileId,
    path: req.file.path,
    name: req.file.originalname,
    size: req.file.size,
    mimeType: req.file.mimetype,
    from: req.body.deviceId || 'unknown',
    fromName: req.body.deviceName || 'Unknown',
    timestamp: Date.now(),
    checksum
  });

  console.log(`[Upload] ${req.file.originalname} (${(req.file.size/1024/1024).toFixed(2)} MB) from ${req.body.deviceName || '?'}`);
  res.json({ fileId, name: req.file.originalname, size: req.file.size, checksum });
});

// Download
app.get('/api/files/:fileId', (req, res) => {
  const f = fileRegistry.get(req.params.fileId);
  if (!f) return res.status(404).json({ error: 'File not found' });
  if (!fs.existsSync(f.path)) {
    fileRegistry.delete(req.params.fileId);
    return res.status(410).json({ error: 'File expired' });
  }
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(f.name)}"`);
  res.setHeader('Content-Type', f.mimeType || 'application/octet-stream');
  res.setHeader('Content-Length', f.size);
  const stream = fs.createReadStream(f.path);
  stream.pipe(res);
});

// File list
app.get('/api/files', (req, res) => {
  const files = Array.from(fileRegistry.values())
    .filter(f => fs.existsSync(f.path))
    .map(f => ({ id: f.id, name: f.name, size: f.size, mimeType: f.mimeType, from: f.from, fromName: f.fromName, downloadUrl: `/api/files/${f.id}`, timestamp: f.timestamp, checksum: f.checksum }))
    .sort((a, b) => b.timestamp - a.timestamp);
  res.json(files);
});

// Delete file
app.delete('/api/files/:fileId', (req, res) => {
  const f = fileRegistry.get(req.params.fileId);
  if (!f) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(f.path); } catch {}
  fileRegistry.delete(req.params.fileId);
  broadcast({ type: 'FILE_DELETED', fileId: req.params.fileId });
  res.json({ ok: true });
});

// ICE config — served to web & Android so they use the embedded TURN relay
app.get('/api/ice-config', (req, res) => {
  const ips = getLocalIPs();
  const serverIp = ips[0] || '127.0.0.1';
  const iceServers = [
    // Public STUN for gathering reflexive candidates
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];

  if (turnRunning) {
    // Embedded TURN — relay works even when mDNS host candidates fail
    iceServers.push(
      { urls: `turn:${serverIp}:${TURN_PORT}?transport=udp`, username: TURN_USER, credential: TURN_PASS },
      { urls: `turn:${serverIp}:${TURN_PORT}?transport=tcp`, username: TURN_USER, credential: TURN_PASS },
    );
  }

  res.json({ iceServers, turnRunning, serverIp });
});

// Server info + QR
app.get('/api/info', async (req, res) => {
  const ips = getLocalIPs();
  const primaryUrl = `${tlsFiles ? 'https' : 'http'}://${ips[0] || 'localhost'}:${PORT}`;
  let qr = null;
  try { qr = await qrcode.toDataURL(primaryUrl, { width: 300, margin: 2 }); } catch {}
  res.json({
    name: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    ips,
    port: PORT,
    primaryUrl,
    qr,
    uptime: process.uptime(),
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    devices: devices.size,
    files: fileRegistry.size,
    pinEnabled: pairingData.enabled,
    version: '2.0.0'
  });
});

// PIN management
app.post('/api/pin/generate', (req, res) => {
  const pin = generatePin();
  console.log(`[PIN] New pairing PIN generated: ${pin}`);
  res.json({ pin, enabled: true });
});

app.post('/api/pin/disable', (req, res) => {
  pairingData.pin = null;
  pairingData.enabled = false;
  savePin();
  res.json({ enabled: false });
});

app.get('/api/pin/status', (req, res) => {
  res.json({ enabled: pairingData.enabled });
});

// Stats
app.get('/api/stats', (req, res) => {
  const uploadSize = Array.from(fileRegistry.values()).reduce((a, f) => a + (f.size || 0), 0);
  res.json({
    devices: devices.size,
    files: fileRegistry.size,
    uploadBytes: uploadSize,
    uptime: process.uptime(),
    platform: os.platform(),
    hostname: os.hostname()
  });
});

// Devices list
app.get('/api/devices', (req, res) => res.json(deviceList()));

// Clipboard
app.get('/api/clipboard', (req, res) => res.json(clipboard));

// Health
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now(), devices: devices.size }));

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ─── UDP Discovery ────────────────────────────────────────────────────────────
function getDiscoveryPayload() {
  const ips = getLocalIPs();
  return JSON.stringify({
    type: 'NEXUS_ANNOUNCE',
    name: os.hostname(),
    platform: os.platform(),
    port: PORT,
    ips,
    wsUrl: `${tlsFiles ? 'wss' : 'ws'}://${ips[0] || '127.0.0.1'}:${PORT}`,
    version: '2.0.0',
    pinEnabled: pairingData.enabled
  });
}

const udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });

udpServer.on('error', err => {
  console.warn('[UDP] Discovery error (non-fatal):', err.message);
});

udpServer.on('message', (buf, rinfo) => {
  try {
    const data = JSON.parse(buf.toString());
    if (data.type === 'NEXUS_DISCOVER') {
      const resp = Buffer.from(getDiscoveryPayload());
      udpServer.send(resp, rinfo.port, rinfo.address);
    }
  } catch {}
});

try {
  udpServer.bind(DISCOVERY_PORT, '0.0.0.0', () => {
    console.log(`[UDP] Discovery on :${DISCOVERY_PORT}`);
  });
} catch (e) {
  console.warn('[UDP] Could not bind discovery port:', e.message);
}

// Periodic broadcast
function broadcastPresence() {
  try {
    const buf = Buffer.from(getDiscoveryPayload());
    const sock = dgram.createSocket({ type: 'udp4' });
    sock.bind(() => {
      try {
        sock.setBroadcast(true);
        sock.send(buf, DISCOVERY_PORT, '255.255.255.255', () => {
          try { sock.close(); } catch {}
        });
      } catch { try { sock.close(); } catch {} }
    });
  } catch {}
}
setInterval(broadcastPresence, 10000);

// ─── Cleanup ──────────────────────────────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - FILE_EXPIRY_MS;
  let removed = 0;
  for (const [id, f] of fileRegistry) {
    if (f.timestamp < cutoff) {
      try { fs.unlinkSync(f.path); } catch {}
      fileRegistry.delete(id);
      removed++;
    }
  }
  if (removed > 0) console.log(`[Cleanup] Removed ${removed} expired files`);
}, 60 * 60 * 1000);

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  const proto = tlsFiles ? 'https' : 'http';
  const lines = [
    '',
    '╔══════════════════════════════════════════════════╗',
    '║         NEXUS v2 — Device Ecosystem              ║',
    '╠══════════════════════════════════════════════════╣',
    `║  Server  : ${proto}://localhost:${PORT}                 ║`,
    ...ips.map(ip => `║  Network : ${proto}://${ip.padEnd(15)}:${PORT}           ║`),
    `║  UDP     : :${DISCOVERY_PORT} (LAN discovery)                 ║`,
    '╠══════════════════════════════════════════════════╣',
    tlsFiles
      ? '║  HTTPS ✓ — screen share & voice on all devices   ║'
      : '║  HTTP + TURN ✓ — screen share works via relay    ║',
    '║  Open URL on any device on same WiFi/LAN         ║',
    '║  Android: scan QR code in the app                ║',
    '╚══════════════════════════════════════════════════╝',
    ''
  ];
  lines.forEach(l => console.log(l));
});

process.on('uncaughtException', err => console.error('[Uncaught]', err.message));
process.on('unhandledRejection', err => console.error('[Unhandled]', err));

module.exports = { app, server, wss };
