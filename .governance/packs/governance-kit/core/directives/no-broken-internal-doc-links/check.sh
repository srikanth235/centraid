#!/usr/bin/env bash
# Directive: Every markdown link to a local path in a tracked .md file resolves.
# Rationale: Doc rot is invisible until an agent follows a dead link and bails.
# This directive only checks link *targets*, not anchors — validating #heading
# fragments mechanically is fragile and generates noise.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "no-broken-internal-doc-links"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

# One-pass extractor: for each tracked .md file, pull out every [text](target)
# as `line_no:[text](target)`, then parse each in shell without iterative regex.
link_re_extract='\[[^]]*\]\([^)]+\)'
# Match everything from `](` up to the next `)`, capturing the target.
target_re='^\[[^]]*\]\(([^)]+)\)$'

check_link() {
    local file="$1" line_no="$2" match="$3"
    # Extract target from "[text](target)"
    local target
    target="${match##*(}"   # strip leading "[text]("
    target="${target%)}"    # strip trailing ")"
    # Drop optional title: `path "Title"` → `path`.
    target="${target%% *}"

    case "$target" in
        http://*|https://*|mailto:*|tel:*|'#'*|'<'*|'') return 0 ;;
    esac
    # Drop anchor fragment.
    local path="${target%%#*}"
    [[ -z "$path" ]] && return 0

    local dir resolved
    dir=$(dirname "$file")
    if [[ "$path" == /* ]]; then
        resolved="${ROOT}${path}"
    else
        resolved="${ROOT}/${dir}/${path}"
    fi

    if [[ -e "$resolved" ]]; then
        return 0
    fi

    has_waiver "$file" "$line_no" "no-broken-internal-doc-links" && return 0
    violation "$file:$line_no — broken link to '$target'"
}

while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    # Skip files inside governance directives — they contain regex strings that look like links.
    [[ "$file" == .governance/packs/governance-kit/core/directives/* ]] && continue
    # Skip skill asset templates — their links resolve relative to the TARGET repo
    # they're injected into, not to the asset's own location.
    [[ "$file" == */assets/*.md ]] && continue
    # grep -noE gives "line_no:match" per match, one per line.
    while IFS=: read -r line_no match; do
        [[ -z "$line_no" || -z "$match" ]] && continue
        check_link "$file" "$line_no" "$match"
    done < <(grep -noE "$link_re_extract" "$file" 2>/dev/null || true)
done < <(git ls-files -- '*.md' '*.markdown' ':!vendor/**' ':!node_modules/**' 2>/dev/null || true)

directive_end
