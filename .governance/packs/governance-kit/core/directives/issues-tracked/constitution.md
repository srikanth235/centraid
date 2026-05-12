### issues-tracked

- **Directive**: `QUALITY.md` exists at the repo root with a top-level `# ` heading and contains `## Open` and `## Resolved` sections.
- **Rationale**: Bugs and quality observations discovered between releases rot in Slack and memory. Tracking them in a file keeps them in the system of record, diff-auditable, and greppable by agents and humans alike.
- **Enforced by**: `.governance/packs/governance-kit/core/directives/issues-tracked/check.sh`
- **Exceptions**: none. Empty sections are allowed; the file itself is the contract.
