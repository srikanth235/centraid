### doc-freshness

- **Directive**: Docs opted into `.governance/freshness.conf` carry a `<!-- last-verified: YYYY-MM-DD -->` marker dated within the last 90 days (configurable). No-op if the config file is absent.
- **Rationale**: Critical runbooks and onboarding docs decay. A periodic "someone re-read this" checkpoint keeps them honest — if the deadline passes, either the doc still reflects reality (bump the date) or it doesn't (fix it).
- **Enforced by**: `.governance/packs/governance-kit/core/directives/doc-freshness/check.sh`
- **Exceptions**: Remove a doc from `freshness.conf` to opt it out entirely. Per-file waiver — include `governance: allow-doc-freshness <reason>` anywhere in the doc (typically as an HTML comment alongside the `last-verified` marker) to keep the doc in the config but exempt it from the staleness check (reason required; a bare token does not waive). The waiver is visible in `git blame` and searchable; use it for docs awaiting a known rewrite rather than as a long-term escape hatch.
