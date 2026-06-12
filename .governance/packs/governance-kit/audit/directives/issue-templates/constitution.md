### issue-templates

- **Directive**: `.github/ISSUE_TEMPLATE/config.yml`, `proposal.yml`, and `bug.yml` exist; blank issues are disabled; the proposal form requires Context, Decision, Scope, Acceptance criteria, Validation, and Open questions; and the bug form requires the core defect-report fields.
- **Rationale**: Agent-created GitHub issues are the durable output of brainstorming sessions. Requiring the settled decision, scope, acceptance criteria, validation, and open questions in the issue form keeps a future implementing agent from re-deriving intent from chat history.
- **Enforced by**: `.governance/packs/governance-kit/audit/directives/issue-templates/check.sh`
- **Exceptions**: Whole-directive waiver — include `<!-- governance: allow-issue-templates <reason> -->` in CONSTITUTION.md to skip the directive entirely (reason required; a bare token does not waive). Use when the repo intentionally does not use GitHub Issues — tracking lives in Linear / Jira / GitLab and the templates would be dead code. The waiver is discoverable in CONSTITUTION.md (the source-of-truth for repo-level deviations) and auditable via grep.
