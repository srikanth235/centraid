#!/usr/bin/env bash
# #545 D9 — governance / hook shell surface for pre-commit `scripts/test.sh`
# and CI `bun run test:governance-shell`.
#
# 1) Runs coverage-scope-reachability self-test (expects a synthetic violation).
# 2) Runs the live coverage-scope-reachability check (must be clean).
# 3) When shellcheck is installed: lint .governance/, .githooks/, check.sh files.
#
# #576 — this lane spends ~3s re-shellchecking all 34 governance shell files on
# every commit, whatever the commit touched, and re-runs the coverage-scope
# check that the directive loop runs again moments later. Inside a commit hook
# it is therefore path-gated: a commit that stages no shell/governance surface
# skips straight out. Every other invocation (CI's `bun run
# test:governance-shell`, `check:pr`, a bare shell) runs the full lane, so the
# gate can only ever narrow the *fast* loop — never the enforcing one.
#
# This does NOT bring pre-commit near its 2s target: `repo-hygiene` (18.7s) and
# `receipt-per-issue` (13.2s) are vendored, digest-locked, and repo-wide by
# construction. See docs/dev-environment.md#the-local-gate-loop.
#
# The hook signal is GIT_INDEX_FILE, which git sets for pre-commit (verified on
# git 2.50.1) and not for a plain `bun run`. It is deliberately paired with a
# non-empty staged set: a hypothetical hook that exports GIT_INDEX_FILE with
# nothing staged falls through to the full lane rather than silently skipping.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

SCOPE_CHECK=".governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/check.sh"

# Fail-open to the FULL lane. Only a positively-identified commit hook whose
# staged set misses every shell surface takes the fast path.
shell_lane_is_gated_out() {
  [[ "${GOVERNANCE_SHELL_FULL:-0}" == "1" ]] && return 1
  [[ -n "${GIT_INDEX_FILE:-}" ]] || return 1

  local staged
  staged="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"
  [[ -n "$staged" ]] || return 1

  # Surfaces this script reads: shellcheck globs .governance/ and .githooks/;
  # scripts/ is included because this file lives there and a shell change under
  # it should still get the full lane.
  grep -qE '^(\.governance/|\.githooks/|scripts/)' <<<"$staged" && return 1
  return 0
}

if shell_lane_is_gated_out; then
  echo "governance-shell: no .governance/, .githooks/, or scripts/ file staged — skipped (GOVERNANCE_SHELL_FULL=1 forces the full lane)"
  exit 0
fi

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
