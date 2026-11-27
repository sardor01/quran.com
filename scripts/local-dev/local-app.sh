#!/bin/bash
# A private copy of the app on this Mac, opened like a normal app and fully stopped when closed.
#
#   scripts/local-dev/local-app.sh make-app   # create ~/Applications/Quran.app (once)
#
# Opening Quran.app runs `run`: it rebuilds if the code changed since the last build, starts the
# app and gateway on 127.0.0.1 only, and opens the Quran window. Closing the window (or quitting it)
# stops everything. Ports differ from the dev setup (3100/4000), so both can run at once.
#
#   scripts/local-dev/local-app.sh build      # production build only
#   scripts/local-dev/local-app.sh start      # run app + gateway in the foreground, no window
#
# See scripts/local-dev/README.md ("Private local app").
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO_DIR="$PWD"

APP_PORT="${APP_PORT:-3200}"
GATEWAY_PORT="${GATEWAY_PORT:-4100}"
DEVTOOLS_PORT="${DEVTOOLS_PORT:-9334}"
HOST=127.0.0.1
APP_URL="http://$HOST:$APP_PORT"
SUPPORT_DIR="$HOME/Library/Application Support/QuranLocal"
LOG_DIR="$HOME/Library/Logs/quran-local"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BUILT_COMMIT_FILE=".next/LOCAL_APP_COMMIT"
# Outside .next so a failed build attempt is remembered after the previous build is restored.
FAILED_COMMIT_FILE="$SUPPORT_DIR/failed-build-commit"

# Apps opened from Finder start with a minimal PATH: load Node 20 via nvm, and Homebrew for ffmpeg.
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
source "$NVM_DIR/nvm.sh" >/dev/null
nvm use 20 >/dev/null
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

# These override .env.local (which keeps the dev server's settings). NEXT_PUBLIC_* values are baked
# in at build time, so build and start must use the same ports.
export NEXT_PUBLIC_VERCEL_URL="$HOST:$APP_PORT"
export NEXT_PUBLIC_EMBED_URL="$APP_URL/embed/v1"
export API_GATEWAY_URL="http://$HOST:$GATEWAY_PORT"
export ALLOWED_ORIGINS="localhost,127.0.0.1"

PIDS=()
GATEWAY_PID=""
CHROME_PID=""
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

notify() {
  osascript -e "display notification \"$1\" with title \"Quran\"" >/dev/null 2>&1 || true
}

wait_for_url() {
  for _ in $(seq 1 150); do
    curl -s -o /dev/null "$1" && return 0
    sleep 0.2
  done
  return 1
}

start_gateway() {
  PORT="$GATEWAY_PORT" HOST="$HOST" APP_ORIGIN="$APP_URL" \
    node scripts/local-dev/qurancdn-gateway.js &
  GATEWAY_PID=$!
  PIDS+=("$GATEWAY_PID")
  wait_for_url "http://$HOST:$GATEWAY_PORT/" || {
    echo "gateway did not start on $HOST:$GATEWAY_PORT" >&2
    return 1
  }
}

build() {
  start_gateway
  local status=0
  IS_BUILD_TIME=true node_modules/.bin/next build || status=$?
  kill "$GATEWAY_PID" 2>/dev/null || true
  if [ "$status" -eq 0 ]; then
    git rev-parse HEAD >"$BUILT_COMMIT_FILE"
  fi
  return "$status"
}

# True while a merge, rebase or cherry-pick is unfinished or files have unresolved conflicts.
git_busy() {
  local git_dir
  git_dir="$(git rev-parse --git-dir)"
  [ -n "$(git ls-files --unmerged)" ] || [ -e "$git_dir/MERGE_HEAD" ] ||
    [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ] ||
    [ -e "$git_dir/CHERRY_PICK_HEAD" ]
}

# Rebuild when there is no build yet or the checked-out commit changed (e.g. after `git pull`).
# Never leaves you without a working app: mid-merge/rebase it skips the update, and if an update
# fails it restores the previous build. Returns non-zero only when there is no build at all.
build_if_needed() {
  local head
  head="$(git rev-parse HEAD)"
  if [ -f .next/BUILD_ID ] && [ "$(cat "$BUILT_COMMIT_FILE" 2>/dev/null)" = "$head" ]; then
    return 0
  fi
  if [ -f .next/BUILD_ID ] && git_busy; then
    notify "Git merge or rebase in progress. Opening the last working version."
    return 0
  fi
  if [ -f .next/BUILD_ID ] && [ "$(cat "$FAILED_COMMIT_FILE" 2>/dev/null)" = "$head" ]; then
    notify "The last update failed. Opening the last working version."
    return 0
  fi

  notify "Updating Quran, this takes a few minutes…"
  local backup="$SUPPORT_DIR/previous-build"
  mkdir -p "$SUPPORT_DIR"
  rm -rf "$backup"
  if [ -f .next/BUILD_ID ]; then
    cp -cR .next "$backup" # APFS clone: instant, no extra space
  fi
  if build; then
    rm -rf "$backup" "$FAILED_COMMIT_FILE"
    return 0
  fi
  echo "$head" >"$FAILED_COMMIT_FILE"
  if [ -d "$backup" ]; then
    rm -rf .next
    mv "$backup" .next
    notify "Update failed. Opening the last working version."
    return 0
  fi
  return 1
}

open_window() {
  mkdir -p "$SUPPORT_DIR/chrome-profile"
  # A separate Chrome instance with its own profile, so the launcher can tell when its window is
  # closed. The profile is kept, so settings and reading position persist between launches.
  "$CHROME" --user-data-dir="$SUPPORT_DIR/chrome-profile" \
    --remote-debugging-port="$DEVTOOLS_PORT" --remote-debugging-address=127.0.0.1 \
    --no-first-run --no-default-browser-check --app="$APP_URL" >/dev/null 2>&1 &
  CHROME_PID=$!
  PIDS+=("$CHROME_PID")
}

has_open_pages() {
  curl -s -m 2 "http://$HOST:$DEVTOOLS_PORT/json/list" | grep -q '"type": "page"'
}

run() {
  mkdir -p "$LOG_DIR"
  exec >>"$LOG_DIR/app.log" 2>&1
  echo "--- $(date) run"

  # Already open: just bring up another window in the running instance.
  if curl -s -o /dev/null "$APP_URL" && curl -s -o /dev/null "http://$HOST:$DEVTOOLS_PORT/json/version"; then
    "$CHROME" --user-data-dir="$SUPPORT_DIR/chrome-profile" --app="$APP_URL" >/dev/null 2>&1 &
    return 0
  fi

  if ! build_if_needed; then
    notify "Quran failed to build. See ~/Library/Logs/quran-local/app.log"
    return 1
  fi
  start_gateway
  node_modules/.bin/next start -H "$HOST" -p "$APP_PORT" &
  PIDS+=($!)
  wait_for_url "$APP_URL/" || {
    notify "Quran failed to start. See ~/Library/Logs/quran-local/app.log"
    return 1
  }

  open_window
  wait_for_url "http://$HOST:$DEVTOOLS_PORT/json/version" || true

  # Stay until the window is closed (no pages left) or the Chrome instance quits.
  while kill -0 "$CHROME_PID" 2>/dev/null && has_open_pages; do
    sleep 2
  done
  echo "--- $(date) window closed, stopping"
}

make_app() {
  local app="$HOME/Applications/Quran.app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

  cat >"$app/Contents/MacOS/Quran" <<EOF
#!/bin/bash
exec /bin/bash "$REPO_DIR/scripts/local-dev/local-app.sh" run
EOF
  chmod +x "$app/Contents/MacOS/Quran"

  # Icon: the app's logo as a rounded macOS-style tile (1024px, rendered from
  # public/images/logo/Logo.svg on Apple's icon grid: 824px rounded square, soft shadow).
  local icon=scripts/local-dev/app-icon.png iconset
  iconset="$(mktemp -d)/Quran.iconset"
  mkdir -p "$iconset"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$icon" --out "$iconset/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$icon" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset" -o "$app/Contents/Resources/Quran.icns"

  # LSUIElement: the launcher has no Dock icon of its own; the Quran window is what you see.
  cat >"$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Quran</string>
  <key>CFBundleDisplayName</key><string>Quran</string>
  <key>CFBundleIdentifier</key><string>local.quran-app</string>
  <key>CFBundleExecutable</key><string>Quran</string>
  <key>CFBundleIconFile</key><string>Quran</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF
  touch "$app"
  # Make Finder, Dock and Spotlight pick up the new icon instead of a cached one.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app" >/dev/null 2>&1 || true
  echo "Created $app"
}

case "${1:-}" in
  build) build ;;
  start)
    [ -f .next/BUILD_ID ] || build
    start_gateway
    node_modules/.bin/next start -H "$HOST" -p "$APP_PORT"
    ;;
  run) run ;;
  make-app) make_app ;;
  *)
    echo "usage: $0 make-app|run|build|start" >&2
    exit 2
    ;;
esac
