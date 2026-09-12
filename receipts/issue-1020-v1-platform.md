# Issue #1020 — v1 platform: Rust core, KMP mobile shell, Electron seat, gateway anywhere

Umbrella receipt. One receipt for the whole umbrella; each wave appends its own section below and never edits a section above it.

The umbrella is [#1020](https://github.com/srikanth235/centraid/issues/1020): v0's product core is close to stable and its platform is a TypeScript monoculture — the seat engine and every app's query handlers run on Hermes inside an Expo app, on sqlite-wasm in a browser worker for the PWA, and on Bun for the gateway. Three things prompted the proposal. **Mobile performance**, because the phone runs SQL, the sync applier and every app query on the JS thread, and the decision is to stop running data code on a JS engine at all — a **structural** decision, not a measured one, since the only handler timing on record (188 ms for Tally's dashboard at 2,000 expenses, [receipt #922](issue-922-snappier-blueprints.md)) was taken on a 4-core Node host over node-sqlite and says nothing about a phone. **Tooling**, because rule two is served in v0 by TypeScript-only tools and v1 is three languages. **Surfaces**, because only desktop and mobile matter, so the web PWA and every browser-only plane it forced into the seat engine retire. The platform is Rust for the shared core, Kotlin Multiplatform for the mobile shell with native UI, and Electron for desktop; v0 is the executable specification, and compatibility with v0 artifacts is explicitly not a constraint.

## Checklist

- [x] **Wave 0 — Charter** (root): rulings into [`docs/decisions.md`](../docs/decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020); receipt opened; **real-device baselines and absolute targets** into [`tests/journeys.json`](../tests/journeys.json) — p95 interaction latency, frame misses during concurrent sync, typing latency in Notes, memory at a 50k-asset library, battery per background pass, cold start at year-3 volume, on named reference devices (a mid-range Android and the oldest supported iPhone); version window N ruled; the VPS threat-model section in [SECURITY.md](../SECURITY.md#the-gateway-on-rented-hardware--v1-trust-premise-1020)
- [ ] **Wave 1 — Foundation**: lane A (`crates/ontology`, `contracts/`) and lane B (`crates/xtask`, `flake.nix`, workflows, `deny.toml`). Checkpoint: the ontology crate opens the v0 golden vault; CI runs only `cargo xtask gate`
- [ ] **Wave 2 — Core and proofs**: lane C (`crates/api-proto`, `protocol`, `net`, `centraid` — two schema packages with buf, wire framing, pairing and QR, iroh-blobs, relay fallback and no-relay behaviour, the one binary); lane D (`crates/vault`, `seat`, `apps/kit`, `apps/tally`, `core`, `core-ffi` — both roles, per-command authorization, the ABI and its `CONTRACT.md`, the failure matrix, and **deterministic simulation as the primary sync proof** under `turmoil`); lane R (restore drill and key custody, `centraid recover`, a CI drill that restores and re-pairs a seat); and the **binding spike** (cinterop and JNA actuals, the Swift wrapper, measured call latency and event throughput on a physical iPhone and Android), whose numbers fix the ABI contract before wave 3
- [ ] **Wave 3 — Integration proof** on release-built physical devices against a VPS gateway: lane E (`mobile/**` — shared module over the ABI, Tally list, Photos grid with camera-roll backup, Notes editor, SwiftUI and Compose, XcodeGen, Maestro, and the **iOS background transfer experiment** across foreground, backgrounded, locked, suspended and relaunched); lane F (`desktop/**` — sidecar, socket bridge, `centraid://` media with seeking, thin and replicated modes with their visible states); lane G (`deploy/**`, `tests/**`, `scripts/ci/**` — images, device lanes, Macrobenchmark and XCTest metric lanes, prebuilt artifact lane with identity checks). **Gate: no wave 4 lane starts until the binding, transport and lifecycle contracts are finalised in this receipt**
- [ ] **Wave 4 — Apps in depth**: one lane per app, at most three concurrent, plus lanes for `crates/assist`, `crates/automations`, `crates/connectors` and `extension/`, and the Locker lane that ships [R-1020-9](../docs/decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020)'s sealed secret cells. Exit per app as before, plus the inventory's journey
- [ ] **Wave 5 — Ship**: store lanes, desktop service install on three OSes, docs rewrite
- [ ] **Wave 6 — Retire**: atomic — delete the v0 tree and the retired tools; supersession rows
- [ ] **Close pass**: the acceptance criteria of [#1020](https://github.com/srikanth235/centraid/issues/1020) walked one by one, the spike report and the transport experiment recorded with evidence, and the doc pass over every state document the waves changed

Ticked by wave 0: **box 1 only**. Every other box needs code that does not exist, and no acceptance criterion of the issue is met by this slice.

## What changed

Wave 0 is docs-only and lands the **charter**: the rulings every later wave is planned against, the trust premise the platform is designed to, the absolute targets the phone will be held to, the nouns the work is described in, and the two registers that make the umbrella findable.

- **[`docs/decisions.md`](../docs/decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020)** — a new section `## v1 platform — Rust core, KMP shell, Electron seat, gateway anywhere (#1020)`, placed after `## Mobile UX consistency (#1015)` and before `## Related docs`. It carries **thirty-three rulings R-1020-1 … R-1020-33** as one `Id | Current decision | Why` table; a `### Deliberate non-goals (#1020)` list taken from the issue's `Out:` set; and a `### Open questions for the owner (#1020)` table with **Q-1020-1** and **Q-1020-2**. The opening paragraph states what the umbrella is, the three prompts, that v0 is the executable specification, and — in bold — that **v0's rulings stay current for the v0 tree until wave 6 deletes it**, so this section rules the v1 tree and nothing else. The provisional paragraph states that every row adopts the issue's own recommendation with no owner reading, that work proceeds so no wave is built over a guess, and that confirming or reversing is **Q-1020-1** and a release blocker rather than a follow-up.
- **[`docs/decisions.md`](../docs/decisions.md#superseded-decision-pointers)** — **five rows appended** to `## Superseded decision pointers`; no existing row's text is touched and the diff adds lines only. Each names the v0 ruling, points at the R-1020 row that supersedes or narrows it **for the v1 tree only**, and says explicitly that the v0 ruling stays current for the v0 tree until wave 6. The five: the "Rust data plane moves bounded bytes only and never owns identity…" sentence and "Node remains the gateway runtime" (both under [Performance and Rust byte plane](../docs/decisions.md#performance-and-rust-byte-plane)); the web/PWA seat rulings of [#996](https://github.com/srikanth235/centraid/issues/996) (R9's remote-only paged door, R15's "the PWA is a cache of the vault", OQ-2's rows-minus-FTS answer, and the `viewer` seat of the custody triple); [#555](https://github.com/srikanth235/centraid/issues/555)'s Iroh-only transport, **restated and narrowed** rather than reversed, now provisional until wave 3; and [SECURITY.md](../SECURITY.md)'s "the local gateway is L0-trusted" premise, **narrowed** to "trusted for data, blind for secrets".
- **[`SECURITY.md`](../SECURITY.md#the-gateway-on-rented-hardware--v1-trust-premise-1020)** — a new `### The gateway on rented hardware — v1 trust premise ([#1020](…))` after `### Owners, hosting, and the v0 storage premise (#726, supersedes #599)`. It opens by saying **ruled, not yet shipped**, and that no code in this repository implements the sealing half today, so nothing here is a claim about v0's behaviour. It then states the premise in both halves (host operator trusted for rows and blobs, blind for Locker secret cells sealed under a member key the gateway never holds, landing in wave 4); why full end-to-end for all rows is refused; what the premise narrows in v0's L-export and household-placement rulings, for the v1 tree only; the **relay dependence** and the no-relay failure posture; that the off-by-default blob door is the only listener the product would ever have; the sidecar socket's mode-0600 and **peer-credential** check with the OS user boundary still primary; and that **app extensions never open the vault and never start iroh**.
- **[`SECURITY.md`](../SECURITY.md#the-claim-register-1014)** — one row appended to `## The claim register`, status **RULED, NOT SHIPPED**, enforced by nothing, owned by [#1020](https://github.com/srikanth235/centraid/issues/1020) wave 4. The register's format admits states weaker than a test (`DOCUMENTED-ONLY`, `DOCUMENTED NON-CLAIM`, `NOT ENFORCED — open`), so a "ruled, not yet shipped" row is in its vocabulary rather than an extension of it; the row exists because the register's own rule is that adding a claim to the document without adding its row is the thing the table is there to stop.
- **[`tests/journeys.json`](../tests/journeys.json)** — additions only, and nothing existing is re-keyed or re-numbered. Two `hardware` cells (`device-android-mid`, `device-iphone-oldest`), each saying the model is **not named yet** and why it is distinct from the farm's existing `device-android-low-end` / `device-iphone` cells. Three `journeys` (`typing`, `background-pass`, `memory`); frame misses stay on the existing `scroll` journey rather than becoming a fourth. One `volume` (`year3-50k-assets`), distinguished from `year3-photos`'s 90,000 gateway-side assets. Twelve `entries` — six targets × two reference devices — keyed `mobile/<journey>/<volume>/<hardware>`: p95 interaction latency (100 ms), frame misses during concurrent sync (1 %), Notes keystroke latency (16 ms, one frame), resident memory at the 50k-asset library (300 MB), battery per background pass (1 %), and cold start at year-3 volume (1,500 ms). **Every metric is parked** under `_intendedCeiling…` with `status: "_intended"`, so the ratchet cannot see it and it gates nothing; each carries a `probe` saying no rig and no device exist, and a `_provenance.note` arguing the number from the 60 Hz frame budget rather than from v0. `approvedDeviation` on `entries`, on `rigs` and at the root is **unchanged** — additions are not a widen, and no surviving ceiling moves.
- **[`docs/glossary.md`](../docs/glossary.md#hosts-and-clients)** — one short block under `## Hosts and clients`, marked **(v1, #1020)**, with one line each for gateway (role), seat (role), replicated seat, thin seat, sidecar, the `centraid` binary, blob door and reference device. The v1 `seat` row says in its own words that it is not the v0 byte-custody seat (`origin` / `custodian` / `viewer`) two sections below, because the same noun carrying two axes silently is how a glossary stops being one.
- **[`CHANGELOG.md`](../CHANGELOG.md)** — one entry under `## [Unreleased]` → `### Changed`, first in the list, citing [#1020](https://github.com/srikanth235/centraid/issues/1020): the platform in the member's terms (one program, two roles, a gateway that needs no domain or open port, native phone views, the PWA retiring), the trust premise said out loud with the ruled-versus-shipped line drawn, and the six absolute phone targets with the note that they are parked until a run on the two named devices fills them in. It closes by saying that nothing a member has today changes.
- **`receipts/issue-1020-v1-platform.md`** — this file, created as the umbrella receipt with the issue's own wave list as its checklist.

## Out of scope

Every line of code [#1020](https://github.com/srikanth235/centraid/issues/1020) names. No crate, no `contracts/` fixture, no `mobile/`, `desktop/`, `extension/` or `deploy/` tree, no `xtask`, no protobuf package, no C ABI, and no CI change exists after this slice — waves 1 through 6 own all of it. The `contracts/journeys/` tree the brief offered as a home for this ledger's consumer paths is **not created here**: it is wave 1 lane A's file, and standing it up early to satisfy a lint would put one lane's directory in another lane's commit.

The state documents the charter's rulings will eventually change are deliberately untouched: [ARCHITECTURE.md](../ARCHITECTURE.md), [README.md](../README.md), [TESTING.md](../TESTING.md), [docs/protocol.md](../docs/protocol.md), [docs/vault-ontology.md](../docs/vault-ontology.md), [docs/mobile-offline.md](../docs/mobile-offline.md), [docs/platform-gating.md](../docs/platform-gating.md), [docs/toolchain.md](../docs/toolchain.md), [docs/release.md](../docs/release.md) and [docs/recovery/](../docs/recovery/backup-restore.md) describe mechanisms these rulings replace in a tree that does not exist yet, and rewriting them now would state code nobody has written. The docs pass is the umbrella's close pass, per its own plan. [QUALITY.md](../QUALITY.md) gains nothing: its open entries are v0 defects with v0 owners, and a platform proposal does not close them. No test, ledger direction, budget, allowlist, lint config or law path was touched, and no acceptance box is ticked.

## Decisions

Each bullet is one ruling recorded in [`docs/decisions.md`](../docs/decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020); the table there carries the reasoning.

- **R-1020-1** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — the platform is Rust for the shared core, KMP with native UI for mobile, Electron for desktop; v0-artifact compatibility is not a constraint and v1↔v1 compatibility is.
- **R-1020-2** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — one crate family, two roles, one `centraid` binary, and the CLI is a client rather than a privileged path.
- **R-1020-3** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — iroh QUIC is the transport with no listening TCP port by default; relay dependence and the unresolved iOS background-transfer question are stated, and the ruling is **provisional until wave 3**.
- **R-1020-4** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — two protobuf packages with two promises: `centraid.core.v1` a gateway commitment, `centraid.screen.v1` shell-internal.
- **R-1020-5** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — the five-function C ABI and its contract clauses: buffer ownership, reentrancy, cancellation by request id, a bounded coalescing event queue as backpressure, `close` semantics, and panic containment with a poisoned handle.
- **R-1020-6** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — mobile is one KMP shared module with SwiftUI and Compose views; no Compose Multiplatform on iOS.
- **R-1020-7** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — desktop is a seat: a sidecar behind a local socket, replicated or thin with their states visible to the renderer, carrying the v0 React app UIs (OQ6 answered yes).
- **R-1020-8** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — plain SQLite; SQLCipher is dropped (OQ1), with key custody and recovery in wave 2 either way.
- **R-1020-9** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — the trust premise is "trusted for data, blind for secrets", with Locker cells end-to-end sealed under a member key the gateway never holds (OQ8), ruled now and shipped in wave 4.
- **R-1020-10** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — tooling follows the code: `cargo xtask gate` is the only entrypoint, four profiles with feedback-time budgets, and compile-time and library-size ledgers that only fall.
- **R-1020-11** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — a new top-level tree with v0 pinned as a read-only oracle until wave 6, v0's gates off PRs from wave 1, and only the nightly oracle suite against it (OQ7).
- **R-1020-12** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — the version window is N = 3 (OQ4), with the `{schema_version, min_supported}` handshake, `UpgradeRequired`, `DowngradeRefused`, forward-only migrations, and buf breaking against released tags inside the window.
- **R-1020-13** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — a local gateway on the desktop is the same binary installed as a service (OQ5).
- **R-1020-14** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — push wake is a content-free relay on the existing OAuth worker, wave 4, with nothing in the core depending on it (OQ2).
- **R-1020-15** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — prefer no HTTPS blob door; the threshold is 500 assets per night, measured in wave 3 and decided after it (OQ3).
- **R-1020-16** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — recognition placement: faces and OCR on the device holding the asset with a gateway CPU fallback, embeddings on the gateway through `ort` under a rate budget (OQ9).
- **R-1020-17** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — screen contracts are protobuf through wave 3, with the written exit criterion (a) 1.5× lines, (b) a second fixture disagreement, (c) 1 ms p95 delivery — fixed before the wave so evidence decides and not sunk cost (OQ10).
- **R-1020-18** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — Electron is kept for v1; Tauri is a v2 question the sidecar boundary keeps cheap (OQ11).
- **R-1020-19** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — the blob store is local filesystem only, with the disk requirement stated up front (OQ12).
- **R-1020-20** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — the physical-device lane is a self-hosted macOS runner on nightly and release only (OQ13).
- **R-1020-21** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — Windows is a first-class desktop target in v1 (OQ14).
- **R-1020-22** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — the extension is MV3 over native messaging to the `centraid` binary; no WASM and no iroh in a browser.
- **R-1020-23** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — the artifact key law: a content digest over `crates/**` and `contracts/**` plus schema, target, features, toolchain and profile; embedded build identity; and a stale artifact refused at `open`.
- **R-1020-24** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — app extensions never open the vault and never start iroh; Share writes an app-group inbox and Autofill reads a sealed index the main app maintains.
- **R-1020-25** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — `open` never blocks on the network; the iroh endpoint starts afterwards and idles when the app is backgrounded.
- **R-1020-26** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — local socket authentication: mode 0600 in the user runtime directory, a user-only DACL named pipe on Windows, and a peer-credential check before the sidecar answers.
- **R-1020-27** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — online-only commands are marked in the schema and refused offline with a typed reason the shell renders.
- **R-1020-28** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — media delivery: materialised paths with `ready_bytes` on phones, `centraid://` with range support on desktop, and per-request minted, expiring authorization.
- **R-1020-29** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — one snapshot, three uses: backup, seat bootstrap and the pre-migration safety copy are the same content-addressed artifact.
- **R-1020-30** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — deterministic simulation under `turmoil` is the primary sync proof and runs on every PR; a failing seed becomes a test.
- **R-1020-31** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — the execution model: Rust owns durable facts and derived reads, Kotlin owns screen state, Swift and Compose render; `call` never on a UI thread, with a `call` budget in the `pr` profile.
- **R-1020-32** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — recognition model weights are fetched on first use and never bundled.
- **R-1020-33** ([#1020](https://github.com/srikanth235/centraid/issues/1020)) — civil time is the vault's zone and never the host's; a VPS runs UTC and automations still fire at the member's local time.
- **Provisional, and said so in the document.** The alternative was to hold seven waves until the owner replied on [#1020](https://github.com/srikanth235/centraid/issues/1020). A wave built over an unrecorded guess is worse than one built over a recorded provisional ruling, so every row states that it adopts the issue's own recommendation, and **Q-1020-1** puts the confirmation in front of the owner as a release blocker rather than as a note. The issue has no owner comments, so not one of its fourteen open questions was ruled by the owner before this slice.
- **The wave 0 baselines could not be taken here.** [#1020](https://github.com/srikanth235/centraid/issues/1020) wave 0 asks for real-device baselines. This container has no physical phone, no Xcode and no self-hosted runner (`command -v xcodebuild nix` finds neither), and the two reference devices are not even named. So the six absolute targets land as parked `_intended` ceilings with the reference cells named and the argument for each number written down, and **Q-1020-2** asks the owner for the two models. Stating any of them on an emulator was refused: [`tests/journeys.json`](../tests/journeys.json)'s own vocabulary says an emulator number is a lower bound and never a budget, which is why `device-android-low-end` already carries that sentence.
- **Thirty-three rulings, not the issue's fourteen open questions.** The fourteen questions are fourteen of these rows. The other nineteen are decisions the issue's `## Decision`, `## Execution model`, `## Compatibility` and `Rulings to record at wave 0` sections state as settled — the ABI contract, the artifact key, the CLI-as-client clause, `open` and the network, the socket check, the app-extension rule, the snapshot collapse, the simulation proof and the rest — and the issue explicitly lists them as rulings to record at wave 0. A charter that recorded only the open questions would leave every later wave to re-derive the settled half from an issue body.
- **Frame misses stay on `scroll`.** The journey's declared meaning is already "frames delivered while flinging a long list", so the concurrent-sync measurement is that journey under load rather than a new journey name. Adding `frame-misses` beside it would put two names on one measurement, which is what the ledger's key grammar exists to prevent.
- **The new entries name spans and no consumers.** `consumers: []` is deliberate and honest: the v1 lane that will assert these ceilings does not exist, and `scripts/lint-journey-ledger.mjs` fails on a consumer path that is not on disk — which is the rule working, not an obstacle to route around. The lint's own requirement is that an entry names a span **or** a consumer, and these name v1 spans; the lane that will read them is named in prose in each `_provenance.note` (the wave 3 self-hosted device lane of [R-1020-20](../docs/decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020), through Macrobenchmark and XCTest metrics), and wave 3 lane G fills the field when the rig exists.
- **The claim register gains one row, not a section.** Its format already admits claims weaker than a test, so a `RULED, NOT SHIPPED` row fits its vocabulary. Leaving the register alone was the alternative and was refused: the new SECURITY.md section makes a claim, and the register's stated purpose is that a claim without a row is the thing it exists to stop.

## Verification

Doctrine digest for this lane: **`53be88c22ab5`** (`node .governance/law/brief.mjs`). Every command below was run at the worktree root on this commit's tree, in this order.

```sh
bun run format                # PASS — oxfmt --write, 5,790 files, exit 0
bun run format:check          # PASS — "All matched files use the correct format", exit 0
bun run lint:journey-ledger   # PASS — "journey-ledger: ok — every entry names its volume, hardware, spans and consumers", exit 0
bun run lint:ledgers          # PASS — "check-ledgers: ok — 20 sections across 5 ledgers hold against origin/main", exit 0
bun run build                 # PASS — 14 successful, 14 total (needed before check:push:static: its
                              #        typecheck:affected member ends in `tsc -p tests`, which resolves
                              #        @centraid/* through dist)
bun run check:push:static     # PASS — "4/4 gates passed in 115.4s": lint, format:check, typecheck:affected, turbo:lint
bash .governance/run.sh       # PASS — "governance: all 10 directive(s) passed"; the law's window door
                              #        inside it reports 10 rule(s), no findings
node .governance/law/run.mjs --door window --range e9a7d81a..HEAD --brief-digest 53be88c22ab5
                              # PASS — law (window door): no findings, exit 0
git log --format=%B -1        # PASS — subject 89 bytes, ends `(#1020)`; body carries both trailers
git push -u origin claude/1020-w0
                              # PASS — pre-push static tier ran; no SKIP_* and no --no-verify
```

Internal links were checked separately: every relative `](path#anchor)` target added by this change was resolved against the GitHub heading-slug rule over the files it points at, and all resolve — 0 missing files and 0 missing anchors across `docs/decisions.md`, `SECURITY.md`, `docs/glossary.md` and `CHANGELOG.md`.

No gate, ledger direction, budget, allowlist, lint config or law path was touched. No test was skipped, quarantined or deleted. No waiver was spent, no docket row was filed, and `SKIP_GOVERNANCE` / `--no-verify` were never used.

## Audit

**PASS**

- **`## What changed` against the diff.** PASS. `git diff --name-only e9a7d81a..HEAD` is exactly the six files this section names — `CHANGELOG.md`, `SECURITY.md`, `docs/decisions.md`, `docs/glossary.md`, `tests/journeys.json` and this receipt. The `docs/decisions.md` diff is one new `## v1 platform …` section (a 33-row ruling table, a 7-item non-goals list, a 2-row open-questions table) plus five appended `## Superseded decision pointers` rows, and it adds lines only — no existing line is rewritten. `SECURITY.md` is one new `###` section plus one claim-register row. `tests/journeys.json` is additions only: two `hardware` keys, three `journeys` keys, one `volumes` key and twelve `entries`, with three pre-existing lines changed by a trailing comma alone where a key stopped being last in its object. `docs/glossary.md` is one block under an existing heading; `CHANGELOG.md` is one bullet. No file in the diff is unnamed and no bullet claims a change the diff does not carry.
- **Each `- [x]` against the diff.** PASS. One box is ticked, wave 0, and each of its clauses is realized in the diff: the rulings in `docs/decisions.md`, this receipt opened, the six absolute targets on two named reference cells in `tests/journeys.json`, the version window ruled as **R-1020-12**, and the VPS threat-model section in `SECURITY.md`. Every other box is `- [ ]`, needs code, and needs no crosswalk.
- **The `## Checklist` against the issue's plan.** PASS. The rows mirror [#1020](https://github.com/srikanth235/centraid/issues/1020)'s own `## Execution plan` wave list — 0 Charter, 1 Foundation (lanes A, B), 2 Core and proofs (lanes C, D, R and the binding spike), 3 Integration proof (lanes E, F, G with its wave-4 gate), 4 Apps in depth, 5 Ship, 6 Retire — in the issue's order, with each row's text taken from that wave's own description, closed by a close pass. It is a wave checklist rather than the issue's acceptance list because those sixteen criteria are per-wave gates the later sections carry; none is dropped.
- **The `## Decisions` rulings against `docs/decisions.md`.** PASS. Each of **R-1020-1 … R-1020-33** appears in both files with the same substance, and each bullet and each table row cites `#1020` in its own paragraph — which is what `doctrine-citation` reads, and a table row is its own paragraph, so no row borrows a neighbour's citation. `registry-completeness` is satisfied in both directions: this receipt records rulings and `docs/decisions.md` carries lines citing #1020; the change lands and `CHANGELOG.md` carries a line citing #1020. No ledger widened, so its third question is not asked.
- **Claims against commands.** PASS. Every line in `## Verification` was run on this tree and every one carries its outcome; no fenced command is left without one. No gate, ledger, budget, allowlist or lint config was touched, and nothing in `## What changed` describes v0 code as already doing what the charter rules for v1 — the `SECURITY.md` section opens by saying the opposite, and the claim-register row records it as `RULED, NOT SHIPPED`.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

## Wave 0b — the owner's ruling on Q-1020-1, Q-1020-2 and the standing delegation (R-1020-34)

Doctrine digest for this lane: **`53be88c22ab5`** (`node .governance/law/brief.mjs`).

**What the owner said.** On 2026-09-12, in the run that recorded the wave 0 charter: *"for Q‑1020‑1 and Q‑1020‑2, go ahead with your recommendations... and in fact for all future decisions, go with recommendations and note them in receipt!"* There is no issue comment; this section is the record of the instruction and of what was adopted under it.

**What was adopted.**

- **Q-1020-1 — ruled.** Every row **R-1020-1** … **R-1020-33** in the [`## v1 platform …` section](../docs/decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020) of `docs/decisions.md` is confirmed as written. They are no longer provisional and no longer a release blocker: they are the owner's rulings by delegation, and reversal is the owner's on [#1020](https://github.com/srikanth235/centraid/issues/1020).
- **Q-1020-2 — ruled.** `device-android-mid` is the **Samsung Galaxy A55 (2024, Exynos 1480, 8 GB)**: a current mid-range Android in the volume tier the v1 absolute targets are stated for, and distinct from the farm's low-end floor cell. `device-iphone-oldest` is the **iPhone XR on iOS 17**: the oldest iPhone that runs the iOS floor v1's SwiftUI surface needs, and the cheapest and most common handset of that floor. The parked ceilings in [`tests/journeys.json`](../tests/journeys.json) stay parked as `_intended` until a run on those two phones exists — naming a model does not make a number measured. Only the model names change; no entry, ceiling or `approvedDeviation` moved ([#1020](https://github.com/srikanth235/centraid/issues/1020)).
- **New standing ruling R-1020-34 — owner delegation for this umbrella.** For every later open question in [#1020](https://github.com/srikanth235/centraid/issues/1020), the root adopts the recommendation it writes, records the question, the recommendation and the adoption in the `## Decisions` of the lane that raised it in this receipt, and mirrors it into `docs/decisions.md` at the next docs commit. Reversal is by the owner on the issue. The delegation does not extend past [#1020](https://github.com/srikanth235/centraid/issues/1020), and it does not cover a security finding's safer-fix rule (`Claude Approvals`), which is always taken. The owner's reason, in one sentence: they would rather the run proceed on written recommendations than hold waves for a reply, and the receipt is where each one is read back.

**Files touched.** Four, all registry or territory, no law path:

- `docs/decisions.md` — in the [`## v1 platform …` section](../docs/decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020) ([#1020](https://github.com/srikanth235/centraid/issues/1020)): the provisional paragraph is rewritten to current state (recorded provisionally 2026-09-12, confirmed the same day by delegation); **R-1020-34** appended to the ruling table; the **Q-1020-1** and **Q-1020-2** rows rewritten to their ruled state with the two device names.
- `tests/journeys.json` — the `device-android-mid` and `device-iphone-oldest` hardware descriptions name the models and cite Q-1020-2 as ruled. Nothing else in the file changed: no entry, no ceiling, no `approvedDeviation`, no ledger direction.
- `CHANGELOG.md` — one appended bullet under `## [Unreleased]` → `### Changed` citing [#1020](https://github.com/srikanth235/centraid/issues/1020): the rulings are in force and the two phones have names. The charter's existing bullet is left byte-for-byte alone; the changelog is the evidence layer and is appended to, never rewritten.
- `receipts/issue-1020-v1-platform.md` — this section, appended at the end.

**Exit list, with outcomes.**

```sh
bun run format                # PASS — oxfmt --write, exit 0
bun run format:check          # PASS — "All matched files use the correct format", exit 0
bun run lint:journey-ledger   # PASS — journey-ledger: ok
bun run lint:ledgers          # PASS — check-ledgers: ok against origin/main
bash .governance/run.sh       # PASS — every directive passed
node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5
                              # PASS — 10 rule(s), no findings; baseline is the merge-base with
                              #        origin/main (e9a7d81a), which is the baseline CI judges
node .governance/law/run.mjs --door window --range 8ec1fede..HEAD --brief-digest 53be88c22ab5
                              # 1 finding, doc-integrity, an artifact of the overridden baseline:
                              #        8ec1fede is an umbrella-branch commit, so this receipt exists
                              #        at that baseline and `frozen-files receipts/*.md` reads the
                              #        lane's append as a rewrite. It does not exist at the real
                              #        merge-base (verified with `git ls-tree e9a7d81a --
                              #        receipts/issue-1020-v1-platform.md`, empty), where
                              #        doc-integrity's own rule is that branch-authored content
                              #        stays editable until it merges — so the run above is clean.
                              #        No waiver was spent for it. doctrine-citation and
                              #        registry-completeness also fired on this range first and were
                              #        FIXED rather than explained: the R-1020-34 crosswalk bullet
                              #        now cites #1020 in its own paragraph, and CHANGELOG.md
                              #        carries this lane's own bullet.
bun run build                 # PASS — 14 successful, 14 total; needed before check:push:static,
                              #        whose typecheck:affected member resolves @centraid/* via dist
bun run check:push:static     # PASS — "4/4 gates passed in 24.9s"
git push -u origin claude/1020-w0b
                              # PASS — accepted, new branch; no SKIP_* and no --no-verify
```

No gate, ledger direction, budget, allowlist, lint config or law path was touched. No waiver was spent and no docket row was filed.

## Wave 1 — lane A: the ontology crate and the contracts tree

Lane A of wave 1 (Foundation). Five commits on `claude/1020-laneA`, rebased onto the umbrella at `cddafdc2`: `e37724fa` (workspace root), `8f60a0ec` (contracts), `4596c9a4` (the crate), `c145685d` (the doc paragraph), `d5356d19` (the version window, D-1020-A1). Lane B owns `crates/xtask`, `flake.nix`, the workflows and `tests/path-filter-ledger.json`; nothing below touches them.

### What landed

- `Cargo.toml` — the workspace root: `resolver = "3"`, `members = ["crates/*"]`, the v0 byte plane (`packages/tunnel/data-plane`, `packages/tunnel/native`, `apps/web/iroh-wasm`) excluded so it stays the pinned oracle until wave 6, one shared `[workspace.dependencies]` block, and `[profile.dev.package."*"] opt-level = 2` so dependencies are optimised once and our crates stay fast to rebuild.
- `Cargo.lock` — committed.
- `.gitignore` — one appended line, `/target/`.
- `contracts/README.md` — what lives under `contracts/`, the rule that every fixture passes in Rust and the TS oracle passes the SAME FILES while the v0 tree exists, the regeneration command per subdirectory, and the version window.
- `contracts/golden/issue-929/vault.db.gz`, `contracts/golden/issue-929/manifest.json` — byte-identical copies of the v0 corpus. `sha256sum` of both pairs: `vault.db.gz` `dd7cef709e42f6d615fad81e682d206a8afbfe1bcf6c859d9f040fd88062d0ad`, `manifest.json` `9799c2b7160b0275965ec2b1f5b31cfecb7d8708b833669a49a9ef77ab208093`. The v0 copy was not touched, moved or re-cut.
- `contracts/schema/vault-ddl.sql` — the corpus's `sqlite_master` (`type, name, tbl_name, sql` where `sql` is not null, ordered by `type` then `name`, `sqlite_stat*` excluded), 1,068 objects over 9,992 lines, with a header naming the command that writes it.
- `contracts/schema/v0-registries.json` — 39,640 bytes: `ontologyVersion`, the version window (`userVersion`, `ladderUserVersion`), `ontologyPacks` (8), `machineryBands` (10), `auditBand` (8 tables, 5 write-once), `privateTables` (28, by kind with reasons), `localTables` (43 with reasons), `sealedColumns` (4 entities), `entities` (96, with physical table, label, lifecycle, `projectionOf` and deletion roles), `contentReferences` (7), `retentionWindows` (audit 365, ledger 90), `snapshotExclusions` (1).
- `contracts/tools/export-v0-registries.ts` — the transcriber. Run by path (`bun contracts/tools/export-v0-registries.ts > contracts/schema/v0-registries.json`, then `bun run format`, because the repository formatter owns JSON too), not through a `bun run` script: it is v1 tooling that happens to be TypeScript, and v0's own gates leave PRs from wave 1.
- `crates/ontology/Cargo.toml`, `crates/ontology/README.md`.
- `crates/ontology/src/lib.rs` (`#![forbid(unsafe_code)]`), `error.rs`, `vault.rs`, `golden.rs`, `snapshot.rs`, `jsvalue.rs`, `doctor.rs`, `registries.rs`, `ddl.rs`, `src/bin/export-ddl.rs`.
- `crates/ontology/tests/golden_vault.rs` (the checkpoint + the version window), `tests/commitments.rs`, `tests/fixtures.rs`.
- `docs/vault-ontology.md` — one appended paragraph under `## Where the truth lives`. Nothing else in the file was altered.

### The checkpoint

`cargo test -p centraid-ontology --test golden_vault`, `the_ontology_crate_opens_the_v0_golden_vault` and `every_row_the_release_froze_is_still_there_with_its_values`:

```
compare_snapshot(manifest.tables, golden) -> findings: ""  ok: true
compared.tables = 16    compared.rows = 139    (== the manifest's own digest count)
PRAGMA user_version = 7 (== the manifest's), journal_mode = wal, ONTOLOGY_VERSION = "1.0"
PRAGMA integrity_check = ok, PRAGMA foreign_key_check = empty
```

`re_snapshotting_the_corpus_reproduces_the_frozen_manifest` is the stronger form: freezing the file again FROM RUST reproduces every table, column list, primary key, row count and 16-hex digest the release froze. That is what makes this crate a candidate to replace the TypeScript oracle rather than a second opinion — the digests were written by TypeScript over `node:sqlite` values, so reproducing them proves the file is being read the same way.

### Decisions — lane A

Both made by the root under the owner's standing delegation (R-1020-34), recorded verbatim so the next docs commit can mirror them into `docs/decisions.md`.

- **D-1020-A1 — the expected file version is a contract, not a constant** ([#1020](https://github.com/srikanth235/centraid/issues/1020)). `Vault::open` reads its expected `user_version` from `contracts/schema/v0-registries.json#userVersion` (embedded via `include_str!`, so no runtime file dependency), not from a hard-coded `7`; the golden corpus at 7 is the wave 1 checkpoint fixture, and wave 2 lane D re-freezes a golden at v0's current ladder head (11) with v0's own freezer (`bun run golden-vault:freeze`, a permitted `tests/**` fixture edit) so that v1's baseline is v0's CURRENT shape. If `userVersion` in that JSON is the frozen corpus's 7 (it is exported from the manifest), keep a second exported key `ladderUserVersion` = `VAULT_MIGRATIONS.length` (11) in the registries export and make `Vault::open` accept a file at EITHER the corpus version or the ladder head, refusing above the head with `DowngradeRefused` and below the corpus with `UpgradeRequired`.
- **D-1020-A2 — `replica_change` is an era exclusion of the corpus, never a registry entry** ([#1020](https://github.com/srikanth235/centraid/issues/1020)). `CORPUS_ERA_EXCLUSIONS`/`RETIRED_IN_CORPUS` in the tests with the reason and the #1014 citation; the library's ported `SNAPSHOT_EXCLUSIONS` stays `replica_meta` only.

D-1020-A1 as implemented in `d5356d19`: `userVersion` is exported FROM the golden manifest (7) and `ladderUserVersion` from `VAULT_MIGRATIONS.length` (11); `expected_user_version()` and `ladder_user_version()` read the embedded fixture, and `Vault::open` accepts the closed window between them. Four tests: both ends open, `ladder + 1` is `DowngradeRefused`, `corpus - 1` is `UpgradeRequired`, and a fifth asserts the two ends are DISTINCT so the window cannot collapse to a point and pass vacuously. The out-of-window files are made by inflating the corpus and STAMPING `PRAGMA user_version` — the version number is synthesised, not the shape a rung would build, which is the honest limit of a crate with no ladder; the test says so in its own header. That the ladder head really is `VAULT_MIGRATIONS.length` was checked out of band, not assumed: a throwaway vitest inside `packages/vault/src/` founded a fresh vault with v0's own `openVaultDb` and asserted `PRAGMA user_version === VAULT_MIGRATIONS.length` (passed; file deleted, `git status` clean).

### Commitments held, and the ones deferred

`crates/ontology/tests/commitments.rs`, one `#[test]` per row of `docs/vault-ontology.md` § *Commitments the code enforces* that a file-level check can hold, all against the frozen corpus:

| Held | How |
| --- | --- |
| Every physical table is a registered entity, a declared local table, a private table or an audit-band table | 139 base tables, all accounted for (one declared era exclusion, below) |
| Every entity row has an id unique across the model | 61 ontology-pack, non-projection entity tables each carry `<table>_entity_insert` and `<table>_entity_delete` |
| Evidence cannot be rewritten | an UPDATE and a DELETE are EXECUTED against `access_provenance` and both abort with the trigger's own message; the 5 write-once tables each declare both triggers |
| Secrets are ciphertext at rest, never indexed | no sealed column of the 4 sealed entities appears in any of the 165 FTS objects |
| A member's edit is refused when the row moved under it | 53 replicated mutable/trash entity tables all carry `row_version` |
| Money states its currency | `currency NOT NULL` on `tally_group`, `tally_expense`, `tally_settlement`, read from `PRAGMA table_info` rather than from DDL line breaks |
| Delete is a reversible trash with a grace window | all 13 trash entities carry `deleted_at`/`purge_at` AND the CHECK tying one to the other |
| Which schemas are life data and which are plumbing | every registered entity's schema is in exactly one of `ONTOLOGY_PACKS` / `MACHINERY_BANDS` |
| No replicated table references a private one | no non-private table declares a `REFERENCES` onto any of the 28 private tables |
| A vault that a harness touched is still sound | `integrity_check` and `foreign_key_check`, in `golden_vault.rs` |
| A vault from the frozen corpus opens and keeps every row | the checkpoint above |
| The DDL fixture equals the live `sqlite_master` | `fixtures.rs`, regenerated in memory and diffed |
| The two golden copies are byte-identical while the v0 path exists | `fixtures.rs`, with the wave-6 absence handled rather than failed |

**Deferred — held by v0's oracle until `crates/vault`**, because each one's mechanism is the command pipeline and this crate cannot write: a receipt committing in the same transaction as the mutation it describes; the retention windows and the archive pass proving custody before it prunes; a receipted reveal; a portable export carrying no key in the clear and an import re-sealing under the target's key; the purge behaviour per `DELETION_ROLES` role; a person's purge being refused while money and authority still name them; the derived-data travel judgement per table; the scripted reader scenarios under `tests/fixtures/ontology-scenarios/`; the bracketed-replica-writes discipline; `bun run lint:vault-sql`; the published-page-versus-DDL comparison; the `agent_command.ontology_version` equality check; and the recurrence and RRULE refusals. The lane's crate also does NOT ask v0's third doctor question — blob custody — because v1 has no CAS; `doctor.rs` says so in its own header so a clean report is not read as a claim it does not make.

One declared era exclusion, per D-1020-A2: `replica_change` holds 44 rows in the PRE-migration corpus, is in no registry, is DROPped by v0's rung ten ([#1014](https://github.com/srikanth235/centraid/issues/1014) R-1014-1), and is absent from the frozen manifest because the era that froze the file excluded the replica plane's own mechanism from the corpus. Consequence worth writing down: re-freezing the pre-migration corpus with TODAY's exclusion list yields 17 tables, not 16. The allowance lives in the two test files with that reason; the library's ported `SNAPSHOT_EXCLUSIONS` still names `replica_meta` and nothing else.

### Falsification

The two riskiest claims, each with the throwaway check that was run against it and reverted.

- **The digest port.** Claim: the Rust encoding reproduces v0's digests, so a green comparison means the file is being read identically. Check: the INTEGER branch of `jsvalue::encode_value` was changed from `number:{int}` to `number:{int}.0` — the difference between JavaScript's `String(1)` and a plausible Rust spelling. Result: 9 tables and every numeric row reported as `REWRITTEN`, 2 of 5 checkpoint tests red. The comparison is therefore load-bearing on the exact encoding and not on the row count. Reverted.
- **The DDL fixture.** Claim: the committed fixture describes the corpus, so drift is red. Check: one space inserted into the fixture's first `CREATE INDEX`. Result: `the_ddl_fixture_still_describes_the_corpus` red with `line 13: fixture: CREATE  INDEX … / live: CREATE INDEX …`. Reverted. `the_ddl_fixture_is_not_vacuous` covers the other direction (a fixture rendered down to its header would otherwise match a schemaless vault).

Two further anti-vacuity guards, because a green gate over nothing is the failure mode both of these invite: the checkpoint asserts `compared.tables == 16` and `compared.rows == 139` against the manifest's own count, and `re_snapshotting_…` asserts BOTH directions of the table set — which is what caught `replica_change` rather than a reviewer noticing it later.

The corpus cannot exercise every digest branch, and that is stated where it matters rather than implied by a green run: its 640 frozen cells are 453 TEXT, 144 NULL and 43 numeric, **every numeric one integral and inside the 2^53 safe range, and not one BLOB cell**. So `js_number_to_string`'s fractional and exponential forms and `encode_value`'s `object:` byte-join are held by a hand-written table of real JavaScript output in `jsvalue.rs` (24 cases, including `1e21` → `1e+21`, `1e-7` → `1e-7`, `1e-6` → `0.000001`, `-0` → `0`, `NaN`, `Infinity`), not by the fixture.

### Exit list

```
cargo fmt --all --check       # PASS — clean
cargo clippy --workspace --all-targets -- -D warnings
                              # PASS — clean, no allows spent beyond one #[expect] on the
                              #        integer-to-double cast, whose precision loss IS the JS
                              #        behaviour being reproduced
cargo test --workspace        # PASS — 32 tests green, 0 failed: 9 unit, 9 commitments,
                              #        5 fixtures, 9 golden_vault (5 checkpoint + 4 version
                              #        window). Checkpoint: compared.tables = 16,
                              #        compared.rows = 139, findings ""
cargo run -p centraid-ontology --bin export-ddl -- contracts/golden/issue-929/vault.db.gz \
  | diff - contracts/schema/vault-ddl.sql
                              # PASS — empty
bun contracts/tools/export-v0-registries.ts | diff - contracts/schema/v0-registries.json
                              # NOT EMPTY, and the fixture is still current: oxfmt owns JSON and
                              #        re-flows short arrays, so the committed file is the script's
                              #        output AFTER `bun run format`. The check used instead is the
                              #        one the brief allows: regenerate, format, diff against the
                              #        committed bytes -> no diff (idempotent). Documented in
                              #        contracts/README.md and in the script's header
sha256sum packages/vault/tests/golden/issue-929/* contracts/golden/issue-929/*
                              # PASS — pairwise equal (digests quoted above); also asserted by
                              #        tests/fixtures.rs while the v0 path exists
bun run format && bun run format:check
                              # PASS — "All matched files use the correct format"
bunx vitest run packages/vault/src/golden-vault.test.ts
                              # PASS — 1 file, 5 tests. The oracle is untouched. Needed `bun run
                              #        build` first in this fresh worktree (see findings)
bash .governance/run.sh       # PASS — all 10 directive(s) passed
node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5
                              # PASS — 10 rule(s), no findings, on the DEFAULT baseline (the
                              #        merge-base with origin/main, e9a7d81a), which is the
                              #        baseline CI judges and the one doc-integrity freezes
                              #        receipts against — so this section's append is free
bun run build                 # PASS — 14 successful, 14 total
bun run check:push:static     # PASS — 4/4 gates
git push -u origin claude/1020-laneA
                              # PASS — accepted; no SKIP_* and no --no-verify on any commit
node scripts/lint-path-filters.mjs
                              # 2 problems, `crates` and `contracts` unledgered — EXPECTED and
                              #        lane B's: `tests/path-filter-ledger.json` is its file and
                              #        was not touched here
```

No gate, ledger direction, budget, allowlist, lint config or law path was touched. No waiver was spent and no docket row was filed. No v0 file under `packages/**` or `apps/**` was edited: the corpus was COPIED, never moved.

### Findings for the close pass

Not fixed here; each is outside lane A's files or outside wave 1.

- `docs/vault-ontology.md` is stale on numbers: § *Where the truth lives* says the file's own version is `PRAGMA user_version` (5) and § *The shape today* says "A fresh vault at `PRAGMA user_version = 5`: **137 base tables**" with a five-rung ladder. Reality is a ladder of 11 rungs and 139 base tables in the frozen corpus. A.4 is append-only inside one section, so the rewrite belongs to the umbrella's doc pass.
- `bunx vitest run packages/vault/src/golden-vault.test.ts` fails in a FRESH worktree until `bun run build` has run: `@centraid/core`'s `./blob` subpath export resolves through `dist/`, and the vault package imports it. Pre-existing, and it will bite every lane that runs a v0 suite from a new worktree.
- `crates/ontology`'s snapshot port is byte-compatible with the TypeScript by construction and will stay so only while someone is looking. When wave 2 lane D re-freezes a golden at the ladder head, the two implementations should freeze the SAME file and diff the manifests — that is the check that keeps the port honest after v0's freezer stops running.

### Doctrine digest

Law `53be88c22ab5` (`node .governance/law/brief.mjs`), verified with `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5` — the law did not move under this lane's work.

## Wave 1 — lane B: xtask, the flake and the gate workflows

`cargo xtask gate` exists, it is the only CI entrypoint for the v1 tree, and pull requests now run it instead of `ci.yml`. Base: umbrella `0381e347` (lane A), rebased, never merged.

### Files

| Path | What it is |
| --- | --- |
| `rust-toolchain.toml` | the one version file for the v1 tree — `1.94.1`, `rustfmt` + `clippy`, minimal profile. Read by both gate workflows and by the flake |
| `.cargo/config.toml` | `[alias] xtask = "run --quiet --package xtask --"` |
| `crates/xtask/Cargo.toml`, `src/{main,gate,rules,ledger,measure,testing}.rs`, `README.md` | the gate runner. `#![forbid(unsafe_code)]`, three dependencies (clap, anyhow, serde_json), no `regex` and no tree-sitter |
| `contracts/ledgers/gate-budgets.json` | the per-profile feedback-time ceiling, down-only |
| `contracts/ledgers/compile-time.json` | clean check, incremental check, single-crate test, release build — down-only |
| `contracts/ledgers/library-size.json` | the prebuilt core's size per ABI, **seeded empty** |
| `.github/workflows/gate.yml` | `pull_request` + `push: main` + `workflow_dispatch`; jobs `gate` and `dependency-review` |
| `.github/workflows/gate-nightly.yml` | `schedule` 05:30 UTC + `workflow_dispatch`; `--profile nightly` |
| `.github/workflows/ci.yml` | `pull_request:` removed, `schedule:` added, `all` extended to cover it, header rewritten. **No job touched** |
| `.github/actions/setup/action.yml` | a `v1` cargo-cache preset (`target/` + `~/.cargo/bin`) |
| `scripts/lint-workflow-pins.{mjs,test.mjs}` | rule 5's single open-PR entry point repointed to `gate.yml` |
| `tests/path-filter-ledger.json` | `crates` and `contracts` ledgered as always-on, covered by `gate.yml` unfiltered |
| `flake.nix` | the #504 packaging stub replaced by `devShells.default` |
| `.xcode-version` | `16.4` — the one toolchain nix cannot pin |
| `deny.toml` | comment only: the shared policy now has a fourth crate root |
| `docs/toolchain.md`, `docs/dev-environment.md` | the v1 gate loop as current state |

`contracts/ledgers/` is a new subdirectory under lane A's `contracts/`; no other lane created it, and the rebase was clean there.

### Decisions — lane B

Under the owner's standing delegation R-1020-34, relayed by the root. All cite [#1020](https://github.com/srikanth235/centraid/issues/1020).

- **D-1020-B1 — inherited red is named, never hidden.** `gitleaks` and `osv-scanner` were `ci.yml` pull-request lanes and are not v0 gates, so they move onto the new PR gate with the others *even though both are red on tree state that predates this work*. A PR gate that stops reporting because its target is red today is a weakening. Nothing was added to `.gitleaks.toml` or `osv-scanner.toml`: a gate whose first act is to widen its own allowlist has gated nothing. Both fixes are owner hand-offs below.
- **The `ci.yml` change is two edits, not one, and they are inseparable.** Adding `schedule:` without extending the `changes` job's `all` output to the `schedule` event would have installed a lane that skips every path-gated job and reports green — the `skipped`-counts-as-PASS hazard that file's own comments are about. No job was otherwise touched.
- **`dependency-review` and four repo-wide linters moved onto the PR gate.** `lint:workflow-pins`, `lint:ci-egress`, `lint:path-filters` and `actionlint` are the `ci-policy` step; `dependency-review` is its own job in `gate.yml` because it reads the PR's dependency diff through the API and cannot be a step of a command. It keeps narrow permissions so `pull-requests: write` is not handed to the job that compiles third-party crates.
- **One entry point, named once.** `scripts/lint-workflow-pins.mjs` rule 5 now reads a single `PR_ENTRY_POINT` constant instead of a hard-coded `ci.yml`, and a new test asserts `ci.yml` is refused like any other file now that it has let go. An allowlist of two is how "exactly one" becomes "a few".
- **`ts-static` is scoped to the v1 tree**, not a second run of v0's static gate: re-running v0's gates on pull requests under a different name would be the same CI bill with the ruling pasted over it. On this merged tree the step is no longer a skip — lane A's `contracts/tools` is TypeScript, so it ran `bun run check:push:static` for real and passed.

### Inherited red on `main`

Both fail today, both named in `crates/xtask/src/gate.rs`, `crates/xtask/README.md` and `docs/toolchain.md`.

| Step | Finding | Arrived with |
| --- | --- | --- |
| `secrets` (gitleaks 8.30.1) | `leaks found: 1` — `packages/model-runtime/LICENSES.md`, rule `generic-api-key`, secret redacted | `af9ceac6` (#1011/#1012) |
| `osv` (osv-scanner 2.4.0) | `astro@7.1.5 (score 9.8)` CRITICAL; the full inventory is 1 Critical / 60 High / 44 Medium / 5 Low across 34 packages of `bun.lock` | pre-existing |

### Owner hand-offs

1. **Branch protection must be repointed, or every pull request blocks.** The required check is `check` from `ci.yml`, which no longer runs on pull requests; a required check that never reports blocks the PR forever. The owner must make **`gate`** and **`dependency-review`** — the two jobs in `gate.yml`, neither path-filtered, so both always report — the required checks. Branch protection is configured outside this repository, like the code-owner review requirement.
2. **The `LICENSES.md` gitleaks hit.** A reasoned `.gitleaks.toml` allowlist row naming the file, or moving the offending string, is the owner's call. Not taken here.
3. **The `astro@7.1.5` CRITICAL.** A dependency bump, which is a change outside #1020's scope.

### Timing, measured on this container (4 vCPU, 15 GB — `ci-linux-x64-4c`)

Cold means after `cargo clean`, on the merged tree with both crates.

| Profile | Cold | Warm | Budget | Verdict |
| --- | --- | --- | --- | --- |
| `local` | **76.3 s** (clippy 63.7, test 12.5) | 0.4 s | 120 s | PASS |
| `pr` | **176.9 s** (clippy 63.8, release-build 67.1, ts-static 22.6, test 13.0, deny 1.0, ci-policy 0.3) | — | 900 s | the two inherited reds, nothing else |
| `nightly` | — | 8.7 s (v0 oracle 4.9) | unbounded | PASS |
| `release` | — | 6.5 s | unbounded | FAILS on its two placeholders only |

`local` is at 64% of its ceiling with two crates, and `clippy` is 83% of that — `rusqlite`'s bundled C build dominates a cold run. That is the pressure the ledger exists to make visible, and the issue's structural answers (sccache, mold, one crate per app) are what wave 2 will need to spend to keep the ruling.

Ledger seeds, with the wave-1 measurement in each entry's `headroom`: `cleanCheckSeconds` 17.4 → 180; `incrementalCheckSeconds` 0.1 → 10; `singleCrateTestSeconds` 10.4 → 60; `releaseBuildSeconds` 28.9 → 600 (this one is enforced by the `pr` profile). `library-size.json` is empty and says so. All are written only by `cargo xtask measure --write`, which only ever lowers a ceiling, so a gate run cannot ratchet itself upwards by observing a slow day.

### Demonstrated reds

Every structural rule has a fixture that must be caught; a rule with no demonstrated red is a claim, not a gate. From `cargo test --workspace`:

| Rule | The red | The green beside it |
| --- | --- | --- |
| `sql-confinement` | `sql_outside_the_allowed_crates_is_caught` — `"SELECT 1 FROM rows"` in `crates/net/src/lib.rs` is one finding; the same literal in `crates/vault` is none | `sql_inside_the_allowed_crates_is_clean`, including `SELECT` in a doc comment |
| `abi-five-symbols` | `a_sixth_abi_symbol_is_caught` — six `extern "C"` symbols reports `6 … not 5` | `exactly_five_abi_symbols_is_clean`; `the_abi_rule_is_pending_until_the_crate_lands` |
| `no-listening-socket` | `an_unguarded_listener_is_caught_and_a_guarded_one_is_not` — line 2 is a finding, the `#[cfg(feature = "blob-door")]` one is not; `the_listener_rule_reports_the_file_and_line` | same tests |
| `commonmain-no-platform-import` | `a_platform_import_in_commonmain_is_caught` — `import android.os.Bundle` | `commonmain_without_platform_imports_is_clean` |
| down-only ledgers | `a_risen_number_is_a_finding`, `a_removed_ceiling_is_a_finding` | `a_fallen_number_is_clean`, `a_new_ledger_with_no_base_copy_passes`, `a_new_entry_in_an_existing_ledger_passes`, `an_empty_ledger_gates_nothing_and_says_so` |
| the `release` placeholders | `the_placeholders_fail_rather_than_skip` — both must FAIL, because a profile that can pass without the restore drill would call a release green that nobody proved restorable | `each_profile_is_a_superset_of_the_one_before` |

On the merged tree the two applicable rules now cover lane A's crate: `sql-confinement` — 0 files scanned, **13 in the allowed crates** (`crates/ontology` is an allowed root), 6 in the rule runner; `no-listening-socket` — **13 files scanned**, clean, 6 in the rule runner. `crates/xtask` is exempt from both because it holds their pattern literals; it ships in no artifact and opens no socket.

### Exit list

| # | Check | Outcome |
| --- | --- | --- |
| 1 | `cargo fmt --all --check` | clean |
| 2 | `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| 3 | `cargo test --workspace` | 56 passed — 32 ontology (9 unit + 9 commitments + 5 fixtures + 9 golden vault) and 24 xtask |
| 4 | `cargo xtask gate --profile local` | PASS, 76.3 s cold of 120 s |
| 5 | `cargo xtask gate --profile pr` | 176.9 s of 900 s; every step green except the two inherited reds (D-1020-B1). `deny` is REAL, not skipped |
| 6 | `cargo xtask gate --profile release` | exit 1 on exactly `restore-drill: not implemented: lands in wave 2 lane R (…)` and `vps-smoke: not implemented: lands in wave 3 lane G (…)` |
| 7 | `bun run lint:workflow-pins` | 25 workflows clean |
| 8 | `bun run lint:ci-egress` | 5 enforce an egress policy, 16 ledgered |
| 9 | `actionlint` 1.7.12 | exit 0 |
| 10 | `bun run lint:path-filters` | 10 filters cover every path, 5 ledgered always-on — run after this rebase, with `crates/ontology` and `contracts/` present |
| 11 | `bun run format` + `format:check` | clean |
| 12 | `bash .governance/run.sh` | every directive passes |
| 13 | `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5` | no findings |
| 14 | `bun run check:push:static` | 4/4 |
| 15 | `git push` | accepted; no `SKIP_*`, no `--no-verify` |

### Falsification

The two riskiest claims in this lane, and the throwaway check run against each.

**"Pull requests still gate."** Dropped a `.github/workflows/zz-throwaway.yml` with `on: pull_request` and `uses: actions/checkout@v4` — a floating ref, the exact thing `ci.yml` used to catch on a PR — and ran `cargo xtask gate --profile pr`. It went red on `ci-policy` with two findings: the floating ref, and `zz-throwaway.yml:3 listens on 'pull_request' — only .github/workflows/gate.yml may (open PR events), because a PR's verdict has one source`. The file was removed. So the workflow-policy gates a pull request still passes through, from inside the gate that replaced `ci.yml`, and the single-entry-point invariant is enforced against the new owner rather than merely asserted about the old one.

**"No v0 gate was deleted, only moved."** `diff <(git show 0381e347:.github/workflows/ci.yml | grep '^  [a-z0-9_-]*:$') <(grep '^  [a-z0-9_-]*:$' .github/workflows/ci.yml)` — 24 two-space keys before and 24 after, and the only line that differs is `pull_request:` → `schedule:`. Every one of the 21 job keys (`changes, static, gates, verify, coverage-shard, coverage, publish-report, mutation-pr, new-test-burn-in, mobile-smoke, mobile-device-gate, docs, web-build, iroh-wasm, companion-static, oauth-worker, dependency-review, gitleaks, osv-scanner, design-gallery, check`) is byte-identical, and the trigger set is now `push: [main]`, `schedule: 0 4 * * *`, `workflow_dispatch`. What changed is when a v0 regression surfaces — push-and-merge-blocking becomes push-and-within-a-day — and nothing else.

### Not done

- **`flake.nix` has not been evaluated.** `nix` is not installed on this container, so `nix flake check` has not run; the file says so in its own header. Balanced attrsets and both inputs named in `outputs` were checked by reading. The first evaluation on a machine with nix is what confirms it.
- `cargo-nextest`, `buf`, `protoc`, `mold` and `sccache` are not installed here. The `test` step ran `cargo test` and says which runner ran in its line; the flake pins all five for anyone with nix.
- `.xcode-version` is `16.4` and **not confirmed against a build** — wave 3 lane E owns the first iOS compile and confirms or replaces it.
- The device lanes are a named loud skip, not a stub that passes: `ios-transfer-experiment`, `android-macrobenchmark`, `ios-xctest-metrics`, `battery-per-background-pass` need the self-hosted macOS runner of open question 13.

### Findings for the close pass

- The two inherited reds above are the lane's largest finding and are already owner hand-offs 2 and 3.
- `bun run check:push:static` fails in a fresh worktree until `bun run build` has run, with module-resolution errors that read like product bugs (`Cannot find module '@centraid/server/engine'`). Same root cause lane A recorded for the v0 vitest oracle, one gate further out.
- `ci.yml`'s evidence pipeline (`scripts/test-report/write-evidence.mjs`, the `pr-evidence-*` artifacts, `publish-report`) now only runs on `main` pushes and nightly. `gate.yml` writes no lane evidence, so the per-PR test report has no rows for the v1 gate. Re-homing it is wave 3 lane G's `scripts/ci/**` work; naming it here so it is not discovered as a silence.
- `sonarcloud.yml`, `hygiene.yml`, `candidate.yml` and `cache-cleanup.yml` mention `pull_request` in prose or in `on:` sub-keys but none carries an open-PR trigger; `governance.yml` does and is `governance-kit:managed`, so it keeps reporting its own required check on pull requests and rule 5 exempts it upstream. Verified by reading each `on:` block.

### Doctrine digest

Law `53be88c22ab5`, verified with `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5` — the law did not move under this lane's work, and no waiver was spent.

## Wave 2 — lane D3: the app kit, Tally, and the ceiling nobody could reach

The app half of wave 2 lane D: `crates/apps/kit` (the paged-read grammar every app is written in), `crates/apps/tally` (the shared-expense ledger), and Tally's parity fixtures generated from the v0 handlers. Four commits, then this one.

The lane's headline is not the port. It is that **porting Tally's stated ceiling made it measurable for the first time, and the ceiling turned out to be unreachable in v0**: the dashboard reads 500 expenses while declaring 2,000, discards the cursor that says there are more, and folds a balance over what it got — which is the exact failure its own doctrine names four lines above the window declaration.

### What landed

**`0b8ebbe0` — `feat(apps): the app kit — paged reads, the door grammar and Money`**

- `Cargo.toml` — `members` gains `crates/apps/kit`; `exclude` gains `crates/apps` (see D-1020-D3-13).
- `Cargo.lock` — `proptest` and the two new crates.
- `crates/apps/kit/Cargo.toml`
- `crates/apps/kit/src/lib.rs` — the crate's own contract: what the kit guarantees, what an app may not do, and what stops it.
- `crates/apps/kit/src/error.rs` — `KitError`. Every variant is a member-visible outcome in v0; a denial is deliberately **not** one of them.
- `crates/apps/kit/src/row.rs` — `Cell`, `Row`, `Found`. NULL, MISSING and a value kept as three claims.
- `crates/apps/kit/src/page.rs` — `PageCursor`, `PageRequest`, `Page`, `MAX_PAGE_ROWS`, `probe_limit`, `page_of`.
- `crates/apps/kit/src/statement.rs` — `PageOrder`, `PageQuery`, `page_cursor_of`, `page_cursor_boundary`, the one `page_statement` assembler.
- `crates/apps/kit/src/grammar.rs` — the paged door's grammar as a parser over the statement-as-data: `ALLOWED_WORDS`, `OPERATORS`, `parse`, `check_columns`, `TableFacts` as the vault's splice point.
- `crates/apps/kit/src/money.rs` — `Money` as `i64` minor units, `Currency`, the ISO 4217 minor-unit table, `MoneyBag`, `Valuation`, `js_round_div`, `format_money`.
- `crates/apps/kit/src/manifest.rs` — the `app.json` parser and the three cross-cuts a schema cannot express.
- `crates/apps/kit/src/changes.rs` — `ChangeEvent`, `coalesce`, `DependencySet::matches`.
- `crates/apps/kit/src/reads.rs` — `PageDoor`, `in_list`, `FanOutBound`, `JOIN_FAN_OUT`, `read_by_id`, `read_pages`.
- `crates/apps/kit/src/testdoor.rs` — the SQLite test door.
- `crates/apps/kit/src/fixtures.rs` — the year-3 Tally generator.
- `crates/apps/kit/tests/keyset_properties.rs` — the keyset properties.

**`38d6284c` — `test(contracts): Tally's parity fixtures, generated from the v0 handlers`**

- `contracts/tools/export-tally-parity.ts` — founds a fresh v0 vault, seeds through the real typed commands, invokes all eight queries through the real handler path, canonicalises and returns the bundle.
- `contracts/tools/tally-parity-ledger.ts` — the scripted ledger (three currencies, uneven payers, a group-less 1:1, a trashed expense, a departed member, a standing order with an overridden occurrence, a prepared nudge).
- `contracts/tools/tally-parity-balances.ts` — the six balance-engine cases.
- `contracts/apps/tally/{rows,queries,balances,scenarios}.json` — the bundle.
- `contracts/README.md` — the `apps/tally/` row, and the wave-2 note corrected (`apps/*/` no longer "wave 4" wholesale).
- `tests/quality/tally-parity.contract.test.ts` — **the one permitted v0 edit in this lane**: a fixture adapter under `tests/**` that is both the emitter (`CENTRAID_WRITE_CONTRACTS=1`) and the oracle (without it, it rebuilds from the live v0 tree and fails if the committed files disagree). No product code and no v0 behaviour changed. It sits under `tests/` rather than `packages/vault/tests/` because `packages/vault/tsconfig.test.json` sets `rootDir: "."`, so a file there cannot import `contracts/`; `tests/`'s own tsconfig already spans the repository, which is why the invariants name that path for this shape of file. Nothing was relaxed to get it to typecheck: the eight handler specifiers are computed at run time so the blueprint handler graph never enters a TypeScript program that also sees `packages/vault/src`.

**`c6d84848` — `feat(apps): crates/apps/tally — the manifest, the balance engine, loadTally`**

- `Cargo.toml` — `members` gains `crates/apps/tally`.
- `crates/apps/tally/{Cargo.toml,manifest.json}` — the manifest is v0's `app.json` byte for byte.
- `crates/apps/tally/src/lib.rs`, `src/manifest.rs`, `src/balance.rs`, `src/queries.rs`, `src/commands.rs`.
- `crates/apps/tally/tests/parity.rs` — the balance-engine parity and the `loadTally` fold over the fixture ledger.
- `crates/apps/kit/src/contract_vault.rs` — `open_contract_vault`, moved out of the tally test because `sql-confinement` scans tests too.
- `crates/apps/kit/src/lib.rs`, `src/fixtures.rs`, `src/reads.rs`, `crates/apps/tally/src/queries.rs` — the fan-out arithmetic.

**`7cdcf437` — `feat(apps): the year-3 Tally axis, measured, and the window it uncovered`**

- `crates/apps/kit/src/fixtures.rs` — `YEAR3_TALLY`, `year3_tally`; the stand-in DDL **deleted** in favour of the committed one.
- `crates/apps/kit/src/reads.rs` — `Window`, `read_window`, `FanOutBound::reachable_page_size`, `cap` reporting the reachable number.
- `crates/apps/tally/src/queries.rs` — windows walked rather than clamped; `TallyData::ledger_window_filled`.
- `crates/apps/tally/tests/year3.rs` — the measurement.
- `contracts/apps/tally/year3-ceiling.md` — the volume, the query, the cells, the numbers and the two findings.

**This commit** — `crates/apps/kit/README.md`, `crates/apps/tally/README.md`, this section.

### Exit list

| Command | Outcome |
| --- | --- |
| `cargo fmt --all --check` | clean |
| `cargo clippy --workspace --all-targets` | **0 warnings**, 0 errors |
| `cargo test --workspace` | **14 suites, all ok** — kit lib 54, kit keyset properties 7, tally lib 25, tally parity 4, tally year3 1, ontology and xtask unchanged |
| `cargo xtask gate --profile local` | green, inside budget |
| `cargo xtask gate --profile pr` | green except the two inherited reds named in wave 1 (gitleaks on `packages/model-runtime/LICENSES.md`, osv on `astro@7.1.5`) |
| `sql-confinement` | `ok sql-confinement — 7 file(s) scanned, clean (27 in the allowed crates, 6 in the rule runner)` — the 7 scanned are `crates/apps/tally`'s source and tests, and they hold no SQL; the kit's 12 files are among the 27 in the allowed crates |
| `no-listening-socket` | `ok — 34 file(s) scanned, clean` |
| `node node_modules/vitest/vitest.mjs run --config vitest.quality.config.ts tests/quality/tally-parity.contract.test.ts` | 2 passed — the fixtures are what the live v0 handlers answer |
| `CENTRAID_WRITE_CONTRACTS=1 … && bun run format && git diff --exit-code contracts/apps` | clean — generation is idempotent |
| `bun run check:push:static` | **4/4** — `lint`, `format:check`, `turbo:lint`, `typecheck:affected` |
| `bun run format` / `format:check` | clean |
| `cargo mutants -p centraid-apps-kit` | **not run** — see "Not done" |

### Parity numbers

- **Balance engine: 6 cases × 7 comparisons each = 42 assertions**, all green: attributions per live expense, per-member net, the pairwise matrix, the open-debt count, the minimal transfers, and the simplification both opted in and out. The cases are the odd amount over three sharers, two payers, a settlement, a zero share, a departed member and a four-way simplification.
- **`loadTally` over the fixture ledger**: 6 live expenses, 1 trashed, 3 groups in 3 currencies, 16 split rows, 8 payer rows, 1 settlement, 1 standing order, 1 occurrence exception, 4 parties — every payer set and split set sums to its amount, every group's pairwise matrix reconciles with its net, and the departed member is still nameable.
- **`queries.json`: 29 cases across all 8 queries, committed, not yet compared** (see "Not done").
- **Year-3 `loadTally` at 2,000 expenses / 8,000 splits on `ci-linux-x64-4c`: 58 ms release, 124 ms dev**; the balance fold over 40 groups / 240 pair rows: 6 ms release, 27 ms dev. Projected provenance, not a budget.

### Decisions — lane D3

Adopted under **R-1020-34** ([#1020](https://github.com/srikanth235/centraid/issues/1020)): options written, recommendation adopted, recorded here.

- **D-1020-D3-10 — a keyset page is not continued over a NULLABLE sort column.** Options: (a) reproduce v0, which silently drops rows; (b) refuse the continuation; (c) build the typed, versioned cursor that can carry NULL as its own value. **Adopted (b)**, with (c) filed as a finding. SQLite compares a row value with a NULL operand to **NULL, not true** — verified directly: `SELECT (NULL,'pk-4') > ('','pk-3')` answers NULL — so v0's continuation drops rows in three of the four (direction, boundary) cases and says nothing. (a) is a wrong ledger; (c) is a wire-format change that belongs with the protocol lane. Cites [#1020](https://github.com/srikanth235/centraid/issues/1020).
- **D-1020-D3-11 — the parity fixture is canonicalised ROWS, not a `vault.db.gz`.** Options: (a) the brief's compressed vault; (b) rows plus the committed DDL. **Adopted (b)**. `bootstrapVault` mints the vault, the owner party and the first device as UUIDv7 off the clock and they are not seed-derived, so a database file is not byte-reproducible and the idempotency gate could never pass; a compressed database is also not a diff anyone reads, and `contracts/README.md`'s rule is that a fixture is data both trees read without a bridge. Rust rebuilds the same file from the rows and `contracts/schema/vault-ddl.sql`, which stays the one copy of the model. Cites [#1020](https://github.com/srikanth235/centraid/issues/1020).
- **D-1020-D3-12 — a bound and a window report the size they can reach.** Options: (a) restate v0's arithmetic and reproduce both bugs; (b) report the reachable cap and walk a stated window. **Adopted (b)**, and Tally's bounds are restated at a page size of 500 so the stated ceilings (8,000 and 32,000) are the reachable ones. `MAX_PAGE_ROWS` clamps a page to 500, so `pageSize × fanOutPages` names twice the rows it stops at whenever `pageSize` exceeds 500, and a window asked for as one page reads a quarter of itself. A cap that lies about its own size is worse than a smaller cap. Cites [#1020](https://github.com/srikanth235/centraid/issues/1020).
- **D-1020-D3-13 — each app crate is a NAMED workspace member.** Options: (a) the brief's `"crates/apps/*"` glob; (b) name each app crate. **Adopted (b)**, because (a) does not work: `crates/*` also matches `crates/apps`, cargo refuses a glob match with no manifest, and adding `crates/apps` to `exclude` excludes the whole subtree — an explicitly listed member is the only thing that overrides its parent's exclusion. Naming them also keeps the count visible in the workspace file, which a glob hides. Cites [#1020](https://github.com/srikanth235/centraid/issues/1020).
- **D-1020-D3-14 — the parity generator's epoch is 2099 and host-clock instants are tokenised.** Options: (a) a past epoch and no trash step; (b) tokenise the clock-dependent columns and move the epoch past the host's clock. **Adopted (b)**. The vault has **two clocks**: a handler stamps `ctx.now`, which a JS proxy can hold still, while a command's pre/postconditions are SQL and read SQLite's own `strftime('now')`, which no proxy reaches. With a frozen clock in the past, `tally.delete_expense` writes a `purge_at` already expired by the host's reckoning and its own postcondition refuses it, so the trash case cannot be fixtured at all; and every replicated table's `updated_at` defaults to the host clock, so it can never be committed as a value. Cites [#1020](https://github.com/srikanth235/centraid/issues/1020).

### Demonstrated reds

Every gate this lane added landed with a red first, and each one is a named test rather than a claim.

| Gate | Demonstrated red |
| --- | --- |
| `NullableSortKey`, boundary half | `testdoor::tests::a_null_sort_key_at_a_boundary_is_refused_not_dropped` — the ascending case, where the boundary row is NULL |
| `NullableSortKey`, continuation half | the same test's descending half, where the boundary row is valued and the NULL rows are the ones still owed — the case a boundary check alone misses and v0 gets wrong with no signal |
| `NullableSortKey`, as a property | `keyset_properties::a_walk_is_whole_or_refused`, and `the_recorded_counterexample_is_refused` keeps the shrunk case the property found |
| The grammar | `grammar::tests::refused_shapes` — eleven shapes, one per refusal: a second statement, a line comment, a block comment, a subquery in `FROM`, a nested `SELECT`, an unlisted function, a `JOIN` with no `ON`, an unterminated string, an unknown token, two tables under one name, an unreadable alias |
| The field mask and sealed columns | `grammar::tests::a_column_outside_the_field_mask_and_a_sealed_column_are_both_refused` |
| The door refuses what the grammar refuses | `testdoor::tests::the_door_refuses_what_the_grammar_refuses` — and asserts the table is still there afterwards |
| `FanOutBound::cap` | `reads::tests::the_stated_ceiling_is_the_reachable_one` — v0's `{1000, 8}` reaches 4,000, not 8,000 |
| `read_window` | `reads::tests::a_stated_window_is_walked_rather_than_clamped` — 1,200 rows, one page of a 1,000-row window returns 500 **and a cursor**, which is what v0 takes and folds a balance over |
| `FanOutExceeded` in Tally | `parity::a_fan_out_past_its_ceiling_errors_rather_than_answering_short`, and asserts the honest bound reads all 16 rows |
| The `(expense_id, party_id)` pair keyset | `parity::a_page_boundary_inside_one_expense_loses_no_sharer` — added because the falsification below found that neither the parity nor the year-3 fixture crossed a boundary inside an expense |
| The manifest's cross-cuts | `manifest::tests::{the_version_is_checked_before_the_shape, a_reserved_handler_name_is_refused_on_both_sides, one_name_in_both_lists_is_allowed_and_two_in_one_is_not, an_action_with_no_writes_key_is_refused, states_is_a_closed_partition, an_uncanonical_state_is_refused}` |
| A denial is a value | `commands::tests::a_denial_is_a_value_and_not_an_error`, and `an_absent_door_fails_closed_and_names_the_command` for the other half |
| The zero window | `page::tests::a_zero_window_is_refused_by_both_ends` |

### Findings outside the slice

Each one is a v0 bug or seam this lane found and did not fix in v0, because v0 is the pinned oracle.

1. **`loadTally` reads a quarter of its declared ledger window and folds a balance over it.** `queries/dashboard.ts:267-280` asks for `limit: LEDGER_ROWS` (2,000) as one page and takes `.rows`; `MAX_PAGE_ROWS` clamps to 500 and the `next` cursor is discarded. The dashboard's hero figures, every group ledger and the friend view are all folds over this. **The most serious finding of the lane** — it is a wrong number on a shipped surface, not a slow screen, and the doctrine four lines above the declaration says so in those words.
2. **Every declared fan-out over a page size of 500 reaches half the rows it names, then throws a message naming the other half.** Tally's `LEDGER_FAN_OUT` states 8,000 and reaches 4,000; `ALLOCATION_FAN_OUT` states 32,000 and reaches 16,000. Combined with finding 1: at 2,000 expenses with four sharers each, v0's `loadTally` **throws**, and the only reason nobody has seen it is that no fixture could reach that volume.
3. **A keyset continuation over a nullable sort column silently drops rows** in three of the four (direction, boundary) cases, because SQLite compares a row value with a NULL operand to NULL. No Tally statement is exposed today (`spent_on` and every other sort column is NOT NULL), but nothing in v0 prevents one; the next app to page by `due_at` or `archived_at` gets a short list with no signal.
4. **The vault has two clocks.** A command's handler stamps `ctx.now`; its pre/postconditions are SQL and read SQLite's `strftime('now')`. `EXPENSE_TRASHED_SQL` is the instance that bites: a frozen-clock fixture in the past cannot trash an expense, because its own postcondition compares `purge_at` to the host's wall time. `crates/vault` should take its instant from one injected source.
5. **`updated_at` cannot be fixtured.** Every replicated table defaults it to `strftime('now')` and a trigger re-stamps it the same way, so it is the wall time of whoever regenerated a fixture. Tokenised here; the one-clock fix in finding 4 removes it.
6. **v0's currency formatter is wrong for JPY and KWD and locale-dependent everywhere.** `packages/design/src/format.ts:38` divides minor units by 100 unconditionally and passes `undefined` as the locale, so the same vault renders differently on two devices. The port carries a minor-unit table and takes an explicit locale; parity fixtures for formatting are therefore deliberately **not** generated from v0.
7. **`line-model.ts` mints line ids from a module-level counter.** Two seats composing offline produce colliding `line-1` ids. Not reached in this lane (the port has no line-draft model yet), so it stays a finding rather than a fix — the port will mint from a seat-scoped ULID, as the expense id already is.
8. **`tally.remove_group_member`'s `member_off_ledger` precondition makes it unusable for any member who has spent anything**, which is every member a group has. `leave_group` is the verb that works, and the manifest offers both with no hint that one is unreachable. Worth a product question rather than a code change.
9. **`reads` on a manifest query entry is dead**: the type has it and no bundled app populates it. Either it means something and the apps are under-declaring, or it should go.

### Owner hand-offs

1. **Finding 1 is a live wrong number on a shipped surface.** v0 is the pinned oracle and this lane did not touch it, but the dashboard is wrong for any member with more than 500 live expenses today. Options: (a) leave it, on the grounds that v1 fixes it and few members are over 500; (b) a one-line fix in v0's `loadTally` to walk the window, taken as a permitted oracle edit; (c) ship it as a known issue with a surface note. **Recommendation: (b)**, because the fix is small, the fixture that proves it now exists, and "the oracle is wrong about the thing the port is being compared to" is a worse position than a narrow edit to the oracle. Needs the owner's word, since it is outside this lane's file set.
2. **Finding 8** — is `remove-group-member` meant to be reachable? If yes its precondition needs to change; if no, it should not be a manifest action.

### Doctrine digest

Law `53be88c22ab5`, stamped. `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5` — no findings. `bash .governance/run.sh` — all directives pass. No waiver spent; no law path, gate, budget, ledger or allowlist touched. The one edit inside the pinned v0 tree is `packages/vault/tests/contracts/tally-parity.test.ts`, which the invariants permit by name.

### Not done, and why

- **`queries.json`'s 29 cases are not compared in Rust.** The outputs carry presentation the port has no source for: a party's colour from `partyHueValue`, its initials from `identityInitials`, a ledger row's tone from `figureTone` — all in `packages/design`, which moves to `design/` in wave 3/4 with the token emitter (D-1020-D3-9). Comparing the arithmetic alone would mean editing the fixture to drop fields, which is the one thing a generated fixture must not allow. The fixture is committed and is the next wave's first job.
- **The `history` and `matches` queries have no Rust statements.** They read `core_entity_revision`, `core_transaction`, `core_link` and `core_account` — the revision and finance planes, which are `crates/vault`'s (lane D1). Their v0 outputs are in the fixture.
- **The client-side models** (`split-model`, `line-model`, `draft-model`, `contrib-model`, `receipt-model`, `spending-model`, `schedule-model`, `activity-model`) are not ported. They are form arithmetic and surface state, not the ledger, and they belong with the shell that renders them.
- **`cargo mutants -p centraid-apps-kit` was not run.** It is not installed in this container and `cargo install cargo-mutants` is a from-source build the lane's budget did not have. The exit criterion names it as judged at lane D2's close; the crate's tests are the survivor surface it will be run against, and the receipt records it as owed rather than done.
- **`crates/vault/src/commands/tally.rs`** — untouched. Lane D1's skeleton did not land during this lane, so the 23 actions sit behind the `Commands` trait with an in-memory test implementation, exactly as the brief specified for that case.
- **The change stream's wire half** (`ChangeEvent` over the ABI, the SSE frame) is not here; `changes.rs` is the matching rule and the coalescing, which is the app-visible half.

### Falsification

The two riskiest claims in this diff, the throwaway check run against each, and the result.

1. **"The ported statements are the same statements, so the parity fixture is a fair comparison."** The risk is a port that agrees with v0 because both were written from the same reading of the same file, not because they compute the same thing. Check: the fixture was generated by **executing v0** — a real founded vault, the real typed commands, the real handler path through the real paged door — and the Rust side was pointed at the resulting rows. Then one statement was deliberately broken: `tally.dashboard.splits`' order changed from the `(expense_id, party_id)` pair to `expense_id` alone, which is the exact trap the census names, and the suites were re-run.

   **Result: the parity suite did NOT catch it, and neither did the year-3 suite.** Only the statement-shape unit test did. The reason is alignment, and it is worth more than the check was: the fixture's sixteen split rows fit inside one 500-row page, so no boundary is crossed at all; and the year-3 profile's **four sharers per expense divides the 500-row page exactly**, so at 8,000 split rows the boundary lands between expenses sixteen times and never inside one. Both fixtures were blind to the trap by arithmetic accident.

   So the claim was **false as stated** and the lane now carries the gate it was missing: `parity::a_page_boundary_inside_one_expense_loses_no_sharer` walks pages of **three** over expenses with four sharers, so every boundary falls inside one, and compares the walk to the single-page read row for row. Against the broken keyset it fails with "a boundary inside an expense dropped its remaining sharers"; against the correct one it passes. The break was then reverted and the workspace is green.

A third, cheaper one worth recording: the claim that **`crates/apps/tally` holds no SQL** is not a comment, it is `cargo xtask rules`' verdict, and it was checked to be actually scanning — `sql-confinement` reports `7 file(s) scanned` for this crate rather than `0`, and the 27 files it skipped are named as in the allowed crates.

## Wave 2 — lane C: the schema workspace, the protocol, the iroh endpoint and the one binary

Four slices, four commits, on `claude/1020-laneC`, rebased onto lane D3's `d5654afc`.

### What landed

**`a5bfa41d` — C.1, api-proto.** The two protobuf packages, generated in-tree.

- `crates/api-proto/Cargo.toml`, `crates/api-proto/build.rs`, `crates/api-proto/src/lib.rs`, `crates/api-proto/README.md`
- `crates/api-proto/proto/centraid/core/v1/`: `value.proto`, `row.proto`, `log.proto`, `snapshot.proto`, `intent.proto`, `command.proto`, `query.proto`, `change.proto`, `handshake.proto`, `pair.proto`, `admin.proto`, `error.proto`, `envelope.proto`
- `crates/api-proto/proto/centraid/screen/v1/screen.proto`
- `crates/api-proto/tests/roundtrip.rs`, `crates/api-proto/tests/tree.rs`
- `buf.yaml`, `buf.gen.yaml` (repository root)
- `crates/xtask/src/gate.rs` — a `buf` step in `pr`, `window_tags` (last three minors at their highest patch), and two tests
- `.github/workflows/gate.yml` — installs `buf` 1.61.0 beside actionlint/gitleaks/osv-scanner, and `fetch-depth: 0` so `buf breaking --against .git#branch=main` has a history to compare with (`docs/decisions.md#the-pr-gate-loop-892`)
- `Cargo.toml` — `[workspace.dependencies]` gains `base64, bytes, iroh, prost, prost-build, protox, qrcode, rand, tokio, tracing-subscriber`; `Cargo.lock`. `proptest` was also added here and then dropped at the rebase onto lane D3, which had landed the same key: one entry for the workspace, theirs, and `cargo check --workspace` confirms both lanes' dev-dependencies resolve against it

**`b33addfb` — C.2, protocol.** No iroh type appears in this crate.

- `crates/protocol/Cargo.toml`, `crates/protocol/src/`: `lib.rs`, `alpn.rs`, `error.rs`, `framing.rs`, `handshake.rs`, `session.rs`, `transport.rs`, `version.rs`, `wire.rs`
- `crates/protocol/tests/framing_golden.rs`, `crates/protocol/tests/framing_properties.rs`
- `contracts/protocol/framing-golden.json` — seven named `Envelope` vectors with their `frameBase64`, the three ALPNs with their bytes, the framing caps and the version window
- `contracts/README.md` — the `protocol/` row and its regeneration command

**`4129e69d` — C.3, net.**

- `crates/net/Cargo.toml`, `crates/net/README.md`, `crates/net/src/`: `lib.rs`, `allowlist.rs`, `endpoint.rs`, `error.rs`, `pairing.rs`, `ticket.rs`
- `crates/net/tests/pair_and_stream.rs`
- `crates/api-proto/proto/centraid/core/v1/pair.proto` — `PairTicket.direct_addrs` (D-1020-C15)

**`98a7537e` — C.4, centraid.**

- `crates/centraid/Cargo.toml`, `crates/centraid/README.md`, `crates/centraid/src/main.rs`, `crates/centraid/src/run.rs`
- `crates/centraid/tests/no_listener.rs`

`contracts/README.md`'s index gained the `protocol/` row, merged at the rebase beside lane D3's `apps/tally/` row with one "the rest of the tree" paragraph naming what neither lane landed.

No file owned by lane D1 or D3 was touched: `crates/vault`, `crates/seat`, `crates/apps/**`, `contracts/schema/**` and `contracts/golden/**` are untouched, and `crates/xtask` was edited only for the `buf` step the brief authorises.

### Exit list

| # | Command | Outcome |
|---|---|---|
| 1 | `cargo fmt --all --check` | clean |
| 2 | `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| 3 | `cargo test --workspace` | green, post-rebase — **236 passed, 1 ignored** across the whole workspace. Lane C's own crates: api-proto 9, protocol 40, net 30 (+1 ignored), centraid 10, xtask 26 (2 new) = **115**. The rest is lane A's ontology (32) and lane D3's kit and Tally (89) |
| 4 | `cargo xtask gate --profile local` | PASS, 8.6 s of the 120 s budget on a warm tree. On a **cold** tree the same run was 160.7 s and tripped the budget line — every step green, 131.1 s of it `cargo test`'s first build of the test binaries. Named under *Findings* rather than answered by moving a ledger |
| 5 | `cargo xtask gate --profile pr` | 203.9 s of 900 s post-rebase. Green except `secrets` and `osv`, the two inherited reds — and `secrets` now reports 7 findings rather than 1 (see *Findings*). `release-build` 240.6 s of the 600 s ceiling on a cold `target/release`, 17.9 s warm; `abi-five-symbols` PENDING (no `crates/core-ffi`); `no-listening-socket` scanned 59 files clean; `sql-confinement` scanned 32 clean, 27 of them inside the allowed crates |
| 6 | `buf lint` + `buf breaking` | **real run, not a loud skip.** `buf` 1.61.0 fetched with `curl -sSL https://github.com/bufbuild/buf/releases/download/v1.61.0/buf-Linux-x86_64 -o ~/.local/bin/buf`. Lint clean over both modules (14 files, each once). `buf breaking --against '.git#branch=main,subdir=crates/api-proto/proto'` reports `had no .proto files` — `main` carries no schema yet, so there is nothing there to break; the step classifies that case as a pass whose line says so. `git tag --list 'v*'` is empty, so "0 tags in window" |
| 7 | The pair-and-stream test | `crates/net/tests/pair_and_stream.rs::two_endpoints_pair_and_stream_a_commit`. Its assertion: `assert_eq!(page.rows.len(), 3, "the commit arrived whole")`, with `assert_eq!(page.next, page.watermark)` and the gateway side asserting the seat's returned cursor is `seq = 3` |
| 8 | `cargo run -p centraid -- gateway --data-dir /tmp/x --print-qr` | quoted below |
| 9 | `bun run lint:workflow-pins`, `actionlint` | 25 workflows clean; actionlint clean on `gate.yml` |
| 10 | `bun run format` + `format:check` | "All matched files use the correct format" |
| 11 | `bash .governance/run.sh` | all 10 directives passed |
| 12 | `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5` | 10 rules, no findings |
| 13 | `bun run check:push:static` | 4/4 in 32.2 s (needs `bun run build` once first, as lane A and lane B both recorded) |
| 14 | `git push -u origin claude/1020-laneC` | accepted; no `SKIP_*`, no `--no-verify` |

Item 8, quoted. The binary, then the kernel's own answer:

```
$ ./target/debug/centraid gateway --data-dir /tmp/x --print-qr --no-relay
centraid gateway ready endpoint=1bf9d3f3205b57b5dcee48251628753def61aa76b75d201d7d02e35cb8033afa
ticket CAESIBv50_MgW1e13O5IJRYodT3vYap2t10gHX0C41y4Azr6IhR0a3RfYTc3ZDU4OTIxZDJlN2Q5MioQp31Ykh0ufZKix-hKp8DoHjIIQ2VudHJhaWQ49Mvnpok0Qg8xOTIuMC4yLjI6NTEyMDA
█████████████████████████████████████████████████████████        (29 rows of QR)
(stderr) centraid: --data-dir /tmp/x is accepted and NOT yet durable: the SQLite allowlist lands
         in crates/vault (wave 2 lane D1, D-1020-C8). Every pairing in this run is lost on exit.

$ ls -l /proc/18900/fd | grep socket
lrwx------ 1 root root 64 Sep 12 08:46 10 -> socket:[230700]

$ cat /proc/net/tcp | awk '$4=="0A"{print $2, $10}'
0100007F:B0EF 2092
0100007F:A1A3 51
00000000:07E8 1984
00000000:07E9 1985

$ ss -ltnp | grep -i centraid
(no output)
```

The process owns exactly one socket, inode `230700`, and no LISTEN row names it. `/proc/net/tcp6` does not exist in this container; the test reads both tables and tolerates the absence, and skips loudly where `/proc/net/tcp` itself is missing rather than passing where it cannot look.

### Decisions — lane C

Every ruling in the lane brief (**D-1020-C1** … **D-1020-C11**) was adopted as written. Five refinements and additions, each citing [#1020](https://github.com/srikanth235/centraid/issues/1020):

- **D-1020-C12 — an intent's and a command's `input` are `bytes` carrying canonical JSON, not `Any` and not a message per action** ([#1020](https://github.com/srikanth235/centraid/issues/1020), D-1020-C4 asked for the note). Options: (a) a proto message per action, (b) `google.protobuf.Any`, (c) opaque bytes. (c), for three reasons in order of weight. The input *is* the hash preimage — `intentPayloadHash` hashes the canonical JSON of `{action, appId, input, baseVersions?, dependsOn?}` and the gateway compares in constant time, and protobuf serialisation is explicitly not canonical (map order, default elision, unknown fields all vary by runtime), so a proto body could not carry a payload hash at all. The input schema is per-action and lives in the vault as `agent_command.input_schema_json`, so (a) would put `buf breaking` in the way of adding a command. And opaque bytes cannot be silently re-encoded, which is what holds the unknown-field promise. The cost is that the core validates JSON rather than getting it from the decoder, paid once in `crates/vault`.
- **D-1020-C13 — prost 0.14 does not preserve unknown fields, and the invariant moves to the frame** ([#1020](https://github.com/srikanth235/centraid/issues/1020) Compatibility). Verified rather than assumed: `grep -rn unknown` over the vendored `prost-build-0.14.4/src/` has one hit, a panic message about proto syntax, and `prost-0.14.4/src/` has none; there is no `preserve_unknown_fields` switch and no `unknown_fields` struct member. Options: (a) switch to `prost-reflect`'s dynamic messages at the envelope, (b) hand-roll retention, (c) hold the invariant one layer out. (c): nothing in the v1 plane relays a *decoded* message — `crates/protocol::wire::relay_frame` moves a length prefix and an opaque body — every payload that crosses a version boundary is `bytes`, and an unknown message type is answered with `Unsupported{type_url}`. The residual gap is named: a *field* added in a future release is invisible to this build, and a middlebox that decoded and re-encoded would lose it. `crates/protocol/src/wire.rs::a_relayed_frame_keeps_bytes_this_build_cannot_decode` asserts both halves — the relay keeps them, the decode-and-re-encode path shortens the message — and `crates/api-proto/tests/roundtrip.rs::prost_drops_unknown_fields_...` turns red if prost ever gains the feature, which would be a welcome red.
- **D-1020-C14 — `idle()` closes the endpoint and `resume()` re-binds it** ([#1020](https://github.com/srikanth235/centraid/issues/1020) Network lifecycle; refines D-1020-C10). Options: (a) a flag that only stops our accept loop, (b) close and re-bind, (c) wait for an iroh pause API. (a) leaves the relay connection and its keepalives in place, which is precisely the battery cost the rule exists to remove, so the rule would have been a comment. (c) blocks the phone lane on upstream. (b) is safe because identity is the secret key, not the endpoint object: `Endpoint::id()` is unchanged across a cycle, so every paired seat still recognises the gateway and only the addresses move. A dial while idle is refused rather than silently re-binding — a backgrounded phone that dialled on its own is the thing being prevented.
- **D-1020-C15 — `PairTicket` carries `direct_addrs`** ([#1020](https://github.com/srikanth235/centraid/issues/1020); the ticket shape in D-1020-C4). `RelayMode::Disabled` is a mode the issue names, and with no relay and no address-lookup service an EndpointId alone has nothing to be dialled through, so a LAN-only deployment could not pair at all. Options: (a) require a relay for pairing, (b) a second out-of-band channel for addresses, (c) the addresses in the ticket. (c): they are hints and never authority — iroh's TLS handshake proves the endpoint id, so a tampered address reaches either the right gateway or nothing, which is what makes it safe for a value read off a screen by a camera to carry them. With relays on they save the first round trip and nothing depends on them.
- **D-1020-C16 — the `buf` step treats "the base carries no `.proto` files" as a pass whose line says so** ([#1020](https://github.com/srikanth235/centraid/issues/1020), D-1020-C5). `buf breaking` exits non-zero with `had no .proto files` when the base has no schema, which is this step's answer on the commit that introduces one. Options: (a) fail, which makes the schema's first commit unmergeable, (b) skip the step until `main` has the tree, which is a gate that does not run, (c) classify the case from what buf printed and report a pass that names it. (c), read off the step's own artifact rather than guessed from the tree, and it stops happening the moment `main` carries the schema.

### Demonstrated reds

Every gate this lane added lands with a red it has actually produced.

- **The framing codec's four refusals.** `crates/protocol/tests/framing_properties.rs` drives an eight-row named corpus — a clean end of stream, one/three prefix bytes, a declared length of zero, a prefix with no body, `u32::MAX`, one byte over the 256 KiB ceiling, exactly the ceiling with no body — and each row must produce one of the four framing errors and be fatal to the stream. Plus a proptest over **any** four-byte prefix with up to 64 trailing bytes: never a panic, never a body the prefix did not describe, and the ceiling checked before any allocation (the `u32::MAX` row is the allocation bomb, and it returns in constant memory).
- **The version window, as a table.** `crates/protocol/src/version.rs` pins eight rows including both directions of the asymmetric case, and asserts symmetry exhaustively over `1..6` × `1..6`.
- **`Cancel` refuses a bounded read.** `session.rs::an_unbounded_request_cancels_and_a_bounded_one_refuses` gets `NotCancellable` and asserts the request is still in flight afterwards, so a refused cancel cannot settle it.
- **The ticket's five malformed shapes.** `ticket.rs::every_malformed_ticket_is_refused_rather_than_half_accepted` — unknown format version, a 31-byte endpoint id, no ticket id, no secret, no expiry — plus non-base64url input and well-formed base64url that is not a ticket.
- **An unenrolled peer is closed before a frame is read.** `pair_and_stream.rs::an_unenrolled_peer_is_closed_before_a_frame_is_read` completes a real QUIC handshake, writes a `Hello` frame the gateway must never parse, and asserts the gateway answered `Unauthorized` with no stream accepted and nothing enrolled.
- **An unroutable peer never hangs.** `an_unroutable_peer_fails_typed_inside_the_timeout` measured 2.001 s against a 2 s budget and a typed `Timeout`.
- **A verb that is not built exits 3.** `no_listener.rs::every_unimplemented_verb_exits_three_and_names_its_lane` runs the real binary for six verbs and asserts exit 3, the wave named, and `#1020` cited; `native-host` is checked apart because a browser would otherwise believe it has a working host.
- **The xtask `buf` step's own red.** `gate.rs::the_buf_step_skips_loudly_before_the_schema_lands` asserts the loud skip, and `the_window_is_three_minors_at_their_highest_patch` builds a throwaway git repository with eight tags (including a prerelease and a malformed one) and pins the three the step checks against.
- **The framing fixture is regenerate-and-diff.** `the_committed_fixture_is_what_this_build_produces` fails with both documents printed when the committed bytes and the build disagree; `CENTRAID_UPDATE_FIXTURES=1` writes and the comparison still runs, so the variable is a generator and not a way to go green.

### Findings outside the slice

- **`gitleaks` now reports 7 findings, not 1, and 6 of them are untracked build output.** `packages/model-runtime/LICENSES.md` is the inherited red (D-1020-B1). The six new ones are `target/{debug,release}/deps/lib{pem_rfc7468,pkcs8}-*.rmeta`, matched by the `private-key` rule: iroh's graph pulls `pem-rfc7468` and `pkcs8`, whose documentation carries PEM private-key examples, and those doc strings land in the crates' `.rmeta`. The count scales with how many profiles have been built, which is on its own enough to show it is an artifact and not content. The step runs `gitleaks detect --source . --no-git`, which ignores `.gitignore`, and `/target/` is line 78 of it. **Not fixed from here**: `.gitleaks.toml` is an allowlist and `crates/xtask/src/gate.rs`'s `secrets` step is not this lane's to change beyond the `buf` wiring. It will red in CI too, because `gate.yml` restores `target/` from the cargo cache. Owner hand-off 1 below.
- **`cargo xtask gate --profile local` trips its 120 s budget on a cold tree.** 160.7 s post-rebase, of which `cargo test --workspace` was 131.1 s building test binaries for the first time; the same run on a warm tree is 8.6 s. Every step was green in both. The budget is the edit-run loop's promise and a warm tree is what that loop runs on, so nothing was moved — the number is recorded here rather than absorbed into `contracts/ledgers/gate-budgets.json`, which is lane B's down-only ledger. Owner hand-off 2.
- `cargo deny --all-features check` passes over iroh's whole graph with `deny.toml` **unchanged**: no licence exception was needed, and nothing was added to `[bans].skip` or `[advisories].ignore`.
- `crates/xtask`'s `ts-static` step no longer skips: `contracts/tools/export-v0-registries.ts` is TypeScript inside the v1 tree, so the step runs `bun run check:push:static` for real. That is correct behaviour and worth naming, because it means the v1 gate now depends on `bun run build` having run, which lane A and lane B both recorded one gate further out.
- The seat lane in `centraid gateway` admits an enrolled device and then logs that the replica plane lands in lane D2. That is the honest answer while there is no log to serve, and it is the seam lane D2 picks up: `Endpoint::accept` already hands back the `Device` its authority decisions need.

### Owner hand-offs

1. **`.gitleaks.toml` (or the `secrets` step) should stop scanning `target/`.** Recommendation: add `target/` to `[allowlist].paths`, or pass `--exclude-path`. It is untracked build output and cannot be a commit surface, so excluding it removes four false positives without weakening what the gate covers. Not done here because it is an allowlist and not this lane's file. The `LICENSES.md` finding stays the owner's call, as lane B recorded.
2. **`local`'s 120 s budget against a cold `cargo test`.** Either the budget's definition names a warm tree, or the profile's `test` step gets `cargo nextest` and a prebuilt target. Both are lane B's ledger and lane G's CI; recorded here with the measurement.
3. **The relay-only case has no runner.** `a_relay_only_pair_and_stream` is written and `#[ignore]`d with its reason: it needs egress to a relay and two networks, and this container has one namespace and proxy-only egress. It runs under `cargo test -- --ignored` on a runner with real egress, and the `nightly` profile has no `--ignored` leg today. Wave 3 lane G's VPS smoke is the proof that counts.

### Doctrine digest

Law `53be88c22ab5`, verified with `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5` — 10 rules, no findings. The law did not move under this lane's work; no waiver was spent; no v0 file was edited, so no fixture-adapter change is owed a line here.

### Falsification

The two riskiest claims in this diff, the throwaway check run against each, and the result.

**"`crates/protocol` is transport-generic — no iroh type appears in it."** The claim is load-bearing because #1020 makes deterministic simulation the primary sync proof, and a protocol that names iroh cannot be simulated. Reading the imports is not a check: a type could arrive through a re-export. So: `cargo tree -p centraid-protocol -e normal` — the crate's normal dependency closure is `centraid-api-proto`, `prost`, `thiserror`, `tokio`, `tracing` and their transitives, and `iroh` appears nowhere in it. Then the stronger version, an actual compile: temporarily added `iroh = { workspace = true }` to `crates/protocol/Cargo.toml` and `use iroh::Endpoint;` to `src/lib.rs`, confirmed it compiled (so the crate *could* have taken the dependency and the absence is a choice, not an accident), and reverted both. The second implementation of the trait in `src/transport.rs::duplex` is what keeps the claim true going forward: the seam is not tested by mocking iroh, it is tested by there being another implementor, and `the_protocol_runs_over_a_transport_that_is_not_iroh` runs the framing over it.

**"`centraid gateway` opens no listening TCP socket."** The risk is that the xtask rule only greps for `TcpListener::bind` in *this repository's* source, and iroh's graph is 200-odd crates any one of which could listen. A source scan cannot see that. So the check reads the kernel: spawn the real binary, wait for its ready line, collect every socket inode from `/proc/<pid>/fd`, collect every `st == 0A` row from `/proc/net/tcp*`, and intersect. Result: one socket owned (inode `230700`, the UDP socket iroh bound), four LISTEN rows on the host (`2092`, `51`, `1984`, `1985`), empty intersection; `ss -ltnp` names no centraid process. The test also asserts the process owns **at least one** socket, so it cannot pass vacuously against a gateway that failed to bind at all — which is the way this test would otherwise have gone quietly green.

## Wave 2 — lane D1: `crates/vault`, the authority's file

The umbrella's centre. Everything durable a gateway knows is in one SQLite file, and everything that writes to it goes through `Vault::commit`.

### What landed, by commit

**`db67602b` — `build(deps): rusqlite 0.40 with session, hooks and functions`**

- `Cargo.toml`, `Cargo.lock` — the workspace bump. Own commit because the workspace shares the dependency; `cargo test --workspace` was green before and after.

**`fc34e93c` — `feat(contracts): the v1 baseline corpus, frozen at the ladder head`**

- `packages/vault/tests/golden/issue-1020/{vault.db.gz,manifest.json}` — **the one permitted v0-tree edit in this lane**, and it is the permitted kind: a corpus cut by v0's own freezer (`bun run golden-vault:freeze -- --label issue-1020`). No v0 source file was touched.
- `contracts/golden/issue-1020/{vault.db.gz,manifest.json}` — byte-identical copies.
- `contracts/schema/vault-ddl.sql` — regenerated from the new corpus. 1,053 objects → 761: the 292 that leave are `replica_change`, its four indexes and the 287 `trg_replica_*_a{i,u,d}` triggers that #1014 R-1014-1 retired. One baseline, not two.
- `contracts/schema/v0-registries.json`, `contracts/tools/export-v0-registries.ts` — `replicatedTables` (109 names) and `replicaConstants` (10 numbers, the local-table list, the JSON-key exclusions).
- `crates/ontology/src/{golden,registries,ddl}.rs`, `src/bin/export-ddl.rs`, `tests/{fixtures,golden_vault}.rs`, `README.md` — the ontology crate's small change: `GOLDEN_LABEL` is now the v1 baseline and `GOLDEN_LABEL_CHECKPOINT` the #929 one, `is_replicated_table` lands, and `version_window::both_ends_of_the_window_open` reads **two real v0 files** instead of stamping a version onto one copy — which wave 1's own doc comment said was owed to this lane.
- `contracts/README.md` — the two corpora and their roles.

**`ec544c24` — `feat(vault): the v1 vault crate — file, log plane, registry, tally stubs`** (the commit the root merged early for lanes D3 and R)

- `crates/vault/Cargo.toml`, `src/lib.rs`, `src/bin/export-baseline.rs`
- `src/error.rs` — `VaultError`, `RebootstrapReason` (v0's closed 5-value vocabulary at the log door), `IntentRefusal`.
- `src/value.rs` — `Value`, `RowImage`, the log's JSON in v0's spelling.
- `src/clock.rs` — `Clock`, `FixedClock`, `Ids`, `SeededIds`, the ISO-millisecond conversion.
- `src/migrations.rs`, `contracts/migrations/001_baseline.sql` — the ladder, the baseline, `seed_entity_kinds`.
- `src/file.rs` — `Vault::create`/`open`/`read`, the `query_only` read path.
- `src/log/{mod,capture,store,guard,door,apply}.rs` — the plane.
- `src/snapshot.rs` — the seven-step pipeline, `Fault`, `SnapshotHead`.
- `src/access.rs` — `Principal`, `Verb`, `evaluate_access`, the clamp intersection.
- `src/commands/{mod,core,tally}.rs` — `Registry`, the gate order, the three real commands, the 23 stubs.
- `src/audit.rs`, `src/intents.rs`, `src/devices.rs`, `src/page.rs`, `src/bootstrap.rs`.

**`67334747` — `test(vault): the log plane, the doors, and the three applier gates`**

- `contracts/applier/{README.md,oracle.json,convergence.json,atomicity.json}`, `contracts/tools/export-applier-oracle.ts`
- `crates/vault/tests/{common/mod,baseline,log_plane,doors,gates}.rs`
- `crates/vault/src/{migrations,file,clock}.rs` — `seed_entity_kinds` and its call site; `Clock`/`Ids` for `Arc`, so a test can hold the clock it gave the vault.

**`f04507fe` — `test(vault): the snapshot pipeline, its fault points and disk full`**

- `crates/vault/tests/{snapshot_faults,disk_full}.rs`
- `crates/vault/src/error.rs` — `From<rusqlite::Error>` classifies `DiskFull` unconditionally.
- `crates/vault/src/snapshot.rs` — `Fault::CopyTo`.

**`55ad2a5b` — `test(vault): the command plane end to end, and three properties`**

- `crates/vault/tests/{commands,properties}.rs`
- `Cargo.toml` — `serde_json`'s `float_roundtrip`.

**this commit** — `crates/vault/README.md` and this receipt section.

### Exit list

| # | Command | Outcome |
| --- | --- | --- |
| 1 | `cargo fmt --all --check` | clean |
| 2 | `cargo clippy --workspace --all-targets -- -D warnings` | clean; no `#[allow]` added to the library, one `#![allow(dead_code)]` on `tests/common/mod.rs` with its reason (each integration test is its own binary and compiles the whole module) |
| 3 | `cargo test --workspace` | **269 passed, 0 failed.** `centraid-vault` **122**: lib 59, `baseline` 6, `commands` 15, `disk_full` 2, `doors` 13, `gates` 4, `log_plane` 13, `properties` 3, `snapshot_faults` 7. Also `centraid-ontology` 34 (lib 11 + 9 + 5 + 9), `centraid-apps-kit` 59, `centraid-apps-tally` 30, `xtask` 24 |
| 4 | `cargo xtask gate --profile local` | every step **PASS**; `sql-confinement` scanned this crate and reports clean. **The 120 s budget is now exceeded** — 134.2 s on the rebase onto lane C, of which `test` is 108.4 s. On the rebase onto lane D3 alone it was 23.8 s of 120 s. `cargo test -p centraid-vault` is **17.1 s** of the 108.4 s; the rest of the workspace is the other 91 s. See the finding and the hand-off below — the budget is a down-only ledger and this lane did not touch it |
| 5 | `cargo xtask gate --profile pr` | **FAIL on exactly the two named inherited reds** — `secrets` (gitleaks, `packages/model-runtime/LICENSES.md:generic-api-key:8`) and `osv` (`astro@7.1.5`). Every other step green: fmt, clippy, test, rules, ledgers, `deny`, `ci-policy`, `release-build` 96.8s of 600s, `ts-static`. 163.9s of 900s |
| 6 | `bunx vitest run packages/vault/src/golden-vault.test.ts` | **9 passed** — `issue-1020` and `issue-929` both green in v0, four assertions each |
| 7 | `sha256sum` of both `issue-1020` copies | equal. `vault.db.gz` `07559187…afca00b3`, `manifest.json` `6d49f85c…85f14644` |
| 8 | `bun contracts/tools/export-v0-registries.ts && bun run format && git diff --exit-code contracts/schema` | clean |
| 9 | `node --experimental-strip-types contracts/tools/export-applier-oracle.ts && bun run format && git diff --exit-code contracts/applier` | clean. **`node`, not `bun`** — see D-1020-D1-16 |
| 10 | the gate, fault and disk-full tests | below |
| 11 | `cargo install cargo-mutants` | installed in **93 s**. First run on `crates/vault/src/value.rs`, 61 mutants, 51 reached before the lane's budget ran out: **43 caught, 3 missed, 5 unviable**. The three survivors are below |
| 12 | `bun run format` / `format:check`; `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5`; `bash .governance/run.sh`; `bun run check:push:static` | all clean / 4-of-4 |

**Item 10 — the named tests and their assertion lines.**

| Test | The assertion |
| --- | --- |
| `gates::oracle_the_rust_log_produces_the_rows_v0_produced` | every one of v0's 10 rows equal on commit index, table, op, pk, row, prior, `indirect`, `local`, `deferred` and producer; plus "the fixture carries an update with a prior, a delete, a local row and an indirect row" so it cannot go vacuous |
| `gates::convergence_a_copy_fed_the_log_equals_the_gateway_at_the_watermark` | `findings.join("\n") == ""` over **109 replicated tables**, row for row, value for value; 5 applied commits; the copy is the real snapshot artifact, not a file copy |
| `gates::atomicity_a_crash_mid_batch_is_completed_and_a_duplicate_lands_once` | three cases, each asserting the row set, `atom-a`'s value and that the cursor never went back |
| `gates::freezing_the_baseline_corpus_from_rust_reproduces_v0s_manifest` | lane A's suggestion: 16 tables, every column set, row count and per-row digest |
| `snapshot_faults::an_interrupted_build_leaves_no_artifact_and_the_next_one_succeeds` | for each of 8 fault points: no `.db.gz` outside `.building`, the live file unchanged in size, its private table still 1 row; then the canary still in the live vault's bytes, and the 9th attempt produces a sanitised artifact |
| `snapshot_faults::the_private_canary_is_absent_from_the_files_bytes` | present in the live vault's raw bytes, absent from the artifact gzipped **and** inflated |
| `snapshot_faults::no_private_table_and_no_trigger_except_fts_sync_survive` | all 28 private tables gone; every surviving trigger names an FTS table; no `_touch_updated_at`; 18 FTS shadow `_data` tables kept |
| `snapshot_faults::the_log_is_truncated_its_cursor_is_kept_and_the_numbers_come_from_the_copy` | `replica_log` 0 rows, `floor_seq == watermark`, `active_commit_id` NULL, and the head's epoch/seq/schema-epoch/vault-id equal the live state's |
| `snapshot_faults::the_artifact_is_content_addressed_…` | two builds at one position produce the same name **and the same bytes** |
| `disk_full::a_full_disk_at_the_log_insert_rolls_the_whole_commit_back` | `error.is_disk_full()`; `commit_seq` equals `COUNT(DISTINCT commit_seq)` in the log; **0 orphan rows** (no `core_party` row without its log row); and the next commit after the cap lifts writes 2 rows, not 20 — the sessions were abandoned |
| `disk_full::a_full_disk_during_a_snapshot_build_leaves_no_partial_artifact` | `is_disk_full()`, the snapshot directory **empty** (`.building` files cleared too), the live vault's private table intact, and the retry builds |

**Item 11 — the first `cargo mutants` run.** `--file crates/vault/src/value.rs`, 61 mutants, 51 reached in the lane's budget: **43 caught, 3 missed, 5 unviable** (the five are `Default::default()` substitutions on functions whose return type has no `Default`). The three survivors, judged:

| Survivor | Verdict |
| --- | --- |
| `value.rs:262 replace < with <=` in `json_string` — the control-character boundary | **REAL.** A space would be escaped as `\u0020`, which is valid JSON that parses back to a space, so no round-trip test can see it. It is caught by nothing here and by the ORACLE fixture only if a v0 row's text holds a space in a redacted image. Named as owed rather than patched: the gate that would catch it is byte-equality against v0's `row_json` for a text value, which is the next wave's ORACLE widening. |
| `value.rs:283 replace \| with ^` in `to_base64` | **EQUIVALENT MUTANT.** `((a & 3) << 4) \| (b >> 4)` combines disjoint bit ranges, so `\|` and `^` compute the same value for every input. Not a test gap. |
| `value.rs:286 replace \| with ^` in `to_base64` | **EQUIVALENT MUTANT**, same reason. |

The umbrella's "no survivors" is judged at lane D2's close; this is the number, not a verdict.

### Decisions — lane D1

Every one cites [#1020](https://github.com/srikanth235/centraid/issues/1020) and follows **R-1020-34**: options, recommendation, adopted.

- **D-1020-D1-1 — v1's baseline is v0's current shape.** As briefed: re-cut with v0's own freezer at the ladder head, copied byte-identically to `contracts/`, and `vault-ddl.sql` regenerated from it. The old rung-7 rendering is replaced, not kept beside — one baseline.
- **D-1020-D1-2 — v1 files carry `application_id = 0x43454E31` and a `user_version` counting v1's OWN migrations.** As briefed. `crates/ontology`'s 7..11 window is a different question and stays: it is about reading two frozen **v0** files.
- **D-1020-D1-3 — one session per replicated table, and `table_filter` stays unused.** `rusqlite` DOES expose it, which the brief flagged. Options: (a) one filtered session, ~1 ms cheaper per commit; (b) one per table. **Adopted (b)**, for a reason stronger than caution: `node:sqlite` accepted the same filter and silently ignored it, and the failure mode is a private table's rows reaching every seat, invisible until someone reads a log. A table that was never attached produces *no changes at all*, so the failure is "no rows", which a test sees. A filter that is honoured is indistinguishable from one that is ignored until it matters.
- **D-1020-D1-4 — the file's own row images stay v0's JSON spelling.** The ORACLE fixture compares Rust's rows against v0's value for value; a differently-spelled image would make every row a finding for a difference that is not one. Number spelling is borrowed from `centraid_ontology::jsvalue::js_number_to_string` rather than re-derived: a REAL `1.0` is JSON `1`, and Rust's own formatting prints `1.0`.
- **D-1020-D1-5 — the commit pair is the only writable connection, and `Vault::read` holds `PRAGMA query_only`.** As briefed, plus the `query_only` half, which turns "no caller writes through a read" into "SQLite refuses it". The grep: the only `pub fn connection()` in the crate are `CommitTx::connection` (`src/log/guard.rs:54`) and `CommandCtx::connection` (`src/commands/mod.rs:116`, which delegates to it); `Vault::connection` is `pub(crate)` (`src/file.rs:239`).
- **D-1020-D1-6 — doors are functions.** As briefed.
- **D-1020-D1-7 — one content-addressed snapshot, three uses.** As briefed; `Fault` is a runtime enum on the shipped builder rather than a `#[cfg(test)]` hook, because a gate that only exists in test builds proves nothing about the shipped one.
- **D-1020-D1-8 — `DiskFull` is typed, and classified in `From<rusqlite::Error>`.** The brief put the classification in a helper. Options: (a) a helper each call site calls; (b) the `From` impl. **Adopted (b)** — the first run of the disk-full test showed why: the error arrived through a handler's own `?`, not through the log plane's helper, and came out as a generic `Sqlite`. A classification a call site can forget is a classification the product renders wrong.
- **D-1020-D1-9 — authority and the command plane.** As briefed. `AllowlistStore` is `crates/vault::devices` with the method set `enrol` / `revoke` / `is_device_enrolled` / `live_devices`, because `crates/net` was not on the umbrella at this lane's rebase; lane C's trait is implemented over it in one block.
- **D-1020-D1-10 — the paged door's vault-side hook.** `Vault::page_raw`, `page::and_row_filters`, `page::apply_field_mask`. The interface agreed with D3: **the kit builds the statement text and the binds and calls `and_row_filters` with the decision it got from `evaluate_access`; the vault never sees a `PageQuery` and the kit never sees a `Connection`.** D3's crate landed first and its grammar matches this shape.
- **D-1020-D1-11 — the three gates as `contracts/` fixtures.** As briefed.
- **D-1020-D1-12 — `replicatedTables` and `replicaConstants` in the registry fixture.** As briefed, with one wrinkle: `REPLICATED_TABLE_NAMES` is **not exported** by `private-tables.ts` and the v0 tree is pinned, so adding an `export` was not available. Options: (a) re-type the 109 names in Rust; (b) derive them from a fresh vault's tables ∩ `isReplicatedTable`, which only yields the names a vault happens to carry; (c) read the array literal out of the source text and put every parsed name back through the exported `isReplicatedTable`. **Adopted (c)**: it transcribes rather than re-types, and a mis-parse fails loudly in the generator (the predicate is the oracle, plus a "well over a hundred" floor) rather than shipping a short allow-list.
- **D-1020-D1-13 — the baseline migration and its `contracts/` fixture are ONE file.** The brief asked for `crates/vault/src/migrations/NNN_*.sql` *and* a fixture under `contracts/migrations/`. Options: (a) two copies with a test that diffs them; (b) one file under `contracts/`, reached by `include_str!`. **Adopted (b)**: two copies of a 6,460-line DDL is two answers to one question, and a diff test is a gate against a problem that need not exist. `bin/export-baseline` generates it and `tests/baseline.rs` founds a vault from it and diffs against the corpus.
- **D-1020-D1-14 — `core.add_party` refuses a reach scheme by name rather than dropping it.** v0's input schema admits `email` and `tel`; v0 routes those to `social.save_contact_channel` and `core_party_identifier`'s own CHECK refuses them. The contact-reach plane is the People lane's. Options: (a) accept and silently ignore them; (b) accept and bind them anyway (the CHECK refuses, so the whole command fails with a constraint error); (c) refuse with a sentence naming the command that takes them. **Adopted (c)** — a dropped identifier means the app believes it bound an email and nothing did.
- **D-1020-D1-15 — `core_entity_kind` is DERIVED from the DDL, not transcribed.** A fresh v1 file needs the registry `core_entity.entity_type` keys into, and the baseline is schema only. Options: (a) transcribe the 52 names into Rust; (b) export them into `v0-registries.json`; (c) derive them — an entity kind is exactly a logical name whose table declares `FOREIGN KEY (<pk>) REFERENCES core_entity(entity_id)`. **Adopted (c)**: the schema already answers the question, and `tests/baseline.rs` holds the derivation to v0's own 52 names in both directions. A transcribed list's drift shows up as a foreign-key failure on one app's first insert, months later.
- **D-1020-D1-16 — `export-applier-oracle.ts` runs under `node --experimental-strip-types`, not `bun`.** Not a preference: v0's vault package is built on `node:sqlite`, which Bun does not provide (`error: No such built-in module: node:sqlite`) — the same reason v0's own freezer is `node scripts/golden-vault/build.mjs`. Types are stripped, so there is no build step. The exit list's item 9 command is amended accordingly.
- **D-1020-D1-17 — a snapshot build cannot exhaust SQLite pages, so the disk-full test aims at the copy's file write.** The brief proposed capping the copy's `max_page_count`. Measured, that cannot work: every step after the copy only ever *frees* pages (drops, a truncation, a VACUUM), and SQLite clamps `max_page_count` **up** to the current size, so a cap has nothing to refuse — verified against the real baseline schema. Options: (a) drop the snapshot disk-full test and rely on the fault loop; (b) a privileged tiny `tmpfs`, which no CI runner should need; (c) redirect the copy to `/dev/full`, which accepts an open and fails every write with ENOSPC, so SQLite reports a genuine `SQLITE_FULL` (code 13, `database or disk is full` — verified). **Adopted (c)**: privilege-free, deterministic, and the same error code the log-insert test reaches by a different route.
- **D-1020-D1-18 — `serde_json`'s `float_roundtrip` feature is on.** Found by `properties::a_row_image_round_trips_through_the_logs_json`: the default parser is fast and approximate and landed one ULP away (`1.2240809751959867e163` came back as `…868e163`). A log row's images are re-parsed on every apply, so a drifting REAL is a seat whose latitude, or exchange rate, is quietly not the gateway's.

### Demonstrated reds

Every user-facing gate here was watched to fail before it was trusted.

| Gate | Demonstrated red |
| --- | --- |
| ORACLE | the fixture's `prior` for `update-one-column` had `updated_at` removed → `row 2 (update-one-column) prior: v0 {…}, us {…,"updated_at":…}`; restored, green. Then the CODE was broken (`prior_delta` reading `new_value` instead of `old_value`) → three rows differ, naming each |
| CONVERGENCE | the applier was made to skip deletes — the classic insert-only mirror → `` `core_entity`: 7 row(s) on the gateway, 8 on the seat `` and `` `core_party`: 4 … 5 ``, with `conv-b` named on the seat side |
| The interrupted build | each of the 8 fault points is itself the red: `build_snapshot` returns `Err` and the test asserts nothing was published. Without the scratch-file clear, attempt 9 fails on `VACUUM INTO`'s refusal of an existing destination |
| Disk full at the log insert | first run reported `Sqlite(SqliteFailure(DiskFull))` rather than `VaultError::DiskFull` — which is what moved the classification into the `From` impl (D-1020-D1-8) |
| Disk full at the snapshot | first run with a capped copy **succeeded**, which is what established D-1020-D1-17 |
| The FTS sync triggers | the first `export-baseline` excluded shadow objects by name and produced 211 triggers instead of 268 — all 57 FTS sync triggers, because `fts_<table>_ai` starts with the virtual table's name exactly as a shadow table does. `tests/baseline.rs::the_fifty_seven_fts_sync_triggers_survive_the_baseline` is that red as a gate |
| `Value::Integer(i64::MIN)` | `attempt to negate with overflow` in `to_wire_json` — `abs()` on `i64::MIN`. Now `unsigned_abs` |
| The read connection | `a_read_connection_refuses_a_write` first failed with `table core_concept has no column named label`, proving the statement never reached the `query_only` check; rewritten to a statement that prepares |
| The float round trip | `1.2240809751959867e163` → `…868e163`, which is D-1020-D1-18 |

### Findings outside the slice

1. **v0 cannot capture a row holding an INTEGER above 2^53, and the `{i}` encoding exists for exactly that value.** `decodeChangeset`'s read-back statement (`packages/vault/src/replica/log.ts:409-415`) never calls `setReadBigInts(true)`, so `node:sqlite` throws `ERR_OUT_OF_RANGE` — `Value is too large to be represented as a JavaScript number` — and the **whole commit rolls back**. Minimal repro, five lines, confirmed: a plain `SELECT … WHERE id = ?` over a column holding `9007199254740993n` throws, and the same statement with `setReadBigInts(true)` returns it. So `row-json.ts`'s own contract — "`{i}` is a decimal-text 64-bit integer, and a vault that stores byte counts and epoch-nanosecond timestamps reaches that" — describes a value v0's producer can never emit. It is why the ORACLE script stops at `Number.MAX_SAFE_INTEGER`; v1 has no such limit and `log_plane::a_blob_and_a_wide_integer_survive_the_round_trip_through_the_log` proves it.
2. **`crates/xtask`'s `fixture_dir` is not unique per process, so two concurrent `cargo test` runs of `-p xtask` race.** `crates/xtask/src/testing.rs:12-17` builds `temp_dir()/centraid-xtask-<name>` and `remove_dir_all`s it; one run deletes the tree another just wrote. Seen once: `rules::tests::a_platform_import_in_commonmain_is_caught` reported 0 findings inside `cargo xtask gate --profile local`, and passed on its own and on the next gate run. A process id or a counter in the name fixes it. Lane B's file, so reported rather than changed.
3. **`primaryKeyValues` and `primaryKeyOf` disagree about key order when a table's declared PK order differs from its column order.** `packages/vault/src/replica/log.ts:285-294` reads the primary-key flags in COLUMN index order for `pk_json`; `:200-215` sorts by the `pk` index for the read-back's `WHERE`. No table in today's schema declares them differently, so nothing is broken now — but the two are bound positionally, and the first table that does gets its read-back bound with transposed key values. v1 uses column order for **both**, so the two cannot disagree.
4. **`isFtsSyncTrigger` matches the whole `sqlite_master.sql`, name included, not the body its comment claims.** `packages/vault/src/replica/seat-snapshot.ts:66-73` says "matching on the NAME would be matching on a convention; matching on the body is matching on what the trigger does", and the regex runs over the whole statement — so a trigger merely *named* `fts_…` is kept whatever it does. Safe in practice (nothing but an FTS sync trigger is named that way) and a wider match than the comment states. v1 reproduces the behaviour, with the discrepancy recorded in `snapshot.rs`'s test.
5. **`replica_intent_outcome`'s `answered_versions` and `waiting_on` have no writer in this lane's port.** The parked plane and the offline chain are `crates/seat`'s (D2); the ledger here writes status, invocation, commit position and expiry. Named so D2 does not assume they are handled.
6. **`enrich_policy`'s two default rows (`photos`/`gateway`, `docs`/`gateway`) are in the corpus and are not seeded by `Vault::create`.** No foreign key depends on them, so a v1 file is sound without them; they are a product default and belong with the enrich lane. Named so nobody discovers it as a missing row.
7. **`cargo mutants` cannot run against a crate that builds the bundled SQLite amalgamation without `--in-place`.** Its default strategy copies the tree to `/tmp/cargo-mutants-….tmp` and `libsqlite3-sys`' build script then fails there — `error occurred in cc-rs: command did not execute successfully … "-c" "sqlite3/sqlite3.c"` — so it reports `cargo build failed in an unmutated tree, so no mutants were tested` and tests nothing. `--in-place` works (and is what produced item 11's numbers) but is incompatible with `--jobs`, so it is single-threaded. The umbrella's "no survivors" criterion needs one of: `--in-place` in the gate, a `CARGO_TARGET_DIR` that survives the copy, or a system libsqlite3 for the mutation run. Named for lane B and for lane D2's close.

8. **`cargo xtask gate --profile local` now exceeds its 120 s budget: 134.2 s, with `test` at 108.4 s.** Measured on this lane's rebase onto lane C's head; the same gate was 23.8 s of 120 s on the rebase onto lane D3's head an hour earlier, so the step grew with lane C's crates, not with this one — `cargo test -p centraid-vault` is 17.1 s of the 108.4 s and the rest of the workspace is the other 91 s. The budget is a down-only ledger entry (`contracts/ledgers/gate-budgets.json`) and this lane did not touch it. The gate's own message is the right diagnosis: either a step got slower or the profile grew a step it should not carry. See the hand-off.

### Owner hand-offs

1. **Finding 1 is a live data-loss path in v0, not a cosmetic gap.** Any commit that writes a byte count, an epoch-nanosecond timestamp or any INTEGER above 2^53 into a replicated table throws at capture and rolls the whole commit back — so the member's write is *refused*, silently, with a `RangeError` in the gateway's log. Options: (a) leave it, since v1 fixes it and no shipped surface is known to write such a value; (b) a one-line `setReadBigInts(true)` on the read-back statement, taken as a permitted oracle edit; (c) ship it as a known issue. **Recommendation: (b)** — one line, and the failure mode is a refused write rather than a wrong number, which is the kind of bug members report as "it just doesn't save". Outside this lane's file set, so it needs the owner's word.
2. **The `local` profile's budget needs a ruling, not a bump.** `local` is the product's edit-run-loop promise (2 minutes, #1020 Tooling coverage) and `cargo test --workspace` has grown past it as wave 2's crates landed — it will grow again with every app. Options: (a) raise the ledger number, which is the one thing the repo's own rules forbid; (b) `local` runs `cargo test` for the **changed** crates only and `pr` keeps the workspace run, which is what "incremental `cargo nextest` for one crate" in the issue's compile-time budgets already anticipates; (c) `cargo nextest` for its parallelism, which the issue also names. **Recommendation: (b), then (c) if it is still over** — a profile that promises a fast loop has to be scoped to what changed, and the workspace run is exactly what `pr` is for. Not this lane's file (`crates/xtask/src/gate.rs` is lane B's) and not this lane's number to move.

3. **The `tally.*` stubs are registered with schemas transcribed from the census table, not from v0's `inputSchema` objects.** Where the census names a key without a type (`splits`, `payers`, `line_items`, `member_ids`, `split_params`, `override`) the schema admits any JSON, because narrowing it here would be inventing the shape from the key's name. Lane D3 or wave 4 should replace each stub's schema with v0's own when it fills the body. Flagged rather than decided because it is their call which fidelity they want.

### Doctrine digest

Law `53be88c22ab5`, stamped. `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5` — no findings. `bash .governance/run.sh` — all directives pass. No waiver spent. No law path touched (`.governance/**`, `CONSTITUTION.md`, `scripts/ci/gate-classes.json`, `tests/*.json`, `oxlint.config.ts`, `oxfmt.config.ts`, `.github/CODEOWNERS` — none in the diff); no gate, budget, ledger or allowlist weakened. The only edit inside the pinned v0 tree is the new corpus under `packages/vault/tests/golden/issue-1020/`, cut by v0's own freezer — no v0 source file was changed, and `REPLICATED_TABLE_NAMES` is read out of `private-tables.ts` as text precisely so that no `export` had to be added to it.

### Not done, and why

- **Process death between commit and ack, and restore-with-seats, are not here.** The brief assigns them to D2 and R. The mechanisms they need — `replica_invocation_commit` with `journal_finalized_at`, and the epoch bump with `reason = "backup-restore"` — are both in place and tested from the vault side (`doors::an_epoch_bump_derives_the_floor_from_the_log_and_invalidates_every_cursor`).
- **The feed (wake) page is not ported.** `readReplicaLogPage`'s logical-entity vocabulary, canonical row ids and *second, incompatible* filter-JSON encoding (`{i}` as bare decimal text, a BLOB as `null`) belong with the change stream, which is D3's `changes.rs` and the ABI's event plane. Porting the seat door's encoding and reusing it for the feed is census seam 2's named trap, so the feed is deliberately absent rather than half-present.
- **`ddl` log rows are written by nothing.** `apply_log_page` applies them and `LogOp::Ddl` exists, but no producer emits one: an ext band's mid-transaction DDL is D3's `alterExtTable` twin, and `CommitTx::watch_table` is the hook it will call.
- **The snapshot door's HTTP surface** — the strong ETag, `If-None-Match`, single-range `Range`, the `?seq=` pin, the two-artifact cache with its in-flight refcount — is lane C's and R's. The builder, the content-addressed name and the head are here; `SnapshotHead.name` carries the seq in the clear precisely so eviction can read it back out of the name.
- **`AllowlistStore` is not an `impl Trait`.** `crates/net` was not on the umbrella at this lane's rebase (D3 landed, C had not). The method set is in `crates/vault::devices` and the trait is one block away.
- **The 171 other commands.** Three are the proof of the gate order; a fourth of the same shape adds no evidence about it.
- **`cargo mutants` has no verdict here.** Installed in 93 s and launched over two of the riskiest files; the umbrella judges survivors at D2's close, so the number is a finding and not a gate.

### Falsification

The two riskiest claims in this diff, the throwaway check run against each, and the result.

1. **"The ORACLE gate compares the decode, so a port that disagrees with v0 about a row image is caught."** The risk is a comparison that is structurally satisfied — same row count, same tables — while the part that matters goes unchecked. Two checks. First, the fixture was edited: one `prior`'s `updated_at` key removed. **Result: caught**, with `row 2 (update-one-column) prior: v0 …, us …` naming the row, the commit label and both sides. Second, and the real test, the **code** was broken: `prior_delta` was changed to read `new_value` instead of `old_value`, which is the single most plausible port slip in the whole plane (both are `Option`, both are indexed the same way, and a delta built from the new image looks superficially reasonable). **Result: caught**, three rows differing, each naming its commit. A third attempt is worth recording because it did *not* fail: filling untouched columns from the new image was a **no-op**, because an UPDATE's new record omits untouched columns exactly as its old record does — which is itself a fact about the format the test now documents rather than a hole in the gate.

2. **"CONVERGENCE compares every replicated table, so a mirror that diverges anywhere is caught."** The risk is that the comparison walks a list that is shorter than it looks — a named-tables list, or only the tables the script touched. Check: the applier was broken to skip `delete` rows while still advancing its cursor, which is the classic insert-only mirror and the exact bug `INSERT OR REPLACE` versus `ON CONFLICT` is also about. **Result: caught**, `` `core_entity`: 7 row(s) on the gateway, 8 on the seat `` and `` `core_party`: 4 … 5 ``, with the surviving `conv-b` visible in the printed seat side. And the comparison is held to its own breadth by `assert!(compared > 100)` — it reports 109 tables compared, not the 4 the fixture names — so a future narrowing of the walk is a red rather than a quieter pass. Both breaks were reverted; `cargo test --workspace` is 269 green.

A third, cheaper one worth recording: the claim that **the baseline migration reproduces the corpus exactly** is not an inspection, it is `tests/baseline.rs` founding a file and diffing 761 `sqlite_master` objects by `(type, name)` **and by SQL text**, in both directions, with `assert!(expected.len() > 700)` so two empty schemas cannot compare equal. The answer to "what is excluded from the comparison" is *nothing*: the three classes the generator omits — 90 FTS shadow tables, `sqlite_sequence`, and every `sqlite_autoindex_*` — are all back in the founded file because SQLite creates each of them itself, and the test asserts their counts rather than trusting the claim.
