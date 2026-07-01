#!/usr/bin/env bash
# Codex transcript reader.
#
# Output on success (one line to stdout, space-separated):
#   <session_id> <cum_input> <cum_cache_create> <cum_cache_read> <cum_output> <model>
# Exit non-zero if no transcript can be located.
#
# Codex transcripts report OpenAI cached input as a subset of input tokens.
# The ledger wants lossless split columns, so this reader records:
#   input       = input_tokens - cached_input_tokens
#   cache_read  = cached_input_tokens
#   cache_create = 0
# Keeping the shape identical to claude-code.sh lets the caller treat all
# runtime readers uniformly.
#
# Environment overrides:
#   CODEX_TRANSCRIPT_PATH    absolute path to the session JSONL
#   CODEX_SESSIONS_DIR       override ~/.codex/sessions
#   CODEX_ARCHIVED_SESSIONS_DIR override ~/.codex/archived_sessions
#   CODEX_THREAD_ID          the live thread/session id (exported into the hook
#                            env by Codex) — names the transcript.

set -u

CODEX_SESSIONS="${CODEX_SESSIONS_DIR:-${HOME}/.codex/sessions}"
CODEX_ARCHIVED_SESSIONS="${CODEX_ARCHIVED_SESSIONS_DIR:-${HOME}/.codex/archived_sessions}"

TRANSCRIPT="${CODEX_TRANSCRIPT_PATH:-}"
if [[ -z "$TRANSCRIPT" ]]; then
    [[ -n "${CODEX_THREAD_ID:-}" ]] || exit 1
    for dir in "$CODEX_SESSIONS" "$CODEX_ARCHIVED_SESSIONS"; do
        [[ -d "$dir" ]] || continue
        TRANSCRIPT="$(find "$dir" -type f -name "*${CODEX_THREAD_ID}.jsonl" -print 2>/dev/null | LC_ALL=C sort | head -n1)"
        [[ -n "$TRANSCRIPT" ]] && break
    done
fi

[[ -z "$TRANSCRIPT" || ! -f "$TRANSCRIPT" ]] && exit 1

# Read cumulative tokens from the current Codex Desktop transcript shape:
#   - session_meta.payload.id carries the session id
#   - turn_context.payload.collaboration_mode.settings.model carries the model
#   - event_msg.payload.info.total_token_usage carries cumulative tokens
OUT="$(python3 - "$TRANSCRIPT" "${CODEX_THREAD_ID:-}" <<'PY'
import json, sys
path = sys.argv[1]
env_sid = sys.argv[2]
sid = env_sid or ""
t_input = 0
t_cache_create = 0
t_cache_read = 0
t_output = 0
model = ""
latest_total = None

def pull_total(total):
    i = total.get("input_tokens", 0) or 0
    cr = total.get("cached_input_tokens", 0) or 0
    o = total.get("output_tokens", 0) or 0
    try:
        i = int(i or 0)
        cr = int(cr or 0)
        o = int(o or 0)
    except (TypeError, ValueError):
        return 0, 0, 0, 0
    return max(i - cr, 0), 0, cr, o

with open(path) as f:
    for line in f:
        try:
            d = json.loads(line)
        except Exception:
            continue
        payload = d.get("payload") if isinstance(d.get("payload"), dict) else None
        if not sid and payload and d.get("type") == "session_meta":
            candidate = payload.get("id")
            if isinstance(candidate, str) and candidate:
                sid = candidate
        collaboration = payload.get("collaboration_mode") if payload else None
        settings = collaboration.get("settings") if isinstance(collaboration, dict) else None
        m = settings.get("model") if isinstance(settings, dict) else None
        if isinstance(m, str) and m:
            model = m
        if payload and payload.get("type") == "token_count":
            info = payload.get("info")
            total = info.get("total_token_usage") if isinstance(info, dict) else None
            if isinstance(total, dict):
                latest_total = pull_total(total)
if latest_total is not None:
    t_input, t_cache_create, t_cache_read, t_output = latest_total
if not sid:
    sys.exit(2)
print(f"{sid} {t_input} {t_cache_create} {t_cache_read} {t_output} {model or 'unknown'}")
PY
)"
read -r SESSION_ID CUM_INPUT CUM_CACHE_CREATE CUM_CACHE_READ CUM_OUTPUT MODEL <<<"$OUT"

printf '%s %s %s %s %s %s\n' \
    "$SESSION_ID" "${CUM_INPUT:-0}" "${CUM_CACHE_CREATE:-0}" "${CUM_CACHE_READ:-0}" "${CUM_OUTPUT:-0}" "${MODEL:-unknown}"
