#!/usr/bin/env bash
# Shared runtime detection + cumulative-token resolution for
# agent-token-accounting. Sourced by hooks/pre-commit.sh (the write path) and
# check.sh (runtime detection before commit-time endpoint reconciliation).
#
# The writer reads the transcript cumulative and freezes that coordinate under
# a staged-tree endpoint. The checker calls this only to decide whether an
# agent runtime is active; it then verifies the staged receipt row against the
# frozen endpoint rather than a moving live transcript.
#
# resolve_runtime_cumulative
#   Detects the active agent runtime from the environment and resolves the
#   session's cumulative token counters. On success sets the globals:
#     RUNTIME SESSION_ID CUM_INPUT CUM_CACHE_CREATE CUM_CACHE_READ CUM_OUTPUT MODEL
#   Return codes:
#     0 — runtime detected, cumulative resolved
#     1 — no agent runtime detected (a human / manual-git commit; caller no-ops)
#     2 — runtime detected but its transcript / coordinates were unreadable
#
# Detection mirrors the historical pre-commit contract:
#   AGENT_NAME set            → manual   (explicit AGENT_SESSION_ID / AGENT_CUM_*)
#   CLAUDECODE=1              → claude-code
#   CODEX_THREAD_ID or CODEX_TRANSCRIPT_PATH set → codex
#
# Per-runtime transcript readers live in sibling runtimes/<runtime>.sh and emit
#   <session_id> <cum_input> <cum_cache_create> <cum_cache_read> <cum_output> <model>
# Stdlib bash; Bash 3.2 compatible (macOS /bin/bash).

resolve_runtime_cumulative() {
    local here runtimes out
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    runtimes="$(cd "$here/../runtimes" && pwd)"

    RUNTIME=""
    SESSION_ID=""
    CUM_INPUT=0
    CUM_CACHE_CREATE=0
    CUM_CACHE_READ=0
    CUM_OUTPUT=0
    MODEL=""

    if [[ -n "${AGENT_NAME:-}" ]]; then
        RUNTIME="manual"
    elif [[ "${CLAUDECODE:-}" == "1" ]]; then
        RUNTIME="claude-code"
    elif [[ -n "${CODEX_THREAD_ID:-}" || -n "${CODEX_TRANSCRIPT_PATH:-}" ]]; then
        RUNTIME="codex"
    fi

    [[ -z "$RUNTIME" ]] && return 1

    case "$RUNTIME" in
        claude-code)
            out="$("$runtimes/claude-code.sh")" || return 2
            read -r SESSION_ID CUM_INPUT CUM_CACHE_CREATE CUM_CACHE_READ CUM_OUTPUT MODEL <<<"$out"
            ;;
        codex)
            out="$("$runtimes/codex.sh")" || return 2
            read -r SESSION_ID CUM_INPUT CUM_CACHE_CREATE CUM_CACHE_READ CUM_OUTPUT MODEL <<<"$out"
            ;;
        manual)
            # Explicit coordinates via env — the test seam and the escape hatch
            # for runtimes that report cumulative counters out-of-band.
            [[ -n "${AGENT_SESSION_ID:-}" && -n "${AGENT_CUM_INPUT:-}" && -n "${AGENT_CUM_OUTPUT:-}" ]] || return 2
            SESSION_ID="$AGENT_SESSION_ID"
            CUM_INPUT="$AGENT_CUM_INPUT"
            CUM_CACHE_CREATE="${AGENT_CUM_CACHE_CREATE:-0}"
            CUM_CACHE_READ="${AGENT_CUM_CACHE_READ:-0}"
            CUM_OUTPUT="$AGENT_CUM_OUTPUT"
            MODEL="${AGENT_MODEL:-unknown}"
            ;;
    esac

    MODEL="${MODEL:-unknown}"

    # Cumulative counters must be non-negative integers.
    local var val
    for var in CUM_INPUT CUM_CACHE_CREATE CUM_CACHE_READ CUM_OUTPUT; do
        val="${!var}"
        [[ "$val" =~ ^[0-9]+$ ]] || return 2
    done
    return 0
}
