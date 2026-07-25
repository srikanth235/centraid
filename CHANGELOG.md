# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with the release rules in [docs/release.md](docs/release.md) (issue #468 **D3** / **D4** / **I12**):

- **Patch** — every entry under *Fixed* only.
- **Minor** — anything *Added*, *Changed*, or *Removed*.
- **Major** — not used before 1.0; agents never propose one.
- GitHub Release bodies are generated from the matching section here (D3).
- In-app "what's new" is re-wired from this feed as an explicit D3 checklist item (I12); no permanent placeholder UI.

## [Unreleased]

### Added

- Storage page with local footprint accounting and two owner-set limits ([#544](https://github.com/srikanth235/centraid/issues/544)): the Operations sidebar's **Backups** page is now **Storage** and shows how much of the machine's disk Centraid is using, split by component (attachments, ledger, vault database, app code, app data, backup staging, runner cache, logs, templates, gateway state) and per vault, against the volume it sits on. A **disk budget** warns as it fills — degrading a new `storage-limit` health component at 80% and again at the limit — and never blocks a write. A **ledger limit** makes conversation and audit archival run early, narrowing its window 90 → 30 → 14 → 7 days until `journal.db` is back under; the 7-day floor means archival never reaches inside the window you are working in. Both limits are off by default. New gateway routes `GET /_gateway/storage/local` and `GET|PUT /_gateway/storage/limits`.
- First-class Connectors platform ([#524](https://github.com/srikanth235/centraid/issues/524)): top-level navigation, durable connection-bound automations, provider sync/action capabilities, and 11 additional pull templates with recoverable incremental cursors.
- Centraid Assist for Google connectors ([#526](https://github.com/srikanth235/centraid/issues/526)): a stateless OAuth code courier, gateway-owned PKCE and token custody, desktop/PWA return handling, fail-closed restricted scopes, recovery guidance, and production verification gates.
- Three-number versioning and multi-surface release synthesis ([#512](https://github.com/srikanth235/centraid/issues/512)): product / build / protocol separation; handshake connects on protocol only; release surface matrix (`bun run release:matrix`); prepare/publish ship set
- Agent self-serve documentation set for solo-maintainer leverage ([#468](https://github.com/srikanth235/centraid/issues/468)): decisions, glossary, coding standards, protocol, release, recovery, traps, enrollment, identifiers, and related root docs.

### Changed

- Settings → **Storage** is now **Storage provider**, so it is not confused with the Operations page that took the name Storage; it still owns the provider connection and the per-vault hosted/local choice, and the Backups card's "Manage" link still lands there ([#544](https://github.com/srikanth235/centraid/issues/544))
- Gateway info handshake no longer refuses clients solely because product version strings differ; capability flags still gate features ([#512](https://github.com/srikanth235/centraid/issues/512))
- Resource sizing is now cgroup- and steal-aware: the hardware baseline sizes the share you granted of the host rather than the raw machine, and resource modes are budget presets over that share. On container-limited or high-CPU-steal hosts the resolved worker and memory knobs may decrease to match the actually-granted share; plain hosts resolve to the same numbers as before ([#528](https://github.com/srikanth235/centraid/issues/528))
