#!/usr/bin/env bash
# Linux-Build für Foldwing – auch wenn das Projekt auf einer mit Windows
# geteilten Platte liegt und node_modules dort die Windows-Binaries enthält.
# Der Build läuft deshalb in einem Linux-nativen Spiegel-Ordner:
#
#   1. Node.js v22 wird (einmalig) lokal nach ~/.cache/foldwing-linux-build
#      geladen – keine Systeminstallation nötig.
#   2. Der Quellcode wird dorthin gespiegelt (ohne node_modules/out/release),
#      npm ci installiert die Linux-Abhängigkeiten.
#   3. npm run dist:linux holt cloudflared (scripts/fetch-cloudflared.mjs,
#      Version und SHA256 fest) und baut AppImage + .deb.
#   4. Die fertigen Artefakte landen zurück im Projekt unter release/.
#
# Aufruf einfach:  bash scripts/build-linux.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ROOT="${FOLDWING_LINUX_BUILD_DIR:-$HOME/.cache/foldwing-linux-build}"
APP_DIR="$BUILD_ROOT/app"
TOOLCHAIN="$BUILD_ROOT/toolchain"

mkdir -p "$APP_DIR" "$TOOLCHAIN"

# ---- Node.js besorgen (lokal, ohne sudo) ----------------------------------
# Mindestens v20, idealerweise v22 (s. o.) – ein zu altes System-Node (Distro-
# Paket hinkt oft hinterher) wird NICHT genommen, sondern die eigene Toolchain
# heruntergeladen, statt mit einer inkompatiblen Version zu bauen.
MIN_NODE_MAJOR=20

node_major() {
  # $1: Pfad zur node-Binary. Gibt 0 zurück, wenn die Abfrage fehlschlägt.
  "$1" -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

if command -v node >/dev/null 2>&1 && [ "$(node_major "$(command -v node)")" -ge "$MIN_NODE_MAJOR" ]; then
  NODE_BIN_DIR="$(dirname "$(command -v node)")"
elif [ -x "$TOOLCHAIN/node/bin/node" ] && [ "$(node_major "$TOOLCHAIN/node/bin/node")" -ge "$MIN_NODE_MAJOR" ]; then
  NODE_BIN_DIR="$TOOLCHAIN/node/bin"
else
  echo "[Foldwing] Kein ausreichend aktuelles Node.js (>= v$MIN_NODE_MAJOR) gefunden – lade Node.js v22 (einmalig) …"
  cd "$TOOLCHAIN"
  curl -fsSL -o SHASUMS256.txt https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
  NAME="$(grep -o 'node-v22[0-9.]*-linux-x64.tar.xz' SHASUMS256.txt | head -1)"
  curl -fsSL -o node.tar.xz "https://nodejs.org/dist/latest-v22.x/$NAME"
  # Prüfsumme gegen die Liste von nodejs.org prüfen, bevor entpackt wird.
  EXPECTED="$(grep " $NAME\$" SHASUMS256.txt | cut -d' ' -f1)"
  ACTUAL="$(sha256sum node.tar.xz | cut -d' ' -f1)"
  if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "[Foldwing] Prüfsumme von $NAME stimmt nicht – Abbruch." >&2
    rm -f node.tar.xz SHASUMS256.txt
    exit 1
  fi
  rm -f SHASUMS256.txt
  rm -rf node
  mkdir -p node && tar -xJf node.tar.xz -C node --strip-components=1 && rm node.tar.xz
  NODE_BIN_DIR="$TOOLCHAIN/node/bin"
fi
export PATH="$NODE_BIN_DIR:$PATH"
echo "[Foldwing] Node: $(node -v), npm: $(npm -v)"

# ---- Quellcode spiegeln ----------------------------------------------------
echo "[Foldwing] Spiegle Projekt nach $APP_DIR …"
rsync -a --delete \
  --exclude node_modules --exclude out --exclude release --exclude .git \
  --exclude tsconfig.node.tsbuildinfo --exclude tsconfig.web.tsbuildinfo \
  "$PROJECT_DIR"/ "$APP_DIR"/

cd "$APP_DIR"

# ---- Abhängigkeiten (Linux-Binaries) --------------------------------------
# Seit Electron 42 holt npm ci das Electron-Programm nicht mehr (electron-builder lädt
# es beim Paketieren selbst), deshalb nur auf die npm-Pakete prüfen. Hat sich das
# Lockfile seit der letzten Installation geändert (z. B. Electron-Upgrade), neu
# installieren – sonst baut der Spiegel mit den alten Paketen weiter.
LOCK_STAMP="$BUILD_ROOT/package-lock.sha256"
LOCK_SUM="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ ! -x node_modules/.bin/electron-vite ] || [ ! -f node_modules/electron/package.json ] \
  || [ "$(cat "$LOCK_STAMP" 2>/dev/null)" != "$LOCK_SUM" ]; then
  echo "[Foldwing] npm ci (Linux-Abhängigkeiten) …"
  npm ci
  echo "$LOCK_SUM" > "$LOCK_STAMP"
fi

# ---- Prüfen + bauen --------------------------------------------------------
npm run typecheck
npm run dist:linux

# Das geladene cloudflared zurück ins Projekt legen, damit es beim nächsten
# Spiegeln nicht erneut geladen wird. Auch eine vorhandene Projektkopie wird
# ersetzt, wenn fetch-cloudflared.mjs sie wegen falscher Prüfsumme neu geladen hat.
if [ -f resources/cloudflared-linux-amd64 ] && ! cmp -s resources/cloudflared-linux-amd64 "$PROJECT_DIR/resources/cloudflared-linux-amd64"; then
  cp resources/cloudflared-linux-amd64 "$PROJECT_DIR/resources/"
fi

# ---- Artefakte zurückkopieren ---------------------------------------------
mkdir -p "$PROJECT_DIR/release"
cp -v release/*.AppImage release/*.deb release/latest-linux.yml "$PROJECT_DIR/release/" 2>/dev/null || true
echo "[Foldwing] Fertig – Artefakte liegen in release/."
