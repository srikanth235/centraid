#!/usr/bin/env bash
# Directive: format-check - staged files that oxfmt owns must already be
# formatted.
#
# Why this exists: CI runs `bun run format:check` over the whole tree
# (.github/workflows/ci.yml), but no local hook ran any formatter. A commit
# could therefore clear every pre-commit gate and still fail CI on something
# purely mechanical - a stripped trailing newline is the canonical case.
#
# Scope is STAGED FILES ONLY, on purpose. A repo-wide check would fail on
# pre-existing debt in files the author never opened, and a gate that fires
# for someone else's mess is a gate people learn to bypass.
#
# No waiver hook: formatting has exactly one correct answer. A file that
# genuinely must not be formatted belongs in oxfmt's own ignore config, where
# the exclusion is visible, not in a per-commit escape hatch.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "format-check"
require_git

# oxfmt is a devDependency; prefer the local binary so the hook never reaches
# for the network. If it is missing (fresh clone, no install yet) skip rather
# than block - an unrunnable gate must not stop a commit.
REPO_ROOT="$(git rev-parse --show-toplevel)"
OXFMT=""
for candidate in "$REPO_ROOT/node_modules/.bin/oxfmt" "node_modules/.bin/oxfmt"; do
    if [[ -x "$candidate" ]]; then
        OXFMT="$candidate"
        break
    fi
done
if [[ -z "$OXFMT" ]]; then
    directive_end
    exit 0
fi

# Extensions oxfmt owns. Anything else staged is none of this check's business.
staged=()
while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    [[ -f "$file" ]] || continue
    case "$file" in
    *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.mts | *.cts | *.json | *.jsonc | *.yml | *.yaml | *.css)
        staged+=("$file")
        ;;
    esac
done < <(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)

if [[ ${#staged[@]} -eq 0 ]]; then
    directive_end
    exit 0
fi

# oxfmt --check prints one offending path per line, then a summary. Match its
# output back against the staged list so a path we never staged can't be
# reported, and so the summary lines are ignored.
output="$("$OXFMT" --check "${staged[@]}" 2>&1 || true)"
while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    # Strip oxfmt's trailing timing annotation, e.g. "path/to/file.ts (12ms)".
    candidate="${line% (*}"
    for file in "${staged[@]}"; do
        if [[ "$candidate" == "$file" ]]; then
            violation "$file - not formatted (run: bun run format)"
            break
        fi
    done
done <<<"$output"

directive_end
