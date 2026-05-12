### doc-freshness

- **Directive**: Docs opted into `.governance/freshness.conf` carry a `<!-- last-verified: YYYY-MM-DD -->` marker dated within the last 90 days (configurable). No-op if the config file is absent.
- **Rationale**: Critical runbooks and onboarding docs decay. A periodic "someone re-read this" checkpoint keeps them honest — if the deadline passes, either the doc still reflects reality (bump the date) or it doesn't (fix it).
- **Enforced by**: `.governance/packs/governance-kit/core/directives/doc-freshness/check.sh`
- **Exceptions**: Remove a doc from `freshness.conf` to opt it out entirely.
