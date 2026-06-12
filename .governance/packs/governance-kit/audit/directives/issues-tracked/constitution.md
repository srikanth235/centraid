### issues-tracked

- **Directive**: `QUALITY.md` exists at the repo root with a top-level `# ` heading and contains `## Open` and `## Resolved` sections.
- **Rationale**: Bugs and quality observations discovered between releases rot in Slack and memory. Tracking them in a file keeps them in the system of record, diff-auditable, and greppable by agents and humans alike.
- **Enforced by**: `.governance/packs/governance-kit/audit/directives/issues-tracked/check.sh`
- **Exceptions**: Empty sections are allowed; the file itself is the contract. Whole-directive waiver — include `<!-- governance: allow-issues-tracked <reason> -->` in CONSTITUTION.md to skip the directive entirely (reason required; a bare token does not waive). Use when the repo tracks bugs elsewhere (Linear / Jira / GitHub Issues only) and QUALITY.md would be dead state.
