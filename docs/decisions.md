# Decisions (issue #468)

Settled **2026-07-20**. Source of truth for judgement calls that blocked solo-maintainer leverage work. Cite this file instead of re-asking. If a decision is wrong in practice, say so in a PR comment and change it here — do not quietly implement something different.

Full issue: [#468](https://github.com/srikanth235/centraid/issues/468).

## The four that gated whole groups

| Id | Decision |
| --- | --- |
| **H1** | **The gateway runs detached.** It becomes a child process that outlives the app window. The always-on premise is load-bearing for pairing, the browser extension ([#462](https://github.com/srikanth235/centraid/issues/462)), and mobile; scoping the gateway to app runtime would mean rewriting the product story instead of the process model. This unblocks all of group I. Rationale write-up: [H1 rationale](#h1-detached-gateway) below. Implementation is H2–H7 (not docs). |
| **C1** | **No fallback paths, confirmed.** Hard capability gating with an "update the host" wall, no degraded modes. With both ends under one maintainer's control and no compatibility promise before 1.0, every fallback branch is code that gets written defensively and reviewed forever. The protocol-contract half (never break parsing) keeps the wall graceful rather than a crash. See [protocol.md](protocol.md). |
| **Signing** | **Enroll in all three now.** Apple Developer Program for notarization; **Azure Trusted Signing** for Windows rather than an OV/EV certificate (cheaper, faster to obtain, and the key never exists as a file in CI); **Play App Signing** for Android, so Google holds the release key and we hold only a recoverable upload key. Wall-clock lead time — start before pipeline work. Checklist: [enrollment.md](enrollment.md). |
| **J7** | **Store-only releases, with a dormant hotfix lane.** Install and configure `expo-updates` with `runtimeVersion: { policy: "appVersion" }` and production/development channels, but add **no `eas update` step to CI**. Store releases stay the only routine path. OTA is a configured hotfix lane for one already-shipped version only (`checkAutomatically: "ON_ERROR_RECOVERY"`). |

## Policy table

| Item | Decision |
| --- | --- |
| **D4** | Patch = fixes only. If every changelog entry sits under *Fixed*, it is a patch; anything added, changed, or removed is a minor. No major before 1.0, and agents never propose one. See [release.md](release.md). |
| **D5** | Beta channel is desktop-only. TestFlight and the Play internal track already are the mobile beta channel; web continuous host is **`app.centraid.dev`** (gateway-embedded PWA remains LAN fallback). Tags: `v0.x.y-beta.n` as GitHub pre-releases on a separate updater channel — never move the stable download target or `latest` **image** tag (GHCR `centraid-gateway`). |
| **R1** | **One product version** stamps the monorepo. Surfaces may skip *shipping* a version; they never keep a divergent package version in git. |
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
| **T1** ([#505](https://github.com/srikanth235/centraid/issues/505)) | **The `direct` transport tier stays, on per-device tokens only.** A self-fronted https URL (Tailscale / Caddy / Cloudflare Tunnel) is a v0-supported remote topology alongside iroh — so the per-device HTTP token store and the HTTP pairing twin (`POST /centraid/_gateway/pair`, issue #376) survive. What dies with phase 7 is the **shared gateway-wide admin token** (`token.bin` / `print-token` / the desktop URL+token paste form): there is no durable bearer that grants every vault. A `direct`-tier gateway is added the same way as an iroh one — by redeeming a pairing ticket (over its URL, `mode:'http'`), which mints a per-device token confined to that device's enrollments. Admin capability is the per-device, revocable `owner` enrollment trust tier; the CLI-admin loopback mechanism (open question 6) is a per-launch/ephemeral loopback secret handed to the daemon in-process (the CLI itself needs no HTTP auth — it operates on `--data-dir` files directly). |

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

### Implications (implementation still H2–H7)

- **H2** — spawn detached, ignore stdio, `unref()` so a dead app cannot wedge a full stdout pipe.
- **H3** — ownership stamp in the pid-lock; adopt-don't-kill foreign/developer-started gateways.
- **H4** — stable default port + status probe for the bound address (no ephemeral-port bookmarks).
- **H5** — OS service opt-in (LaunchAgent / systemd / Windows service), default off.
- **H6** — lifecycle verbs through the bundled CLI for app and terminal parity.
- **H7** — preserve the existing crash-loop breaker.

Until H2–H7 land, the code may still embed the gateway in-process; this file is the policy agents implement toward.

## Signing identities (enrollment targets)

| Platform | Mechanism | Notes |
| --- | --- | --- |
| macOS | Apple Developer Program | Hardened runtime, notarization, entitlements (I2) |
| Windows | Azure Trusted Signing | Prefer over OV/EV; key never a CI file (I3) |
| Android | Play App Signing | Google holds release key; we hold recoverable upload key (J1) |

Human residual checklist (no secrets in git): [enrollment.md](enrollment.md).

## Related docs

| Doc | Covers |
| --- | --- |
| [protocol.md](protocol.md) | C1–C4 two-contract + COMPAT + wire purity |
| [release.md](release.md) | D1–D6 prepare vs publish, patch/minor, beta |
| [identifiers.md](identifiers.md) | J5 full `dev.centraid.*` table |
| [enrollment.md](enrollment.md) | Apple / Azure / Play human steps |
| [TESTING.md](../TESTING.md) | L1/E2 PR vs nightly |
| [SECURITY.md](../SECURITY.md) | F2 threat model |
