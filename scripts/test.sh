#!/usr/bin/env bash
# #545 D9 — governance / hook shell surface for pre-commit `scripts/test.sh`
# and CI `bun run test:governance-shell`.
#
# 1) Runs coverage-scope-reachability self-test (expects a synthetic violation).
# 2) Runs the live coverage-scope-reachability check (must be clean).
# 3) When shellcheck is installed: lint .governance/, .githooks/, check.sh files.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

SCOPE_CHECK=".governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/check.sh"

echo "governance-shell: coverage-scope-reachability self-test"
self_out="$(GOVERNANCE_COVERAGE_SCOPE_SELFTEST=1 bash "$SCOPE_CHECK" 2>&1 || true)"
if ! grep -q '__coverage_scope_selftest_unowned__' <<<"$self_out"; then
  echo "governance-shell: self-test did not report synthetic unowned package" >&2
  printf '%s\n' "$self_out" >&2
  exit 1
fi
echo "governance-shell: self-test ok (synthetic violation observed)"

echo "governance-shell: coverage-scope-reachability live check"
bash "$SCOPE_CHECK"

if ! command -v shellcheck >/dev/null 2>&1; then
  echo "governance-shell: shellcheck not installed — skipping static shell lint (install shellcheck for full D9)"
  exit 0
fi

# Portable file list (bash 3.2 / macOS — no mapfile).
SHELL_FILES=()
while IFS= read -r f; do
  [[ -n "$f" ]] && SHELL_FILES+=("$f")
done < <(
  {
    find .governance -type f \( -name '*.sh' -o -name 'run.sh' -o -name 'lib.sh' \) 2>/dev/null || true
    # Shell scripts only — avoid shellchecking future non-shell files under .githooks.
    find .githooks -type f \( -name '*.sh' -o -name 'pre-*' -o -name 'commit-msg' -o -name 'prepare-commit-msg' -o -name 'post-*' \) 2>/dev/null || true
  } | sort -u
)

if [[ ${#SHELL_FILES[@]} -eq 0 ]]; then
  echo "governance-shell: no shell files found" >&2
  exit 1
fi

echo "governance-shell: shellcheck ${#SHELL_FILES[@]} file(s)"
shellcheck --severity=error "${SHELL_FILES[@]}"
echo "governance-shell: ok"
