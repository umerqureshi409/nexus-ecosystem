#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════
#  NEXUS v2  —  Local Device Ecosystem
#  Linux / macOS Launcher  |  Production Grade
# ════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────
R='\033[0;31m'   # red
G='\033[0;32m'   # green
Y='\033[1;33m'   # yellow
C='\033[0;36m'   # cyan
B='\033[1;34m'   # blue
W='\033[1;37m'   # white bold
D='\033[2m'      # dim
NC='\033[0m'     # reset

NEXUS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=7523
LOGFILE="$NEXUS_DIR/nexus-log.txt"
OS="$(uname -s)"

# ── Helpers ───────────────────────────────────────────────────
blank()    { echo ""; }
step()     { echo -e "  ${C}[$1/5]${NC}  $2"; }
ok()       { echo -e "  ${G}[ OK ]${NC}  $1"; }
info()     { echo -e "  ${D}[  > ]${NC}  $1"; }
warn()     { echo -e "  ${Y}[ !! ]${NC}  $1"; }
err()      { echo -e "  ${R}[ERR ]${NC}  $1"; }
die()      { blank; err "$1"; blank; echo "  Press Enter to exit..."; read -r; exit 1; }

print_header() {
  clear
  echo ""
  echo -e "  ${C}███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗${NC}"
  echo -e "  ${C}████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝${NC}"
  echo -e "  ${C}██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗${NC}"
  echo -e "  ${C}██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║${NC}"
  echo -e "  ${C}██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║${NC}"
  echo -e "  ${C}╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝${NC}"
  echo ""
  echo -e "  ${D}Local Device Ecosystem  |  v2.0  |  ${OS}${NC}"
  echo -e "  ${D}────────────────────────────────────────────${NC}"
  echo ""
}

print_running_header() {
  clear
  echo ""
  echo -e "  ${C}███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗${NC}"
  echo -e "  ${C}████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝${NC}"
  echo -e "  ${C}██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗${NC}"
  echo -e "  ${C}██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║${NC}"
  echo -e "  ${C}██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║${NC}"
  echo -e "  ${C}╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝${NC}"
  echo ""
  echo -e "  ${G}                  ★  RUNNING  ★${NC}"
  echo -e "  ${D}────────────────────────────────────────────${NC}"
  echo ""
}

# ── Step 1: Already running? ──────────────────────────────────
print_header
step "1" "Checking if NEXUS is already running..."

if lsof -Pi ":$PORT" -sTCP:LISTEN -t >/dev/null 2>&1 || \
   ss -tlnp 2>/dev/null | grep -q ":$PORT " 2>/dev/null; then
  ok "NEXUS is already running on port $PORT"
  blank
  info "Opening http://localhost:$PORT ..."
  if   command -v xdg-open &>/dev/null; then xdg-open "http://localhost:$PORT" &>/dev/null & disown
  elif command -v open      &>/dev/null; then open "http://localhost:$PORT" &
  fi
  blank
  info "Close the terminal that started NEXUS to stop it."
  blank
  exit 0
fi

# ── Step 2: Node.js ───────────────────────────────────────────
blank
step "2" "Checking for Node.js..."

install_node_linux() {
  blank
  warn "Node.js not found — installing automatically..."
  info "This is a one-time setup (~2 minutes). Please wait."
  blank

  ARCH="$(uname -m)"
  [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]] && NARCH="arm64" || NARCH="x64"
  NODE_VER_DL="20.11.0"
  NODE_TAR="node-v${NODE_VER_DL}-linux-${NARCH}.tar.gz"
  NODE_URL="https://nodejs.org/dist/v${NODE_VER_DL}/${NODE_TAR}"
  TMPDIR_NODE="$(mktemp -d)"
  NODE_INSTALL="$HOME/.nexus-node"

  # Prefer package managers (cleaner & auto-updates)
  if command -v apt-get &>/dev/null; then
    info "Using apt-get (requires sudo)..."
    if curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null 2>&1; then
      sudo apt-get install -y nodejs >/dev/null 2>&1
    fi

  elif command -v dnf &>/dev/null; then
    info "Using dnf..."
    sudo dnf install -y nodejs >/dev/null 2>&1

  elif command -v pacman &>/dev/null; then
    info "Using pacman..."
    sudo pacman -S --noconfirm nodejs npm >/dev/null 2>&1

  elif command -v zypper &>/dev/null; then
    info "Using zypper..."
    sudo zypper install -y nodejs20 >/dev/null 2>&1

  else
    # Fallback: portable binary — no sudo needed
    info "Downloading portable Node.js binary (no sudo needed)..."
    curl -fsSL "$NODE_URL" -o "$TMPDIR_NODE/$NODE_TAR" 2>/dev/null || \
      wget -q "$NODE_URL" -O "$TMPDIR_NODE/$NODE_TAR" 2>/dev/null || \
      die "Download failed. Install Node.js manually: https://nodejs.org"

    tar -xzf "$TMPDIR_NODE/$NODE_TAR" -C "$TMPDIR_NODE"
    rm -rf "$NODE_INSTALL"
    mv "$TMPDIR_NODE/node-v${NODE_VER_DL}-linux-${NARCH}" "$NODE_INSTALL"
    export PATH="$NODE_INSTALL/bin:$PATH"
    info "Node.js installed to ~/.nexus-node (no system changes)"
  fi

  rm -rf "$TMPDIR_NODE"
}

install_node_macos() {
  blank
  warn "Node.js not found — installing automatically..."
  info "This is a one-time setup (~2 minutes). Please wait."
  blank

  if command -v brew &>/dev/null; then
    info "Using Homebrew..."
    brew install node >/dev/null 2>&1

  else
    ARCH="$(uname -m)"
    [[ "$ARCH" == "arm64" ]] && NARCH="arm64" || NARCH="x64"
    NODE_VER_DL="20.11.0"
    NODE_PKG="node-v${NODE_VER_DL}-darwin-${NARCH}.tar.gz"
    NODE_URL="https://nodejs.org/dist/v${NODE_VER_DL}/${NODE_PKG}"
    TMPDIR_NODE="$(mktemp -d)"
    NODE_INSTALL="$HOME/.nexus-node"

    info "Downloading Node.js ${NODE_VER_DL} (${NARCH})..."
    curl -fsSL "$NODE_URL" -o "$TMPDIR_NODE/$NODE_PKG" || \
      die "Download failed. Install Node.js manually: https://nodejs.org"

    tar -xzf "$TMPDIR_NODE/$NODE_PKG" -C "$TMPDIR_NODE"
    rm -rf "$NODE_INSTALL"
    mv "$TMPDIR_NODE/node-v${NODE_VER_DL}-darwin-${NARCH}" "$NODE_INSTALL"
    export PATH="$NODE_INSTALL/bin:$PATH"
    rm -rf "$TMPDIR_NODE"
    info "Node.js installed to ~/.nexus-node"
  fi
}

# Check for portable install from a previous run
if [[ -x "$HOME/.nexus-node/bin/node" ]]; then
  export PATH="$HOME/.nexus-node/bin:$PATH"
fi

if command -v node &>/dev/null; then
  NODE_VER="$(node --version)"
  ok "Node.js $NODE_VER found"
else
  if [[ "$OS" == "Darwin" ]]; then
    install_node_macos
  else
    install_node_linux
  fi

  if ! command -v node &>/dev/null; then
    die "Node.js installation failed. Install manually: https://nodejs.org"
  fi
  NODE_VER="$(node --version)"
  ok "Node.js $NODE_VER installed!"
fi

# ── Step 3: npm packages ──────────────────────────────────────
blank
step "3" "Checking packages..."
cd "$NEXUS_DIR"

if [[ ! -f "package.json" ]]; then
  die "package.json not found. Run this script from the NEXUS folder."
fi

if [[ ! -d "node_modules" ]]; then
  info "Installing packages (first run only — ~30 seconds)..."
  npm install --loglevel=error >"$LOGFILE" 2>&1 || {
    err "Package install failed."
    info "Check $LOGFILE for details."
    blank
    die "Resolve the error above and try again."
  }
  ok "Packages installed!"
else
  ok "All packages present."
fi

# ── Step 4: Firewall ──────────────────────────────────────────
blank
step "4" "Checking firewall..."

if [[ "$OS" == "Linux" ]]; then
  if command -v ufw &>/dev/null; then
    sudo ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
    sudo ufw allow 7524/udp >/dev/null 2>&1 || true
    ok "ufw rules added (TCP $PORT + UDP 7524)"
  elif command -v firewall-cmd &>/dev/null; then
    sudo firewall-cmd --add-port="$PORT/tcp" --permanent >/dev/null 2>&1 || true
    sudo firewall-cmd --add-port=7524/udp --permanent >/dev/null 2>&1 || true
    sudo firewall-cmd --reload >/dev/null 2>&1 || true
    ok "firewalld rules added"
  else
    info "No firewall manager found — skipping (usually fine on LAN)"
  fi
else
  ok "macOS system firewall — no changes needed."
fi

# ── Step 5: Get local IP ──────────────────────────────────────
blank
step "5" "Starting NEXUS server..."

if [[ "$OS" == "Darwin" ]]; then
  LOCAL_IP="$(ipconfig getifaddr en0 2>/dev/null || \
              ipconfig getifaddr en1 2>/dev/null || \
              ipconfig getifaddr en2 2>/dev/null || echo "check-your-ip")"
else
  LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || \
              ip route get 1.1.1.1 2>/dev/null | awk '{print $7}' | head -1 || \
              echo "check-your-ip")"
fi

# ── Launch ────────────────────────────────────────────────────
print_running_header

echo -e "  ${W}┌──────────────────────────────────────────────┐${NC}"
echo -e "  ${W}│${NC}                                              ${W}│${NC}"
echo -e "  ${W}│${NC}  This PC  :  ${G}http://localhost:$PORT${NC}             ${W}│${NC}"
echo -e "  ${W}│${NC}  Network  :  ${G}http://$LOCAL_IP:$PORT${NC}         ${W}│${NC}"
echo -e "  ${W}│${NC}                                              ${W}│${NC}"
echo -e "  ${W}└──────────────────────────────────────────────┘${NC}"
echo ""
echo -e "  ${D}Open either URL in any browser on the same Wi-Fi.${NC}"
echo -e "  ${D}Scan the QR code in the app to connect your phone.${NC}"
echo ""
echo -e "  ${Y}Press Ctrl+C to stop NEXUS${NC}"
echo ""
echo -e "  ${D}════════════════════════════════════════════════${NC}"
echo ""

# Open browser after delay (non-blocking)
(
  sleep 2
  if   command -v xdg-open &>/dev/null; then xdg-open "http://localhost:$PORT" &>/dev/null 2>&1 &
  elif command -v open      &>/dev/null; then open "http://localhost:$PORT" &
  fi
) &

# Run server — this call blocks until Ctrl+C
node "$NEXUS_DIR/server/index.js"

echo ""
echo -e "  ${Y}NEXUS has stopped.${NC}"
echo ""
