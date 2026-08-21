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
MANIFEST="$(dirname "$0")/directive.yaml"

# Whole-directive waiver: `<!-- governance: allow-issue-templates <reason> -->`
# in CONSTITUTION.md exempts the directive from this commit's check. Reason
# required; HTML comment markers are stripped before matching. Use when the
# repo intentionally does not use GitHub Issues (e.g. tracking is in Linear /
# Jira and templates would be dead code).
if [[ -f "$ROOT/CONSTITUTION.md" ]] && sed -E 's/<!--//g; s/-->//g' "$ROOT/CONSTITUTION.md" \
        | grep -qE 'governance:[[:space:]]*allow-issue-templates[[:space:]]+[^[:space:]]'; then
    directive_end
fi

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

config="$(conf_get issue-templates CONFIG_PATH "$MANIFEST")"
proposal="$(conf_get issue-templates PROPOSAL_PATH "$MANIFEST")"
bug="$(conf_get issue-templates BUG_PATH "$MANIFEST")"

if require_file "$config"; then
    require_pattern "$config" '^blank_issues_enabled:[[:space:]]*false$' "blank issues must be disabled so issues use a tracked template"
fi

if require_file "$proposal"; then
    while IFS= read -r id; do
        require_pattern "$proposal" "^[[:space:]]+id:[[:space:]]*$id$" "proposal form missing '$id' field"
    done < <(conf_list issue-templates "$MANIFEST" PROPOSAL_FIELDS)
    proposal_min="$(conf_get issue-templates PROPOSAL_REQUIRED_MIN "$MANIFEST")"
    require_count_at_least "$proposal" '^[[:space:]]+required:[[:space:]]*true$' "$proposal_min" "proposal handoff fields must be required"
fi

if require_file "$bug"; then
    while IFS= read -r id; do
        require_pattern "$bug" "^[[:space:]]+id:[[:space:]]*$id$" "bug form missing '$id' field"
    done < <(conf_list issue-templates "$MANIFEST" BUG_FIELDS)
    bug_min="$(conf_get issue-templates BUG_REQUIRED_MIN "$MANIFEST")"
    require_count_at_least "$bug" '^[[:space:]]+required:[[:space:]]*true$' "$bug_min" "core bug-report fields must be required"
fi

directive_end
