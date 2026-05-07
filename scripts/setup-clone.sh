#!/usr/bin/env bash
# One-time per-clone setup for governance-kit hooks.
#
# Points git at the tracked .githooks/ directory. Safe to re-run — git
# overwrites the existing value. Worktrees inherit .git/config from their
# parent checkout, so this only needs to run once per clone, not per worktree.

set -eu

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [[ ! -d .githooks ]]; then
    echo "setup-clone: no .githooks/ directory — is governance-kit bootstrapped in this repo?" >&2
    exit 1
fi

git config core.hooksPath .githooks

current="$(git config --get core.hooksPath)"
echo "setup-clone: core.hooksPath=$current"
