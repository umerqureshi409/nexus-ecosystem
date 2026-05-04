#!/usr/bin/env bash
# NEXUS v2 — Auto Setup & Launcher (Linux / macOS)
# Run: bash START_LINUX_MAC.sh

set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

NEXUS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=7523

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║          NEXUS v2 — Device Ecosystem         ║${NC}"
echo -e "${CYAN}║       Auto-Setup & Launcher (Linux/Mac)      ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── Check if already running ─────────────────────────────────────────────────
if lsof -Pi ":$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo -e "${GREEN}[OK]${NC} NEXUS is already running on port $PORT"
  echo -e "${CYAN}[>>]${NC} Open: http://localhost:$PORT"
  if command -v xdg-open &>/dev/null; then xdg-open "http://localhost:$PORT" &
  elif command -v open &>/dev/null; then open "http://localhost:$PORT" &
  fi
  exit 0
fi

# ── Install Node.js if missing ────────────────────────────────────────────────
echo -e "${CYAN}[1/4]${NC} Checking Node.js..."

if ! command -v node &>/dev/null; then
  echo -e "${YELLOW}[..]${NC}  Node.js not found. Installing automatically..."
  OS="$(uname -s)"
  
  if [[ "$OS" == "Darwin" ]]; then
    # macOS
    if command -v brew &>/dev/null; then
      echo -e "${CYAN}[..]${NC}  Using Homebrew..."
      brew install node
    else
      echo -e "${CYAN}[..]${NC}  Downloading Node.js for macOS..."
      ARCH="$(uname -m)"
      if [[ "$ARCH" == "arm64" ]]; then
        NODE_URL="https://nodejs.org/dist/v20.11.0/node-v20.11.0-darwin-arm64.tar.gz"
      else
        NODE_URL="https://nodejs.org/dist/v20.11.0/node-v20.11.0-darwin-x64.tar.gz"
      fi
      TMPDIR="$(mktemp -d)"
      curl -fsSL "$NODE_URL" -o "$TMPDIR/node.tar.gz"
      tar -xzf "$TMPDIR/node.tar.gz" -C "$TMPDIR"
      NODE_DIR="$(ls -d $TMPDIR/node-*)"
      sudo cp -r "$NODE_DIR"/* /usr/local/
      rm -rf "$TMPDIR"
    fi
    
  elif [[ "$OS" == "Linux" ]]; then
    if command -v apt-get &>/dev/null; then
      # Debian/Ubuntu
      echo -e "${CYAN}[..]${NC}  Using apt-get..."
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null
      sudo apt-get install -y nodejs 2>/dev/null
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y nodejs
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm nodejs npm
    elif command -v zypper &>/dev/null; then
      sudo zypper install -y nodejs20
    else
      # Generic: download binary
      echo -e "${CYAN}[..]${NC}  Downloading Node.js binary..."
      ARCH="$(uname -m)"
      [[ "$ARCH" == "aarch64" ]] && ARCH="arm64" || ARCH="x64"
      NODE_URL="https://nodejs.org/dist/v20.11.0/node-v20.11.0-linux-${ARCH}.tar.gz"
      TMPDIR="$(mktemp -d)"
      curl -fsSL "$NODE_URL" -o "$TMPDIR/node.tar.gz"
      tar -xzf "$TMPDIR/node.tar.gz" -C "$TMPDIR"
      NODE_DIR="$(ls -d $TMPDIR/node-*)"
      sudo cp -r "$NODE_DIR"/* /usr/local/
      rm -rf "$TMPDIR"
    fi
  fi
  
  if ! command -v node &>/dev/null; then
    echo -e "${RED}[ERR]${NC} Node.js install failed."
    echo "      Please install manually: https://nodejs.org"
    exit 1
  fi
fi

NODE_VER="$(node --version)"
echo -e "${GREEN}[OK]${NC}  Node.js $NODE_VER found."

# ── Install dependencies ──────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}[2/4]${NC} Checking dependencies..."
cd "$NEXUS_DIR"

if [[ ! -d "node_modules" ]]; then
  echo -e "${YELLOW}[..]${NC}  Installing npm packages (first run only)..."
  npm install --loglevel=error
  echo -e "${GREEN}[OK]${NC}  Packages installed."
else
  echo -e "${GREEN}[OK]${NC}  Dependencies already present."
fi

# ── Firewall (Linux only) ─────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}[3/4]${NC} Checking firewall..."
OS="$(uname -s)"
if [[ "$OS" == "Linux" ]]; then
  if command -v ufw &>/dev/null; then
    sudo ufw allow 7523/tcp >/dev/null 2>&1 || true
    sudo ufw allow 7524/udp >/dev/null 2>&1 || true
    echo -e "${GREEN}[OK]${NC}  ufw rules added (7523/tcp, 7524/udp)"
  elif command -v firewall-cmd &>/dev/null; then
    sudo firewall-cmd --add-port=7523/tcp --permanent >/dev/null 2>&1 || true
    sudo firewall-cmd --add-port=7524/udp --permanent >/dev/null 2>&1 || true
    sudo firewall-cmd --reload >/dev/null 2>&1 || true
    echo -e "${GREEN}[OK]${NC}  firewalld rules added"
  else
    echo -e "${YELLOW}[..]${NC}  No firewall manager detected — skipping"
  fi
else
  echo -e "${GREEN}[OK]${NC}  macOS firewall managed by system."
fi

# ── Get local IP ──────────────────────────────────────────────────────────────
OS="$(uname -s)"
if [[ "$OS" == "Darwin" ]]; then
  LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "check-your-ip")
else
  LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "check-your-ip")
fi

# ── Start server ──────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}[4/4]${NC} Starting NEXUS server..."
echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║             NEXUS IS STARTING                ║${NC}"
echo -e "${CYAN}╠══════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}  This PC : ${GREEN}http://localhost:$PORT${NC}             ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  Network : ${GREEN}http://$LOCAL_IP:$PORT${NC}           ${CYAN}║${NC}"
echo -e "${CYAN}╠══════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}  Android: open Chrome → go to Network URL    ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  Or scan the QR from inside the app          ${CYAN}║${NC}"
echo -e "${CYAN}╠══════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}  Press Ctrl+C to stop                        ${CYAN}║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo ""

# Open browser
(sleep 2 && {
  if command -v xdg-open &>/dev/null; then xdg-open "http://localhost:$PORT" &>/dev/null &
  elif command -v open &>/dev/null; then open "http://localhost:$PORT" &
  fi
}) &

node server/index.js
