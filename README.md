<div align="center">

```
███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗
████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝
██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗
██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║
██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║
╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝
```

**Cross-platform local device ecosystem.**  
No internet. No accounts. No cloud. Just your network.

[![Version](https://img.shields.io/badge/version-2.0.0-0ff?style=flat-square&logo=node.js&logoColor=white)](.)
[![License](https://img.shields.io/badge/license-MIT-0af?style=flat-square)](.)
[![Node](https://img.shields.io/badge/node-%3E%3D16-brightgreen?style=flat-square&logo=nodedotjs&logoColor=white)](.)
[![Protocol](https://img.shields.io/badge/protocol-WebSocket%20%2B%20WebRTC-blueviolet?style=flat-square)](.)
[![Offline](https://img.shields.io/badge/internet-not%20required-ff6b6b?style=flat-square)](.)

</div>

---

## ◈ What is NEXUS?

NEXUS is a **self-hosted local network hub** that connects all your devices — phones, laptops, desktops, tablets — into a single seamless ecosystem. Open a browser, scan a QR code, and instantly share files, sync your clipboard, stream your screen, and make voice calls. Everything stays on your LAN. Nothing ever leaves.

> Think AirDrop + KDE Connect + a screen-share tool — running in any browser, on any OS, with zero configuration.

---

## ◈ Features

| Feature | Description |
|---|---|
| **⚡ File Transfer** | Drag-and-drop up to **2 GB per file**. Files expire after 48h and are auto-cleaned. MD5 checksum verified. |
| **📋 Clipboard Sync** | Push text, URLs, and code snippets across all connected devices instantly. Up to 1 MB per sync. |
| **🖥 Screen Share** | WebRTC P2P screen sharing with optional audio. Works on Chrome, Edge, Firefox desktop. Embedded TURN relay for HTTP fallback. |
| **🎙 Voice Calls** | Crystal-clear P2P voice — audio never touches the server. Real-time visualizer and mute control. |
| **💬 Messages** | Lightweight local messenger with per-device targeting and a 500-message history log. |
| **📡 Auto Discovery** | UDP broadcast on `:7524` — devices find each other automatically on the same WiFi or LAN. |
| **🔐 PIN Pairing** | Optional 6-digit PIN gating. Regenerate on demand. Persisted across restarts. |
| **📲 PWA Support** | Install as a Progressive Web App on any device. Works offline after first load. |
| **🔒 HTTPS Auto-TLS** | Auto-generates a self-signed cert via OpenSSL on first run. Drop your own `cert.pem` + `key.pem` to use a custom cert. |
| **🔁 TURN Relay** | Embedded TURN server (port `3478`) ensures screen share ICE works even over plain HTTP. |

---

## ◈ Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     NEXUS SERVER (Node.js)               │
│                                                          │
│   ┌─────────────┐   ┌──────────────┐   ┌─────────────┐   │
│   │  Express    │   │  WebSocket   │   │ UDP Discover│   │
│   │  REST API   │   │  (ws)        │   │ :7524       │   │
│   │  :7523      │   │  :7523       │   │             │   │
│   └──────┬──────┘   └──────┬───────┘   └─────────────┘   │
│          │                 │                             │
│   ┌──────▼─────────────────▼───────────────────────┐     │
│   │              Core State                        │     │
│   │  devices Map · fileRegistry · clipboard        │     │
│   │  msgHistory · pairingData                      │     │
│   └────────────────────────────────────────────────┘     │
│                                                          │
│   ┌─────────────────────────────────────────────────┐    │
│   │  Embedded TURN Server (node-turn)  :3478        │    │
│   │  ICE relay for WebRTC over HTTP                 │    │
│   └─────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘

         ↕ WebSocket (ws/wss)    ↕ WebRTC (P2P)
┌──────────────┐        ┌──────────────┐        ┌──────────────┐
│   Browser A  │◄──────►│   Browser B  │◄──────►│  Browser C   │
│  (Desktop)   │        │  (Android)   │        │  (Laptop)    │
└──────────────┘        └──────────────┘        └──────────────┘
```

---

## ◈ Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) `>= 16`
- All devices on the **same WiFi or LAN network**

### Install & Run

```bash
# Clone or unzip the project
cd nexus-final

# Install dependencies
npm install

# Start the server
npm start
```

That's it. NEXUS will print your network URLs to the console:

```
╔══════════════════════════════════════════════════╗
║         NEXUS v2 — Device Ecosystem              ║
╠══════════════════════════════════════════════════╣
║  Server  : https://localhost:7523                ║
║  Network : https://192.168.1.42:7523             ║
║  UDP     : :7524 (LAN discovery)                 ║
╠══════════════════════════════════════════════════╣
║  HTTPS ✓ — screen share & voice on all devices   ║
║  Open URL on any device on same WiFi/LAN         ║
║  Android: scan QR code in the app                ║
╚══════════════════════════════════════════════════╝
```

Open the **Network URL** on any device on your LAN. Scan the in-app **QR code** to connect mobile devices instantly.

---

## ◈ One-click Scripts

| Platform | Script |
|---|---|
| Linux / macOS | `./START_LINUX_MAC.sh` |
| Windows | `START_WINDOWS.bat` |

---

## ◈ HTTPS & Screen Share

NEXUS auto-generates a self-signed TLS certificate using `openssl` on first run (`nexus-cert.pem` + `nexus-key.pem`). This enables screen sharing and voice on all devices without extra setup.

**To use your own certificate:**

```
nexus-final/
├── cert.pem      ← your certificate
├── key.pem       ← your private key
└── ...
```

**Certificate resolution order:**
1. `cert.pem` + `key.pem` (user-provided)
2. `nexus-cert.pem` + `nexus-key.pem` (auto-generated)
3. Any `*.pem` / `*-key.pem` pair in project root (legacy)
4. Plain HTTP + embedded TURN relay (fallback)

> **Browser warning:** You'll see an "untrusted certificate" warning on first visit. Click **Advanced → Proceed**. This is expected for self-signed certs on a local network.

---

## ◈ API Reference

All endpoints are served on port `7523`.

### REST

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/info` | Server info, IPs, QR code, uptime |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/devices` | List connected devices |
| `GET` | `/api/stats` | Device count, file count, upload bytes |
| `POST` | `/api/upload` | Upload a file (multipart/form-data) |
| `GET` | `/api/files` | List all shared files |
| `GET` | `/api/files/:fileId` | Download a file |
| `DELETE` | `/api/files/:fileId` | Delete a file |
| `GET` | `/api/clipboard` | Get current clipboard content |
| `GET` | `/api/ice-config` | ICE/TURN config for WebRTC clients |
| `POST` | `/api/pin/generate` | Generate a new pairing PIN |
| `POST` | `/api/pin/disable` | Disable PIN protection |
| `GET` | `/api/pin/status` | Check if PIN is enabled |

### WebSocket Events

```
Client → Server                   Server → Client
──────────────────────────────    ────────────────────────────────────
REGISTER                          REGISTERED · AUTH_FAILED
PING                              PONG
UPDATE_INFO                       DEVICE_JOINED · DEVICE_LEFT · DEVICE_UPDATED
CLIPBOARD_PUSH                    CLIPBOARD_UPDATE
SEND_TEXT                         RECEIVE_TEXT
FILE_SENT                         FILE_INCOMING · FILE_DELETED
SCREENSHARE_OFFER/ANSWER          (relayed to target device)
ICE_CANDIDATE                     (relayed to target device)
VOICE_OFFER/ANSWER/ICE            (relayed to target device)
SEND_NOTIFICATION                 NOTIFICATION
GET_DEVICES                       DEVICE_LIST
DELETE_FILE                       FILE_LIST
```

---

## ◈ Project Structure

```
nexus-final/
├── server/
│   └── index.js          # Core server — Express, WebSocket, TURN, UDP discovery
├── public/
│   ├── index.html        # Single-page app shell
│   ├── css/
│   │   └── nexus.css     # Full UI stylesheet
│   ├── js/
│   │   └── nexus.js      # Client-side app logic
│   └── assets/
│       └── icon.svg      # App icon
├── data/
│   └── pairing.json      # Persisted PIN state
├── manifest.json         # PWA manifest
├── sw.js                 # Service worker
├── START_LINUX_MAC.sh
├── START_WINDOWS.bat
└── package.json
```

---

## ◈ Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7523` | HTTP/HTTPS server port |
| `DISCOVERY_PORT` | `7524` | UDP discovery broadcast port |
| `TURN_PORT` | `3478` | Embedded TURN server port |
| `MAX_FILE_SIZE` | `2 GB` | Per-file upload limit |
| `FILE_EXPIRY_MS` | `48h` | Time before uploaded files are auto-deleted |

Override the port with an environment variable:

```bash
PORT=8080 npm start
```

---

## ◈ Platform Notes

| Device | File Transfer | Clipboard | Screen Share | Voice |
|---|---|---|---|---|
| Chrome Desktop | ✅ | ✅ | ✅ | ✅ |
| Firefox Desktop | ✅ | ✅ | ✅ | ✅ |
| Edge Desktop | ✅ | ✅ | ✅ | ✅ |
| Android Chrome | ✅ | ✅ | ⚠️ View only¹ | ✅ |
| iOS Safari | ✅ | ✅ | ⚠️ View only¹ | ✅ |

> ¹ `getDisplayMedia` (screen capture) is not supported by mobile browsers — this is a browser-level restriction, not a NEXUS limitation. Mobile devices can **receive and view** screen shares without issue.

---

## ◈ Security Model

- **All data stays on your LAN.** Nothing is transmitted to external servers.
- **WebRTC streams are peer-to-peer.** Screen share and voice audio never pass through the NEXUS server.
- **PIN protection** prevents unauthorized devices from joining your ecosystem.
- **TURN credentials** are randomly generated per session — a new secret on every server start.
- **File checksums** (MD5) are computed server-side and sent to receiving devices for verification.
- **CORS headers** are permissive by design for local network use. Do not expose NEXUS to the public internet.

---

## ◈ Dependencies

| Package | Role |
|---|---|
| `express` | HTTP server & REST API |
| `ws` | WebSocket server |
| `multer` | File upload handling |
| `node-turn` | Embedded TURN/ICE relay |
| `qrcode` | QR code generation for device onboarding |
| `uuid` | Unique IDs for devices, files, messages |

---

## ◈ License

**MIT** — Use it, modify it, ship it. Just don't sue us if your cat walks across the keyboard during a screen share.

---

<div align="center">

Built for local networks. Designed to disappear into the background.  
**NEXUS v2.0.0**

</div>
