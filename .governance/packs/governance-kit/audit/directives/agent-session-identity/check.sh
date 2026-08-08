#!/usr/bin/env bash
# Validate receipt session identifiers and require the active identity in the
# staged receipt for agent-authored commits.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../../../../../lib.sh"
directive_start "agent-session-identity"
require_git
ROOT="$(git rev-parse --show-toplevel)"
RECEIPTS_DIR="$(conf_get agent-session-identity RECEIPTS_DIR "$HERE/directive.yaml")"
source "$HERE/lib/receipt.sh"
source "$HERE/lib/runtime.sh"
source "$HERE/lib/validate.sh"

while IFS= read -r violation_text; do
    [ -z "$violation_text" ] || violation "$violation_text"
done < <(session_validate_dir "$ROOT/$RECEIPTS_DIR")

msg_has_waiver() {
    printf '%s\n' "$1" | grep -qE '^[[:space:]]*(<!--)?[[:space:]]*governance:[[:space:]]*allow-agent-session-identity[[:space:]]+.+'
}

if [ "$#" -gt 0 ]; then
    msg_file="$1"
    [ -f "$msg_file" ] || { violation "commit message file not found: $msg_file"; directive_end; }
    subject="$(grep -vE '^[[:space:]]*($|#)' "$msg_file" | head -n1)"
    [[ "$subject" == Revert\ \"* ]] && directive_end
    msg="$(cat "$msg_file")"
    msg_has_waiver "$msg" && directive_end
    detect_runtime_identity || directive_end

    staged="$(git diff --cached --no-renames --name-only -- "$RECEIPTS_DIR/*.md" 2>/dev/null || true)"
    found=0
    while IFS= read -r rel; do
        [ -z "$rel" ] && continue
        [ -f "$ROOT/$rel" ] || continue
        if [ -n "$(session_row "$ROOT/$rel" "$RUNTIME" "$SESSION_ID")" ]; then found=1; break; fi
    done <<< "$staged"
    if [ "$found" -eq 0 ]; then
        violation "pending commit — runtime '$RUNTIME' (session '$SESSION_ID') has no matching staged Session/Identifiers row; commit through the pre-commit writer or add a governance: allow-agent-session-identity <reason> waiver"
    fi
fi

directive_end
