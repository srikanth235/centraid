#!/usr/bin/env bash
# Directive: no-hardcoded-colors - blueprint app stylesheets consume colors
# from packages/design through `var(--token)`; they never restate them as
# hex or rgb()/hsl() literals.
#
# Scope: packages/blueprints/apps/**/*.module.css only. This is the
# commit-time tripwire, not the thorough gate - the exhaustive check
# (including font-family stacks and reserved custom-property namespaces,
# with a per-file burn-down ratchet) is
# packages/blueprints/src/token-purity.test.ts plus its allowlist. This
# directive exists so a NEW literal is caught in the second it is typed
# rather than in the test run.
#
# Ratchet: the vitest allowlist already pins the exact per-file counts of
# the pre-existing literals (issue #686). To stay fast and dependency-free
# here, this check only fires on lines that are ADDED relative to the merge
# base (or, with no upstream, staged additions) - so the historical debt in
# already-committed CSS does not block every commit, while any new literal
# does.
#
# Waiver: `/* governance: allow-no-hardcoded-colors <reason> */` on the
# offending line.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "no-hardcoded-colors"
require_git

# #rgb / #rgba / #rrggbb / #rrggbbaa, or a functional color notation.
PATTERN='#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?)\('

CSS_PATHSPEC='packages/blueprints/apps/**/*.module.css'

# Diff base: prefer the merge base with the default branch so a whole
# branch's additions are covered; fall back to the index (staged) when
# there is no such ref (fresh clone, detached CI checkout).
base=""
for ref in origin/main main; do
    if git rev-parse --verify --quiet "$ref" >/dev/null 2>&1; then
        base="$(git merge-base HEAD "$ref" 2>/dev/null || true)"
        [[ -n "$base" ]] && break
    fi
done

if [[ -n "$base" ]]; then
    diff_cmd=(git diff --unified=0 "$base" -- "$CSS_PATHSPEC")
else
    diff_cmd=(git diff --unified=0 --cached -- "$CSS_PATHSPEC")
fi

file=""
line_no=0
while IFS= read -r diff_line; do
    case "$diff_line" in
        '+++ b/'*)
            file="${diff_line#+++ b/}"
            ;;
        '@@'*)
            # @@ -a,b +c,d @@ - take c as the first added line number.
            hunk="${diff_line#*+}"
            hunk="${hunk%% *}"
            line_no="${hunk%%,*}"
            ;;
        '+'*)
            content="${diff_line#+}"
            if printf '%s' "$content" | grep -qE "$PATTERN"; then
                if ! printf '%s' "$content" \
                    | grep -q "governance: allow-no-hardcoded-colors"; then
                    literal=$(printf '%s' "$content" | grep -oE "$PATTERN" | head -1)
                    violation "$file:$line_no - hardcoded color '$literal' (use a var(--token) from @centraid/design; see packages/blueprints/src/token-purity-allowlist.ts)"
                fi
            fi
            line_no=$((line_no + 1))
            ;;
    esac
done < <("${diff_cmd[@]}" 2>/dev/null || true)

directive_end
