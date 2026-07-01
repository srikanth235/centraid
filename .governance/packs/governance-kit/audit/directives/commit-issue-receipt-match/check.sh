#!/usr/bin/env bash
# Directive: every non-merge, non-revert commit in scope adds or modifies at
# least one `receipts/issue-<N>.md`. The touched receipt's filename **is** the
# commit's issue anchor — the receipt is where the audit for issue N lives, so
# the file in the diff is the authoritative commit↔issue link.
#
# Issue #293 made this file-first. The directive used to anchor on the subject's
# trailing `(#N)` plus body `Issue: #N` trailers and cross-check them against
# the touched receipt's `issue-<N>` token. With the accounting trailers retired,
# the only squash-robust anchor is the receipt path itself: it sits in the diff
# identically before and after a squash-merge (where the subject flips to the PR
# number), so no body trailer or HEAD-fallback is needed to recover the issue on
# the trunk. `commit-message-format` independently requires the subject `(#N)`;
# `receipt-per-issue` independently validates the receipt filename and shape.
# This directive supplies the remaining link — every commit touches its issue's
# receipt — which is what keeps the receipt a live audit artifact rather than an
# end-of-work afterthought.
#
# Modes:
#   Mode A — commit-msg hook:  bash check.sh <path-to-msg-file>
#       Reads the pending subject (merge/revert detection) + body (waiver) and
#       uses the staged diff for the receipt-touch check.
#   Mode B — CI / run.sh:      bash check.sh
#       Walks default-branch merge-base → HEAD and validates each commit against
#       its own tree-diff. On the trunk (no new work) Mode A already handled the
#       pending commit; re-flagging merged history is out of scope.
#
# Exceptions:
#   - Merge commits (parent count > 1 in Mode B; commit-msg never sees them).
#   - Revert commits (subject starts with `Revert "`).
#   - Per-commit waiver: a line `governance: allow-commit-issue-receipt-match
#     <reason>` anywhere in the commit body, for release commits and unusual
#     cross-cutting refactors that legitimately touch no receipt. The reason is
#     required — a bare token does not waive.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "commit-issue-receipt-match"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

# Returns 0 if the commit body carries a valid waiver line.
msg_has_waiver() {
    local msg="$1"
    printf '%s\n' "$msg" \
        | grep -qE '^[[:space:]]*(<!--)?[[:space:]]*governance:[[:space:]]*allow-commit-issue-receipt-match[[:space:]]+.+'
}

# validate <label> <subject> <body> [changed-file ...]
validate() {
    local label="$1" subject="$2" body="$3"
    shift 3

    # Skip merge commits.
    [[ "$subject" == Merge\ * ]] && return 0
    # Skip revert commits (git auto-subject).
    [[ "$subject" == Revert\ \"* ]] && return 0

    if msg_has_waiver "$body"; then
        return 0
    fi

    # File-first anchor: the commit must add or modify at least one receipt.
    local f
    for f in "$@"; do
        case "$f" in
            receipts/*.md) return 0 ;;
        esac
    done

    violation "$label — commit touches no receipts/*.md (every commit must add or update its issue's receipt; use 'governance: allow-commit-issue-receipt-match <reason>' in the body for a deliberate exception such as a release commit)"
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
    subject=$(grep -vE '^[[:space:]]*($|#)' "$msg_file" | head -n1)
    body=$(cat "$msg_file")

    changed=()
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        changed+=("$f")
    done < <(git diff --cached --name-only --diff-filter=ACMR -- 2>/dev/null || true)

    if [[ ${#changed[@]} -eq 0 ]]; then
        validate "pending commit" "$subject" "$body"
    else
        validate "pending commit" "$subject" "$body" "${changed[@]}"
    fi
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

if [[ -z "$base" ]]; then
    # No new work on this branch relative to the default — Mode A handles any
    # pending commit. Re-flagging history already on main is out of scope.
    directive_end
fi

while IFS= read -r sha; do
    [[ -z "$sha" ]] && continue
    parents=$(git log -1 --format=%P "$sha" 2>/dev/null || echo "")
    # Multi-parent → merge commit; skip.
    [[ "$parents" == *' '* ]] && continue
    subject=$(git log -1 --format=%s "$sha" 2>/dev/null || echo "")
    [[ "$subject" == Revert\ \"* ]] && continue
    body=$(git log -1 --format=%B "$sha" 2>/dev/null || echo "")

    changed=()
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        changed+=("$f")
    done < <(git diff-tree --no-commit-id --name-only --diff-filter=ACMR -r "$sha" 2>/dev/null || true)

    if [[ ${#changed[@]} -eq 0 ]]; then
        validate "$sha" "$subject" "$body"
    else
        validate "$sha" "$subject" "$body" "${changed[@]}"
    fi
done < <(git log "$base..HEAD" --format='%H')

directive_end
