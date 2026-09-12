#!/usr/bin/env bash
# Directive: law — the change set and the governance documents it touches must
# pass the rule catalog under `.governance/law/` (#1005).
#
# This directive is a thin door, on purpose. It decides which door to open and
# forwards the runner's output and exit code; every judgement lives in a rule,
# where it is declarable, suppressible with a reason, unit-tested, and printed
# whether it passed or failed.
#
# Dependencies: the managed `.github/workflows/governance.yml` runs
# `.governance/run.sh` with no `bun install` before it, so the law carries its
# own exact-pinned npm install and this script materializes it on demand. With
# no npm on PATH the directive skips rather than blocks — an unrunnable gate
# must not stop a commit (the same rule `lint-check` follows for oxlint).
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "law"
require_git

REPO_ROOT="$(git rev-parse --show-toplevel)"
LAW_DIR="$REPO_ROOT/.governance/law"

if [[ ! -d "$LAW_DIR" ]]; then
    directive_end
fi

if [[ ! -d "$LAW_DIR/node_modules/eslint" ]]; then
    if ! command -v npm >/dev/null 2>&1; then
        printf "⊘ law skipped (npm not on PATH)\n"
        exit 0
    fi
    if ! npm ci --prefix "$LAW_DIR" --no-audit --no-fund --silent >/dev/null 2>&1; then
        violation "npm ci --prefix .governance/law failed (run it by hand to see why)"
        directive_end
    fi
fi

if ! command -v node >/dev/null 2>&1; then
    printf "⊘ law skipped (node not on PATH)\n"
    exit 0
fi

# GIT_INDEX_FILE is git's own signal that a commit hook is running (the same
# signal scripts/test.sh uses). In a hook the change is a staged set and the
# budget is rung 0, so only the hook door runs; everywhere else the whole law
# does.
DOOR="window"
if [[ -n "${GIT_INDEX_FILE:-}" ]]; then
    DOOR="hook"
fi

output="$(cd "$REPO_ROOT" && node .governance/law/run.ts --door "$DOOR" 2>&1)"
status=$?
printf '%s\n' "$output"
if [[ $status -ne 0 ]]; then
    violation "the law refused this change at the $DOOR door (see the findings above)"
fi

directive_end
