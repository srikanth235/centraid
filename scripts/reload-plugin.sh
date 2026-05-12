#!/usr/bin/env bash
# Rebuild @centraid/openclaw-plugin, ensure it's link-installed in the local
# OpenClaw gateway, and restart the gateway so the new code is live.
#
# Usage:  scripts/reload-plugin.sh [--port 18789] [--no-build]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/packages/openclaw-plugin"
PLUGIN_ID="centraid"
PORT="18789"
DO_BUILD=1
LOG_FILE="${OPENCLAW_GATEWAY_LOG:-$REPO_ROOT/.openclaw-gateway.log}"

# Load repo-root .env so OPENCLAW_GATEWAY_TOKEN (and friends) are visible when
# this script is invoked directly. `bun run reload-plugin` already loads it,
# so this is a no-op in that path.
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a; source "$REPO_ROOT/.env"; set +a
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --no-build) DO_BUILD=0; shift ;;
    -h|--help)
      sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# openclaw requires Node >= 22.12 — load nvm so we don't inherit a stale shell node.
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"
nvm use default >/dev/null

command -v openclaw >/dev/null || { echo "openclaw CLI not found on PATH" >&2; exit 1; }
command -v bun     >/dev/null || { echo "bun not found on PATH"          >&2; exit 1; }

if [[ "$DO_BUILD" -eq 1 ]]; then
  echo "→ building @centraid/openclaw-plugin"
  (cd "$REPO_ROOT" && bun run --filter "@centraid/openclaw-plugin" build)
fi

if openclaw plugins list 2>/dev/null | grep -q "^│ $PLUGIN_ID\b\| $PLUGIN_ID "; then
  echo "→ $PLUGIN_ID already installed (link mode picks up rebuilds)"
else
  echo "→ link-installing $PLUGIN_ID from $PLUGIN_DIR"
  # --dangerously-force-unsafe-install: the plugin shells out to `openclaw cron`
  # via child_process (see packages/openclaw-plugin/README.md → "Cron registration").
  openclaw plugins install --link --dangerously-force-unsafe-install "$PLUGIN_DIR"
fi

UID_NUM="$(id -u)"
AGENT="gui/$UID_NUM/ai.openclaw.gateway"
if launchctl print "$AGENT" >/dev/null 2>&1; then
  # The user's gateway runs under a LaunchAgent that auto-respawns on exit —
  # spawning our own `openclaw gateway --force` races launchd and almost always
  # loses, leaving the old plugin code still loaded. `kickstart -k` tells
  # launchd to kill + restart, which is race-free.
  echo "→ restarting gateway via launchctl ($AGENT)"
  launchctl kickstart -k "$AGENT"
  GATEWAY_PID="$(launchctl print "$AGENT" 2>/dev/null | awk -F'= ' '/^[[:space:]]*pid =/ {print $2; exit}')"
else
  echo "→ restarting gateway on :$PORT (no launchd agent found, spawning directly)"
  nohup openclaw gateway --port "$PORT" --force >"$LOG_FILE" 2>&1 &
  GATEWAY_PID=$!
  disown "$GATEWAY_PID" 2>/dev/null || true
fi

AUTH_ARGS=()
if [[ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  AUTH_ARGS=(-H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN")
fi

# Wait for the listener to come back up.
for _ in $(seq 1 30); do
  if curl -sS -o /dev/null -w "%{http_code}" "${AUTH_ARGS[@]}" "http://127.0.0.1:$PORT/centraid/_apps" 2>/dev/null | grep -qE '^(200|401|403)$'; then
    break
  fi
  sleep 0.5
done

CODE="$(curl -sS -o /dev/null -w "%{http_code}" "${AUTH_ARGS[@]}" "http://127.0.0.1:$PORT/centraid/_apps" 2>/dev/null || true)"
CT="$(curl -sS -o /dev/null -w "%{content_type}" "${AUTH_ARGS[@]}" "http://127.0.0.1:$PORT/centraid/_apps" 2>/dev/null || true)"
RESP_HEAD="$(curl -sS "${AUTH_ARGS[@]}" "http://127.0.0.1:$PORT/centraid/_apps" 2>/dev/null | head -c 200 || true)"

if [[ "$RESP_HEAD" == "<!doctype"* || "$RESP_HEAD" == "<!DOCTYPE"* ]]; then
  echo "✗ /centraid/_apps fell through to the Control UI — plugin route not mounted." >&2
  echo "  Check $LOG_FILE for plugin load errors." >&2
  exit 1
fi
if [[ "$CODE" == "200" ]]; then
  echo "✓ /centraid plugin routes mounted, auth ok (PID $GATEWAY_PID, log: $LOG_FILE)"
elif [[ "$CODE" == "401" || "$CODE" == "403" ]]; then
  echo "✓ /centraid plugin routes mounted (HTTP $CODE — token missing or stale; set OPENCLAW_GATEWAY_TOKEN in .env)"
else
  echo "✓ /centraid plugin routes mounted (HTTP $CODE, content-type: $CT, PID $GATEWAY_PID, log: $LOG_FILE)"
fi
