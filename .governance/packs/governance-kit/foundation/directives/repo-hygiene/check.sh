#!/usr/bin/env bash
# Directive: repo-hygiene — no merge-conflict markers, oversized files, committed
# build artefacts, stray debug statements, or overlong source files. Rolls up:
# no-merge-conflict-markers, no-large-files, no-committed-build-artifacts,
# no-debug-statements, file-size-limit.
#
# To carve out a sub-check for your repo, use `governance directive modify` to
# amend this script (or `governance directive remove` to drop the directive
# entirely). Threshold tunables — MAX_FILE_SIZE_MB and FILE_SIZE_LIMIT — default
# in the pack-owned `defaults.conf` beside this script and are overridden
# per-repo in `.governance/conf/governance-kit/foundation/repo-hygiene.conf` (or
# the matching GOVERNANCE_* env vars, which win); they are applied below.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "repo-hygiene"
require_git

DEFAULTS="$(dirname "$0")/defaults.conf"
[[ -f "$DEFAULTS" ]] || { violation "broken install: $DEFAULTS missing (threshold defaults unavailable)"; directive_end; }

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
_LIMIT_MB="$(conf_get repo-hygiene MAX_FILE_SIZE_MB "$DEFAULTS")"
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
_artifacts=(
    '*.pyc|Python bytecode'
    '*.pyo|Python optimized bytecode'
    '__pycache__/**|Python cache dir'
    '*.class|Java class file'
    '*.o|compiled object file'
    'node_modules/**|node_modules committed'
    'dist/**|dist/ build output'
    'build/**|build/ output'
    'target/**|target/ (JVM / Rust) build output'
    'out/**|out/ build output'
    '.DS_Store|macOS metadata'
    'Thumbs.db|Windows metadata'
    '*.swp|editor swap file'
    '*.swo|editor swap file'
)
for entry in "${_artifacts[@]}"; do
    IFS='|' read -r pattern label <<<"$entry"
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        violation "$f — $label"
    done < <(git ls-files -- "$pattern" 2>/dev/null || true)
done

# ── debug-statements ────────────────────────────────────────────
_dbg=(
    "console.log|console\.log\s*\(|*.js *.jsx *.ts *.tsx *.mjs *.cjs"
    "debugger statement|^[[:space:]]*debugger[[:space:]]*;?|*.js *.jsx *.ts *.tsx *.mjs *.cjs"
    "Python breakpoint|^[[:space:]]*breakpoint\s*\(|*.py"
    "pdb.set_trace|import pdb|*.py"
    "Rust dbg! macro|\bdbg!\s*\(|*.rs"
    "fmt.Println debug|^[[:space:]]*fmt\.Println\s*\(|*.go"
)
for entry in "${_dbg[@]}"; do
    IFS='|' read -r label pattern pathspec <<<"$entry"
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
_LIMIT="$(conf_get repo-hygiene FILE_SIZE_LIMIT "$DEFAULTS")"
_exts=(
    "*.py" "*.js" "*.jsx" "*.ts" "*.tsx" "*.mjs" "*.cjs"
    "*.go" "*.rs" "*.rb" "*.java" "*.kt" "*.scala"
    "*.c" "*.cc" "*.cpp" "*.h" "*.hpp"
    "*.swift" "*.php" "*.cs"
)
_excludes=(
    ":!vendor/**"
    ":!**/node_modules/**"
    ":!**/generated/**"
    ":!**/*_pb2.py"
    ":!**/*.pb.go"
    ":!**/migrations/**"
)
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
