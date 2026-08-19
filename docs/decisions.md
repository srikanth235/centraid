# Current decisions

This file is the adjudication layer over the repository's append-only evidence. It records the decisions that are in force, deliberate non-goals, and supersession chains that keep old evidence from being mistaken for current truth. The linked issues and receipts carry the rationale and implementation history; this file carries the current answer. Update a row when the answer changes and link the issue that settles the change.

## Product positioning

Centraid is a personal, local-first **superapp**: one shell wrapping many first-party apps whose content characters could not be more different. The shell, the vault, and the apps ship together as one product — the owner installs Centraid, not apps into Centraid.

Ruled 2026-08-15 by [#799](https://github.com/srikanth235/centraid/issues/799), which retired the serving plane that made the older "personal app builder" framing true:

- **Not an app builder.** There is no authoring surface, no scaffolder a person points at a blank app, and no build-and-publish loop. `conversation.kind='build'` names the workspace-capable assistant thread, not a retired app-authoring product.
- **Not a platform.** There is no third-party, user-built, or generated app plane, no code store, and no install-from-elsewhere path. The catalogue is the bundled system apps this repo ships.
- **The gateway serves data, never UI bytes.** Every app UI is first-party code in the release: an inline React route in the shared shell, or the same app as an Expo screen on mobile. See [Inline system apps](#inline-system-apps).

Automations remain owner-authored — the automation compiler is a live "builder" in the narrow, internal sense and keeps that word ([blueprints README](../packages/blueprints/README.md)). Retired positioning vocabulary and its replacements are in [glossary.md](glossary.md#forbidden--discouraged-synonyms-broader); the binding design statement of the same idea is [DESIGN.md](../DESIGN.md).

## Foundational decisions

| Id | Current decision |
| --- | --- |
| **H1** | The gateway runs detached. Desktop launches `centraid-gateway` as a child that outlives the app window; the in-process path is test-only and requires `CENTRAID_EMBEDDED_GATEWAY=1`. See [ARCHITECTURE.md](../ARCHITECTURE.md). |
| **C1** | There are no fallback paths for an unsupported protocol or capability. The client shows an update wall; protocol parsing remains strict and graceful. See [protocol.md](protocol.md). |
| **Signing** | Enroll in Apple Developer Program, Azure Trusted Signing, and Play App Signing. Human steps live in [enrollment.md](enrollment.md). |
| **J7** | Mobile uses store releases as the routine path. `expo-updates` is configured as a dormant, already-shipped-version recovery lane; CI does not run `eas update`. |
| **D4** | Patch releases contain fixes only. Added, changed, or removed product behavior is minor before 1.0; agents never propose a major. See [release.md](release.md). |
| **D5** | Beta is desktop-only; TestFlight and Play internal track are mobile beta channels; web is continuous on `app.centraid.dev`. Stable download and `latest` image targets never move for beta. |
| **R1** | One product version stamps the monorepo. A surface may skip shipping a version but never carries a divergent package version. |
| **R2** | Build numbers derive from product semver. A store resubmission without product change is not supported; cut a patch instead. |
| **R3** | Protocol version is the runtime connection comparator. Product version is display-only; capability flags gate features. |
| **R4** | Product tags ship desktop, gateway image, and gateway npm by default. Mobile is dispatch-opt-in; web/docs are continuous on main. |
| **R5** | A failed build is retried or rebuilt; product semver is not bumped solely to make a build pass. |
| **F1** | 1.0 begins when every schema change ships a migration. Before 1.0, epoch changes may require vault recreation and the handshake refuses mismatches. |
| **H5** | OS service installation is opt-in and default-off. The LaunchAgent label is `dev.centraid.gateway`. |
| **J1** | GitHub Actions holds the Android upload key; Google Play App Signing holds the release key. |
| **J4** | Secrets use platform secure storage (`expo-secure-store`, Keychain, or Android Keystore), never plaintext. |
| **J5** | The reverse-DNS root is `dev.centraid`; the full table is [identifiers.md](identifiers.md). |
| **K5** | The PWA manifest id is `/`, so future `start_url` changes do not orphan installs. |
| **I12** | What's new is sourced from GitHub Releases; desktop opens it at most once per product version. |
| **L1 / E2** | PRs run unit, integration, contract, boot-smoke, and path-filtered client e2e; nightly owns full cross-client, performance, scale, mutation, mobile, and pairing lanes. See [TESTING.md](../TESTING.md). |
| **L3** | [TESTING.md](../TESTING.md) is the winning test contract; a contradictory suite README is corrected. |

## Superseded decision pointers

| Former decision | Current pointer |
| --- | --- |
| **T1 / #505 direct transport** | Superseded by [#555](https://github.com/srikanth235/centraid/issues/555): gateway connections are Iroh-only and identified by `EndpointId`; the original transport rationale remains in [#505](https://github.com/srikanth235/centraid/issues/505). |
| **#298 erase posture** | Superseded and amended by [#555](https://github.com/srikanth235/centraid/issues/555) and [#603](https://github.com/srikanth235/centraid/issues/603); current erase/restore behavior is the backup-plane `centraid-gateway recover` contract. |
| **#599 member/role model** | Superseded by [#726](https://github.com/srikanth235/centraid/issues/726); current authority is one owner per vault. |
| **#724 enrichment service** | Superseded by [#731](https://github.com/srikanth235/centraid/issues/731); current recognition runs inside bundled handlers. |
| **#505 served-app plane** | Superseded by [#799](https://github.com/srikanth235/centraid/issues/799); an app UI reaches the screen one way — an inline React route in the shared shell, or the same app as an Expo screen on mobile. |
| **Single-scalar `EnrichTier` per domain** | Superseded by [#807](https://github.com/srikanth235/centraid/issues/807); policy is a scoped cascade with engine selection. The tier survives as the vault-default layer and its `off\|device\|gateway` values as egress-class ceilings — see [Generic enrichment](#generic-enrichment-807). |
| **Delegate step as an OCR-only one-off** | Superseded by [#807](https://github.com/srikanth235/centraid/issues/807); delegate engines are engine profiles selected by policy, and a recipe's `delegateStep.selected` is one of two selectors. OCR remains the first shipped delegate. |
| **#690 / #765 DOM custom elements** | Superseded by [#799](https://github.com/srikanth235/centraid/issues/799); the third rendering technology is gone and every DOM composition is a React block. |
| **"personal app builder" positioning** | Superseded by [#799](https://github.com/srikanth235/centraid/issues/799); Centraid is a personal, local-first **superapp** — see [Product positioning](#product-positioning). |
| **16-package workspace split** | Superseded by [#801](https://github.com/srikanth235/centraid/issues/801); see [Package boundaries](#package-boundaries-801). |
| **Coordinate naming deferred for want of a licensed gazetteer** | Superseded by [#816](https://github.com/srikanth235/centraid/issues/816); naming is an opt-in automation over a vendored open dataset, run entirely on-device — see [Photos place and cartography](#photos-place-and-cartography-816). |
| **No basemap under Places, on any surface** | Superseded by [#816](https://github.com/srikanth235/centraid/issues/816); that ruling was derived from the browser's tile-request problem. Mobile defaults to a real native map with a one-switch return to the sketch; web stays sketch-only with CSP `'self'`. |
| **#726 "Give is a receiver-owned snapshot"** | Superseded by [#825](https://github.com/srikanth235/centraid/issues/825); copy-as-share retires and a share is a standing grant. Closure read and projection survive as internal fulfillment transport — see [Sharing v1](#sharing-v1--the-grant-plane-825). The rest of #726's placement ruling stands. |
| **The link ceremony as a prerequisite (#726 / #821 L-write)** | Superseded by [#825](https://github.com/srikanth235/centraid/issues/825); share subsumes linking — a grant to an unlinked person parks at `awaiting_channel` and mints the invitation — and People gains the write side, so a share is no longer always made from a container. |
| **`react-native-maps` as the phone's map SDK** | Superseded by [#816](https://github.com/srikanth235/centraid/issues/816); the dependency is removed as dead code and the native map stack is `expo-maps` on iOS plus `@maplibre/maplibre-react-native` on Android. |

## Package boundaries (#801)

Ruled 2026-08-16 by [#801](https://github.com/srikanth235/centraid/issues/801). A workspace package exists only if it has a **distribution** split, a **hard technical wall** (native build, zero-runtime-dep, React Native `src` resolution), or an **independently published contract**. Architectural seams that meet none of those (automation must not import an ACP backend; engine imports nothing above it) are enforced by import-boundary lint and tests, not extra package.json edges.

Kept packages and why:

| Package | Test | Why it stays |
| --- | --- | --- |
| `core` | distribution + technical wall | Thin clients consume protocol/blob/time without server code; RN `src`; zero-dep |
| `server` | distribution | The backend unit; desktop and `centraid-gateway` consume it whole |
| `vault` | distribution + published ontology | Desktop consumes it directly |
| `backup` | technical wall + published format | Node builtins only; `centraid-storage-provider/1` + `centraid-snapshot/2` |
| `blueprints` | distribution | Server needs manifests/handlers; client/mobile need UI chunks |
| `design` | distribution + RN `src` | Shared by every app |
| `client` | distribution | Browser-safe React shell for desktop/web/mobile |
| `tunnel` | native wall | Rust data plane + napi |
| `cli` | distribution (deliberate) | Depends only on contracts to prove wire parity |
| `test-kit` / `model-runtime` | private leaves | Shared tests; pinned native inference |

Supersedes any prior rationale that treated `protocol`, `blob-format`, `time-engine`, `gateway`, `app-engine`, `automation`, or `agent-runtime` as independently publishable workspace packages. Those names remain historical in receipts and changelogs.

## Defaults (so nobody has to ask)

| Topic | Default |
| --- | --- |
| **B3 knip** | knip runs per-workspace at error level; unused files, dependencies, and exports fail the gate |
| **G1 dev env** | `.claude/launch.json` plus [dev-environment.md](dev-environment.md) are the dev-environment manifest; do not invent a new format |
| **I5 rollout** | Desktop updates use a 72-hour staged rollout window with a stable per-install bucket (`bucket < elapsed/window`) |
| **I10 packaging** | macOS ships ZIP **and** DMG; Windows ships per-user NSIS |
| **K11 fonts** | The app shell uses the system font stack; no webfont, no render-blocking third-party CDN |

## Gateway founding and recovery

A fresh gateway founds itself: it creates `Shared` and `Personal` and enrolls the host device as owner on both. An existing data directory is never modified by founding. There is one ticket concept — the pair ticket — and web/PWA and mobile onboarding are ticket-only. The former founding ceremony and `vaults:initialize` / `vaults:restore` routes are not part of the current surface. Recovery kits remain a backup-plane export and are consumed by `centraid-gateway recover`. Settled in [#603](https://github.com/srikanth235/centraid/issues/603).

## Ownership, sharing, and peer transport

The ruling from [#726](https://github.com/srikanth235/centraid/issues/726): **one owner per vault, structurally enforced; there are no roles.** Authorization asks which owner a proved device binds to and whether that owner owns the vault. Sharing is placement, not row filtering: data crosses by projection into an audience vault, and no one queries another person's vault. Commons is circle-backed co-owned residency. The Give half — a receiver-owned snapshot as a member-facing act — is superseded by [#825](https://github.com/srikanth235/centraid/issues/825); a share is a standing grant and closure projection is internal fulfillment transport ([Sharing v1](#sharing-v1--the-grant-plane-825)). The authentication boundary is transport-first (Iroh `EndpointId` proves the device; custody of the data directory proves the host) with no password/session/OIDC plane, which remains the standing [#599](https://github.com/srikanth235/centraid/issues/599) security decision minus its role vocabulary. Schema, tables, and mechanics live in [ARCHITECTURE.md](../ARCHITECTURE.md#vault-ownership-and-sharing-726) and [SECURITY.md](../SECURITY.md); vocabulary in [glossary.md](glossary.md#owners-gateway-726).

## Commons

Commons is circle-backed, steward-serialized multi-writer state from [#731](https://github.com/srikanth235/centraid/issues/731). The steward orders member-signed commands into a monotonic log; members apply checkpoint plus tail and compute balances from identical rows. Non-steward writes require the bound vault signature and fresh nonce. v0 uses deterministic last-write-wins by steward sequence; invalid commands are refused rather than surfaced as retriable conflicts.

## Experimental features (v0)

Automations and connectors ship in the release binary but are **off by default** in v0; the gate exists for owner + enthusiast early feedback ([#774](https://github.com/srikanth235/centraid/issues/774)). Resolution per feature mirrors Resource mode: `CENTRAID_EXPERIMENTAL` env (authoritative when set) &gt; durable prefs `gateway.experimental.*` &gt; host option &gt; off, applied at serve boot. Off means absent: no capability advertisement (C1), no routes, no webhook ingress — clients hide or wall the surface from the one capability detection point. Turning a feature off leaves its durable data intact. System recognition recipes (photo OCR, faces, embeddings, transcripts) are **not** gated: schedulers always run and the gate lives in the reconcile row-set, so the photos pipeline keeps flowing while user automations stay dark. There is no remote flag service and no per-user targeting — each user owns their gateway; the opt-in switch is the allowlist. Clients treat an **unanswered** capability question as unknown, never as off, wherever a stale answer would reshuffle standing navigation: mobile places never hide on unknown (offline cold starts keep their band), and the desktop route wall stays a blank frame until resolved. The desktop launcher/palette are the recorded exception — they boot at off because hiding beats flashing against a loopback gateway that answers within a frame (see `packages/client/src/react/shell/capabilities.ts`).

The proposed fixed-window replacement for steward-side ack-gated compaction is **not adopted**. The current `share_commons_cursor` ack and retention behavior remains until unconditional checkpoint digest verification and real dogfood lag measurements justify a change. The instrumentation is exposed through the commons diagnostics described in [logs.md](logs.md#commons-sync-observability-731); the proposal and its rejected alternatives live in [#731](https://github.com/srikanth235/centraid/issues/731).

## Recognition automations and derived data

Recognition is self-contained automation. `photo-ocr`, `transcript`, `embed-image`, `embed-text`, and `faces` read bytes through `ctx.vault.content`, run their bundled implementation, and persist through `ctx.vault.invoke`. The automation engine owns scheduling, consent, retries, cursor watermarks, and ledger history. There is no service wire, `ctx.infer`, or `ctx.enrich`. A recipe may declare a consented `ctx.delegate` variant — `photo-ocr` and `doc-text-extractor` do — and which engine runs it is answered by the policy cascade below, not by the recipe alone ([#807](https://github.com/srikanth235/centraid/issues/807)). Device-side model inference is not part of the product; clients consume replicated derived rows. See [recognition-automations.md](recognition-automations.md) and [Photos derived ledger](photos/derived-ledger.md).

Faces consume only an open `enrich_request(capability='faces')` or a prior consent stamp. `media.forget_person` removes regions, embeddings, derivation stamps, and clusters. `enrich_derivation` is the provenance record, and model upgrades are backfills that leave older rows serving until replacements land. The stamp is keyed by **engine profile** as well as target and variant ([#807](https://github.com/srikanth235/centraid/issues/807)): several profiles' results for one variant coexist, and consumers read the one `preferredDerivation` ([`packages/vault/src/enrich/derivation.ts`](../packages/vault/src/enrich/derivation.ts)) resolves — never a hand-picked row.

## Generic enrichment (#807)

Ruled 2026-08-17 by [#807](https://github.com/srikanth235/centraid/issues/807). Enrichment is four independent layers, and conflating any two is what made the old single-scalar policy unable to grow. The binding statements live in [blueprint-seats.md](blueprint-seats.md#enrichment-doctrine) and [recognition-automations.md](recognition-automations.md).

| Id | Current decision |
| --- | --- |
| **E-capability** | A capability is a typed contract — input kind to versioned output schema — registered in [`capability-registry.ts`](../packages/server/src/enrich/capability-registry.ts). Apps consume capabilities by contract only. `EnrichDomain` stays closed at `photos \| docs`; an app is not a domain, so Tally receipts ride `docs` and app-level differences are expressed by the cascade's app scope. |
| **E-engine** | An engine profile is a named bundle of capability + engine + parameters. Bundled deterministic models are immutable `built-in` profiles; member profiles bind a harness, model, config pins and prompt revision. Profiles are **gateway prefs** (`enrich.profile.*`) because execution is a device property — see [config-ownership.md](config-ownership.md). |
| **E-egress** | Every engine carries a computed egress class — `on-device`, `gateway` (the member's own infrastructure, not egress), or `provider`. It is a fact about the harness, never a user knob, and a profile can never claim a lower class than its engine implies. |
| **E-policy** | Policy is one scoped cascade — vault, domain, collection, item — stating per capability: enabled, engine profile, trigger. `NULL` inherits; most specific wins. Rules and consent are **vault-owned** because permission travels with the data. There is exactly one resolver, inside `decideEnrichmentGate`; a second policy path is a defect. |
| **E-ceiling** | The legacy per-domain tier survives as the vault-default layer, its values read as egress ceilings (`off`, `on-device`, `gateway`). Only that layer sets the ceiling, so no rule, profile, or per-item choice can widen egress. It is **not a member-facing control** ([#815](https://github.com/srikanth235/centraid/issues/815)): enrichment runs on the gateway, and where it runs is not a choice, so Settings → Enrichment offers no per-domain tier. The gate is unchanged, so a row a stored ceiling refuses says so at that row — removing the control must not turn a refusal back into silence. |
| **E-consent** | Egress consent is keyed capability × egress class (× optional scope), asked once, receipted, and evaluated **independently** of the cascade. The tier is the recorded answer for `on-device` and `gateway`; `provider` requires an explicit granted row, and an absent answer is not a grant. |
| **E-plural** | Derived results are keyed by engine profile and coexist. Consumers read the policy-preferred result through the one resolver; re-enrichment is backfill, never destructive. |
| **E-faces** | Faces stays built-in, on-device-class only. Biometric egress needs its own proposal before any delegate engine may claim it. |
| **E-oneshot** | A per-item "enrich with X" is a one-shot run with stamped provenance, not a standing item rule; durable rules stop at collection scope. |
| **E-budget** | Triggers live in the cascade; resource budgeting stays in the gateway Resource mode machinery. Enrichment grows no second throttling policy, and provider-cost ceilings are out of scope. |

Blueprints gain nothing from this: apps declare consumed capabilities and never touch inference, and `app.json#knobs` stays cosmetic. The per-app enrichment surface writes host-owned policy through host UI.

## Blueprint-readiness policies

The current cross-app policies from [#630](https://github.com/srikanth235/centraid/issues/630) are:

| Topic | Current decision |
| --- | --- |
| Schema migrations | New blueprint-readiness data uses ordered real-vault-preserving migrations; pre-1.0 recreation is not permission to erase a real vault. |
| Backup and restore | Schema and recovery evidence land together; snapshot/restore and restore-after-erase retain new rows. |
| Notification permission | Request permission when the first reminder is created, never at launch; a denial leaves an actionable Settings path. |
| Local OCR | The bundled `photo-ocr` handler is the local path; an explicit provider-egress-consented OCR delegate is optional. |
| Quick add | Deterministic rules route unambiguous input; ambiguous input gets a bounded delegate preview and nothing commits before confirmation. |
| Google OAuth | BYO client is the path for Calendar/Contacts until Assist's verification evidence is accepted. |
| Push | Expo Push is wake-only and content-free; the gateway remains canonical and resident-device notifications are the local fallback. |

## Typography and design contracts

The design contract is binding in [DESIGN.md](../DESIGN.md) and lowered by `@centraid/design`. Shared semantic roles use one spelling across shell, blueprint, and native lowerings; size and line-height may differ by renderer, while family and weight express the role. The composable `--t-*-size` rungs are the supported escape from shorthand font roles, and `kit.css` consumes them rather than owning a second scale. The `--t-tiny` family/weight exception remains explicit in the role-parity contract until a separately named eyebrow role can replace it. See [design machinery](design-machinery.md) and [#686](https://github.com/srikanth235/centraid/issues/686).

The seat and north-star contract is orthogonal to form factor: mobile is `origin`, desktop is `custodian`, and web/PWA is `viewer`; record-only apps use replica data, byte-bearing apps use the custody triple. Locker is disabled on the viewer seat, and Photos uses a merged timeline plus automatic frame-owned backup. See [blueprint seats](blueprint-seats.md).

The design-gallery gate screenshots the product, not a fixture. Ruled 2026-08-15 under [#799](https://github.com/srikanth235/centraid/issues/799): the SH and SH-c lanes capture the built web shell's `#ui-preview` surface, and every capture renders the product's self-hosted Instrument Sans woff2 faces — loaded from the same `FONT_FILES` manifest the shell serves, gated by `document.fonts.ready` plus an explicit resolution probe so no fallback face can be baked into a baseline. This supersedes the `system-ui` bootstrap fixture and discharges the one-time maintainer baseline decision recorded against [#781](https://github.com/srikanth235/centraid/issues/781): baselines are Linux-captured and byte-deterministic there; if a darwin run shows a residual rasterizer delta, the remedy is per-platform baseline directories, never a widened diff tolerance. BI and MO are deliberately token-lowering lanes, not component screenshots: MO has no DOM, and photographing the shell's React blocks under the blueprint lowering would depict components no blueprint app renders (the two DOM compositions merge under [#765](https://github.com/srikanth235/centraid/issues/765)). A lane's narrower claim is stated in the gallery manifest's `laneClaims` rather than left to be misread as component coverage.

System state follows the signal ladder settled in [#785](https://github.com/srikanth235/centraid/issues/785): ambient ribbon → glance destination → push only for a human decision → cause-focused drill-down. The signal vocabulary is exactly quiet, attention, and urgent; healthy state earns no hue or animation. Persisted route ids remain stable while member-facing destinations are Vault, Activity, System, and On this phone. Seat filtering is presentation only, and omitted launcher destinations remain deep-link reachable with an explanatory state. The Assistant remains a full route and also appears as a frame companion; its pointer rail reserves content width rather than reproducing the reference prototype's overlay limitation. See [assistant companion and system signals](system-signals.md).

## Photos place and cartography (#816)

Ruled 2026-08-17 by [#816](https://github.com/srikanth235/centraid/issues/816). Place is a first-class dimension of memory, and the three answers below — how a place is named, which surface owns the experience, and what is drawn under the pins — are decided independently.

| Id | Current decision |
| --- | --- |
| **P-ladder** | A place is named by a phrase ladder, in falling order of what the vault knows: a name the member gave it; a settlement name from the gazetteer when the opt-in gazetteer automation is on; a phrase relative to a member-named place; then "A place with no name yet". A coordinate is never printed as a name. Raw coordinates appear only behind an explicit exact-location action the member takes on one item. |
| **P-gazetteer** | Coordinate-to-settlement naming ships as an **opt-in, zero-egress automation** over a vendored open dataset (GeoNames `cities15000` class, CC-BY): the lookup runs against bundled bytes, so nothing is requested and no coordinate leaves the device. A member-entered name is authoritative and derived naming never overwrites it. |
| **P-mobile-first** | The Expo mobile app is the **primary Photos surface**: it is where place work is designed, built, and accepted first, and a wave exits on mobile evidence. It runs as a dev client with config plugins — never Expo Go, never a webview. Web is the **curation surface** and lands after mobile, not before. |
| **P-cartography** | Cartography has two modes. On mobile the real map is the default: iOS renders Apple MapKit through `expo-maps`, Android renders MapLibre (`@maplibre/maplibre-react-native`) against OpenFreeMap vector tiles — both keyless, no account, no vendor API key in the app. The **"Use real maps"** setting (on by default) swaps to the Private sketch, the zero-egress projection both surfaces already share ([`place-map.ts`](../packages/blueprints/apps/photos/place-map.ts)). Web is sketch-only and its CSP stays `'self'`. Trip-card covers always render the offline projection, in either mode, because a card is an artifact rather than a live view. |
| **P-shared** | A relative phrase ("3.4 km NE of Home") is readable only to someone who knows where Home is, so it is a **private** rung: it never renders in a shared or exported context, and never in a title a card carries. In a shared context the ladder falls straight from the member's name to the gazetteer name to "A place with no name yet". Place metadata rides along on a share only by the member's explicit choice, at a precision they chose. |
| **P-egress** | In real-map mode the map provider sees which areas are viewed. That is disclosed plainly where the setting lives — it is **not** consent-gated, because it is base-layer traffic a member turns off with one switch. No vault bytes, coordinates of items, names, or photographs are ever sent to a map provider under either mode. |

## Copy governance (#805)

Ruled 2026-08-16 by [#805](https://github.com/srikanth235/centraid/issues/805). UX copy is a design contract, not per-screen taste, and the binding statement is [DESIGN.md § Copy](../DESIGN.md#copy).

| Id | Current decision |
| --- | --- |
| **U-voice** | The house voice stays — calm, concrete, confident — and gains a length cap. Crisp-but-warm beats utilitarian: "Photo deleted", never "Deleted" and never "Your photo has been successfully deleted." Copy is signage read at a glance, not conversation. |
| **U-ratchet** | Concision is enforced by a hard ratchet in the U-series quality tests (`tests/quality/user-facing-qualities.test.ts`). `tests/quality/copy-allowlist.json` is the only escape hatch, and an entry is a debt that records its reason. |
| **U-scope** | The rulebook covers the whole app — shell, bundled system apps, and mobile — under one umbrella. Audit everything, rewrite only violations: a string already inside its budget is left alone. |
| **U-reassurance** | Reassurance is positional. Full sentences about what was not lost, deleted, sent, or generated belong only where the risk decision is made — consent screens, destructive confirms, security and privacy disclosures — and those strings are allowlisted by name. Nothing else gets a second sentence by default. |
| **U-umbrella** | One umbrella issue, no child issues. Slices are sub-agents and PR waves under it, with one receipt for the umbrella. Recorded as repo process in [AGENTS.md](../AGENTS.md) and [multi-agent.md](multi-agent.md). |

The per-surface sentence budgets (button, toast, status line, empty state, banner, error, settings description, placeholder, consent) live in the DESIGN.md table, not here; vocabulary rules remain [glossary.md](glossary.md).

## Inline system apps

The eight bundled system apps are inline React routes in the shared shell. Their reads, subscriptions, and writes use `ReplicaShellSession`; writes carry `intentId`, and the apps render from the replica offline. There is no second render path: the served-iframe plane, its bridge and blueprint CSP, the postMessage settings path, and the gateway's UI-byte serving were retired end to end on 2026-08-15 by [#799](https://github.com/srikanth235/centraid/issues/799). The app-scoped RPC surface is `/centraid/<app>/actions|queries/<name>`; the former shared admin token plane is retired in favor of revocable owner enrollment. Full render-path details live in [ARCHITECTURE.md](../ARCHITECTURE.md#app-render-path). Settled by [#505](https://github.com/srikanth235/centraid/issues/505) and narrowed to one path by [#799](https://github.com/srikanth235/centraid/issues/799).

## Surfaces held back for a design handoff

Ruled 2026-08-18. Three surfaces were **removed rather than carried**, and none of them are deprecations: mobile Docs, mobile People, and desktop People. Each was drawn before the Binding Layer v11 handoff and answers an earlier grammar, so keeping it would have meant maintaining, testing and explaining screens the rebuild is going to replace. A surface that is wrong costs more than a surface that is absent.

Amended 2026-08-18 by [#821](https://github.com/srikanth235/centraid/issues/821): **desktop/web People is restored** — rebuilt to the Binding Layer v12 handoff over the untouched contract, with `people` deleted from `AWAITING_HANDOFF.web` and its gate rows back on ([design-divergences.md](design-divergences.md#people--v12-parity-state-and-sanctioned-withholdings) records what the rebuild withholds and why). The first H-loss — People's adversarial untrusted-string rendering — is closed by the restored web renderer.

Closed out 2026-08-18, same issue, wave 3: **mobile Docs and mobile People are restored** — native Expo rebuilds to the same handoff (People to Part 1's touch geometry, Docs to Part 2's fourteen phone screens), `AWAITING_HANDOFF.mobile` is empty, both stacks and their deep links are back (superseding H-shape's removal), and the gate now scans both native trees again with `NATIVE_QUERY_UI` / `NATIVE_FALLBACK` rows naming how each handler is reached. No surface remains under this holdback; the ruling stands only as the pattern for the next handoff. The H-loss row's second loss (the People phase of the mobile frame-drop scale flow) remains accepted — the native roster is back, but the 5,000-contact year-3 volume flow has not been re-authored yet.

| Id | Current decision |
| --- | --- |
| **H-scope** | Only the RENDER TREE goes. Manifests, `./actions/*`, `./queries/*`, vault scopes, pending projections and receipts are untouched on all three. A design handoff redraws screens; it does not redesign a contract. The apps are **unrendered, not dark** — the assistant still invokes every handler, and desktop People's Ask panel still runs its seven queries. |
| **H-wall** | Each removed surface leaves a wall carrying the place's own frame — its title and the way out — not a blank screen, a spinner, or a 404. Deliberately not the switched-off-place wall (`FeatureOffPlace`), which states a different fact (the gateway disabled something) with a different remedy. The wall spends no CTA: there is nothing to go forward to. |
| **H-shape** | Docs on mobile loses its stack and is a plain cover again; `docs/:documentId` is gone from the deep-link table rather than silently resolving to the drive. People was already a single cover on both seats. |
| **H-gates** | Gates are suspended over the missing UI by NAME, never softened. `handler-reachability.test.ts` gains one `awaiting-handoff` exception keyed per app per surface, whose justification test fails on an id that is not a real manifest; People comes off the three `state-honesty.test.ts` rendering lists; the native Docs assertions leave `placement-registry.test.ts` and the People renderer leaves `untrusted-rendering.test.ts` rather than being made conditional. Every removal names what the rebuild must restore. |
| **H-loss** | Two coverage losses are accepted and recorded, not papered over: People's adversarial untrusted-string rendering, and the People phase of the mobile frame-drop scale flow (no other native list carries its 5,000-contact year-3 volume, so it is excised rather than pointed at a stand-in). |

Restoring a surface is the last step of its rebuild: delete its id from `AWAITING_HANDOFF`, put its rows back on the lists above, and the gates come back on by themselves.

## People, links and the sharing plane (#821)

Ruled 2026-08-18 by [#821](https://github.com/srikanth235/centraid/issues/821). The v12 People rebuild needed facts the contract did not answer, so the contract was **amended** — maintainer-authorized, in the same wave — rather than the screens being drawn over a guess. What each surface may say about a link, and who may make one, are separate answers.

| Id | Current decision |
| --- | --- |
| **L-linked** | A person is **linked** exactly when a live `share_party_vault_binding` row names their party. The link ceremony writes it: approving a same-machine link, and redeeming a link ticket, both reconcile the binding into whichever side's vault is mounted here (`packages/server/src/serve/link-party-bindings.ts` over `VaultLinksStore`'s change listener). One party holds **at most one live binding** — on conflict the standing binding wins and the loser carries `revoked_at`, so "linked people" and "live bindings" are the same count by construction. |
| **L-read** | People and Docs hold **read-only** scopes on the sharing plane (`share.party_vault_binding`, `share.circle_grant`, `share.commons_member_state`, `share.commons_invitation`, plus `social.circle_member` and `core.party`). Every share read degrades to **absent, not empty**, on denial: the query answers `null`, and the surface draws nothing rather than a zero. A scope may legitimately be parked on an existing vault, so "nobody is linked" must never be rendered from "we could not look". |
| **L-write** | Amended by [#825](https://github.com/srikanth235/centraid/issues/825): **People holds the write side.** A share is a grant over an audience × subject × capability, made from either end — the content app's subject or the person screen's audience — and the person screen is the grant dashboard that Share and Revoke return through ([G-audience](#sharing-v1--the-grant-plane-825)). A grant to an unlinked person parks at `awaiting_channel` and mints the invitation itself, so no separate link act precedes it. The standing rule the amendment keeps: a surface never grows a control naming an act it cannot perform. |
| **L-never** | `cadence_days = 0` means **never**, and is stored verbatim — the vault `CHECK` floors at 0 and `people.add_person` / `people.set_cadence` type a minimum of 0. A person on zero is never overdue and is excluded from Reconnect outright; no stand-in number, and no sentinel. |

What each surface consequently draws and withholds, screen by screen, is [design-divergences.md](design-divergences.md) — the [People](design-divergences.md#people--v12-parity-state-and-sanctioned-withholdings) and [Docs](design-divergences.md#docs--parity-state-and-sanctioned-withholdings) sections. The commons mechanics live in [ARCHITECTURE.md](../ARCHITECTURE.md#circle-backed-commons-731); the grant plane over them is [Sharing v1](#sharing-v1--the-grant-plane-825).

## Sharing v1 — the grant plane (#825)

Ruled 2026-08-19 by [#825](https://github.com/srikanth235/centraid/issues/825). A share is a **standing grant**, and the audience's bytes are a replica under it. One app-agnostic infrastructure carries every app: `share_grant(grant_id, audience_kind person|circle, audience_id, subject_type, subject_id, capability view|edit, granted_at, revoked_at, granted_by)` states the member's sentence, `share_fulfillment(grant_id, peer_vault_id, state awaiting_channel|syncing|delivered|remove_sent|removed)` carries per-audience-vault delivery. Capabilities are `view` and `edit`; `comment` is reserved and unimplemented. These rulings land ahead of the code waves of #825, per its execution plan.

| Id | Current decision |
| --- | --- |
| **G-membership** | Container semantics are **membership, not snapshot**. A grant on an album or folder covers its contents now and later; an item added after the grant is shared by the grant, with no second act. |
| **G-view** | View grants sync forward. The origin is the sole author of a `view` subject and delivery is **re-projection on change**, not a CRDT merge. Divergence between origin and audience copies is a bug to fix, never the resting state. |
| **G-edit** | Edit grants route writes back through the existing commons command routing ([`commons-routing.ts`](../packages/vault/src/share/commons-routing.ts)): the commons machinery is the `edit` **fulfillment strategy**, not a second product concept beside grants. The [#750](https://github.com/srikanth235/centraid/issues/750) rule survives as the registry gate — a subject type with no fulfillment answer cannot be offered. v1 ships edit co-contribution for `tally.group` only; albums and folders are view-capable and their edit strategy is deferred. |
| **G-revoke** | Revoke is **one verb, uniform, and honestly best-effort**. `revoked_at` stops sync and sends removal; a sovereign system cannot scrub a peer's disk, and the copy says so plainly — "no longer shared; her vault has been asked to remove it". Removal on the audience side is a hard delete: no tombstone row survives it. |
| **G-channel** | Share subsumes linking. A grant to an unlinked person parks at `awaiting_channel` and mints the invitation as its first fulfillment step, so the **channel** (today's `share_party_vault_binding` + `vault_links`, states invited\|live\|severed) is a property of the party rather than a ceremony the member must complete first. |
| **G-copy** | Copy-as-share retires. `peer-edge-give-route` and the give / edge-answer verbs leave the product surface, and no "give a copy" verb replaces them in v1. [`readShareClosure`](../packages/vault/src/share/read-closure.ts) / [`projectShareClosure`](../packages/vault/src/share/project-closure.ts) survive as **internal fulfillment transport** only — machinery beneath a grant, never a member-facing act. |
| **G-audience** | Audience-first is the primary key. "Everything Priya can reach" is one query over `share_grant`; People's person screen is the grant dashboard, and Share and Revoke return there through it. |
| **G-subject** | `people.person` is never a subject. A person is the **audience** side of a grant; subjects are the shared things — album, folder, document, asset. |

Per-grant size ceilings carry over unchanged from the commons limits; the grant plane adds no second budget. Circle grants recompile their roster on every fulfillment pass — a party added to a granted circle is delivered on the next pass with no re-grant — while grants the #825 migration decomposed into per-party rows are literal and do not follow roster drift; reaching a later addition there takes a new grant.

## Performance and Rust byte plane

Node remains the gateway runtime until Bun supports `node:sqlite` and passes the same durability suite. Five performance designs — dependency-aware read cache, compiled consent decisions, incremental materializations, verified boot snapshot, and lazy vault mount — are evidence-gated, not adopted; mounting stays eager because a missed automation wakeup is a correctness failure. The Rust data plane moves bounded bytes only and never owns identity, consent, journal, replica, agent, or automation decisions. Budgets, profiles, and the full boundary live in [ARCHITECTURE.md](../ARCHITECTURE.md#performance-and-byte-plane-boundary); settled in [#456](https://github.com/srikanth235/centraid/issues/456).

## Product grammar and block composition

The product grammar is the current design contract, not a migration plan: semantic roles, lowerings, recipes, icon/identity/formatter contracts, and reference states are enforced by [DESIGN.md](../DESIGN.md), [design machinery](design-machinery.md), and their tests. The former plan's durable outcome is that app identity and action colour remain separate, host appearance owns appearance, and mobile consumes `toNativeTheme()` without CSS parsing. See [#690](https://github.com/srikanth235/centraid/issues/690) and its review closure [#695](https://github.com/srikanth235/centraid/issues/695).

The headless block logic lives in `@centraid/design/blocks`. React DOM composition is still split between shell and inline blueprint markup; the consolidation remains a follow-up tracked by [#765](https://github.com/srikanth235/centraid/issues/765). The DOM custom elements that used to be a third rendering technology are gone ([#799](https://github.com/srikanth235/centraid/issues/799)): `Avatar`, `Meter` and `Skeleton` are React blocks in `packages/blueprints/apps/_shared`, and the status line is plain DOM in `packages/design/src/elements/feedback.ts`.

## Related docs

| Doc | Current contract |
| --- | --- |
| [protocol.md](protocol.md) | Two-contract, COMPAT, wire-purity, RPC, and stream authority rules |
| [release.md](release.md) | Versioning, surfaces, release gates, and recovery |
| [identifiers.md](identifiers.md) | `dev.centraid.*` identifiers |
| [enrollment.md](enrollment.md) | Human signing and public-service setup |
| [TESTING.md](../TESTING.md) | PR/nightly lanes and app admission |
| [SECURITY.md](../SECURITY.md) | Threat model and automated security gates |
