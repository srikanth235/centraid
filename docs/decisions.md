# Decisions (issue #468)

Settled **2026-07-20**. Source of truth for judgement calls that blocked solo-maintainer leverage work. Cite this file instead of re-asking. If a decision is wrong in practice, say so in a PR comment and change it here — do not quietly implement something different.

Full issue: [#468](https://github.com/srikanth235/centraid/issues/468).

## The four that gated whole groups

| Id | Decision |
| --- | --- |
| **H1** | **The gateway runs detached.** The desktop launches it as a child that outlives the app window. The always-on premise is load-bearing for pairing, the browser extension ([#462](https://github.com/srikanth235/centraid/issues/462)), and mobile. H2–H7 are implemented; the in-process path remains only for tests and explicit `CENTRAID_EMBEDDED_GATEWAY=1`. Rationale: [H1 rationale](#h1-detached-gateway). |
| **C1** | **No fallback paths, confirmed.** Hard capability gating with an "update the host" wall, no degraded modes. With both ends under one maintainer's control and no compatibility promise before 1.0, every fallback branch is code that gets written defensively and reviewed forever. The protocol-contract half (never break parsing) keeps the wall graceful rather than a crash. See [protocol.md](protocol.md). |
| **Signing** | **Enroll in all three now.** Apple Developer Program for notarization; **Azure Trusted Signing** for Windows rather than an OV/EV certificate (cheaper, faster to obtain, and the key never exists as a file in CI); **Play App Signing** for Android, so Google holds the release key and we hold only a recoverable upload key. Wall-clock lead time — start before pipeline work. Checklist: [enrollment.md](enrollment.md). |
| **J7** | **Store-only releases, with a dormant hotfix lane.** Install and configure `expo-updates` with `runtimeVersion: { policy: "appVersion" }` and production/development channels, but add **no `eas update` step to CI**. Store releases stay the only routine path. OTA is a configured hotfix lane for one already-shipped version only (`checkAutomatically: "ON_ERROR_RECOVERY"`). |

## Policy table

| Item | Decision |
| --- | --- |
| **D4** | Patch = fixes only. If every changelog entry sits under _Fixed_, it is a patch; anything added, changed, or removed is a minor. No major before 1.0, and agents never propose one. See [release.md](release.md). |
| **D5** | Beta channel is desktop-only. TestFlight and the Play internal track already are the mobile beta channel; web continuous host is **`app.centraid.dev`** (gateway-served PWA remains LAN fallback). Tags: `v0.x.y-beta.n` as GitHub pre-releases on a separate updater channel — never move the stable download target or `latest` **image** tag (GHCR `centraid-gateway`). |
| **R1** | **One product version** stamps the monorepo. Surfaces may skip _shipping_ a version; they never keep a divergent package version in git. |
| **R2** | **Build numbers** are script-derived from product semver (`major*1e6+minor*1e3+patch`). Never hand-set. Store resubmit without product change is not supported — cut a patch. |
| **R3** | **Protocol version** is the only runtime connect comparator; product version is display-only. Capability flags gate features (C1). See [protocol.md](protocol.md) / #512. |
| **R4** | **Default ship set** on product tag: desktop, gateway-image, gateway-npm. Mobile is dispatch-opt-in. Web/docs are continuous on main. |
| **R5** | **Never bump product version only to fix a failed build.** Rebuild / re-run workflows / surface retry; reserve semver for real product change. |
| **F1** | **1.0 is defined as** the first release after which every schema change ships a migration. Before it: epoch bumps may require vault re-creation and the version handshake refuses mismatches. Pre-1.0 stores rely on optional-fields-with-defaults for forward compatibility. |
| **H5** | OS service install is **opt-in**, offered during onboarding, **default off**. Silent service installation is the one thing that makes users distrust a local-first app. LaunchAgent label `dev.centraid.gateway` (see [identifiers.md](identifiers.md)). |
| **J1** | Upload key in GitHub Actions secrets; release key held by Play App Signing. An upload key is recoverable if lost; a self-managed release key is not. |
| **J4** | Yes, unconditionally — secrets move to platform secure storage (`expo-secure-store` / Keychain / Android Keystore). Recorded deliberately; there is no argument for plaintext once we submit to stores. |
| **J5** | Reverse-DNS root is **`dev.centraid`**, not `com.centraid`. Full table: [identifiers.md](identifiers.md). |
| **K5** | PWA manifest `"id": "/"`, landed before any real install exists. Without it, install identity derives from `start_url` and later changes orphan installs. |
| **I12** | Hide the "what's new" placeholder; re-wire to GitHub Releases feed (desktop `changelog.ts`). **Closed in #501:** sidebar entry + once-per-version auto-open via `changelogSeenVersion`. |
| **L1 / E2** | PR-time: unit, integration, the boot-the-artifact smoke unconditionally, plus **path-filtered** client e2e. Nightly: full cross-client suites, perf budgets, mobile. Promotion rule: if a nightly-only area burns us twice, it moves to PR-time. See [TESTING.md](../TESTING.md). |
| **L3** | `TESTING.md` wins; any suite README that contradicts it is stale and gets corrected. |
| **L4** | Triage orphaned desktop e2e flows against the [#458](https://github.com/srikanth235/centraid/issues/458) flow inventory; adopt what covers a real gap; delete the rest in one commit. |
| **T1 (superseded)** ([#505](https://github.com/srikanth235/centraid/issues/505)) | Historical direct-transport decision; see the amendment below for the current connection contract. |
| **T1 amendment** ([#555](https://github.com/srikanth235/centraid/issues/555), supersedes T1/#505) | **Gateway connections are iroh-only and identified by EndpointId.** Per-device HTTP tokens, direct URL connections, and `POST /centraid/_gateway/pair` are removed. Relay hints are refreshable cache. Every request resolves a real vault enrollment; there is no wildcard admin plane. The original T1 remains above as the historical decision being reversed. |
| **#298 erase amendment** ([#555](https://github.com/srikanth235/centraid/issues/555), supersedes #298's “leave the seal key behind” recovery posture) | **A completed vault erase crypto-erases its independent DEK.** Gateway rows and an erase intent commit first; content and the DEK are then unlinked; boot idempotently completes a crash-left intent. The gateway EndpointId and recovery-kit fingerprint survive. Recovery after erase is through a previously exported, passphrase-wrapped kit and provider snapshot—not a seal key deliberately retained on the erased host. **Amended by [#603](https://github.com/srikanth235/centraid/issues/603):** the erase ceremony itself is unchanged, but restore-after-erase is now the backup-plane `centraid-gateway recover` only — the `vaults:restore` founding route it used to name is gone. |
| **Founding retirement** ([#603](https://github.com/srikanth235/centraid/issues/603), supersedes the #555/#568 zero→one founding plane) | **A gateway founds itself; there is no ceremony.** Constructing over a _fresh_ data dir creates `Shared` (first) and `Personal` (marked `personal`, hence the registry default and the head of every vault listing — see #665), and enrols the host device as `admin` on both. An existing data dir is never modified. Deleted: the `centraid-gw-found` ticket kind, `init-ticket`, `serve --init-vault` / `initVaultName`, the `vaults:initialize` / `:initialize/verify` / `:restore` routes, the `uninitialized` 409 wall and its fresh-gateway allowlist, the FoundingScreen, and the founding recovery-kit ceremony. Recovery kits keep their **backup-plane** life (`backup kit` export, `recover`, Settings surfaces); they may return as a first-class Settings export post-v0. Consequently there is exactly one ticket concept — the **pair ticket** — and web/PWA + mobile onboarding is ticket-only, because only a desktop can start a gateway. |

## Defaults (so nobody has to ask)

| Topic | Default |
| --- | --- |
| **B3 knip** | knip, per-workspace, warn-first for one week then error |
| **G1 dev env** | Promote existing `.claude/launch.json` (when present) plus [dev-environment.md](dev-environment.md) — do not invent a new manifest format |
| **I5 rollout** | 72-hour staged rollout window; stable per-install bucket (`bucket < elapsed/window`) |
| **I10 packaging** | ZIP **and** DMG on macOS; per-user NSIS on Windows |
| **K11 fonts** | System font stack in the app shell; no webfont / no render-blocking third-party CDN |

## H1 — Detached gateway

### Decision

The desktop-hosted gateway is a **detached child process** that outlives the Electron app window (and, after H5 opt-in, can outlive logout/reboot via OS service).

### Why not "gateway dies with the app"

Closing the desktop window must not take the vault offline for:

- paired phones and the Expo client,
- the browser PWA / ticket-only Iroh path,
- the companion extension ([#462](https://github.com/srikanth235/centraid/issues/462)),
- any always-on automation schedule that expects a reachable gateway.

Scoping the gateway to the app lifetime would force rewriting the product story (always-on personal software) rather than fixing the process model.

### Implemented implications

- **H2** — spawn detached, ignore stdio, `unref()` so a dead app cannot wedge a full stdout pipe.
- **H3** — ownership stamp in the pid-lock; adopt-don't-kill foreign/developer-started gateways.
- **H4** — stable default port + status probe for the bound address (no ephemeral-port bookmarks).
- **H5** — OS service opt-in (LaunchAgent / systemd / Windows service), default off.
- **H6** — lifecycle verbs through the bundled CLI for app and terminal parity.
- **H7** — preserve the existing crash-loop breaker.

The production desktop path now satisfies H2–H7. The in-process `serve()` path remains an explicit test/E2E escape hatch, not the default product topology.

## Signing identities (enrollment targets)

| Platform | Mechanism | Notes |
| --- | --- | --- |
| macOS | Apple Developer Program | Hardened runtime, notarization, entitlements (I2) |
| Windows | Azure Trusted Signing | Prefer over OV/EV; key never a CI file (I3) |
| Android | Play App Signing | Google holds release key; we hold recoverable upload key (J1) |

Human residual checklist (no secrets in git): [enrollment.md](enrollment.md).

## #599 — household members, sharing, and the no-credential invariant

Settled **2026-07-27** in [#599](https://github.com/srikanth235/centraid/issues/599). The standing invariants:

- **Authentication is the transport.** Devices prove iroh EndpointIds in the QUIC handshake; the host proves custody of the data dir (landlord bearer derived from the endpoint key). There is **no password/session/OIDC plane by design** — identity-proofing for a new member is an owner handing them a ticket. Any future feature that wants a login screen is re-opening this decision, not extending it.
- **Model A over Model B.** Vault-per-person plus additional shared vaults on one household gateway — never one vault with many member principals and row-level visibility. Rationale: 46/122 FK edges in the ontology point at `core_party`; per-member ACLs would put an "as whom?" filter into every query, agent turn, and automation, break the sovereignty story, and reintroduce OIDC pressure.
- **Authority is authored on `(member, vault)`;** devices are bindings that inherit. No per-device roles, no attenuation. Roles are ownership words (Owner / Member / Viewer over `admin`/`write`/`read`).
- **Sharing is placement, not filtering.** Selective sharing projects rows/blobs into an audience vault (hardlinked CAS, `core_share_origin` provenance sidecar, single-DB transaction in the audience vault). Row-level ACLs are rejected as fail-open; **narrower vaults over finer roles** is the fence.
- **Household participation and domain identity stay separate.** An authenticated gateway `member` with a role in the audience vault may read/write a placed Tally group; a Tally `core_party` / `social_circle_member` remains an accounting identity and never grants authority. Locker placements are re-encrypted under the audience vault's independent DEK rather than copying ciphertext or introducing a household-wide key. Revocation removes the member role; explicit unshare removes the audience projection, and both gestures preserve access receipts.
- **v0 encryption posture: the local gateway is not an adversary.** Local blobs stay plaintext (`packages/vault/src/blob/local.ts`); sealing exists for untrusted remote storage and activates exactly when a storage/CAS provider is configured. Stolen-disk is the OS full-disk-encryption's job. Accepted, deferred loss: remote dedup of shared blobs (each vault seals under its own keys); local dedup is kept because the filesystem link count is the cross-vault refcount.

## #630 — blueprint-readiness policies

Settled **2026-07-29** in [#630](https://github.com/srikanth235/centraid/issues/630). The issue's Wave 0 exit text says “all six decisions,” but its checklist names seven; all seven are binding:

| Topic | Decision |
| --- | --- |
| Schema migrations | **Real-vault-preserving migrations start now for blueprint-readiness data.** F1 remains the general pre-1.0 compatibility posture, but it is not permission to erase a person's real vault. New #630 tables/columns use the existing ordered `packages/vault/src/schema/migrate.ts` machinery, prove upgrade from the previous user version, and never require erase/re-import. |
| Backup and restore | **Schema and recovery land atomically.** A change that creates versions, recurrence exceptions, notification registrations, sync cursors, or household grants also proves snapshot/restore and restore-after-erase retain them. Whole-database backup is not sufficient evidence by assertion; the recovery test seeds and reads the new rows. |
| Notification permission | **Prompt at the first reminder, never at launch.** The action that creates a first reminder explains the value, then requests OS permission. A denial leaves the reminder visible with an actionable Settings path and does not nag on later launches. |
| Local OCR | **Device-native first, bounded gateway backstop.** iOS uses Vision text recognition and Android uses ML Kit on-device recognition; the PWA/manual gateway path uses a local Tesseract-compatible worker. Gateway work is one document at a time, capped at 20 megapixels / 25 MiB, with a Raspberry Pi 4-class 4 GiB host as the supported low-end floor. No image or recognized text leaves the user's devices. |
| Quick-add routing | **Heuristics first, agent fallback.** Deterministic, offline rules route unambiguous task/expense/note/event text immediately; ambiguous input asks the local agent for a classified preview. Nothing commits before the user sees the destination and parsed fields. |
| Google OAuth | **BYO-client first for Calendar/Contacts.** The shared Assist client does not request these sensitive scopes until Google's production verification evidence is accepted. BYO remains functional throughout and uses the same connector/sync contract. |
| Push topology | **Expo Push Service is a wake-only relay, with local fallback.** The relay receives device tokens, timing, an opaque registration id, and a content-free wake/deep-link class—never titles, bodies, secrets, entity names, or sealed columns. The gateway remains canonical for content after open. Installations that disable the relay retain on-device scheduled notifications while the app is resident, with the availability limitation stated in Settings. |

## #686 — typography is a contract of ROLES, not families

Recorded **2026-08-01** as an orchestrator recommendation under [#686](https://github.com/srikanth235/centraid/issues/686). Canonical design document: [DESIGN.md](../DESIGN.md).

- **The contract names roles, never faces.** `sans` / `display` / `mono` / `serif`, plus the semantic scale in `packages/design/src/typography.ts` (`size`, `lineHeight`, `weight` per key). A surface binds roles to faces; a surface never adds a role, and no consumer may set an arbitrary `font-family`.
- **Web and desktop use system stacks. #468 K11 stands.** `system-ui` / `ui-monospace` chains, no webfont family first, so the chrome never blocks on a network fetch. This is not up for renegotiation as part of #686.
- **Mobile maps the same roles to platform-appropriate loaded faces.** React Native cannot combine `fontFamily` with `fontWeight` reliably across platforms, so each (role, weight) pair must be its own family name. The current mapping in `apps/mobile/src/kit/theme/index.ts` — Geist (sans), Space Grotesk (display), JetBrains Mono (mono), Playfair Display (serif) — is **recorded here as the sanctioned per-role mapping**, pending a future revisit toward native faces (San Francisco / Roboto) if the download weight or the cross-platform look argues for it.
- **Therefore the web↔mobile face divergence is decided, not drift.** An audit that finds different family names on the two surfaces has found the intended state. The thing to check is that mobile still resolves _roles and the numeric scale_ from `@centraid/design`, and that the size/lineHeight/weight values are not re-typed by hand.

## #686 — the type scale is not under-adopted, it is under-shaped

Recorded **2026-08-02** under [#686](https://github.com/srikanth235/centraid/issues/686).

`--t-*` are CSS `font` **shorthands**, so using one sets family, weight, size and line-height together. A rule that wants the scale's _size_ but a different weight — or that must inherit the family — cannot use the token at all, and has to write a raw `font-size`. The repo-wide ratchet counts those as debt, which framed 1,284 declarations as indiscipline. The measurement says otherwise:

| relation to the scale | declarations | share |
| --------------------- | ------------ | ----- |
| exactly a token size  | 494          | 38%   |
| within 0.6px of one   | 477          | 37%   |
| genuinely off-scale   | 314          | 24%   |

**181 of those rules already set `font: var(--t-*)` and then override `font-size`.** That is the shape problem stated in the authors' own hands: they reached for the token, then had to fight it.

**Decision.** Treat this as a token-shape gap, not a cleanup backlog. The scale should expose composable size (and line-height) rungs alongside the shorthands, so a rule can take the size without inheriting the weight. Roughly 971 of the 1,284 declarations would then become token references with **no visual change** — the values already match.

**Not done here.** #686 is already 243 files; adding vocabulary plus a 971-site sweep would make the visual diff unreviewable. The ratchet in `scripts/lint-design-tokens.mjs` holds the count meanwhile, and this entry records that the count is a symptom rather than the fault.

## Related docs

| Doc | Covers |
| --- | --- |
| [protocol.md](protocol.md) | C1–C4 two-contract + COMPAT + wire purity |
| [release.md](release.md) | D1–D6 prepare vs publish, patch/minor, beta |
| [identifiers.md](identifiers.md) | J5 full `dev.centraid.*` table |
| [enrollment.md](enrollment.md) | Apple / Azure / Play human steps |
| [DESIGN.md](../DESIGN.md) | The canonical design document the #686 typography entry implements |
| [TESTING.md](../TESTING.md) | L1/E2 PR vs nightly |
| [SECURITY.md](../SECURITY.md) | F2 threat model |
