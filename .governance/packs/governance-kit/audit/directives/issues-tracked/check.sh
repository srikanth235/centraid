#!/usr/bin/env bash
# Directive: QUALITY.md exists at repo root and tracks bugs/issues with Open + Resolved sections.
# Rationale: Issues discovered between releases rot in Slack and memory. A tracked
# file keeps them in the system of record, diff-auditable, and greppable.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "issues-tracked"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

# Whole-directive waiver: `<!-- governance: allow-issues-tracked <reason> -->`
# in CONSTITUTION.md exempts the directive from this commit's check. Reason
# required; HTML comment markers are stripped before matching. Use when the
# repo tracks bugs elsewhere (Linear / Jira / GitHub Issues only) and
# QUALITY.md would be dead state.
if [[ -f "$ROOT/CONSTITUTION.md" ]] && sed -E 's/<!--//g; s/-->//g' "$ROOT/CONSTITUTION.md" \
        | grep -qE 'governance:[[:space:]]*allow-issues-tracked[[:space:]]+[^[:space:]]'; then
    directive_end
fi

if [[ ! -f "$ROOT/QUALITY.md" ]]; then
    violation "QUALITY.md not found at repo root"
    directive_end
    exit 0
fi

grep -qE '^# '          "$ROOT/QUALITY.md" || violation "QUALITY.md — missing top-level '# ' heading"
grep -qE '^## Open'     "$ROOT/QUALITY.md" || violation "QUALITY.md — missing '## Open' section"
grep -qE '^## Resolved' "$ROOT/QUALITY.md" || violation "QUALITY.md — missing '## Resolved' section"

directive_end
