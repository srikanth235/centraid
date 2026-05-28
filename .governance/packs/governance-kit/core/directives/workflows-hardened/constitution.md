### workflows-hardened

- **Directive**: Every `.github/workflows/*.yml` declares a `permissions:` block and pins third-party actions (anything outside `actions/*` and `github/*`) to a full 40-character commit SHA.
- **Rationale**: A compromised third-party action with write access is a supply-chain vulnerability. Tag pins are mutable; SHA pins are not. A missing `permissions:` block inherits a broad default that most jobs do not actually need.
- **Enforced by**: `.governance/packs/governance-kit/core/directives/workflows-hardened/check.sh`
- **Exceptions**: Append `# governance: allow-workflows-hardened <reason>` to the offending line for documented exceptions.
