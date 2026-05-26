#!/usr/bin/env bash
# Directive: agent-tool-names-fixed - the agent-facing tool surface in
# centraid is fixed at exactly six tool names. Three from the three-tool
# dispatcher (packages/runtime-core/src/dispatcher.ts, issue #107) and
# three from the direct-SQL agent surface
# (packages/openclaw-plugin/src/lib/tools.ts):
#
#   centraid_describe         centraid_sql_describe
#   centraid_read             centraid_sql_read
#   centraid_write            centraid_sql_write
#
# A new 'centraid_<name>' tool registered anywhere is a new entry point
# for agents that the audit chain doesn't yet know about - token and
# steering trailers won't be stamped for it, the run ledger won't see
# it, and reviewers won't realize a new surface exists. Adding a tool
# must be a deliberate amendment here, not a drive-by registration in
# an adapter file.
#
# Detection: any quoted string literal matching `["']centraid_[a-z_]+["']`
# in tracked source under packages/ and apps/, whose name is not in the
# six-element allowlist. Documentation (*.md, *.mdx), tests, and build
# artifacts are excluded - those reflect reality, they don't define it.
#
# Waiver: `// governance: allow-agent-tool-names-fixed <reason>` on the
# offending line for the rare case where a 'centraid_<name>' literal is
# not a tool registration (e.g. a session-key prefix string).
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "agent-tool-names-fixed"
require_git

# The six allowlisted tool names. Adding to this list requires updating
# the directive itself (a reviewable amendment) - not a drive-by edit
# in an adapter.
ALLOWED=(
    'centraid_describe'
    'centraid_read'
    'centraid_write'
    'centraid_sql_describe'
    'centraid_sql_read'
    'centraid_sql_write'
)

# Build a regex alternation of the allowlist for membership testing.
allowed_alt="$(IFS='|'; echo "${ALLOWED[*]}")"

# Match any quoted 'centraid_<id>' literal in source. We deliberately
# accept both single and double quotes; JSON files use double, JS/TS
# use either.
PATTERN="['\"]centraid_[a-z_]+['\"]"

while IFS=: read -r file line_no match; do
    [[ -z "$file" ]] && continue
    has_waiver "$file" "$line_no" "agent-tool-names-fixed" && continue
    # Extract the bare name (strip quotes).
    name=$(printf '%s' "$match" | grep -oE "centraid_[a-z_]+" | head -1)
    [[ -z "$name" ]] && continue
    # If the name is in the allowlist, skip.
    if [[ "$name" =~ ^(${allowed_alt})$ ]]; then
        continue
    fi
    violation "$file:$line_no - unknown agent tool name '$name' (allowlist: ${ALLOWED[*]}; add behavior to packages/runtime-core/src/dispatcher.ts instead of a new tool)"
done < <(git grep -nE "$PATTERN" -- \
    'packages/**/*.ts' 'packages/**/*.tsx' 'packages/**/*.js' 'packages/**/*.mjs' 'packages/**/*.json' \
    'apps/**/*.ts' 'apps/**/*.tsx' 'apps/**/*.js' 'apps/**/*.json' \
    ':!**/*.test.ts' ':!**/*.test.tsx' ':!**/*.spec.ts' ':!**/*.spec.tsx' \
    ':!**/dist/**' ':!**/node_modules/**' \
    2>/dev/null || true)

directive_end
