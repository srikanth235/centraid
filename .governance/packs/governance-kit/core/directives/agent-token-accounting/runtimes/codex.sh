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
#   CODEX_TRANSCRIPT_PATH   absolute path to the session JSONL
#   CODEX_SESSIONS_DIR      override ~/.codex/sessions
#   CODEX_THREAD_ID         the thread/session id (otherwise derived from filename)

set -u

CODEX_SESSIONS="${CODEX_SESSIONS_DIR:-${HOME}/.codex/sessions}"
CODEX_ARCHIVED_SESSIONS="${CODEX_ARCHIVED_SESSIONS_DIR:-${HOME}/.codex/archived_sessions}"

TRANSCRIPT="${CODEX_TRANSCRIPT_PATH:-}"
if [[ -z "$TRANSCRIPT" ]]; then
    if [[ -n "${CODEX_THREAD_ID:-}" ]]; then
        for dir in "$CODEX_SESSIONS" "$CODEX_ARCHIVED_SESSIONS"; do
            [[ -d "$dir" ]] || continue
            TRANSCRIPT="$(find "$dir" -type f -name "*${CODEX_THREAD_ID}*.jsonl" -print 2>/dev/null | head -n1)"
            [[ -n "$TRANSCRIPT" ]] && break
        done
    fi
    if [[ -z "$TRANSCRIPT" && -d "$CODEX_SESSIONS" ]]; then
        TRANSCRIPT="$(find "$CODEX_SESSIONS" -type f -name "*.jsonl" -print0 2>/dev/null \
            | xargs -0 ls -t 2>/dev/null \
            | head -n1)"
    fi
fi

[[ -z "$TRANSCRIPT" || ! -f "$TRANSCRIPT" ]] && exit 1

# Read cumulative tokens across the common Codex transcript shapes:
#   - Codex Desktop event_msg token_count.info.total_token_usage
#   - top-level usage / message.usage / response.usage dictionaries
#   - OpenAI input_tokens_details.cached_tokens dictionaries
#   - prompt_tokens / completion_tokens fallback keys
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

def pull(u):
    """Return (input, cache_create, cache_read, output) from a usage dict."""
    if not isinstance(u, dict):
        return 0, 0, 0, 0
    i  = u.get("input_tokens")  or u.get("prompt_tokens")     or 0
    o  = u.get("output_tokens") or u.get("completion_tokens") or 0
    cc = u.get("cache_creation_input_tokens", 0) or 0
    cr = u.get("cache_read_input_tokens", 0) or 0
    # OpenAI-style cached input is a subset of input tokens, not an additional
    # bucket. Split it out so pricing uses cached-input rates for those tokens.
    if not cr:
        cr = u.get("cached_input_tokens", 0) or 0
    details = u.get("input_tokens_details") or u.get("prompt_tokens_details")
    if not cr and isinstance(details, dict):
        cr = details.get("cached_tokens", 0) or 0
    try:
        i = int(i or 0)
        cc = int(cc or 0)
        cr = int(cr or 0)
        o = int(o or 0)
    except (TypeError, ValueError):
        return 0, 0, 0, 0
    # Only OpenAI cached-input fields are included in input_tokens. Anthropic
    # cache_read_input_tokens is already separate, so do not subtract it.
    if ("cached_input_tokens" in u) or isinstance(details, dict):
        i = max(i - cr, 0)
    return i, cc, cr, o

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
        # Model can live at any of several places depending on transcript version.
        for container in (d, payload, d.get("message"), d.get("response")):
            if isinstance(container, dict):
                m = container.get("model") or container.get("model_slug") or container.get("model_id")
                if isinstance(m, str) and m:
                    model = m
                    break
                collaboration = container.get("collaboration_mode")
                if isinstance(collaboration, dict):
                    settings = collaboration.get("settings")
                    if isinstance(settings, dict):
                        m = settings.get("model")
                        if isinstance(m, str) and m:
                            model = m
                            break
        if payload and payload.get("type") == "token_count":
            info = payload.get("info")
            total = info.get("total_token_usage") if isinstance(info, dict) else None
            if isinstance(total, dict):
                latest_total = pull(total)
                continue
        for container in (
            d,
            payload,
            d.get("message")  if isinstance(d.get("message"),  dict) else None,
            d.get("response") if isinstance(d.get("response"), dict) else None,
        ):
            if container is None:
                continue
            u = container.get("usage") if container is not d else container.get("usage", container)
            i, cc, cr, o = pull(u if isinstance(u, dict) else {})
            if i or o or cc or cr:
                t_input        += i
                t_cache_create += cc
                t_cache_read   += cr
                t_output       += o
                break
if latest_total is not None:
    t_input, t_cache_create, t_cache_read, t_output = latest_total
if not sid:
    base = path.rsplit("/", 1)[-1]
    if base.endswith(".jsonl"):
        base = base[:-6]
    sid = base.split("rollout-", 1)[-1] if base.startswith("rollout-") else base
print(f"{sid} {t_input} {t_cache_create} {t_cache_read} {t_output} {model or 'unknown'}")
PY
)"
read -r SESSION_ID CUM_INPUT CUM_CACHE_CREATE CUM_CACHE_READ CUM_OUTPUT MODEL <<<"$OUT"

printf '%s %s %s %s %s %s\n' \
    "$SESSION_ID" "${CUM_INPUT:-0}" "${CUM_CACHE_CREATE:-0}" "${CUM_CACHE_READ:-0}" "${CUM_OUTPUT:-0}" "${MODEL:-unknown}"
