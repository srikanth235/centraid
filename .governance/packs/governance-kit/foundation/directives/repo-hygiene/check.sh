#!/usr/bin/env bash
# Directive: repo-hygiene — no merge-conflict markers, oversized files, committed
# build artefacts, stray debug statements, or overlong source files. Rolls up:
# no-merge-conflict-markers, no-large-files, no-committed-build-artifacts,
# no-debug-statements, file-size-limit.
#
# To carve out a sub-check for your repo, use `governance directive modify` to
# amend this script (or `governance directive remove` to drop the directive
# entirely). Threshold tunables — MAX_FILE_SIZE_MB and FILE_SIZE_LIMIT — default
# in the pack-owned manifest beside this script and are overridden
# per-repo in `.governance/conf/governance-kit/foundation/repo-hygiene.conf`;
# they are applied below.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "repo-hygiene"
require_git

MANIFEST="$(dirname "$0")/directive.yaml"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

# ── merge-markers ───────────────────────────────────────────────
while IFS=: read -r file line_no _; do
    [[ -z "$file" ]] && continue
    # Skip this directive's own files — they contain the patterns as strings.
    [[ "$file" == .governance/packs/governance-kit/foundation/directives/repo-hygiene/* ]] && continue
    violation "$file:$line_no — merge conflict marker"
done < <(git grep -InE '^(<<<<<<< |=======$|>>>>>>> )' -- \
    ':!**/evals/**' 2>/dev/null || true)

# ── large-files ─────────────────────────────────────────────────
_LIMIT_MB="$(conf_get repo-hygiene MAX_FILE_SIZE_MB "$MANIFEST")"
_LIMIT_BYTES=$((_LIMIT_MB * 1024 * 1024))
_file_size() {
    stat -f%z "$1" 2>/dev/null && return 0
    stat -c%s "$1" 2>/dev/null && return 0
    wc -c < "$1" | tr -d ' '
}
while IFS= read -r f; do
    [[ -z "$f" || ! -f "$f" ]] && continue
    _size=$(_file_size "$f")
    [[ -z "$_size" ]] && continue
    if [[ "$_size" -gt "$_LIMIT_BYTES" ]]; then
        _hr=$(awk -v b="$_size" 'BEGIN{ split("B KB MB GB", u); s=0; while (b>1024 && s<3) { b/=1024; s++ } printf "%.1f %s", b, u[s+1] }')
        violation "$f — $_hr (limit: ${_LIMIT_MB} MB). Use Git LFS or host externally."
    fi
done < <(git ls-files)

# ── build-artifacts ─────────────────────────────────────────────
_artifacts=()
while IFS= read -r entry; do [[ -n "$entry" ]] && _artifacts+=("$entry"); done \
    < <(conf_list repo-hygiene "$MANIFEST" ARTIFACT_PATTERNS)
for entry in ${_artifacts[@]+"${_artifacts[@]}"}; do
    IFS='|' read -r pattern label <<<"$entry"
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        violation "$f — $label"
    done < <(git ls-files -- "$pattern" 2>/dev/null || true)
done

# ── debug-statements ────────────────────────────────────────────
_dbg=()
while IFS= read -r entry; do [[ -n "$entry" ]] && _dbg+=("$entry"); done \
    < <(conf_list repo-hygiene "$MANIFEST" DEBUG_PATTERNS)
for entry in ${_dbg[@]+"${_dbg[@]}"}; do
    # The regex may itself contain an alternation (`|`), so split the stable
    # label and pathspec delimiters explicitly instead of letting `read` cut
    # the pattern at its first alternation.
    label="${entry%%|*}"
    _debug_rule="${entry#*|}"
    pathspec="${_debug_rule##*|}"
    pattern="${_debug_rule%|*}"
    # shellcheck disable=SC2206
    _pathspec_args=($pathspec)
    while IFS=: read -r file line_no _; do
        [[ -z "$file" ]] && continue
        [[ "$file" == .governance/packs/governance-kit/foundation/directives/repo-hygiene/* ]] && continue
        [[ "$file" == *_test.* ]] && continue
        [[ "$file" == *.test.* ]] && continue
        [[ "$file" == *test_*.py ]] && continue
        [[ "$file" == tests/* ]] && continue
        [[ "$file" == *evals/* ]] && continue
        has_waiver "$file" "$line_no" "repo-hygiene" && continue
        violation "$file:$line_no — $label"
    done < <(git grep -InE "$pattern" -- "${_pathspec_args[@]}" 2>/dev/null || true)
done

# ── file-size-limit ─────────────────────────────────────────────
_LIMIT="$(conf_get repo-hygiene FILE_SIZE_LIMIT "$MANIFEST")"
_exts=()
while IFS= read -r entry; do [[ -n "$entry" ]] && _exts+=("$entry"); done \
    < <(conf_list repo-hygiene "$MANIFEST" SOURCE_PATTERNS)
_excludes=()
while IFS= read -r entry; do [[ -n "$entry" ]] && _excludes+=(":!$entry"); done \
    < <(conf_list repo-hygiene "$MANIFEST" EXCLUDE_PATTERNS)
while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    [[ ! -f "$file" ]] && continue
    has_file_waiver "$file" "repo-hygiene" "file-size-limit" && continue
    lines=$(wc -l < "$file" | tr -d ' ')
    if [[ "$lines" -gt "$_LIMIT" ]]; then
        violation "$file — $lines lines (limit: $_LIMIT)"
    fi
done < <(git ls-files -- "${_exts[@]}" "${_excludes[@]}" 2>/dev/null || true)

directive_end
