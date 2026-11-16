# Docs rebuild review — #1200

The public docs now describe the current nine-app phone vault. All 12 routes and existing section fragment IDs remain available. Short task cards, diagrams, individual app cards and a real current iPhone Home capture replace long introductory prose; technical detail remains expandable.

The four-part mark comes from the canonical design generator. Both sites receive identical generated SVG bytes (SHA-256 `6aeba1dbf4610e0cc63a56d46bce442bdccaa237b258602792c4506e14db3f45`). The social image uses the same generated paths and token-derived template. Light mockups were authored first; dark boards and site assets were generated with `cargo xtask design`.

Source claims were checked against the implementation, including phone-only writing, blind gateway storage, recovery key plus reachable sealed backup, pairing safety checks, device permissions and nine app roles. Calendar shows reminder occurrences; completion happens in Reminders. Privacy/terms preserve their existing draft status, clauses, contact and review questions. The source audit is in `docs-source-review.md`.

## Verification

- Guarded design regeneration: 367 outputs; focused icon tests 8/8 and ontology tests 5/5 passed.
- The generated ontology schema region remains byte-identical to the prior head: 85,255 bytes, SHA-256 `6d690d7d60f1c92d81d61e5c4bd9d487219ff1372e504920b6eaacc3c1959697`.
- Docs bundle and smoke passed across 12 routes, normalized section anchors and internal routes/fragments. Pagefind search was rebuilt.
- Root inspected all 12 routes at a 390px viewport without horizontal document overflow, and representative desktop, dark, mobile, menu, search and deep-link states. This does not claim every route was visually inspected at every viewport/theme.
- Root verified searching for restore offers the restore section, opens its containing disclosure and lands below the sticky header. Ontology mobile gutters and diagram arrow orientations were checked after correction.
- Guarded `bun run check`, full workspace formatting, scoped all-target xtask Clippy and all 27 structural rules passed after the final changes.

Preview: `http://127.0.0.1:4175/docs/`. Root's screenshot is `/private/tmp/centraid-1201-docs-preview.jpg`. The committed native Home image is `scripts/docs-site/public/assets/home-iphone.png`; it shows a newly onboarded vault with its starter Note, not a wholly empty vault.
