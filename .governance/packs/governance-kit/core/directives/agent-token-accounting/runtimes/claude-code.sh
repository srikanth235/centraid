#!/usr/bin/env bash
# Claude Code transcript reader.
#
# Output on success (one line to stdout, space-separated):
#   <session_id> <cum_input> <cum_cache_create> <cum_cache_read> <cum_output> <model>
# Exit non-zero if no transcript can be located.
#
# `model` is the latest `message.model` seen on any assistant entry; used by
# lib/rates.py to compute cost_usd. If absent, printed as the literal string
# `unknown` — which the rate lookup can't price, so the pre-commit hook
# blocks the commit (Cost-USD is mandatory). Export AGENT_MODEL manually
# to override when the transcript genuinely doesn't carry a model id.
#
# The four token numbers are cumulative across the whole session transcript;
# the caller (agent-accounting.sh) subtracts prior ledger rows to get the
# per-commit delta.
#
# Environment overrides:
#   CLAUDE_TRANSCRIPT_PATH   absolute path to the session JSONL
#   CLAUDE_PROJECTS_DIR      override ~/.claude/projects

set -u

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
CLAUDE_PROJECTS="${CLAUDE_PROJECTS_DIR:-${HOME}/.claude/projects}"

encode_path() {
    # Replace every `/` and `.` with `-`, matching Claude Code's project-dir convention.
    printf '%s' "$1" | sed -E 's#[/.]#-#g'
}

TRANSCRIPT="${CLAUDE_TRANSCRIPT_PATH:-}"
if [[ -z "$TRANSCRIPT" ]]; then
    for candidate in "$REPO_ROOT" "$PWD"; do
        dir="$CLAUDE_PROJECTS/$(encode_path "$candidate")"
        if [[ -d "$dir" ]]; then
            TRANSCRIPT="$(ls -t "$dir"/*.jsonl 2>/dev/null | head -n1)"
            [[ -n "$TRANSCRIPT" ]] && break
        fi
    done
fi

# Cross-worktree fallback: the cwd-encoded lookup above misses when the
# user starts a Claude session in worktree A and runs `git commit` from
# worktree B (different `git rev-parse --show-toplevel`, so a different
# encoded project dir). When CLAUDECODE=1 confirms a live session, the
# active transcript is being written to *now* — so the most recently
# modified `.jsonl` anywhere under CLAUDE_PROJECTS is almost always it.
# A 10-minute mtime window keeps long-closed sessions out. If multiple
# Claude sessions are running concurrently, set CLAUDE_TRANSCRIPT_PATH
# explicitly to disambiguate.
if [[ -z "$TRANSCRIPT" && "${CLAUDECODE:-}" == "1" && -d "$CLAUDE_PROJECTS" ]]; then
    candidate=""
    while IFS= read -r f; do
        if [[ -z "$candidate" || "$f" -nt "$candidate" ]]; then
            candidate="$f"
        fi
    done < <(find "$CLAUDE_PROJECTS" -type f -name '*.jsonl' -mmin -10 2>/dev/null)
    [[ -n "$candidate" && -f "$candidate" ]] && TRANSCRIPT="$candidate"
fi

[[ -z "$TRANSCRIPT" || ! -f "$TRANSCRIPT" ]] && exit 1

# The four usage fields are reported separately so the ledger can split:
#   input_tokens                  → new tokens this turn (not from cache)
#   cache_creation_input_tokens   → tokens written to the prompt cache
#   cache_read_input_tokens       → tokens re-read from the prompt cache
#   output_tokens                 → model output
python3 - "$TRANSCRIPT" <<'PY'
import json, sys
path = sys.argv[1]
sid = None
model = ""
t_input = 0
t_cache_create = 0
t_cache_read = 0
t_output = 0
with open(path) as f:
    for line in f:
        try:
            d = json.loads(line)
        except Exception:
            continue
        if sid is None and d.get("sessionId"):
            sid = d["sessionId"]
        msg = d.get("message") if isinstance(d.get("message"), dict) else None
        if not msg:
            continue
        # Track model from whichever assistant entry carries it. Latest wins
        # so mid-session /model switches propagate forward.
        m = msg.get("model")
        if isinstance(m, str) and m and m != "<synthetic>":
            model = m
        usage = msg.get("usage")
        if not isinstance(usage, dict):
            continue
        t_input        += int(usage.get("input_tokens", 0) or 0)
        t_cache_create += int(usage.get("cache_creation_input_tokens", 0) or 0)
        t_cache_read   += int(usage.get("cache_read_input_tokens", 0) or 0)
        t_output       += int(usage.get("output_tokens", 0) or 0)
if sid is None:
    sys.exit(2)
print(f"{sid} {t_input} {t_cache_create} {t_cache_read} {t_output} {model or 'unknown'}")
PY
