#!/usr/bin/env bash
# Keep the map's chat server running on this machine.
#
#   chat/service.sh install     start it at login, and again whenever it stops
#   chat/service.sh update      move it to the latest main and restart it
#   chat/service.sh status      what runs, from which commit, and whether it answers
#   chat/service.sh uninstall   stop it and take it off the login
#
# It runs from a worktree of its own, detached at origin/main — never from the
# checkout you work in. The published map draws main's hai-data.js and the chat
# must answer from that same file (spec invariant 17), not from whatever branch
# or half-regenerated payload the working checkout holds that day. So a merge
# reaches the published chat when `update` is run, and not before.
#
# launchd starts it at login: with automatic login on, a reboot brings it back
# unattended. Ollama and the Tailscale Funnel in front of it are separate —
# Ollama.app opens at login, and Funnel's configuration persists in tailscaled.
set -euo pipefail

LABEL=com.marota.hai-chat
REPO=$(cd "$(dirname "$0")/.." && pwd)
LIVE=${HAI_CHAT_LIVE:-$HOME/Dev/human-ai-collaboration-live}
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
LOG=$HOME/Library/Logs/hai-chat.log
PYTHON=${HAI_CHAT_PYTHON:-$(command -v python3)}
PORT=${HAI_CHAT_PORT:-8765}
DOMAIN=gui/$(id -u)

say() { printf '%s\n' "$*"; }

answering() {
  for _ in $(seq 1 60); do
    curl -fs --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null && return 0
    sleep 0.5
  done
  return 1
}

managed() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

live_at_main() {
  git -C "$REPO" fetch --quiet origin main
  if [ -d "$LIVE" ]; then
    git -C "$LIVE" checkout --quiet --detach origin/main
  else
    git -C "$REPO" worktree add --quiet --detach "$LIVE" origin/main
  fi
  say "  live     $LIVE"
  say "           at $(git -C "$LIVE" log --oneline -1)"
}

write_plist() {
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
  # gh lives in Homebrew's bin, which launchd's own PATH does not have, and the
  # log is unbuffered so it says what happened when it happened.
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON</string>
    <string>chat/server.py</string>
    <string>--port</string>
    <string>$PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$LIVE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>PYTHONUNBUFFERED</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
  plutil -lint "$PLIST" >/dev/null
}

case "${1:-}" in
  install)
    # launchd would restart a server that cannot bind its port forever, so a
    # port already taken by something it does not manage is a stop, not a retry.
    if ! managed && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      say "Port $PORT is already taken by a process launchd does not manage:"
      lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | sed 's/^/  /'
      say "Stop it first, then run install again."
      exit 1
    fi
    live_at_main
    write_plist
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    if answering; then
      say "  running  http://127.0.0.1:$PORT — at login, and again whenever it stops"
    else
      say "  not answering yet — see $LOG"
      exit 1
    fi
    ;;
  update)
    managed || { say "Not installed: run $0 install"; exit 1; }
    live_at_main
    launchctl kickstart -k "$DOMAIN/$LABEL"
    if answering; then say "  restarted on main"; else say "  not answering — see $LOG"; exit 1; fi
    ;;
  status)
    if managed; then
      # Top-level keys only: they sit one tab in, nested blocks repeat "state".
      launchctl print "$DOMAIN/$LABEL" | grep -E $'^\t(state|pid|runs|last exit code) =' \
        | sed 's/^[[:space:]]*/  /'
    else
      say "  not installed"
    fi
    if [ -d "$LIVE" ]; then
      say "  live     $(git -C "$LIVE" log --oneline -1)"
      say "  main     $(git -C "$REPO" log --oneline -1 origin/main)"
    fi
    if curl -fs --max-time 3 "http://127.0.0.1:$PORT/api/health" >/dev/null; then
      say "  health   answering on :$PORT"
    else
      say "  health   NOT answering on :$PORT"
    fi
    if command -v tailscale >/dev/null; then
      tailscale funnel status 2>/dev/null | grep -E "\(Funnel on\)" | sed 's/^/  funnel   /' || true
    fi
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    say "  stopped, and off the login. The worktree stays; remove it with:"
    say "    git -C $REPO worktree remove $LIVE"
    ;;
  *)
    sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
