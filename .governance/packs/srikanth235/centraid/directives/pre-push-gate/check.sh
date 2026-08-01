#!/usr/bin/env bash
# Directive: pre-push-gate (#576) — a push that moves a ref runs the local PR
# gate first.
#
# Why this exists: AGENTS.md has instructed agents to run `bun run check:pr`
# before every push since #496. #568 still shipped a red CI, because a gate
# enforced by prose is enforced by whoever remembers it. The commands were
# already written; this is the wiring.
#
# stdin carries one line per ref being pushed:
#   <local ref> <local sha> <remote ref> <remote sha>
# An all-zero local sha is a delete — nothing to check. Empty stdin is an
# up-to-date push, likewise nothing to check.
#
# Output is NOT captured. `check:pr` runs for minutes and its progress is the
# only feedback the user gets; swallowing it to replay on failure would leave
# the terminal silent for the whole run.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "pre-push-gate"
require_git

if [[ "${SKIP_CHECK_PR:-0}" == "1" ]]; then
    printf "⊘ pre-push-gate skipped (SKIP_CHECK_PR=1) — CI still enforces\n" >&2
    exit 0
fi

ZERO="0000000000000000000000000000000000000000"
moves_a_ref=0
while read -r _local_ref local_sha _remote_ref _remote_sha; do
    [[ -z "${local_sha:-}" ]] && continue
    # Deleting a remote branch pushes no content; there is nothing to gate.
    [[ "$local_sha" =~ ^0+$ || "$local_sha" == "$ZERO" ]] && continue
    moves_a_ref=1
    break
done

if [[ $moves_a_ref -eq 0 ]]; then
    directive_end
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT" || exit 1

if ! command -v bun >/dev/null 2>&1; then
    # An unrunnable gate must not block a push; CI remains the enforcing copy.
    printf "⊘ pre-push-gate skipped (bun not on PATH)\n" >&2
    exit 0
fi

# git does not export GIT_INDEX_FILE for pre-push (verified on git 2.50.1), so
# `scripts/test.sh` already takes its full lane here. Setting this explicitly
# means a future git that *does* export it cannot silently narrow the push gate
# to the fast commit-time path.
export GOVERNANCE_SHELL_FULL=1

# The push tier runs `check:push`, NOT `check:pr` (#668). `check:pr` is the
# local mirror of the whole CI PR gate: at ~250s serial it stopped at the first
# failure, so three unrelated problems cost three full passes, and the price of
# a push drifted far enough above its value that SKIP_CHECK_PR became the
# default rather than the exception. A gate people always skip enforces
# nothing.
#
# `check:push` is the same gates minus the four that CI recomputes
# authoritatively anyway (full typecheck, lint:types, workflow-pins,
# diff-coverage), run concurrently, reporting every failure in one pass.
# ~52s, bounded by the affected tests — which is the gate that actually
# catches breakage.
printf "\n▶ pre-push-gate: bun run check:push (skip with SKIP_CHECK_PR=1)\n\n" >&2
# Strip git's hook environment before handing control to the gate (#668).
#
# Git exports GIT_DIR (and friends) to its hooks. Every gate — and every test a
# gate runs — inherits them, and for git those variables OVERRIDE cwd. A test
# that builds a throwaway repo with `git init` in a temp directory therefore
# re-initializes the REAL repository instead. That is not hypothetical: it set
# `core.bare = true` in the shared config on every push, which broke `git` in
# the main checkout and in every worktree, and then failed the three gates that
# shell out to git — so the gate could never pass from the hook, only when run
# by hand. `scripts/release/publish-guards.test.mjs` no longer inherits them
# either; this is the belt to that file's braces, and it covers gates nobody
# has written yet.
env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE \
    -u GIT_PREFIX -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES \
    bun run check:push \
    || violation "check:push failed — fix the failures above, or push with SKIP_CHECK_PR=1 and let CI enforce"

directive_end
