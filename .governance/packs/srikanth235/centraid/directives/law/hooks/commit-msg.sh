#!/usr/bin/env bash
# The law at the commit-msg hook (#1005).
#
# The commit message is the one part of a change that does not exist yet when
# pre-commit runs, so the hook door runs a second time here with the message
# file attached — the arrival record's `pending` section then carries both the
# message and the staged set, and a rule can read them together.
set -u
MSG_FILE="${1:-}"
ROOT="$(git rev-parse --show-toplevel)"
LAW_DIR="$ROOT/.governance/law"

# Same skip rule as check.sh: no law, no node, or no install means no verdict,
# and no verdict must not become a refusal. check.sh has already installed the
# dependencies moments earlier in the same commit.
[[ -n "$MSG_FILE" ]] || exit 0
[[ -d "$LAW_DIR/node_modules/eslint" ]] || exit 0
command -v node >/dev/null 2>&1 || exit 0

cd "$ROOT" || exit 1
exec node .governance/law/run.mjs --door hook --message-file "$MSG_FILE"
