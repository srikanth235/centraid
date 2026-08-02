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

### Shipped: the vocabulary, and the exact-match half of the sweep

Recorded **2026-08-02**, same issue. `--t-<key>-size` now exists on both surfaces — one property per **distinct** size, so `body`/`bodyStrong` (both 15px) publish `--t-body-size` and nothing else. `typeSizeRungs()` in `packages/design/src/typography.ts` derives them, `toCss()` and `toBlueprintCss()` emit them, and `contract.ts` derives both contracts from the same call rather than a hand-list. The blueprint type scale moved into `typography.ts` as `blueprintType` in the process — it was six opaque shorthand strings, from which no size could be read.

**No line-height rungs.** The data does not support them and speculative vocabulary is worse than none: of 227 hand-written `line-height` declarations across the three targets, all but a handful are unitless multipliers, while the chrome scale's line-heights are absolute px. A `--t-body-line-height: 22px` would be a rung nothing could adopt.

**411 declarations converted, provably zero visual change** — 402 in `packages/client/src`, 9 in `packages/blueprints/apps`. The bar was tightened twice against the estimate above:

- **Per-surface scales, not one scale.** The 494/477/314 split measured every target against the _chrome_ scale. The blueprint layer has its own — `--t-small` is 13px in the chrome and `0.8rem` in an app — so a `13px` inside `packages/blueprints/apps` was never an exact match. Against the scale that actually resolves there, the exact set is 402 + 9, not 494.
- **Same unit, not same computed px.** `1rem` and `16px` agree only at a 16px root; a reader who has raised their browser's default font size would see the second stop tracking. Only like-for-unit conversions were made (px→px rung in the chrome, rem→rem rung in the blueprints).

**`packages/design/kit` was left alone entirely.** `kit.css` renders under _both_ token layers — the shell `:root` and the rescoped `.centraid-inline-scope` block — so its eight exact matches resolve to two different values, and every one of them would move on one of the two surfaces.

**Still open, as recorded debt:** the ~477 near-misses (within 0.6px) and the ~314 genuinely off-scale declarations. Both are visual changes and need per-site judgement, not a sweep. The ratchet total fell 1291 → 880 with no other metric moving, and `rawFontSize` now counts `font-size: var(--t-<key>)` — naming a shorthand where a size belongs — as debt rather than letting it hide inside the `var()` carve-out.

## #686 — one token name, two meanings: the shell and blueprint type scales have diverged

Recorded **2026-08-02** under [#686](https://github.com/srikanth235/centraid/issues/686). Surfaced while adopting the composable size rungs; **not fixed** — it needs a deliberate call.

`toCss()` and `toBlueprintCss()` both emit `--t-*`, and the contract's rule is that an emitter "may choose values appropriate to its surface, but cannot invent a second spelling for a semantic role." The inverse has happened: the same spelling now carries a **different role** on each surface.

| token | shell | blueprint |
| --- | --- | --- |
| `--t-body` | 15px / 22px, sans, 400 | 0.855rem (13.68px) / 1.5, sans, 400 |
| `--t-small` | 13px / 18px, sans, 400 | 0.8rem (12.8px) / 1.45, sans, 400 |
| `--t-mono` | 12px / 16px, mono, 500 | 0.72rem (11.52px) / 1.4, mono, 500 |
| **`--t-tiny`** | 11px / 14px, **sans**, **500** | 0.6rem (9.6px) / 1.4, **mono**, **600** |

Size and line-height differing per surface is defensible — an embedded app pane is not the chrome. `--t-tiny` changing **family and weight** looked like the one indefensible cell: a rule that reads "the eyebrow rung" gets sans-500 in the shell and mono-600 in an app.

This matters because **`kit.css` is served to both surfaces**. Of its 80 hardcoded `font-size` declarations, **20 exactly match a blueprint rung and 0 match a shell rung** — the kit's type was authored against the app scale while rendering on both. Because those values are hardcoded, kit components currently render at app sizes _inside the chrome_, and cannot be tokenised without moving on one surface or the other. That is why the size-rung sweep skipped `kit.css` entirely.

**Options as first recorded.** (a) Reconcile the two scales so a role means one thing, and let only the _values_ differ. (b) Rename the blueprint rungs so the divergence is explicit rather than implied. (c) Declare `kit.css` blueprint-scoped and give the chrome its own component sheet. The sub-entry above closes the family/weight half of (a) on evidence — the two surfaces bind the same role to different faces because they carry different rungs, which the contract permits; (b) and (c) stand.

Until then, `DESIGN.md`'s claim that the kit "holds no design decisions of its own" is true of colour, radius and spacing, and **false of type** — 80 sizes live there.

### Resolved by measurement: the shell's `--t-tiny` is not the eyebrow rung, so it does not move

Recorded **2026-08-02**, same issue. The obvious reading — that the shell's sans is a plain outlier against `DESIGN.md`'s "**Mono is the signature.** Metadata, counts, dates, and eyebrows are mono" and against shell practice — was tested and **does not survive the measurement**. `type.tiny` stays `sans` / 500.

The eyebrow idiom in the shell is real and is overwhelmingly mono: of **120** rules under `packages/client/src` carrying `text-transform: uppercase`, **94 set a mono family in the same block**. But those 94 rules are not `--t-tiny` sites and never were — the sizes they pair with mono are:

| size                         | rules |
| ---------------------------- | ----- |
| 9.5px                        | 36    |
| 10px                         | 21    |
| 10.5px                       | 19    |
| 9px                          | 9     |
| 8.5px                        | 4     |
| `var(--t-tiny-size)` (11px)  | 3     |
| 8px                          | 1     |
| `font: var(--t-mono)` (12px) | 1     |

**90 of the 94 sit below `--t-tiny`'s 11px.** The shell's eyebrow is a sub-11px mono rung that the scale does not name, not the 11px rung it does. Two shell eyebrows go further and opt _out_ of mono on purpose — `chrome.module.css` `.sbSection` pairs `font-family: var(--font-sans)` with `font-size: var(--t-tiny-size)`, and `.sbSubLabel` is sans at 10px.

What actually consumes the shell shorthand `font: var(--t-tiny)` is **5 sites in 4 files**, and none of them is an eyebrow or metadata:

| Site | What it is | Verdict |
| --- | --- | --- |
| `packages/client/src/react/screens/SettingsProvidersScreen.module.css` `.ladderMember` | pill holding an agent's display title (`card.title`) | prose label — sans |
| `packages/client/src/react/screens/SettingsProvidersScreen.module.css` `.ladderAdd` | native `<select>`, options are agent titles | form control — sans |
| `packages/client/src/react/screens/SessionStatusStrip.module.css` `.telemetry` | container; its own text is "Working"/"Ready". The numeric readout is the child `.context`, which already sets `font-family: var(--font-mono)` itself | the metadata was already mono; the parent is prose — sans |
| `packages/client/src/react/screens/DevicesCard.module.css` `.renameAction` / `.renameIcon` | buttons reading "Save"/"Cancel", and a pencil glyph | action labels — sans |
| `packages/client/src/react/screens/AssistantScreen.module.css` `.effortPicker select` | native `<select>` (runner / effort / workspace pickers) | form control — sans |

Mobile agrees. Of the seven `t("tiny")` consumers in `apps/mobile/src`, five are prose — `AppHeader.subtitle`, `OptionSheet.rowDetail`, `AttentionLine.chipSub`, `Assistant.statusText`, `Assistant.selectionError` (an error message) — and the two that _are_ eyebrows already override the family themselves: `AppLock.eyebrow` to `family.monoBold`, `LockerHome.fieldLabel` to `family.monoMedium`.

So aligning `type.tiny` to mono would improve **zero** of the 94 mono eyebrows (they already say mono, at sizes the rung does not carry), and would regress **all five** shell sites plus five mobile prose sites — putting `<select>` chrome, "Save"/"Cancel" buttons and an error message into a monospace face. `DESIGN.md`'s "prose is not" clause governs here, not the eyebrow clause.

**The weight question answers itself the same way**, and also refutes the premise that the blueprint's 600 is the settled reading: the two mobile eyebrows that hand-patch the family disagree with each other — 600 and 500 — so there is no single mono eyebrow weight to converge on. The shell's 500 is the correct weight for what the shell rung actually is (a quiet control label; 600 would make "Save" compete with the row it sits in), and the blueprint's 600 is correct for what _its_ rung is (a 9.6px eyebrow, which needs the extra weight to hold at that size). This is a legitimate per-surface difference of a role's _rendering_, not two roles wearing one name.

**What this leaves — and a correction to it.** The first draft of this entry said the shell has an "unnamed sub-11px mono eyebrow rung", implying a single rung waiting to be named. Measuring the 94 rules by _shape_ rather than by size refutes that: they carry **51 distinct (size, weight, tracking) combinations**, and the largest cluster is 6 rules.

| shape                   | rules    |
| ----------------------- | -------- |
| 9.5px, tracking 0.1em   | 6        |
| 9.5px, tracking 0.05em  | 6        |
| 10px, tracking 0.06em   | 5        |
| 10.5px, tracking 0.04em | 5        |
| 10px, tracking 0.1em    | 5        |
| …46 more shapes         | 1–4 each |

So a `--t-eyebrow` shorthand would fit at most 6 of 94 sites. Adding one would repeat the exact mistake the entry above diagnoses — an all-or-nothing token almost nothing can adopt — and would be a second `--r-lg`: vocabulary that exists because it seemed principled, not because anything could use it.

What the 94 rules genuinely share is a **family** (`--font-mono`, already tokenised) and an **idiom** (uppercase + tracking). Sizes span 8–10.5px and tracking varies continuously from 0.04em to 0.1em. That is not a missing token; it is 51 ad-hoc decisions that need converging before any rung can describe them. Converging them is a design pass with a visual diff at ~94 sites — a real piece of work, and explicitly **not** a naming exercise.

**Still genuinely open, and unresolved by any of the above:** (b) whether the blueprint rungs should be renamed so the size/line-height divergence is explicit; (c) whether `kit.css` is blueprint-scoped and the chrome gets its own component sheet. Those remain product decisions.

## #686 — the three questions this issue left open, and their answers

Recorded **2026-08-02** under [#686](https://github.com/srikanth235/centraid/issues/686). Proposed as recommendations and **accepted as written by the maintainer on 2026-08-02** — all three. They are decisions now, not proposals. Agreed order is **(1) → (3) → (2)**, each its own PR; the measurements behind them are in the entries above.

### 1. The 94 mono eyebrows: converge to two rungs, then name them

Measured distribution — sizes `9.5px ×36, 10px ×21, 10.5px ×19, 9px ×9, 8.5px ×4`; tracking `0.06em ×20, 0.05em ×15, 0.04em ×15, 0.1em ×14, 0.08em ×9`. 51 distinct shapes, largest cluster 6.

**Recommend:** converge _first_, name _second_ — the reverse of the instinct. Two rungs cover the real span: a standard eyebrow at **9.5px** (the plurality, 38%) and a section header at **10.5px**, both mono at one tracking value. Pick the tracking from the cluster, not by eye: `0.06em` is the mode and sits mid-range.

The order matters. Naming a rung against 51 shapes produces vocabulary that fits 6% and rots — the `--r-lg` failure. Converging first makes the rung describe something real, and the conversion afterwards is mechanical.

**Cost:** a visual diff at ~94 sites, none individually large. **Do not** attempt it inside a change set that is already doing something else.

### 2. `kit.css`: do NOT blueprint-scope it — make it consume the size rungs

`kit.css` renders under both token layers, and 20 of its 80 hardcoded sizes match a blueprint rung against **0** shell rungs, so its type was authored for the app surface while shipping on both.

**Recommend against** splitting it into two component sheets. That doubles the divergence this issue documented rather than resolving it, and every future component then has two homes. Instead, bind those sizes to `--t-<key>-size`, which now emits from both emitters — a kit button becomes 15px in the chrome and 13.68px in an app.

That is the right answer on the merits, not just the cheap one: an embedded app pane **should** read at app scale. A component that renders identically in both contexts is the actual bug, and it is what ships today.

**Caveat, stated plainly:** this is a visible change on both surfaces, and the eight exact matches were skipped in #686 for exactly this reason. It needs its own PR.

### 3. Should the two emitters' scales diverge? Size yes, role no

**Recommend:** codify the split the contract already implies. **Size and line-height may differ per surface** — a chrome and an embedded pane are different reading contexts, and the emitters exist precisely so values can differ. **Family and weight may not** — those are the role, and one spelling with two roles is the inverse of the contract's own rule.

That makes `--t-tiny` (sans/500 shell, mono/600 blueprint) the one genuine violation. Note that #686 investigated aligning it and **declined**: 90 of the 94 mono eyebrows sit below its 11px, so `--t-tiny` is a quiet control label on the shell side and changing it would monospace prose. The clean fix is therefore (1) first, not a direct edit — once the eyebrow rung exists and is named, `--t-tiny` can be aligned without collateral.

**Sequence:** (1) → (3) → (2). Each is independently shippable; doing (3) before (1) recreates the problem #686 already declined to cause.

## #686 — `--t-*` role parity is now a law with a test behind it

Recorded **2026-08-02** under [#686](https://github.com/srikanth235/centraid/issues/686). Implements decision (3) above (accepted by the maintainer 2026-08-02). Enforced by `packages/design/src/type-role-parity.test.ts`.

**The law.** _Size and line-height may diverge per emitter. Family and weight may not._ A shell and an embedded app pane are different reading contexts, so optical size is legitimately a per-surface value choice — that is what two emitters over one contract are _for_. Family and weight are not a value choice; they are the role. `font: var(--t-tiny)` has to mean something.

**Family is compared by genus, not by name or stack.** The two emitters legitimately spell one role with different custom properties (`--font-display` in the shell, `--font-title` in the blueprint layer, both aliasing a sans stack) and ship different concrete stacks for the same genus — the blueprint layer is sandboxed and loads no fonts, so its stacks are system-only and ordered differently. What the law gates is `sans-serif` vs `monospace` vs `serif`, resolved by following `var()` aliases to the generic family the stack ends in.

**The full derived comparison**, from `packages/design/src` rather than from any prior table. Six roles are published by both emitters:

| role | shell | blueprint | family | weight |
| --- | --- | --- | --- | --- |
| `--t-body` | sans-serif 400, 15px/22px | sans-serif 400, 0.855rem/1.5 | agree | agree |
| `--t-body-strong` | sans-serif 600, 15px/22px | sans-serif 600, 0.855rem/1.4 | agree | agree |
| `--t-mono` | monospace 500, 12px/16px | monospace 500, 0.72rem/1.4 | agree | agree |
| `--t-small` | sans-serif 400, 13px/18px | sans-serif 400, 0.8rem/1.45 | agree | agree |
| **`--t-tiny`** | **sans-serif 500**, 11px/14px | **monospace 600**, 0.6rem/1.4 | **DIFFER** | **DIFFER** |
| `--t-title` | sans-serif 600, 20px/26px | sans-serif 600, 1.15rem/1.2 | agree | agree |

`--t-display`, `--t-display-1`, `--t-h2` and `--t-h3` are shell-only and out of the law's scope — the law governs shared spellings, not the union.

**So `--t-tiny` is the only violation, and it is waived, not fixed.** Both sides were re-derived after lane (1) landed and the earlier reading holds: the shell's five `font: var(--t-tiny)` sites are two native `<select>`s, a Save/Cancel pair plus a pencil glyph, a pill holding an agent title, and the "Working"/"Ready" telemetry strip — **zero** eyebrows, plus five mobile prose consumers including an error message. The blueprint's **twelve** sites are **ten** uppercase + `--tracking-eyebrow` eyebrows at 0.6rem (9.6px), with two chips. Forcing mono monospaces prose and controls; forcing sans de-monospaces an entire surface's eyebrow idiom. Neither side is wrong; the spelling is.

The fix is therefore **not** to pick a winner — it is open decision (b), naming the eyebrow role separately. Lane (1) converged the 94 shell eyebrows onto two rungs but deliberately did not name them, so the vocabulary that would let `--t-tiny` align does not exist yet. Until it does, the divergence sits in `ROLE_PARITY_ALLOWLIST` with this reasoning attached, and the test asserts the entry is still _needed_ — the moment the two sides agree, the stale waiver fails the suite.

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
