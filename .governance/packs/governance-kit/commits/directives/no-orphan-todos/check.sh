#!/usr/bin/env bash
# Directive: Every TODO/FIXME must reference a tracker (#123 or ABC-123).
# Orphan TODOs rot — a TODO without a ticket is a future bug with no owner.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "no-orphan-todos"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1
MANIFEST="$(dirname "$0")/directive.yaml"
MARKER_REGEX="$(conf_get no-orphan-todos MARKER_REGEX "$MANIFEST")"
TRACKER_REGEX="$(conf_get no-orphan-todos TRACKER_REGEX "$MANIFEST")"

# Pattern: TODO or FIXME, then anything up to 80 chars on the same line.
# Accepted references on the same line: #123, ABC-123 (uppercase project key + number).
while IFS=: read -r file line_no match; do
    [[ -z "$file" ]] && continue
    # Skip matches in this directive file itself (it mentions TODO).
    [[ "$file" == .governance/packs/governance-kit/commits/directives/no-orphan-todos/* ]] && continue
    [[ "$file" == kit/assets/packs/*/directives/no-orphan-todos/* ]] && continue
    # Skip matches inside the constitution, which documents the directive.
    [[ "$file" == CONSTITUTION.md ]] && continue
    # Accept waiver: `# governance: allow-no-orphan-todos <reason>`
    has_waiver "$file" "$line_no" "no-orphan-todos" && continue
    # Accept a tracker reference on the same line.
    if echo "$match" | grep -qE "$TRACKER_REGEX"; then
        continue
    fi
    violation "$file:$line_no — $(echo "$match" | sed 's/^[[:space:]]*//' | cut -c1-80)"
# `--word-regexp` is portable across GNU and BSD git-grep; `\b` is not.
done < <(git grep -nwE "$MARKER_REGEX" -- \
    ':!.governance/packs/governance-kit/commits/directives/no-orphan-todos/**' \
    ':!kit/assets/packs/*/directives/no-orphan-todos/**' \
    ':!CONSTITUTION.md' 2>/dev/null || true)

directive_end
