### pinned-dependencies

- **Directive**: Every third-party GitHub Action (anything outside the `actions/*` and `github/*` namespaces) used in `.github/workflows/*.yml` (or `*.yaml`) is pinned to a full 40-character commit SHA, not a moving tag. This is the OpenSSF Scorecard *Pinned-Dependencies* check. It is the future home for the rest of the pinning family — container-image digests, install-command pinning, and manifest/lockfile sync.
- **Rationale**: Tag pins are mutable; SHA pins are not. A compromised third-party action with write access is a supply-chain vulnerability, and tag-pinning is precisely the gap the tj-actions/changed-files compromise exploited in 2025 — a moved tag silently swapped trusted code for an attacker's.
- **Enforced by**: `.governance/packs/governance-kit/security/directives/pinned-dependencies/check.sh`
- **Exceptions**: For a deliberately tag-pinned action, append `# governance: allow-pinned-dependencies <reason>` to the offending `uses:` line — the waiver is visible in `git blame` and searchable by design.
