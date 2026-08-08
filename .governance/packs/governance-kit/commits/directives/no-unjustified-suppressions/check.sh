#!/usr/bin/env bash
# Directive: Every lint / type-checker suppression must reference a tracker
# (#123 or ABC-123) on the same line.
# Rationale: An agent that hits a failing lint or type error has two moves —
# fix the code, or silence the checker. The silent move is invisible in a
# green build: `// @ts-ignore`, `# type: ignore`, `eslint-disable`, and friends
# turn a real signal off with no paper trail. Requiring a tracker reference on
# the suppression line turns "I muted this" into "I muted this, and here is the
# issue that owns un-muting it" — the suppression survives in `git blame` and
# someone, somewhere, can follow up. This is the sibling of no-orphan-todos for
# the checker-silencing case.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "no-unjustified-suppressions"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1
MANIFEST="$(dirname "$0")/directive.yaml"
TRACKER_REGEX="$(conf_get no-unjustified-suppressions TRACKER_REGEX "$MANIFEST")"
grep_args=()
while IFS= read -r marker; do
    [[ -n "$marker" ]] && grep_args+=(-e "$marker")
done < <(conf_list no-unjustified-suppressions "$MANIFEST" MARKERS)

# Fixed-string suppression markers across the common ecosystems. `git grep -F`
# treats these literally, so the regex-special characters (`[`, `(`, `@`, `#`)
# need no escaping. Markdown is excluded — a suppression token in prose is
# documentation, not a live silencing.
while IFS=: read -r file line_no match; do
    [[ -z "$file" ]] && continue
    # Skip this directive's own files — they spell the markers out literally.
    [[ "$file" == */directives/no-unjustified-suppressions/* ]] && continue
    # Skip the constitution, which documents the directive.
    [[ "$file" == CONSTITUTION.md ]] && continue
    # Accept waiver: `# governance: allow-no-unjustified-suppressions <reason>`
    has_waiver "$file" "$line_no" "no-unjustified-suppressions" && continue
    # Accept a tracker reference on the same line.
    if echo "$match" | grep -qE "$TRACKER_REGEX"; then
        continue
    fi
    violation "$file:$line_no — $(echo "$match" | sed 's/^[[:space:]]*//' | cut -c1-80)"
done < <(git grep -nF "${grep_args[@]}" \
    -- \
    ':!**/directives/no-unjustified-suppressions/**' \
    ':!*.md' \
    ':!CONSTITUTION.md' 2>/dev/null || true)

directive_end
