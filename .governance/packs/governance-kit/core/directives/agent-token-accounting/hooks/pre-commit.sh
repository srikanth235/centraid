#!/usr/bin/env bash
# Agent token accounting — invoked from the pre-commit hook.
#
# This is what makes `git commit` the baseline for agent-authored commits.
# The pre-commit hook runs it before governance tests; if the commit is
# agent-authored, it appends the ledger row and `git add`s it (so the row
# lands in the CURRENT commit's tree), then writes a handoff file that
# prepare-commit-msg reads to stamp matching trailers onto the message.
#
# Why not do this in prepare-commit-msg directly: by the time that hook runs,
# git has already snapshotted the tree for the commit. `git add` from there
# lands in the NEXT commit's index, not this one.
#
# Runtime detection is automatic from the environment:
#   CLAUDECODE=1                 → claude-code
#   CODEX_THREAD_ID set          → codex
#   AGENT_NAME set manually      → whatever the user said, with explicit
#                                   AGENT_SESSION_ID / AGENT_CUM_INPUT /
#                                   AGENT_CUM_CACHE_CREATE /
#                                   AGENT_CUM_CACHE_READ / AGENT_CUM_OUTPUT
# Otherwise the commit is treated as a human commit and this script no-ops.
#
# Issue anchor inference reads the parent git process's argv via
# /proc/$PPID/cmdline (Linux) or sysctl(KERN_PROCARGS2) via lib/argv.py (macOS)
# to find a `(#N)` in the -m / --message subject. Set AGENT_ISSUE='#N'
# explicitly to skip inference (useful for editor-mode commits where argv has
# no -m).
#
# All COSTS.md parsing / summing / appending goes through
# sibling lib/ledger.py — bash here only handles git plumbing,
# environment detection, argv walking, and the env-file handoff.
# Per-runtime transcript readers live in sibling runtimes/<runtime>.sh.

set -u

if [[ "${SKIP_GOVERNANCE:-0}" == "1" ]]; then
    exit 0
fi

# ── Detect runtime ─────────────────────────────────────────────
RUNTIME=""
if [[ -n "${AGENT_NAME:-}" ]]; then
    RUNTIME="manual"
elif [[ "${CLAUDECODE:-}" == "1" ]]; then
    RUNTIME="claude-code"
elif [[ -n "${CODEX_THREAD_ID:-}" ]]; then
    RUNTIME="codex"
fi

# Not an agent commit — exit silently. Humans committing manually hit this path.
[[ -z "$RUNTIME" ]] && exit 0

ROOT="$(git rev-parse --show-toplevel)"
HERE="$(cd "$(dirname "$0")" && pwd)"
RULE_DIR="$(cd "$HERE/.." && pwd)"
LEDGER="$ROOT/COSTS.md"
LIB="$RULE_DIR/lib"
RUNTIMES="$RULE_DIR/runtimes"
# In a worktree `.git` is a pointer file, not a directory. Use rev-parse
# to locate the real per-worktree git dir so the handoff file writes cleanly.
HANDOFF="$(git rev-parse --git-path governance-pending.env)"

# ── Read git's argv to recover the -m / --message subject ─────
# This script runs as: git → pre-commit hook → bash agent-accounting.sh.
# $PPID is the hook, not git. Walk up one more level to find git.
grandparent_pid() {
    local pid="$PPID"
    if [[ -r "/proc/$pid/status" ]]; then
        awk '/^PPid:/ {print $2}' "/proc/$pid/status"
    else
        ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' '
    fi
}

parent_argv_string() {
    local pid="$1"
    if [[ -r "/proc/$pid/cmdline" ]]; then
        tr '\0' ' ' < "/proc/$pid/cmdline"
    elif [[ "$(uname -s)" == "Darwin" ]]; then
        # macOS `ps -o args=` cat-v-escapes bytes >= 0x80 under LC_ALL=C
        # (the locale git hooks usually run with), mangling UTF-8 in the
        # commit subject. Read raw argv bytes via sysctl(KERN_PROCARGS2).
        # See issue #140.
        python3 "$LIB/argv.py" "$pid" 2>/dev/null | tr '\0' ' '
    else
        ps -ww -p "$pid" -o args= 2>/dev/null
    fi
}

GIT_PID="$(grandparent_pid)"
ARGV="$(parent_argv_string "${GIT_PID:-$PPID}")"
# Fallback to the immediate parent if the grandparent argv doesn't look
# like a git commit invocation (e.g. a rebase driving the hook).
if [[ "$ARGV" != *git* ]]; then
    ARGV="$(parent_argv_string "$PPID")"
fi

# ── Infer the issue anchor ─────────────────────────────────────
ISSUE="${AGENT_ISSUE:-}"
if [[ -z "$ISSUE" && "$ARGV" =~ \(#([1-9][0-9]*)\) ]]; then
    ISSUE="#${BASH_REMATCH[1]}"
fi
if [[ -z "$ISSUE" ]]; then
    cat >&2 <<EOF

────────────────────────────────────────
✗ Agent commit blocked by governance.

Detected agent runtime: $RUNTIME
Could not infer issue anchor from the commit subject.

Pass '(#N)' in the subject:
    git commit -m "feat: thing (#123)"

Or set AGENT_ISSUE explicitly (useful for editor-mode commits):
    AGENT_ISSUE='#123' git commit
────────────────────────────────────────
EOF
    exit 1
fi

# ── Pull a subject for the ledger's note column (best-effort) ──
# BSD ps escapes newlines in args as literal `\012` sequences; ledger.py's
# _safe_cell truncates at the first backslash on write, so here we just
# pass the raw captured blob through.
SUBJECT=""
if [[ "$ARGV" =~ [[:space:]](-m|--message)[[:space:]]+(.+) ]]; then
    SUBJECT="${BASH_REMATCH[2]}"
elif [[ "$ARGV" =~ --message=(.+) ]]; then
    SUBJECT="${BASH_REMATCH[1]}"
fi

# ── Runtime dispatch: get session id + cumulative tokens + model ───
SESSION_ID=""
CUM_INPUT=0
CUM_CACHE_CREATE=0
CUM_CACHE_READ=0
CUM_OUTPUT=0
MODEL=""
case "$RUNTIME" in
    claude-code)
        if ! out="$("$RUNTIMES/claude-code.sh")"; then
            echo "✗ claude-code: transcript not found or unreadable" >&2
            exit 1
        fi
        read -r SESSION_ID CUM_INPUT CUM_CACHE_CREATE CUM_CACHE_READ CUM_OUTPUT MODEL <<<"$out"
        AGENT_NAME="claude-code"
        ;;
    codex)
        if ! out="$("$RUNTIMES/codex.sh")"; then
            echo "✗ codex: transcript not found or unreadable" >&2
            exit 1
        fi
        read -r SESSION_ID CUM_INPUT CUM_CACHE_CREATE CUM_CACHE_READ CUM_OUTPUT MODEL <<<"$out"
        AGENT_NAME="codex"
        ;;
    manual)
        require() {
            if [[ -z "${!1:-}" ]]; then
                echo "✗ AGENT_NAME=$AGENT_NAME set manually but \$$1 is unset" >&2
                exit 1
            fi
        }
        require AGENT_SESSION_ID
        require AGENT_CUM_INPUT
        require AGENT_CUM_OUTPUT
        SESSION_ID="$AGENT_SESSION_ID"
        CUM_INPUT="$AGENT_CUM_INPUT"
        CUM_CACHE_CREATE="${AGENT_CUM_CACHE_CREATE:-0}"
        CUM_CACHE_READ="${AGENT_CUM_CACHE_READ:-0}"
        CUM_OUTPUT="$AGENT_CUM_OUTPUT"
        MODEL="${AGENT_MODEL:-unknown}"
        ;;
esac
# Normalize missing/blank model to a sentinel the ledger recognizes as unpriced.
MODEL="${MODEL:-unknown}"

for var in CUM_INPUT CUM_CACHE_CREATE CUM_CACHE_READ CUM_OUTPUT; do
    val="${!var}"
    if ! [[ "$val" =~ ^[0-9]+$ ]]; then
        echo "✗ $var must be a non-negative integer (got '$val')" >&2
        exit 1
    fi
done

# ── Compute per-commit delta from prev rows for this session ──
read -r PREV_INPUT PREV_CACHE_CREATE PREV_CACHE_READ PREV_OUTPUT < <(
    python3 "$LIB/ledger.py" sum-by-session "$LEDGER" "$SESSION_ID"
)

TOKEN_INPUT=$(( CUM_INPUT         - PREV_INPUT         ))
TOKEN_CACHE_CREATE=$(( CUM_CACHE_CREATE - PREV_CACHE_CREATE ))
TOKEN_CACHE_READ=$(( CUM_CACHE_READ   - PREV_CACHE_READ   ))
TOKEN_OUTPUT=$(( CUM_OUTPUT        - PREV_OUTPUT        ))
(( TOKEN_INPUT         < 0 )) && TOKEN_INPUT=0
(( TOKEN_CACHE_CREATE  < 0 )) && TOKEN_CACHE_CREATE=0
(( TOKEN_CACHE_READ    < 0 )) && TOKEN_CACHE_READ=0
(( TOKEN_OUTPUT        < 0 )) && TOKEN_OUTPUT=0

# Trailer contract: Token-Input = new-work tokens = input + cache_create.
# cache_read is NOT in the trailer — it's the same bytes re-read, not new work.
TRAILER_INPUT=$(( TOKEN_INPUT + TOKEN_CACHE_CREATE ))
TRAILER_OUTPUT=$TOKEN_OUTPUT
TRAILER_TOTAL=$(( TRAILER_INPUT + TRAILER_OUTPUT ))

# ── Compute cost-key ──────────────────────────────────────────
SESSION_SHORT="${SESSION_ID:0:12}"
SESSION_SHORT="${SESSION_SHORT%%[-._]}"
COST_KEY="${AGENT_COST_KEY:-${AGENT_NAME}-${SESSION_SHORT}-$(date +%s)}"

# ── Compute cost-usd once; feed both ledger row and trailer ───
# Keeping this shell-side (instead of letting ledger.py recompute) means
# the handoff to prepare-commit-msg carries the same 4-decimal string the
# ledger will write — no cross-check divergence possible.
#
# Cost-USD is required on every new commit. If the runtime model can't be
# priced (no family-prefix fallback matches), `rates.py cost` exits 3 with
# a human-readable reason on stderr; we surface that and block the commit.
# Escape hatch: `SKIP_GOVERNANCE=1 git commit ...` (at the top of this
# script) for genuine hot-fixes; the real fix is to add the missing model
# to `lib/rates.py`.
if ! COST_USD="$(python3 "$LIB/rates.py" cost "$MODEL" "$TOKEN_INPUT" "$TOKEN_CACHE_CREATE" "$TOKEN_CACHE_READ" "$TOKEN_OUTPUT")"; then
    if command -v tput >/dev/null 2>&1 && [[ -t 2 ]] && tput setaf 1 >/dev/null 2>&1; then
        _r="$(tput setaf 1)"; _rst="$(tput sgr0)"
    else
        _r=""; _rst=""
    fi
    printf '%s✗ agent-token-accounting: model %q is not priced.%s\n' \
        "$_r" "$MODEL" "$_rst" >&2
    printf '    add an entry (usually a family-prefix row) to lib/rates.py\n' >&2
    printf '    or set SKIP_GOVERNANCE=1 for a one-off bypass.\n' >&2
    unset _r _rst
    exit 1
fi

# ── Append the ledger row ─────────────────────────────────────
python3 "$LIB/ledger.py" append-row \
    "$LEDGER" \
    "$COST_KEY" "$AGENT_NAME" "$SESSION_ID" "$ISSUE" "$MODEL" \
    "$TOKEN_INPUT" "$TOKEN_CACHE_CREATE" "$TOKEN_CACHE_READ" "$TOKEN_OUTPUT" \
    "$SUBJECT"
git add "$LEDGER"

# ── Hand off to prepare-commit-msg via env file ───────────────
cat > "$HANDOFF" <<EOF
AGENT_NAME='$AGENT_NAME'
AGENT_SESSION_ID='$SESSION_ID'
AGENT_ISSUE='$ISSUE'
AGENT_TOKEN_INPUT='$TRAILER_INPUT'
AGENT_TOKEN_OUTPUT='$TRAILER_OUTPUT'
AGENT_TOKEN_TOTAL='$TRAILER_TOTAL'
AGENT_COST_KEY='$COST_KEY'
AGENT_COST_USD='$COST_USD'
EOF

printf 'agent-accounting: runtime=%s model=%s session=%s input=+%d cache_create=+%d cache_read=+%d output=+%d cost-key=%s cost-usd=%s\n' \
    "$RUNTIME" "$MODEL" "$SESSION_ID" "$TOKEN_INPUT" "$TOKEN_CACHE_CREATE" "$TOKEN_CACHE_READ" "$TOKEN_OUTPUT" "$COST_KEY" "$COST_USD" >&2

exit 0
