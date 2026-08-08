#!/usr/bin/env bash
# Harness-neutral session identity detection for agent-session-identity.
#
# This file deliberately knows only identity signals. It never reads a
# harness-owned file, transcript, session database, or usage surface.

set -u

_gov_git_dir() {
    local d
    d="$(git rev-parse --absolute-git-dir 2>/dev/null)" && [ -n "$d" ] && {
        printf '%s\n' "$d"
        return 0
    }
    d="$(git rev-parse --git-dir 2>/dev/null)" || return 1
    case "$d" in
        /*) printf '%s\n' "$d" ;;
        *) printf '%s/%s\n' "$(pwd)" "$d" ;;
    esac
}

identity_file() {
    local d
    d="$(_gov_git_dir)" || return 1
    printf '%s/governance/session-identity\n' "$d"
}

identity_get() {
    local f
    f="$(identity_file)" || return 0
    [ -f "$f" ] || return 0
    IDENTITY_KEY="$1" awk '
BEGIN { key = ENVIRON["IDENTITY_KEY"] }
index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }
' "$f"
}

_identity_fresh() {
    local epoch now max manifest runtime_dir
    epoch="$(identity_get epoch)"
    case "$epoch" in ''|*[!0-9]*) return 1 ;; esac
    runtime_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    manifest="$runtime_dir/../directive.yaml"
    if declare -F conf_get >/dev/null 2>&1 && [ -f "$manifest" ]; then
        max="$(conf_get agent-session-identity SESSION_MAX_AGE_HOURS "$manifest" 2>/dev/null || printf '24')"
    else
        max=24
    fi
    case "$max" in ''|*[!0-9]*) return 1 ;; esac
    now="$(date +%s)"
    [ $((now - epoch)) -lt $((max * 3600)) ]
}

# detect_runtime_identity sets RUNTIME and SESSION_ID.
# RUNTIME is empty and the function returns 1 for a human/plain-git commit.
detect_runtime_identity() {
    RUNTIME=""
    SESSION_ID="-"

    if [ -n "${GOVERNANCE_HARNESS:-}" ]; then
        RUNTIME="$GOVERNANCE_HARNESS"
        SESSION_ID="${GOVERNANCE_SESSION_ID:--}"
    elif [ -n "${AGENT_NAME:-}" ]; then
        RUNTIME="manual"
        SESSION_ID="${AGENT_SESSION_ID:-manual}"
    elif [ "${CLAUDECODE:-}" = "1" ]; then
        RUNTIME="claude-code"
        SESSION_ID="${CLAUDE_CODE_SESSION_ID:--}"
    elif [ -n "${CODEX_THREAD_ID:-}" ]; then
        RUNTIME="codex"
        SESSION_ID="$CODEX_THREAD_ID"
    elif [ "${PI_CODING_AGENT:-}" = "true" ] || [ -n "${PI_SESSION_ID:-}" ]; then
        RUNTIME="pi"
        SESSION_ID="${PI_SESSION_ID:--}"
    elif [ "${CURSOR_AGENT:-}" = "1" ]; then
        RUNTIME="cursor-agent"
        SESSION_ID="${CURSOR_SESSION_ID:--}"
    elif [ "${OPENCODE:-}" = "1" ] || [ -n "${OPENCODE_SERVER:-}" ]; then
        RUNTIME="opencode"
        SESSION_ID="${OPENCODE_SESSION_ID:--}"
    elif _identity_fresh && [ -n "$(identity_get harness)" ]; then
        RUNTIME="$(identity_get harness)"
        SESSION_ID="$(identity_get session)"
    fi

    [ -n "$RUNTIME" ] || return 1
    [ -n "$SESSION_ID" ] || SESSION_ID="-"
    return 0
}
