#!/usr/bin/env bash
# Directive: GitHub issue templates must encode the agent brainstorming handoff.
# Rationale: Agent-created issues are the durable record of a brainstorming
# session. If the issue form does not ask for the settled decision, scope,
# acceptance criteria, validation, and open questions, the next agent has to
# recover intent from chat history instead of the system of record.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "issue-templates"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

require_file() {
    local file="$1"
    if [[ ! -f "$file" ]]; then
        violation "$file not found"
        return 1
    fi
    return 0
}

require_pattern() {
    local file="$1" pattern="$2" message="$3"
    grep -qE "$pattern" "$file" || violation "$file - $message"
}

require_count_at_least() {
    local file="$1" pattern="$2" min="$3" message="$4"
    local count
    count="$(grep -cE "$pattern" "$file" || true)"
    if (( count < min )); then
        violation "$file - $message"
    fi
}

config=".github/ISSUE_TEMPLATE/config.yml"
proposal=".github/ISSUE_TEMPLATE/proposal.yml"
bug=".github/ISSUE_TEMPLATE/bug.yml"

if require_file "$config"; then
    require_pattern "$config" '^blank_issues_enabled:[[:space:]]*false$' "blank issues must be disabled so issues use a tracked template"
fi

if require_file "$proposal"; then
    for id in context decision scope acceptance validation open-questions; do
        require_pattern "$proposal" "^[[:space:]]+id:[[:space:]]*$id$" "proposal form missing '$id' field"
    done
    require_count_at_least "$proposal" '^[[:space:]]+required:[[:space:]]*true$' 6 "all six proposal handoff fields must be required"
fi

if require_file "$bug"; then
    for id in what-happened expected repro environment; do
        require_pattern "$bug" "^[[:space:]]+id:[[:space:]]*$id$" "bug form missing '$id' field"
    done
    require_count_at_least "$bug" '^[[:space:]]+required:[[:space:]]*true$' 4 "core bug-report fields must be required"
fi

directive_end
