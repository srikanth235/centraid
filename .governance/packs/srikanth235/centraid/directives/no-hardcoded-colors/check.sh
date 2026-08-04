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
            # The waiver is read from the RAW line, before the comment
            # stripping below. The waiver's documented form is a trailing
            # `/* governance: allow-no-hardcoded-colors <reason> */`, which is
            # exactly what the stripper deletes — so matching it on the
            # stripped text made the escape hatch unreachable on every line it
            # was meant for.
            waived=0
            if printf '%s' "$content" \
                | grep -q "governance: allow-no-hardcoded-colors"; then
                waived=1
            fi
            # Strip comment text before matching: issue references like `#686`
            # inside /* ... */ are valid 3-digit hex to the regex but are not
            # color declarations. Order matters on a single diff line with no
            # surrounding context: (1) a `*/` with no `/*` before it closes a
            # block comment started on an earlier line - drop the prefix;
            # (2) drop complete inline `/* ... */` comments; (3) a trailing
            # unclosed `/*` drops the remainder; (4) a line that is a bare
            # block-comment continuation (leading `*`) is skipped.
            content="$(printf '%s' "$content" | sed -E '
                /\*\//{ /\/\*/!s:^.*\*/:: ; }
                s:/\*[^*]*(\*+[^/*][^*]*)*\*+/::g
                s:/\*.*$::')"
            trimmed="${content#"${content%%[![:space:]]*}"}"
            case "$trimmed" in
                \**) line_no=$((line_no + 1)); continue ;;
            esac
            # A color literal only counts inside a declaration. A diff line has
            # no surrounding context, so a multi-line comment's interior prose
            # (e.g. "... #686 retired that fork") is indistinguishable from
            # CSS by position alone. Two prose filters: a line with no colon is
            # not a declaration, and `#abc word` (hex followed by a word) is an
            # issue reference in a sentence, not a color value. The vitest
            # ratchet strips comments properly and remains the thorough gate.
            case "$content" in
                *:*) ;;
                *) line_no=$((line_no + 1)); continue ;;
            esac
            content="$(printf '%s' "$content" | sed -E 's/#[0-9a-fA-F]{3,8} [A-Za-z]+//g')"
            # Functional notation whose first argument is itself a token
            # (`hsl(var(--app-hue) ...)`) is parameterized by the contract,
            # not a restated color - the vitest ratchet still counts it, but
            # the tripwire lets it through. (No \b: BSD sed lacks it.)
            content="$(printf '%s' "$content" | sed -E 's:(rgba?|hsla?)\([[:space:]]*var\(::g')"
            if printf '%s' "$content" | grep -qE "$PATTERN"; then
                if [[ "$waived" -eq 0 ]]; then
                    literal=$(printf '%s' "$content" | grep -oE "$PATTERN" | head -1)
                    violation "$file:$line_no - hardcoded color '$literal' (use a var(--token) from @centraid/design; see packages/blueprints/src/token-purity-allowlist.ts)"
                fi
            fi
            line_no=$((line_no + 1))
            ;;
    esac
done < <("${diff_cmd[@]}" 2>/dev/null || true)

directive_end
