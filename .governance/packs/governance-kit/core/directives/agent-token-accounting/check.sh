#!/usr/bin/env bash
# Directive: Every non-merge, non-revert commit carries full token-accounting
# trailers and a matching append-only row in COSTS.md. This repo is
# agent-driven only — an untrailered commit is a bug, not an allowed mode.
#
# Required trailers on every in-scope commit:
#   Agent:         free-form runtime identifier (codex, claude-code, cursor, ...)
#   Issue:         #123 — the GitHub issue anchor
#   Session:       the runtime's session / thread id
#   Token-Input:   non-negative integer (= input + cache_create)
#   Token-Output:  non-negative integer (= output)
#   Token-Total:   non-negative integer, == Token-Input + Token-Output
#   Cost-Key:      <agent>-<session-short>-<epoch>, unique within COSTS.md
#   Cost-USD:      4-decimal dollar figure, cross-checked against COSTS.md's
#                  cost_usd column. An unpriced model blocks the commit
#                  upstream in the pre-commit hook — Cost-USD is not optional.
#
# COSTS.md ledger format — one row per agent-authored commit, append-only:
#   | cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | note |
#
# Where:
#   model      = runtime-reported model id (e.g. claude-sonnet-4-5)
#   new-work   == input + cache_create + output (self-checking, cache_read
#                 excluded — same bytes re-read, not new effort). Matches
#                 Token-Total in the trailer by construction.
#   cost-usd   = rates.lookup(model) (see lib/rates.py) · token columns.
#                Non-empty on every new v3 row; family-prefix fallback in
#                the rate table makes the unpriced case a hard failure at
#                commit time, not a silent blank.
# Legacy rows are accepted: v2 (10 cols, no model/cost-usd), v1 (8 cols,
# no cache split either), and v3 rows predating the cost-mandate whose
# `model` cell is empty. For those, `model`/`cost_usd` stay empty and the
# old `total` value is read as `new_work`.
#
# Modes:
#   Mode A — commit-msg hook:  bash agent-token-accounting.sh <path-to-msg-file>
#       Skips revert commits (subject starts with `Revert "`); merge commits
#       don't go through commit-msg.
#   Mode B — CI / run.sh:      bash agent-token-accounting.sh
#       Walks default-branch merge-base → HEAD and validates every non-merge,
#       non-revert commit. Merge commits (>1 parent) and revert commits
#       (subject starts with `Revert "`) are exempt. When the range is empty
#       (HEAD already at base, no remote main, etc.) Mode B is a no-op —
#       Mode A handles the pending commit, and re-flagging historical commits
#       already in main is out of scope. Also validates COSTS.md shape
#       independently, so post-squash repos still get ledger integrity.
#
# No self-bootstrap exemption: `governance init` is responsible for making
# the install commit pass this directive on the first try (dry-run + inline
# fix + normal `git commit` with the populators active). The only sanctioned
# bypass is the `unsupported-runtime` body waiver below, which is a
# subsequent-commit fallback for runtimes that have no `runtimes/<name>.sh`
# adapter — not a bootstrap accommodation.
#
# Ledger parsing, trailer parsing, and cross-check math are in sibling
# lib/ledger.py and lib/trailers.py — the directive folder is self-contained.
# This script is the bash shell — detect mode, walk commits, aggregate
# violations.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "agent-token-accounting"
require_git

ROOT="$(git rev-parse --show-toplevel)"
LEDGER="$ROOT/COSTS.md"
LIB="$HERE/lib"

if [[ ! -f "$LIB/ledger.py" || ! -f "$LIB/trailers.py" ]]; then
    violation "directive folder is missing lib/{ledger,trailers}.py — cannot validate"
    directive_end
fi

# ──────────────────────────────────────────────────────────────
# Ledger-integrity check (independent of any commits). Runs first so
# repo-wide shape problems get reported even on human-only branches.
# ──────────────────────────────────────────────────────────────
if [[ -f "$LEDGER" ]]; then
    while IFS= read -r v; do
        [[ -z "$v" ]] && continue
        violation "$v"
    done < <(python3 "$LIB/ledger.py" validate "$LEDGER" || true)
fi

# ──────────────────────────────────────────────────────────────
# Per-commit validation — shared between Mode A and Mode B.
# Args: <label>  <msg> (on stdin)
# ──────────────────────────────────────────────────────────────
validate_commit_message() {
    local label="$1"
    local msg
    msg="$(cat)"

    # Unsupported-runtime waiver — bypass the trailer + ledger requirement
    # when the agent's runtime has no runtimes/<name>.sh adapter. Requires a
    # non-empty reason after the colon so the gap is grep-able from
    # `git log --grep='allow-agent-token-accounting'`.
    if printf '%s\n' "$msg" | grep -qE '^governance:[[:space:]]+allow-agent-token-accounting[[:space:]]+unsupported-runtime:'; then
        local reason
        reason="$(printf '%s\n' "$msg" \
            | sed -nE 's/^governance:[[:space:]]+allow-agent-token-accounting[[:space:]]+unsupported-runtime:[[:space:]]*(.+)$/\1/p' \
            | head -n1 \
            | sed -E 's/[[:space:]]+$//')"
        if [[ -z "$reason" ]]; then
            violation "$label — unsupported-runtime waiver requires a reason after the colon (e.g. 'governance: allow-agent-token-accounting unsupported-runtime: cursor runtime not yet supported')"
        fi
        return 0
    fi

    # Mandatory: every in-scope commit must carry an Agent: trailer.
    # Caller is responsible for filtering out merge / revert commits before
    # invoking this function.
    if ! printf '%s\n' "$msg" | grep -qE '^Agent:[[:space:]]'; then
        violation "$label — missing required Agent: trailer (every non-merge, non-revert commit must carry token-accounting trailers; run \`git commit\` through the runtime-aware pre-commit hook, or use a 'governance: allow-agent-token-accounting unsupported-runtime: <reason>' waiver if the runtime has no runtimes/<name>.sh adapter)"
        return 0
    fi

    # Extract Cost-Key so we can look it up in the ledger. Use the last
    # occurrence (git trailer semantics) just like trailers.py does.
    local cost_key
    cost_key="$(printf '%s\n' "$msg" | awk -F': *' '/^Cost-Key:[[:space:]]/ {val=$2} END {print val}')"

    # Look up the ledger row.
    local found=0 row_input=0 row_cc=0 row_cr=0 row_output=0 row_new_work=0 row_cost_usd="-"
    if [[ -n "$cost_key" && -f "$LEDGER" ]]; then
        if row_output_line="$(python3 "$LIB/ledger.py" find-by-cost-key "$LEDGER" "$cost_key" 2>/dev/null)"; then
            read -r row_input row_cc row_cr row_output row_new_work row_cost_usd <<<"$row_output_line"
            found=1
        fi
    fi

    # First-class ledger-presence violation is independent of the trailer shape.
    if [[ "$found" == "0" ]]; then
        if [[ ! -f "$LEDGER" ]]; then
            violation "$label — declares Agent: trailer but COSTS.md does not exist at repo root"
        else
            local count
            count="$(python3 "$LIB/ledger.py" find-by-cost-key "$LEDGER" "$cost_key" 2>&1 1>/dev/null | grep -oE 'found [0-9]+' | awk '{print $2}')"
            violation "$label — Cost-Key '${cost_key:-<missing>}' should have exactly 1 row in COSTS.md, found ${count:-0}"
        fi
    fi

    # Trailer shape + cross-check math (only when we have the row; otherwise
    # trailers.py just skips the cross-check).
    local v
    while IFS= read -r v; do
        [[ -z "$v" ]] && continue
        violation "$v"
    done < <(
        printf '%s' "$msg" | python3 "$LIB/trailers.py" validate \
            "$label" "$found" \
            "$row_input" "$row_cc" "$row_cr" "$row_output" "$row_new_work" \
            "$row_cost_usd" \
            - 2>/dev/null || true
    )
}

# ──────────────────────────────────────────────────────────────
# Mode A — commit-msg hook
# ──────────────────────────────────────────────────────────────
if [[ $# -gt 0 ]]; then
    msg_file="$1"
    if [[ ! -f "$msg_file" ]]; then
        violation "commit-msg file not found: $msg_file"
        directive_end
    fi
    # Skip revert commits — git's auto-format starts with `Revert "..."`.
    # Merge commits don't go through commit-msg, so no parent check here.
    pending_subject=$(grep -vE '^[[:space:]]*($|#)' "$msg_file" | head -n1)
    if [[ "$pending_subject" == Revert\ \"* ]]; then
        directive_end
    fi
    validate_commit_message "pending commit" <"$msg_file"
    directive_end
fi

# ──────────────────────────────────────────────────────────────
# Mode B — CI / run.sh — walk base..HEAD
# ──────────────────────────────────────────────────────────────
base=""
for candidate in origin/main origin/master main master; do
    if git rev-parse --verify "$candidate" >/dev/null 2>&1; then
        mb=$(git merge-base HEAD "$candidate" 2>/dev/null || echo "")
        if [[ -n "$mb" && "$mb" != "$(git rev-parse HEAD)" ]]; then
            base="$mb"
            break
        fi
    fi
done

is_exempt_commit() {
    # Returns 0 (true) if the SHA is a merge commit or a revert commit.
    local sha="$1"
    local parents subject
    parents=$(git log -1 --format=%P "$sha" 2>/dev/null || echo "")
    # Multi-parent → merge commit.
    if [[ "$parents" == *' '* ]]; then
        return 0
    fi
    subject=$(git log -1 --format=%s "$sha" 2>/dev/null || echo "")
    if [[ "$subject" == Revert\ \"* ]]; then
        return 0
    fi
    return 1
}

if [[ -z "$base" ]]; then
    # No base ref found, or HEAD is at the base (no new work on this branch).
    # Nothing to walk — Mode A (commit-msg hook) handles the pending commit.
    # We deliberately do NOT fall back to validating HEAD here, because under
    # mandatory semantics that would re-flag historical commits already in
    # main, which are out of scope for this directive.
    directive_end
fi

while IFS= read -r sha; do
    [[ -z "$sha" ]] && continue
    if is_exempt_commit "$sha"; then
        continue
    fi
    msg=$(git log -1 --format=%B "$sha")
    # Here-string keeps validate_commit_message in the current shell so
    # `violation` calls actually bubble up (a pipe would subshell them).
    validate_commit_message "$sha" <<<"$msg"
done < <(git log "$base..HEAD" --format='%H')

directive_end
