#!/usr/bin/env bash
# Forward the commit message so receipt-per-issue can require a receipt on a
# direct-to-default completed commit (and honor a body waiver). Uniqueness and
# shape stay on hook: pre-commit / CI.
set -u
[ "${SKIP_GOVERNANCE:-0}" = "1" ] && exit 0
exec bash "$(dirname "$0")/../check.sh" "$@"
