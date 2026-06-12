### token-permissions

- **Directive**: Every `.github/workflows/*.yml` (or `*.yaml`) declares a `permissions:` block — top-level or per-job — so the workflow runs with a least-privilege token rather than the repository's broad default. This is the OpenSSF Scorecard *Token-Permissions* check.
- **Rationale**: A missing `permissions:` block inherits a default that most jobs do not actually need. A compromised step or action then holds write access it should never have had. Declaring permissions explicitly is the cheapest blast-radius reduction available to a workflow.
- **Enforced by**: `.governance/packs/governance-kit/security/directives/token-permissions/check.sh`
- **Exceptions**: For a workflow that legitimately needs no explicit block, add `# governance: allow-token-permissions <reason>` within the first ten lines of the workflow file — the waiver is visible in `git blame` and searchable by design.
