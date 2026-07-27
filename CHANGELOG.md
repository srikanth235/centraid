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

- Vault founding plane ([#555](https://github.com/srikanth235/centraid/issues/555)): a gateway now boots with **zero vaults** and stays legally uninitialized until a first-run ceremony founds one. Create downloads a password-wrapped recovery kit and requires you to re-select it before the vault opens; Restore brings backed-up vaults back from that kit plus a provider key. Both consume one short-lived, host-minted founding capability. Settings gains an **erase** ceremony (owner device, exact typed vault name, verified kit) that crypto-erases the vault's key and returns the gateway to its uninitialized state. All gateway state — preferences, enrollments, tickets, web sessions, backup fencing — now lives in a single `gateway.db` that is also the exclusive single-writer process lock. An interrupted ceremony is resumable from the first-run screen ([#568](https://github.com/srikanth235/centraid/issues/568))
- Storage page with local footprint accounting and two owner-set limits ([#544](https://github.com/srikanth235/centraid/issues/544)): the Operations sidebar's **Backups** page is now **Storage** and shows how much of the machine's disk Centraid is using, split by component (attachments, ledger, vault database, app code, app data, backup staging, runner cache, logs, templates, gateway state) and per vault, against the volume it sits on. A **disk budget** warns as it fills — degrading a new `storage-limit` health component at 80% and again at the limit — and never blocks a write. A **ledger limit** makes conversation and audit archival run early, narrowing its window 90 → 30 → 14 → 7 days until `journal.db` is back under; the 7-day floor means archival never reaches inside the window you are working in. Both limits are off by default. New gateway routes `GET /_gateway/storage/local` and `GET|PUT /_gateway/storage/limits`.
- First-class Connectors platform ([#524](https://github.com/srikanth235/centraid/issues/524)): top-level navigation, durable connection-bound automations, provider sync/action capabilities, and 11 additional pull templates with recoverable incremental cursors.
- Centraid Assist for Google connectors ([#526](https://github.com/srikanth235/centraid/issues/526)): a stateless OAuth code courier, gateway-owned PKCE and token custody, desktop/PWA return handling, fail-closed restricted scopes, recovery guidance, and production verification gates.
- Three-number versioning and multi-surface release synthesis ([#512](https://github.com/srikanth235/centraid/issues/512)): product / build / protocol separation; handshake connects on protocol only; release surface matrix (`bun run release:matrix`); prepare/publish ship set
- Agent self-serve documentation set for solo-maintainer leverage ([#468](https://github.com/srikanth235/centraid/issues/468)): decisions, glossary, coding standards, protocol, release, recovery, traps, enrollment, identifiers, and related root docs.

### Changed

- The gateway's loopback control bearer is derived from its KeyStore-custodied endpoint key rather than minted per boot ([#555](https://github.com/srikanth235/centraid/issues/555), documented accurately in [#568](https://github.com/srikanth235/centraid/issues/568)): a local process that can open custody derives the same bearer, which is how the CLI and the desktop reach a gateway they did not spawn. It is stable for the life of the endpoint identity and is not rotated
- Settings → **Storage** is now **Storage provider**, so it is not confused with the Operations page that took the name Storage; it still owns the provider connection and the per-vault hosted/local choice, and the Backups card's "Manage" link still lands there ([#544](https://github.com/srikanth235/centraid/issues/544))
- Gateway info handshake no longer refuses clients solely because product version strings differ; capability flags still gate features ([#512](https://github.com/srikanth235/centraid/issues/512))
- Resource sizing is now cgroup- and steal-aware: the hardware baseline sizes the share you granted of the host rather than the raw machine, and resource modes are budget presets over that share. On container-limited or high-CPU-steal hosts the resolved worker and memory knobs may decrease to match the actually-granted share; plain hosts resolve to the same numbers as before ([#528](https://github.com/srikanth235/centraid/issues/528))

### Removed

- The direct-HTTP transport tier and its per-device bearer tokens ([#555](https://github.com/srikanth235/centraid/issues/555)): remote access is iroh-only, and every remote request carries an EndpointId the QUIC handshake proved. The shared `token.bin` bearer plane and the wildcard admin/recovery HTTP mounts are gone with it
- Unwrapped recovery kits are no longer accepted ([#568](https://github.com/srikanth235/centraid/issues/568)): a kit is always password-wrapped. The unwrapped acceptance path also ignored the supplied password, leaving a password-free branch on restore, kit verification, and kit confirmation

### Fixed

- Loopback is not treated as an identity ([#568](https://github.com/srikanth235/centraid/issues/568)): the desktop's phone tunnel and the embedded gateway now refuse host-only capabilities for any request a forwarder delivered to 127.0.0.1, and `GET /_gateway/info` serves the gateway's iroh dial ticket only to an authenticated caller rather than to any local web page
- The admin CLIs open key custody the way the daemon does ([#568](https://github.com/srikanth235/centraid/issues/568)): against a real daemon data directory, `vault list` printed nothing, `status` reported zero vaults, `devices add --vault` failed to resolve a vault, and `devices revoke` silently skipped its vault-local data erasure
- `centraid-gateway service install` on macOS validates that it can decrypt existing keys **before** writing the Keychain credential, and keys that credential per data directory ([#568](https://github.com/srikanth235/centraid/issues/568)) — a failed install used to leave a poisoned entry that made every key in the directory undecryptable
- Opting into the OS gateway service no longer leaves the desktop permanently refusing to adopt it on the next launch ([#568](https://github.com/srikanth235/centraid/issues/568))
- Read-only CLI verbs (`devices list`, `backup status`, `backup list`) report that the running daemon owns the database instead of a raw `database is locked` stack trace ([#568](https://github.com/srikanth235/centraid/issues/568))
- macOS network-filesystem detection reads the mount table's filesystem type; the previous probe could never match and also suppressed its own fallback ([#568](https://github.com/srikanth235/centraid/issues/568))
- Re-opening the founding QR while a restore is downloading no longer destroys that restore ([#568](https://github.com/srikanth235/centraid/issues/568))
