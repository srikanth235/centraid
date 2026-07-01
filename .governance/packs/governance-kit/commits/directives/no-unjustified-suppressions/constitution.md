### no-unjustified-suppressions

- **Directive**: Every lint or type-checker suppression — `eslint-disable*`, `@ts-ignore`, `@ts-expect-error`, `# noqa`, `# type: ignore`, `# pylint: disable`, `# pyright: ignore`, `#[allow(...)]`, `nolint`, `@SuppressWarnings` — references either a GitHub issue (`#123`) or a tracker ticket (`ABC-123`) on the same line.
- **Rationale**: When an agent hits a failing check it can fix the code or silence the checker; the silent move leaves a green build with no paper trail. A suppression tied to an issue turns "I muted this" into "I muted this, and here is the ticket that owns un-muting it" — visible in `git blame` and searchable. This is the checker-silencing sibling of `no-orphan-todos`.
- **Enforced by**: `.governance/packs/governance-kit/commits/directives/no-unjustified-suppressions/check.sh`
- **Exceptions**: Append `governance: allow-no-unjustified-suppressions <reason>` to the offending line for rare intentional, permanent suppressions (e.g. a generated file, a known upstream-bug workaround). Markdown is not scanned — a suppression token quoted in prose is documentation, not a live silencing.
