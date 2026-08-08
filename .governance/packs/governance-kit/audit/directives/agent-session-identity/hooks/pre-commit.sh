#!/usr/bin/env bash
# Stamp the active agent session into the issue receipt before Git snapshots it.

set -u
[ "${SKIP_GOVERNANCE:-0}" = "1" ] && exit 0

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
HERE="$(cd "$(dirname "$0")" && pwd)" || exit 0
LIB="$HERE/../lib"
GOV_LIB="$HERE/../../../../../../lib.sh"
[ -f "$GOV_LIB" ] && source "$GOV_LIB"
source "$LIB/runtime.sh"
source "$LIB/receipt.sh"

detect_runtime_identity || exit 0

grandparent_pid() {
    local pid="$PPID"
    if [ -r "/proc/$pid/status" ]; then awk '/^PPid:/ {print $2}' "/proc/$pid/status"; else ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' '; fi
}
parent_argv_string() {
    local pid="$1"
    if [ -r "/proc/$pid/cmdline" ]; then tr '\0' ' ' < "/proc/$pid/cmdline"; else ps -ww -p "$pid" -o args= 2>/dev/null; fi
}

ISSUE="${AGENT_ISSUE:-}"
GIT_PID="$(grandparent_pid)"
ARGV="$(parent_argv_string "${GIT_PID:-$PPID}")"
[[ "$ARGV" == *git* ]] || ARGV="$(parent_argv_string "$PPID")"
if [ -z "$ISSUE" ] && [[ "$ARGV" =~ \(#([1-9][0-9]*)\) ]]; then ISSUE="#${BASH_REMATCH[1]}"; fi
if [ -z "$ISSUE" ]; then
    printf 'agent-session-identity: active runtime %s has no issue anchor; use commit subject (#N) or AGENT_ISSUE.\n' "$RUNTIME" >&2
    exit 1
fi

RECEIPTS_NAME="$(conf_get agent-session-identity RECEIPTS_DIR "$HERE/../directive.yaml")"
RECEIPTS_DIR="$ROOT/$RECEIPTS_NAME"
RECEIPT="$(receipt_resolve "$RECEIPTS_DIR" "$ISSUE")"
session_upsert "$RECEIPT" "$(date -u +%F)" "$RUNTIME" "$SESSION_ID"
git add "$RECEIPT"
printf 'agent-session-identity: harness=%s session=%s receipt=%s\n' "$RUNTIME" "$SESSION_ID" "$RECEIPT" >&2
exit 0
