#!/usr/bin/env bash
# Governance prepare-commit-msg hook — stamps agent token-accounting trailers
# using values the pre-commit hook computed and handed off via
# .git/governance-pending.env.
#
# If the handoff file doesn't exist, this commit is either human-authored or
# came from a path where pre-commit didn't run (e.g. `git commit --no-verify`)
# — in either case the hook is a silent no-op.
#
# Escape hatches:
#   SKIP_GOVERNANCE=1 git commit ...
#   git commit --no-verify

set -u

if [[ "${SKIP_GOVERNANCE:-0}" == "1" ]]; then
    exit 0
fi

MSG_FILE="$1"
COMMIT_SOURCE="${2:-}"

# Don't stamp on merges, squashes, or message templates — trailers would be
# inherited from somewhere else and double-stamp.
case "$COMMIT_SOURCE" in
    merge|squash|commit) exit 0 ;;
esac

HANDOFF="$(git rev-parse --git-path governance-pending.env)"

[[ -f "$HANDOFF" ]] || exit 0

# shellcheck disable=SC1090
source "$HANDOFF"
rm -f "$HANDOFF"

# Skip stamping if trailers are already present (idempotent on amends/retries).
if grep -qE '^Agent:[[:space:]]' "$MSG_FILE"; then
    exit 0
fi

{
    cat "$MSG_FILE"
    printf '\n'
    printf 'Agent: %s\n'        "$AGENT_NAME"
    printf 'Issue: %s\n'        "$AGENT_ISSUE"
    printf 'Session: %s\n'      "$AGENT_SESSION_ID"
    printf 'Token-Input: %s\n'  "$AGENT_TOKEN_INPUT"
    printf 'Token-Output: %s\n' "$AGENT_TOKEN_OUTPUT"
    printf 'Token-Total: %s\n'  "$AGENT_TOKEN_TOTAL"
    printf 'Cost-Key: %s\n'     "$AGENT_COST_KEY"
    printf 'Cost-USD: %s\n'     "$AGENT_COST_USD"
} > "$MSG_FILE.new"
mv "$MSG_FILE.new" "$MSG_FILE"

exit 0
