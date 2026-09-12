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

## Wave 2 — lane V: the wrong answers the port found, fixed in the oracle

The port's job was to agree with v0. Lane D3 and lane D1 found nine places where agreeing with v0 would have meant being wrong, filed them, and asked. The owner's answer on 2026-09-12 was one sentence — *"if you are finding any correctness bugs in the process, fix them please!"* — and this lane is that sentence carried out: **R-1020-35**, recorded at [docs/decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020](../docs/decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020) and ruled by the owner on [#1020](https://github.com/srikanth235/centraid/issues/1020), which narrows that issue's "v0 is a pinned oracle" invariant to admit a fixture-proven edit for a wrong answer and nothing else. Five commits, each naming the wrong answer it removes and shipping the test that was red in front of it.

Every one of the nine is a **silent** failure. Not one produced an error a member could act on: a balance folded over a quarter of its ledger, a refusal naming twice the rows it read, a keyset that reported dropped rows as "the rows ended", a trash command that rolled itself back, a ¥ amount a hundredfold small, two seats merging two receipt lines into one, an action the manifest offered and the precondition could never pass, a commit refused for holding a large number, and a declaration nobody wrote or read.

### What landed

**`529d765b` — `fix(engine): a query entry stops declaring reads nobody reads`**

- [`docs/decisions.md`](../docs/decisions.md) — **R-1020-35**, a `### Decisions — lane V (#1020)` block at the end of the `#1020` section, with the owner's words verbatim, what it supersedes (lane D3's owner hand-off 1 and the "did not fix in v0" line above its findings; lane D1's hand-off 1 on the same footing) and what it does **not** license.
- `packages/server/src/engine/registry/manifest.ts` — `ManifestQueryEntry.reads` and its JSON-schema property, deleted. Outside the file set the brief listed (`packages/{blueprints,core,vault,design}`), and inside the finding that named it; no other lane is live in `packages/server`.
- `packages/blueprints/src/app-manifests.test.ts` — the guard: every bundled manifest's query entries carry only keys the runtime reads.

**`27fd54b1` — `fix(apps): a declared window and a declared fan-out reach the rows they name`**

- `packages/blueprints/apps/_shared/paged-reads.ts` — `reachableBound` (a bound's declared product is the contract; the page is clamped to `MAX_PAGE_ROWS` and the page count raised to keep it) and `readWindow` (walks the host's own continuation to the end of a stated window, and stops there rather than throwing — a window is a declared screenful, a fan-out cap is a set that was supposed to be bounded).
- `packages/blueprints/apps/_shared/paged-reads.bounds.test.ts` — new. Its fake host runs the caller's limit through the real `probeLimit`/`pageOf`, so no case can pass by being asked politely.
- `packages/blueprints/apps/tally/queries/dashboard.ts` — `LEDGER_FAN_OUT`/`ALLOCATION_FAN_OUT` restated at a 500 page (same products, 8,000 and 32,000); `tally.dashboard.expenses` and `tally.dashboard.recurringExceptions` walk their 2,000-row windows.
- `packages/blueprints/apps/locker/queries/{autofill-candidates,trash,watchtower}.ts` — the same wrong answer, found by sweeping every declared window against `MAX_PAGE_ROWS` rather than by reading Tally: three 2,000-row windows that returned 500 rows. Watchtower is the one that matters most after Tally — it audited a quarter of the vault and reported the count as the whole.

**`afc0cc04` — `fix(vault): the paged door refuses a continuation over a nullable sort column`**

- `packages/vault/src/gateway/paged-door.ts` — `checkSortColumn`, run from `planPagedDoor` when the request carries a cursor; `packages/vault/src/gateway/filters.ts` — `columnIsNullable` off the `PRAGMA table_info` cache the door already keeps; `packages/vault/src/gateway/gateway.ts` — passes whether the request continues.
- `packages/vault/src/gateway/paged-door.test.ts` — the four (direction, boundary) cases, plus the proven-column case that must still be served.
- `packages/blueprints/apps/agenda/queries/day-context.ts` — `due_at IS NOT NULL` stated where the range either side of it already implied it.
- `packages/server/src/serve/app-query-plans.snapshot.md` — one line, the same predicate. The snapshot is the review diff for every statement that runs, so a statement change that does not move it means the statement never ran; the query PLAN either side of the line is unchanged, which is the point of stating a predicate an index already satisfied.

**`4332a25b` — `fix(vault): conditions read the handler's clock, and a wide integer commits`**

- `packages/vault/src/gateway/contract.ts` — `evaluateConditions` takes the instant and binds the one reserved parameter, `:ctx_now`; `packages/vault/src/gateway/execution.ts` — one `nowIso()` per invocation, handed to the preconditions, `ctx.now`, `claimStaged` and the postconditions.
- `packages/vault/src/commands/{tally,tasks,schedule,media,documents,knowledge,locker,people}.ts` — all eight `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` occurrences, every one of them a restore-window condition, converted to `:ctx_now`. That is the whole sweep: `grep -rn "strftime\|CURRENT_TIMESTAMP\|julianday" packages/vault/src/commands packages/vault/src/operations` now returns nothing.
- `packages/vault/src/commands/tally.test.ts` — the frozen-clock case.
- `packages/vault/src/replica/log.ts` — `read.setReadBigInts(true)` on `decodeChangeset`'s read-back; `packages/vault/src/replica/log-wide-integer.test.ts` — new (split from `log.test.ts` only because that file is at its 625-line ceiling).

**`d6d261a1` — `fix(tally): minor units, seat-scoped line ids and a reachable member removal`**

- `packages/design/src/format.ts` — `MINOR_UNIT_EXPONENT` (the ISO 4217 exponents that are not 2), `minorUnitExponent`, `DEFAULT_LOCALE` and `fmtMoney`'s third parameter. Design-tokens domain, under [docs/decisions.md#typography-and-design-contracts](../docs/decisions.md#typography-and-design-contracts): this changes a formatter's arithmetic and its locale source, not a token or a type scale.
- `packages/design/src/format.test.ts` — JPY/KRW at exponent 0, KWD/BHD at 3, the common case unmoved, and the same input under two locales.
- `packages/blueprints/apps/tally/line-model.ts` + `line-model.test.ts` — `newLineId`, and the two-seat collision case.
- `packages/vault/src/commands/tally.ts` — `MEMBER_NET_IN_GROUP_SQL` replaces `member_off_ledger`'s history count; `packages/vault/src/commands/tally-groups.test.ts` — a settled-up member is removable, one with a balance is not, and the refusal's observed row names the currency and the amount.
- `packages/blueprints/apps/tally/app.json` — the action's description says what "off ledger" means and that the expenses stay.

No file of lane B2 (`crates/xtask`, the ledgers, the `docs/decisions.md` budget block), lane D1 (`crates/vault`, `packages/vault/tests/golden/issue-1020/`) or lane C was touched; `crates/**`, `contracts/ledgers/**` and `.github/**` are untouched, and `contracts/apps/tally/*.json` did not move (see the exit list).

### The nine, and where each one is now

| # | The wrong answer | Commit | The test that was red | Fixture moved |
|---|---|---|---|---|
| 1 | `loadTally` folded every balance over the first 500 rows of a declared 2,000-row window | `27fd54b1` | `a stated window is walked to its end > reads all 2,000 rows of a 2,000-row window` | no |
| 2 | A fan-out of 8,000 reached 4,000 and threw a refusal naming 8,000 | `27fd54b1` | `a fan-out bound reaches the rows it states > walks all 8,000 rows of Tally's stated ledger fan-out` | no |
| 3 | A keyset continuation over a nullable sort column dropped rows and reported them as the end | `afc0cc04` | `a continuation over a nullable sort column > is refused by name, {ascending,descending}` + the two boundary cases | no |
| 4 | Handlers stamped `ctx.now`; their conditions read the host clock, so a frozen-clock trash rolled itself back | `4332a25b` | `a frozen clock in the past trashes an expense, and purge_at is relative to ctx.now` | no |
| 5 | `fmtMoney` divided by 100 for every currency and took the host's locale | `d6d261a1` | `fmtMoney scales by the currency's ISO 4217 exponent` + `… identically under two host locales` | no |
| 6 | `newLineDraft` minted `line-1` on every seat | `d6d261a1` | `line ids > never collide across independent seats` | no |
| 7 | `member_off_ledger` was unreachable for anyone who had spent | `d6d261a1` | `a settled-up member can be removed; one with a balance cannot` | no |
| 8 | `reads` on a manifest query entry was written by nobody and read by nobody | `529d765b` | `%s/%s declares only query keys the runtime reads` | no |
| 9 | A replicated commit holding an INTEGER above 2^53 threw and rolled back whole | `4332a25b` | `a value wider than a JavaScript number > commits, and the log row carries it exactly` | no |

### Demonstrated reds

Each was produced by reverting the fix on this tree and re-running the committed test — the failure text is quoted, not paraphrased.

1. **The window.** `AssertionError: expected [ { id: 'row-00000' }, …(499) ] to have a length of 2000 but got 500`. Two more from the same revert: `stops at the window rather than throwing` with the same 500, and `stops at the rows when they end` with `expected [ 2000 ] to strictly equal [ 500 ]` — the pre-fix code asked for 2,000 rows in one breath, which is how the clamp was reached at all.
2. **The fan-out.** `Error: test.rows: fan-out passed 8000 rows; the set this joins over is not bounded`, thrown after collecting 4,000 — the refusal naming the half it never read, which is the finding's sentence reproduced as a failure.
3. **The keyset.** All four cases: `AssertionError: expected [Function] to throw an error`. The continuation returned a short page and `next: undefined` instead. The companion green case pins what the refusal must not break: the proven-column walk returns `["task_000", "task_002", "task_004"]` across two pages.
4. **The two clocks.** `AssertionError: expected 'failed' to be 'executed'` on `tally.delete_expense` under a clock frozen at `2021-06-01T12:00:00.000Z`, with `expense_trashed` as the failing postcondition — the command trashed the row and then rolled it back.
5. **Money.** With the exponent table removed, `expect(fmtMoney(1234, "JPY")).toBe("¥1,234")` fails against `¥12.34`, and KWD's `1.500` against `15.00`.
6. **Line ids.** `expect(new Set([...seatA, ...seatB]).size).toBe(400)` fails at 200, both seats having produced `line-1 … line-200`.
7. **Member removal.** `expected '{"status":"failed",…"reason":"member_off_ledger: n eq 0"…}' to contain 'unsettled balance'` — the pre-fix predicate refused a member who had settled up in full.
8. **The dead field.** Red is the field coming back: `reads: ["tally.expense"]` added to Tally's first query entry fails the guard with `+ [ "dashboard.reads" ]`.
9. **The wide integer.** `RangeError: Value is too large to be represented as a JavaScript number: 9007199254740993`, thrown out of the capture inside the invocation's transaction — and the second case, the replica convergence one, fails with the same error, so the failure is the producer's rather than the applier's.

### Exit list

| # | Command | Outcome |
|---|---|---|
| 1 | `bun run --filter @centraid/vault typecheck` / `test` | code 0; **224 files, 1,861 passed, 2 skipped** |
| 2 | `bun run --filter @centraid/blueprints typecheck` / `test` | code 0; **216 of 219 files, 7,437 passed, 2 expected fail**, and **3 inherited failures** — see *Findings* 5 |
| 3 | `bun run --filter @centraid/design typecheck` / `test` | code 0; **32 files, 386 passed** |
| 4 | `bun run --filter @centraid/core typecheck` / `test` | code 0; **24 files, 333 passed** |
| 5 | `bun run --filter @centraid/server typecheck` / `test` | code 0; **401 of 408 files, 5 failed**. One was this lane's and is fixed — `app-query-plans.test.ts`, the snapshot above. The other four are **inherited**, verified by running them on `22042e5f` clean: `manifest-scope-denial.sweep.test.ts` (`declaredScopes` 295 against an expected 294), `gateway-db-lock.integration.test.ts` (a SIGKILL/`sqlite3` integration case), `vault-plane-maintenance.test.ts` (*sweeps the retained ledger by its own expiry*) and two `acp/launch.test.ts` cases about the root `IS_SANDBOX` bypass, which this container's uid decides |
| 6 | `node node_modules/vitest/vitest.mjs run --config vitest.quality.config.ts tests/quality/tally-parity.contract.test.ts` | 2 passed. This is the ORACLE: it rebuilds the bundle from the live v0 tree and fails if the committed fixtures disagree, so a green run is the statement that **no fix changed a fixture's answer** |
| 7 | `CENTRAID_WRITE_CONTRACTS=1 …` the same test, then `bun run format` and `git diff --quiet contracts/apps` | exit 0 — regeneration is idempotent and `contracts/apps/tally/*.json` is byte-identical. The 6-expense fixture the brief named specifically is unchanged, which is the point: its ledger fits in one 500-row page, so the window fix cannot move it |
| 8 | `bun run lint` | clean (`oxlint --deny-warnings`, whole tree) |
| 9 | `bun run format` + `bun run format:check` | "All matched files use the correct format", 5,830 files |
| 10 | `bash .governance/run.sh` | all 10 directives passed; one `doctrine-citation` **warning** on the design-tokens domain, answered by the anchor cited in this section's `d6d261a1` entry |
| 11 | `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5` | 10 rules, 0 errors |
| 12 | `bun run check:push:static` | **4/4 in 228.1 s** — `lint` 17.1 s, `turbo:lint` 0.7 s, `format:check` 18.4 s, `typecheck:affected` 210.2 s (needs `bun run build` once first, as lanes A, B and C all recorded) |
| 13 | `git push -u origin claude/1020-laneV` | accepted; no `SKIP_*`, no `--no-verify`, no waiver spent |

`cargo` was not run in this lane: the brief excludes it (disk), and the lane touches no Rust. The Rust parity suite re-runs on merge against unchanged fixtures.

### Decisions — lane V

- **D-1020-V1** — **the nullable-keyset refusal fires on the CONTINUATION, not on the statement.** Lane D3's finding, and the Rust port, refuse a `PageQuery` whose sort column is nullable outright. Options: (a) refuse at statement build, always; (b) refuse only when the request carries a cursor; (c) coalesce the sort key; (d) reproduce v0's silence. A mechanical sweep of every `(from, sortColumn)` pair in the tree against a real vault's `PRAGMA table_info` — 9 pairs on nullable columns — is what settled it: four are proven non-null by the handler's own predicate (`notes.library.trash`, `people.trash.profiles`, `photos.duplicates.phashes`, `photos.library.trash`, `tally.dashboard.trash`), and four are not (`agenda.dayContext.dueTasks`, `photos.library.live`, `photos.search.assets`, `tasks.board.logbook`). **(a) would have removed rows a member can see today**: an undated photo sorts last under `captured_at DESC` and is visible in any library under 500 assets, and (a) drops it from the shelf entirely. (c) is not available — coalescing makes the sort key an expression, a SELECT alias cannot be named in a WHERE, and the keyset could not be written at all without falling back to OFFSET, which is what `packages/core/src/page/window.ts` exists to prevent. **Adopted (b)**, with a syntactic `<column> IS NOT NULL` proof in the handler's own predicate as the accepted escape: the first page is correct today and is left alone, and the continuation — the only thing that silently drops rows — refuses by name. No shipped handler is broken by it, because all four unproven statements are single-page reads with no cursor ([#1020](https://github.com/srikanth235/centraid/issues/1020)).
- **D-1020-V2** — **`reachableBound` keeps a bound's PRODUCT, not its page size.** Options: (a) clamp `pageSize` and accept that the cap falls with it, restating every call site's `fanOutPages`; (b) treat `pageSize × fanOutPages` as the contract and raise the page count; (c) refuse a bound whose `pageSize` exceeds `MAX_PAGE_ROWS`. (a) makes every existing declaration's number change meaning; (c) is the most honest and is a breaking change to two shipped call sites for no gain, since the walk can simply take more pages. **Adopted (b)**, and Tally's two bounds are additionally restated at a 500 page so the call site reads true on its face — the products are unchanged at 8,000 and 32,000 ([#1020](https://github.com/srikanth235/centraid/issues/1020)).
- **D-1020-V3** — **a stated window stops at the window; it does not throw.** `readPages`' cap throws, and the two could have been one function. They are not, because they answer different questions: a fan-out cap means "the set I am joining over was supposed to be bounded and is not", which is a bug in the caller; a window means "this is the screenful I declared", and stopping at it is the declaration being honoured. Options: (a) one function that throws; (b) one that truncates; (c) two, named for the two claims. **Adopted (c)** ([#1020](https://github.com/srikanth235/centraid/issues/1020)).
- **D-1020-V4** — **`:ctx_now` is a reserved condition parameter, not a merged input.** Options: (a) bind `now` from the input map, so a command could pass it; (b) a reserved name the input cannot shadow; (c) pass the instant as a second SQL binding by position. (a) lets a command input decide the vault's idea of the time, which is the same class of bug one level up. **Adopted (b)** ([#1020](https://github.com/srikanth235/centraid/issues/1020)).
- **D-1020-V5** — **"off ledger" means no unsettled balance, per currency.** This is lane D3's finding 8 with its options (a) drop the action, (b) redefine the predicate, (c) leave it, and the brief's recommendation (b) adopted as written. The balance is computed from the same four terms the dashboard's fold uses — payer rows, or `paid_by` for the whole amount when an expense has none; splits; settlements out; settlements in — over live rows only. A member's expenses are **not** removed: they are durable money history, and the manifest description now says so ([#1020](https://github.com/srikanth235/centraid/issues/1020)).
- **D-1020-V6** — **`fmtMoney`'s default locale is `en-US`, stated.** Options: (a) keep `undefined` (the host's); (b) read a vault-held display locale; (c) an explicit constant default. (b) is right and there is nothing to read: `grep -rn "locale:" packages/{client,core,design}/src` finds only `localeCompare`, and `core_vault` has no locale column (`vault_id, self_party_id, display_name, status, base_currency, settings_json, …`). **Adopted (c)**, with (b) filed as *Findings* 1 — an explicit default is reproducible and a vault-held one can replace it in one place ([#1020](https://github.com/srikanth235/centraid/issues/1020)).
- **D-1020-V7** — **a line id is minted locally, not deferred to the vault.** Options: (a) a seat-scoped random id; (b) ask the gateway for an id before a draft exists; (c) a per-draft counter rooted at the receipt id. (b) defeats the point of a draft, which is to exist offline before the vault has seen it. (c) still collides when two seats draft against the same receipt. **Adopted (a)**: `line-<ms base 36>-<80 random bits>`, the expense id's shape — time-ordered prefix, random tail ([#1020](https://github.com/srikanth235/centraid/issues/1020)).

### Findings outside the slice

1. **The vault holds no display locale, so `fmtMoney`'s default is a constant rather than a member's setting.** `DEFAULT_LOCALE = "en-US"` in `packages/design/src/format.ts` is the one place it would change. The natural home is `core_vault.settings_json` beside `base_currency`, read the way civil time's zone is ([R-1020-33](../docs/decisions.md)); no surface asks for it today, so nothing is broken, and a member outside en-US sees en-US grouping.
2. **Four statements page by a nullable column and are saved only by being single-page reads**: `photos.library.live` and `photos.search.assets` on `media_asset.captured_at`, `tasks.board.logbook` on `schedule_task.completed_at`, and `agenda.dayContext.dueTasks` on `schedule_task.due_at` (now stating its proof). The first three have a product question behind them — where an undated photo and a cancelled-but-never-completed task belong in an ordering — and until it is answered their rows past the first page are unreachable *by the ordering itself*, which the refusal now makes loud rather than fixing. Owner hand-off 1.
3. **`photos.library.live` still asks for a window of up to 2,000 rows in one request** and gets 500. It was left on `ctx.vault.page` rather than converted, because its pagination is the client's `before` parameter rather than a cursor, and because converting it would walk a nullable sort column straight into finding 2's refusal. It is the one declared window above `MAX_PAGE_ROWS` this lane knowingly left short; it does not fold a balance over the result.
4. **`ManifestActionEntry.writes` is populated and never read**, the sibling of the field this lane deleted. `grep -rn '"writes"' --include=app.json packages/` finds it on real actions, and no call site consults it — so unlike `reads` it is a declaration somebody wrote, which makes deleting it the wrong first move. Either the dispatcher should enforce it or it should go; not this lane's call.
5. **Three `packages/blueprints` suites are red on the umbrella base**, verified by checking out `d3e0479e` clean and running them: `src/one-computation.test.ts` (*adds no seat-local duplicate BODY, renamed or not*), `src/pending-projection-tripwire.test.ts` (*every destructive action on the eight apps projects a delete or a tombstone*) and `src/photos-vocabulary.test.ts` (*shows the storage noun only in reviewed ownership copy*, on `PHOTOS_ERROR_FREE_UP_PAUSED`). All three are law tests over Photos and the pending plane, none is in this lane's file set, and all three fail identically with and without this lane's diff. **Four `packages/server` suites are red on the same base** and were checked the same way: the manifest scope sweep's `declaredScopes` count is one over its expected 294, and the other three are host-shaped — a SIGKILL/`sqlite3` integration case, a retained-ledger expiry sweep, and two `acp` launch cases that branch on the process uid.
6. **`packages/client/src/replica/seat/{seat-page-reader,paged-handler}.ts` assemble the same statements with no nullable-column check.** A seat that holds the file runs `pageStatement` directly, so D-1020-V1's refusal covers the gateway path only. The check belongs in `pageStatement` itself with schema facts passed in — the shape the Rust kit uses — and `packages/client/src/replica/**` is neither this lane's file set nor free of a doctrine anchor ([docs/decisions.md#one-vault-every-seat-996](../docs/decisions.md#one-vault-every-seat-996)). Owner hand-off 2.
7. **`packages/vault/src/schema/{replica,updated-at,entity,time-organize}.ts` still stamp `strftime('now')` in column defaults and triggers.** Lane D3's finding 5 called this a fixturing seam, and the clock sweep confirms it is not a command condition: nothing in `packages/vault/src/commands` or `packages/vault/src/operations` reads a value those produce inside a pre- or postcondition. Left alone deliberately, per the brief.

### Owner hand-offs

1. **Where does an undated photo, or a cancelled task that was never completed, belong in an ordering?** Findings 2 and 3. Options: (a) the ordering stays and those rows are reachable only on the first page, as today; (b) the shelf sorts on a NOT NULL column — `created_at` — and undated photos sort by import date; (c) the ingest guarantees `captured_at` and the column becomes NOT NULL, which is an ontology change. **Recommendation: (b) for `tasks.board.logbook`** (a logbook is chronological by when it closed, and `updated_at` is the closest total column) **and (c) for Photos**, because a library ordered by import date is a different product from one ordered by capture date. Both are outside this lane's file set and neither is a wrong answer today, only an unreachable one.
2. **The seat-side statement assembler needs the same nullable-column refusal** (finding 6). Recommendation: move the check into `pageStatement` with the table facts passed in, which is where the Rust kit puts it, and delete the door's copy. One lane, `packages/core` + `packages/client`, with the doctrine anchor named.
3. **`ManifestActionEntry.writes`** (finding 4) — enforce or delete.

### Doctrine digest

Law `53be88c22ab5`, stamped. `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5` — 10 rules, 0 errors, 1 warning (the design-tokens `doctrine-citation` note, answered above by naming [docs/decisions.md#typography-and-design-contracts](../docs/decisions.md#typography-and-design-contracts)). `bash .governance/run.sh` — all 10 directives pass. No waiver spent; no law path, gate, budget, ledger, allowlist or quarantine list touched, and no test skipped or weakened. Every edit inside the pinned v0 tree is listed above by full path and is licensed by **R-1020-35**, which this lane's first commit records.

### Not done, and why

1. **`contracts/apps/tally/*.json` was not regenerated into a diff**, because there is none to make: a write run is byte-identical to what lane D3 committed. That is the strongest single statement in this section — nine fixes to the oracle, and the fixture that compares the oracle to the port did not move — and it is true for a reason worth naming rather than celebrating: lane D3's own falsification found that fixture blind to page-boundary bugs by arithmetic accident (16 split rows inside one 500-row page). It proves the fixes broke nothing. It does not prove they were needed; the nine reds do that.
2. **The `packages/client` suite was not run.** It holds no edit from this lane. `packages/server` was run in full and is recorded at exit-list item 5.
3. **No Rust was built or run.** The brief forbids it here on disk grounds, and the lane touches no Rust. Mid-lane the container's filesystem did in fact reach 100% and this lane's own vitest, turbo and coverage caches were cleared to finish; nothing outside `/home/user/centraid-laneV` and this lane's scratchpad was touched.

### Falsification

The two riskiest claims in this diff, the throwaway check run against each, and the result.

1. **"The window fix changes no answer that was already right."** The risk is the opposite of the bug: `readWindow` walking past a window, or re-reading a boundary row, would make every Tally figure wrong in a new way — and the parity oracle could not see it, because its 6-expense fixture never reaches a second page. So the fake host in `paged-reads.bounds.test.ts` was built out of the **real** `probeLimit` and `pageOf` rather than a restatement of them, and the walk was checked at three volumes on either side of the boundary: 2,000 rows through a 2,000 window (`[500, 500, 500, 500]`, the exact request sequence asserted), 2,600 through 2,000 (last row `row-01999`, so no overrun), and 6 through 2,000 (one request, `[500]`, so no pointless second call). Then the stronger version: the window was set to 501 against 502 rows — the smallest case that crosses the boundary at all — and the walk returns 501 distinct ids with no repeat of row 500.

   **Result: the claim held, and the sharpest case is now a committed test.** At a window of 501 against 502 rows the request sequence is `[500, 1]` — not `[500, 500]` with a trim — so the walk never reads rows it will throw away, which is the way this function would otherwise have been quietly wasteful on the hottest handler in the app and been hidden by the trim. 501 rows came back, 501 of them distinct, last id `r-0500`: no boundary row repeated and none skipped. The trim in `readWindow` is therefore belt-and-braces rather than the thing doing the work, and it stays only because a host that over-returns is a host this function should not propagate.

2. **"The nullable-keyset refusal breaks no shipped handler."** A refusal is the one kind of fix that can turn a wrong answer into a dead screen, and reading the handlers is not a check — a sort column's nullability is in the schema, not in the file that names it. So the check was mechanical: a script that walks every `.ts` under `packages/{blueprints/apps,client/src,server/src,vault/src}`, extracts each `(from, sortColumn)` pair, and asks a **real founded vault** (`contracts/golden/issue-929/vault.db.gz`, 249 tables) for that column's `notnull`. It reports 9 nullable pairs, classifies each as proven or not by the handler's own predicate, and names the file.

   **Result: the claim held, and the check changed the design.** The first intent was the port's — refuse the statement outright — and the sweep is what showed that (a) five handlers are only legal because of a predicate a schema check cannot see, which is where the `IS NOT NULL` escape comes from, and (b) `photos.library.live` would have lost its undated assets from the shelf, which is where the "continuation only" scope comes from. Both are recorded as D-1020-V1 with the options they replaced. The residue is finding 6: the same sweep shows the seat-side assembler has no such check, so the claim is true of the gateway path and is not yet true of the seat.

   A third, cheaper one: the claim that **the eight clock conversions are the whole sweep** is not a reading, it is `grep -rn "strftime\|CURRENT_TIMESTAMP\|julianday" packages/vault/src/commands packages/vault/src/operations` returning nothing afterwards, against 8 hits before — and the four remaining `strftime('now')` sites in `packages/vault/src/schema/**` were each checked against the condition SQL that could read them, which is finding 7.

## Wave 2 — lane R: key custody, backup, the recovery kit and the restore drill

Doctrine digest stamp: law `53be88c22ab5`.

The exit criterion in one line: **a vault can be lost completely and come back, and the seat that was paired to it re-pairs and converges** — proven by `cargo xtask gate --profile release`, step `restore-drill`, in 18.2 s.

### What landed, by commit

**`c5de2b39` — `feat(media): the byte plane moves to crates/media with its golden`**

- `crates/media/{Cargo.toml,README.md}`, `crates/media/src/{lib,cbsf,format}.rs`, `crates/media/tests/golden.rs`
- `contracts/golden/format-golden.json` (byte-identical copy of `packages/tunnel/data-plane/fixtures/format-golden.json`)
- `Cargo.toml` — `[workspace.dependencies]` gains `aes-gcm 0.11`, `hkdf 0.13`, `hmac 0.13`, `ryu-js 1.0.3`, `scrypt 0.12`, `subtle 2`, `tempfile 3`, `zstd 0.13`

`cbsf` and `format` are **moved source**, with an origin header line naming the v0 path, and they carry v0's own tests. The v0 crate is untouched and stays the oracle.

**`aaeb4bf4` — `feat(vault): key custody in three layers, with the rotation-order crash tests`**

- `crates/vault/src/custody/{mod,keystore,seal,locker_key}.rs`; one `pub mod custody;` line in `crates/vault/src/lib.rs`
- `crates/vault/Cargo.toml` — `aes-gcm`, `anyhow`, `base64`, `hkdf`, `hmac`, `rand`, `scrypt` deps; `base64`, `tempfile` dev-deps

**`14e26330` — `feat(vault): the backup plane, the recovery kit and centraid backup/recover/export`**

- `crates/vault/src/backup/{mod,base,drill,keyring,kit,manifest,policy,restore,store,wal}.rs`; one `pub mod backup;` line in `lib.rs`
- `crates/vault/tests/backup_golden.rs`
- `crates/centraid/src/cmd/{mod,backup,recover,export}.rs`; `crates/centraid/src/main.rs` (the three verbs' args and dispatch, plus `mod cmd;`); `crates/centraid/Cargo.toml`
- `crates/centraid/tests/restore_drill.rs`; `crates/centraid/tests/no_listener.rs` (lane C's stub list shrank — see "inherited tests" below)
- `contracts/custody/recovery-kit.json`, `contracts/tools/export-recovery-kit-fixture.ts`, `contracts/migrations/999_fails.sql`

**`01736d37` — `feat(xtask): the release profile's restore-drill placeholder becomes real`**

- `crates/xtask/src/gate.rs` — `run_restore_drill` replaces the failing placeholder; the two tests that named it are re-pointed at `vps-smoke`, which is still a placeholder and still FAILS
- `contracts/ledgers/gate-budgets.json` — the release profile's `headroom` prose and a new `_provenance` string. **No number was added, raised or removed**; `budgetSeconds` for `release` is `null` by ruling and there was no `restoreDrillSeconds` slot to lower

**this commit** — `crates/vault/src/custody/README.md` and this receipt section.

### Exit list

| # | Command | Outcome |
|---|---|---|
| 1–3 | `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` | **clean / clean / PASS.** Clippy has zero warnings; two it raised on this lane's code (`needless_range_loop` in the drill, `field_reassign_with_default` + `type_complexity` in the policy test and the keystore) were fixed in the code, not silenced |
| 4 | `cargo xtask gate --profile local` | **PASS**, every step ok. `sql-confinement` scanned 41 files and reports clean — `crates/media` and `crates/centraid` carry no SQL literal (see D-1020-R9). **202.0 s against the 120 s budget**, which is lane D1's already-filed finding growing further; the ledger was not touched |
| 5 | `cargo xtask gate --profile pr` | **FAIL on four steps.** Two are the inherited reds on `main`: `secrets` (gitleaks, `packages/model-runtime/LICENSES.md`) and `osv` (`astro@7.1.5`). Two are findings, neither this lane's file: `release-build` took **666.6 s cold** against the 600 s ceiling in `contracts/ledgers/compile-time.json`, and `ts-static` failed once on the then-uncommitted `custody/README.md` formatting, which `bun run format` fixed. Every other step ok |
| 6 | **`cargo xtask gate --profile release`** | **`restore-drill` PASS in 18.2 s** — "restore, re-pair and converge in 18.2s (release budget is unbounded by ruling) — evidence: target/xtask/release/restore-drill". `vps-smoke` is the **one remaining placeholder red** ("not implemented: lands in wave 3 lane G"). `release-build` ok at 0.5 s warm; `v0-oracle` ok; `device-lanes` SKIP; `secrets`/`osv` the two inherited |
| 7 | `sha256sum contracts/golden/format-golden.json packages/tunnel/data-plane/fixtures/format-golden.json` | **equal**: `9a8cd304bc74f33d0562272ffd0517aad757edd3974400178667752e704d9464` both. Asserted in code too, by `the_contracts_copy_is_byte_identical_to_the_v0_fixture` |
| 8 | `bunx vitest run packages/vault/src/rust-golden.test.ts packages/backup/src/rust-golden.test.ts` | **2 files, 4 tests passed.** Needs `bun run build` once first, as the common brief says |
| 9 | Test names | R4: `gateway_file_and_keystore_do_not_reveal_a_cell_without_k`, whose assertion line is `assert!(decrypt_under_locker_key(candidate, stamped, item_id, cell).is_err(), "{item_id} opened under a key that is not K — the cell depends on something other than K")`. Rotation crash points: `a_crash_between_the_new_key_file_and_the_transaction_sweeps_clean`, `a_crash_between_the_transaction_and_the_old_file_delete_sweeps_clean` |
| 10 | `centraid recover --kit … --password-file … --data-dir … --yes` on the drill's artefacts | **exit 0**, driven as a real process by `crates/centraid/tests/restore_drill.rs`. Phases on stderr in order, JSON on stdout; the test asserts `phases == ["discovering","fetching","replaying","fencing","adopting","warming","done"]`, `clean == true`, `restoreCheck.sealKey == "ok"` and that `fencedEpoch` is a string. A bad `--at` is **exit 2** and leaves no lock file |
| 11 | `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5` · `bash .governance/run.sh` · `bun run format` + `format:check` · `bun run check:push:static` | recorded below the decisions |

`bun run check:push:static` → **4/4** (lint 16.4 s, turbo:lint 0.9 s, format:check 17.9 s, typecheck:affected 19.3 s).

### Decisions — lane R

- **D-1020-R1 — formats are moved, not ported.** `crates/media` carries `cbsf` (v2) and `format` as moved v0 source with v0's tests, reading `contracts/golden/format-golden.json`. *Options:* (a) re-implement from the spec in the census; (b) move the source; (c) depend on the v0 crate. (c) is out — the v0 crate is excluded from the workspace and retires in wave 6. (a) is what a rewrite normally does and is wrong here: every constant and every info/AAD string is a **format** decision, so a re-implementation is a chance to silently re-key every vault, and the golden only catches the four vectors it carries. **(b) adopted**, with a header line per file naming the origin and a test asserting the two fixture copies are the same bytes while the v0 file exists (#1020, Compatibility).
- **D-1020-R2 — three key layers, three AADs, never one helper.** `custody::{keystore, seal, locker_key}`, each with its own wire form and AAD, faithful to v0 including the parts that look like rough edges: adoption of an unprotected envelope is **warned about** rather than refused, permissions are **repaired**, and `is_sealed_value` / `is_locker_ciphertext` are **structural** predicates. *Options:* (a) one `encrypt(key, aad, value)` helper the three layers call; (b) three modules with three AAD builders. (a) reads better and is how a ciphertext becomes movable between rows: the AADs name different things (a cell; a row under a key generation), and one helper invites a caller to pass the wrong one. **(b) adopted** (#1020).
- **D-1020-R3 — a recovery kit in a member's drawer must stay openable, so v1 reads a v0-made kit.** `contracts/custody/recovery-kit.json` is produced by v0's own `wrapRecoveryKit` under a fixed password via `contracts/tools/export-recovery-kit-fixture.ts`, and `a_v0_made_wrapped_kit_opens_in_rust` opens it. *Options:* (a) hold the line — no v0 artefact compatibility, full stop, and an owner re-exports a kit before upgrading; (b) make the kit the single exception. (a) is the issue's general rule and it is right for seat files and pairing tickets, because those are re-made in a ceremony the owner is present for. A kit is not like that: it is written once and opened years later, on the day everything else is gone. An upgrade that quietly invalidated the last copy of a vault's keys would be the single worst thing this umbrella could ship. **(b) adopted**, scoped to this one file format and to the reader only; nothing else in v1 reads a v0 artefact (#1020).
- **D-1020-R4 — the acceptance test in its wave 2 form, with what it does not prove said out loud.** Every seal/unseal function takes the key **by value**, and `gateway_file_and_keystore_do_not_reveal_a_cell_without_k` opens the vault file and the whole `keys/` directory with `K` withheld, asserting every `lk1:` cell fails under every byte string the host still offers (plus a raw-bytes scan of the vault file for each plaintext). *Options:* (a) leave the acceptance box to wave 4 with the member key; (b) land the test now in the shape the wave 4 key will satisfy. **(b) adopted.** Plainly: **the gateway still holds `K` until wave 4.** What the test proves is that a sealed cell depends on `K` and on **nothing else that is on disk** — which is the property that makes wave 4 a change of custody rather than a change of format. Stated the same way in `crates/vault/src/custody/README.md` so nobody reads the green test as the box being closed (#1020).
- **D-1020-R5 — one policy, deterministic nonces, and `backup now` as a command through the core.** `BackupPolicy` keeps v0's defaults exactly (`rpoSeconds 60`, `snapshotIntervalHours 24`, `verifyEveryDays 7`, `outboxBudgetBytes 512 MiB`, `reservedHeadroomBytes 256 MiB`, `walBaseRollBytes 16 MiB`, `walBaseRollHours 24`, `MIN_RPO_SECONDS 30`), including the two provider-shaped fields v1 has no back-end for (`storageClass`, `directToColdOriginals`) — *options:* drop them, or carry them dormant. Dropping makes a v0 policy row unreadable and re-inventing the names later is worse than two dormant fields now; **carried dormant, with a note** (#1020).
- **D-1020-R6 — `recover` takes its password from a file, and a bad `--at` is exit 2.** *Options:* (a) `--password`; (b) `--password-file`; (c) a prompt. (a) puts the last copy of a vault's keys in the shell history and in every `ps` listing on the host. (c) cannot be scripted, and a restore is often run by a script at 3am. **(b) adopted**, and `--at` is validated **before anything is touched** and exits 2, because a script that retries a refusal must not retry a typo (#1020).
- **D-1020-R7 — the drill runs the real binary, and the seat's half is played by D1's applier.** `crates/seat` (lane D2) is **not on the umbrella at this lane's rebase** (`66a16bcb`; `find crates -maxdepth 1` shows no `seat`), so per the brief the drill uses **D1's gateway-side applier** (`log::apply::apply_log_page`) against a second vault file, with `devices::enrol_device` and the log door's cursor record standing in for lane C's pairing ceremony. **What that costs, named:** the drill proves the *replica* re-bootstraps and converges and that the old cursor earns `RebootstrapRequired{epoch-mismatch}`; it does **not** prove the iroh pairing handshake runs again. `backup::drill::SeatReplica` is the one seam D2 swaps. *Options:* (a) wait for D2; (b) mark the drill `#[ignore]`; (c) land it with the applier and name the gap. (a) serialises two lanes for one struct; (b) is a gate that does not run. **(c) adopted** (#1020).
- **D-1020-R8 — a backup's base copy is NOT the seat snapshot. D-1020-D1-7 is narrowed.** *This is the reversal the drill found, and it was a real bug.* D-1020-D1-7 rules one snapshot pipeline with three uses, one of them "a backup generation's base". Built that way, the drill's `restored-census` check reported **29 tables at `-1` (absent) and `replica_log` at 0 against 30** — including **`locker_key`**, which is the row a vault names its own live key with. The recovery kit carries the key *file*; nothing carries the row, so a restore from that generation is a vault whose Locker secrets can never be opened, from a backup that reported success. Also lost: `access_device_secret` (every paired device's key half), the `blob_*` custody tables, `outbox_item`, `replica_invocation_commit` (the exactly-once ledger) and the log itself. *Options:* (a) accept it and restore the private bands from somewhere else — there is nowhere else; (b) add a flag to `build_snapshot`; (c) a separate `backup::base::build_backup_base`, a plain `VACUUM INTO` with nothing removed. (b) is one typo away from handing a phone the credential bands. **(c) adopted**: a different function, a different name, a different module, and `a_base_copy_keeps_the_private_bands_the_seat_snapshot_drops` asserts the difference in both directions. The seat snapshot keeps its other two uses unchanged; the ruling is narrowed from three to two, not discarded. **Owner hand-off 1** below, because this contradicts a landed lane's recorded decision (#1020).
- **D-1020-R9 — `export` lands its custody half and says what it is missing.** v0's portable export also carried the blob bundle and an app-by-app manifest, which needs the content store wave 3 owns. *Options:* (a) exit 3 until wave 3; (b) ship the bundle silently without blobs; (c) ship the custody half and print, on stderr and in the JSON (`"carriesContentBlobs": false`), that content blobs are not in it. (b) is a bundle an owner would trust with their photos. **(c) adopted** — the useful half now, honestly labelled. It also requires `--password-file`: there is no unwrapped export path, not as a flag, not as a prompt (#1020).
- **D-1020-R10 — the SQL stays in `crates/vault`, which shaped two APIs.** `sql-confinement` allows SQL only under `crates/{ontology,vault,seat,search}` and `crates/apps/kit`, and `crates/centraid` is not one of them. So `recover`'s fencing step became `backup::restore::fence_restored_vault` in the vault crate, and the drill's vault-side work became `backup::drill`, with the caller passing a `Recover` closure that runs `CARGO_BIN_EXE_centraid`. *Options:* (a) widen the rule for the CLI; (b) put the SQL where the rule allows it. (a) is weakening a gate to go green. **(b) adopted**, and it produced the better shape anyway: the drill exercises the real process, which a library call would not (#1020).

### Demonstrated reds

Every gate this lane lands was seen failing first, on this tree:

1. **`restore-drill`, the whole point.** Its first real run failed with `restore_check/drill is not clean: restored-census: ... locker_key: expected 1, restored -1; ... replica_log: expected 30, restored 0; restored-blob-coverage: 12 sampled, 12 missing` — 29 absent tables listed by name. That red is what produced D-1020-R8 and `backup::base`. It then failed a second time on `the re-paired seat applied nothing, so convergence proved nothing`, because the seat's re-bootstrap snapshot was being taken *after* the post-restore write and therefore already contained it; fixing the order is what makes the convergence assertion mean anything.
2. **`a_base_copy_keeps_the_private_bands_the_seat_snapshot_drops`** fails if `build_backup_base` is replaced by `build_snapshot` (that is the bug it was written from), and its second half fails if the base copy is taken through `Vault::read`, which holds `PRAGMA query_only = ON` — SQLite calls `VACUUM INTO` a write. Seen as `attempt to write a readonly database`.
3. **`the_drill_catches_a_restored_vault_whose_content_is_gone`** is a red-by-construction gate: it empties a restored vault's rows, asserts the **structural** check is still clean (`integrity_check` speaks about pages, not rows), and then asserts the depth check is not.
4. **`an_upgrade_that_fails_mid_way_restores_from_its_pre_migration_snapshot`** fails unless `contracts/migrations/999_fails.sql` leaves the file *changed* — the drill refuses a fixture that succeeded, and refuses one whose failure changed nothing, because either way the pre-migration snapshot would prove nothing. Observed failure: `NOT NULL constraint failed: drill_upgrade_scratch.label`.
5. **`a_failed_commit_leaves_no_temp_file_and_no_key_file`** drives `atomic_write`'s injected `before_commit` failure; **`two_live_rows_are_unrepresentable_because_the_index_is_on_the_predicate`** is a real `UNIQUE constraint` refusal from `locker_key_live_idx`; both rotation-crash tests assert the DB/keys state *before* the sweep and after it.
6. **`an_unwrapped_kit_is_refused_however_well_formed_it_is`** passes the same document that `RecoveryKitDocument::from_json` accepts, and asserts `parse_recovery_kit` refuses it with and without a password — v0's #568 prohibition, with a test on it rather than a comment.

### Inherited tests this lane changed

Two, both because their **subject** moved, neither weakened:

- `crates/centraid/tests/no_listener.rs::every_unimplemented_verb_exits_three_and_names_its_lane` — lane C's list of six verbs is now three (`seat`, `devices list`, `doctor`). `backup now`, `recover` and `export` are implemented, so they are no longer "not yet available". The rule is untouched, and a **new** test, `the_verbs_lane_r_landed_no_longer_exit_three`, asserts the three now exit 1 (refusal) / 2 (usage) and never claim to be unavailable — which is what keeps exit 3 meaning something.
- `crates/xtask/src/gate.rs::the_placeholders_fail_rather_than_skip` — narrowed to `vps-smoke`, the one remaining placeholder. Its sibling was renamed to `release_adds_exactly_the_restore_drill_and_the_vps_smoke`; the assertion (the release profile adds exactly those two step names, in that order) is unchanged.

No v0 file was edited. `contracts/tools/export-recovery-kit-fixture.ts` **imports** from `packages/backup/src/recovery-kit.js` and changes nothing there.

### Findings outside the slice

1. **`release-build` overran its ceiling: 666.6 s cold against 600 s** in `contracts/ledgers/compile-time.json`. Not this lane's number and not one lane's fault — wave 2 added seven crates. Warm it is 0.5 s, so the ceiling is a *cold-build* ceiling in practice. For lane B / the owner.
2. **`gate --profile local` is now 202.0 s against its 120 s budget**, with `cargo test --workspace` at 175.9 s. This is lane D1's filed finding (they measured 134.2 s) continuing to grow; their recommendation (`local` tests only the changed crates, `pr` keeps the workspace run) is the right one and is more urgent now.
3. **`crates/vault`'s `snapshot::build_snapshot` has no caller-visible marker that its output is sanitised.** `backup::base` exists because a reasonable reader used it for a backup. A `#[must_use]`-style name or a doc line at the function (not only in the module header) would have caught it at review. For lane D1.
4. **`access_receipt(object_type, object_id)` is a cross-band reference with no foreign key**, by design, and `restore_check` is now the only thing that checks it. Nothing checks it on a **live** vault — v0's `journal-archive.ts` is still marked NEEDS-WIRING (#367) and v1 has no equivalent. For whoever owns the ledger band.
5. **`recovery_kit_fingerprint` sorts targets with Rust's `str::cmp` (UTF-8 bytes) where v0 uses `localeCompare`.** They agree for every id a target actually carries (a `vaultId` is a UUID, a `targetId` is a path) and the v0-made fixture proves it for that fixture. A non-ASCII `targetId` is the one input that could disagree, and it would show as a fingerprint mismatch, which is a loud refusal rather than a silent wrong answer. Recorded rather than fixed: the fix is to normalise the sort key, and doing it changes the fingerprint of every existing kit.
6. **No v0 wrong answer found in this lane's reading** of `key-store.ts`, `sealed.ts`, `locker-key-plane.ts`, `crypto.ts`, `recovery-kit.ts`, `password-wrap.ts`, `backup-policy.ts`, `restore-check.ts` — nothing to hand lane V.

### Owner hand-offs

1. **D-1020-R8 narrows D-1020-D1-7, a landed lane's recorded decision.** The narrowing is not a preference — building a generation from the seat snapshot loses `locker_key` and is unrecoverable custody loss. But the ruling belongs to lane D1's author and to the owner, so: the decision as it now stands is *"one snapshot pipeline with **two** uses — a seat's bootstrap and pre-migration safety — and a separate complete base copy for backup"*. If the owner would rather have one pipeline with a `sanitise: bool`, say so and it is a small change; the recommendation is to keep two functions, because the boolean's wrong value hands a phone the credential bands.
2. **The WAL capture tick is not running.** `take_generation` accepts a WAL tail and seals it correctly against the golden, and `centraid backup now` passes an **empty** tail — the loop that rolls a segment every `rpo_seconds` is the gateway's, and the gateway's run loop is lane C's/wave 3's. Until it exists, a generation is the base copy and the RPO is the snapshot interval, not 60 s. Named here rather than left to be discovered from a restore that came back a day stale.
3. **`recover --full` warms the manifest's chunk index and nothing more**, because v1 has no content store to materialise from (R-1020: local filesystem only). `deferredBlobs` in the report is the chunk count, honestly. Wave 3's content store is what makes `--full` mean what its name says.
4. **The drill's re-pair is a replica re-bootstrap, not a pairing handshake** (D-1020-R7). When `crates/seat` lands, swapping `backup::drill::SeatReplica` for it closes the gap, and the acceptance box should not be read as fully closed until that happens.

### Falsification — the two riskiest claims, and the throwaway check against each

1. **"A `lk1:` cell cannot be opened from the gateway's disk without `K`."** The risk is that the test passes for a boring reason — the cells were never ciphertext, the AAD is not actually binding, or the raw-bytes scan does not read what it claims to. Three throwaway checks, each reverted afterwards.

   **(a) The negative.** The R4 test's candidate-key list was temporarily extended with the real `K` *before* it is withheld. The test **failed**: `item-0 opened under a key that is not K — the cell depends on something other than K`. So the loop's assertion is capable of failing, and the green run is not vacuous.

   **(b) Stubbing the encryption.** `encrypt_under_locker_key` was stubbed to return its plaintext. The test **failed**, but at `item-0 must be stored as ciphertext, not plaintext` — the structural predicate, **not** the raw-bytes scan. Worth recording precisely, because it means (b) proved the ciphertext guard and left the scan unproven.

   **(c) So the scan was checked on its own.** One secret was planted as **plaintext in the `title` column**, which the layer deliberately leaves unencrypted, so only the raw-bytes scan could catch it. The test **failed**: `the vault file's bytes must not contain s3cret`. The scan reads the file.

   **Result: the claim held, and it is now known to be able to fail for each of the three right reasons.** The shipped test carries all three assertions permanently.

2. **"Every row is back after the restore."** The risk is a comparison that is trivially satisfied — a census compared against itself, an empty table set, or a check that only notices a whole missing table.

   **(a) The baseline is what does the work.** `restore_drill` was called with `expected_census: None` in the drill's step 7. It **passed** — so the `Some(...)` branch is the half that compares, and the green run with a baseline is a real comparison rather than the `None` branch's "some rows exist".

   **(b) One row, not one table.** Exactly one row was deleted from the restored vault before the comparison. The drill **failed**: `restored-census: core_content_item: expected 12, restored 11; core_entity: expected 14, restored 13; fts_core_content_item: expected 12, restored 11; …`. A single missing row is caught — and the FTS shadow tables moved with it, which is a second thing the census turns out to check for free.

   **(c) The numbers cannot be zero.** The drill refuses `census_before` outright if `total_rows == 0`, so a vault with nothing in it cannot pass by having nothing to lose. The green run reports **247 tables compared, 209 rows**.

   **Result: the claim held, and this check is why D-1020-R8 exists** — the first honest run of exactly this comparison is what reported 29 absent tables, `locker_key` among them.

A third, cheaper one, because `sha256sum` at one moment is not a claim that two files stay equal: the byte-identity of `contracts/golden/format-golden.json` with the v0 fixture is asserted **in code** by `the_contracts_copy_is_byte_identical_to_the_v0_fixture`. Flipping one byte of the contracts copy made it **fail** (`contracts/golden/format-golden.json has drifted from the v0 fixture`), and both files were confirmed back at `9a8cd304bc74f33d0562272ffd0517aad757edd3974400178667752e704d9464` afterwards. The test skips rather than fails once the v0 file is gone in wave 6.

## Wave 2 — lane B2: the feedback-time budgets, re-based for a Rust workspace

The wave-1 ledgers were seeded from a workspace of **one** crate over clap and serde_json. It holds **ten** now, over iroh, quinn, tokio, prost and rusqlite-bundled, with six more due in wave 2b and a Kotlin toolchain in wave 3, and the numbers no longer described anything: `cargo xtask gate --profile local` cost 1394.6 s on a cold tree against a 120 s budget, and `--profile pr` 1420.1 s against 900 s. The owner ruled on 2026-09-12, on [#1020](https://github.com/srikanth235/centraid/issues/1020): _"given that we're migrating away from ts to rust/kotlin, the earlier budget migh not hold...adjust accordingly!"_ — the one legitimate way a number in a down-only ledger rises. This lane spent that ruling once: every raised number carries its measurement, the state of the tree it was measured on and the multiplier that produced it, three numbers were **kept** because their measurement already sat under a third of the ceiling, and the ratchet code is exactly as strict as it was. It also learned to tell a warm tree from a cold one, because one budget cannot be right for both.

### What landed

`fix(xtask): scan the repository, not its build output, for secrets (#1020)`
- `crates/xtask/src/gate.rs` — `run_secrets` keeps ONE unfiltered `gitleaks detect --no-git` scan (working-tree coverage is the whole point of `--no-git`) and classifies its JSON report afterwards: a finding is dropped only where `git check-ignore` matches the file **and** `git ls-files` does not track it. `external` was split so `missing_binary` is shared by the steps that classify their own report rather than their exit code. Two tests: `only_untracked_ignored_build_output_is_dropped_from_a_secrets_report` (a tracked-but-gitignored file stays), `a_gitleaks_report_is_read_by_its_file_field`.

`feat(xtask): score the local profile warm or cold, and refuse mobile-jvm (#1020)`
- `crates/xtask/src/gate.rs` — `Tree`, `member_packages`, `tree_state`, `has_linked_artifact`, `score`, the `mobile-jvm` refusal, and `COLD_LOCAL_KEY`. Five tests: the `.rmeta`-only tree, the partially built tree, `--cold`, both scoring branches including "a cold run with no stated ceiling fails", and `pr` scored against its budget on a cold tree.
- `crates/xtask/src/measure.rs` — a key table (`cleanCheckSeconds`, `incrementalCheckSeconds`, `singleCrateTestSeconds`, `releaseBuildSeconds`, `coldLocalProfileSeconds`), `--only`, the app-crate edit for the incremental number, the heaviest crate for the single-crate number, and `take_cold_local_profile`. Four tests.
- `crates/xtask/src/main.rs` — `--cold`, `--only`, the `MobileJvm` variant.

`fix(xtask): the gate's last line is the verdict, budget included (#1020)`
- `crates/xtask/src/gate.rs` — the verdict line reads `ok`, not the step list.

`fix(xtask): name the unbuilt tree the ts-static step trips over (#1020)`
- `crates/xtask/src/gate.rs` — `run_ts_static` names an unprovisioned tree instead of emitting hundreds of `Cannot find module '@centraid/server/engine'` lines.
- `.github/workflows/gate.yml` — `bun run build` before the profile (provisioning is the workflow's job, not a charge on the profile's budget); `timeout-minutes` 20 → 40.

`chore(ledgers): re-base the feedback-time budgets for nine Rust crates (#1020)` and `chore(ledgers): re-base release-build on lane R's slower sample too (#1020)`
- `contracts/ledgers/gate-budgets.json`, `contracts/ledgers/compile-time.json` — the table below.
- `docs/decisions.md` — `### Decisions — lane B2 (#1020)`, after lane V's block.
- `docs/toolchain.md`, `docs/dev-environment.md`, `crates/xtask/README.md` — the budget sentences, the profile tables, the warm/cold rule, the measurement table.

### Every ledger number, before and after

| Ledger key | Before | Measured (tree) | Multiplier | After |
| --- | --- | --- | --- | --- |
| `profiles.local` | 120 | **24.0 s** warm at 9 members, **41.6 s** at 10 | KEPT — 35% of the ceiling | **120** |
| `profiles.pr` | 900 | **1420.1 s** cold · 575.8 s warm | 1.06 — the next round number, no further | **1500** |
| `profiles.nightly` | null | — | — | null |
| `profiles.release` | null | — | — | null |
| `profiles.mobile-jvm` | absent | — | placeholder | **null** |
| `cleanCheckSeconds` | 180 | **541.7 / 480.8 s** | 2 on the higher | **1200** |
| `incrementalCheckSeconds` | 10 | **0.6 / 0.5 s** (an app crate) | KEPT — 6% of the ceiling | **10** |
| `singleCrateTestSeconds` | 60 | **2.4 / 2.5 s** (`-p centraid-net`, repeated) | KEPT — 4% of the ceiling | **60** |
| `releaseBuildSeconds` | 600 | **240.3 / 401.0 / 475.0 s** here, **666.6 s** on lane R | 2 on the highest | **1400** |
| `coldLocalProfileSeconds` | absent | **1394.6 s** at 9 members, **1562.4 s** at 10 (clippy 626.1 + test 935.6) | 2 on the higher | **3200** |
| `kotlinNativeLinkSeconds` | absent | — | placeholder | **null** |

The `local` profile's two lines, quoted:

```
xtask gate — profile local · hardware ci-linux-x64-4c · budget 120s
  tree warm — all 10 workspace member(s) have a linked artifact in target/debug/deps
  TOTAL                41.6
  BUDGET ok — 41.6s of 120s
gate local: PASS
```
```
xtask gate — profile local · hardware ci-linux-x64-4c · budget 120s
  tree cold — 9 of 10 workspace member(s) have no linked artifact in target/debug/deps (first: centraid); an `.rmeta` from a previous `cargo check` does not count
  TOTAL              1562.4
  BUDGET cold ok — 1562.4s of the 3200s `coldLocalProfileSeconds` ceiling in contracts/ledgers/compile-time.json; the warm 120s budget was not the number scored
gate local: PASS
```

### Exit list

| Command | Outcome |
| --- | --- |
| `cargo fmt --all --check` | clean |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `cargo test -p xtask` | 37 passed (28 before this lane) |
| `cargo test --workspace` | 371 passed at the pre-lane-R head; at the current head it passed inside the cold `local` run's `test` step (935.6 s). A standalone post-rebase run could not complete — see *Not done* |
| `cargo xtask gate --profile local`, warm | PASS, 41.6 s of 120 s, `tree warm — all 10 workspace member(s) have a linked artifact` |
| `cargo xtask gate --profile local`, cold | PASS, 1562.4 s of the 3200 s cold ceiling, `tree cold` (three earlier cold attempts died on ENOSPC — see *Not done*) |
| `cargo xtask gate --profile pr` | FAIL on the two inherited reds only (`secrets`, `osv`); every other step green, `ts-static` 27.9 s green after `bun run build`. 575.8 s warm, 1420.1 s cold. Both runs predate the lane R rebase and the 900 -> 1500 budget line — not re-run, see *Not done* |
| `cargo xtask measure` | four of five keys quoted below; the fifth was measured on its own |
| `bun run format` / `format:check` | 5845 files, all correctly formatted |
| `bash .governance/run.sh` | all 10 directives passed |
| `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5` | 10 rules, no findings |
| `bun run check:push:static` | 4/4 in 212.7 s (lint, format:check, turbo:lint, typecheck:affected) |

```
xtask measure — hardware ci-linux-x64-4c · 5 of 5 key(s)
  measuring cleanCheckSeconds        `cargo check --workspace` from an empty target/
    target/ cleaned
  cleanCheckSeconds           480.8
  measuring incrementalCheckSeconds  `cargo check --workspace` after one line appended to an app crate
    one line appended to crates/apps/tally/src/lib.rs and restored
  incrementalCheckSeconds       0.5
  measuring singleCrateTestSeconds   `cargo test -p centraid-net` repeated, the heaviest crate's steady-state loop
  singleCrateTestSeconds        2.5
  measuring releaseBuildSeconds      `cargo build --workspace --release` from an empty target/release
    target/release removed
  releaseBuildSeconds         401.0
  measuring coldLocalProfileSeconds  `cargo xtask gate --profile local` with no debug artifacts on disk
    target/debug removed — the gate runner is rebuilt inside this number
  [the child gate ran to 443.1s and its `test` step died on ENOSPC; measure refused the number]
xtask: measuring coldLocalProfileSeconds: `cargo xtask gate --profile local` failed on the cold tree — the measurement is the wall clock of a PASSING run, and a failing gate has a red step to fix first

  not written — pass `--write` to update contracts/ledgers/compile-time.json
```

### Decisions — lane B2

Mirrored into [docs/decisions.md](../docs/decisions.md#decisions--lane-b2-1020) with the options each one weighed. In brief, each citing [#1020](https://github.com/srikanth235/centraid/issues/1020):

- **D-1020-B2-1** — the `local` budget is scored on a **warm** tree, detected by every workspace member having a *linked* artifact (`.rlib` or an extensionless executable) in `target/debug/deps`. Options weighed: a marker file (gameable), "`target/debug` exists" (bought by a 5 s `cargo check`), a mandatory `--cold` flag (an honesty system). Artifact presence is the only one that cannot be satisfied without having done the work, and it deliberately reads a *stale* incremental tree as warm, because that is the tree the loop runs on. A cold `local` run is charged against `coldLocalProfileSeconds` and **fails** when that key states no ceiling. Supersedes lane B's "local under 2 minutes after `cargo clean`" reading and answers lane C's owner hand-off 2.
- **D-1020-B2-2** — every number is measurement × a stated multiplier. Default 3; **2** for the three large cold numbers, because 3× of a number that size is a ceiling no regression reaches and a budget nobody can miss is a log; **1.06** for `pr`, the next round number above its measurement and no further; **2 on the highest sample** for `releaseBuildSeconds`, because it is the one compile-time number a pull request goes red on and this container's samples spread 2.8×. Three keys kept their ceiling and say so.
- **D-1020-B2-3** — `pr` stays Rust-only at 1500 s, recorded against #892's rung table: CI restores a Cargo cache, so the warm run (575.8 s) is the p95 the rung budgets and 1420.1 s is the cache-miss tail. Kotlin gets `mobile-jvm` and `kotlinNativeLinkSeconds`, both null, both wave 3 lane E's to measure; `--profile mobile-jvm` refuses.
- **D-1020-B2-4** — no `approvedDeviation`, waiver or override was added. `ledger.rs`'s `a_risen_number_is_a_finding` still fails a raise against an existing base copy; **the re-base passed the `ledgers` step only because `origin/main` carries no `contracts/ledgers/` yet**, so the base copy is `None` and every entry reads as new. Once #1020 merges these are the baseline and only fall.
- **D-1020-B2-5** — under the owner's correctness ruling ([R-1020-35](../docs/decisions.md#decisions--lane-v-1020)), lane C's owner hand-off 1: the `secrets` step scans the repository, not its build output. One scan, a report filtered by git's own answer to "is this a file we wrote?", both counts printed, `.gitleaks.toml` untouched. The alternative — one `gitleaks dir` per non-ignored top-level entry (71 of them) — measured 46.5 s against 2.7 s, because gitleaks compiles its ruleset per process.

### Demonstrated reds

- **The cold-with-no-ceiling branch.** Before `coldLocalProfileSeconds` existed, the 1394.6 s cold run printed `BUDGET cold — the 'local' profile took 1394.6s and contracts/ledgers/compile-time.json states no 'coldLocalProfileSeconds' ceiling for ci-linux-x64-4c. An unscored run is not a pass` and exited non-zero. With the ceiling in place the same run passes and names the ceiling it was charged against.
- **The verdict line.** That same run also printed `gate local: PASS` underneath its budget failure, while exiting non-zero. Fixed; the verdict now reads the budget too, and a green-steps-over-budget run says `FAIL — over budget`.
- **`measure --write` reported `HELD <key> at <the measurement>`** for a key it had just inserted, because the insert seeded `budgetSeconds` before the comparison read it — a ceiling pinned to one run while the note claimed nothing had moved. Caught by `the_writer_lowers_holds_and_sets_but_never_raises`, which fails on the old code.
- **`secrets` on a built tree.** Six `.rmeta` false positives were lane C's hand-off; the fixed step reports `1 secret finding(s) in repository files (first: packages/model-runtime/LICENSES.md); 4 finding(s) dropped in files .gitignore excludes and git does not track (build output, e.g. target/debug/deps/libpem_rfc7468-a5a5ad3ac995aa15.rmeta)`. Four rather than six because the scan ran against a tree built to a different point; the count is whatever iroh's PEM doc strings are compiled into at scan time, which is exactly why it cannot be an allowlist row.
- **`ts-static`.** On an unbuilt tree it reported `packages/server/src/serve/build-gateway.ts(4297,40): error TS` and 200-odd `Cannot find module '@centraid/server/engine'` lines. It now reports the unprovisioned tree by name, and passes (27.9 s) once `bun run build` has run.
- **`mobile-jvm`** refuses rather than passing with no steps: `REFUSED the 'mobile-jvm' profile is a ledger placeholder with no steps … wave 3 lane E … measures them and sets them`, exit non-zero.
- **`release`** still fails on `vps-smoke` (lane R made `restore-drill` real), so the profile cannot pass vacuously.

### Findings outside the slice

- **A cold `local` run compiles the dependency graph twice** — clippy 587.6 s and `cargo test --workspace` 806.5 s, check units then linkable artifacts. It is over half the 1394.6 s and it is what the issue's structural answers (sccache, mold or lld) are for. No fix attempted here; recorded as the number the next tooling wave is measured against.
- **`cargo test -p centraid-net` and `cargo test --workspace` invalidate each other's artifacts** — 185.8 s and 161.7 s on the switch against 2.4 s for either command repeated, because one package's feature resolution is not the workspace's union. The gate runs `--workspace` and a developer iterating runs `-p`, so the loop pays this every time it changes shape. The structural answers are one `cargo test` shape for both, or a `[workspace] default-members` that makes them the same graph. Not fixed; `singleCrateTestSeconds` was NOT widened to absorb it.
- **`gate.yml`'s job timeout was below its own gate's cold cost** — 20 minutes against a 1420.1 s `pr` run plus provisioning. A run the runner kills cannot report the budget it is scored against. Raised to 40 in this lane because it is the CI-side knob the budget semantics needed.
- **`releaseBuildSeconds` is contention-sensitive on this hardware class** — 240.3 / 401.0 / 475.0 / 666.6 s for the same command on the same container, depending on which other lanes were building. Any per-step wall-clock ceiling scored on a shared runner inherits that spread; this is why the ceiling took 2× the highest sample rather than the median.
- **One `cargo xtask measure` run died inside `cc-rs`** (`command did not execute successfully … "cc" "-O2"`) while building rusqlite-bundled at roughly 4 GB free. The measurement correctly refused to record a number off a failing gate. Worth knowing for any lane measuring on a shared allowance: the failure surfaces as a compiler error, not as a disk error.
- **`ts-static` runs v0's whole-repo static gate because five v1 helper scripts are TypeScript** (`contracts/tools/*.ts`). #1020 ruled v0's gates off pull requests; this step puts the largest of them back on, under another name, for five files. Owner hand-off 3.

### Owner hand-offs

1. **`pr` at 1500 s against a rung-2 wall clock of 15 minutes.** The reading adopted is that the rung number budgets the **p95** (a Cargo-cache hit, 575.8 s) and this ledger number is the tail a cache miss must not exceed. Options if that is not the reading you want: (a) accept it as recorded; (b) hold `pr` at 900 s and require the structural work (sccache, mold or lld, a smaller `test` step) that brings the cold number under it, which would red the gate until that work lands; (c) split the cold case into a separate profile. Recommendation and what is in the tree: (a), with (b) as the target for the next tooling wave.
2. **Two inherited reds are unchanged and unhidden**: gitleaks on `packages/model-runtime/LICENSES.md`, and `astro@7.1.5` (CRITICAL 9.8) in `bun.lock`. Nothing was added to `.gitleaks.toml` or `osv-scanner.toml`. Lane C's hand-off 1 — the `target/` `.rmeta` findings — is **closed** by D-1020-B2-5.
3. **`ts-static`'s scope.** Options: (a) keep it (the five `contracts/tools/*.ts` files get the only static check there is, at 27.9 s warm plus a provisioning build); (b) add a v1-only typecheck script and point the step at it; (c) move those five scripts out of the v1 directories. Recommendation: (b). Adopted for now: (a), because no v1-only script exists and dropping the check would leave those files ungated.
4. **The cold first build is 1394.6 s.** That is the bill a new clone or a cold CI cache pays today, at nine crates of fifteen. It is ledgered rather than hidden, and it is the number that decides whether wave 2b lands with sccache or without.

### Not done, and why

- `library-size.json` was not touched. It is seeded empty by design and wave 3 lane G fills it; there is no artifact to measure.
- No `nightly` or `release` measurement was taken. Both are unbounded by ruling, `nightly` needs the v0 oracle build, and `release` fails on `vps-smoke` regardless.
- **Three cold runs and one standalone `cargo test --workspace` died on `No space left on device`**, and one of those surfaced as `error occurred in cc-rs` rather than as a disk error. This container's disk allowance is shared with concurrent lanes and a cold debug tree for this workspace is 7-8 GB; the fourth attempt, taken when 16 GB was free, completed green and is the number in the ledger. What this cost the exit list: the `pr` profile was not re-run after the lane R rebase (its `release-build` step needs a release tree alongside the debug one), and `cargo test --workspace` was not run standalone at the current head — it ran inside the green cold `local` gate instead, which is the same command through the same runner. The `pr` budget's arithmetic is unaffected: the only thing that changed for it is the ledger line it is compared against.
- `measure` does not run the warm `local` and warm `pr` profiles as ledger keys. Their numbers are the gate's own output, scored by the gate against `gate-budgets.json`; adding a second timing path for the same wall clock would give one number two writers.

### Falsification

1. **"An `.rmeta`-only tree reads as cold, so a `cargo check` cannot buy a warm budget."** The unit test builds that tree from fixture files, which proves the predicate and not the world. Throwaway check on the real workspace: after `cargo xtask measure --only cleanCheckSeconds` — which leaves a tree that has been fully checked and nothing else — `cargo xtask gate --profile pr` printed `tree cold — 8 of 9 workspace member(s) have no linked artifact in target/debug/deps`, and its `test` step then took 1072.1 s compiling and linking what the check had not. The 9th member is `xtask` itself, which cargo had just built to run the command; the rule requires **all** members, so one built member cannot make a tree warm.
2. **"The secrets filter drops build output and never a tracked file."** The risk is a tracked file that matches a `.gitignore` pattern being dropped silently — a real secret hidden by the fix. Throwaway check: a fixture repo with `kept.log` tracked via `git add --force` against a `.gitignore` that lists it; `git check-ignore` honours the index, so the file is not reported as ignored and the classifier keeps it, and the tracked-file probe would keep it even if that changed. On the real tree the same run kept `packages/model-runtime/LICENSES.md` (tracked) and dropped four `target/debug/deps/*.rmeta` (untracked, ignored) — the exact split claimed.

### Doctrine digest

Law `53be88c22ab5`. `.governance/run.sh` all directives pass; `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5` no findings. No waiver spent, no law file touched (`.governance/**`, `CONSTITUTION.md`, `scripts/ci/gate-classes.json`, `tests/*.json`, `oxlint.config.ts`, `oxfmt.config.ts`, `.github/CODEOWNERS` are all untouched); `.github/workflows/gate.yml` is territory and is cited to [#the-pr-gate-loop-892](../docs/decisions.md#the-pr-gate-loop-892) through D-1020-B2-3. No v0 file under `packages/**` or `tests/**` was edited, so this lane lists no fixture-adapter edits.

## Wave 3 — lane G: the deploy tree, the CI lanes, the prebuilt core and the release smoke

### What landed

**`f64ede94` — one deploy tree, and service units as a CLI verb.**
`deploy/README.md`, `deploy/docker/Dockerfile` (new, the v1 image), `deploy/docker/gateway-v0.Dockerfile` (`git mv` from the root `Dockerfile`, unchanged), `deploy/systemd/centraid-gateway.service`, `deploy/systemd/system/centraid-gateway@.service`, `deploy/launchd/dev.centraid.gateway.plist`, `deploy/vps/install.sh`, `contracts/deploy/units/{README.md,export-v0-units.ts,centraid-gateway.user.service.expected,centraid-gateway@.system.service.expected,dev.centraid.gateway.plist.expected}`, `crates/centraid/src/cmd/{units.rs,gateway_install.rs,doctor.rs,mod.rs}`, `crates/centraid/src/main.rs`, `crates/centraid/tests/gateway_install.rs`, `crates/centraid/tests/no_listener.rs`, `crates/centraid/README.md`, `.github/workflows/{ci.yml,lane-gateway-package.yml,lane-release-gateway-image.yml}` (the moved Dockerfile's path), `ARCHITECTURE.md`, `TESTING.md`, `flake.nix` (stale path references).

**`11282c87` — the artifact key, the identity stamp and the prebuilt-core lane.**
`crates/xtask/src/artifact.rs`, `crates/xtask/{Cargo.toml,src/main.rs}`, `crates/centraid/{build.rs,src/identity.rs,src/main.rs}`, `.github/workflows/lane-prebuilt-core.yml` (new), `.github/workflows/{gate.yml,release.yml}`, `Cargo.toml`, `Cargo.lock`.

**`86ffd20e` — the dev loop carries line tables, and `dist` is what a tag ships.** `Cargo.toml`.

**`e174ca68` — the CI re-homes, the WAL capture tick and a real `vps-smoke`.**
`crates/xtask/src/{ci.rs,smoke.rs}` (new), `crates/xtask/src/{gate.rs,main.rs}`, `crates/centraid/src/cmd/{capture.rs,backup.rs,mod.rs}`, `crates/centraid/src/run.rs`, `crates/net/src/endpoint.rs` (one new method — see finding 1), `contracts/ledgers/advisory.json` (new).

**`9fb2d81f` — device lanes with a runner contract, the flake check and the candidate.**
`.github/workflows/gate-nightly.yml`, `.github/actionlint.yaml`, `.github/workflows/lane-prebuilt-core.yml`, `deploy/docker/Dockerfile`, `deploy/vps/install.sh`, `contracts/ledgers/library-size.json`, `tests/journeys.json`, `crates/xtask/README.md`, `docs/{release.md,toolchain.md}`.

**`fa003e51` — the `dist` split re-judged against lane B2's re-based ceilings.** `Cargo.toml`, `docs/toolchain.md`, `crates/xtask/src/smoke.rs`.

### Exit list

| # | Command | Outcome |
|---|---|---|
| 1 | `cargo test --workspace` | **PASS** — 0 failures across every member; `cargo test -p xtask` is 58 tests, `-p centraid` 40 |
| 2 | `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check` | **PASS**, clean |
| 3 | `cargo xtask gate --profile local` | **PASS** — 127.0 s. Over the 120 s **warm** budget and the run was scored **cold** (10 of 10 members unlinked), so it was charged `coldLocalProfileSeconds` = 3200 s and held. `test` is 102.7 s of the 127.0 |
| 4 | `cargo xtask gate --profile pr` | **258.8 s of 1500 s**, `BUDGET ok`, cold. Green except three: `secrets` (2 findings — finding 3), `osv` (`astro@7.1.5`, the named inherited red), `ts-static` (unprovisioned tree; green after `bun run build`, item 5) |
| 5 | `cargo xtask gate --profile release --lane ts-static` | **PASS** — 25.6 s, `bun run check:push:static`, after `bun run build` — the step's own message diagnosed it correctly as an unprovisioned tree rather than a type error |
| 6 | `cargo xtask gate --profile release --lane vps-smoke` | **PASS — 74.0 s.** The wave 3 exit criterion; transcript quoted below |
| 7 | `cargo xtask gate --profile release --lane artifact-identity` | **PASS** — the refusal line is quoted below |
| 8 | `cargo xtask gate --profile release --lane prebuilt-core-required` | **PASS** — three required triples, three distinct keys: `x86_64-unknown-linux-gnu 4ab33d7a2d12bd26`, `aarch64-apple-darwin d20c9afb7fb58370`, `x86_64-pc-windows-msvc 74bb9f0034869e33` |
| 9 | `cargo xtask gate --profile release --lane restore-drill` | **PASS** — 28.0 s, lane R's step, unchanged by this lane |
| 10 | `bun run lint:workflow-pins` | **PASS** — 26 workflows clean (SHA pins, bun pin, timeouts, single PR + release entry point) |
| 11 | `bun run lint:ci-egress` | **PASS** — 6 workflows enforce a policy, 16 pinned as debt; `lane-prebuilt-core.yml` enforces `audit` |
| 12 | `bun run lint:path-filters`, `bun run lint:journey-ledger`, `bun run lint:ledgers` | **PASS** each |
| 13 | `actionlint` (pinned 1.7.12, whole `.github/`) | **PASS**, clean. `devices` is declared in `.github/actionlint.yaml` |
| 14 | the 21 `ci.yml` job keys | **unchanged** — `21 21 / identical: True` from a key extractor run over `git show 6e2bd750:.github/workflows/ci.yml` and the working copy |
| 15 | `cargo xtask artifact-key` on two trees differing by one byte in `contracts/` | **different, and reverting restores it** — quoted below |
| 16 | `docker build -f deploy/docker/Dockerfile .` | **NOT PROVEN HERE** — finding 4 and an owner hand-off |
| 17 | `bun run format` + `format:check` | **PASS** — "All matched files use the correct format" |
| 18 | `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5`; `bash .governance/run.sh` | see the report |
| 19 | `bun run check:push:static` | **PASS** — through the `ts-static` step, item 5 |

### The `vps-smoke` transcript, summarised

`cargo xtask gate --profile release --lane vps-smoke` → **ok, 74.0 s**, over three clean containers of `debian:trixie-slim@sha256:d7e1218…` (digest-pinned for the same reason `deploy/docker`'s bases are):

- **pass 1, first boot.** `deploy/vps/install.sh --local … --sums …`: `checksum ok`, `identity ok (gitSha, digest, schemaVersion all match the release)`, `installed /usr/local/bin/centraid`, and then the two commands it did **not** run. `centraid gateway install --system --dry-run` printed a `DynamicUser=yes` system unit and `/etc/systemd/system` was byte-for-byte the same before and after — checked by listing it, not by trusting the message. The gateway **FOUNDED a new vault** (`centraid: vault 2c96e477-…`), minted a ticket, and a seat redeemed it over iroh with `--no-relay`. The RPO capture tick ran (`wal/tick.json`: `{"ticks":1,"segments":0,"lastSegment":null}`), `centraid backup now --force` took generation 1, and `centraid doctor --data-dir /data --json` was clean.
- **pass 2, restart over the same data directory.** `opened the existing vault (no second vault founded)` — asserted by the ABSENCE of the founding line, so a second vault would be a red. Paired again, tick ran, doctor clean.
- **pass 3, the negative.** The same tarball and the same `SHA256SUMS` with **one character of the digest changed** in `identity.json`: `install.sh: IDENTITY MISMATCH on digest: the release says 'zev', the binary says 'dev'. This artifact is not the one this release published — refusing to install it.` Exit 1, nothing installed.

**Two things the smoke does not claim, and says so in its own line.** The WAL tail is **empty** — nothing writes to the vault after it is founded until the durable allowlist lands (D-1020-C8, wave 2 lane D2), so a tick that seals nothing is correct rather than broken, and the smoke prints the segment count instead of asserting it non-zero. And a restart **re-pairs** rather than reconnecting the previous seat, for the same reason. The capture mechanics themselves — per-tick offsets, a checkpoint bumping the group, resume across a restart, a pending line whose blob is missing being refused — are proved by six unit tests in `crates/centraid/src/cmd/capture.rs` over a WAL that does grow.

### The artifact key, the identity stamp, the sizes

```
$ cargo xtask artifact-key --triple x86_64-unknown-linux-gnu --profile release
7e8e0864c825f2fd70c315f4b6ca0d36fae888e8615490c13ce3dc2b4dbbdd3d
$ printf '\n' >> contracts/README.md && cargo xtask artifact-key --triple … --profile release
103bacad05a560bb6f2cf3aa6431c973be9aaf222baac2cbb9e1d3edc07db9d2
$ git checkout contracts/README.md && cargo xtask artifact-key --triple … --profile release
7e8e0864c825f2fd70c315f4b6ca0d36fae888e8615490c13ce3dc2b4dbbdd3d
```

One byte in `contracts/` moves the key and reverting restores it. The `Cargo.lock` half of the rule is proved by unit test both ways (`a_cargo_lock_change_moves_the_key_only_when_the_resolved_graph_changes`): a reordered `dependencies` list and an added comment do **not** move it; a version bump does; and a checksum change at the **same** version does, which is the yanked-and-republished case a version-only rule would miss. `a_ledger_write_does_not_move_the_key` holds the other half — a ledger is evidence about an artifact, not an input to it, or every measurement would re-key the thing it measured.

The identity refusal, quoted from `crates/centraid/src/identity.rs`: `STALE CORE REFUSED: this shell was built against core digest {expected}, and the core it loaded reports {digest} (git {sha}, schema {version}). Refusing to answer a single call: a core from another tree starts, answers, and answers from the wrong schema.` An **empty** expectation is refused too — that is a build that forgot to record which core it was built against, and treating it as a match is what would make the whole scheme decorative. A `dev` build is allowed and returns a warning that says the check did not run.

**Sizes.** `contracts/ledgers/library-size.json` takes its first measured entry: `x86_64-unknown-linux-gnu.strippedBytes = 23067264` (22.0 MiB), from `cargo build --profile dist --bin centraid` then `objcopy --only-keep-debug` + `--strip-debug --add-gnu-debuglink`; the symbol file beside it is 73,679,584 bytes. The other twelve published triples are **`null`** and are listed rather than omitted: this container is Linux x64 with no macOS runner, no Xcode, no NDK and no Windows host, and a projection from the x64 number would be indistinguishable from a measurement six months from now.

### v0 CI shapes: re-homed vs. still running under `ci.yml`

| Re-homed into `cargo xtask` | From | Where it runs now |
|---|---|---|
| `advisory` | `scripts/ci/advisory-expiry.mjs` | `pr` |
| `lockfile` | `scripts/ci/lockfile-lint.mjs`, extended to `Cargo.lock` | `pr` |
| `lane-health` | `scripts/ci/lane-health.mjs` | `nightly`, and `cargo xtask lane-health` |
| the per-PR evidence row | `scripts/test-report/write-evidence.mjs` | every profile, `target/xtask/<profile>/evidence.json` |
| the wall-clock scorer | `scripts/ci/pr-gate-wall-clock.mjs` | already the budget table (wave 1 lane B, re-based by B2) |
| the candidate pointer | `candidate.yml`'s `promote` | `gate-nightly.yml`'s `promote-candidate`, on a green nightly |

**Still running under `ci.yml` on `push: main` and its own nightly schedule, none deleted, all 21 job keys byte-identical:** `changes, static, gates, verify, web-build, docs, oauth-worker, gitleaks, osv-scanner, dependency-review, mobile-smoke, iroh-wasm, data-plane, gateway-package, extension, design, quality, perf, scale, e2e-smoke, check`. The four `scripts/ci/**` groups not re-homed are v0 governance that retires with v0: the `run-gates.mjs`/`gate-classes.json` runner, the turbo and mutation ratchets, the device/toolchain lease scripts (`device-farm-lease.sh` is now *called* by the device lanes rather than replaced), and the candidate resolve/write scripts (`write-candidate.mjs` is now *called* by `promote-candidate`).

### Decisions — lane G

Adopted under R-1020-34 (options, recommendation, adopt), each citing [#1020](https://github.com/srikanth235/centraid/issues/1020).

- **D-1020-G1 — `deploy/` is the one home; the v0 image moves with history and keeps shipping.** Options: (a) rewrite the root `Dockerfile` into the v1 image in place, (b) add a v1 image beside an untouched root `Dockerfile`, (c) `git mv` the v0 image into `deploy/docker/gateway-v0.Dockerfile` and add `deploy/docker/Dockerfile` as the v1 one. **(c) adopted.** (a) would have broken `lane-release-gateway-image.yml` and `lane-gateway-package.yml`, which is deleting a v0 lane by another name; (b) leaves the deploy tree half-populated. Both workflows and `ci.yml`'s path filter were repointed to the new path — a re-home, not a deletion.
- **D-1020-G2 — the key and the stamp are two mechanisms, and the exact rule is written down.** `cargo xtask artifact-key`'s five inputs, with `contracts/ledgers/` excluded and `Cargo.lock` reduced to its resolved graph, are in `crates/xtask/src/artifact.rs`'s module doc and in `docs/release.md`. The stamp lives in `crates/centraid` and **not** `crates/core`, because lane D2 had not landed when this was written; the module names the move rather than implying it, and the JSON field names are already `gitSha`/`digest`/`schemaVersion` so lane E's KMP assertion has a contract to write against today.
- **D-1020-G3 — a CI-shape gate moves into the gate that replaced the workflow; it is never dropped.** The advisory register reads **both** `contracts/ledgers/advisory.json` and `tests/inventory.json#advisory` (law estate, not editable from a territory commit), so there is exactly one row per step between the two files and neither carries a copy of the other's. Options considered: duplicate the two v0 rows into the v1 ledger (rejected — two copies of one row drift), or leave the rule in v0 only (rejected — it would come off pull requests with `ci.yml`).
- **D-1020-G4 — a device lane is a loud skip with a runner contract, and the contract lives in the runner.** `CENTRAID_DEVICE_RUNNER` flips `device-lanes` from skipping to REQUIRING `xcrun devicectl list devices` (a physical iPhone — not `simctl`, which lists simulators, the exact gap `tests/quarantine.json#lanes.device-rung-ios` is parked on) and `adb devices`. A runner that claims the label and has no phone goes **red**: that is an infrastructure fault, not a skip. `--lane <name>` narrows a run to one cell, and a name matching nothing is an error rather than an empty run that would report PASS over zero steps.
- **D-1020-G5 — the release profile's four steps, and `vps-smoke`'s device-less form.** `restore-drill` + `artifact-identity` + `prebuilt-core-required` + `vps-smoke`. The old placeholder test (`the_placeholders_fail_rather_than_skip`) was replaced by `no_step_in_the_release_profile_is_a_stub`, which greps this file for the stub sentence — the rule was never about the message, it was that the profile cannot pass vacuously.
- **D-1020-G6 — the flake stays honest without a fabricated pin.** Options: (a) install nix with a SHA-pinned third-party action, (b) install it from a pinned release URL, (c) do neither and check what is checkable. This repository has no pin for either installer shape, and **inventing one in the file whose whole subject is pinning** is the worst available outcome — so **(c)**: `gate-nightly.yml`'s `flake` job asserts that `flake.nix` reads the channel out of `rust-toolchain.toml` and carries no second literal of it, and states in the run summary that the flake has never been evaluated. The first evaluation is an owner hand-off.
- **D-1020-G7 — the edit-run loop carries line tables, not full DWARF.** Measured on the shared target directory: **16 GB** under `debug/`, of which **7.7 GB was 144 test and bin executables** (the four `centraid` ones 363–387 MB each) and 4.3 GB rlibs. `[profile.dev]`/`[profile.test]` at `debug = "line-tables-only"` with `split-debuginfo = "unpacked"`, and `[profile.dev.package."*"] debug = false` beside the existing `opt-level = 2`, take the same set to **0.50 GB over 39 executables**, largest **43.1 MB** (−89 % on the biggest single artifact), with 0.03 GB of split DWARF beside it. A backtrace still names file and line; `CARGO_PROFILE_DEV_DEBUG=2 cargo test -p <crate>` restores the rest for one command and is written in `crates/xtask/README.md`. No test inspects a backtrace's contents, so `debug = 1` was not needed. **The directory total does not fall until a clean**: cargo does not garbage-collect artifacts from a previous profile, so `du` over the shared `target/` keeps showing the old bytes until someone clears it — the honest number is the per-artifact one above.
- **D-1020-G8 — two optimised profiles, and the second reason is the one that survives.** `release` (what a pull request builds and `release-build` scores) and `dist` = `release` + `lto = "thin"` + `codegen-units = 1` + the debuginfo settings (what a tag publishes). Measured cold on `ci-linux-x64-4c`, contended: LTO + `codegen-units = 1` put `cargo build --workspace --release` at **1039 s** (and `--bin centraid` alone at 630 s); the debuginfo settings alone at **747 s**; the profile as it stands at **379 s**. The split was first made against the old 600 s `releaseBuildSeconds` ceiling, which 1039 s broke. Lane B2 has since re-based that ceiling to **1400 s**, so 1039 s would now fit — and the split stays on the argument that survives the number: it spends ~70 % of the 1500 s `pr` budget on inlining only the published artifact consumes. **What it costs is stated too:** the binary a pull request builds is not bit-identical to the one a tag ships, so `vps-smoke` smokes `release` and the `dist` artifact is proved by `lane-prebuilt-core.yml`, which builds it, stamps it and reads the stamp back **out of the binary** before publishing.
- **D-1020-G9 — the WAL capture tick runs in the gateway and its pending tail is on disk.** Lane R named the missing tick as a gap. Options: (a) an in-process buffer (rejected — `centraid backup now` is a separate process and could not see it), (b) the CLI captures the tail itself (rejected — a second capturer with its own idea of where the last segment ended), (c) the gateway appends one line per tick to `<data-dir>/wal/pending.jsonl` and writes the sealed bytes to the blob store; `backup now` reads it and retires it **after** the manifest naming those segments is written. **(c) adopted.** A crash between the blob write and the index append leaves an orphan blob rather than a manifest pointing at a blob that is not there — a blob nothing points at is garbage; the other way round is a generation that cannot be replayed. The gateway holds the vault's **one writable connection open** for the process lifetime, which is also what makes the tick have bytes at all: in WAL mode SQLite checkpoints and removes the `-wal` file when the last connection closes.
- **D-1020-G10 — a redemption waits for the peer's close.** See finding 1.

### Demonstrated reds

1. **`a_dry_run_prints_the_unit_and_leaves_the_home_directory_untouched`** — before the assertion existed, `--dry-run`'s guarantee was a sentence in a message. The test lists every file under a temporary `HOME` before and after and compares the sets.
2. **`the_user_unit_is_byte_identical_to_the_v0_generator`** — the two fixtures under `contracts/deploy/units/` were written by **v0's own** `buildSystemdUnit`/`buildLaunchdPlist` (regenerable with `bun run contracts/deploy/units/export-v0-units.ts`, verified byte-identical with `cmp`). Changing one character of `systemd_quote`'s bare-character set reds it.
3. **`a_past_revisit_date_is_a_finding`** — the same advisory row passes at `2026-09-11` and fails at `2026-09-12`, so the failure is about the date and not about the row.
4. **`a_mismatched_digest_is_refused_and_both_digests_are_named`** — and its companion `an_empty_expectation_is_refused_rather_than_treated_as_a_match`, which is the failure mode that would have made the identity scheme decorative.
5. **`an_unknown_lane_name_is_refused_rather_than_running_nothing`** — `--lane no-such-lane` errors instead of selecting zero steps and reporting PASS.
6. **`a_pending_line_whose_blob_is_missing_is_refused`** — a tail line naming a blob the store cannot produce fails at `backup now` rather than at restore time.
7. **`a_checkpoint_that_shortens_the_wal_starts_a_new_group_at_offset_zero`** — without it, two different byte ranges would seal under one address and, with a deterministic nonce, under one nonce.
8. **The `vps-smoke` step itself reproduced finding 1** three times before it passed, and its pass-3 negative reproduces the identity refusal on every run.

### Findings outside the slice

1. **A pairing race: the gateway enrols the device and tells the member pairing failed.** `pairing::serve_redemption` writes and flushes its `PairResponse` and returns; the accept loop then dropped the `Connection` on its next iteration, and dropping an iroh connection sends CONNECTION_CLOSE at once, which QUIC uses to discard stream data the peer has not read. The seat printed `centraid: i/o: connection lost` while the gateway logged `a device paired` — and because the ticket is one-shot, the member's second attempt is **refused**. Reproduced by the release smoke in two of two passes. **FIXED at its source under R-1020-35** (D-1020-G10): `IrohConnection::closed()` is a new method on `crates/net/src/endpoint.rs` (no existing behaviour changed) and `crates/centraid/src/run.rs`'s accept loop awaits it with a 10 s backstop after answering. **This is a cross-lane edit** — `crates/net` is lane C/D2's file — and it is one added method plus its caller; the root should route the review.
2. **`centraid seat|devices|export`'s README rows were stale.** `crates/centraid/README.md` still said `backup now`, `recover` and `export` exit 3, which wave 2 lane R made real. Corrected in `f64ede94` along with the `doctor` and `gateway install` rows. Stale docs are bugs.
3. **`secrets` now reports TWO findings, and the new one is a `contracts/` fixture.** `contracts/golden/format-golden.json` — lane R's cross-language format golden, which is AEAD ciphertext and test-vector key material by construction — joins the named `packages/model-runtime/LICENSES.md` red. **Nothing was added to `.gitleaks.toml`**: a gate whose first act is to widen its own allowlist has gated nothing, and the census records the precedent that the number moving is not a licence to suppress. This is an **owner hand-off**, and the decision is a real one: either a reasoned allowlist row naming the golden (with the argument that a published test vector is not a secret) or moving the key material out of the fixture.
4. **`docker build -f deploy/docker/Dockerfile .` cannot be proven on this machine.** The build reaches the toolchain assertion and passes it (`toolchain 1.94.1 matches rust-toolchain.toml`), then fails fetching the crates.io index: `[60] SSL peer certificate or SSH remote key was not OK (SSL certificate problem: self-signed certificate in certificate chain)`. This host's outbound HTTPS goes through an agent proxy whose CA is not in the container's trust store; it is an environment limitation and not a Dockerfile defect. **One real fix came out of the attempt**: the first version copied `rust-toolchain.toml` into the build stage, which made rustup try to sync the channel on every build — a network round-trip per build and, here, a TLS failure whose message said nothing about Centraid. The file is now compared rather than installed, and a mismatch fails loudly with both version numbers. Owner hand-off below.
5. **`local` is over its warm budget on this tree.** 127.0 s against 120 s, of which `test` is 102.7 s. The run was correctly scored **cold** by B2's detector and charged the 3200 s cold ceiling, so the profile passed — but the warm number is what the budget is about, and it is now over. No ledger number was touched. This is lane B2's open question (b): `local` runs the changed crates' tests and `pr` keeps the workspace run.
6. **`tests/journeys.json`'s twelve v1 mobile entries now name their lane** and **no number was promoted.** Each `_intended` cell gained a `lane` field naming the `gate-nightly.yml` cell that will measure it and restating R-1020-20 in the same sentence: a parked ceiling is promoted by the first run on a named reference device, never by a lane existing.

### Owner hand-offs

1. **Branch protection must be repointed** — still open since wave 1. `gate` **and** `dependency-review` are the required checks; until then pull requests block.
2. **The real VPS run.** The exact commands and the transcript to expect are in [docs/release.md](../docs/release.md#owner-hand-off--the-real-vps-run). What the container cannot prove and that run must: that `DynamicUser` + `StateDirectory` actually start (the system unit has never been loaded by a real systemd), that `systemd-creds` hands the secret over, that the service survives a reboot, and that a seat on another machine pairs across a real network rather than over loopback.
3. **`docker build` on a host with ordinary egress**, or with the proxy CA added to the container's trust store: `docker build -f deploy/docker/Dockerfile -t centraid-gateway:v1 .`, then record the image size. Finding 4.
4. **A self-hosted macOS runner with one iPhone (XR/iOS 17) and one Android (Galaxy A55) attached**, and `vars.CENTRAID_DEVICE_RUNNER=true` to enable the four device cells. Open question 13.
5. **Signing and notarisation enrolment** for the desktop and mobile surfaces — lanes F and E own their sections of [docs/enrollment.md](../docs/enrollment.md).
6. **The first `nix flake check`**, then commit `flake.lock` and add the pinned nix installer `gate-nightly.yml`'s `flake` job deliberately does not fabricate. D-1020-G6.
7. **The `secrets` decision on `contracts/golden/format-golden.json`** and the standing `LICENSES.md` and `astro@7.1.5` reds. Finding 3.
8. **The first real `prebuilt-core` matrix run** fills the twelve `null` triples in `contracts/ledgers/library-size.json` and produces the first `dist` artifact measurement on a non-x64 platform.

### Splices owed

`contracts/handoff/{F,E}/` did not exist at the rebase onto `6e2bd750`, so **no lane F or lane E step function was spliced**. What is prepared for them: `gate-nightly.yml`'s four device cells call `cargo xtask gate --profile nightly --lane <name>` and `device-lanes` FAILS on a real device runner rather than reporting lanes it did not run; `lane-prebuilt-core.yml`'s `android` and `ios` jobs are gated on `crates/core-ffi`'s presence with a loud run-summary line, and the Android job publishes the four ABIs in the AAR's `jni/<abi>/` layout while saying the AAR is **not** assembled because the JNI initializer class is lane E's. The iOS deployment floor is declared once, in that job's `IPHONEOS_DEPLOYMENT_TARGET`, for lane E's `Package.swift` to read.

### Falsification

The two riskiest claims in this diff, and the throwaway check run against each.

1. **"The Rust unit generators emit exactly what v0 emits."** A port proved by reading is a port nobody checked. Check: regenerated both fixtures with `bun run contracts/deploy/units/export-v0-units.ts` into copies, then `cmp` against the committed files — byte-identical — and then deliberately widened `systemd_quote`'s bare-character set by one character and confirmed `the_user_unit_is_byte_identical_to_the_v0_generator` goes red. The fixtures are v0's output, not this lane's.
2. **"The capture tick is running."** The first version of the smoke asserted a non-empty `pending.jsonl` and failed; the temptation was to conclude the loop was broken. Check: ran the real release binary on the host for 100 s with `--data-dir /tmp/gwtest` and read `wal/tick.json` — `{"ticks":1,"segments":0,"lastSegment":null}`. The loop is alive and there is genuinely nothing to capture, because nothing writes to the vault after it is founded until D2's durable allowlist lands. That is why the smoke now asserts the **marker** and prints the segment count, and why the marker exists at all: without it, a dead loop and an idle one are the same observation.

### Doctrine digest

Law `53be88c22ab5`. `bash .governance/run.sh` all directives pass; `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5` no findings. No waiver spent. No law file touched — `.governance/**`, `CONSTITUTION.md`, `scripts/ci/gate-classes.json`, `tests/{floors,budgets,inventory,quarantine,claims}.json`, `oxlint.config.ts`, `oxfmt.config.ts` and `.github/CODEOWNERS` are all unmodified (`tests/journeys.json` is not law estate and took a non-numeric `lane` field on twelve entries). `.github/workflows/**` and `scripts/ci/**`-adjacent territory is cited to [#the-pr-gate-loop-892](../docs/decisions.md#the-pr-gate-loop-892) in every commit that touches it. No v0 file under `packages/**` was edited and no fixture adapter was needed, so this lane lists none. No model identifier appears in any file or commit message.

## Wave 2 — lane D2: the seat, the core, the five-symbol ABI, and the simulation that found two bugs

`crates/seat`, `crates/core`, `crates/core-ffi`, `crates/sim`, the failure
matrix, the `call` budget and the host half of the binding spike.

The headline is not the code. It is that **the deterministic simulation found
two real bugs on its first run**, one of which no other test in this repository
could have found — a liveness bug that left every optimistic overlay painted on
every screen for the life of a seat while *convergence passed throughout*. The
issue calls deterministic simulation the primary sync proof. It earned the
title on day one.

### What landed, by commit

**`be809629` — `feat(seat): the seat replica — applier, state, outbox, intent grammar`**

- `crates/seat/Cargo.toml`, `crates/seat/README.md`
- `crates/seat/src/lib.rs` — the crate's own docs on the three vocabularies and
  the two numbers that look alike
- `crates/seat/src/applier.rs` — the gateway's four rules plus **rule 5**,
  idempotent-by-seq; the two hooks; one transaction per commit with the cursor
  in it
- `crates/seat/src/state.rs` — `seat_state`'s DDL, `SeatPosition`, the
  watermark arithmetic
- `crates/seat/src/outbox.rs` — `seat_outbox` / `seat_outbox_settled`, the
  queue, the bounded journal
- `crates/seat/src/intent.rs` — ten `IntentState`s, nine `OVERLAY_STATES`, seven
  `GatewayStatus`es, five `OutcomeStatus`es, as **three types**
- `crates/seat/src/payload.rs` — the canonical hash, re-exported from the vault,
  with the astral-plane tests
- `crates/seat/src/chain.rs` — minted rows, synthetic ids, holds, the backoff,
  the six-step cutover as data
- `crates/seat/src/settlement.rs` — an answer is the gateway's fact, an overlay
  is this seat's
- `crates/seat/src/occ.rs` — `row_version`, and what `actual_version == 0` means
- `crates/seat/src/identity.rs`, `crates/seat/src/error.rs`
- `crates/seat/tests/common/mod.rs`, `crates/seat/tests/convergence.rs`,
  `crates/seat/tests/properties.rs`

**`21611cb5` — `feat(vault): list intent outcomes by status, for core's parked door`**

- `crates/vault/src/intents.rs` (`list_outcomes_with_status`),
  `crates/vault/tests/doors.rs`

The one edit to lane D1's crate, and it is here rather than in `crates/core`
because `sql-confinement` names five crates and `core` is not one of them. The
rule is right: a door that read the ledger itself would be a second reader of a
table this crate owns the shape of.

**`07046485` — `feat(core): the message loop — open, call, next_event, close`**

- `crates/core/Cargo.toml`, `crates/core/README.md`, `crates/core/src/lib.rs`
- `crates/core/src/handle.rs` — the four entry points, the three roles, the
  request-id and `Cancel` semantics, the poison
- `crates/core/src/events.rs` — the bounded queue, coalescing, the never-drop
  stall
- `crates/core/src/config.rs`, `crates/core/src/error.rs`,
  `crates/core/src/convert.rs` (the proto boundary), `crates/core/src/api.rs`
  (the `VaultApi` v1 twin)
- `crates/core/tests/call_budget.rs`, `contracts/ledgers/call-budget.json`

**`019bd020` — `feat(core-ffi): the C ABI — five symbols, ten clauses, each one tested`**

- `crates/core-ffi/{Cargo.toml,README.md,CONTRACT.md,cbindgen.toml,build.rs}`
- `crates/core-ffi/src/lib.rs` — the five entry points
- `crates/core-ffi/src/marshal.rs` — the unsafe surface, **confined** so miri
  can run over it
- `crates/core-ffi/src/bin/spike-fixture.rs`
- `crates/core-ffi/include/centraid.h` — generated, committed
- `crates/core-ffi/tests/{contract.rs,symbols.rs,marshal_miri.rs,spike.rs}`
- `crates/core-ffi/spike/spike.c`,
  `crates/core-ffi/spike/jna/{settings.gradle.kts,build.gradle.kts,src/main/kotlin/Main.kt}`

**`4cb1577f` — `fix(api-proto): CommandOutcome carries the commit its effect landed in`**

- `crates/api-proto/proto/centraid/core/v1/command.proto` (field 7)
- `crates/core/src/api.rs`, `crates/core/src/config.rs`,
  `crates/core/src/handle.rs` (`CoreConfig::with_clock`)
- `crates/seat/src/settlement.rs`, `crates/seat/src/sync.rs` (new)

**`2f13d7c3` — `test(sim): the deterministic simulation, and the seeds it found bugs on`**

- `crates/sim/{Cargo.toml,README.md}`, `crates/sim/src/lib.rs`
- `crates/sim/src/world.rs` — the turmoil hosts, the faults, the quiescence
  barrier
- `crates/sim/src/schedule.rs` — the seeded generator
- `crates/sim/src/invariants.rs` — the seven claims
- `crates/sim/src/protocol.rs` — the datagram framing
- `crates/sim/tests/{seeds.rs,recorded_seeds.rs}`
- `contracts/sim/failing-seeds.json`
- `crates/xtask/src/gate.rs` — the `sim` and `call-budget` steps in `pr`,
  `sim-nightly` in `nightly`, and `process_with_env` / `report_failure`
- `Cargo.toml` (`rand_chacha`, `turmoil`)

**`4807deab` — `test(seat): the wave 2 failure matrix, red-first`**

- `crates/seat/tests/failure_matrix.rs`, `crates/seat/tests/common/mod.rs`,
  `crates/seat/Cargo.toml`

**`00ffbff9` — `test(seat): the tests cargo-mutants asked for — 0 survivors`**

- `crates/seat/src/{applier,error,identity,intent,outbox,payload,settlement,sync}.rs`
  — thirty-three tests, every one for a gap a mutant found

**`6bd6b8de` — `refactor(vault): the keyset page and the convergence comparator move here`**

- `crates/vault/src/page.rs` (`KeysetPage`, `KeysetAnswer`, `Vault::keyset_page`)
- `crates/vault/src/converge.rs` (new) — the CONVERGENCE comparator and the
  readers a convergence check needs, plus `Vault::self_party_id`
- `crates/vault/src/lib.rs`, `crates/core/src/api.rs`,
  `crates/core/src/handle.rs`, `crates/core/tests/call_budget.rs`,
  `crates/core-ffi/{Cargo.toml,src/bin/spike-fixture.rs,tests/spike.rs}`,
  `crates/sim/{Cargo.toml,src/invariants.rs,src/world.rs,tests/seeds.rs}`

The `sql-confinement` rule's own finding, and the most useful thing it did all
lane — see the findings below.

**`2d6ff752` — `chore(deps): the lockfile after the simulation's dependencies`** ·
**`0722a7eb` — `fix(core-ffi): the open configuration after CoreConfig grew a clock`**

### The two bugs the simulation found

Both are in `contracts/sim/failing-seeds.json` with the schedule, the
presentation and the fix, and `crates/sim/tests/recorded_seeds.rs` replays them
for ever.

**1. A liveness bug in settlement — seed 0, and every other seed.**
`centraid.core.v1.CommandOutcome` carried no `commit_seq`, while
`crates/vault`'s own Rust `CommandOutcome` had carried one all along. So an
`executed` answer reached the seat with neither a commit seq nor an
`answered_versions` set: `settle_at_commit_seq` could not match it (its
`commit_seq` was NULL) and `settle_answered_intents` skipped it (its version set
was empty). The intent parked at `awaiting-change` **for ever** and the
optimistic overlay stayed painted on every screen for the life of the seat.

What makes this the case for the simulation: **convergence passed throughout**.
The rows arrived, every table matched, and every unit test in `crates/seat`
was green. Only a run that asserted "the outbox is drained or terminal *at
rest*" over a whole scheduled workload could see it, and only a harness with a
real gateway answering real commands could produce the answer that triggered it.

Fixed in three places, because the bug had three halves: the field was added
(`optional uint64 commit_seq = 7` — a fresh number, so `buf breaking` is
unaffected); `core`'s `api::invoke` populates it; and `seat`'s settlement now
**refuses** an `executed` answer carrying neither, rather than parking it where
nothing can reach it. That third part is the one that matters most — the state
was representable and unreachable-from, and a type that can hold an impossible
value will hold one again.

**2. The gateway was not reproducible — seed 3.** `Core::open` had no way to be
given a clock, so it used the system clock. Two runs of one seed produced
byte-identical rows — same ids, same values, same counts — and different
`created_at` / `updated_at` / `occurred_at` / `executed_at` stamps; and
`access_receipt.hash` covers those stamps, so the receipt chain differed too.
A seed that cannot be replayed byte for byte cannot be *recorded*, so this bug
was blocking `contracts/sim/failing-seeds.json` itself. `CoreConfig::with_clock`
is the fix, and `Core::open` now decides create-versus-open by the file's
existence so the boxed clock moves exactly once.

**And two findings that were the harness's**, recorded because each taught the
product something now written into it:

- The seats quiesced **independently**, so a seat gave up just before another
  seat's last write landed, and three seeds reported a convergence failure while
  the product was correct. The harness fix is a shared quiescence barrier. The
  product lesson is that `PassReport::behind` is a **display number** meaning
  "as of the last page fetched" — it is derived from the watermark the last
  served page carried, so a gateway that commits afterwards leaves it at zero
  while the seat is genuinely behind. Any caller treating `behind == 0` as
  terminal stops early and stays stale. That is now said in those words on the
  field, and `reached_the_end` is the honest termination signal beside it.
- Faults were repaired only *after* the clients finished, which quietly made the
  convergence claim "converges unless partitioned". Every fault is now repaired
  while the seats still have catch-up budget left.

### Exit list

| # | Command | Outcome |
|---|---|---|
| 1 | `cargo fmt --all --check` | clean |
| 2 | `cargo clippy --workspace --all-targets -- -D warnings` | clean. Three findings were real and fixed rather than allowed: a `RefCell` borrow held across an `await` in `crates/sim` (the two channels share one connection, so it was a deadlock waiting for the day the driver interleaved them — the socket needs no interior mutability at all), an index-by-loop-variable, and `too_many_arguments` on `init_seat_state`, which became `SeatPosition` because two adjacent positional `i64`s that mean `applied_seq` and `applied_commit_seq` is exactly the shape in which census seam 5's two numbers get swapped |
| 3 | `cargo test --workspace` | **708 passed, 0 failed** across 30 binaries |
| 4 | `cargo xtask gate --profile local` | **PASS** — 170.5 s, scored against lane B2's new *cold* ceiling (`coldLocalProfileSeconds` 3200 s) because 14 of 14 workspace members had no linked artifact. `sccache` was not needed: the warm 120 s budget was not the number scored |
| 5 | `cargo xtask gate --profile pr` | **green except three**, and none of the three is this lane's. `secrets` reports 2 findings — `packages/model-runtime/LICENSES.md` (the named inherited red) and `contracts/golden/format-golden.json` (lane R's deliberate test key, new since the brief was written; named below). `osv` reports `astro@7.1.5` (the second named inherited red). `ts-static` refuses an unprovisioned tree rather than a type error, and says so in its own message — after `bun run build` it is 4/4. **The two steps this lane added both pass**: `sim` 28.7 s, `call-budget` 4.0 s. Total 363.2 s of a 1500 s budget, cold |
| 6 | `nm -D --defined-only …/libcentraid_core_ffi.so \| grep ' T centraid_' \| wc -l` | **5** — `centraid_call`, `centraid_close`, `centraid_free`, `centraid_next_event`, `centraid_open` |
| 7 | `cargo miri test -p centraid-core-ffi --test marshal_miri` | **7 passed**, on `RUSTUP_TOOLCHAIN=nightly` (the pinned 1.94.1 toolchain has no miri component; `rustup component add --toolchain nightly miri rust-src` was needed). What miri covered: the slice reconstruction and its bounds, the two out-pointer writes, the `Vec` → raw → `Vec` round trip `centraid_free` inverts (a capacity mismatch there is undefined behaviour that happens to work), the null-pointer refusals *before* any dereference, the empty-buffer corner, and a thousand round trips against miri's leak check. What it did **not** cover is everything that opens a vault: SQLite is a C library and miri does not execute foreign code, which is precisely why the unsafe surface is confined to `src/marshal.rs` |
| 8 | `SIM_SEEDS=100 cargo test -p centraid-sim` | **100 seed(s) in 95.0 s, 0 failing.** Wall clock for the whole test binary: 1 m 38 s |
| 9 | the failure matrix | 10 tests, 4 reds demonstrated — below |
| 10 | `cargo mutants -p centraid-seat` | **0 survivors.** 244 mutants: 204 caught, 1 missed, 39 unviable on the first full run; the 33 survivors of the run before it were every one a real gap, and all 33 are now killed by tests rather than excluded. `mutants.toml` was not created and `exclude_re` holds nothing: no survivor turned out to be a genuinely equivalent mutant. `--file crates/seat/src/sync.rs` re-run after the last fix: 39 mutants, 37 caught, 2 unviable, 0 survivors |
| 11 | the spike numbers | below |
| 12 | format / governance / law / static / push | `bun run format` + `format:check` clean; `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5` → 10 rules, no findings; `bash .governance/run.sh` → all 10 directives pass; `bun run check:push:static` → **4/4** |

### The `call` budget and the spike numbers

All `ci-linux-x64-4c`, 4 vCPU / 15 GB. **Floor measurements**, and the receipt
says so: the fixture is small, so what they catch is a regression in the call
path — a lock held too long, a statement re-prepared per call, a page probe gone
quadratic — not the cost of a year-three table.

**`call` budget** (`cargo test -p centraid-core --test call_budget`), a page of
100 rows over a 200-row vault, 200 samples after 20 unmeasured warm-ups:

```
p50 0.35ms · p95 0.47ms · p99 4.45ms · ceiling 50ms
```

`contracts/ledgers/call-budget.json` records the **ceiling**, not the
observation, and `_provenance.seededFrom` says why: a ceiling set to the current
measurement fails on the next runner that is one percent slower, which teaches a
team to raise budgets. The ledger and the test's constant are asserted equal by
`the_ledger_and_this_test_state_the_same_ceiling` — two copies of a budget is
two budgets, and the one nobody reads is the one that drifts.

**Binding spike, host half** (D-1020-D2-7). Ten thousand bounded reads across
the ABI, 100/500 unmeasured warm-ups:

| Harness | open | p50 | p95 | p99 | calls/s | answer |
|---|---|---|---|---|---|---|
| C (`cc -O2`, `-Wall -Wextra` clean) | 49.8 ms | 431 µs | 494 µs | 753 µs | 2,272 | 4,143 B |
| JNA 5.14 on JDK 21.0.10 | 125.7 ms | 480 µs | 894 µs | 1,152 µs | 1,772 | 4,143 B |

Event path, through `centraid_next_event`: **1,024 events in 4.3 ms, 235,817
events/s**. Neither out-of-process harness can measure this — nothing in them
produces an event, so both report `events: 0`, which is a real measurement of
the *timeout* path (clause 6: a timeout allocates nothing, and both harnesses
would crash if it did) rather than of a drain.

**The one number worth reading**: the JVM binding costs about **1.8×** the C
one at p95 (894 µs against 494 µs) for an identical 4 KB answer. That is the
marshalling — JNA's method dispatch plus the copy of the answer into a
`ByteArray` — and it is the number an Android shell budgets against.

Gradle **did** reach Maven Central through this machine's proxy, so the JNA
harness is a measured number and not only shipped source. `gradle --offline`
fails (no plugin cache); plain `gradle build` succeeds.

The spike's purpose is the ABI's **shape**, and the shape held: a shell needs
exactly five declarations, the answer comes back as a pointer *and* a length as
separate out-parameters (so JNA needs no hand-maintained `Structure` layout),
and the C harness compiles `-Wall -Wextra` clean. The *device* half — cinterop
on iOS, JNA on Android, the Swift wrapper — is wave 3 lane E's and there is no
device here.

### Demonstrated reds

The failure matrix was written red-first. Each red was produced by breaking the
product deliberately, recorded, and reverted; each test's own doc comment names
its red so a future reader can reproduce it.

| Red | Break | Result |
|---|---|---|
| A | rule 5 disabled (`if false && row.seq <= state.applied_seq`) | `the_same_page_twice_changes_nothing_at_the_seat` **FAILED**, `left: 6 right: 0` — the redelivered span's delete replayed and removed the live row |
| B | the overlay cleared from `on_commit_durable` instead of the in-transaction hook | `an_intent_executed_this_pass_has_its_overlay_cleared_this_pass` **FAILED**, `left: [] right: ["i-1"]` |
| C | the per-row epoch gate disabled | `an_epoch_bump_tells_an_old_seat_to_rebootstrap_and_says_why` **FAILED** — a row from another epoch landed |
| D | `SQLITE_FULL` classified as a generic SQLite error | `a_full_seat_file_rolls_back_whole_and_resumes_from_the_same_cursor` **FAILED**: `SQLITE_FULL must be its own typed answer, or the shell says 'sync failed' and the member never learns that clearing space would fix it: database or disk is full` |

And the two bugs above are themselves reds, found rather than planted: the
simulation's first run was the red, and `contracts/sim/failing-seeds.json` is
where they are recorded.

One further red is recorded in `crates/core/src/events.rs`'s own history: the
test `the_health_event_carries_the_seats_distance_behind` failed on the first
implementation because a stall that happened with the queue **full of change
events** had no health slot to replace and was therefore never reported — the
shell would learn a stall had ended without ever learning it began. The fix is
the deferred `stall_unreported` report, which takes the first slot a drain
frees rather than dropping a change event to make room.

### Decisions — lane D2

Each cites [#1020](https://github.com/srikanth235/centraid/issues/1020) and was
adopted under **R-1020-34** (options, recommendation, adopt, record).

**D-1020-D2-1 — the seat is the same crate family as the gateway.** `crates/seat`
holds the applier, `seat_state`/`seat_outbox`/`seat_outbox_settled`, the
watermark arithmetic, the `(gateway_id, vault_id)` digest, the intent grammar as
three distinct types, the offline chain, settlement, `row_version` OCC and the
online-only refusal. SQL string literals are allowed here, as the
`sql-confinement` rule already names. **The applier's SQL is the gateway's**:
`centraid_vault::log::apply::{apply_row_sql, delete_row_sql}` render the
statements and this crate calls them. v0 had two hand-transcribed copies of the
same four rules and they drifted; one renderer with two callers cannot.

**D-1020-D2-2 — `core` is the message loop.** Four entry points and nothing
else. `open` opens the file, runs migrations and **returns**; the endpoint is a
separate call. `call` is synchronous from the caller's view with a debug
assertion against the shell's named UI thread. `next_event` is bounded at 1024
and drops nothing. `close` unblocks every waiter and later calls are typed
errors. Three roles over one `Request` surface.

**D-1020-D2-3 — `core-ffi` is five symbols and a contract.** Exactly five
`#[unsafe(no_mangle)] pub extern "C"`, ten clauses in `CONTRACT.md`, one test per
clause through the C entry points, `nm` over the built `cdylib` as a second and
different question, a committed cbindgen header whose regeneration is asserted
to be a no-op, `#![deny(unsafe_op_in_unsafe_fn)]`, every `unsafe` block
commented with the invariant it relies on, and the marshalling confined to one
module so miri can run over it.

**D-1020-D2-4 — the simulation is the sync proof.** One gateway host, N seat
hosts, a seeded schedule, seven invariants after every run, 25 seeds in `pr` and
250 in `nightly`, and every seed that ever failed replayed for ever. Every host
is real except the network: real vault, real doors, real applier, real outbox,
real sync driver, real on-disk SQLite. The alternative — mocks — proves the
mocks agree.

**D-1020-D2-5 — the failure matrix, red-first.** Five modes, ten tests, four
demonstrated reds. The seat side is `crates/seat/tests/failure_matrix.rs`, where
a connection can be dropped and reopened and a file can be made full on purpose;
the gateway side of process death and duplicate delivery is `crates/sim`'s,
where a real host crashes and restarts over a real file.

**D-1020-D2-6 — the `call` budget.** p95 over 200 calls of one bounded read,
against a ceiling in a down-only ledger, run by `pr`'s `call-budget` step.
`--nocapture`, so a number trending towards its ceiling is visible in the gate's
log rather than only pass-or-fail.

**D-1020-D2-7 — the binding spike, host half.** A C harness and a JNA harness,
both measured. JNA and **not** the Foreign Function & Memory API: FFM is final
in JDK 22 and Android's minimum is nowhere near it, so an Android shell will use
JNA or JNI for years, and measuring the binding the product will ship is the
point of a spike.

**D-1020-D2-8 — the status codes are prefixed on both sides.** `CENTRAID_OK`,
not `status::OK` with a bare `#define OK` in the header. Options: (a) bare Rust
names and a cbindgen rename annotation — *tried, and cbindgen 0.29 does not
honour `cbindgen:rename` on constants*; (b) two spellings, one per language —
refused, because two names for one constant is a thing that drifts; (c) one
prefixed name on both sides — **adopted**. A C preprocessor has a single
namespace and a header that `#define`d bare `OK` would collide with somebody's
enum on the first project that included both.

**D-1020-D2-9 — one mutex over the vault, in wave 2.** `Vault` keeps its
commit-guard depth in a `Cell` and is `!Sync` by construction. The issue's
"reads run concurrently under SQLite's own rules" needs a pool of read
connections, which needs `PRAGMA` statements, which is SQL — and
`sql-confinement` confines SQL to five crates `core` is not one of. Options:
(a) a reader pool in `crates/core` — **refused**, it puts SQL where the rule
does not allow it and weakening a rule to go green is exactly what this
repository forbids; (b) a reader pool inside `crates/vault` — the right answer,
and lane D1's file, so it is an owner hand-off rather than a reach across a lane
boundary; (c) one mutex, every call serialised — **adopted for wave 2**. What it
costs is bounded and measured: `call` is p95-budgeted on a *single* bounded read,
which serialisation does not change, and p95 is 0.47 ms against a 50 ms ceiling.
What it does not cost is correctness. `CONTRACT.md` clause 3 states the honest
version — the FFI adds no lock of its own, and it never promised the vault was
concurrent.

**D-1020-D2-10 — the sync driver is production code, not the simulation's.**
`crates/seat/src/sync.rs` holds the loop, written over `LogSource` and
`IntentSink`; `crates/sim` implements them over turmoil and a real seat will
implement them over `crates/net`. A driver in the test crate would have made
every simulation bug a bug in code no phone runs. The two traits are **separate**
because they fail independently and the remedies differ: a seat whose log source
is down is *stale* (it shows what it has and says how far behind), and a seat
whose intent sink is down is *blocked* (its writes are queued and the badge says
so). Those are the two most different states a seat has, and one "connection"
trait would make them the same one.

**D-1020-D2-11 — the simulation speaks UDP, not TCP.** Options: (a) turmoil's
TCP — refused twice over. First because **it is not what the product speaks**:
production is iroh, which is QUIC over UDP, and a TCP simulation would prove
convergence for a transport no seat has, hiding reordering, datagram loss and
the absence of head-of-line blocking, which are exactly the three things a sync
loop must survive. Second because the product **may not open a listening TCP
socket** and the xtask `no-listening-socket` rule says so on every gate run: a
simulated listener is not a real one, but a crate whose source reads
`TcpListener::bind` is a crate somebody copies from. (b) An in-process channel —
refused, turmoil's partitions and latency would not apply and the schedule would
be decoration. (c) **turmoil UDP — adopted.** The rule stands unweakened and was
never asked to bend. The cost is this crate's own datagram framing, which keeps
the protocol's `u32BE(len)` prefix even though a datagram already has a length,
because a truncated datagram must be refused for the same reason a truncated
stream frame is.

**D-1020-D2-12 — the sync driver is async; `Handle::call` is not.** These two
were briefly conflated, and the first attempt called `Handle::block_on` from
inside a turmoil host — which panics, correctly. A sync *pass* is network I/O, so
`pass` is `async` and the two traits return boxed futures. `call` is synchronous
because a *shell* asking one question wants one answer and should not need a
runtime in Swift. The SQLite work between the awaits stays synchronous, which
is right: an apply is one transaction per commit and there is nothing to await
inside one — so the applier never holds a transaction across an await point,
which is the rule that keeps a cancelled future from leaving one open.

### Findings outside the slice

1. **`crates/vault`'s gateway-side applier does not persist its cursor.**
   `log::apply::apply_log_page` documents rule 2 as "one transaction per commit,
   **with the cursor in it**", and the statement it runs inside that transaction
   is `UPDATE replica_meta SET floor_seq = MAX(floor_seq, 0), updated_at =
   updated_at WHERE singleton = 1` — a no-op in both columns. The cursor is
   returned in `ApplyOutcome.cursor` and never written. Not a bug for its two
   current callers (the CONVERGENCE and ATOMICITY fixtures both pass the cursor
   back in), and a real one for anything that crashes mid-replay and reopens —
   which is exactly what lane R's restore drill does through
   `backup::drill::SeatReplica`. `crates/seat`'s applier writes `seat_state` in
   the same transaction, so the seat side is sound; this is the gateway-side
   twin. **For lane D1 or the owner.**
2. **`SeededIds` restarts its sequence when a process restarts.** The
   simulation's gateway host reopens its file on a bounce and mints ids from the
   same seed again. It did not collide in any of the 100 seeds run — each id is
   consumed once per command and the command count is the same — but a restart
   that re-issued an id a previous run had already committed would be an id
   collision in the audit band, which is append-only. Worth a deliberate answer
   before anything ships on `SeededIds` outside a test. **For lane D1.**
3. **`crates/vault`'s `RebootstrapReason` has five values; the wire has eleven.**
   `contracts/protocol`'s `RebootstrapReason` carries v0's full ten plus
   `UNSPECIFIED`, and `convert::rebootstrap_to_wire` can only ever produce four
   of them. The other six (`epoch-changed`, `snapshot-retention`,
   `shape-changed`, `checkpoint-incompatible`, `device-access-changed`) are v0
   verdicts nothing in v1 raises yet. Not a defect — a seat normalises what it
   does not know to `invalid-cursor`, as v0's door does — but the asymmetry is
   worth a look when the snapshot door lands in wave 3. **For lane C / wave 3.**
4. **`sql-confinement` found eight violations I had written, and fixing them
   found a triplicated comparator.** Worth writing down as a finding about the
   *rule* rather than about my code. `crates/vault::page::RawPage` takes SQL the
   **caller** wrote, which means the first consumer outside `crates/vault` that
   wants a page has to write a `SELECT` — so the violation was not carelessness,
   it was the interface. `KeysetPage` is the fix: the shape crosses the boundary
   and the syntax does not. And in chasing the other seven I found the
   CONVERGENCE comparator written **three times** — in `crates/vault`'s
   `tests/gates.rs`, in lane R's restore drill, and a third time in
   `crates/sim` because the first two were `#[test]`-private. Three copies of a
   comparison is three comparisons, and the one that is wrong is the one nobody
   re-reads. `crates/vault::converge` is now the single one.

   **The lesson for the umbrella**: the right answer to "the rule will not let
   me put a query here" was never an exemption, and twice out of eight it was
   "there should only have been one query". Worth saying because the tempting
   fix — adding `crates/sim` to `SQL_ALLOWED_ROOTS`, since it is test-only and
   `publish = false` — would have looked entirely reasonable and would have lost
   both improvements.
5. **The `secrets` step now has a second cause, and it is not the one the brief
   named.** `contracts/golden/format-golden.json` trips gitleaks'
   `generic-api-key` on lane R's deliberate cross-language test key, alongside
   the inherited `packages/model-runtime/LICENSES.md`. So `pr`'s red is two
   findings rather than one, and a future lane reading "the two inherited reds"
   will find three causes for two steps. Not mine to resolve — a fixture key is
   supposed to be in the fixture — but the allowlist or the ignore file wants a
   deliberate entry rather than a standing red that everybody learns to skip
   past. **For lane R or the owner.**
6. **`crates/xtask`'s `report_failure` now reads stdout as well as stderr.** The
   simulation prints its diagnosis — the failing seed and its schedule — through
   `println!`, so a gate step whose reason was looked for in stderr alone
   reported `(no stderr)` for the most diagnosable failure in the profile. Fixed
   in `2f13d7c3`, and mentioned because lane B2 is editing the same file.

### Owner hand-offs

1. **The reader pool belongs in `crates/vault`** (D-1020-D2-9). Until it exists,
   `crates/core` serialises every call through one mutex. The budget says the
   cost is not currently felt (p95 0.47 ms against 50 ms), so this is a
   correctness-neutral scheduling question rather than an urgent one — but the
   issue's own words are "reads run concurrently under SQLite's own rules", and
   they are not yet true.
2. **Lane R's restore drill still re-pairs through D1's applier, and the swap
   is not cheap.** `backup::drill::SeatReplica` lives in `crates/vault`, and
   `crates/seat` depends on `crates/vault` — so swapping it for the seat applier
   would be a **circular dependency**. The swap therefore needs the drill to
   *move*, out of `crates/vault` and into `crates/seat` or a crate above both.
   That is a wave 3 change with a design decision in it, not the cheap
   substitution lane R's note hoped for. Recorded here rather than attempted.
   Finding 1 above is why it matters: the applier the drill currently uses is
   the one whose cursor is not persisted.
3. **`centraid_close` twice on one pointer is undefined**, and `CONTRACT.md`
   says so in those words rather than defending against it. A shell must null
   its own copy. Naming it because it is the one clause a shell author can get
   wrong without a compiler or a test noticing, and a wave 3 shell review should
   confirm all three shells do.
4. **The device half of the binding spike is wave 3 lane E's.** The numbers here
   are `ci-linux-x64-4c` numbers. The shape is fixed and the ABI is unlikely to
   need a sixth symbol; the p95 an iPhone sees is unknown and is the number that
   decides whether the prebuilt-core lane's size budget matters.

### Doctrine digest

Law `53be88c22ab5`. `amendment-pairing`, `commit-message-format`,
`constitution-coverage`, `doc-integrity`, `doctrine-citation`,
`estate-separation`, `managed-tree-integrity`, `receipt-per-issue`,
`registry-completeness`, `waiver-docket` — no findings, no waivers spent. No law
file touched. No model identifier in any file or commit.

### Falsification — the two riskiest claims, and the throwaway check against each

**1. "The C ABI exports exactly five symbols."** The risk is that the count is
met by something other than the claim: a test counting *declarations* in source
rather than exports in the artifact, a `grep` that matches a comment, or an
artifact so stale that it predates the symbol under test.

**(a) A sixth symbol.** A `#[unsafe(no_mangle)] pub extern "C" fn
centraid_invoke()` was added to `src/lib.rs`. `cargo xtask gate --profile local`
**failed** at the `rules` step: `crates/core-ffi exports 6 extern "C" symbol(s),
not 5: [centraid_call, centraid_close, centraid_free, centraid_invoke,
centraid_next_event, centraid_open]`, and after a rebuild
`exactly_five_symbols_are_exported` **failed** too, from `nm`. Both halves can
fail, and they fail for different reasons — which is the point of asking the
question twice.

**(b) The artifact, not the source.** `the_exported_names_are_what_a_shell_links`
resolves each of the five through `libloading` on the built `cdylib`.
`#[unsafe(no_mangle)]` was removed from `centraid_free` alone; the Rust-level
contract tests **still passed** (they link the `rlib` and resolve at compile
time), and the `libloading` test **failed**: `` `centraid_free` is in CONTRACT.md
and not in …/libcentraid_core_ffi.so ``. So the two tests are not redundant, and
the one that would have been dropped as duplicative is the one that catches a
missing export.

**(c) A stale artifact is caught, and this was not a hypothetical.** After
check (a) the source was restored and the `cdylib` was **not** rebuilt. The
next run of `exactly_five_symbols_are_exported` **failed** with
`exports 6 'centraid_*' text symbol(s)` and printed both lists — so the test
reads the artifact on disk rather than anything derived from the source it was
compiled against. `touch` plus a rebuild put it back to five.

The residual hole is the other direction: both symbol tests print
`SKIPPED: no built cdylib found` and return rather than asserting, so a
`cargo test -p centraid-core-ffi` with no prior build reports green having
checked nothing. Recorded rather than hidden — the gate's `test` step runs
`cargo test --workspace`, which builds the `cdylib`, and the skip line is
printed loudly. A test that *failed* on an absent artifact would fail for every
developer running one test file, which is worse.

**Result: the claim held, and both halves of it are now known to be able to
fail.**

**2. "Every seat's replicated tables equal the gateway's after every schedule."**
The risk is the classic one for a convergence check: that it compares an empty
set, or walks a list shorter than it looks, or compares a file with itself.

**(a) Two empty files must not pass.** `comparing_two_empty_files_is_a_finding_and_not_a_pass`
is a permanent test, and the `assert!(compared < 100)` guard inside
`seat_converges` is what it exercises. The invariant reports **109 tables
compared** on a real run, not the handful a workload touches.

**(b) The comparator can see a single row.** One row was deleted from
`seat-0`'s `core_party` after a clean run, before the invariant check. The check
**failed**: `` [1/convergence] seat-0: `core_party`: 9 row(s) on the gateway, 8
here `` — with both row lists printed, so the missing row is identifiable from
the output alone.

**(c) The applier was broken to skip deletes while still advancing its cursor** —
the classic insert-only mirror. Three things were then run, and the result is
more interesting than a pass:

- **The simulation did not catch it.** Seed 1 reported 0 findings over 109
  tables. Honest, and a gap: the generated workload is `core.add_party` only, so
  **the simulation does not currently exercise deletes at all**.
- **The duplicate-delivery test did not catch it either**, which surprised me
  and is worth writing down. `the_same_page_twice_changes_nothing_at_the_seat`
  compares the first delivery against the second, and a broken applier skips the
  delete equally on both — so the property it asserts (idempotence) was still
  true of the broken code. A test that compares a thing against itself cannot
  see a bug that affects both sides.
- **D1's CONVERGENCE fixture, replayed through this applier, caught it.**
  `crates/seat/tests/convergence.rs` **failed**: `` `core_entity`: 7 row(s) on
  the gateway, 8 on the seat `` and `` `core_party`: 4 … 5 ``, with the surviving
  `conv-b` visible in the printed seat side. That is the value of running lane
  D1's fixture through lane D2's applier rather than trusting that two
  implementations of four rules agree.

**Result: the claim held, and the check relocated the coverage.** The delete
path is covered by the CONVERGENCE fixture and not by the simulation; the
simulation's workload should grow an update and a delete when a delete-shaped
command is registered, which is wave 3. It is named here rather than counted as
covered — and the reason the gap was invisible is that the test I *expected* to
catch it structurally cannot.

A third, cheaper check, because "the simulation found two bugs" is a claim that
could be met by two bugs in the simulation: both are in *product* crates
(`crates/api-proto` + `crates/seat`, and `crates/core`), both have a permanent
regression test outside `crates/sim`
(`an_executed_answer_with_neither_a_commit_seq_nor_versions_is_refused` and
`a_seed_run_twice_reaches_the_same_state`), and both were reproduced by reverting
the fix and re-running the sweep before the receipt was written.

## Wave 3 — lane F: the desktop seat — a sidecar the shell owns, a 0600 socket, and a video that seeks while it arrives

Doctrine digest stamp: law `53be88c22ab5` · [#1020](https://github.com/srikanth235/centraid/issues/1020) wave 3, lane F · branch `claude/1020-laneF`.

**Exit criterion: met.** `desktop/e2e/media-seek.e2e.ts` runs a real Electron app
against a real `centraid seat` child over a real mode-0600 Unix socket, points a
`<video>` at `centraid://blob/<digest>` for a blob that is 20% on disk, seeks to
70% of its duration into bytes that do not exist yet, and asserts `currentTime`
advances past the seek target. 7 specs, 12.0 s wall clock, 7 passed.

### What landed, by commit

**`5c59abbb` — `centraid seat --socket`: the door.**
`crates/centraid/src/cmd/seat/{mod,local,peer,blob,catalogue,core_link,server,state}.rs`,
`crates/centraid/src/cmd/native_host.rs`, `crates/centraid/src/cmd/mod.rs`,
`crates/centraid/src/main.rs`, `crates/centraid/Cargo.toml`, `Cargo.lock`,
`crates/centraid/tests/seat_socket.rs`, `crates/centraid/tests/no_listener.rs`,
`contracts/desktop/socket-catalogue.json`.

**`3ab46a14` — `desktop/electron` and `desktop/renderer`.**
`desktop/electron/src/main.ts`, `desktop/electron/src/preload.ts`,
`desktop/electron/src/main/{ipc-core,ipc,preload-core,seat-client-core,seat-socket,seat-state-core,sidecar-supervisor-core,sidecar,media-response-core,media-protocol}.ts`
with `{preload-core,seat-client-core,seat-state-core,sidecar-supervisor-core,media-response-core,media-protocol-core}.test.ts`;
`desktop/renderer/src/{main.tsx,App.tsx,seat-store.ts,seat-store.test.ts}`,
`desktop/renderer/src/apps/tally/{fold.ts,fold.test.ts}`,
`desktop/renderer/public/{index.html,styles.css}`;
`desktop/vitest.config.ts`, `desktop/electron/{package.json,tsconfig.json,tsconfig.test.json}`,
`desktop/renderer/tsconfig.json`; `crates/centraid/src/cmd/seat/{local,server}.rs`
(the `req_end` field the shell needs to stream one resolved range).

**`edf55ac8` — the exit criterion.**
`desktop/e2e/{playwright.config.ts,electron-entry.mjs,fixture.mjs,media-seek.e2e.ts,seat.e2e.ts}`,
`contracts/desktop/fixtures/{arriving.webm,arriving.json,make-video.mjs}`.

**`acba10c0` — the MV3 Companion.**
`extension/src/{host-core.ts,host-core.test.ts,worker.ts}`,
`extension/static/manifest.{chrome,firefox}.json`,
`extension/scripts/native-round-trip.mjs`, `extension/{package.json,tsconfig.json}`,
`desktop/vitest.config.ts` (the Companion joins the same project).

**`cf093373` — packaging, entitlements, the updater.**
`desktop/electron/electron-builder.yml`, `desktop/electron/electron-builder/app-id.json`,
`desktop/electron/build/entitlements.mac.{plist,inherit.plist}`,
`desktop/electron/src/main/packaging.test.ts`, `desktop/electron/.gitignore`,
`desktop/electron/src/main/update-{watcher,watcher-wiring.test,check,check.test,rollout,rollout-core,rollout-core.test,signature-core,signature-core.test,signature-gate,signature-gate.test}.ts`,
`desktop/electron/src/main/{ipc-core,ipc,preload-core,preload-core.test}.ts`,
`.github/workflows/lane-release-desktop.yml`.

**`88d7fc28` — the gate steps and the docs.**
`crates/xtask/src/gate.rs` (`desktop-unit` in `pr`, `desktop-e2e` in `nightly`),
`tests/path-filter-ledger.json`, `desktop/README.md`, `extension/README.md`,
`contracts/desktop/README.md`, `contracts/handoff/F/desktop-e2e.md`,
`desktop/electron/package.json`, `desktop/vitest.config.ts`,
`crates/centraid/src/cmd/seat/catalogue.rs`, `crates/centraid/tests/seat_socket.rs`
(the two SQL literals `sql-confinement` was right to flag).

### Exit list

| Command | Outcome |
|---|---|
| `bun run --cwd desktop/electron test` | **201 passed**, 15 files, 1.7 s — `desktop/electron`, `desktop/renderer` and `extension/src` in one project |
| `bun run --cwd desktop/electron typecheck` | clean — three tsconfigs (main, the test program, the renderer) |
| `cargo test -p centraid` | **105 passed** across 5 targets (83 unit, 9 `no_listener`, 7 `seat_socket`, 3 `gateway_install`, 3 `restore_drill`), 0 failed |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean (25.4 s) |
| `cargo xtask gate --profile local` | **PASS** — fmt, clippy, test (`--workspace`, 143 s), rules, ledgers. 196.2 s of the 3200 s cold ceiling |
| `cargo xtask gate --profile pr` | 433.0 s of 1500 s. Two steps were red for reasons this lane then fixed (`ci-policy`, `desktop-unit`); the rest inherited — see below |
| `cargo xtask gate --profile nightly` | 736.4 s. **`ok desktop-unit 9.6s`**, **`ok desktop-e2e 98.2s`**, `ok ts-static`, `ok ci-policy`, `ok sim-nightly 261.2s`, `ok v0-oracle`, `SKIP device-lanes` (the named runner contract). `FAIL` on three inherited only: `secrets`, `osv`, `lane-health` |
| `xvfb-run -a node_modules/.bin/playwright test -c desktop/e2e/playwright.config.ts` | **7 passed (12.0 s)** |
| `node extension/scripts/native-round-trip.mjs` | `{"attached": false, "host": "dev.centraid.host", "t": "pong", "version": "1.0.0-alpha.0"}` |
| `no-listening-socket` over `crates/centraid` | `ok no-listening-socket — 172 file(s) scanned, clean (9 in the rule runner)` |
| `bun run format` + `format:check` | clean |
| `bun run lint` | clean |
| `bun run lint:actions` (actionlint) + `lint:workflow-pins` | clean — `26 workflow(s) clean` |
| `bun run check:push:static` | **4/4** in 25.7 s |
| `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5` | 10 rule(s), **no findings** |
| `bash .governance/run.sh` | **all 10 directive(s) passed** |

Two `pr` steps were red for reasons this lane fixed, and both are **`ok` in the
nightly run above**:

- **`ci-policy`** — `lint:path-filters` refused `desktop` and `extension` as
  paths no filter claims: "a path no filter names wakes no path-gated lane, and
  `skipped` counts as a PASS in ci.yml's `check` — so it would merge green,
  unexercised." Correct, and the fix is a ledger entry naming the **always-on**
  job that covers them, which is `gate.yml`'s unfiltered `cargo xtask gate
  --profile pr` and its new `desktop-unit` step. `10 filter(s) cover every
  workspace and top-level path (7 ledgered as always-on)`.
- **`desktop-unit`** — failed on its first gate run with `Projects definition
  references a non-existing file: desktop/electron/vitest.quality.config.ts`,
  which is the repository's **own** `vitest.config.ts` being loaded by mistake:
  vitest resolves a relative `--config` against the project root it infers
  rather than against the shell's cwd. The package script now passes an absolute
  path (`--config "$PWD/../vitest.config.ts"`) and `desktop/vitest.config.ts`
  says why in a comment. Worth naming because the failure mode was a *green-
  looking* wrong config, not an error about my files.

Three steps are red for reasons outside this lane (all three in the nightly run
too, where they are the only failures):

- **`secrets`** — two findings, both pre-existing:
  `packages/model-runtime/LICENSES.md` (named on `main` in the wave 2 brief) and
  **`contracts/golden/format-golden.json`** (`generic-api-key` on the
  `dataKeyHex` field of lane R's cross-language format golden). The second is
  **not** in the brief's list of inherited reds; it is present at `2fc8d284`, so
  it is not this lane's, and it is filed as a finding below.
- **`osv`** — `astro@7.1.5 (score 9.8)`, the named inherited red.
- **`lane-health`** — `ci.yml passed 5/40 first attempts (12.5 %) against a
  95 % floor` and `ci.yml has been red on main for 16 consecutive runs`. That is
  a reading of the repository's own GitHub history and has nothing to do with
  this branch.

`ts-static` was red on the first `pr` run with `the workspace is not built:
packages/server/dist is absent` — the step's own documented precondition, which
`gate.yml` satisfies by running `bun run build` first. It is **`ok`** in the
nightly run above, and `bun run check:push:static` by hand is 4/4.

### The e2e, and the seek evidence

```
cargo build -p centraid && bun run --cwd desktop/electron build
xvfb-run -a node_modules/.bin/playwright test -c desktop/e2e/playwright.config.ts

  ✓ media-seek.e2e.ts › the seat attaches and reports its four states (244ms)
  ✓ media-seek.e2e.ts › a blob still arriving plays, and seeking past the prefix still plays (6.0s)
  ✓ media-seek.e2e.ts › the door refuses what it must, and serves what it must (134ms)
  ✓ media-seek.e2e.ts › the whole blob lands and is then served as complete (52ms)
  ✓ seat.e2e.ts › quit stops the seat it started and unlinks its socket (1.2s)
  ✓ seat.e2e.ts › a thin seat shows nothing to show, with a reason, and never an empty list (1.1s)
  ✓ seat.e2e.ts › the same door serves the shell in replicated mode, with the ledger's own rows (1.2s)
  7 passed (12.0s)
```

The fixture is a committed 20-second VP8/WebM of 227,977 bytes
(`contracts/desktop/fixtures/arriving.webm`, digest in `arriving.json` and
verified by the test before it runs). 20% of it is on disk as
`<digest>.partial` beside a declared `<digest>.total` when the window opens; the
rest lands at ~32 KiB/s and the prefix is renamed to `<digest>` when the last
byte arrives — which is what an `iroh-blobs` transfer does when a blob verifies.

The assertion the criterion names, verbatim from `media-seek.e2e.ts`:

```ts
const target = duration * 0.7;
const arrivedBeforeSeek = arriving.received();
expect(arrivedBeforeSeek).toBeLessThan(fixture.byte_size);   // still arriving
…
await expect
  .poll(async () => locator.evaluate((node: HTMLVideoElement) => node.currentTime))
  .toBeGreaterThan(afterSeek + 0.05);                        // it advanced
```

`duration` is read before the seek and is within 2 s of the fixture's recorded
20 s — from a file that is a fifth present — which is the other half of the
claim: the `Range` is parsed against the **declared total**, so the element
learns the video's real length rather than its length so far.

### The four-state transitions observed

| Where | Transition |
|---|---|
| `seat_socket.rs` (replicated, fresh vault) | `availability: local`, `durability: settled`→ reported, `connectivity: unconfigured` — **not** `offline`: no gateway has been chosen |
| `seat_socket.rs` (`--thin`) | `availability: unavailable`, `durability: none`, and a `page` refused with a reason rather than answered with an empty page |
| `seat-state-core.test.ts` | online→offline on a replicated seat: `availability` stays `local`, `durability` falls to `local-only` — it keeps *reading* and stops being *settled* |
| `seat-state-core.test.ts` | the first state never opens an outage even when offline (#647's rule in push shape), `down` fires once ever, `recovered` pairs only with a fired `down`, a stall fires once and re-arms after catching up |
| `seat.e2e.ts` (thin, on screen) | `read-nothing` visible with "not been paired", `photos-grid` count 0 **and** `photos-empty` count 0 — no list at all, rather than a list with nothing in it |

### Parity: what was compared, and the count

`desktop/renderer/src/apps/tally/fold.test.ts` compares this dashboard's fold
against **`contracts/apps/tally/queries.json` case 0** — the dashboard with no
input — with the pages built from `contracts/apps/tally/rows.json` through the
**committed catalogue's own** projection and predicate, so the fold is tested
against the columns it will really be handed. Fields compared and agreeing:

| Field | v0's answer | this fold |
|---|---|---|
| `currency` | `GBP` | `GBP` |
| `friends` | 3 | 3 |
| `expense_count` | 6 | 6 (of 7 rows — `deleted_at IS NULL` is in the statement) |
| `settlement_count` | 1 | 1 |
| `groups` | 3, each with `name`, `icon`, `member_count`, `owner_net.currency` | 3, all four fields agree per group (Tokyo JPY/2, Lisbon EUR/3, Sitwell Road GBP/2) |
| `archived_groups` | 0 | 0 |

That is **six of the thirteen** output fields of case 0, and it is the half a
renderer owns. `crates/apps/tally/tests/parity.rs` deliberately compares
`balances.json` and `rows.json` but **not** `queries.json`, because its outputs
"carry presentation the port has no source for yet"; this is that source for the
join and the counts. The remaining seven (`owe`, `owed`, `me`, `nudges`,
`recurring`, `rate_suggestions`, `trash`) need the balance engine's output
projected through `packages/design`'s `figureTone`/`partyHueValue`, which moves
to `design/` with the token emitter (D-1020-D3-9) — named as the next wave's
job, not claimed here.

The e2e proves the same rows arrive from a **real** sidecar: `seat.e2e.ts`'s
replicated case reads the freshly founded vault's `core_vault` row through the
catalogue and renders its base currency, and asserts `tally-unavailable` is
absent so the zeroes beside it are answers rather than absences.

### What quit does now

**It stops the seat.** v0 leaves a detached gateway running on purpose (census
§F seam 1) because a gateway is a daemon with other clients; a seat process
whose only client is this window is *owned*. The sequence, asserted as a list in
`sidecar-supervisor-core.test.ts` and as behaviour in `seat.e2e.ts`:

1. `dispose` the supervisor **first** — a mid-teardown auto retry would
   resurrect a closing seat (v0's `main.ts:180`–`:182` ordering bug, made a rule).
2. the protocol's **terminal command**.
3. **await the seat's `closing`** — where the vault's last write lands.
4. `SIGTERM` → 5 s → `SIGKILL`, v0's escalation. A **bare pid**, not `-pid`:
   this child is not `detached`, so a process-group signal would hit the shell's
   own group.
5. **await the exit**, before anything reuses the socket path (§F seam 2).
6. **unlink** the socket, last.

`seat.e2e.ts` asserts, through `ps` rather than a pid file this shell wrote,
that no `centraid` process is serving that socket after `app.close()`, and that
the socket file is gone.

### Decisions — lane F

Each cites [#1020](https://github.com/srikanth235/centraid/issues/1020) and
follows R-1020-34: options, a recommendation, adopted.

- **D-1020-F9 — the seat socket carries TWO channels in one frame, and the
  local one is not in `centraid.core.v1`.** A frame is `crates/protocol`'s
  `u32BE(len) ‖ body` with the first body byte a channel tag: `0x00` is a
  `centraid.core.v1.Envelope` byte-identical to what crosses iroh, `0x01` is one
  UTF-8 JSON local message. Options: (a) add the local messages to
  `centraid.core.v1` — refused, because every one of them names something that
  cannot exist on a remote wire (a peer uid, a byte offset into a file this
  process can see, a capability token for a child on this machine), and
  `buf.yaml` puts that package under a FILE promise to seats that update on
  their own schedule; (b) a second protobuf package — refused, because it needs
  a generator in the desktop build for three message types; (c) **adopted**: a
  channel tag, with the version-bearing surface unchanged and exercised by
  `the_core_channel_carries_an_envelope_unchanged`. What it costs is that a
  reader has to know about the tag, which `desktop/README.md` and
  `crates/centraid/src/cmd/seat/local.rs` both state.
- **D-1020-F10 — the renderer sees JSON, not protobuf-es, and `desktop/**` is
  outside the bun workspace.** D-1020-F2 asked for `buf generate` with
  `protoc-gen-es` and committed TS under `desktop/renderer/src/generated/`.
  Neither `@bufbuild/protobuf` nor `@bufbuild/protoc-gen-es` is installed, and
  adding them means editing the root `package.json` and `bun.lock` — shared
  files, and a codegen step in a tree whose whole point is that it needs none.
  Options: (a) install both and generate — a shared-file change plus a build
  step for a consumer that speaks only the local channel; (b) hand-roll a
  protobuf decoder in TS — two copies of a wire format; (c) **adopted**: main
  speaks the local channel only, the core channel is protobuf and is exercised
  from Rust, and the JSON shapes are pinned by
  `the_json_spelling_is_pinned` on one side and `seat-client-core.test.ts` on
  the other. Consequence: `desktop/**` and `extension/**` are not bun-workspace
  members and not rows in the repository-wide vitest project list either — that
  list drives the v0 coverage run scored against `tests/floors.json`, and adding
  a tree to it moves coverage numbers for reasons unrelated to the oracle it
  measures. The v1 gate runs both suites by name (`desktop-unit`).
- **D-1020-F11 — reads are NAMED statements from a catalogue the sidecar holds,
  never composed by the caller.** Options: (a) carry v0's shape and let the
  renderer send a `PageQuery` — refused: the renderer is the part of this
  product that runs app-authored JSX, so a read it can compose is a read an app
  can compose, and the peer check says *who* rather than *what*; (b) a
  per-statement message type — a protocol change per app; (c) **adopted**: a
  name, resolved against `crates/apps/tally`'s own statement functions (the same
  ones `crates/apps/tally/tests/parity.rs` compares) plus three Photos
  statements over the ontology's tables. Pinned in
  `contracts/desktop/socket-catalogue.json`, which `centraid seat
  --print-catalogue` must reproduce byte for byte. Photos is **not** joined in
  SQL: `crates/core`'s `api::page` reads each row value back by the literal
  `select` entry, so an alias there is a silent column of nulls.
- **D-1020-F12 — "not yet" is its own outcome, and the HTTP answer is a
  retryable 503.** D-1020-F3 says *never 416 for a known-total blob*. A range
  inside a declared total whose bytes have not landed is not unsatisfiable and
  is not satisfiable either. Options: (a) answer 416 — refused, and this is the
  whole point: a media element that gets a 416 stops asking, permanently; (b)
  hold the request open until the bytes arrive — refused, because a stalled
  transfer would hold a media request forever; (c) **adopted**: the seat waits a
  bounded 5 s on the writer, answers the prefix short if any of it is there, and
  otherwise answers `still-arriving` which the shell renders as `503` with
  `Retry-After: 1` and `Content-Range: bytes */<total>` for a human reading the
  network panel. `416` is reserved for a range past a **settled** size, and
  `media-response-core.test.ts` asserts `expect(response.status).not.toBe(416)`
  on the arriving case.
- **D-1020-F13 — one resolved range becomes as many frames as it takes, and the
  seat reports the range it resolved.** `crates/protocol`'s `MAX_FRAME_BYTES` is
  262,144 and the local channel base64-encodes bytes, so one frame carries at
  most 128 KiB of blob. Answering a request with that one window and an honest
  `Content-Length` would tell a `<video>` the file is 128 KiB long — which it
  believes, once, forever. So `BlobBytes` carries `req_end`, the last byte of the
  range the **sidecar** resolved before the frame ceiling clamped it, and the
  response body is a stream that pulls the rest. The shell cannot re-derive
  `req_end`, because the `Range` grammar (and its open-range clamp) lives only
  in the sidecar.
- **D-1020-F14 — a per-turn capability token is minted by the shell, is
  single-use, and is clamped to ten minutes.** D-1020-AS2 requires the socket to
  admit `centraid mcp` as a second local client kind with a per-turn token in
  env. Options: (a) admit any local process of this uid — refused: uid says
  *who*, not *which program*, and a browser-launched host runs as the member
  too; (b) a long-lived token in a file — a bearer on disk; (c) **adopted**: the
  renderer asks, the seat mints 32 bytes of `/dev/urandom` as hex, and the token
  is **removed from the live map on redemption** — so a token read out of a
  child's `/proc/<pid>/environ` by a second child of the same uid buys nothing.
  A token minted for `native-host` does not admit `mcp` and a child may not
  mint. All four properties are tested in `local.rs` and over a real socket in
  `a_second_local_client_kind_attaches_with_a_minted_token_once`.
- **D-1020-F15 — the Windows named-pipe door is an owner hand-off, and
  `centraid seat --socket` refuses to run there.** Options: (a) write the DACL
  unobserved — refused: a DACL that was written but never seen to refuse
  anybody is a claim, not a protection, and this container has no Windows
  machine; (b) open an unprotected pipe with a warning — refused; (c)
  **adopted**: exit 3 with the hand-off named in the message, so a Windows
  build fails loudly rather than serving a vault over a pipe nobody checked.
- **D-1020-F16 — mounting `packages/blueprints/apps/{tally,photos}/app-inline`
  is deferred, and the parity claim is not deferred with it.** D-1020-F5 asks
  for the v0 UIs behind an adapter. Those components take v0's
  `@centraid/client` context — a gateway HTTP client, an SSE change feed, and
  the design-token provider — so mounting them is adapting *that context*, not a
  data source, and the adapter is a piece of work the size of this renderer.
  Options: (a) mount them and stub the context — a stubbed change feed is a
  screen that silently never updates; (b) port the components — a second copy of
  eight apps; (c) **adopted**: ship the screens over the same named reads, and
  keep the parity claim by comparing the fold against `queries.json` case 0
  field by field (above) and by proving the rows arrive from a real sidecar in
  the e2e. Named as a hand-off in `desktop/README.md`.
- **D-1020-F17 — the e2e's fixture video is committed, not generated.** The
  claim is about serving a blob whose bytes are still arriving; a test that first
  has to encode a video depends on an encoder the runner may not have. This
  container's only ffmpeg is Playwright's screen-recording build
  (`--disable-everything`, one decoder: mjpeg; one encoder: libvpx), which is
  why the generator feeds JPEG frames and emits VP8/WebM. `make-video.mjs` is
  committed beside the file so it is reproducible, and nothing in CI runs it.

### Demonstrated reds

Each was produced by breaking the subject, observing the failure, and reverting.

1. **The blob door's 416 rule.** `Served::NotYet` replaced by
   `Served::Unsatisfiable` in `crates/centraid/src/cmd/seat/blob.rs`:
   `cmd::seat::blob::tests::an_arriving_blob_serves_its_prefix_and_says_not_yet_past_it
   ... FAILED` — `test result: FAILED. 82 passed; 1 failed`.
2. **The peer check.** `judge_peer` returning `Ok(peer)` unconditionally:
   `cmd::seat::peer::tests::the_owning_uid_is_admitted_and_a_second_uid_is_refused
   ... FAILED`. **This is the peer-check red the exit list asks for**: a second
   uid cannot be created in this container, so the refusal is asserted against
   `PeerIdentity { uid: 1001 }` and `uid: 0` in the unit test, and the
   production path feeds that exact function from `UnixStream::peer_cred`. The
   socket's own mode is asserted over a live socket in
   `the_socket_is_0600_and_a_foreign_instance_is_refused_not_adopted`.
3. **The media door's status.** `503` replaced by `416` for `still-arriving` in
   `media-response-core.ts`: `the statuses > is 503 with Retry-After — never 416
   — for a range inside a declared total` — `1 failed | 113 passed`.
4. **`desktop-unit`'s own red, found by the gate rather than staged**: the
   vitest config misresolution above. The step failed on its first real run, the
   cause was a wrong config being loaded silently, and the fix is in the
   script.

### The xtask hand-off

`contracts/handoff/F/desktop-e2e.md` records both steps, but they are **already
applied** to `crates/xtask/src/gate.rs` — the route the umbrella's state block
named as preferred now that lane G has landed. `desktop-unit` is in `pr`
(1.9 s vitest + 6.4 s of typechecks, under 1% of the 1500 s ceiling; no ledger
was touched, because the ledgers are down-only and `measure --write` owns them)
and `desktop-e2e` is in `nightly`. The one thing lane G may want: `xvfb` on the
nightly runner, without which `desktop-e2e` **fails** with the install command
rather than skipping — Electron has no headless mode, and a browser test that
read green with no window would be the loudest kind of lie.

### Findings outside the slice

- **`cargo xtask` measures whichever git worktree last compiled `crates/xtask`,
  not the one you run it in.** `crates/xtask/src/main.rs`'s `repo_root()` reads
  `env!("CARGO_MANIFEST_DIR")`, which is baked at COMPILE time — deliberately,
  so `cargo run -p xtask` works from a subdirectory. With a shared
  `CARGO_TARGET_DIR` across worktrees (this wave's lanes E and F share
  `/home/user/cargo-target-2b` by the brief's own instruction) cargo reuses the
  cached binary, so the gate silently scores the *other* lane's tree. I hit it:
  a `nightly` run from this worktree reported `commonmain-no-platform-import —
  12 file(s) scanned` (lane E's `mobile/shared`, which does not exist here),
  `no-listening-socket — 162` instead of 172, and `ts-static — 9 .ts file(s)`
  instead of 50. `touch crates/xtask/src/main.rs && cargo build -p xtask` fixes
  it, and every number quoted in this section comes from a run after that. The
  repair belongs in `repo_root()`: prefer `git rev-parse --show-toplevel` (or
  walk up from the cwd for the workspace `Cargo.toml`) and fall back to the
  baked manifest path, which keeps the `cargo run` case working and makes a
  shared target directory safe. Lane G owns `crates/xtask`.
- **`contracts/golden/format-golden.json` trips `gitleaks`** (`generic-api-key`
  on `dataKeyHex`, line 23) and is **not** one of the two inherited reds the
  wave 2 brief names. It is present at `2fc8d284`, so it predates this lane.
  It is a *format golden* — the hex is a fixed derivation input, not a
  credential — so the fix is in the gate's own config (a path rule for
  `contracts/golden/**`), never an allowlist entry for the finding. Lane G owns
  `.gitleaks.toml`.
- **`contracts/apps/tally/rows.json` and `queries.json` were generated from two
  different fixture runs**, so their generated ids disagree: the same three
  groups are `id-0033`, `id-0034`, `id-0011` in one and `id-0005`, `id-0006`,
  `id-0007` in the other, while every other field agrees. The parity test
  therefore joins by **name** and says so in a doc comment. One generator run
  would make id-level comparison possible, which is what the remaining seven
  `queries.json` fields will need.
- **`claimRevival` requires epoch milliseconds.** A fresh budget's
  `lastAttemptAt` is `0`, so the minimum-interval check is against the absolute
  clock: a caller that handed it a monotonic uptime would have its first
  revival refused for the process's first fifteen seconds. This is v0's
  arithmetic, carried verbatim by D-1020-F1, so it was **named and pinned**
  (`requires epoch milliseconds: a near-zero clock refuses the first revival`)
  rather than "fixed" — changing the comparison would change when the second
  and third revivals are allowed too. A finding for whoever owns v0's copy.
- **`oxlint`'s `promise/no-multiple-resolved` false-positives** on two
  consecutive `clearTimeout(...)` statements inside a closure returned from a
  function that also constructs a `Promise` (`desktop/e2e/fixture.mjs`). Written
  as one call site in a loop with the reason in a comment rather than silenced,
  because a disable comment there would hide a real finding later. R-1020-35
  says a gate that reports a false positive is a bug in the gate — this one is
  upstream oxlint and `oxlint.config.ts` is law, so it is a finding and not a
  patch.
- **`crates/core`'s `api::page` keys a row's values by the literal `select`
  entry**, which means the paged read cannot carry a column alias or an
  expression at all — an aliased `select` yields a page of nulls with no error.
  `crates/centraid/src/cmd/seat/catalogue.rs` asserts every catalogued statement
  projects plain columns only, and the Photos join is done in the renderer
  because of it. Worth a typed refusal in `api::page` rather than a convention
  each caller has to know.

### Oracle edits

**None.** `apps/desktop/**`, `apps/extension/**` and `packages/**` are
untouched; `git diff origin/claude/friendly-cori-ezadjb..HEAD --stat -- apps
packages` is empty. Four v0 modules were **copied** into
`desktop/electron/src/main/` with their tests (`update-signature-core`,
`update-signature-gate`, `update-watcher`, `update-check`, `update-rollout`,
`update-rollout-core`) and their headers annotated to say they were carried
unchanged and why; the originals are unmodified.

One **test** in this lane's own crate was amended rather than weakened:
`crates/centraid/tests/no_listener.rs`'s
`every_unimplemented_verb_exits_three_and_names_its_lane` listed `seat` and
`native-host` as exit-3 stubs. Both are implemented now, so the list shrank (as
it has twice before) and the property it protected — *a verb must not exit 0
without doing its work* — is asserted against the real implementations:
`the_seat_verb_names_the_flag_it_needs_rather_than_exiting_zero`,
`the_seat_prints_the_catalogue_it_serves`,
`the_native_messaging_host_answers_a_ping_in_the_browsers_framing` and
`the_host_manifest_carries_an_allowlist_and_is_never_installed_by_guessing`.

### Owner hand-offs

1. **macOS and Windows runs.** Everything here is proven on Linux under Xvfb.
   The commands are in `desktop/README.md` § *Running it*; on macOS/Windows they
   are unchanged except that no `xvfb-run` is needed. On Windows,
   `centraid seat --socket` exits 3 with the named-pipe hand-off until its DACL
   door is written **and observed to refuse somebody**.
2. **Signing and notarisation enrolment.** `lane-release-desktop.yml`'s gates
   are untouched: Apple secrets flip `CSC_IDENTITY_AUTO_DISCOVERY`, Azure
   secrets flip Windows signing, and the GitHub Release **withholds the
   installers entirely** while unenrolled. `docs/enrollment.md` is the doc; the
   `docs/release.md` pipeline sections are lane G's.
3. **The updater's release key.** `TRUSTED_RELEASE_KEYS` stays **empty**, so
   every packaged update refuses with `no-trust-anchor` and
   `relaunchToUpdate()` relaunches rather than installs. That is the fail-closed
   state, it is asserted (`enrols no release key, so every packaged update
   refuses`), and enrolling a key flips that test — which is the review signal
   that signed updates went live. Widening it to make a v1 update path work is
   the "never weaken policy to go green" case.
4. **Where the browser host manifest is stored, per browser and per platform.**
   `centraid native-host install --browser chrome|firefox --extension-id <id>
   --out <path>` writes it and prints the directory to copy it to; it never
   copies it itself, for the same reason `gateway install` never enables a unit.
   Which directory an installer should write to — and whether the desktop
   installer should offer at all — is a product decision.
5. **Store enrolment and the extension ids** for Chrome Web Store and AMO.
   Until an id is enrolled there is nothing to put in a host manifest's
   allowlist, and a manifest with a placeholder id is one that silently does not
   work (an empty allowlist is refused outright).
6. **`xvfb` on the nightly runner**, or `desktop-e2e` fails loudly there. See
   the hand-off note.
7. **Prebuilt core artifacts.** The release lane compiles `centraid` per
   platform today; when lane G's `lane-prebuilt-core.yml` artifacts are
   downloadable, the `cargo build --release -p centraid` step is replaced by a
   download and `electron-builder.yml`'s `extraResources` path does not change.

### Falsification: the two riskiest claims, and what was run against each

**Claim 1 — "a video seeks in a blob that is still arriving."** The risk is that
the test passes because the blob had *finished* arriving by the time the seek
happened, which would make the assertion true and meaningless. It did: on the
first full run the fixture's writer (16 KiB every 60 ms) completed in ~0.8 s and
the precondition `expect(received).toBeLessThan(fixture.byte_size)` **failed**
with `Expected: < 227977 / Received: 227977` — the test caught its own vacuity
before I did. The writer was slowed to ~32 KiB/s so the arrival outlasts the
setup, and the precondition is asserted **twice**: once at the top of the test
and again immediately before the seek (`arrivedBeforeSeek`). A second check:
the two statuses that only exist for an arriving blob are observed in the same
run — the renderer console logs `416` (a range past the declared total) while a
`206` for a range inside the prefix carries
`bytes 0-99/227977`, the **declared** total of a file that was a fifth present.

**Claim 2 — "quit stops the seat."** The risk is that the process is gone
because Playwright's `app.close()` kills the whole process tree, not because the
supervisor's sequence ran — which would make the ordering untested and the
`SIGTERM`/`SIGKILL` escalation decorative. Three checks. (a) The sidecar is
spawned with `detached: false`, so `app.close()` *would* take it down; so the
e2e assertion alone is not proof, and the ordering is asserted separately in
`sidecar-supervisor-core.test.ts` as a list with three index comparisons
(`dispose` before `terminate-command`, `await-close` before `sigterm`,
`await-exit` before `unlink-socket`). (b) The seat's own side is proven without
Electron at all: `the_shell_attaches_reads_a_named_page_and_terminates_the_seat`
sends `terminate` over a real socket, reads the `result` and then the `closing`,
and then polls `child.try_wait()` until the process exits **0 of its own
accord** — before any signal. That test found a real bug in my first version: it
used `/proc/<pid>` to detect the exit, which still exists for an unreaped
zombie, so it reported the seat as alive when it had exited cleanly. (c) The
socket file's disappearance is checked separately from the process, so
"unlinked" and "exited" cannot pass for each other.

## Wave 3 — lane E: the KMP mobile shell, the ABI binding, three screens, and the experiment that is a protocol

The mobile tree: one Kotlin Multiplatform shared module over the five-function C
ABI, three screens as protobuf state machines, a Compose shell and a SwiftUI
shell that render finished states and own nothing, and the iOS background
transfer experiment written so an owner's device run produces the number that
decides. Doctrine digest stamp: law `53be88c22ab5`.

**What this lane could prove, and where it drew the line.** There is no Android
SDK, no Xcode, no simulator and no device on this machine. Every claim that
needs one is an owner hand-off with an exact command in
[`mobile/README.md`](../mobile/README.md), whose first table is the whole list.
Nothing here is a passing stub and nothing is a silent skip: the iOS actuals
that cannot be written honestly fail loudly with the command that unblocks them
(`IosSecureStore` refuses rather than writing a vault credential to a plist),
the Android target is not in the build at all unless `ANDROID_HOME` is set and
says so on every configuration, and `:core:jvmTest` **fails** rather than skips
when the cdylib or the fixture vault is missing.

### What landed, by commit

**`b9472eda` — `build(mobile): the KMP skeleton`**

- `mobile/settings.gradle.kts`, `mobile/build.gradle.kts`,
  `mobile/gradle.properties`, `mobile/gradle/libs.versions.toml`,
  `mobile/gradle/wrapper/{gradle-wrapper.jar,gradle-wrapper.properties}`,
  `mobile/gradlew`, `mobile/gradlew.bat`, `mobile/.gitignore`,
  `mobile/ios-deployment-target`
- `mobile/core/build.gradle.kts`, `mobile/shared/build.gradle.kts`
- `mobile/core/src/nativeInterop/cinterop/centraid.def`
- `mobile/core/src/commonMain/kotlin/dev/centraid/core/{CoreStatus,CoreFailure,ArtifactIdentity,CentraidAbi,CentraidCore}.kt`
- `mobile/core/src/jnaMain/kotlin/dev/centraid/core/JnaCentraidAbi.kt`
- `mobile/core/src/jvmMain/.../CentraidAbi.jvm.kt`,
  `mobile/core/src/androidMain/.../CentraidAbi.android.kt`,
  `mobile/core/src/iosMain/.../CentraidAbi.ios.kt`
- `mobile/core/src/jvmTest/kotlin/dev/centraid/core/{AbiContractSpec,AbiRoundTripSpec,FakeCentraidAbi}.kt`

**`f522e0d2` — `feat(mobile): three screens as protobuf state machines`**, with
**`d9d1e785`** staging the `.proto` that commit compiles against — it was left
out of its `git add` path list, so `f522e0d2` does not build on its own. The fix
is a separate commit rather than a rewrite because the branch had already been
built and measured on top of it; a reader bisecting should treat the pair as one.

- `crates/api-proto/proto/centraid/screen/v1/screen.proto` — `TallyListState/Event`,
  `PhotosGridState/Event`, `NotesEditorState/Event`, `SeatState`, `Money`,
  `ReadFailure`, `Loading`, `PhotoStateView`, `BackupState`, `MediaPermission`
- `contracts/screens/{tally,photos,notes,seat}/*.{textproto,bin}` (19 fixtures),
  `contracts/screens/manifest.json`, `contracts/tools/build-screen-fixtures.ts`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/screen/{ScreenMachine,ScreenHost,TallyListMachine,PhotosGridMachine,NotesEditorMachine}.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/nav/Navigation.kt`,
  `.../mount/Mount.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/{ScreenFixtureSpec,ScreenMachineSpec,NavigationAndMountSpec,CommonMainIsPlatformFreeSpec}.kt`

**`af91a36e` — `feat(mobile): the sync/lifecycle scheduler, the write gate, the platform seams`**

- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/{Lifecycle,WriteGate}.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/platform/PlatformServices.kt`
- `mobile/shared/src/{jvmMain,androidMain,iosMain}/kotlin/dev/centraid/shared/platform/PlatformServices.*.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/SyncSchedulerSpec.kt`

**`7bc99be3` — `feat(mobile): Compose and SwiftUI over the emitted tokens, the experiment, the promise`**

- `mobile/androidApp/build.gradle.kts`, `src/main/AndroidManifest.xml`,
  `src/main/res/xml/{data_extraction_rules,full_backup_content}.xml`,
  `src/main/kotlin/dev/centraid/android/{CentraidApplication,MainActivity,HomeScreen}.kt`,
  `.../theme/Theme.kt`, `.../screens/{TallyListScreen,PhotosGridScreen,NotesEditorScreen}.kt`
- `mobile/iosApp/{Package.swift,project.yml}`, `Resources/Info.plist`,
  `Sources/{CentraidApp,ShellModel,TallyListView,PhotosGridView,NotesEditorView,StateViews,CentraidCore}.swift`,
  `Tests/ScreenFixtureTests.swift`, `Design/Theme.swift` (generated)
- `contracts/tools/export-native-theme.ts`; generated:
  `design/native-theme.json`, `copy/{notes,photos,shared,tally}.json`,
  `mobile/shared/src/commonMain/kotlin/dev/centraid/design/{Tokens,Copy}.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/{NativeThemeSpec,NativeAccessibilityLintSpec}.kt`
- `mobile/maestro/README.md`, `ios-transfer-experiment.md`,
  `flows/{selectors.md,tally-list.yaml,photos-grid.yaml,notes-editor.yaml,cold-start-and-relaunch.yaml}`
- `mobile/README.md`, `.github/workflows/lane-release-mobile.yml` (EAS retired)
- `docs/mobile-offline.md` (the per-state promise, provisional),
  `docs/platform-gating.md` (the native parity rows),
  `docs/client-keying.md` (rules 11 and 12)
- `contracts/handoff/E/{README.md,mobile-jvm-step.patch,release-yml.patch,device-lane-bodies.md,measured.md,proposed-patches.md}`

**`5d2a0a53` — `test(mobile): the source-scanning specs declare their sources as task inputs`** —
the two defects the falsification below found in this lane's own work, fixed,
plus the hand-off numbers corrected to what was actually measured.

### Exit list

| Command | Outcome |
| --- | --- |
| `cd mobile && ./gradlew mobileJvm` | **green** — 75 tests across `:shared:jvmTest` and `:core:jvmTest`, plus `koverXmlReport`. Three consecutive runs: **91 s** cold, **15 s**, **16 s** warm |
| the ABI round trip | **green** — `AbiRoundTripSpec` "open, call, next_event, free and close, against the real library", over JNA against the `cargo`-built `libcentraid_core_ffi.so` on a `spike-fixture` vault |
| the five calls' latencies | `open` **12.9–13.0 ms**; `call` p50 **398–494 µs** / p95 **563–1177 µs** across the three screens' reads; `next_event` timeout path **133–170 µs**; `close` **2.3–2.9 ms**; `free` has **no number of its own, by contract** — it is inside `call`'s harvest, which is what clause 1 requires, and measuring it separately would mean a binding that held a buffer across two calls |
| the `call` budget | measured; the proposed `contracts/ledgers/gate-budgets.json#mobile-jvm` row is `budgetSeconds` **420** and the `call` ceiling **3,600 µs** (three times the worst measured p95). `kotlinNativeLinkSeconds` stays **null**. Numbers and reasoning: `contracts/handoff/E/measured.md` |
| the threading red | **demonstrated** — `UiThreadCallError: centraid_call was invoked on the UI thread (centraid-ui @spec-scope-1871678080#10) … on a device this is the freeze` |
| `contracts/screens` | **19 fixtures**, 4 screens, decoded by Wire in `ScreenFixtureSpec`. The Swift twin is `mobile/iosApp/Tests/ScreenFixtureTests.swift` — written in full, **never run** (owner hand-off) |
| open question 10's line counts | **1.72×** averaged over the three screens; see below |
| the Konsist red | **demonstrated** — `[mobile/shared/ScreenHost: java.io.File]` |
| the accessibility reds | **demonstrated** — `[NotesEditorScreen.kt: Icon( with no contentDescription]` and `[PhotosGridView.swift: Image(systemName:) with neither accessibilityLabel nor accessibilityHidden(true)]` |
| the `warning.mode=fail` red | **demonstrated** — `Deprecated Gradle features were used in this build, making it incompatible with Gradle 10` → `BUILD FAILED`, with no `--warning-mode` on the command line |
| the theme drift check | **idempotent** — `bun contracts/tools/export-native-theme.ts && bun contracts/tools/build-screen-fixtures.ts && bun run format && git diff --exit-code design copy mobile contracts/screens` is clean |
| `cargo test -p centraid-core-ffi` | **green** — 29 tests (7 + 10 + 7 + 2 + 3). Lane E changed nothing in that crate |
| `cargo test -p centraid-api-proto` | **green**, including `every_proto_in_the_tree_is_compiled` |
| `buf lint` / `buf breaking --against '.git#ref=529435a1'` | **both clean** |
| `cargo xtask gate --profile local` | **PASS** — `fmt` 0.8 s, `clippy` 26.6 s, `cargo test --workspace` 189.0 s green, `rules`, `ledgers` (5 ledgers hold); 216.5 s of the 3200 s cold ceiling |
| `cargo xtask rules` | `commonmain-no-platform-import` **flipped from PENDING to applied** — 12 files scanned, clean. See finding 8 for the shared-target-dir trap that makes this answer depend on which worktree last compiled `xtask` |
| `nm -D --defined-only …/libcentraid_core_ffi.so \| grep ' T centraid_' \| wc -l` | **5** |
| `actionlint .github/workflows/lane-release-mobile.yml` | clean |
| `bun run format` + `format:check` | clean |
| governance hooks on every commit | `format-check`, `lint-check`, `law`, `doc-integrity`, `estate-separation`, `managed-tree-integrity`, `commit-message-format`, `no-hardcoded-colors`, `no-hardcoded-model-ids` — all green, no `SKIP_*` and no `--no-verify` |
| kover | `INSTRUCTION 84.8%`, `BRANCH 72.6%`, `LINE 86.8%` over hand-written `commonMain`, against a 70 % floor. The report is titled **"centraid mobile :shared — JVM only; not a Kotlin/Native number"**; generated code is excluded, for the reason in `mobile/README.md` |

### Open question 10 — criterion (a), measured

**The method, exactly.** The protobuf side is the `.proto` source a human
maintains — every `message` and `enum` block for that screen, counted
non-blank and non-comment. The Kotlin side is the equivalent hand-written
sealed classes and data classes with the same fields, the same nesting and the
same three-state content union, written as a throwaway under `/tmp` (**not in
the tree**) and **compiled** against this module's `jvmTest` source set, so the
comparison is real code and not a sketch. Wire's generated output is excluded
from both sides: nobody maintains it, and counting it would measure a code
generator.

| Screen | proto lines | Kotlin lines | ratio |
| --- | --- | --- | --- |
| Tally list (`TallyListState`, `TallyListData`, `TallyRow`, `TallyListEvent`) | 63 | 43 | **1.47×** |
| Photos grid (+ `PhotoCell`, `PhotoStateView`, `BackupState`, `MediaPermission`) | 140 | 70 | **2.00×** |
| Notes editor (`NotesEditorState`, `NoteDraft`, `NotesEditorEvent`) | 69 | 41 | **1.68×** |
| **average over the three screens** | | | **1.72×** |
| (the shared messages: `SeatState`, `ReadFailure`, `Loading`, `Money`, the envelope) | 62 | 33 | 1.88× |

**1.72× — over the 1.5× threshold** on criterion (a). Tally alone is *under* it
at 1.47×; Photos is twice the Kotlin, and it is the screen with the most enums,
which is where protobuf's `_UNSPECIFIED` zero value and `buf`'s
`ENUM_VALUE_PREFIX` rule cost the most lines. The count also **understates**
protobuf's cost: it excludes the 19 `.textproto`/`.bin` fixture pairs, the
manifest and the `buf convert` step that keeps them current, none of which
sealed classes would need.

Criteria (b) — a SwiftUI/Compose disagreement on a shared state fixture more
than once — and (c) — >1 ms p95 Kotlin→Swift delivery on the reference iPhone at
50k assets — are both device measurements and **neither has been taken**.

**What the number does not settle**, and what the owner should weigh against it:
the one thing protobuf bought here is the Swift half of
`ScreenFixtureTests.swift`. Nineteen fixtures, one byte format, two decoders,
and a Swift test a macOS session runs without porting anything. SKIE over
sealed classes gives Swift the types but not a byte-level fixture the two
languages can share, so "one fixture, two languages" — v0's own pattern, from
the tunnel module — would have to be replaced by something. That is a
judgement, not a measurement, and it is the owner's.

### Decisions — lane E

- **D-1020-E0-1** — **the toolchain is current stable, not the container's.**
  Gradle **9.7.1** via the committed wrapper (with `distributionSha256Sum`),
  Kotlin **2.4.20**, AGP **9.4.0** (the newest with no alpha/beta/rc suffix in
  Google's maven metadata), Wire 7.0.1, Kotest 6.2.5, Turbine 1.2.1, kover
  0.9.9, Konsist 0.17.3, JNA 5.19.1, coroutines 1.11.0. Options: (i) the
  container's preinstalled Gradle 8.14.3 / Kotlin 2.0.21, which the brief
  assumed and which printed *"Deprecated Gradle features were used in this
  build, making it incompatible with Gradle 9.0"* on the first run;
  (ii) current stable with `org.gradle.warning.mode=fail`. **Adopted (ii)** on
  the owner's instruction of 2026-09-12, amending D-1020-E0. Its cost is that a
  Gradle or plugin upgrade reds here before anywhere else, which is the point.
  Three deprecations were removed to get clean: `project(":core")` as a
  dependency notation inside `binaries.framework { export(...) }` (now
  `dependencies.project`), and two `val x by tasks.registering(T::class)` /
  `val x by creating` Kotlin-DSL delegate forms (now `register<T>(name)` and
  `create(name)`) (#1020).
- **D-1020-E1a** — **the Android target is configured by NAME, not through
  typed accessors.** Options: (i) declare AGP in `plugins {}` with
  `apply false`, which resolves it from `google()` on every configuration of
  this build including on machines with no SDK — a download to reach a failure;
  (ii) add it to the root `buildscript` classpath conditionally and configure
  the `androidLibrary` extension by name with `withGroovyBuilder`, which is not
  type-checked here; (iii) a precompiled convention plugin in a
  `mobile/build-logic` included build, the mature answer, which doubles the
  setup. **Adopted (ii)**, with the trade written out in
  `mobile/core/build.gradle.kts`: that block is proved by the owner hand-off and
  nowhere else, and a silently-skipped Android target would have been worse
  (#1020).
- **D-1020-E1b** — **cinterop commonization ON, klib cross-compilation OFF on
  Linux.** `iosMain` needs commonization to see `:core`'s one `centraid` klib
  across three iOS targets — it is what makes the iOS actual a single file. But
  processing a cinterop needs an Apple toolchain, and with cross-compilation
  left on, a Linux `:core:compileKotlinJvm` **fails** with "Cross Compilation
  with Cinterop Not Supported" rather than simply not building iOS. Options:
  (i) drop the cinterop from the shared source set and write three per-target
  actuals; (ii) turn commonization off and let `iosMain` not resolve;
  (iii) keep commonization and set `kotlin.native.enableKlibsCrossCompilation=false`,
  with the macOS hand-off passing `-P…=true`. **Adopted (iii)** (#1020).
- **D-1020-E3a** — **all screen messages go in the existing `screen.proto`, one
  file.** `crates/api-proto/build.rs` carries a NAMED list of every `.proto` and
  `tests/tree.rs` asserts the list and the directory agree; both are lane C's.
  Options: (i) one file per screen plus a `build.rs` edit outside this lane's
  ownership; (ii) one file. **Adopted (ii)** — for a shell-internal package with
  a PR-base-only compatibility promise, one file costs nothing and keeps the
  change inside the boundary (#1020).
- **D-1020-E5a** — **`.xcode-version` stays `16.4`, unchanged, and the
  confirmation is the hand-off.** Options: (i) raise it to a current Xcode,
  which on a machine that can neither run `xcodebuild` nor link Kotlin/Native is
  a guess dressed as a decision; (ii) confirm the existing pin and name the
  exact command that settles it. **Adopted (ii)**, which is what the census
  expects ("E confirms or replaces it on the first real iOS compile"). If
  Kotlin 2.4.20's Kotlin/Native refuses that Xcode, the refusal names the
  version it wants and that number goes in the file (#1020).
- **D-1020-E6a** — **the emitter splits `NativeColors` into colours and
  effects.** Three of `packages/design`'s 54 `NativeColors` entries
  (`shadowLg`, `shadowSm`, `shadowAmbient`) are CSS `box-shadow` strings and
  five more are `rgba()` functions. Options: (i) emit them as opaque strings in
  the colour map, making `colors` a map a `Color(Long)` cannot consume;
  (ii) invent a native elevation grammar, a design decision this lane does not
  get to make; (iii) parse the `rgba()` colours into channels, split the three
  shadows into a named `effects: Map<String, String>`, and file the design
  question. **Adopted (iii)**; `NATIVE_EFFECT_ROLES` is the honest record and
  the proposed `packages/design` fix is in
  `contracts/handoff/E/proposed-patches.md` §4 (#1020).
- **D-1020-E7a** — **the accessibility lint is a source scan over both
  surfaces, not Konsist.** Compose's `contentDescription` is a call argument and
  Konsist reads declarations; the Swift half has no Kotlin AST at all. Options:
  (i) two tools that disagree about which files they cover; (ii) one regex
  scanner that strips comments, asserts its own file count, and fails with the
  file and the call site. **Adopted (ii)**, and its advertised failure mode — a
  false positive somebody fixes rather than a false negative nobody sees — fired
  immediately (a six-line comment between an `Image` and its
  `.accessibilityLabel` pushed the label out of the window) and was fixed by
  measuring over code instead of over comments (#1020).
- **D-1020-E7b** — **kover excludes generated code from its report.**
  `centraid.screen.v1.*` (Wire) and `dev.centraid.design.*` (the emitter) are
  four times the hand-written source; including them put line coverage at
  **41.2 %** against a 70 % floor and made the number a measurement of two code
  generators. Options: (i) lower the floor to fit the generated code, which is
  weakening a gate; (ii) exclude the generated packages and keep the floor.
  **Adopted (ii)** — the coverage after the exclusion is 86.8 % of lines, and
  the exclusion is stated in the build file and in `mobile/README.md` (#1020).

### Demonstrated reds

1. **The Konsist rule.** `import java.io.File` added to
   `mobile/shared/.../screen/ScreenHost.kt` →
   `AssertionFailedError: [mobile/shared/ScreenHost: java.io.File]`. `java.*`
   rather than `android.os.Bundle` deliberately: an Android import does not
   compile on the JVM target, so that red would have been a compile failure
   rather than the lint's. `java.io.File` compiles on the JVM, fails on iOS, and
   is the mistake that actually reaches a review.
2. **The accessibility lint, Compose half.** The `contentDescription` removed
   from `NotesEditorScreen.kt`'s pin button →
   `[NotesEditorScreen.kt: Icon( with no contentDescription]`.
3. **The accessibility lint, SwiftUI half.** The `.accessibilityLabel` removed
   from `PhotosGridView.swift`'s `more` control →
   `[PhotosGridView.swift: Image(systemName:) with neither accessibilityLabel nor accessibilityHidden(true)]`.
4. **`org.gradle.warning.mode=fail`.** `val abiFixture by tasks.registering(...)`
   restored → `Deprecated Gradle features were used in this build, making it
   incompatible with Gradle 10` → `BUILD FAILED`, with no `--warning-mode` flag
   on the command line.
5. **The missing-fixture refusal.** `:core:abiFixture` disabled and
   `build/abi-fixture` deleted → `IllegalStateException: the ABI fixture vault
   is missing. Build it with: cargo run -p centraid-core-ffi --bin
   spike-fixture -- … a missing fixture is a red and never a skip`. This is the
   one that matters most: it is what makes "the ABI round trip is real" a claim
   the gate can keep.
6. **The theme drift check.** A colour hand-edited in the emitted `Tokens.kt`
   and **committed**, then the emitter re-run → `git diff --exit-code` fails on
   that file.
7. **The three-state read law**, as a permanent red rather than a demonstrated
   one: `ScreenFixtureSpec`'s "tally/empty-ledger and tally/refused-denied are
   DIFFERENT screens" asserts the two fixtures against each other, so a decoder
   that collapsed them fails rather than passing two separate assertions.

### Findings outside the slice

Each has a patch in [`contracts/handoff/E/proposed-patches.md`](../contracts/handoff/E/proposed-patches.md).

1. **`Vault::open` restarts its id sequence, so the first write after ANY reopen
   collides.** `crates/vault/src/file.rs:59` and `:97` default to
   `SeededIds::new("v1")`, whose counter starts at zero per instance.
   **Reproduced from Kotlin through the real C ABI**:
   `Refused(code=63, detail=entity id is already held by another kind: core_party (#916))`.
   A gateway that restarts fails its next write. Lane D3's file; the patch and a
   three-line red-first test are in the hand-off.
2. **The same refusal ships a raw predicate as its owner-facing sentence**,
   which `command.proto`'s own comment forbids in those words.
3. **`Hello` carries no `ArtifactIdentity`**, so a released shell cannot check
   the core it loaded — even though `crates/centraid/src/identity.rs`'s header
   says the move happens "when `crates/core-ffi` is on the umbrella", and it is.
   Lane C's proto plus lane D2's `Handle::hello`.
4. **`crates/core-ffi` has no fault-injection point**, so no shell can test its
   own clause-9 poison handling against the real library;
   `tests/contract.rs:495` says so itself. Proposed: a `debug-fault` feature
   riding the existing `Admin` request, **no sixth symbol**.
5. **`packages/design`'s `NativeColors` holds three CSS `box-shadow` strings**,
   which `assertNativeColorRoleContract` passes over because it checks which
   keys exist and not what they hold. See D-1020-E6a.
6. **`Cargo.lock` was stale for `centraid-core-ffi`** (missing `centraid-vault`,
   in its `Cargo.toml` since wave 2), so every `cargo build` in this repository
   dirtied the tree; lane E reverted the change on every commit rather than
   carrying a file it does not own. **RESOLVED on the rebase onto `529435a1`** —
   the lock now carries the entry, and `cargo check --workspace` leaves it
   clean. Recorded because the workaround is visible in this lane's commits and
   a reader should know why it is no longer needed.
7. **`docs/platform-gating.md`'s parity table claimed an accessibility parity
   that did not exist** — v0's two gates are both web-shaped and neither reaches
   React Native. That doc is lane E's, so it was **fixed in place** rather than
   filed: the native table now names what is real, what is net-new, and the one
   row (type and target floors) still a gap with nothing checking it.
8. **`cargo xtask`'s repo root is baked in at COMPILE time**
   (`main.rs:142`, `env!("CARGO_MANIFEST_DIR")`), so with the shared
   `CARGO_TARGET_DIR` the wave 3 briefs mandate, every path-based rule scans
   whichever worktree last compiled `xtask`. Observed three different answers
   from the same command in the same tree; the failure direction is **reports
   clean**, which is the worst one. `sql-confinement`,
   `no-listening-socket` and `abi-five-symbols` are all path-based and all three
   would have been affected. Patch in the hand-off: resolve the root from the
   current directory and panic rather than fall back.

### Owner hand-offs

Every one has its exact command in `mobile/README.md`.

1. **The iOS transfer experiment** — `mobile/maestro/ios-transfer-experiment.md`.
   5 states × 2 transports × 4 measurements, a 2,000-asset / 6 GB corpus on a
   **named reference device** (R-1020-20), the `lldb`
   `_simulateLaunchForTaskWithIdentifier:` command that makes state 4 measurable
   at all, four fixed evidence file names, and a decision table whose four
   sentences are already written. Hand back: the four JSON files, the device
   name and iOS version, and one line saying which row they land in.
2. **The iOS build** — `./gradlew -Pkotlin.native.enableKlibsCrossCompilation=true
   :shared:linkDebugFrameworkIosSimulatorArm64`, then `protoc-gen-swift`, then
   `xcodegen generate`, then `swift test`. Four things are deliberately
   unimplemented and fail loudly: `IosSecureStore` (needs a `Security.framework`
   cinterop — it refuses rather than writing a credential to a plist),
   `IosMediaLibrary.page` (needs `PHAsset` + a streamed SHA-256),
   `IosNetworkStatus` (needs `NWPathMonitor`; until then it reports
   `platformRefused`, which is TRUE and which `WriteGate` treats as
   not-reachable), and `ShellModel.send`.
3. **The Swift fixture test** — `cd mobile/iosApp && swift test`. Written in
   full over the same 19 fixtures. **It has never run**, and reporting it as a
   pass would be the single most misleading thing this lane could do.
4. **The Android build** — `ANDROID_HOME=… ./gradlew -Pcentraid.android=true
   :androidApp:assembleDebug`, plus `connectedBenchmarkAndroidTest` for the
   Macrobenchmark numbers on a named device.
5. **The Maestro flows** — `maestro test mobile/maestro/flows` with
   `MAESTRO_VERSION=2.6.1` (v0's pin). **Add the 17 `testTag` /
   `accessibilityIdentifier` values from `flows/selectors.md` first**: they are
   paired with the run that proves each selects exactly one thing, because
   seventeen strings nothing checks are seventeen strings that rot.
6. **Store enrolment** — `docs/enrollment.md`; the native lane declares seven
   secrets of its own and reports `scaffold-only` without them.
7. **`.xcode-version`** — confirm `16.4` or replace it on the first real iOS
   compile (D-1020-E5a).

### To lane G

`contracts/handoff/E/` carries the patch and the numbers.
`mobile-jvm-step.patch` turns `Profile::MobileJvm` from a ledger placeholder
into a real profile with one `mobile-jvm` step (the cargo prerequisite,
`./gradlew mobileJvm`, and the generated-artifact drift check) and widens
`commonmain-no-platform-import` to cover `mobile/core` as well —
`git apply --check` clean against the umbrella head `529435a1`. **Lane E did not apply
it**: `Profile::MobileJvm`'s refusal message, its two null ledger rows and its
unit test are one design lane B2 wrote (D-1020-B2-3), and flipping it touches
three of G's files rather than one. `measured.md` carries the proposed
`budgetSeconds` (**420**, from 91 s cold / 15 s / 16 s warm) and the `call`
ceiling (**3,600 µs**); `kotlinNativeLinkSeconds` stays **null**, because no
machine in CI links Kotlin/Native and filling it with a JVM number is the one
thing the report title exists to prevent. `device-lane-bodies.md` has the four
`run:` bodies, each of which still reports a loud `Skipped` — including the
emulator and simulator checks that keep a parked ceiling from being promoted by
accident, and `battery-per-background-pass`, which is **not automatable on
either platform** and says so rather than deriving a number from a proxy.
`release-yml.patch` drops the two retired EAS secrets from `release.yml`'s call.

### Falsification

The two riskiest claims in this diff, the throwaway check run against each, and
the result. **Both found something.**

**Claim 1 — "the ABI round trip is real, not a mock."** A binding test can look
like a round trip and be a test of a fake: the `AbiAnswer` type, the
`FakeCentraidAbi` in the same source set, and a `Native.load` that silently
found some other library would all produce a green. Three checks:
(a) `nm -D --defined-only $CARGO_TARGET_DIR/debug/libcentraid_core_ffi.so | grep ' T centraid_' | wc -l` → **5**, so the library under test is the
five-symbol cdylib; (b) the fixture vault was **deleted** and the fixture task
disabled, and the spec re-run → it FAILED with the
`cargo run -p centraid-core-ffi --bin spike-fixture` command in the message,
rather than passing over an absent file; (c) the seeded read asserts **100 rows
and a non-null keyset cursor** from a vault `spike-fixture` seeded with 200
parties through the real command plane — a number no fake in this tree
produces. The `core.add_party` refusal in finding 1 is a fourth check by
accident: a mock would not have reproduced a bug in `crates/vault`'s id
generator.

**Claim 2 — "the token table is generated from `packages/design` and cannot
drift."** A generator can be run once and then hand-edited, which is exactly
the failure census §E seam 11 names. Two checks, and **both found a real
weakness**:

(a) A colour was edited by hand in `mobile/shared/.../design/Tokens.kt` and the
emitter re-run. With the edit UNCOMMITTED, `git diff --exit-code` came back
**clean** — the regeneration had silently restored the original value, so the
check proved nothing. Redone with the edit **committed**, the same sequence
failed, which is the shape the gate step actually runs in (CI regenerates over
a committed tree). The check works; the first way of testing it did not, and
the distinction is worth recording: a drift gate that only catches *committed*
drift is exactly what is wanted, and the first run did not show that.

(b) `NativeThemeSpec`'s "the emitted JSON, the Kotlin table and the Swift table
are the same table" was run against a `Theme.swift` with `"accent":` renamed in
the LIGHT scheme only. **It passed** — the assertion used `contains`, and the
dark scheme's copy of the role satisfied it. A presence check over a file with
two schemes in it cannot tell a complete table from half of one. The assertion
now **counts** occurrences (exactly two per role, one per scheme) and the
falsification then failed as it should:
`mobile/iosApp/Design/Theme.swift: accent … expected:<2> but was:<1>`.

That second run also exposed a third defect, in the build rather than the test:
the first attempt produced **no output at all**, because `:shared:jvmTest` was
`UP-TO-DATE` — `Theme.swift`, `design/`, `copy/`, `contracts/screens` and both
view trees are read by these specs at runtime and were not declared as task
inputs. A source-scanning test whose sources are not inputs is a test that
passes on yesterday's tree, which is the same failure as a lint over an empty
file set. `mobile/shared/build.gradle.kts` now declares all five as
`inputs.dir(...)`, and the falsification was re-run against the fixed build
before this receipt was written (`5d2a0a53`).

The residual risk is named rather than closed: the drift check itself runs in
the `mobile-jvm` gate step lane G has not spliced yet, so until it does, the
three artifacts are kept in step by `NativeThemeSpec` and by nothing else.

## Wave 4 — lane assist: the assistant plane in Rust — a ledger band, a turn plane that asks consent first, harnesses as external processes, and an MCP server with no socket

`crates/assist` is the assistant plane's **meaning**; it holds no SQL, no model
and no inference loop. The three processes are the gateway, a harness CLI it
spawns over stdio, and `centraid mcp`, which the harness spawns back. Nothing
listens. `crates/assist/README.md` is the current-state map of that shape.

### What landed, by commit

**`f3d48d8b` — `build(deps)`** · `Cargo.toml`, `Cargo.lock`
`agent-client-protocol = "2.1"` (Apache-2.0, MSRV 1.88) and `futures`, one line
each in `[workspace.dependencies]`. The crate's `unstable_mcp_over_acp` feature
**exists and is not enabled**; the `Cargo.toml` comment says why and records it
as the future collapse of `centraid mcp` into the ACP connection itself.

**`23d00b2b` — `feat(assist)`** · `crates/assist/{Cargo.toml,src/{lib,registry,preflight,adapters,spawn_env,low_priority}.rs}`,
`contracts/assist/harnesses.json`, `contracts/tools/export-harnesses.ts`
The registry as data (D-1020-AS1): **17 kinds**, of which **5** are in
`SUPPORTED_HARNESS_KINDS` (`codex, claude-code, opencode, grok, pi`), generated
from v0's `registry.ts` and loaded by `registry::Registry`. `registry::LaunchPlan`
is the one answer the module gives, so nothing outside `registry.rs` branches on
the kind. v0's two prose SAFETY comments became **`refuse_args` data** —
`--mdns` for opencode (it defaults its listen host to `0.0.0.0`, publishing an
unauthenticated code-execution harness to the LAN) and `--port` for copilot — 
because a comment cannot stop a member typing one into the extra-args box.
`spawn_env`'s PATH scrub strips every `node_modules/.bin`; `low_priority` is
nice +10 plus `ionice` on Linux and nothing on Windows. Preflight is
warn-never-block with a 24 h `--version` cache and `versionAtLeast: false` ⇒
`ok: true`.

**`ff618621` — `feat(vault)`** · `crates/vault/src/{lib.rs,ledger/{mod,schema,store,health,consent,archive,sql_guard}.rs}`,
`crates/vault/tests/ledger.rs`, `contracts/assist/ledger-fixture.json`,
`contracts/tools/export-ledger-fixture.ts`
The ledger band (D-1020-AS3), and **no new migration** — see `D-1020-AS8`. The
band is machinery, registered names-only, all 14 tables in `localTables` so
they leave neither in the portable export nor on the replica, **by band**.
`sql_guard` is `vault_sql`'s grammar: one statement, `SELECT`/`WITH … SELECT`/
`EXPLAIN` only, 8,000 statement bytes, `MAX_ROWS = 500`, 8 forbidden prefixes,
15 forbidden tables, and the principal checked before the statement is parsed.

**`08c798ac` — `feat(assist)`** · `crates/assist/src/{turn,health,acp,bin/fake-acp-harness}.rs`,
`crates/assist/tests/acp_turn.rs`
The turn plane (D-1020-AS4) and the ACP client (D-1020-AS5). `run_turn` asks
the posture's consent **before** it touches the dispatcher, and `TurnPosture`
cannot be constructed without an `EgressConsent`. `HYDRATION_TOKEN_BUDGET` 8,000
and `HYDRATION_MIN_TURNS` 2 are v0's. `health` carries the `-1` permanent
sentinel (`auth` failures, because backing off a wrong key is not a wait) and
`half_open_claimed_at` so exactly one caller claims the probe. `Dispatch` is the
trait the automations lane implements as `ctx.delegate`.

**`e08c80a7` — `feat(centraid)`** · `crates/centraid/{Cargo.toml,src/{main.rs,cmd/{mod,mcp,assist}.rs},tests/mcp_stdio.rs}`
`centraid mcp` over stdio (D-1020-AS2) and `centraid assist` (D-1020-AS7, no
`sql` subcommands per #286). Three tools, five methods, stateless, no session
id, nothing bound.

**`96513ba1` — `test(assist)`** · `crates/assist/src/corpus.rs`,
`crates/assist/tests/prompt_injection.rs`, `crates/assist/README.md`,
`contracts/assist/prompt-injection/**` (14 payloads + `ORIGIN.md`)
The #842 corpus, copied not authored, run in Rust (D-1020-AS6).

**`fa79ff81` — `feat(xtask)`** · `crates/xtask/src/gate.rs`,
`contracts/handoff/assist/gate.patch`
The `prompt-injection` `pr` step. **`crates/xtask` is lane X3's this slot**, so
the step is both applied here in a commit touching only `gate.rs` and filed as
a patch under `contracts/handoff/assist/` — the root can drop the commit and
apply the patch if X3's changes conflict.

**`5026b0ac`, `8b20948f` — `style`** · rustfmt/clippy and oxfmt/oxlint over the
earlier slices; `contracts/handoff/assist/README.md`.

**`59941ff8` — `fix(assist)`** · `crates/assist/src/preflight.rs`,
`crates/centraid/src/cmd/assist.rs`
**A real bug this slot shipped and then found.** `VersionProbe::version` took
the `LaunchPlan`, so for the two adapter kinds it probed the process a turn
spawns — `node` — and compared **node's** version against the harness's
minimum. `centraid assist preflight claude-code` answered `v22.22.2`,
`versionAtLeast: true`, against a 2.1.126 floor: a green preflight that says
nothing about the harness. `docs/harnesses.md:69`–`:71` already stated the
distinction (`defaultBin` always names the user-facing CLI, and
`HarnessPrefs.binPath` means "the harness CLI", not "the process we spawn"), so
this was a documented invariant broken in the port, not an open question. The
trait now takes the CLI path explicitly and
`an_adapter_kind_probes_the_harness_cli_and_never_the_node_that_hosts_it`
asserts **which program was asked**, not just the answer.

### Exit list

| command | outcome |
|---|---|
| `cargo fmt --all --check` | clean |
| `cargo clippy -p centraid-assist -p centraid-vault -p centraid --all-targets` | clean, no warnings |
| `cargo test -p centraid-assist` | 66 unit + 5 `acp_turn` + 3 `prompt_injection` = **74 passed, 0 failed** |
| `cargo test -p centraid-vault` | **236 passed, 0 failed** — 153 unit, 16 in the new `tests/ledger.rs`, 67 in the pre-existing suites |
| `cargo test -p centraid` | 87 + 3 + 3 + 9 + 3 + 7 = **112 passed** (incl. 3 `mcp_stdio`) |
| `cargo test --workspace` | **926 passed, 0 failed**, 71 suites (819 + lane E's at spawn) |
| `cargo xtask gate --profile local` (warm) | **no single run was both all-green and under budget, and the reason is the box, not the tree.** Three consecutive runs on the same commit: all steps green at `283.3s` against the 120s budget; then `BUDGET ok — 114.5s of 120s` with `test` red on finding 1; and a cold first run at `25.0s` against the `3200s coldLocalProfileSeconds` ceiling, also red on finding 1. Suite time is **80.9s** of the 283.3s (the 71 test binaries' own reported times, largest `crates/sim`'s `tests/seeds.rs` at 27.5s); the remainder is recompilation and lock waiting caused by other lanes touching the shared target directory. This lane's own suites are **4.71s** of that 80.9s (93 tests: `prompt_injection` 3.34, `tests/ledger.rs` 1.31, 66 unit 0.03, `acp_turn` 0.02, `mcp_stdio` 0.01), so the overrun is not chargeable here and **the budget was not touched** (finding 2) |
| `cargo xtask gate --profile pr` | 18 steps, **14 green**, 4 red — `ci-policy`, `secrets` and `osv` inherited, `test` poisoned by the shared target directory (both below). `BUDGET ok — 669.6s of 1500s` on a cold tree |
| `bun contracts/tools/export-harnesses.ts && bun run format && git diff --exit-code` | byte-identical |
| `bun contracts/tools/export-ledger-fixture.ts && bun run format && git diff --exit-code` | byte-identical |
| `cp packages/server/src/acp/prompt-injection/corpus/*.json … && bun run format && git diff --exit-code` | byte-identical, 14/14 |
| `bun run format` / `format:check` | `All matched files use the correct format`, 5,971 files |
| `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5` | 10 rules, **no findings** |
| `bash .governance/run.sh` | **all 10 directives passed** |
| `bun run check:push:static` | **4/4** in 30.6s (and the gate's own `ts-static` step, green) |

The two lines the exit criterion asks to be quoted, from the `pr` run:

```
ok    prompt-injection    4.2s  cargo test -p centraid-assist --test prompt_injection (14 payloads)
ok      no-listening-socket — 197 file(s) scanned, clean (9 in the rule runner)
```

The 197 files include every `.rs` under `crates/assist` and `crates/centraid`.
The claim is not only a grep: `crates/centraid/tests/mcp_stdio.rs` reads the
child's **own** `/proc/<pid>/fd` and `/proc/<pid>/net/tcp{,6}` while it is
serving, matching `LISTEN`-state rows against the child's own socket inodes, so
the negative is about that process at that moment. It runs on this box (it is
`cfg_attr(not(target_os = "linux"), ignore)`, not `ignore`).

**The four red `pr` steps, each judged.**

| step | verdict |
|---|---|
| `osv` | **inherited**, named in the wave 2 brief: `astro@7.1.5 (score 9.8)`. |
| `secrets` | **inherited, and one more than the brief names.** `findings.txt` is two files: `packages/model-runtime/LICENSES.md` (the named one) and `contracts/golden/format-golden.json:23` — a `generic-api-key` hit on `"masterKeyHex": "fffefdfc…e3e2e1e0"`, a counting-pattern **test fixture key** that landed with `c5de2b39` in wave 2. Neither file is in this lane's diff. Finding 4 below. |
| `ci-policy` | **inherited.** `lint:path-filters` reports `copy`, `design` and `mobile` each "claimed by no `changes` filter and has no ledger entry" — three top-level trees wave 3 added. `.github/**` and `tests/path-filter-ledger.json` are lane G's and the estate's; this lane adds no top-level tree. Finding 5 below. |
| `test` | **not this tree's code.** `error[E0063]: missing field 'identity' in initializer of centraid_api_proto::core_v1::Hello` at `crates/protocol/src/version.rs:39`. No `.proto` in this worktree declares `identity`, and neither file is in this lane's diff. Finding 1 below. The real verdict for this tree is the standalone `cargo test --workspace` above: **926 passed, 0 failed.** |

### The #842 corpus: 14 payloads, 10 proven, 4 deferred loudly

The gate step prints the size, counted from the directory rather than taken from
the test, so the two cannot agree with each other while both being wrong.

Ten are proven end to end through a real turn against `fake-acp-harness`:
`read-confinement` (5), `no-out-of-grant-entity` (3), `egress-no-widen` (2).
Each run (a) asserts the payload's sentinel **was in the prompt the harness
actually received** — a corpus that passed because nothing was injected would
prove nothing — (b) applies the attempt through the same confined door the turn
had against a real founded vault, and (c) asserts the outcome **class** and that
no forbidden row exists. Structural enums only; no ids, no timestamps, no
ordering, and no fake clock, because a fake timer wedges the subprocess I/O.

The four `risk-park` payloads are **deferred with a test that fails the day the
gap closes**, not marked passing:
`crates/assist/tests/prompt_injection.rs::the_park_gate_is_still_missing`.
`CommandDefinition::confirm` is carried, documented and **never read**
(`crates/vault/src/commands/mod.rs:167`–`:169`), so a confirm-gated command
invoked by a non-owner **executes** instead of parking for the owner. The
deferred payloads still assert what is true today — the attempt wrote no
forbidden row — so a regression that made them worse is still caught. The
numbers `(14, 10, 4)` are asserted as a triple with a comment saying a change in
them must be read, not re-baselined.

`the_one_allowed_payload_proves_the_corpus_is_not_passing_by_refusing_everything`
is the anti-vacuity check: exactly one payload expects `allowed`, and it is run.

### The fake-harness `tools/call vault_sql` transcript

Live, off the shipped binary launched the way a harness launches it
(`CENTRAID_SEAT_SOCKET` + `CENTRAID_TURN_TOKEN` in the environment, JSON-RPC on
stdin and stdout), abridged to the three answers:

```
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"centraid","version":"1.0.0-alpha.0"}}}
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"vault_sql",…},{"name":"attachments_list",…},{"name":"attachments_read",…}]}}
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"vault_sql is the owner's surface; this turn runs as `assistant turn`"}],"isError":true}}
```

The refusal is a **tool result the model can read** (`isError: true`), never a
JSON-RPC transport fault: a model that cannot read the refusal retries it.

### A real harness on this box

`command -v codex claude gemini` → **`/opt/node22/bin/claude` only**; no
`codex`, no `gemini`. `claude-code` is one of the two adapter kinds, and the
adapter is not installed, so out of the box the verb reports the hand-off
rather than a version:

```
$ centraid assist preflight claude-code --json
{ "kind": "claude-code", "ok": false, "version": null, "minVersion": "2.1.126",
  "versionAtLeast": null,
  "reason": "claude-code speaks ACP through the @agentclientprotocol/claude-agent-acp adapter, which is not installed. Run `centraid assist adapters install` …",
  "hint": "Install Claude Code (https://claude.com/code) and run `claude login`." }
```

With a stub adapter directory in `CENTRAID_ACP_ADAPTER_DIR` so the launch plan
resolves, the probe runs against the **real** CLI on this box:

```
{ "kind": "claude-code", "ok": true, "version": "2.1.269 (Claude Code)",
  "minVersion": "2.1.126", "versionAtLeast": true }
```

`2.1.269 (Claude Code)` and not `v22.22.2` is the falsification of `59941ff8`
against a real binary rather than against a `Fixed` probe.

**Owner hand-off — one real `initialize` against a real harness.** A real ACP
negotiation needs one of the two npm adapters, and installing it means fetching
and executing third-party code with the member's vault open. That is the
decision `centraid assist adapters install` deliberately **prints rather than
runs**, and it is the owner's, not this lane's. The command and the evidence:

```
npm i -g --prefix "$(centraid assist adapters --json | jq -r .directory)" \
  @agentclientprotocol/claude-agent-acp
centraid assist preflight claude-code --json     # expect ok:true, a 2.1.x version
```

Expected evidence: an `initialize` answer carrying the adapter's
`agentCapabilities`, and a `session/new` that returns an opaque session id.
Until then the protocol half is proven against `fake-acp-harness`, which is a
genuine ACP `Agent` on the other end of a real pipe — not a mock of the client
under test.

### Decisions — lane assist

- **`D-1020-AS1`…`D-1020-AS7`** are adopted as the brief states them (#1020);
  `crates/assist/README.md` is their current-state map. Three refinements:
- **`D-1020-AS8` — the ledger band needed no migration** (#1020). Options: (a)
  write `contracts/migrations/002_ledger.sql` as the brief anticipated; (b)
  discover that the band is already on **rung one** of
  `contracts/migrations/001_baseline.sql` — it is, because the baseline was
  exported from a founded v0 vault and v0 founds the ledger band with everything
  else — and hold the baseline to `ledger.ts`'s shape with assertions instead.
  **(b) adopted.** A second migration creating tables the baseline already has
  is either a no-op or a divergence, and the real risk is the opposite one: a
  future migration silently dropping a trigger or widening a CHECK. So
  `crates/vault/src/ledger/schema.rs` is names and closed vocabularies —
  14 tables, 2 indices, 8 triggers, 1 view, 1 FTS virtual table — and
  `crates/vault/tests/ledger.rs::every_object_the_band_needs_is_on_rung_one`
  fails if any of them leaves.
- **`D-1020-AS9` — the ACP session fixtures are a live fake `Agent`, not
  recorded `.jsonl`** (#1020). Options: (a) record
  `contracts/assist/acp-sessions/*.jsonl` from v0 with a fake agent and replay
  the frames in Rust, as the brief specifies; (b) ship `fake-acp-harness`, a
  real ACP `Agent` binary with four modes (`echo`, `tool`, `thinking`,
  `refuse`), and run the client half against it over a real pipe. **(b)
  adopted.** A replayed frame log tests the mapper and *asserts the framing it
  was recorded with*; it cannot fail when `initialize` stops negotiating, when
  notifications arrive out of order, or when the crate's framing changes under a
  version bump — and those are the failures that break a turn. The same binary
  is then what the #842 corpus and the `tools/call` transcript run against, so
  one fake serves three suites instead of three fixtures serving one. The cost
  is named: **no recorded v0 wire bytes are committed**, so a divergence between
  v0's frames and `agent-client-protocol` 2.1's would not be caught here. That
  is a close-pass item, and the mitigation today is that the crate is the
  protocol's own reference implementation rather than a hand-rolled codec.
- **`D-1020-AS10` — `preflight` probes the harness CLI** (#1020). Not an open
  question so much as a bug with two candidate fixes: (a) keep the `LaunchPlan`
  signature and special-case the two adapter kinds inside `run`; (b) change
  `VersionProbe::version` to take the CLI path and the environment explicitly.
  **(b) adopted**, because (a) puts a `match kind` outside `registry.rs` —
  exactly what D-1020-AS1 forbids — while (b) makes the type carry the
  distinction `docs/harnesses.md:69`–`:71` states, so a future probe
  implementation cannot get it wrong by accident.

### A citation is not a justification — the seams re-judged

- **`SUPPORTED_HARNESS_KINDS` is 5 of 17.** Kept, and it is a real product
  decision rather than an oversight: twelve registered kinds launch and are not
  claimed as supported. Collapsing the lists would mean either dropping twelve
  working kinds or claiming support nobody verified. **Question for the owner:**
  should the twelve be surfaced in Settings → Agents behind an "unverified"
  label, hidden, or promoted after one probe each? Recommendation: surface them
  labelled, because a member who has `goose` installed and cannot select it will
  conclude the product does not support it.
- **`turns.idempotency_key` is indexed, not UNIQUE**, and `items.effort` NULL
  means "not confirmed, never infer". Both kept, both re-derived from what reads
  them rather than from v0's ruling: a UNIQUE key would refuse a legitimate
  retry after a partial write, and an inferred effort is a number in the cost
  column that no harness reported.
- **`turns.parent_turn_id` carries no foreign key.** Kept. A sub-run's parent can
  be recorded after the child inside one batch, and a constraint would refuse
  the batch. The three edges that *do* cascade are asserted together with this
  one in `three_edges_cascade_and_the_parent_turn_link_deliberately_does_not`,
  so the asymmetry is a test rather than a comment.

### Owner hand-offs

1. **The park gate.** `CommandDefinition::confirm` is never read, so a
   confirm-gated command from a non-owner executes. Needs a third
   `CommandStatus::Parked`, written in `Vault::execute` after the authority gate
   and before the handler, the invocation row recorded as parked, and
   `crates/core::api::invoke` mapping it to a new wire value. `crates/api-proto`
   and `crates/core/src/api.rs` are another lane's files this slot. Pinned by
   `the_park_gate_is_still_missing`, which **fails the day park lands**.
2. **`vault_sql` over the seat socket.** The grammar, the row cap and the
   principal check are implemented in `crates/vault/src/ledger/sql_guard.rs`;
   the local channel deliberately carries only *named* reads and commands, so no
   message carries a free-form statement yet. That transport is lane F's
   successor's. Until it exists, `centraid mcp` answers `vault_sql` with the
   principal refusal above rather than opening the vault file itself — the
   tempting fallback, and the one that would make the child a second gateway.
   `the_child_refuses_to_start_without_its_capability_token` holds that shut.
3. **The `prompt-injection` gate step** — `contracts/handoff/assist/gate.patch`,
   also applied here in its own commit. `crates/xtask` is lane X3's this slot.
4. **One real ACP `initialize`** — the adapter install above.

### Demonstrated reds

Each one run on this tree, with the output it produced.

1. **The gate step refuses an empty corpus.** With
   `contracts/assist/prompt-injection/*.json` moved aside:
   ```
   the corpus is committed: Empty("…/contracts/assist/prompt-injection")
   test result: FAILED. 1 passed; 2 failed
   ```
   Zero payloads is an **error**, never "zero payloads, all passed" — the one
   failure mode a gate over a grow-only corpus has. The count in the gate line
   is read from the directory, not from the test, so the two cannot agree with
   each other while both being wrong.
2. **The deferred four cannot be silently promoted.** The triple edited from
   `(14, 10, 4)` to `(14, 14, 0)`:
   ```
   assertion `left == right` failed: the corpus is 14 payloads: 10 proven end to
   end, 4 deferred on the park gate. A change in these numbers is a change in
   what is proven and must be read, not re-baselined.
     left: (14, 10, 4)   right: (14, 14, 0)
   ```
3. **The preflight fix.** `an_adapter_kind_probes_the_harness_cli_and_never_the_node_that_hosts_it`
   fails on the pre-fix signature with
   `the probe must ask the harness CLI, not the node that hosts its adapter`;
   the real-binary form of the same red is the `v22.22.2` answer quoted above.
4. **The park gate** is pinned by an *inverted* red — the test asserts the gap,
   so closing the gap fails it. That is the only kind of red a hand-off can
   carry without either papering over the gap or leaving it unwatched.

### Findings outside the slice

1. **The shared `CARGO_TARGET_DIR` corrupts cross-lane builds through
   `crates/api-proto`'s build script. This is a correctness hazard, not a slow
   one.** `centraid-api-proto`'s `OUT_DIR` is keyed by package identity, which
   is identical in every lane's worktree, so the four lanes sharing
   `/home/user/cargo-target-2b` share one generated `centraid.core.v1.rs`. The
   **last lane to build wins**, and a downstream crate in another worktree then
   compiles against a proto that worktree does not contain. Observed three times
   in this lane with two different fields from a concurrent lane:
   `missing field 'sentence' in initializer of centraid_api_proto::core_v1::Error`
   (`crates/core/src/error.rs:112`) and `missing 'identity'`
   (`crates/protocol/src/version.rs:39`). Neither field exists in this
   worktree's `.proto` files; neither file is in this lane's ten commits.
   Touching this worktree's `.proto` files and `build.rs` immediately before a
   cargo invocation forces the regeneration and was enough to get
   `cargo test --workspace` to **926 passed**, but it is a race, not a fix: the
   third occurrence happened *inside one `gate --profile pr` run*, between the
   `clippy` step and the `test` step, which is why `test` is red above while the
   standalone run is green. **Every lane's `--workspace` verdict in this slot is
   conditional on no other lane building at that moment**, and the root should
   know that before trusting one. The fix is one target directory per worktree.
2. **The same hazard hits the gate runner itself, and it is worse, because it
   fails silently.** `cargo xtask` is `run --quiet --package xtask --`. The
   uplifted `debug/xtask` is whichever lane's build wrote it last, and a fresh
   build does not re-uplift — so this lane's first `gate --profile pr` ran **lane
   X3's xtask binary**: its step table contained a `fault-door` step that does
   not exist in this worktree's `crates/xtask/src/gate.rs`, and did **not**
   contain `prompt-injection`, which does. Nothing in the output said so; the
   gate reported a plausible pass/fail table for the wrong program. Detected by
   `strings $CARGO_TARGET_DIR/debug/xtask | grep -c prompt-injection` → `0`,
   fixed by `touch crates/xtask/src/gate.rs && cargo build -p xtask` (then `2`
   and `fault-door` → `0`), after which the step appeared and passed. **A gate
   verdict from a shared target directory is not evidence unless the binary is
   verified first.**
3. **Disk.** The box reached **0 bytes free** during this slot: four lanes, a
   21 GB shared target directory of which **6.2 GB was `debug/incremental`** —
   pure cache no lane's correctness depends on. Two `pr` steps
   (`call-budget`, `fault-door`) and the evidence file failed with
   `No space left on device` in the first run for that reason alone. Nothing was
   deleted from the shared tree, because removing files under another lane's
   running `rustc` is its own failure mode; `$CARGO_TARGET_DIR/release` was
   removed after the release build per the wave 3 rule, and this worktree's
   `node_modules` was installed only for the `bun` steps and removed again.
4. **A third inherited `secrets` red, and it is a false positive.**
   `contracts/golden/format-golden.json:23` trips `generic-api-key` on
   `"masterKeyHex": "fffefdfcfbfaf9f8…e3e2e1e0"` — a counting pattern, i.e. a
   deterministic golden-fixture key, landed by `c5de2b39` in wave 2. The wave 2
   brief names two inherited reds and this is a third, so a lane that trusted
   the brief's count would read it as its own. Per R-1020-35 a gate that reports
   a false positive is a bug in the gate, and `gate.rs:1100` already says the
   remedy is "a reasoned allowlist row in `.gitleaks.toml` naming the file" and
   that it is **the owner's**. **Recommendation:** add the row for this one file
   with the reason, rather than widening a rule — the fixture key must stay
   deterministic for the golden to be a golden.
5. **`ci-policy` is red on the umbrella head for three wave 3 trees.**
   `lint:path-filters` reports `copy`, `design` and `mobile` each "claimed by no
   `changes` filter and has no ledger entry", and its own message states the
   consequence: `skipped` counts as a PASS in `ci.yml`'s `check`, so a change
   under those paths **merges green, unexercised**. That is three of wave 3's
   deliverables currently outside CI. `.github/**` and
   `tests/path-filter-ledger.json` are lane G's and the estate's, and this lane
   adds no top-level tree, so it is filed rather than fixed. It should not wait
   for the close pass: it is a hole in the gate, not a cosmetic one.

### Doctrine digest

Law `53be88c22ab5`. `amendment-pairing`, `commit-message-format`,
`constitution-coverage`, `doc-integrity`, `doctrine-citation`,
`estate-separation`, `managed-tree-integrity`, `receipt-per-issue`,
`registry-completeness`, `waiver-docket` — all green at the window door, no
waiver spent, no gate, budget, ledger, test or allowlist weakened. No estate
file touched. `docs/harnesses.md` is accurate for this port and was **not**
edited: its two paragraphs at `:69`–`:71` are what `59941ff8` restores
compliance with, and the wave's doc pass is the umbrella's at close.

### Falsification

The two riskiest claims in this diff, the throwaway checks run against each, and
the result. **Both found something.**

**Claim 1 — "the #842 corpus is green because the gateway refuses, not because
the corpus is vacuous."** Four ways it could read green while proving nothing:
the injected content never reaching the model; the gateway refusing
*everything*; the deferred four counting as passes; an empty corpus passing.
Checks and results:

(a) The sentinel assertion was replaced with a **counter** over all fourteen
payloads, reading the marker file the *subprocess* writes: `14 FALSIFY HIT`,
`0 MISS`. So the injected content reaches the harness for every payload, not
just for the first one the assertion happens to reach. (This matters: the
assertion is inside the loop, so simply inverting it fails on payload one and
proves nothing about the other thirteen — the first attempt at this check did
exactly that and had to be redone as a count.)

(b) `the_one_allowed_payload_proves_the_corpus_is_not_passing_by_refusing_everything`
runs the single `allowed` payload and asserts `Applied::Allowed`, so a
refuse-everything gateway fails the suite.

(c) and (d) are demonstrated reds 2 and 1 above.

**And the audit-band question is where the real subtlety is.** `produced_rows`
asks the commit's **own `produced` list** — what the replica log captured —
rather than counting a named table, and filters the `audit` band off it. Both
halves are load-bearing and in opposite directions: a denied invocation
*correctly* writes its receipt, its invocation row and its explanation, so
requiring "no rows at all" would fail on the gateway working properly; and
checking `core_party` by name would pass while some other handler wrote
somewhere the test did not think to look. The band list is read from
`centraid_ontology::registries::v0_registries().audit_band`, so a table added to
the audit band cannot silently become a permitted write.

**Claim 2 — "`centraid mcp` binds nothing."** A source grep proves only that
this source has no `TcpListener`; the dependency graph pulls `iroh`, `quinn` and
`tokio`, any of which could bind on a path this verb reaches. Three checks:

(a) the `no-listening-socket` rule over 197 files, clean — the weak one, because
it is a scan of text;

(b) `the_running_child_holds_no_listening_socket` reads the serving child's own
`/proc/<pid>/fd` inodes and matches them against `LISTEN`-state rows in
`/proc/<pid>/net/tcp{,6}`. **A negative from a parser is worthless unless the
parser can find a positive**, so the same logic was run by hand against a
process that does listen — a Python socket bound to `127.0.0.1:36503` — and it
reported `LISTENING FOUND: 0100007F:8E97 (inode 2202690)`. `0x8E97` is 36503.
The method detects a real listener, so the empty answer for `centraid mcp` means
something;

(c) the child was launched with `CENTRAID_SEAT_SOCKET` and `CENTRAID_TURN_TOKEN`
**removed** and it refused to start rather than falling back to opening the
vault file directly.

That third check is the one that mattered, and it exists because the second has
a hole: a process that binds nothing but reads the vault file itself is not a
listener and is still exactly the architecture D-1020-AS2 rules out. "No socket"
was never the property worth proving on its own; "no second door" is.


## Wave 4 — lane Photos: the library as a projection, the `media` schema, and v0's own answers as the fixture

The largest app in the product ported: 8 queries and 18 actions in Rust over a
crate that holds no SQL, the whole `media` command schema plus the one
app-facing `enrich` command in `crates/vault`, the near-duplicate clustering and
the model lock in `crates/media`, and — the half that decides whether any of it
is true — **v0's own answers, generated from the v0 tree and compared value for
value, ids and page order included**. Doctrine digest stamp: law `53be88c22ab5`.

### What landed, by commit

**`685930c3` — the manifest, eight queries as statements-as-data, 18 actions.**
`crates/apps/photos/{Cargo.toml,manifest.json}` and
`src/{lib,manifest,queries,storage,faces,duplicates,enrichment,places,commands}.rs`.
v0's `app.json` is committed byte for byte and parsed by the kit's parser at
load time rather than transcribed, because two copies of "which tables does
Photos write" is how the two answers drift. 38 scopes over five schemas; the
declared bounds are `LIBRARY_MAX` 2,000, `SHELF_ROWS` 200, `MATCH_ROWS` 300,
`QUEUE_LIMIT` 60, `REGION_ROWS` 4,000, `PARTY_ROWS` 500, and every one reports
the size it reaches (D-1020-D3-12).

**`35ada4a1` — `crates/media::{phash,duplicates,models}`.** Hamming distance
over hex digests where unequal widths and non-hex characters are **not
comparable** (`None`, never `0`); union-find over Hamming ≤ 6 with the group's
lowest `asset_id` as the cluster id, compare-then-write; and
`models.lock.json`'s parser with one verify-then-fetch. Landed here because no
wave 4 lane owns `crates/media`, and `crates/media/README.md` says so and marks
the three constants that are format decisions.

**`c6a70063` — the `media` schema's twenty commands and the one app-facing
enrich.** `crates/vault/src/commands/media.rs` (2,227 lines), `enrich.rs` with
`enrich.request_enrichment` alone under a header saying the rest is slot 4b's,
and `tests/media_commands.rs` (21 tests). Nineteen real handlers plus
`media.add_asset` **registered and refusing**: moving bytes needs a blob door on
`CommandCtx`, which is an owner hand-off rather than a stub that writes a row
and calls it an asset.

**`bec6b049` — the harness, the demo seed and the year-3 axis.**
`crates/apps/kit/src/fixtures.rs` (+1,054 lines: `photos_demo`, `year3_photos`),
`crates/apps/photos/tests/{parity,year3}.rs`,
`contracts/apps/photos/{README.md,manifest.json,sample/**}`,
`contracts/apps/photos/recognition-placement.md`,
`contracts/tools/export-photos-parity.ts`.

**`7e171f6c` — a v0 wrong answer, fixed at source (R-1020-35).**
`packages/blueprints/apps/photos/queries/face-queue.ts`: the statement declared
`width`/`height` on its own `RawAsset` and mapped `asset.width ?? null` into
every queue entry, but never **selected** the columns — so a review card's
dimensions were structurally `null` in every vault that ever ran it. One line,
fixture-proven, in its own commit.

**`c24cc561` — v0's own answers as the parity bundle, and one bug in the port.**
`contracts/apps/photos/{rows,queries,commands,scenarios}.json` generated;
`tests/quality/photos-parity.contract.test.ts` as their emitter **and** their
oracle; `contracts/tools/{export-photos-parity.ts,photos-parity-bundle.ts,photos-parity-queries.ts}`;
`crates/apps/photos/src/representations.rs`; 813 lines of comparison in
`tests/parity.rs`; `crates/media/src/models.rs`'s `NoNetwork` test; both
READMEs; `Cargo.toml` reformatted by the repository formatter.

### The bundle, and why it compares ids and order

`rows.json` is the state `queries.json` was read from, and both are
canonicalised **in one pass over one vault** — so `id-0049` in an answer is the
row `id-0049` in the rows, and `parity.rs` builds its vault *from the rows* and
compares the ported answers including the page's order, not shapes and counts.
The numbers: **21 query cases over 8 queries** (6 library windows incl. one
keyset page, 4 search terms, 5 assets' faces, 2 storage phases, and one each of
face-queue, people, duplicates, enrichment-status), **32 command cases over 20
commands, 7 of them refusals**, **155 rows across 21 tables**, 3 ontology
scenarios (ONT-22/26/28), 19 sample frames.

Fixing the generator found **three bugs in the generator itself**, each of which
had made the bundle say less than it looked like it said:

1. **A negative lookbehind that spared nothing.** `/(?<!2099)\b(?:19|20)\d{2}-…/`
   was meant to keep the frozen epoch and tokenise the host clock; the
   lookbehind inspects the four characters *before* the match, which for
   `"2099-06-01T…"` are a quote and a colon. Every deterministic instant in the
   bundle was replaced — `captured_at` included — which silently deleted the
   ordering the library query is *about* and the capture time the face queue
   dates a proposal by. Replaced by a range on the parsed value.
2. **A per-slice id map.** Each of the four files was canonicalised on its own
   counter, so the same token named different things in different files and the
   comparison above could not have been written.
3. **A drift id that had moved.** The scenarios filter asked for `ONT-03`,
   which the scenario set has not carried since the ids were renumbered, and
   answered quietly with one scenario instead of two. It now throws, and the
   oracle has a floor on the three drifts.

Two things the generator now does that no command does, because two of the eight
queries read only what they write: it runs v0's own `recomputeDuplicateClusters`
and `refreshCustodyRollup` before the compared read. Without the first,
`duplicates` answers `{clusters: []}` for every corpus — and the fixture would
have agreed with a port that does nothing.

**The one case that is not the swept state** is `storage` at `phase: "unswept"`:
`computedAt: null` with every bucket zero, read before the sweeps. The pair is
the whole of D-1020-P1 — two answers that differ in `computedAt` alone, which is
the difference between "nothing to free" and "not counted yet" — and
`the_storage_summary_is_what_v0_answered_swept_and_unswept` compares both.

### The bug the fixture found in the port

`media_type` came back `None` for every asset while v0 answered `image/png`.
The port had left the field empty with a comment calling the representation read
another lane's job. But what the bytes ARE is not a property of the bytes
(#996 R20(b), drift ONT-28): it is `core_content_representation`, keyed on the
**owner** — two assets sharing one sha read as two different things.
`crates/apps/photos/src/representations.rs` ports it: owner-keyed, bounded by
the caller's own content ids and walked to the end of that set, and a denial
renders as no type rather than as an error. v0's copy is in `_shared/` because
six apps call it; the Rust home for it is `crates/apps/kit`, which is another
lane's file this slot — **owner hand-off**: lift it when the second app needs
it, the fold and its statement are written to be moved, not copied.

### Exit list

| Command | Outcome |
| --- | --- |
| `cargo fmt --all --check` | clean |
| `cargo clippy -p centraid-apps-photos -p centraid-media -p centraid-vault --all-targets` | no warnings |
| `cargo test -p centraid-apps-photos` | **98 passed** (71 unit, 24 parity, 3 year-3; the 50k axis `#[ignore]`d as longer than the whole `local` budget) — re-run green in `cargo-target-photos` |
| `cargo test -p centraid-media` | 37 passed — re-run green in `cargo-target-photos` |
| `cargo test -p centraid-vault` | 241 passed — re-run green in `cargo-target-photos` |
| `cargo test --workspace` | **974 passed, 0 failed** in `/home/user/cargo-target-2b` at `c24cc561`'s tree. The root's later instruction retired that directory as corrupting (see finding 4), and the re-run in the lane's own `cargo-target-photos` reached **112 passed over 7 suites and then `No space left on device`** with 285 MB free and four lanes live. The three package suites below were all re-run green in the new directory; the workspace verdict is the older one, and it is named rather than implied |
| `cargo xtask gate --profile local` | **PASS** at `c24cc561`'s tree, in the retired shared directory: `fmt` ok, `clippy --workspace --all-targets -- -D warnings` ok, `test` ok (192.1s), `sql-confinement — 89 file(s) scanned, clean (92 in the allowed crates, 9 in the rule runner)`, `abi-five-symbols` clean, `no-listening-socket` clean, `4 rule(s) applied`, `5 ledger(s) hold against e9a7d81a`; TOTAL 221.2s, scored against the **cold** 3,200s ceiling rather than the warm 120s budget (finding 3). **Not re-run** in the new directory: the profile's `test` step is `cargo test --workspace`, which cannot finish on 285 MB |
| `node node_modules/vitest/vitest.mjs run --config vitest.quality.config.ts tests/quality/photos-parity.contract.test.ts` | PASS **without** `CENTRAID_WRITE_CONTRACTS` — the bundle was rebuilt from the live v0 handlers and asserted equal to what is committed, which is both the oracle and the idempotency proof |
| generator idempotency | two write runs, `md5sum -c` over all four files: OK |
| `node .governance/law/run.mjs --door window --brief-digest 53be88c22ab5` | 10 rules, no findings |
| `bash .governance/run.sh` | all 10 directives pass |
| `bun run format` / `format:check` | clean (it reflowed `Cargo.toml` and `recognition-placement.md`, which the lane's earlier commits left unformatted) |
| `bun run lint` | clean, after the generator was split at the 625-line ceiling into `photos-parity-{bundle,queries}.ts` |
| `bun run check:push:static` | see the report line |
| `cargo xtask gate --profile pr` | **not run** — the profile's `release-build` step needs several GB and the shared disk was at 2.6 GB free with three lanes live; filling it would have broken them. Named, not waived |

The three trap tests the brief names, by name:
`the_storage_summary_of_an_unswept_vault_is_not_counted_yet` and
`the_storage_summary_is_what_v0_answered_swept_and_unswept` (D-1020-P1);
`the_face_queue_counts_matches_and_dates_them_by_capture` and
`the_face_queue_is_what_v0_answered` (D-1020-P2);
`cluster_ids_do_not_depend_on_input_order` — a proptest over 63 permutations of
every input order (D-1020-P3). Plus
`a_host_with_no_network_is_reported_and_never_throws`: a `Fetch` whose every
`get` refuses, asserting `ensure` **returns** a `Provision::failed` and leaves
no file a later `verify` would trust.

### Year-3 numbers (`year3-50k-assets`, projected provenance, D-1020-D3-7)

Measured on `ci-linux-x64-4c` with `cargo test --release`-less debug+opt-level-2
(`[profile.dev.package."*"]`), single run, after the representation read landed:

| Read | Time |
| --- | --- |
| seed 50,000 assets through the fixture generator | 34,883 ms |
| `library` at the 500 default window | **48 ms** |
| `library` asked for 2,000, one page served | 42 ms |
| `library`, ten cursored pages | 458 ms |
| `face-queue` over the 4,000-region window | **40 ms** |
| `duplicates` over 4,000 clustered fingerprints | 16 ms |

Projected, not a ceiling: the numbers come from one machine under three
concurrent lanes, and `tests/journeys.json` rows are the root's to write. What
they establish is that the year-3 library is **not** where the cost is — the
pairwise clustering v0 avoids with multi-index banding is 16 ms at 4,000
fingerprints here, which is why the banding is named as unported rather than
ported without a rig that could check it.

### Findings outside the slice

1. **`media.forget_person` deletes other people's confirmed faces.** The SQL is
   `WHERE party_id = :party_id OR confirmed_by_party_id = :party_id` — both
   party columns, documented as deliberate (#724 W5) — and in a single-member
   vault the owner is the `confirmed_by_party_id` of *every* confirmation. So
   "forget me" erases every confirmed face of everyone. The port reproduces it
   and the fixture pins it (`regions_forgotten: 2` before the script was
   reordered). **Re-judged, not deferred to the citation** (AGENTS.md): the
   privacy argument for deleting a party's own regions is sound; deleting the
   regions they *judged* is data loss about third parties, and no consumer in
   this tree depends on it. **Question for the owner**, with options: (a) keep
   both columns; (b) delete on `party_id` only and *null* `confirmed_by_party_id`
   where it matches, which keeps the erasure of the member's judgement without
   erasing the other person's face; (c) split into two commands.
   **Recommendation: (b).**
2. **`media.forget_person` executes with no confirmation.** It carries
   `confirm: true`, which parks a **non-owner** invocation; an owner
   credential — the only one a single-seat vault has — walks straight through,
   which is why the generator's "expected refusal" executed. That is the two
   gates working as designed (census A0), and the manifest's `confirmation` is
   the one that would ask. Named because the generator's comment assumed
   otherwise, and because the surface, not the command, is the only thing
   standing between a member and an irreversible face purge.
3. **The gate's warm/cold detector ignores `CARGO_TARGET_DIR`.**
   `crates/xtask/src/gate.rs:259` reads `root.join("target/debug/deps")`, while
   `smoke.rs:436` honours the variable — so every lane working under the shared
   target dir the briefs mandate is scored **cold** and the `local` 120s budget
   is never the number scored. A gate that reports a false state is a bug in the
   gate (R-1020-35). `crates/xtask` is lane X3's file this slot, so this is an
   owner hand-off: read `CARGO_TARGET_DIR` in `tree_state` exactly as
   `release_binary` does. Symlinking the worktree's `target` at the shared dir
   did **not** make it warm, so the fix is the variable and not the path.
4. **A shared `CARGO_TARGET_DIR` across worktrees produces false reds, and the
   mechanism is a build script.** Three times a workspace build failed to
   compile a crate this lane never touched — `centraid-apps-photos` against a
   `centraid-apps-kit` with no `fixtures` symbols, `centraid-protocol` with six
   errors, then `centraid-core` with `missing field 'sentence' in initializer of
   centraid_api_proto::core_v1::Error` — and each one compiled and passed on a
   per-package rerun seconds later. The root identified it mid-lane:
   `crates/api-proto`'s build script writes to an `OUT_DIR` keyed by package
   identity, which is **identical across worktrees**, so the last lane to build
   wins and the next lane compiles against another lane's generated protos.
   Two workarounds were used and both belong in `docs/dev-environment.md` if
   the multi-lane pattern continues: `touch crates/apps/kit/src/*.rs` before a
   workspace run (forces this lane's sources to be the fresh ones), and
   `touch crates/api-proto/build.rs` after switching directories (forces the
   protos to be regenerated from this worktree). A per-lane `CARGO_TARGET_DIR`
   fixes it properly and is what the root moved every lane to; the cost is
   disk, and the disk ran out (285 MB free with four lanes live), which is why
   the workspace and gate verdicts above are the older directory's.

5. **`contracts/apps/photos/sample/` has no trashed-asset case.** The scripted
   command set purges the one asset it trashes, so the `trash` shelf in every
   library case is empty and the shelf's `purge_in_days` arithmetic is proved
   only by the Rust-seeded half of `parity.rs`. One extra `media.delete_asset`
   without its purge would close it; noted rather than done because it moves
   every id in the bundle.

### Decisions — lane Photos

- **D-1020-P1 … P8** were adopted as briefed and are recorded against their
  tests in `crates/apps/photos/README.md`; each cites
  [#1020](https://github.com/srikanth235/centraid/issues/1020). What follows is
  what this lane had to decide that the brief did not.
- **D-1020-P9 — the bundle is ONE canonicalisation pass over ONE vault, and the
  host clock is one flat parenthesised token.** Options: (i) a token per file,
  which is what the generator did and which makes cross-file comparison
  impossible; (ii) one pass, with host instants numbered chronologically so
  ordering survives; (iii) one pass, one flat token. **(ii) was built first and
  rejected as not idempotent**: two rows share a millisecond in one run and not
  the next, the distinct count moves, and every later number shifts. **Adopted
  (iii)**, with the token parenthesised because `(` sorts below every digit
  under BINARY collation and the host clock is below the 2099 epoch — so an
  undated asset still rides the end of a newest-first page, where the real
  instant put it. An angle-bracketed token sorts *above* the digits and moved
  those assets to the front of every page. Cost: no ordering *among* host
  instants, which the reading statement breaks on a UUIDv7 primary key —
  and `the_library_pages_are_what_v0_answered_order_included` proves that
  tie-break is v0's order rather than assuming it. Cites #1020.
- **D-1020-P10 — the keyset case's cursor is the newest dated asset's
  `taken_at`, not the page's own `tail`.** `tail` is `captured_at ?? created_at`
  of the last live row, and three of the seed's assets carry no `captured_at`,
  so the tail is a host instant and feeding it back would make the case's
  *input* unreproducible. Options: (i) drop the page-boundary case; (ii) give
  the undated assets a capture time, distorting v0's own corpus; (iii) cursor at
  a dated instant mid-roll. **Adopted (iii)** — a real keyset read at a real
  boundary, at an instant the fixture owns. Cites #1020.
- **D-1020-P12 — `representations` lands in `crates/apps/photos`, not in the
  kit.** Options: (i) a `contracts/handoff/photos/kit.patch` for
  `crates/apps/kit`, which no test in this lane could then run against; (ii) the
  module in the app crate with the lift named as a hand-off. **Adopted (ii)**:
  the kit is another lane's file this slot, and a fixture-proven module in the
  app is worth more than a patch nobody has applied. Cites #1020.
- **D-1020-P13 — the generator is split at the line ceiling rather than the
  ceiling raised.** `oxlint`'s `max-lines` (625) refused the 844-line generator.
  Options: (i) an inline disable; (ii) raise the rule; (iii) split. **Adopted
  (iii)** — `photos-parity-bundle.ts` is what a case and a row set ARE plus the
  canonicalisation, `photos-parity-queries.ts` is which handler at which input,
  and `export-photos-parity.ts` is the run. Never weaken policy to go green.
  Cites #1020.

### The recognition-placement proposal, in one paragraph

`contracts/apps/photos/recognition-placement.md` designs open question 9's third
execution site and builds none of it. The recommendation, end to end: make
**`device` mean "on the device that holds the asset"** with a new fourth tier
name rather than re-meaning a stored consent (§1); stamp *where* a model ran on
`enrich_derivation` as a nullable `device_id` with `ON DELETE SET NULL`, because
a forgotten device must not take its derivations with it (§2); treat an offline
device as **parked, not failed** — no `enrich_target_failure` row, no count, no
backoff — while keeping a per-site cursor so a phone in a drawer cannot stop the
gateway's OCR (§3, §4); expose the ask to the shell as `EnrichAsk` events plus
one `enrich.submit_derivation` command, so `crates/core` owns the queue and the
shell owns only Vision/ML Kit (§5); and keep the `ort` gateway fallback behind a
**per-capability** rate budget with weights fetched on first use through the
`models.lock.json` verify-then-fetch this lane did build (§6). The root
integrates it across the automations lane; nothing in it is a lane's to land
alone, which is §7.

### Falsification

**Claim 1 — "the parity bundle is v0's answers, not the port's beliefs."** The
throwaway check: the oracle was run **without** `CENTRAID_WRITE_CONTRACTS`,
which rebuilds the whole bundle from the live v0 handler graph and asserts
equality with what is committed — it passed, and it is the same command CI would
run. Then the inverse: `media_type` was stripped from every asset in the
committed `queries.json` by hand and the same run **failed** —
`AssertionError: queries.json is stale — regenerate it` — which is the check
that a hand-edited fixture cannot survive. The file was restored by
regeneration, not by editing, and `bun run format && git diff --exit-code
contracts/apps/photos` then came back clean: the committed bytes are the
generator's output **after** oxfmt, which is why the oracle compares parsed
values and the repository's formatter owns the whitespace.

**Claim 2 — "the comparison would catch a wrong port."** Three deliberate breaks
were run against the Rust side and all three were reverted:

(a) `live_statement`'s `PageOrder::desc` flipped to `asc` →
`the_library_pages_are_what_v0_answered_order_included` **failed**, and *where*
it failed is the interesting part: the fifteen dated assets kept their order
(the fold sorts them, as v0's does) and the **two undated ones swapped** —
`…"id-0031", "id-0025", "id-0029"]` against v0's `…"id-0031", "id-0029",
"id-0025"]`. That is the tie-break D-1020-P9 rests on, proved rather than
assumed.

(b) The two confidences conflated — `AssetFace::detector_confidence` fed the
queue's count instead of the detector's score →
`one_photographs_faces_are_what_v0_answered` failed with
`the detector score on id-0049: left Some(0.0), right Some(0.94)`. (The
*intended* break, an invented proposal time, could **not** be demonstrated
against this bundle: every queue entry in the corpus sits on a photograph that
has a capture time, so `first_seen_at`'s `None` branch is covered by the
Rust-seeded unit tests and by nothing in the fixture. Named as a gap rather
than claimed as a check.)

(c) The cluster id changed from the group's lowest `asset_id` to its highest →
**five** tests failed, and *not* the app's parity test: the four in
`crates/media::duplicates` plus
`the_pre_stamped_cluster_ids_are_the_ones_the_sweep_would_compute`
(`asset-000001 carries a cluster id the sweep would not stamp: left
Some("asset-000002")`). The app's `duplicates` comparison passed throughout,
because the app only READS the stamped column — which is D-1020-P3 working, and
is why the clustering needs its own tests rather than the query's.
