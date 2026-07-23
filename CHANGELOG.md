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

- First-class Connectors platform ([#524](https://github.com/srikanth235/centraid/issues/524)): top-level navigation, durable connection-bound automations, provider sync/action capabilities, and 11 additional pull templates with recoverable incremental cursors.
- Centraid Assist for Google connectors ([#526](https://github.com/srikanth235/centraid/issues/526)): a stateless OAuth code courier, gateway-owned PKCE and token custody, desktop/PWA return handling, fail-closed restricted scopes, recovery guidance, and production verification gates.
- Three-number versioning and multi-surface release synthesis ([#512](https://github.com/srikanth235/centraid/issues/512)): product / build / protocol separation; handshake connects on protocol only; release surface matrix (`bun run release:matrix`); prepare/publish ship set
- Agent self-serve documentation set for solo-maintainer leverage ([#468](https://github.com/srikanth235/centraid/issues/468)): decisions, glossary, coding standards, protocol, release, recovery, traps, enrollment, identifiers, and related root docs.

### Changed

- Gateway info handshake no longer refuses clients solely because product version strings differ; capability flags still gate features ([#512](https://github.com/srikanth235/centraid/issues/512))
