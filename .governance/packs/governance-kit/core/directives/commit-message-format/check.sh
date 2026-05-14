#!/usr/bin/env bash
# Directive: Commit messages follow Conventional Commits and end with a GitHub issue suffix.
#   <type>(<optional-scope>)!?: <subject> (#123)
# Allowed types: feat, fix, chore, docs, refactor, test, perf, build, ci, revert, style.
# Extend via GOVERNANCE_CC_EXTRA_TYPES="foo bar baz".
#
# Usage modes:
#   Mode A — commit-msg hook: `bash check.sh <path-to-msg-file>`
#   Mode B — CI / run.sh:     `bash check.sh`
#       Validates every commit from the default-branch merge-base to HEAD.
#
# Merge commits and commits authored by bots (dependabot, renovate) are skipped.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "commit-message-format"
require_git

DEFAULT_TYPES="feat fix chore docs refactor test perf build ci revert style"
EXTRA_TYPES="${GOVERNANCE_CC_EXTRA_TYPES:-}"
ALL_TYPES="$DEFAULT_TYPES $EXTRA_TYPES"
# Build an alternation for the regex.
types_alt=$(echo "$ALL_TYPES" | tr -s ' ' '|' | sed 's/^|//;s/|$//')
# Conventional Commits header regex (first line only) plus a required GitHub issue suffix.
HEADER_RE="^(${types_alt})(\([^)]+\))?!?: .+ \(#[1-9][0-9]*\)$"

validate_subject() {
    local subject="$1"
    local label="$2"
    # Merge commits — skip.
    [[ "$subject" == Merge\ * ]] && return 0
    # Revert commits — git's auto-format starts with `Revert "..."`.
    [[ "$subject" == Revert\ \"* ]] && return 0
    # Fixup / squash / autosquash — not for a clean history but not our fight here.
    [[ "$subject" == fixup!\ * || "$subject" == squash!\ * || "$subject" == amend!\ * ]] && return 0

    if [[ ! "$subject" =~ $HEADER_RE ]]; then
        violation "$label — '$subject' does not match Conventional Commits with an issue suffix (<type>(scope)?: <subject> (#123))"
        return 1
    fi
    # Subject ≤ 100 chars keeps PR titles and log output readable.
    if [[ ${#subject} -gt 100 ]]; then
        violation "$label — subject is ${#subject} chars (max 100)"
        return 1
    fi
    return 0
}

# Returns 0 if the commit body carries a valid waiver line.
# `governance: allow-commit-message-format <reason>` — reason required.
# The waiver must live in the body (the subject itself is what's checked).
msg_has_waiver() {
    local msg="$1"
    printf '%s\n' "$msg" \
        | grep -qE '^[[:space:]]*(<!--)?[[:space:]]*governance:[[:space:]]*allow-commit-message-format[[:space:]]+.+'
}

if [[ $# -gt 0 ]]; then
    # Mode A — commit-msg hook.
    msg_file="$1"
    [[ ! -f "$msg_file" ]] && { violation "commit-msg file not found: $msg_file"; directive_end; }
    # First non-comment, non-blank line is the subject.
    subject=$(grep -vE '^[[:space:]]*($|#)' "$msg_file" | head -n1)
    if msg_has_waiver "$(cat "$msg_file")"; then
        directive_end
    fi
    validate_subject "$subject" "pending commit"
    directive_end
fi

# Mode B — CI / run.sh.
# Pick a base ref. Prefer origin/main or origin/master. Fall back to the last
# commit only (so the directive still exercises something in fresh repos or detached heads).
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
    # Validate just the tip commit.
    subject=$(git log -1 --format=%s HEAD 2>/dev/null || echo "")
    [[ -n "$subject" ]] && validate_subject "$subject" "HEAD"
    directive_end
fi

while IFS=$'\t' read -r sha author_email subject; do
    [[ -z "$sha" ]] && continue
    # Skip bots — they have their own conventions we can't control.
    case "$author_email" in
        *dependabot*|*renovate*|*[bot]*@*) continue ;;
    esac
    body=$(git log -1 --format=%B "$sha" 2>/dev/null || echo "")
    if msg_has_waiver "$body"; then
        continue
    fi
    validate_subject "$subject" "$sha"
done < <(git log "$base..HEAD" --format='%H%x09%ae%x09%s')

directive_end
