#!/usr/bin/env bash
# Agent steering accounting — pre-commit hook.
#
# Walks the active agent runtime's session JSONL, extracts steering events
# (interrupts, classifier-confirmed corrections), and appends one row per
# *new* event to STEERING.md. `git add`s the ledger so the rows land in
# this commit's tree, then writes a handoff env file for prepare-commit-msg
# to stamp the always-on summary triple from.
#
# Always-on contract: when a runtime + transcript are detected, the handoff
# is written even on commits with zero new events, and prepare-commit-msg
# stamps the actual counts. When no runtime is detected (or pre-commit is
# bypassed), this hook is a silent no-op and no handoff is written —
# prepare-commit-msg then falls back to `Steer-Count: 0` / `Steer-Types:
# none` / `Steer-Tiers: none`. Either way every non-merge, non-revert
# commit lands with the summary triple stamped — a `git log`-skimmable
# assertion that the directive ran. The directive is independent of
# agent-token-accounting; the contract holds whether or not the commit
# carries an `Agent:` trailer.
#
# Why pre-commit, not prepare-commit-msg: by the time prepare-commit-msg
# runs, git has already snapshotted the tree. `git add` from there lands
# in the next commit's index, not this one. Same shape as
# agent-token-accounting/hooks/pre-commit.sh.
#
# Dedup: the extractor returns *every* event on the session. We skip the
# first N, where N is the count of rows already in STEERING.md for this
# session. Append-only ordering of the ledger plus the JSONL's chronological
# order makes this exact.
#
# Retry safety (issue #66): the summary trailers are derived from the
# *staged* STEERING.md diff at handoff time, not from the events the
# extractor newly appended. On a retry after a failed commit-msg check,
# pre-commit's first attempt has already appended N rows and `git add`ed
# them; the extractor sees zero new events the second time around, but
# the staged diff still carries those N rows, so the handoff stamps
# `Steer-Count: N`. The retry's commit-msg check then sees a consistent
# row count and trailer count without the user manually re-stamping.
#
# Bash 3.2 compatible — no associative arrays, no namerefs. macOS ships
# bash 3.2.x at /bin/bash, and `#!/usr/bin/env bash` resolves to it on a
# default install.
#
# Escape hatches:
#   SKIP_GOVERNANCE=1 git commit ...
#   git commit --no-verify

set -u

if [[ "${SKIP_GOVERNANCE:-0}" == "1" ]]; then
    exit 0
fi

# ── Detect runtime ─────────────────────────────────────────────
RUNTIME=""
if [[ "${CLAUDECODE:-}" == "1" ]]; then
    RUNTIME="claude-code"
fi
# Codex / other runtimes: future runtimes/<name>.sh adapters will land here.

# Not in an agent-runtime session — pre-commit is a no-op (no transcript
# to extract events from, no rows to append). prepare-commit-msg will
# still fire and stamp the zero-defaults so the universal contract holds.
[[ -z "$RUNTIME" ]] && exit 0

ROOT="$(git rev-parse --show-toplevel)"
HERE="$(cd "$(dirname "$0")" && pwd)"
RULE_DIR="$(cd "$HERE/.." && pwd)"
LEDGER="$ROOT/STEERING.md"
LIB="$RULE_DIR/lib"
RUNTIMES="$RULE_DIR/runtimes"
HANDOFF="$(git rev-parse --git-path governance-pending-steering.env)"

# ── Resolve the transcript ─────────────────────────────────────
case "$RUNTIME" in
    claude-code)
        if ! out="$("$RUNTIMES/claude-code.sh")"; then
            # No transcript — silent no-op (e.g. session id changed mid-commit).
            exit 0
        fi
        read -r SESSION_ID TRANSCRIPT <<<"$out"
        AGENT_NAME="claude-code"
        ;;
    *)
        exit 0
        ;;
esac

# ── Walk argv to recover the issue anchor ─────────────────────
# Same trick as agent-token-accounting: $PPID is the hook process; git is
# its grandparent (typically), so walk one more level. Optional — empty
# `Issue` cell is allowed in the schema for repos that don't enforce
# anchors.
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
        # (the locale git hooks usually run with), which mangles UTF-8 in
        # the commit subject before it ever reaches the regex. Read raw
        # argv bytes via sysctl(KERN_PROCARGS2) so non-ASCII subjects
        # survive intact. See issue #140.
        python3 "$LIB/argv.py" "$pid" 2>/dev/null | tr '\0' ' '
    else
        ps -ww -p "$pid" -o args= 2>/dev/null
    fi
}

GIT_PID="$(grandparent_pid)"
ARGV="$(parent_argv_string "${GIT_PID:-$PPID}")"
if [[ "$ARGV" != *git* ]]; then
    ARGV="$(parent_argv_string "$PPID")"
fi

ISSUE="${AGENT_ISSUE:-}"
if [[ -z "$ISSUE" && "$ARGV" =~ \(#([1-9][0-9]*)\) ]]; then
    ISSUE="#${BASH_REMATCH[1]}"
fi

# Capture a short subject for the `commit` cell.
SUBJECT=""
if [[ "$ARGV" =~ [[:space:]](-m|--message)[[:space:]]+(.+) ]]; then
    SUBJECT="${BASH_REMATCH[2]}"
elif [[ "$ARGV" =~ --message=(.+) ]]; then
    SUBJECT="${BASH_REMATCH[1]}"
fi

# ── Run the extractor ─────────────────────────────────────────
# Tier-2 (corrections) is on by default — the directive itself is opt-in
# at install time, so no further env-var gates inside it. The extractor
# shells out to the active runtime's headless CLI (`claude -p` or
# `codex exec`) for semantic classification, falling back to a regex
# pre-filter only when the CLI is unreachable. Verdicts are cached by
# message-pair hash so re-runs are deterministic.
CLASSIFIER_CACHE="$(git rev-parse --git-path agent-steering-classify-cache.json)"

# Extractor emits TSV: timestamp\ttype\ttier\tuser_reason
ALL_EVENTS="$(mktemp)"
trap 'rm -f "$ALL_EVENTS"' EXIT

if ! python3 "$LIB/extract.py" "$TRANSCRIPT" --cache "$CLASSIFIER_CACHE" > "$ALL_EVENTS"; then
    # Extractor failure shouldn't block a commit — log and move on.
    echo "agent-steering-accounting: extractor failed; skipping" >&2
    exit 0
fi

TOTAL_EVENTS="$(wc -l < "$ALL_EVENTS" | tr -d ' ')"

# Count rows already in STEERING.md for this session — the dedup boundary.
EXISTING_ROWS=0
if [[ -f "$LEDGER" ]]; then
    EXISTING_ROWS="$(awk -F'|' -v sid="$SESSION_ID" '
        /^\|/ {
            key = $2
            sess = $3
            gsub(/^[ \t]+|[ \t]+$/, "", key)
            gsub(/^[ \t]+|[ \t]+$/, "", sess)
            if (key == "steer-key" || key == "" || key ~ /^-+$/) next
            if (sess == sid) c++
        }
        END { print c+0 }
    ' "$LEDGER")"
fi

# New events to append: lines after the first $EXISTING_ROWS. May be zero.
NEW_EVENTS_COUNT=$(( TOTAL_EVENTS - EXISTING_ROWS ))
if (( NEW_EVENTS_COUNT < 0 )); then
    # Defensive — extractor returned fewer events than the ledger already
    # has for this session. Treat as a no-op and let check.sh surface it.
    NEW_EVENTS_COUNT=0
fi

# ── Append rows ────────────────────────────────────────────────
EPOCH="$(date +%s)"
SESSION_SHORT="${SESSION_ID:0:12}"
SESSION_SHORT="${SESSION_SHORT//[^A-Za-z0-9]/}"
[[ -z "$SESSION_SHORT" ]] && SESSION_SHORT="anon"

if (( NEW_EVENTS_COUNT > 0 )); then
    idx=0
    while IFS=$'\t' read -r ts typ tier user_reason; do
        idx=$(( idx + 1 ))
        STEER_KEY="steer-${SESSION_SHORT}-${EPOCH}-${idx}"

        # `-` is the extractor's empty sentinel; map back to "" for the ledger
        # (which has its own sanitizer).
        [[ "$user_reason" == "-" ]] && user_reason=""

        if ! python3 "$LIB/ledger.py" append-row \
            "$LEDGER" \
            "$STEER_KEY" "$SESSION_ID" "$ISSUE" \
            "$typ" "$tier" "$user_reason" \
            "$SUBJECT"; then
            echo "agent-steering-accounting: append-row failed; aborting" >&2
            exit 1
        fi
    done < <(tail -n "$NEW_EVENTS_COUNT" "$ALL_EVENTS")

    git add "$LEDGER"
fi

# ── Derive the summary triple from the staged STEERING.md diff ──
# Re-deriving from the diff (rather than from the events newly appended in
# *this* invocation) is what makes the retry-after-failed-commit-msg case
# work: on a retry, the rows appended by the first attempt are still
# staged, so they show up in `git diff --cached` and the handoff stamps
# the right Steer-Count. See issue #66.
STAGED_TSV="$(git diff --cached -- "$LEDGER" 2>/dev/null | python3 -c '
import re, sys
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line.startswith("+") or line.startswith("+++"):
        continue
    body = line[1:].strip()
    if not body.startswith("|"):
        continue
    cells = [c.strip() for c in body.split("|")[1:-1]]
    if not cells:
        continue
    key = cells[0]
    if key in ("steer-key", "") or re.fullmatch(r"-+", key):
        continue
    if len(cells) >= 5:
        print(f"{cells[3]}\t{cells[4]}")
')"

STAGED_COUNT="$(printf '%s' "$STAGED_TSV" | awk 'NF' | wc -l | tr -d ' ')"
TYPES_RAW="$(printf '%s' "$STAGED_TSV" | awk -F'\t' 'NF { print $1 }')"
TIERS_RAW="$(printf '%s' "$STAGED_TSV" | awk -F'\t' 'NF { print $2 }')"

# Format raw newline-separated values into `key=N,key=N` (sorted for
# determinism — squash-merge rebases shouldn't reorder them). Empty input
# maps to "none".
format_counts() {
    local raw="$1"
    if [[ -z "$raw" ]]; then
        printf 'none'
        return
    fi
    printf '%s' "$raw" \
        | awk 'NF { print }' \
        | sort \
        | uniq -c \
        | awk 'BEGIN { sep="" } { printf("%s%s=%s", sep, $2, $1); sep="," } END { print "" }'
}

TYPES_SUMMARY="$(format_counts "$TYPES_RAW")"
TIERS_SUMMARY="$(format_counts "$TIERS_RAW")"

# ── Hand off to prepare-commit-msg ────────────────────────────
# Always written when a runtime + transcript are detected, even on
# zero-event commits. prepare-commit-msg uses these to stamp the
# always-on summary triple.
{
    printf "AGENT_STEERING_COUNT='%s'\n" "$STAGED_COUNT"
    printf "AGENT_STEERING_TYPES='%s'\n" "$TYPES_SUMMARY"
    printf "AGENT_STEERING_TIERS='%s'\n" "$TIERS_SUMMARY"
} > "$HANDOFF"

printf 'agent-steering: runtime=%s session=%s new=%d staged=%d total=%d\n' \
    "$RUNTIME" "$SESSION_ID" "$NEW_EVENTS_COUNT" "$STAGED_COUNT" "$TOTAL_EVENTS" >&2

exit 0
