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
#       (`base..HEAD` is empty — typically on `main` itself after a
#       squash-merge), Mode B validates HEAD's trailers on its own.
#       Squash-merge commits land on `main` via GitHub's server and bypass
#       the local commit-msg hook, so without this single-commit fallback
#       the squashed commit's per-Cost-Key trailer blocks would go
#       unchecked. Also validates COSTS.md shape independently, so
#       post-squash repos still get ledger integrity.
#
# Per-block validation: the trailer set above repeats once per sub-commit
# in a squash-merge body (one (Token-*, Cost-Key, Cost-USD) tuple per
# folded sub-commit). lib/trailers.py splits the body into trailer-only
# paragraphs and cross-checks every (block, COSTS.md row) pair anchored
# by Cost-Key — last-wins parsing across the whole body would keep only
# the trailing sub-commit's trailers and silently skip the rest.
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

    # Per-block validation: lib/trailers.py walks every trailer block in
    # the body (one per sub-commit on a squash-merge), looks up each
    # block's Cost-Key in COSTS.md, and cross-checks the row's columns
    # against the block's Token-*/Cost-USD trailers. Each block is
    # reported independently — a single squashed body can flag N rows.
    local v
    while IFS= read -r v; do
        [[ -z "$v" ]] && continue
        violation "$v"
    done < <(
        printf '%s' "$msg" | python3 "$LIB/trailers.py" validate-blocks \
            "$label" "$LEDGER" - 2>/dev/null || true
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
    # No new work on this branch relative to the default — but on `main`
    # itself, HEAD is the freshly-landed (often squash-merge) commit whose
    # trailer blocks are the durable record. A squash-merge bypasses the
    # local commit-msg hook (it runs on GitHub's server), so without this
    # single-commit fallback its per-Cost-Key blocks go unchecked.
    # Validate HEAD on its own so the per-block contract still applies
    # post-merge. `--verify` is what distinguishes "HEAD resolves to a
    # commit" from the empty-repo case (where `git rev-parse HEAD` prints
    # the literal string "HEAD" on stdout and exits 128).
    if git rev-parse --verify HEAD >/dev/null 2>&1; then
        head_sha=$(git rev-parse HEAD)
        if ! is_exempt_commit "$head_sha"; then
            msg=$(git log -1 --format=%B "$head_sha")
            validate_commit_message "$head_sha" <<<"$msg"
        fi
    fi
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
