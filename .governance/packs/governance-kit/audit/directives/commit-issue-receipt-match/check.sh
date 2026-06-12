#!/usr/bin/env bash
# Directive: For every non-merge, non-revert commit in scope, **some** issue
# number the commit anchors — either the trailing `(#N)` in the subject OR
# any `Issue: #N` trailer in the body (plural permitted) — must match an
# `issue-<N>` token on a `receipts/*.md` file the commit adds or modifies.
# A commit that touches no `receipts/*.md` also fails.
#
# Why the body-trailer anchor: squash-merged PRs naturally end up with a
# subject carrying the *PR* number while the folded sub-commits keep their
# original `Issue:` trailers (stamped by agent-token-accounting). Treating
# those trailers as legitimate anchors means the directive doesn't false-positive
# on post-squash history where the receipt is correctly for the underlying
# issue but the subject line references the PR id.
#
# Rationale: `commit-message-format` pins each commit to an issue, and
# `receipt-per-issue` pins each receipt file to an issue, but nothing cross-checks
# the two — a commit claiming `(#15)` while touching only issue #42's receipt
# passes both directives. This directive closes that hole, so the receipt the
# agent updates must be the *right* one for the commit's issue. It also
# subsumes the "every substantive commit must touch the receipt" obligation,
# which is what makes the receipt a live audit artifact rather than an
# end-of-work afterthought.
#
# Modes:
#   Mode A — commit-msg hook:  bash commit-issue-receipt-match.sh <path-to-msg-file>
#       Reads the pending subject + body from the msg file and uses the
#       staged diff for the receipt-touch check.
#   Mode B — CI / run.sh:      bash commit-issue-receipt-match.sh
#       Walks default-branch merge-base → HEAD and validates each commit
#       against its own message + tree-diff.
#
# Exceptions:
#   - Merge commits (parent count > 1 in Mode B; commit-msg never sees them).
#   - Revert commits (subject starts with `Revert "`).
#   - Per-commit waiver: a line `governance: allow-commit-issue-receipt-match
#     <reason>` anywhere in the commit body, for unusual cross-issue
#     refactors. The reason is required — a bare token does not waive.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "commit-issue-receipt-match"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

# Echoes the trailing issue number (1+ digits) from a subject line, or empty.
# Anchors to end-of-line so trailing `(#N)` wins over mid-sentence `(#M)`.
extract_issue_num() {
    local subject="$1"
    if [[ "$subject" =~ \(#([1-9][0-9]*)\)[[:space:]]*$ ]]; then
        printf '%s' "${BASH_REMATCH[1]}"
    fi
}

# Echoes space-separated issue numbers harvested from `Issue: #N` trailers
# in the commit body. Repeated trailers (one per folded sub-commit after a
# squash merge) all contribute.
extract_body_issue_nums() {
    local body="$1"
    # grep is portable across BSD/GNU; gawk's capture-group `match(..., m)`
    # isn't on BSD awk (macOS default), so we stay in the grep-sed lane.
    printf '%s\n' "$body" \
        | grep -E '^[[:space:]]*Issue:[[:space:]]*#[1-9][0-9]*[[:space:]]*$' \
        | sed -E 's/^[[:space:]]*Issue:[[:space:]]*#([1-9][0-9]*)[[:space:]]*$/\1/'
}

# Echoes space-separated `issue-<N>` numbers harvested from the basenames
# of the receipt files passed as args. A single receipt file with multiple
# `issue-<N>` tokens contributes all of them.
collect_receipt_issues() {
    local f base rest nums=""
    for f in "$@"; do
        [[ -z "$f" ]] && continue
        base="${f##*/}"
        rest="$base"
        while [[ "$rest" =~ issue-([0-9]+) ]]; do
            nums+="${BASH_REMATCH[1]} "
            rest="${rest#*issue-${BASH_REMATCH[1]}}"
        done
    done
    printf '%s' "$nums"
}

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

    # Collect every issue the commit anchors: the subject's trailing `(#N)`
    # plus any `Issue: #N` body trailer. Squash merges keep the folded
    # sub-commits' `Issue:` trailers, so this is how we recover the real
    # anchor when the subject carries the PR id instead.
    local subject_num body_nums
    subject_num="$(extract_issue_num "$subject")"
    body_nums="$(extract_body_issue_nums "$body")"

    local commit_issues=""
    [[ -n "$subject_num" ]] && commit_issues+="$subject_num "
    local n
    for n in $body_nums; do
        # De-dup — repeated `Issue: #33` trailers after a squash are normal.
        case " $commit_issues " in
            *" $n "*) ;;
            *) commit_issues+="$n " ;;
        esac
    done
    commit_issues="${commit_issues% }"

    if [[ -z "$commit_issues" ]]; then
        # `commit-message-format` will flag the subject shape separately; we
        # still emit a targeted violation so the root cause is clear.
        violation "$label — no issue anchor found: subject has no trailing '(#N)' and body has no 'Issue: #N' trailer ('$subject')"
        return 0
    fi

    local receipt_files=() f
    for f in "$@"; do
        case "$f" in
            receipts/*.md) receipt_files+=("$f") ;;
        esac
    done

    if [[ ${#receipt_files[@]} -eq 0 ]]; then
        local anchor_human
        if [[ -n "$subject_num" ]]; then
            anchor_human="(#$subject_num)"
        else
            anchor_human="Issue: #${commit_issues%% *}"
        fi
        violation "$label — commit anchors $anchor_human but touches no receipts/*.md (add or update the receipt for this issue, or use 'governance: allow-commit-issue-receipt-match <reason>' in the body)"
        return 0
    fi

    local receipt_issues match=0 ci pn
    receipt_issues="$(collect_receipt_issues "${receipt_files[@]}")"
    for ci in $commit_issues; do
        for pn in $receipt_issues; do
            if [[ "$pn" == "$ci" ]]; then
                match=1
                break 2
            fi
        done
    done

    if [[ "$match" == "0" ]]; then
        local touched="${receipt_files[*]}"
        violation "$label — commit issue anchors [${commit_issues}] not found among receipt issue numbers [${receipt_issues% }] (receipts touched: ${touched})"
    fi
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
    # No new work on this branch relative to the default — Mode A handles
    # any pending commit. Re-flagging history already on main is out of
    # scope.
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
