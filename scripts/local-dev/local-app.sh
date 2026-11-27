#!/bin/bash
# Build and run a private production copy of the app on this machine only (127.0.0.1), together
# with the local gateway. Ports differ from the dev setup (3100/4000), so both can run at once.
#
#   scripts/local-dev/local-app.sh build   # production build (starts the gateway temporarily)
#   scripts/local-dev/local-app.sh start   # run the app + gateway (what the login service runs)
#   scripts/local-dev/local-app.sh install # macOS login service (LaunchAgent) running `start`
#   scripts/local-dev/local-app.sh uninstall
#
# See scripts/local-dev/README.md ("Private local app").
set -euo pipefail

cd "$(dirname "$0")/../.."

APP_PORT="${APP_PORT:-3200}"
GATEWAY_PORT="${GATEWAY_PORT:-4100}"
HOST=127.0.0.1
SERVICE_LABEL=local.quran-app

# launchd starts with a minimal PATH: load Node 20 via nvm, and Homebrew for ffmpeg.
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
source "$NVM_DIR/nvm.sh" >/dev/null
nvm use 20 >/dev/null
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

# These override .env.local (which keeps the dev server's settings). NEXT_PUBLIC_* values are baked
# in at build time, so build and start must use the same ports.
export NEXT_PUBLIC_VERCEL_URL="$HOST:$APP_PORT"
export NEXT_PUBLIC_EMBED_URL="http://$HOST:$APP_PORT/embed/v1"
export API_GATEWAY_URL="http://$HOST:$GATEWAY_PORT"
export ALLOWED_ORIGINS="localhost,127.0.0.1"

GATEWAY_PID=""
start_gateway() {
  PORT="$GATEWAY_PORT" HOST="$HOST" APP_ORIGIN="http://$HOST:$APP_PORT" \
    node scripts/local-dev/qurancdn-gateway.js &
  GATEWAY_PID=$!
  trap 'kill "$GATEWAY_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 50); do
    curl -s -o /dev/null "http://$HOST:$GATEWAY_PORT/" && return 0
    sleep 0.2
  done
  echo "gateway did not start on $HOST:$GATEWAY_PORT" >&2
  return 1
}

case "${1:-}" in
  build)
    start_gateway
    IS_BUILD_TIME=true node_modules/.bin/next build
    ;;
  start)
    if [ ! -f .next/BUILD_ID ]; then
      echo "No production build found; run: scripts/local-dev/local-app.sh build" >&2
      exit 1
    fi
    start_gateway
    node_modules/.bin/next start -H "$HOST" -p "$APP_PORT"
    ;;
  install)
    # macOS login service: runs `start` now and at every login, and restarts it if it stops.
    PLIST="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
    LOG_DIR="$HOME/Library/Logs/quran-local"
    mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
    cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVICE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$PWD/scripts/local-dev/local-app.sh</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>$PWD</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/app.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/app.log</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Installed $SERVICE_LABEL: http://$HOST:$APP_PORT (logs: $LOG_DIR/app.log)"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
    echo "Removed $SERVICE_LABEL"
    ;;
  *)
    echo "usage: $0 build|start|install|uninstall" >&2
    exit 2
    ;;
esac
