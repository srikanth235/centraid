### no-orphan-todos

- **Directive**: Every `TODO` or `FIXME` comment references either a GitHub issue (`#123`) or a tracker ticket (`ABC-123`).
- **Rationale**: A bare `TODO` is a promise to nobody. An issue-linked TODO is a promise that someone, somewhere, can follow up on — and that survives the author changing teams.
- **Enforced by**: `.governance/packs/governance-kit/core/directives/no-orphan-todos/check.sh`
- **Exceptions**: Append `governance: allow-no-orphan-todos <reason>` to the offending line for rare intentional exceptions.
