/**
 * NEXUS v2 — Production Client
 * Features: Device hub, file transfer (2GB), clipboard sync,
 *           WebRTC screen share, WebRTC voice calls, messages,
 *           PIN pairing, battery indicator, network discovery,
 *           auto-reconnect, service worker PWA support
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const S = {
  ws: null,
  deviceId: localStorage.getItem('nexus_did') || null,
  deviceName: localStorage.getItem('nexus_name') || null,
  deviceType: localStorage.getItem('nexus_type') || 'desktop',
  platform: localStorage.getItem('nexus_plat') || 'linux',
  connected: false,
  reconnectTimer: null,
  reconnectDelay: 2000,

  devices: new Map(),          // id → info
  files: [],
  clipboardHistory: [],
  messages: [],
  msgUnread: 0,
  pendingFiles: [],

  // Screen share
  rtcScreen: null,
  localStream: null,
  rtcScreenTarget: null,
  pendingScreenOffer: null,

  // Voice
  rtcVoice: null,
  localAudio: null,
  rtcVoiceTarget: null,
  pendingVoiceOffer: null,
  iceCandidateQueueScreen: [],   // buffer ICE for screen share until remote desc is set
  iceCandidateQueueVoice: [],    // buffer ICE for voice until remote desc is set
  voiceCallTimer: null,
  voiceStart: null,
  voiceMuted: false,
  voiceAnalyser: null,

  // Settings
  notifEnabled: localStorage.getItem('nexus_notif') !== 'false',
  autoDl: localStorage.getItem('nexus_autodl') === 'true',
  autoSync: true,

  // ICE configuration — fetched from server on connect (includes embedded TURN)
  iceServers: null,
};

// ─── Constants ────────────────────────────────────────────────────────────────
/** Maximum bitrate for screen share video track (bits/s). 6 Mbps is optimal for LAN 1080p. */
const SCREEN_BITRATE_BPS = 6_000_000;

/** Timeout (ms) before warning the user if screen share hasn't connected yet. */
const SCREEN_CONNECT_TIMEOUT_MS = 15_000;

// ─── Boot ──────────────────────────────────────────────────────────────────────
const BOOT_STEPS = [
  [10,  'Loading interface...'],
  [30,  'Checking network...'],
  [55,  'Scanning devices...'],
  [80,  'Initializing modules...'],
  [100, 'Ready'],
];

async function boot() {
  const fill = $id('boot-fill');
  const stat = $id('boot-status');
  for (const [pct, msg] of BOOT_STEPS) {
    await sleep(220);
    fill.style.width = pct + '%';
    stat.textContent = msg;
  }
  await sleep(350);
  $id('boot-screen').classList.add('fade-out');
  await sleep(500);
  $id('boot-screen').classList.add('hidden');

  if (S.deviceId && S.deviceName) {
    initApp();
  } else {
    // Check if server has PIN BEFORE showing setup screen
    try {
      const pinStatus = await fetch('/api/pin/status').then(r => r.json()).catch(() => ({ enabled: false }));
      if (pinStatus.enabled) {
        $id('pin-section').style.display = 'flex';
      }
    } catch {}
    show('setup-screen');
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────────
function initSetup() {
  $id('setup-name').value = guessDeviceName();

  $$('.dtype-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.dtype-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      S.deviceType = btn.dataset.type;
      S.platform = btn.dataset.platform;
    });
  });

  $id('setup-join').addEventListener('click', async () => {
    const name = $id('setup-name').value.trim();
    if (!name) { $id('setup-name').focus(); return; }

    // Check PIN requirement before allowing join
    const pinInput = $id('setup-pin');
    const pinSection = $id('pin-section');
    
    if (pinSection && pinSection.style.display !== 'none') {
      // PIN is required, check if provided
      const pin = (pinInput?.value || '').trim();
      if (!pin) {
        toast('PIN Required', 'Please enter the 6-digit PIN from the server device', 'warning');
        pinInput?.focus();
        return;
      }
    }

    S.deviceId = S.deviceId || genId();
    S.deviceName = name;
    S.platform = $$('.dtype-btn.active')[0]?.dataset.platform || S.platform;
    S.deviceType = $$('.dtype-btn.active')[0]?.dataset.type || S.deviceType;

    localStorage.setItem('nexus_did', S.deviceId);
    localStorage.setItem('nexus_name', name);
    localStorage.setItem('nexus_type', S.deviceType);
    localStorage.setItem('nexus_plat', S.platform);

    hide('setup-screen');
    initApp();
  });
}

// ─── App Init ─────────────────────────────────────────────────────────────────
let _appInitialized = false;
function initApp() {
  if (_appInitialized) return;
  _appInitialized = true;
  $id('app').classList.remove('hidden');
  $id('app').classList.add('active');
  renderSidebar();
  initTabs();
  initFiles();
  initClipboard();
  initScreenShare();
  initVoice();
  initMessages();
  initSettings();
  initQR();
  connectWS();

  // Battery API
  if (navigator.getBattery) {
    navigator.getBattery().then(bat => {
      sendBattery(bat);
      bat.addEventListener('levelchange', () => sendBattery(bat));
      bat.addEventListener('chargingchange', () => sendBattery(bat));
    });
  }

  // Register service worker for PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

function sendBattery(bat) {
  if (S.ws?.readyState === WebSocket.OPEN) {
    wsSend({ type: 'UPDATE_INFO', battery: Math.round(bat.level * 100) });
  }
}

function renderSidebar() {
  $id('sidebar-name').textContent = S.deviceName;
  $id('sidebar-avatar').textContent = S.deviceName.slice(0, 2).toUpperCase();
  $id('sidebar-platform').textContent = `${S.platform} · ${S.deviceType}`;
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
async function connectWS() {
  const dot = $id('conn-dot');
  dot.className = 'conn-dot connecting';

  // Fetch ICE config (includes embedded TURN relay) before opening WebSocket
  // This ensures createPeer() always has TURN credentials ready
  try {
    const r = await fetch('/api/ice-config');
    if (r.ok) {
      const cfg = await r.json();
      S.iceServers = cfg.iceServers;
      console.log('[ICE] Config fetched:', S.iceServers.length, 'servers, TURN:', cfg.turnRunning);
    }
  } catch (e) {
    console.warn('[ICE] Could not fetch ICE config, using defaults:', e.message);
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  S.ws = new WebSocket(`${proto}//${location.host}`);

  S.ws.addEventListener('open', () => {
    S.connected = true;
    dot.className = 'conn-dot connected';
    S.reconnectDelay = 2000;

    const pin = $id('setup-pin')?.value || '';
    wsSend({
      type: 'REGISTER',
      deviceId: S.deviceId,
      name: S.deviceName,
      platform: S.platform,
      deviceType: S.deviceType,
      userAgent: navigator.userAgent,
      pin
    });

    // Heartbeat
    clearInterval(S._hb);
    S._hb = setInterval(() => wsSend({ type: 'PING' }), 20000);
  });

  S.ws.addEventListener('message', e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleMsg(msg);
  });

  S.ws.addEventListener('close', () => {
    S.connected = false;
    dot.className = 'conn-dot';
    clearInterval(S._hb);
    clearTimeout(S.reconnectTimer);
    // Only auto-reconnect if app is active (not on setup/pin screen)
    if (_appInitialized && $id('app')?.classList.contains('active')) {
      S.reconnectTimer = setTimeout(() => connectWS(), S.reconnectDelay);
      S.reconnectDelay = Math.min(S.reconnectDelay * 1.5, 30000);
    }
  });

  S.ws.addEventListener('error', (err) => {
    if (!$id('app')?.classList.contains('active')) {
      // Still in setup, show error
      console.error('[WS Error during setup]', err);
    }
  });
}

function wsSend(obj) {
  if (S.ws?.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
}

// ─── WS Message Handler ───────────────────────────────────────────────────────
function handleMsg(msg) {
  switch (msg.type) {

    case 'REGISTERED': {
      S.devices.clear();
      msg.devices.forEach(d => { if (d.id !== S.deviceId) S.devices.set(d.id, d); });
      if (msg.files) {
        S.files = msg.files;
        renderFiles();
      }
      if (msg.clipboard?.content && S.autoSync) {
        addClipHistory({ content: msg.clipboard.content, fromName: 'Network', ts: msg.clipboard.ts });
      }
      renderDevices();
      updateSelects();
      if (S.notifEnabled) toast('Connected', `Welcome, ${S.deviceName}!`, 'success');
      loadServerInfo();
      break;
    }

    case 'AUTH_FAILED': {
      toast('Auth Failed', msg.reason || 'Invalid PIN — please try again', 'error');

      // Close the failed WebSocket cleanly
      clearInterval(S._hb);
      if (S.ws) { try { S.ws.close(); } catch {} S.ws = null; }
      S.connected = false;

      // Reset so initApp() / connectWS() can run again on next attempt
      _appInitialized = false;

      // Hide app, restore setup screen
      $id('app').classList.add('hidden');
      $id('app').classList.remove('active');
      $id('setup-screen').classList.remove('hidden');

      // Show PIN section and shake the input
      const ps = $id('pin-section');
      if (ps) ps.style.display = 'flex';

      const pinInput = $id('setup-pin');
      if (pinInput) {
        pinInput.value = '';
        pinInput.classList.add('shake');
        setTimeout(() => { pinInput.classList.remove('shake'); pinInput.focus(); }, 600);
      }
      $id('setup-name').value = S.deviceName || '';
      break;
    }

    case 'DEVICE_JOINED': {
      if (msg.device.id === S.deviceId) break;
      S.devices.set(msg.device.id, msg.device);
      renderDevices(); updateSelects();
      if (S.notifEnabled) toast('Device Joined', `${msg.device.name} is online`, 'info');
      break;
    }

    case 'DEVICE_LEFT': {
      S.devices.delete(msg.deviceId);
      renderDevices(); updateSelects();
      if (S.notifEnabled) toast('Device Left', `${msg.name || 'A device'} went offline`, 'warning');
      break;
    }

    case 'DEVICE_UPDATED': {
      const d = S.devices.get(msg.device.id);
      if (d) { Object.assign(d, msg.device); renderDevices(); }
      break;
    }

    case 'DEVICE_LIST': {
      S.devices.clear();
      msg.devices.forEach(d => { if (d.id !== S.deviceId) S.devices.set(d.id, d); });
      renderDevices(); updateSelects();
      break;
    }

    case 'CLIPBOARD_UPDATE': {
      addClipHistory({ content: msg.content, fromName: msg.fromName, ts: msg.timestamp });
      if (S.autoSync && $id('autosync-toggle').checked) {
        $id('clipboard-input').value = msg.content;
        updateCharCount();
        tryWriteClipboard(msg.content);
      }
      if (S.notifEnabled) toast('Clipboard', `${msg.fromName}: ${msg.content.slice(0, 50)}`, 'info');
      break;
    }

    case 'FILE_INCOMING': {
      const f = {
        id: msg.fileId, name: msg.name, size: msg.size, mimeType: msg.mimeType,
        from: msg.from, fromName: msg.fromName, downloadUrl: msg.downloadUrl,
        timestamp: msg.timestamp, incoming: true, checksum: msg.checksum
      };
      S.files.unshift(f);
      renderFiles(); updateFileBadge();
      if (S.notifEnabled) toast('File Received', `${msg.fromName}: ${msg.name} (${fmtBytes(msg.size)})`, 'success');
      if (S.autoDl) triggerDownload(f.downloadUrl, f.name);
      break;
    }

    case 'FILE_DELETED': {
      S.files = S.files.filter(f => f.id !== msg.fileId);
      renderFiles();
      break;
    }

    case 'RECEIVE_TEXT': {
      addMessage({ id: msg.id, content: msg.content, from: msg.from, fromName: msg.fromName, ts: msg.timestamp, out: false });
      if (!$id('tab-messages').classList.contains('active')) {
        S.msgUnread++;
        updateMsgBadge();
      }
      if (S.notifEnabled) toast('Message', `${msg.fromName}: ${msg.content.slice(0, 60)}`, 'info');
      break;
    }

    case 'NOTIFICATION': {
      if (S.notifEnabled) toast(msg.title, msg.body, 'info');
      break;
    }

    // ── WebRTC Screen ──
    case 'SCREENSHARE_OFFER': {
      handleScreenshareOffer(msg);
      break;
    }
    case 'SCREENSHARE_ANSWER': {
      handleScreenshareAnswer(msg);
      break;
    }
    case 'ICE_CANDIDATE': {
      handleIceCandidate(msg);
      break;
    }
    case 'SCREENSHARE_STOP': {
      stopRemoteStream();
      toast('Screen Share', 'Remote device stopped sharing', 'info');
      break;
    }

    // ── WebRTC Voice ──
    case 'VOICE_OFFER': {
      S.pendingVoiceOffer = { sdp: msg.sdp, from: msg.from, fromName: msg.fromName };
      $id('voice-from-name').textContent = msg.fromName;
      show('voice-request');
      break;
    }
    case 'VOICE_ANSWER': {
      if (S.rtcVoice) {
        const sdpObj = (typeof msg.sdp === 'object' && msg.sdp.type)
          ? msg.sdp
          : { type: 'answer', sdp: msg.sdp };
        S.rtcVoice.setRemoteDescription(new RTCSessionDescription(sdpObj))
          .then(() => flushIceQueue('voice'))
          .catch(err => {
            console.error('[Voice] Failed to set remote answer:', err);
            toast('Voice', 'Call connection failed', 'error');
          });
      }
      break;
    }
    case 'VOICE_ICE': {
      if (!msg.candidate) break;
      if (S.rtcVoice && S.rtcVoice.remoteDescription) {
        S.rtcVoice.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(err => {
          if (!err.message.includes('wrong state')) console.warn('[Voice ICE]', err.message);
        });
      } else {
        S.iceCandidateQueueVoice.push(msg.candidate);
      }
      break;
    }
    case 'REMOTE_CONTROL_REQUEST':
    case 'REMOTE_CONTROL_ACCEPT':
    case 'REMOTE_CONTROL_STOP': {
      // placeholder for future remote control feature
      break;
    }
  }
}

// ─── Devices ──────────────────────────────────────────────────────────────────
function renderDevices() {
  const grid = $id('devices-grid');
  const empty = $id('hub-empty');
  const devs = Array.from(S.devices.values());

  $id('device-count-badge').textContent = `${devs.length} online`;

  if (!devs.length) {
    grid.innerHTML = '';
    if (empty) { grid.appendChild(empty); empty.classList.remove('hidden'); }
    renderNetworkVisual([]);
    return;
  }
  if (empty) empty.classList.add('hidden');

  grid.innerHTML = devs.map(d => {
    const plat = (d.platform || '').toLowerCase();
    const avCls = plat.includes('android') ? 'av-android' : plat.includes('win') ? 'av-windows' : plat.includes('linux') ? 'av-linux' : plat.includes('mac') || plat.includes('ios') ? 'av-macos' : 'av-default';
    const bat = d.battery != null ? `<div class="battery-indicator">
      <div class="battery-bar"><div class="battery-fill ${d.battery < 20 ? 'low' : d.battery < 50 ? 'mid' : ''}" style="width:${d.battery}%"></div></div>
      ${d.battery}%
    </div>` : '';
    return `<div class="device-card">
      <div class="device-card-top">
        <div class="device-card-avatar ${avCls}">${esc(d.name).slice(0,2).toUpperCase()}</div>
        <div class="device-card-info">
          <div class="device-card-name">${esc(d.name)}</div>
          <div class="device-card-meta">
            <div class="device-card-status"><div class="online-dot"></div>${esc(d.platform)} · ${esc(d.type || 'device')}</div>
            ${bat}
          </div>
        </div>
      </div>
      <div class="device-card-actions">
        <button class="action-chip" onclick="quickAction('file','${d.id}')"><svg viewBox="0 0 12 12" fill="none"><path d="M2 2h5l2 2v6H2V2z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>Send File</button>
        <button class="action-chip" onclick="quickAction('clip','${d.id}')"><svg viewBox="0 0 12 12" fill="none"><rect x="1" y="1" width="7" height="10" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>Clipboard</button>
        <button class="action-chip" onclick="quickAction('screen','${d.id}')"><svg viewBox="0 0 12 12" fill="none"><rect x="1" y="2" width="10" height="7" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M4 10h4M6 9v1" stroke="currentColor" stroke-width="1.2"/></svg>Screen</button>
        <button class="action-chip" onclick="quickAction('voice','${d.id}')"><svg viewBox="0 0 12 12" fill="none"><path d="M11 8.5a1 1 0 01-1 1A9 9 0 011.5 1 1 1 0 012.5 0h2a1 1 0 011 1 5 5 0 00.2 1.3.9.9 0 01-.25 1L4.7 4.1a8 8 0 002.7 2.7l.8-.85a.9.9 0 011-.25c.42.135.86.2 1.3.2a1 1 0 011 1v2z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>Voice</button>
        <button class="action-chip" onclick="quickAction('msg','${d.id}','${esc(d.name)}')"><svg viewBox="0 0 12 12" fill="none"><path d="M1 2h10a.5.5 0 01.5.5v6a.5.5 0 01-.5.5H3l-2 2V2.5A.5.5 0 011 2z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>Message</button>
      </div>
    </div>`;
  }).join('');

  renderNetworkVisual(devs);
}

function renderNetworkVisual(devs) {
  const container = $id('nv-devices');
  container.innerHTML = '';
  const W = $id('network-visual').offsetWidth || 600;
  const H = 200;
  const cx = W / 2, cy = H / 2;
  const r = Math.min(W, H) * 0.35;

  devs.forEach((d, i) => {
    const angle = (i / Math.max(devs.length, 1)) * 2 * Math.PI - Math.PI / 2;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);

    // Line
    const dx = x - cx, dy = y - cy;
    const len = Math.sqrt(dx*dx + dy*dy);
    const ang = Math.atan2(dy, dx) * 180 / Math.PI;
    const line = document.createElement('div');
    line.className = 'nv-line';
    line.style.cssText = `width:${len}px;left:${cx}px;top:${cy}px;transform:rotate(${ang}deg)`;
    container.appendChild(line);

    // Node
    const plat = (d.platform || '').toLowerCase();
    const platCls = plat.includes('android') ? 'android' : plat.includes('win') ? 'windows' : plat.includes('linux') ? 'linux' : '';
    const node = document.createElement('div');
    node.className = 'nv-device-node';
    node.style.cssText = `left:${x}px;top:${y}px`;
    node.innerHTML = `<div class="nv-node-dot ${platCls}">${esc(d.name).slice(0,2).toUpperCase()}</div><div class="nv-node-label">${esc(d.name)}</div>`;
    node.addEventListener('click', () => { quickAction('msg', d.id, d.name); switchTab('messages'); });
    container.appendChild(node);
  });
}

function updateSelects() {
  const devs = Array.from(S.devices.values());
  const allOpt = '<option value="all">All Devices</option>';
  const opts = allOpt + devs.map(d => `<option value="${d.id}">${esc(d.name)} (${esc(d.platform)})</option>`).join('');
  ['file-target', 'clipboard-target', 'msg-target'].forEach(id => {
    if ($id(id)) $id(id).innerHTML = opts;
  });
  // Share target (screen + voice)
  const pickOpts = '<option value="">Select device...</option>' + devs.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  if ($id('share-target')) $id('share-target').innerHTML = pickOpts;
  if ($id('voice-target')) $id('voice-target').innerHTML = pickOpts;
}

window.quickAction = function(type, id, name) {
  switch (type) {
    case 'file':
      switchTab('files');
      setTimeout(() => { $id('file-target').value = id; $id('file-input').click(); }, 80);
      break;
    case 'clip':
      switchTab('clipboard');
      const c = $id('clipboard-input').value.trim();
      if (c) { wsSend({ type: 'CLIPBOARD_PUSH', content: c, contentType: 'text', to: id }); toast('Clipboard', 'Sent!', 'success'); }
      else toast('Clipboard', 'Type something in the clipboard tab first', 'info');
      break;
    case 'screen':
      switchTab('screen');
      setTimeout(() => { if ($id('share-target')) $id('share-target').value = id; }, 80);
      break;
    case 'voice':
      switchTab('voice');
      setTimeout(() => { if ($id('voice-target')) $id('voice-target').value = id; }, 80);
      break;
    case 'msg':
      switchTab('messages');
      if ($id('msg-target')) $id('msg-target').value = id;
      $id('msg-input').focus();
      break;
  }
};

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function initTabs() {
  $$('.nav-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
}

function switchTab(name) {
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-section').forEach(s => s.classList.toggle('active', s.id === `tab-${name}`));
  if (name === 'messages') {
    S.msgUnread = 0; updateMsgBadge();
  }
  // Close sidebar on mobile
  if (window.innerWidth < 768) closeMobileSidebar();
}

window.toggleMobileSidebar = function() {
  const sidebar = $id('sidebar');
  const overlay = $id('sidebar-overlay');
  const isOpen = sidebar.classList.toggle('open');
  overlay?.classList.toggle('visible', isOpen);
};
function closeMobileSidebar() {
  $id('sidebar').classList.remove('open');
  $id('sidebar-overlay')?.classList.remove('visible');
}

// ─── File Transfer ────────────────────────────────────────────────────────────
function initFiles() {
  const dz = $id('drop-zone');
  const fi = $id('file-input');

  dz.addEventListener('click', e => { if (e.target.tagName !== 'LABEL') fi.click(); });
  fi.addEventListener('change', () => { S.pendingFiles = Array.from(fi.files); updatePendingUI(); });

  ['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag-over'); }));
  ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag-over'); }));
  dz.addEventListener('drop', e => { S.pendingFiles = Array.from(e.dataTransfer.files); updatePendingUI(); });

  $id('send-files-btn').addEventListener('click', sendFiles);
  $id('clear-files-btn').addEventListener('click', () => {
    S.files = []; renderFiles(); updateFileBadge();
  });
}

function updatePendingUI() {
  const btn = $id('send-files-btn');
  if (S.pendingFiles.length > 0) {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none"><path d="M2 8l12-6-6 12-1.5-5.5L2 8z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg> Send ${S.pendingFiles.length} File${S.pendingFiles.length > 1 ? 's' : ''}`;
  } else {
    btn.disabled = true;
    btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none"><path d="M2 8l12-6-6 12-1.5-5.5L2 8z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg> Send Files`;
  }
}

async function sendFiles() {
  if (!S.pendingFiles.length) return;
  const target = $id('file-target').value;
  const prog = $id('upload-progress');
  const fill = $id('progress-fill');
  const txt = $id('progress-text');
  const spd = $id('progress-speed');

  prog.classList.remove('hidden');
  $id('send-files-btn').disabled = true;

  for (let i = 0; i < S.pendingFiles.length; i++) {
    const file = S.pendingFiles[i];
    txt.textContent = `Uploading: ${file.name} (${i+1}/${S.pendingFiles.length})`;

    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('deviceId', S.deviceId);
      fd.append('deviceName', S.deviceName);

      let lastLoaded = 0, lastTime = Date.now();
      const result = await new Promise((res, rej) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        xhr.upload.addEventListener('progress', e => {
          if (!e.lengthComputable) return;
          const pct = Math.round(e.loaded / e.total * 100);
          fill.style.width = pct + '%';
          const now = Date.now();
          const dt = (now - lastTime) / 1000;
          if (dt > 0.5) {
            const speed = (e.loaded - lastLoaded) / dt;
            spd.textContent = fmtBytes(speed) + '/s';
            lastLoaded = e.loaded; lastTime = now;
            showTransferOverlay(fmtBytes(speed) + '/s', file.name);
          }
          txt.textContent = `${file.name} — ${pct}%`;
        });
        xhr.addEventListener('load', () => {
          try { xhr.status === 200 ? res(JSON.parse(xhr.responseText)) : rej(new Error(`HTTP ${xhr.status}`)); }
          catch { rej(new Error('Parse error')); }
        });
        xhr.addEventListener('error', () => rej(new Error('Network error')));
        xhr.send(fd);
      });

      S.files.unshift({ id: result.fileId, name: file.name, size: file.size, mimeType: file.type, from: S.deviceId, fromName: 'You', downloadUrl: `/api/files/${result.fileId}`, timestamp: Date.now(), incoming: false });
      renderFiles(); updateFileBadge();
      wsSend({ type: 'FILE_SENT', fileId: result.fileId, to: target });
      toast('Sent', `${file.name} sent`, 'success');
      hideTransferOverlay();

    } catch (err) {
      toast('Upload Failed', `${file.name}: ${err.message}`, 'error');
    }
  }

  S.pendingFiles = []; updatePendingUI();
  prog.classList.add('hidden');
  fill.style.width = '0'; spd.textContent = '';
  $id('file-input').value = '';
}

function renderFiles() {
  const el = $id('files-items');
  if (!S.files.length) { el.innerHTML = '<div class="empty-sm">No files shared yet</div>'; return; }
  el.innerHTML = S.files.map(f => `
    <div class="file-item">
      <div class="file-icon">${fileIcon(f.mimeType)}</div>
      <div class="file-info">
        <div class="file-name">${esc(f.name)}</div>
        <div class="file-meta">${fmtBytes(f.size)} · from ${esc(f.fromName || 'You')} · ${timeAgo(f.timestamp)}</div>
      </div>
      ${f.incoming ? `<span class="file-badge">NEW</span>` : ''}
      <div class="file-actions">
        <a href="${f.downloadUrl}" download="${esc(f.name)}" class="btn-secondary" style="padding:7px 12px;font-size:12px">
          <svg viewBox="0 0 14 14" fill="none" style="width:12px;height:12px"><path d="M7 2v8M4 7l3 3 3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 11h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          Save
        </a>
        <button class="btn-icon" onclick="deleteFile('${f.id}')" title="Remove" style="width:28px;height:28px">
          <svg viewBox="0 0 14 14" fill="none" style="width:12px;height:12px"><path d="M2 4h10M5 4V3h4v1M5 6v5M9 6v5M3 4l.7 8h6.6l.7-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div>`).join('');
}

window.deleteFile = function(id) {
  wsSend({ type: 'DELETE_FILE', fileId: id });
  S.files = S.files.filter(f => f.id !== id);
  renderFiles(); updateFileBadge();
};

function updateFileBadge() {
  $id('files-count-badge').textContent = `${S.files.length} file${S.files.length !== 1 ? 's' : ''}`;
  const incoming = S.files.filter(f => f.incoming).length;
  const badge = $id('nav-badge-files');
  if (incoming > 0) { badge.textContent = incoming; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
}

function triggerDownload(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a);
  a.click(); document.body.removeChild(a);
}

// ─── Clipboard ────────────────────────────────────────────────────────────────
function initClipboard() {
  const inp = $id('clipboard-input');
  inp.addEventListener('input', updateCharCount);

  $id('paste-btn').addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      inp.value = t; updateCharCount();
    } catch { toast('Paste', 'Use Ctrl+V to paste', 'info'); }
  });

  $id('copy-clipboard-btn').addEventListener('click', () => {
    const v = inp.value;
    if (!v) return;
    tryWriteClipboard(v);
    toast('Copied', 'Copied to clipboard', 'success');
  });

  $id('sync-clipboard-btn').addEventListener('click', () => {
    const content = inp.value.trim();
    if (!content) { toast('Clipboard', 'Nothing to sync', 'warning'); return; }
    const to = $id('clipboard-target').value;
    wsSend({ type: 'CLIPBOARD_PUSH', content, contentType: 'text', to });
    addClipHistory({ content, fromName: 'You', ts: Date.now() });
    toast('Synced', `Sent to ${to === 'all' ? 'all devices' : S.devices.get(to)?.name || 'device'}`, 'success');
  });

  $id('clear-clipboard-btn').addEventListener('click', () => {
    S.clipboardHistory = []; renderClipHistory();
  });
}

function updateCharCount() {
  const n = $id('clipboard-input').value.length;
  $id('char-count').textContent = `${n.toLocaleString()} chars`;
}

function addClipHistory(item) {
  S.clipboardHistory.unshift(item);
  if (S.clipboardHistory.length > 100) S.clipboardHistory.pop();
  renderClipHistory();
}

function renderClipHistory() {
  const el = $id('history-items');
  if (!S.clipboardHistory.length) { el.innerHTML = '<div class="empty-sm">Nothing synced yet</div>'; return; }
  el.innerHTML = S.clipboardHistory.slice(0, 50).map((item, i) => `
    <div class="history-item" onclick="loadClip(${i})">
      <div style="flex:1;overflow:hidden">
        <div class="history-content">${esc(item.content)}</div>
        <div class="history-from" style="font-size:10px;color:var(--text3);margin-top:3px">${timeAgo(item.ts)}</div>
      </div>
      <span class="history-from">${esc(item.fromName || '?')}</span>
    </div>`).join('');
}

window.loadClip = function(i) {
  const item = S.clipboardHistory[i];
  if (!item) return;
  $id('clipboard-input').value = item.content;
  updateCharCount();
  tryWriteClipboard(item.content);
  toast('Loaded', 'Content loaded into box', 'success');
};

async function tryWriteClipboard(text) {
  try { await navigator.clipboard.writeText(text); } catch {}
}

// ─── Screen Share ──────────────────────────────────────────────────────────────
function isAndroidDevice() {
  return /Android/i.test(navigator.userAgent);
}

function initScreenShare() {
  // Android cannot share screen via getDisplayMedia — show info banner, disable share controls
  if (isAndroidDevice()) {
    show('android-share-banner');
    const startBtn = $id('start-share-btn');
    const shareTarget = $id('share-target');
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.title = 'Screen sharing is not supported on Android browsers';
    }
    if (shareTarget) shareTarget.disabled = true;
    // Update overlay text for Android
    const localOverlay = $id('local-overlay');
    if (localOverlay) {
      const p = localOverlay.querySelector('p');
      if (p) p.textContent = 'Not available on Android';
    }
  }

  $id('start-share-btn').addEventListener('click', startScreenShare);
  $id('stop-share-btn').addEventListener('click', stopScreenShare);
  $id('fullscreen-btn').addEventListener('click', () => {
    const v = $id('remote-preview');
    if (v.requestFullscreen) v.requestFullscreen();
    else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
  });
  $id('close-stream-btn').addEventListener('click', stopRemoteStream);
  $id('accept-screenshare').addEventListener('click', acceptScreenShare);
  $id('reject-screenshare').addEventListener('click', () => { hide('screenshare-request'); S.pendingScreenOffer = null; S._acceptingScreenShare = false; });

  // Show hint when audio toggle is turned on
  const audioToggle = $id('share-audio-toggle');
  const audioHint = $id('audio-share-hint');
  if (audioToggle && audioHint) {
    audioToggle.addEventListener('change', () => {
      if (audioToggle.checked) audioHint.classList.remove('hidden');
      else audioHint.classList.add('hidden');
    });
  }
}

async function startScreenShare() {
  const targetId = $id('share-target').value;
  if (!targetId) {
    toast('Screen Share', 'Select a target device first', 'warning');
    return;
  }

  // Android browser cannot use getDisplayMedia
  if (isAndroidDevice()) {
    toast('Screen Share', 'Use the Nexus Android app to share from Android', 'warning');
    show('android-share-banner');
    return;
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('Screen Share', 'Your browser does not support screen capture. Try Chrome or Firefox.', 'error');
    return;
  }

  if (!checkSecureContext()) {
    toast('Screen Share Unavailable', 'Screen sharing requires HTTPS or localhost.', 'error');
    showSecureContextBanner('screen');
    return;
  }

  // Clean up any stale state
  await _cleanupScreenSender();
  S.iceCandidateQueueScreen = [];

  const wantAudio = $id('share-audio-toggle')?.checked ?? false;

  try {
    setStatus('share-status', 'Capturing...', 'connecting');

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
        frameRate: { ideal: 30, max: 60 },
        width:  { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
      },
      audio: wantAudio ? {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
        sampleRate: 44100,
        channelCount: 2,
      } : false,
    });

    S.localStream = stream;
    const hasAudio = stream.getAudioTracks().length > 0;

    // Show local preview
    const localVid = $id('local-preview');
    if (localVid) {
      localVid.srcObject = stream;
      localVid.play().catch(() => {});
    }
    hide('local-overlay');
    setStatus('share-status', 'Connecting…', 'connecting');
    show('stop-share-btn'); hide('start-share-btn');

    if (hasAudio) {
      show('screen-audio-live');
    }

    // Wire mute button for shared audio
    _wireShareMuteButton();

    // ── Build PeerConnection ──────────────────────────────────────────────────
    S.rtcScreenTarget = targetId;
    S.rtcScreen = createPeer('screen');

    S.rtcScreen.onconnectionstatechange = () => {
      const st = S.rtcScreen?.connectionState;
      console.log('[Screen TX] Connection:', st);
      if (st === 'connected') {
        setStatus('share-status', 'Streaming ●', 'active');
        toast('Screen Share', 'Connected — streaming', 'success');
        // Apply bitrate encoding parameters now that we're connected
        _applyScreenEncodingParams(S.rtcScreen, hasAudio);
      } else if (st === 'failed') {
        toast('Screen Share', 'Connection failed — ensure both devices are on the same network', 'error');
        stopScreenShare();
      } else if (st === 'disconnected') {
        setStatus('share-status', 'Reconnecting…', 'connecting');
      }
    };

    // Add all tracks (video + optional audio)
    stream.getTracks().forEach(track => {
      S.rtcScreen.addTrack(track, stream);
      console.log('[Screen TX] Added track:', track.kind, track.label);
    });

    // Create offer — sender does NOT want to receive
    const offer = await S.rtcScreen.createOffer({
      offerToReceiveVideo: false,
      offerToReceiveAudio: false,
    });

    // Inject bandwidth hint into SDP so receiver knows ceiling immediately
    const mungedOffer = new RTCSessionDescription({
      type: offer.type,
      sdp: _injectBandwidth(offer.sdp, SCREEN_BITRATE_BPS / 1000),
    });

    await S.rtcScreen.setLocalDescription(mungedOffer);
    wsSend({ type: 'SCREENSHARE_OFFER', to: targetId, sdp: S.rtcScreen.localDescription });
    console.log('[Screen TX] Offer sent to', targetId);

    // Stop share if user ends browser capture
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      console.log('[Screen TX] Browser capture ended');
      stopScreenShare();
    });

    // Connection timeout
    setTimeout(() => {
      if (!S.rtcScreen || S.rtcScreen.connectionState === 'connected') return;
      toast('Screen Share', 'Taking too long to connect — check both devices are on the same Wi-Fi', 'warning');
    }, SCREEN_CONNECT_TIMEOUT_MS);

    toast('Screen Share', hasAudio ? 'Sharing screen + audio…' : 'Connecting to remote device…', 'info');

  } catch (err) {
    setStatus('share-status', 'Idle', '');
    if (err.name === 'NotAllowedError') {
      toast('Screen Share', 'Screen capture permission denied', 'warning');
    } else if (err.name === 'NotSupportedError') {
      toast('Screen Share', 'Screen capture not supported on this browser/OS', 'error');
    } else if (err.name !== 'AbortError') {
      console.error('[Screen TX] Start failed:', err);
      toast('Screen Share', err.message || 'Failed to start screen capture', 'error');
    }
    await _cleanupScreenSender();
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Start playing the remote video element.
 * Handles autoplay blocks gracefully by showing a tap-to-play overlay only
 * as a fallback — not as the primary mechanism.
 */
function _startRemotePlayback(vid, stream) {
  if (!vid || !stream) return;
  if (vid._nexusPlaying) return; // already playing
  vid._nexusPlaying = false;

  // Ensure srcObject is set
  if (vid.srcObject !== stream) vid.srcObject = stream;

  // We need muted=false for audio, but muted=true for autoplay policy.
  // Strategy: start muted, unmute once playing.
  vid.muted = true;

  vid.onplaying = () => {
    if (vid._nexusPlaying) return;
    vid._nexusPlaying = true;
    vid.muted = false; // unmute — user has "interacted" via play() or gesture
    const overlay = $id('remote-overlay');
    if (overlay) {
      overlay.classList.add('hidden');
      overlay.onclick = null;
    }
    setStatus('view-status', 'Streaming ●', 'active');
    show('close-stream-btn');
    console.log('[Screen RX] Video playing ✓');
  };

  vid.onstalled = () => {
    if (vid._nexusPlaying) {
      console.warn('[Screen RX] Video stalled — retrying play()');
      vid.play().catch(() => {});
    }
  };

  vid.play()
    .then(() => {
      console.log('[Screen RX] play() succeeded (autoplay allowed)');
    })
    .catch(err => {
      console.warn('[Screen RX] Autoplay blocked:', err.name, '— showing tap overlay');
      _showTapOverlay(vid);
    });
}

/**
 * Show a "tap to play" overlay — only used when autoplay is blocked.
 */
function _showTapOverlay(vid) {
  const overlay = $id('remote-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  overlay.style.cursor = 'pointer';
  overlay.innerHTML = `
    <svg viewBox="0 0 48 48" fill="none">
      <circle cx="24" cy="24" r="20" stroke="currentColor" stroke-width="2" opacity=".6" fill="none"/>
      <path d="M19 16l16 8-16 8V16z" fill="currentColor" opacity=".9"/>
    </svg>
    <p>Tap to play</p>`;
  overlay.onclick = () => {
    overlay.onclick = null;
    overlay.innerHTML = `<p>Starting…</p>`;
    vid.play()
      .then(() => { /* onplaying fires */ })
      .catch(err => {
        console.error('[Screen RX] play() failed after tap:', err);
        overlay.innerHTML = `<p>Tap again</p>`;
        overlay.onclick = () => {
          overlay.onclick = null;
          vid.play().catch(() => {});
        };
      });
  };
}

/**
 * Apply encoding bitrate parameters on the sender's PeerConnection.
 * Call AFTER connectionState === 'connected' — setParameters() fails if
 * called before the encoder is active.
 *
 * This is the primary fix for Web→Android lag:
 * Default WebRTC sender starts conservatively (~500kbps) and ramps over 30s.
 * On LAN we can jump straight to 4-6Mbps.
 */
async function _applyScreenEncodingParams(pc, hasAudio) {
  try {
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;

      const params = sender.getParameters();
      if (!params.encodings?.length) {
        params.encodings = [{}];
      }

      params.encodings[0].maxBitrate          = SCREEN_BITRATE_BPS;
      params.encodings[0].networkPriority      = 'high';
      params.encodings[0].priority             = 'high';
      // 'maintain-framerate' prevents Android from choosing bad quality/fps tradeoffs.
      // Without this, Android WebRTC may drop to 5fps on complex UI to hit bitrate cap.
      params.encodings[0].degradationPreference = 'maintain-framerate';

      await sender.setParameters(params);
      console.log('[Screen TX] Encoding params applied — maxBitrate:', SCREEN_BITRATE_BPS);
    }
  } catch (err) {
    // Non-fatal — connection still works, just at lower quality initially
    console.warn('[Screen TX] setParameters failed (non-fatal):', err.message);
  }
}

/**
 * Inject b=AS (session bitrate) into SDP video section.
 *
 * This is the most portable way to declare bandwidth across Chrome, Firefox,
 * Safari, and WebRTC Android. It signals the encoding budget immediately so
 * both sides can allocate buffers correctly before ICE completes.
 *
 * @param {string} sdp - SDP string to modify
 * @param {number} bitrateKbps - Max bitrate in kbps
 * @returns {string} Modified SDP
 */
function _injectBandwidth(sdp, bitrateKbps) {
  const lines = sdp.split('\r\n');
  const result = [];
  let inVideoSection = false;
  let bInjected = false;

  for (const line of lines) {
    result.push(line);

    if (line.startsWith('m=video')) {
      inVideoSection = true;
      bInjected = false;
    } else if (line.startsWith('m=') && !line.startsWith('m=video')) {
      inVideoSection = false;
    }

    // Insert bandwidth after the c= line in the video section
    if (inVideoSection && !bInjected && line.startsWith('c=')) {
      result.push(`b=AS:${bitrateKbps}`);
      result.push(`b=TIAS:${bitrateKbps * 1000}`);
      bInjected = true;
    }
  }

  return result.join('\r\n');
}

async function _cleanupScreenSender() {
  if (S.localStream) {
    S.localStream.getTracks().forEach(t => t.stop());
    S.localStream = null;
  }
  if (S.rtcScreen) {
    try { S.rtcScreen.close(); } catch {}
    S.rtcScreen = null;
  }
  S.rtcScreenTarget = null;
  S.iceCandidateQueueScreen = [];
}

function _wireShareMuteButton() {
  const btn = $id('share-mute-audio-btn');
  if (!btn) return;
  // Remove old listener by cloning (simpler than tracking AbortControllers)
  const newBtn = btn.cloneNode(true);
  btn.parentNode?.replaceChild(newBtn, btn);
  newBtn.addEventListener('click', () => {
    const audioTrack = S.localStream?.getAudioTracks()[0];
    if (!audioTrack) return;
    S.screenAudioMuted = !S.screenAudioMuted;
    audioTrack.enabled = !S.screenAudioMuted;
    newBtn.classList.toggle('muted', S.screenAudioMuted);
    const icon = $id('share-audio-icon');
    if (icon) icon.innerHTML = S.screenAudioMuted ? _audioIconSvgOff() : _audioIconSvgOn();
  });
}

function _audioIconSvgOn() {
  return `<path d="M2 5h3l4-3v12l-4-3H2V5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          <path d="M11 5.5a3.5 3.5 0 010 5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>`;
}

function _audioIconSvgOff() {
  return `<path d="M2 5h3l4-3v12l-4-3H2V5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          <line x1="14" y1="4" x2="4" y2="14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`;
}


function stopScreenShare() {
  if (S.localStream) {
    S.localStream.getTracks().forEach(t => t.stop());
    S.localStream = null;
  }
  if (S.rtcScreen) {
    if (S.rtcScreenTarget) {
      wsSend({ type: 'SCREENSHARE_STOP', to: S.rtcScreenTarget });
    }
    try { S.rtcScreen.close(); } catch {}
    S.rtcScreen = null;
  }
  S.iceCandidateQueueScreen = [];
  S.rtcScreenTarget = null;
  S.screenAudioMuted = false;

  const localVid = $id('local-preview');
  if (localVid) { localVid.srcObject = null; }
  show('local-overlay');
  setStatus('share-status', 'Idle', '');
  hide('stop-share-btn'); show('start-share-btn');
  hide('screen-audio-live');

  // Reset mute button state
  $id('share-mute-audio-btn')?.classList.remove('muted');
  const icon = $id('share-audio-icon');
  if (icon) icon.innerHTML = _audioIconSvgOn();
}

function stopRemoteStream() {
  const vid = $id('remote-preview');
  if (vid) {
    try { vid.pause(); } catch {}
    vid.srcObject = null;
  }
  if (S.rtcScreen) {
    try { S.rtcScreen.close(); } catch {}
    S.rtcScreen = null;
  }
  S.iceCandidateQueueScreen = [];
  S.rtcScreenTarget = null;
  S.pendingScreenOffer = null;
  S._acceptingScreenShare = false;
  S._remoteAudioMuted = false;
  S._remoteAudioMuteWired = false;

  const remoteBtn = $id('remote-mute-btn');
  if (remoteBtn) { remoteBtn.classList.remove('active', 'muted'); hide('remote-mute-btn'); }

  const overlay = $id('remote-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.style.cursor = '';
    overlay.onclick = null;
    overlay.innerHTML = `
      <svg viewBox="0 0 48 48" fill="none">
        <rect x="4" y="8" width="40" height="28" rx="3" stroke="currentColor" stroke-width="2" fill="none" opacity=".3"/>
        <circle cx="24" cy="22" r="8" stroke="currentColor" stroke-width="2" fill="none" opacity=".3"/>
      </svg>
      <p>No incoming stream</p>`;
  }
  setStatus('view-status', 'Waiting', '');
  hide('close-stream-btn');
}

async function acceptScreenShare() {
  if (S._acceptingScreenShare) return;
  S._acceptingScreenShare = true;
  hide('screenshare-request');

  const offer = S.pendingScreenOffer;
  if (!offer) {
    S._acceptingScreenShare = false;
    return;
  }

  // Clean up any existing peer
  if (S.rtcScreen) {
    try { S.rtcScreen.close(); } catch {}
    S.rtcScreen = null;
  }
  S.iceCandidateQueueScreen = [];

  try {
    // Set target BEFORE creating peer (so onicecandidate has a valid target)
    S.rtcScreenTarget = offer.from;
    S.rtcScreen = createPeer('screen');

    const vid = $id('remote-preview');
    let remoteStream = null;

    // ── ontrack — fires when we receive the sender's video/audio track ────────
    //
    // SIMPLIFIED from the old code: just assign srcObject and call play().
    // The "tap overlay / canplay / readyState" approach was over-engineered
    // and caused the stream to never play when receiving from Android because:
    // - Android sends video with sendonly SDP direction
    // - The old code waited for iceConnected AND readyState >= 3 simultaneously
    //   but on Android→Web the ICE connected event fired BEFORE ontrack
    //   in some timing scenarios, causing maybePlay() to bail early
    //
    // Simple approach: assign srcObject on first video track, call play(),
    // handle autoplay block with a tap overlay only as fallback.
    S.rtcScreen.ontrack = e => {
      console.log('[Screen RX] ontrack:', e.track.kind, 'id:', e.track.id);

      if (!remoteStream) {
        remoteStream = new MediaStream();
        if (vid) vid.srcObject = remoteStream;
        console.log('[Screen RX] Assigned srcObject');
      }

      remoteStream.addTrack(e.track);
      e.track.onunmute = () => {
        console.log('[Screen RX] Track unmuted — frames arriving:', e.track.kind);
        if (e.track.kind === 'video') {
          _startRemotePlayback(vid, remoteStream);
        }
      };

      // Wire audio mute controls
      if (e.track.kind === 'audio') {
        show('remote-mute-btn');
        $id('remote-mute-btn')?.classList.add('active');
        if (!S._remoteAudioMuteWired) {
          S._remoteAudioMuteWired = true;
          S._remoteAudioMuted = false;
          $id('remote-mute-btn')?.addEventListener('click', () => {
            S._remoteAudioMuted = !S._remoteAudioMuted;
            remoteStream?.getAudioTracks().forEach(t => { t.enabled = !S._remoteAudioMuted; });
            const btn = $id('remote-mute-btn');
            const icon = $id('remote-audio-icon');
            if (S._remoteAudioMuted) {
              btn?.classList.remove('active'); btn?.classList.add('muted');
              if (icon) icon.innerHTML = _audioIconSvgOff();
            } else {
              btn?.classList.add('active'); btn?.classList.remove('muted');
              if (icon) icon.innerHTML = _audioIconSvgOn();
            }
          });
        }
      }
    };

    // ── Connection state changes ───────────────────────────────────────────────
    S.rtcScreen.onconnectionstatechange = () => {
      const st = S.rtcScreen?.connectionState;
      console.log('[Screen RX] Connection:', st);
      if (st === 'connected') {
        setStatus('view-status', 'Connected', 'connecting');
        console.log('[Screen RX] ICE connected — video should be flowing');
        // Attempt play in case onunmute fired before connection was established
        if (remoteStream && vid) {
          _startRemotePlayback(vid, remoteStream);
        }
      } else if (st === 'failed') {
        toast('Screen Share', 'Connection failed — ensure both devices are on the same network', 'error');
        stopRemoteStream();
      } else if (st === 'disconnected') {
        setStatus('view-status', 'Reconnecting…', 'connecting');
      }
    };

    // Show connecting overlay
    const overlay = $id('remote-overlay');
    if (overlay) {
      overlay.classList.remove('hidden');
      overlay.style.cursor = 'default';
      overlay.onclick = null;
      overlay.innerHTML = `
        <svg viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="16" stroke="currentColor" stroke-width="2" opacity=".3" fill="none"/>
          <path d="M24 8 a16 16 0 0 1 16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none">
            <animateTransform attributeName="transform" type="rotate" from="0 24 24" to="360 24 24" dur="1s" repeatCount="indefinite"/>
          </path>
        </svg>
        <p>Connecting…</p>`;
    }
    setStatus('view-status', 'Connecting…', 'connecting');
    switchTab('screen');

    // ── Set remote description ────────────────────────────────────────────────
    const sdpObj = (offer.sdp && typeof offer.sdp === 'object' && offer.sdp.type)
      ? offer.sdp
      : { type: 'offer', sdp: offer.sdp };

    await S.rtcScreen.setRemoteDescription(new RTCSessionDescription(sdpObj));
    console.log('[Screen RX] Remote offer set');

    // Flush ICE candidates that arrived before setRemoteDescription
    flushIceQueue('screen');

    // ── Create answer ─────────────────────────────────────────────────────────
    // Must declare receive capability — Android sends with sendonly direction
    const answer = await S.rtcScreen.createAnswer({
      offerToReceiveVideo: true,
      offerToReceiveAudio: true,
    });

    // Inject bandwidth hint so Android sender knows it can push 6Mbps
    const mungedAnswer = new RTCSessionDescription({
      type: answer.type,
      sdp: _injectBandwidth(answer.sdp, SCREEN_BITRATE_BPS / 1000),
    });

    await S.rtcScreen.setLocalDescription(mungedAnswer);
    wsSend({ type: 'SCREENSHARE_ANSWER', to: offer.from, sdp: S.rtcScreen.localDescription });
    console.log('[Screen RX] Answer sent to', offer.from);
    S.pendingScreenOffer = null;

    // Timeout: if still not streaming after 15s, give the user a hint
    setTimeout(() => {
      if (!S.rtcScreen) return;
      const st = S.rtcScreen.connectionState;
      if (st !== 'connected' && st !== 'closed') {
        toast('Screen Share', 'Still connecting — check both devices are on the same Wi-Fi network', 'warning');
      }
    }, SCREEN_CONNECT_TIMEOUT_MS);

  } catch (err) {
    console.error('[Screen RX] Accept failed:', err);
    toast('Screen Share', `Accept failed: ${err.message}`, 'error');
    stopRemoteStream();
  } finally {
    S._acceptingScreenShare = false;
  }
}

// ─── Voice Call ───────────────────────────────────────────────────────────────
function initVoice() {
  $id('voice-call-btn').addEventListener('click', async () => {
    if (S.rtcVoice) { endVoiceCall(); return; }
    const targetId = $id('voice-target').value;
    if (!targetId) { toast('Voice', 'Select a device to call', 'warning'); return; }
    await startVoiceCall(targetId);
  });

  $id('voice-mute-btn').addEventListener('click', toggleVoiceMute);

  $id('accept-voice').addEventListener('click', async () => {
    hide('voice-request');
    await acceptVoiceCall();
  });
  $id('reject-voice').addEventListener('click', () => {
    hide('voice-request');
    S.pendingVoiceOffer = null;
  });
}

async function startVoiceCall(targetId) {
  if (!checkSecureContext()) {
    toast(
      'Voice Call Unavailable',
      'Microphone access requires HTTPS or localhost. Non-localhost devices need the server to run with HTTPS.',
      'error'
    );
    showSecureContextBanner('voice');
    return;
  }

  // Clean up stale peer
  if (S.rtcVoice) { try { S.rtcVoice.close(); } catch {} S.rtcVoice = null; }
  S.iceCandidateQueueVoice = [];

  try {
    $id('voice-status').textContent = 'Requesting microphone...';
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 48000,
        autoGainControl: true
      },
      video: false
    });
    S.localAudio = stream;
    S.rtcVoice = createPeer('voice');
    stream.getTracks().forEach(t => S.rtcVoice.addTrack(t, stream));

    S.rtcVoice.ontrack = e => {
      const audio = new Audio();
      audio.srcObject = e.streams[0] || new MediaStream([e.track]);
      audio.play().catch(err => console.warn('[Voice] Audio play blocked:', err.message));
      startCallTimer();
    };

    S.rtcVoice.onconnectionstatechange = () => {
      const st = S.rtcVoice?.connectionState;
      if (st === 'failed') {
        toast('Voice', 'Call connection failed', 'error');
        endVoiceCall();
      }
      if (st === 'disconnected') {
        toast('Voice', 'Call disconnected', 'warning');
        endVoiceCall();
      }
    };

    S.rtcVoiceTarget = targetId;
    const offer = await S.rtcVoice.createOffer();
    await S.rtcVoice.setLocalDescription(offer);
    wsSend({ type: 'VOICE_OFFER', to: targetId, sdp: S.rtcVoice.localDescription });

    $id('voice-status').textContent = `Calling ${S.devices.get(targetId)?.name || 'device'}...`;
    $id('voice-call-btn').classList.add('active');
    initVoiceVisualizer(stream);
    switchTab('voice');
  } catch (err) {
    if (S.rtcVoice) { try { S.rtcVoice.close(); } catch {} S.rtcVoice = null; }
    if (err.name === 'NotAllowedError') {
      toast('Voice', 'Microphone permission denied', 'error');
    } else if (err.name === 'NotFoundError') {
      toast('Voice', 'No microphone found on this device', 'error');
    } else {
      toast('Voice', `Mic error: ${err.message}`, 'error');
    }
    $id('voice-status').textContent = 'Not in a call';
  }
}

async function acceptVoiceCall() {
  const offer = S.pendingVoiceOffer;
  if (!offer) return;

  if (!checkSecureContext()) {
    toast('Voice Call Unavailable', 'Microphone access requires HTTPS or localhost', 'error');
    showSecureContextBanner('voice');
    S.pendingVoiceOffer = null;
    return;
  }

  // Clean up stale peer
  if (S.rtcVoice) { try { S.rtcVoice.close(); } catch {} S.rtcVoice = null; }
  S.iceCandidateQueueVoice = [];

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    S.localAudio = stream;
    S.rtcVoice = createPeer('voice');
    stream.getTracks().forEach(t => S.rtcVoice.addTrack(t, stream));
    S.rtcVoiceTarget = offer.from;

    S.rtcVoice.ontrack = e => {
      const audio = new Audio();
      audio.srcObject = e.streams[0] || new MediaStream([e.track]);
      audio.play().catch(err => console.warn('[Voice] Audio play blocked:', err.message));
      startCallTimer();
    };

    S.rtcVoice.onconnectionstatechange = () => {
      const st = S.rtcVoice?.connectionState;
      if (st === 'failed')       { toast('Voice', 'Call failed', 'error');       endVoiceCall(); }
      if (st === 'disconnected') { toast('Voice', 'Call ended',  'warning');     endVoiceCall(); }
    };

    // Normalize SDP
    const sdpObj = (typeof offer.sdp === 'object' && offer.sdp.type)
      ? offer.sdp
      : { type: 'offer', sdp: offer.sdp };
    await S.rtcVoice.setRemoteDescription(new RTCSessionDescription(sdpObj));

    // Flush any queued ICE
    flushIceQueue('voice');

    const ans = await S.rtcVoice.createAnswer();
    await S.rtcVoice.setLocalDescription(ans);
    wsSend({ type: 'VOICE_ANSWER', to: offer.from, sdp: S.rtcVoice.localDescription });
    S.pendingVoiceOffer = null;

    $id('voice-status').textContent = `In call with ${offer.fromName}`;
    $id('voice-call-btn').classList.add('active');
    initVoiceVisualizer(stream);
    switchTab('voice');
  } catch (err) {
    if (S.rtcVoice) { try { S.rtcVoice.close(); } catch {} S.rtcVoice = null; }
    if (err.name === 'NotAllowedError') toast('Voice', 'Microphone permission denied', 'error');
    else if (err.name === 'NotFoundError') toast('Voice', 'No microphone found', 'error');
    else toast('Voice', `Error: ${err.message}`, 'error');
  }
}

function endVoiceCall() {
  if (S.localAudio) { S.localAudio.getTracks().forEach(t => t.stop()); S.localAudio = null; }
  if (S.rtcVoice) { try { S.rtcVoice.close(); } catch {} S.rtcVoice = null; }
  S.iceCandidateQueueVoice = [];
  S.rtcVoiceTarget = null;
  clearInterval(S.voiceCallTimer);
  $id('voice-call-btn').classList.remove('active');
  $id('voice-status').textContent = 'Not in a call';
  $id('voice-duration').style.display = 'none';
  S.voiceStart = null;
  $$('.voice-bar').forEach(b => b.classList.remove('active'));
}

function toggleVoiceMute() {
  if (!S.localAudio) return;
  S.voiceMuted = !S.voiceMuted;
  S.localAudio.getAudioTracks().forEach(t => { t.enabled = !S.voiceMuted; });
  $id('voice-mute-btn').style.opacity = S.voiceMuted ? '0.4' : '1';
  toast('Voice', S.voiceMuted ? 'Muted' : 'Unmuted', 'info');
}

function startCallTimer() {
  S.voiceStart = Date.now();
  const dur = $id('voice-duration');
  dur.style.display = 'block';
  $id('voice-status').textContent = 'In call';
  S.voiceCallTimer = setInterval(() => {
    const s = Math.floor((Date.now() - S.voiceStart) / 1000);
    dur.textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
  }, 1000);
}

function initVoiceVisualizer(stream) {
  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    src.connect(analyser);
    S.voiceAnalyser = analyser;
    const bars = $$('.voice-bar');
    const data = new Uint8Array(analyser.frequencyBinCount);
    function animate() {
      if (!S.rtcVoice) return;
      analyser.getByteFrequencyData(data);
      bars.forEach((b, i) => {
        const h = Math.max(8, (data[i * 4] || 0) / 255 * 50);
        b.style.height = h + 'px';
      });
      requestAnimationFrame(animate);
    }
    bars.forEach(b => b.classList.add('active'));
    animate();
  } catch {}
}

// ─── Messages ─────────────────────────────────────────────────────────────────
function initMessages() {
  $id('send-msg-btn').addEventListener('click', sendMessage);
  $id('msg-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
}

function sendMessage() {
  const inp = $id('msg-input');
  const content = inp.value.trim();
  if (!content) return;
  const to = $id('msg-target').value;
  wsSend({ type: 'SEND_TEXT', content, to });
  addMessage({ id: genId(), content, from: S.deviceId, fromName: 'You', ts: Date.now(), out: true });
  inp.value = '';
}

function addMessage(msg) {
  S.messages.push(msg);
  if (S.messages.length > 500) S.messages.shift();
  renderMessages();
  const feed = $id('messages-feed');
  feed.scrollTop = feed.scrollHeight;
}

function renderMessages() {
  const feed = $id('messages-feed');
  if (!S.messages.length) { feed.innerHTML = '<div class="empty-sm">No messages yet!</div>'; return; }
  feed.innerHTML = S.messages.map(m => `
    <div class="message-bubble ${m.out ? 'outgoing' : 'incoming'}">
      ${!m.out ? `<div class="msg-from">${esc(m.fromName)}</div>` : ''}
      ${esc(m.content)}
      <div class="msg-time">${fmtTime(m.ts)}</div>
    </div>`).join('');
}

function updateMsgBadge() {
  const badge = $id('nav-badge-msgs');
  const b2 = $id('msg-count-badge');
  if (S.msgUnread > 0) {
    badge.textContent = S.msgUnread; badge.classList.remove('hidden');
    b2.textContent = `${S.msgUnread} unread`; b2.classList.remove('hidden');
  } else {
    badge.classList.add('hidden'); b2.classList.add('hidden');
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function initSettings() {
  // Notifications toggle
  $id('notif-toggle').checked = S.notifEnabled;
  $id('notif-toggle').addEventListener('change', e => {
    S.notifEnabled = e.target.checked;
    localStorage.setItem('nexus_notif', e.target.checked);
  });

  // Auto download toggle
  $id('autodl-toggle').checked = S.autoDl;
  $id('autodl-toggle').addEventListener('change', e => {
    S.autoDl = e.target.checked;
    localStorage.setItem('nexus_autodl', e.target.checked);
  });

  // PIN toggle
  $id('pin-toggle').addEventListener('change', async e => {
    if (e.target.checked) {
      const r = await fetch('/api/pin/generate', { method: 'POST' }).then(x => x.json());
      $id('pin-value').textContent = r.pin;
      show('pin-area');
      toast('PIN Enabled', `New PIN: ${r.pin}`, 'success');
    } else {
      await fetch('/api/pin/disable', { method: 'POST' });
      $id('pin-value').textContent = '——————';
      hide('pin-area');
    }
  });

  $id('regen-pin-btn').addEventListener('click', async () => {
    const r = await fetch('/api/pin/generate', { method: 'POST' }).then(x => x.json());
    $id('pin-value').textContent = r.pin;
    toast('PIN Regenerated', `New PIN: ${r.pin}`, 'success');
  });
}

async function loadServerInfo() {
  try {
    const info = await fetch('/api/info').then(r => r.json());
    $id('srv-hostname').textContent = info.name || '—';
    $id('srv-platform').textContent = info.platform || '—';
    $id('srv-ips').textContent = info.ips?.join(', ') || '—';
    $id('srv-uptime').textContent = fmtUptime(info.uptime);
    $id('srv-devices').textContent = info.devices;
    $id('pin-toggle').checked = info.pinEnabled;
    if (info.pinEnabled) show('pin-area');

    setInterval(async () => {
      try {
        const i = await fetch('/api/stats').then(r => r.json());
        $id('srv-uptime').textContent = fmtUptime(i.uptime);
        $id('srv-devices').textContent = i.devices;
      } catch {}
    }, 30000);
  } catch {}
}

// ─── QR Code ──────────────────────────────────────────────────────────────────
function initQR() {
  $id('qr-btn').addEventListener('click', async () => {
    try {
      const info = await fetch('/api/info').then(r => r.json());
      if (info.qr) {
        $id('qr-image').src = info.qr;
        $id('qr-url').textContent = info.primaryUrl;
        show('qr-modal');
      }
    } catch { toast('QR', 'Could not load QR code', 'error'); }
  });
  $id('qr-close').addEventListener('click', () => hide('qr-modal'));
  $id('qr-backdrop').addEventListener('click', () => hide('qr-modal'));
  $id('qr-copy-btn').addEventListener('click', () => {
    const url = $id('qr-url').textContent;
    tryWriteClipboard(url);
    toast('Copied', 'Server URL copied', 'success');
  });

  $id('disco-btn').addEventListener('click', async () => {
    wsSend({ type: 'GET_DEVICES' });
    toast('Scanning', 'Scanning local network...', 'info');
    await sleep(1200);
    toast('Done', `${S.devices.size} device${S.devices.size !== 1 ? 's' : ''} found`, S.devices.size ? 'success' : 'info');
  });
}

// ─── Transfer Overlay ─────────────────────────────────────────────────────────
let _xferTimeout;
function showTransferOverlay(speed, name) {
  $id('transfer-speed').textContent = speed;
  $id('transfer-name').textContent = name;
  $id('transfer-overlay').classList.remove('hidden');
  clearTimeout(_xferTimeout);
  _xferTimeout = setTimeout(hideTransferOverlay, 3000);
}
function hideTransferOverlay() {
  $id('transfer-overlay').classList.add('hidden');
}

// ─── WebRTC Helper ────────────────────────────────────────────────────────────
function createPeer(kind) {
  const iceServers = S.iceServers || [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];

  const pc = new RTCPeerConnection({
    iceServers,
    sdpSemantics: 'unified-plan',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceTransportPolicy: 'all',
  });

  pc.onicecandidate = e => {
    if (!e.candidate) {
      console.log(`[${kind}] ICE gathering complete`);
      return;
    }
    const target  = kind === 'voice' ? S.rtcVoiceTarget  : S.rtcScreenTarget;
    const msgType = kind === 'voice' ? 'VOICE_ICE'        : 'ICE_CANDIDATE';

    if (target) {
      wsSend({ type: msgType, to: target, candidate: e.candidate.toJSON() });
      console.log(`[${kind}] ICE sent →`, e.candidate.candidate.substring(0, 70));
    } else {
      console.warn(`[${kind}] ICE candidate dropped — target is null`);
    }
  };

  pc.onicegatheringstatechange  = () => console.log(`[${kind}] ICE gathering:`, pc.iceGatheringState);
  pc.oniceconnectionstatechange = () => console.log(`[${kind}] ICE connection:`, pc.iceConnectionState);
  pc.onsignalingstatechange     = () => console.log(`[${kind}] Signaling:`, pc.signalingState);

  return pc;
}
// ─── ICE Queue Flusher ────────────────────────────────────────────────────────
function flushIceQueue(kind) {
  const queue = kind === 'voice' ? S.iceCandidateQueueVoice : S.iceCandidateQueueScreen;
  const peer  = kind === 'voice' ? S.rtcVoice               : S.rtcScreen;

  if (!peer || !queue.length) return;

  // Check that remote description is actually set before adding candidates
  if (!peer.remoteDescription) {
    console.log(`[${kind}] flushIceQueue: remote desc not set yet — skipping flush (${queue.length} queued)`);
    return;
  }

  console.log(`[${kind}] Flushing ${queue.length} queued ICE candidates`);
  const toFlush = queue.splice(0); // drain atomically
  toFlush.forEach(candidate => {
    peer.addIceCandidate(new RTCIceCandidate(candidate))
      .catch(err => {
        // "wrong state" is benign — happens if the PC closed during flushing
        if (!err.message?.includes('wrong state') && !err.message?.includes('closed')) {
          console.warn(`[${kind}] ICE candidate add failed:`, err.message);
        }
      });
  });
}

// ─── WebRTC Screen Share Message Handlers ────────────────────────────────────

function handleScreenshareOffer(msg) {
  // Guard: ignore if we're already negotiating this exact offer
  const alreadyProcessing = S._acceptingScreenShare &&
                             S.pendingScreenOffer?.from === msg.from;
  const alreadyConnected  = S.rtcScreen &&
                             S.rtcScreenTarget === msg.from &&
                             (S.rtcScreen.connectionState === 'connecting' ||
                              S.rtcScreen.connectionState === 'connected');

  if (alreadyProcessing || alreadyConnected) {
    console.log('[Screen] Ignoring duplicate SCREENSHARE_OFFER from', msg.from,
      '— state:', S.rtcScreen?.connectionState);
    return;
  }

  // Store offer and show accept dialog
  S._acceptingScreenShare = false;
  S.pendingScreenOffer = { sdp: msg.sdp, from: msg.from, fromName: msg.fromName };
  $id('screenshare-from-name').textContent = msg.fromName || 'Unknown device';
  show('screenshare-request');
}

function handleScreenshareAnswer(msg) {
  if (!S.rtcScreen) {
    console.warn('[Screen] Got SCREENSHARE_ANSWER but no active peer — ignoring');
    return;
  }
  // Normalize: msg.sdp may be {type, sdp} object or raw SDP string
  const sdpObj = (msg.sdp && typeof msg.sdp === 'object' && msg.sdp.type)
    ? msg.sdp
    : { type: 'answer', sdp: msg.sdp };

  S.rtcScreen.setRemoteDescription(new RTCSessionDescription(sdpObj))
    .then(() => {
      console.log('[Screen] Remote answer set — flushing ICE queue');
      flushIceQueue('screen');
    })
    .catch(err => {
      console.error('[Screen] setRemoteDescription(answer) failed:', err);
      toast('Screen Share', 'Connection negotiation failed — try sharing again', 'error');
      stopScreenShare();
    });
}

function handleIceCandidate(msg) {
  if (!msg.candidate) return;

  // Always push to queue first, then flush if ready.
  // This prevents race conditions where remoteDescription is set in a microtask
  // but the peer object's internal state hasn't propagated yet.
  S.iceCandidateQueueScreen.push(msg.candidate);

  if (S.rtcScreen && S.rtcScreen.remoteDescription) {
    flushIceQueue('screen');
  }
}


// ─── Secure-Context Warning ───────────────────────────────────────────────────
function checkSecureContext() {
  return window.isSecureContext;
}

function showSecureContextBanner(feature) {
  const existing = $id('secure-context-banner');
  if (existing) return; // already shown

  const banner = document.createElement('div');
  banner.id = 'secure-context-banner';
  banner.innerHTML = `
    <div class="secure-banner-inner">
      <svg viewBox="0 0 20 20" fill="none" style="width:18px;height:18px;flex-shrink:0">
        <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5" fill="none"/>
        <path d="M10 6v4M10 13v.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
      <div>
        <strong>${feature === 'screen' ? 'Screen Share' : 'Voice Call'} requires HTTPS</strong>
        <div style="font-size:11px;margin-top:3px;opacity:.8">
          Browsers block microphone &amp; screen access on non-secure (HTTP) origins.<br>
          <strong>Fix:</strong> Access Nexus via <code>http://localhost:7523</code> on the server machine,
          or configure HTTPS. Other devices on the same LAN can use <code>http://&lt;IP&gt;:7523</code>
          — Chrome flags this secure for getUserMedia on LAN in Chrome 94+, but
          <em>getDisplayMedia always requires HTTPS or localhost</em>.
        </div>
      </div>
      <button onclick="this.parentElement.parentElement.remove()" style="margin-left:auto;background:none;border:none;color:inherit;cursor:pointer;font-size:18px;line-height:1;opacity:.6">✕</button>
    </div>`;
  banner.style.cssText = `
    position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
    background:var(--bg2);border:1.5px solid var(--red);border-radius:var(--radius-lg);
    padding:16px 20px;z-index:900;max-width:520px;width:calc(100% - 32px);
    box-shadow:0 8px 32px rgba(0,0,0,.5);`;
  document.body.appendChild(banner);
}
// ─── Scan Btn ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  $id('scan-btn')?.addEventListener('click', async () => {
    $id('scan-btn').textContent = 'Scanning...';
    wsSend({ type: 'GET_DEVICES' });
    await sleep(1000);
    $id('scan-btn').innerHTML = `<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.2"/><path d="M8 4v4l3 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> Scan`;
  });
});

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(title, msg, type = 'info') {
  const icons = { info: 'ℹ', success: '✓', warning: '⚠', error: '✕' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type]||'ℹ'}</span><div class="toast-body"><div class="toast-title">${esc(title)}</div><div class="toast-msg">${esc(msg)}</div></div>`;
  $id('toast-container').appendChild(el);
  setTimeout(() => { el.classList.add('fade-out'); setTimeout(() => el.remove(), 300); }, 4500);
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function $id(id) { return document.getElementById(id); }
function $$(s) { return document.querySelectorAll(s); }
function show(id) { $id(id)?.classList.remove('hidden'); }
function hide(id) { $id(id)?.classList.add('hidden'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function genId() { return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)+Date.now().toString(36); }
function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/Android/.test(ua)) return 'Android Device';
  if (/iPhone|iPad/.test(ua)) return 'iPhone';
  if (/Win/.test(ua)) return 'Windows PC';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux Device';
  return 'My Device';
}
function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b/1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b/1048576).toFixed(1)} MB`;
  return `${(b/1073741824).toFixed(2)} GB`;
}
function timeAgo(ts) {
  const s = Math.floor((Date.now()-ts)/1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}
function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
function fmtUptime(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function setStatus(id, text, cls) {
  const el = $id(id);
  el.textContent = text;
  el.className = 'screen-status' + (cls ? ' '+cls : '');
}
function fileIcon(mime='') {
  const s = '<svg viewBox="0 0 20 20" fill="none">';
  if (mime.startsWith('image/')) return s+`<rect x="2" y="3" width="16" height="14" rx="2" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="7" cy="8" r="1.5" fill="currentColor" opacity=".6"/><path d="M2 14l4-4 3 3 3-4 4 5" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>`;
  if (mime.startsWith('video/')) return s+`<rect x="2" y="4" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M14 8l4-3v8l-4-3V8z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>`;
  if (mime.startsWith('audio/')) return s+`<circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M7 8h6M7 11h6M7 14h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
  if (mime==='application/pdf') return s+`<path d="M4 3h8l4 4v10H4z" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M12 3v4h4" stroke="currentColor" stroke-width="1.2"/><path d="M7 12h6M7 15h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
  if (mime.includes('zip') || mime.includes('archive')) return s+`<rect x="6" y="2" width="8" height="16" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M9 5h2M9 8h2M9 11h2M9 14h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  return s+`<path d="M4 3h8l4 4v10H4z" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M12 3v4h4" stroke="currentColor" stroke-width="1.2"/></svg>`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initSetup();
  boot();
});