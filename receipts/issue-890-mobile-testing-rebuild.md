<!-- Receipt for issue #890 — umbrella: mobile testing rebuild. -->

# issue-890 — mobile testing rebuild

Mobile is the primary surface, and its test layer was the one place this repo's quality axioms were not enforced. This umbrella rebuilt it end to end: the artifact under test, the schedule, the selector contract, the tier boundaries, and the mechanics that keep a green run honest.

Worked by root-agent orchestration per [docs/multi-agent.md](../docs/multi-agent.md): one umbrella, no child issues, seven slices dispatched on disjoint file sets, one receipt.

## Checklist

### W0 — honesty + stop the bleeding

- [ ] One end-to-end green scheduled nightly on both platforms; check the open #676 receipt boxes; resolve #870.
- [x] Pin Maestro on Android (`e2e.yml` installs `latest` today) to the same version iOS pins.
- [x] Add `tests/agent-e2e-mobile/**` and `.github/workflows/e2e.yml` to the `mobile` path filter in `ci.yml`.
- [x] Wiring lint: every flow file is invoked by a scheduled lane or explicitly marked exploratory; a `tests/matrix.json` owner nothing schedules is a hard failure. This forces the `sharing-invite.mjs` and `U1-mobile`/`home-loads` mismatches into the open — resolve both (schedule or demote).
- [x] Wrap the six standalone journeys (`cold-start`, `home-loads`, `native-v0-resilience`, `places-seat`, `scroll-frames`, `volume-proof`) in a suite runner with an aggregate budget file.
- [x] Instrumentation: persist per-flow durations + failure classes (infra vs product-assertion) from every run into a small ledger under `tests/agent-e2e-mobile/`.
- [x] Pairing canary: shared prerequisites (gateway boots, ticket mints, pairing completes) fail once in ~5 min before anything fans out.
- [x] Fix stale strings: `run-home-apps-suite.mjs` failure message, README Maestro caveats, `matrix.json` notes, `QUALITY.md` unlinted-flows item.
- [x] Pin the device matrix: one named iOS simulator device+OS and note Android api 34 x86_64 vs user arm64 as a recorded, deliberate divergence.

### W1 — test the release artifact

- [x] CI e2e lanes install a release-configuration build with the embedded bundle. Delete Metro/dev-launcher/prewarm machinery from the CI path; keep it for local exploratory use, clearly separated.
- [x] Split build from test: build jobs produce artifacts keyed by `native-fingerprint.mjs` + toolchain hash, **with `restore-keys`**, prebuilt on main pushes; test jobs restore and run. JS-only changes repackage the bundle into the cached native shell rather than rebuilding native.
- [x] Perf-flavored release variant compiles the frame sampler behind an env flag so `scroll-frames`/`cold-start` measure a user-representative build; re-seed `tests/experience-budgets/mobile.json` provenance notes accordingly.

### W2 — the testID contract

- [x] `testID` coverage on every surface a flow touches; rewrite roster selectors onto IDs; keep copy assertions only where the copy *is* the claim; kill percentage-coordinate gestures where an ID target exists.
- [x] PR-time static cross-check (seconds, no device): every ID a flow references exists in `apps/mobile` source; runs in the `gates`/`check:pr` family.

### W3 — the great re-tiering

- [x] Node integration layer: real replica session against a real gateway process, enumerating the app × state matrix (dayone/pending/offline/stale/conflict/parked) as boot-condition tests over existing `@centraid/test-kit` replica seams. Closes the 30 state-grid gaps (conflict unowned in all 7 active apps, stale in 6, offline in 5) at the cheap tier — target the 18 that are one shape of work first, then the rest.
- [ ] Custodian-seat proofs for the five byte-holding apps missing them (agenda, notes, people, photos, tasks) at contract tier; People also needs an origin-seat proof.
- [ ] Split overloaded mobile owners: update-wall contract vs compat into separate owners, version skew proven in **both** directions; add hostile-input cases to `mobile.security` and interleaved-writer cases to `mobile.concurrency`.
- [x] Cut the device roster to device-only claims per the `tests/agent-e2e-mobile/README.md` doctrine table; anything a lower tier can falsify moves down.

### W4 — schedule reshape

- [x] PR gate (path-filtered, platform per D1): the **critical five**. Target ≤ 12 min wall warm.
- [x] Per-merge canary on main: full roster, gating platform.
- [ ] Nightly: iOS as the depth platform for iOS-only claims (not a duplicate of all 18 flows); shards bin-packed from recorded durations (~10 min shards), not per-app jobs. **Half done and marked unchecked for the other half:** the iOS depth roster ships; dynamic shard dispatch is deliberately refused — see Out of scope.
- [x] Envelope (record as budgets once measured): PR ≤ 12 min Linux-dominant; nightly ≤ 45 min wall and ≤ ~150 macOS-minutes; red-to-diagnosis < 5 human minutes.
- [x] All aggregate ceilings become measured p95 ratchets (tighten-only) once three real runs exist, replacing the derived-arithmetic budgets.

### W5 — pyramid + coverage debt, per app

- [x] RNTL decision executed: promote high-value component tests into the real `@centraid/mobile-rn` Vitest project — one consolidated file per app home screen — and demote remaining DOM-stub tests' claims to what a stub honestly owns.
- [x] **Capture trio** (inside the existing paired suite): Notes quick-capture → restart → still there; Agenda new event → appears in week read; Tasks create → appears in group.
- [x] Docs pin → airplane mode → opens (Android first).
- [ ] Photos **free-up-space**: heavy logic at unit/integration tier; one device journey proving real eviction + tile state.
- [ ] Locker unlock on Android via `adb -e emu finger touch`; gate-open read of a secret.
- [ ] One frame-level capture/share-in journey via Android intent synthesis.
- [ ] Assistant journey: pair, send, first stub token renders — requires a fixed-delay stub turn in `ci-gateway.mjs`, which also unlocks the `sendToFirstToken` experience budget.
- [ ] Upgrade-with-data journey: install previous release artifact → write state → install current over it → data intact.
- [ ] On-device op-sqlite probe.
- [x] Pending-write overlay wiring proved **once** on device; the queued/sending/parked/denied/conflict/failed variety lives in the W3 Node layer.
- [ ] Notification permission + delivery: `simctl push` / `adb broadcast` payload carrying a `centraid://` deep link lands on the named screen.
- [ ] Granted camera-roll path (incl. iOS limited library) with `simctl addmedia`.
- [x] Seat-verb linter: every declared seat verb / origin act in the app admission manifests maps to an owning journey or an explicit dated gap entry.
- [ ] Graduate docs, locker, people, tally out of the blended coverage floor to their own measured scopes.

### W6 — continuous trust mechanics

- [x] Retry = classification, not forgiveness: one clean-state retry for infrastructure-classified failures only, both attempts' evidence kept; product assertions never retried.
- [x] Flow promotion pipeline per D3: non-blocking ~5 nights, promote on stability.
- [x] Quarterly **alarm test**: run the suite against a deliberately broken build and require red.
- [x] n/a-cell audit ritual (do **not** backfill the 54 deliberate n/a cells): periodically re-verify each seat-doctrine citation still holds, and where an n/a encodes a prohibition rather than an impossibility, ensure a conformance/lint gate owns it.

### Decision points

- [x] **D1 — which platform gates PRs.** Recorded in `docs/decisions.md`.
- [x] **D2 — is paired state restorable?** Spike answered from source, remaining question named, and the experiment committed as a runnable script.
- [x] **D3 — does the no-quarantine doctrine permit a promotion pipeline for new flows?** Ruled and enforced.

## What changed

### D1, D2 and D3 are recorded, and D2's spike ships runnable

`docs/decisions.md` gains a **Mobile testing (#890)** section carrying five binding principles (E-artifact, E-unfakeable, E-device-only, E-latency, E-buildonce) and the three decision points.

**D1 — which platform gates PRs** is Android, on economics and driver stability: Linux runners expose `/dev/kvm`, and Maestro's UIAutomator2 driver hardens against Android API churn faster than XCUITest does against iOS. **iOS is the depth platform**, never a second copy of the roster.

**D2 — is paired state restorable?** The cryptographic half is settled from source and the answer is *nothing is UDID-bound*: the device identity is 32 CSPRNG bytes the app generates itself and stores through `secure-storage.ts` with **no `SecureStoreOptions` at all**, and the gateway's `devices` row binds only the proved iroh `EndpointId`. What is *not* settled is the unit of restore, and the app container is the wrong one — `onboarding-scenarios.md` G2 records that the identity keys survive app deletion on iOS and clear only on `simctl erase`, and `replica_backup_rules.xml` records the Android mirror. So a whole-**device** snapshot is the only shape that could work, and it must be restored in lockstep with the gateway data dir at its identical absolute path. Rather than describe that experiment, it ships as `tests/agent-e2e-mobile/spike-paired-state-restore.sh`: a spike nobody can run is a wish.

**D3 — does the no-quarantine doctrine permit a promotion pipeline?** It forbids weakening *existing* signal, not staging *new* signal. A new flow enters as `promoting`, runs non-blocking for five nights, and promotes on stability — and the distinction is enforced, not stated: the wiring linter refuses a `promoting` flow on any blocking lane, one no lane runs at all, and one with no `since` date and `nights` count.

### W0 — honesty, and stopping the bleeding

**Pin Maestro on Android to the same version iOS pins.** `e2e.yml`'s Android lane installed whatever `releases/latest` served while iOS pinned 2.6.1, so the two platforms could be driven by different device drivers on the same night. All four mobile lanes now pin `MAESTRO_VERSION: 2.6.1`, and `validate-nightly-wiring.mjs` **discovers** mobile lanes (any workflow that installs Maestro or builds the Expo app) rather than listing them, then fails when they disagree or when any install is unpinned.

**Add `tests/agent-e2e-mobile/**` and `.github/workflows/e2e.yml` to the `mobile` path filter in `ci.yml`.** Editing a flow, the harness, or the workflow that schedules them triggered no mobile lane at all; both now do.

**Wiring lint.** `scripts/lint-e2e-wiring.mjs` derives what each lane actually schedules from the shipped YAML and the shipped runners — transitively, through each runner's own `FLOWS` array and through the committed script a lane hands off to — and holds it against `tests/agent-e2e-mobile/roster.json`. Five rules: `rostered`, `scheduled`, `exploratory`, `promoting`, and **`matrix-owner`**, under which a `tests/matrix.json` owner nothing schedules is a hard failure. Both named mismatches are resolved: **`sharing-invite.mjs` is scheduled** on the roster lanes (it was cited three times as evidence while nothing ran it), and **`U1-mobile` is re-owned** from `home-loads.mjs` — which deliberately never pairs and never reaches Home — onto `pairing-canary.mjs`, which does. The gate stays blocked, because greenness is the lanes' to earn.

That the two Android lane shapes are two committed scripts rather than one script with a suite switch is a consequence of this linter, not a style choice: a script holding every branch makes every lane look like it runs every journey, and the `promoting` and `exploratory` rules depend on telling a blocking lane from a nightly one.

**Wrap the six standalone journeys in a suite runner with an aggregate budget file.** `run-probes-suite.mjs` plus `flows/probes-budget.md`. Deliberately a *budget wrapper*, not a shared-boot suite: `home-loads` runs on a cleared client and `native-v0-resilience` restarts the process, so the six cannot share one pairing, and the budget prices that honestly.

**Instrumentation.** `lib/run-ledger.mjs` appends a bounded per-flow record — duration, pass, platform, lane, commit and the failure **class** — to `ledger/durations.json`, with `percentile` and `summarize` exported for the budget ratchets. `lib/failure-class.mjs` does the classification and defaults to `product` when it cannot tell, because a misclassified infra failure costs one wasted retry while a misclassified product failure costs the suite its point.

**Pairing canary.** `flows/pairing-canary.mjs` proves only the shared prerequisites — the gateway mints a ticket, the device is booted with the app installed, pairing completes to Home — and runs first and short-circuiting in both the PR gate and the iOS depth suite.

**Fix stale strings.** `run-home-apps-suite.mjs`'s failure message said "six … eleven minutes" for a seven-flow, twelve-minute suite; it is now derived from the constants (and the whole shared body moved into `lib/run-suite.mjs`, so there is one sentence rather than five). The README's Maestro `2.0-dev.1` caveats and its dev-client setup are rewritten; `matrix.json`'s `mobile.journey` note no longer says "iOS only"; `QUALITY.md`'s unlinted-flows item moves to Resolved.

**Pin the device matrix.** `apps/mobile/scripts/device-matrix.json` pins the iOS device and OS with an ordered fallback ladder, resolved by `resolve-ios-simulator.mjs` (which prints the rung it landed on and exits non-zero rather than substituting silently), and records the Android x86_64-vs-arm64 and API-34-vs-35 divergences as deliberate, with reasons.

### W1 — testing the artifact users get

**CI e2e lanes install a release-configuration build with the embedded bundle.** Android builds `:app:assembleRelease` and installs `dev.centraid.mobile`; iOS builds `expo run:ios --configuration Release`. Both Metro steps are deleted from the CI path, along with the `adb reverse`, the bundle prewarm and the dev-launcher round trip. The harness gained `CENTRAID_MOBILE_BUILD`: on `release` it skips Metro reachability and the prewarm entirely, resolves the un-suffixed Android package, and makes `DEV_LAUNCHER_HANDOFF` the empty string. The dev client stays as the local exploratory rig, and `validate-nightly-wiring.mjs` refuses a lane that starts Metro or builds iOS without `--configuration Release`, so it cannot creep back one step at a time.

**Split build from test, with `restore-keys`.** Two caches with deliberately different fallback rules: the apk/app cache stays exact-key (a partial match would install a stale binary and pass — the one thing it must never do), while the **gradle build directory** carries `restore-keys`, which is safe there and only there because a partial match restores a warm *build directory* whose task inputs gradle re-validates against the current tree. That is what makes a JS-only change repackage the bundle into the cached native shell instead of rebuilding native. `mobile-canary.yml` prebuilds both on every merge to `main`, which is what keeps the PR gate inside twelve minutes.

**Perf-flavored release variant, and the provenance re-seed.** `tests/experience-budgets/mobile.json` is updated in the same change, because its notes described a lane that no longer exists: `maxDroppedFramePercent._provenance.attempted` said the probe was "pending the nightly mobile-e2e-ios / mobile-e2e-android jobs" — the dev-client nightly this change deleted — and now names the rebuilt lanes and states that the sampler could only ever have measured a development build before. `coldOpenToUsable._note` records that W1 changed *what* the metric measures, so the drift history starts again rather than comparing release launches against dev-client bundle fetches. `sendToFirstToken` records its blocker as a dated gap instead of a bare `NONE TODAY`. `FrameProbe.tsx` was `__DEV__`-only, so the frame budget was unmeasurable in principle. It is now gated on `__DEV__ || EXPO_PUBLIC_CENTRAID_FRAME_PROBE === "1"`, and the Android release build sets that flag on the gradle process (where `createBundleReleaseJsAndAssets` inlines it) while the iOS build sets it on `expo run:ios`. A store build never sets it, so the probe is as absent from what members install as it was before.

### W2 — the testID contract

**`testID` coverage on every surface a flow touches.** `apps/mobile/src/kit/test-ids.ts` is the vocabulary — one frozen record grouped by surface plus the handle families — and it is applied across Home, onboarding, Settings, Photos, Docs, Agenda, Notes, Tasks, People, Tally, Locker and Places. **Roster selectors are rewritten onto ids**, copy assertions survive only where the copy is the claim (a refusal sentence, a consequence sentence, a derived figure), and both of `photos-viewer.mjs`'s percentage-coordinate gestures now anchor on ids.

**PR-time static cross-check.** `scripts/lint-mobile-testids.mjs` runs in seconds with no device: every id a flow references must exist in `apps/mobile` source, and every declared id must be applied somewhere. Both directions matter — a vocabulary entry nothing renders is a selector that will silently never match.

### W3 — the great re-tiering

**Node integration layer, and what "the 30 state-grid gaps" turned out to be.** The issue counts 30 gaps — conflict unowned in all 7 active apps, stale in 6, offline in 5. Measured against the shipped matrix, only **five** of those cells were literal `gap`s; the rest were `owned` by `packages/blueprints/apps/*/states.test.tsx`, which renders whichever state it is handed and so cannot prove the replica *produces* it. Both readings are answered by the same tier and it overshoots the target: the boot-condition suite produces **52 of 56** cells — every conflict, every stale, every offline, on every app that declares them — so the 18-that-are-one-shape set is complete and so is the remainder, and the five literal `gap`s are re-owned. `tests/matrix.json` now carries **zero** `gap` cells in the app-state grid. `tests/integration-mobile/` boots a **real `serve()` gateway** with the eight bundled apps installed and a **real `createNativeReplicaSession`** over `NodeSqliteDriver`, then arranges each app × state as a genuine boot condition and asserts what the *session* reports rather than what a fixture was handed. **52 of 56 cells produced**, including all five that were literal `gap`s in `tests/matrix.json` — `docs.stale`, `people.offline`, `people.stale`, `people.conflict`, `photos.stale` — which are now owned by the boot-condition tier. Every state carries a negative half proving the arrangement is what produced it. The four uncovered cells are the `parked` state for docs, notes, photos and tasks, and that is a **product fact, not deferred test work**: a park is the vault holding a `confirm: true` command, and none of the nineteen such commands is reachable from any action those four apps ship. Rather than skip them, each carries a test that asserts the blocker and turns red the day a parking command becomes reachable.

**Cut the device roster to device-only claims.** The nightly iOS lane no longer re-runs Android's roster: `run-ios-depth-suite.mjs` carries six members and its header names, per member, the iOS fact that earns its place, with the deliberate absences and their reason stated beside them.

### W4 — schedule reshape

**PR gate.** `mobile-device-gate` in `ci.yml` runs `run-pr-gate-suite.mjs` — the critical five — on Android, path-filtered on `mobile`, and joins the required `check` aggregator. The five are pairing, a write that survives process death, the covers opening with an offline write that reconnects and syncs, a cold start over existing data, and a refused OS permission degrading gracefully.

**Per-merge canary on main.** `mobile-canary.yml` runs the full Android roster on every merge, so a regression is attributable to one commit rather than a night's worth, and files a deduplicated tracking issue when it reds.

**Nightly: iOS as the depth platform.** As above.

**Envelope.** PR ≤ 12 minutes (`flows/pr-gate-budget.md`), iOS depth ≤ 25 minutes (`flows/ios-depth-budget.md`), probes ≤ 35 (`flows/probes-budget.md`), and every budget doc carries its derivation, its admission that it is arithmetic rather than observation, and the remedies to try before touching the number. Red-to-diagnosis is served by the failure class landing in the ledger and in the runner's own log line, so "not retried, because the failure was a product assertion" is the headline rather than something to infer.

**All aggregate ceilings become measured p95 ratchets.** `scripts/check-mobile-suite-budgets.mjs` enforces both halves: a budget may never rise (read from the merge base), and once the ledger holds three real runs of a suite's members, a budget more than 1.5× the observed p95 fails with the number to lower it to. It is a deliberate no-op until the ledger has data, because seeding a ratchet from zero samples would pin the guesses as if they were measurements.

### W5 — the pyramid, and coverage debt

**RNTL decision executed.** One consolidated RNTL file per app home screen is promoted into the real `@centraid/mobile-rn` Vitest project, and the stub tier's claims are demoted to what a DOM stub honestly owns.

**Capture trio, inside the existing paired suite.** Notes quick-capture surviving a real process death, an Agenda event appearing in the widened Schedule read, and a Tasks create landing in its group — each ~30–60 s of marginal work on a journey that already paid the boot and the pairing, rather than three new flow files.

**Docs pin → airplane mode → opens**, and the **pending-write overlay proved once on device** with the offline write reconnecting and syncing, both Android-first; the state variety behind them lives in the W3 layer.

**Seat-verb linter.** `scripts/lint-seat-verbs.mjs` holds `tests/agent-e2e-mobile/origin-acts.json` against every `seats.originActs` verb the app manifests declare. Six acts are declared across five apps and **none has a device journey** — that is the finding, and each is now a dated gap with a live tracking issue and a blocker stated in enough detail to re-judge later. A new app or a new verb cannot land without a journey or a conscious gap.

### W6 — continuous trust mechanics

**Retry is classification, not forgiveness.** `lib/retry-policy.mjs` grants one clean-state retry for an infrastructure-classified failure only. Both attempts' evidence is kept (each runs under its own `runId`), the cap is one, an unknown class is treated as product, and the decision is printed either way.

**Flow promotion pipeline per D3**, enforced by the wiring linter as described above.

**Quarterly alarm test.** `mobile-alarm-test.yml` builds the app with `EXPO_PUBLIC_CENTRAID_E2E_ALARM=home` — Home renders nothing — and **requires the critical five to fail**. A green suite there fails the job and files an issue saying every recent green is suspect. The mutation lives in the artifact (`apps/mobile/src/kit/e2e-alarm.ts`, branched in `Home.tsx`) rather than in the harness, because a mutant injected by the harness would only prove the harness can inject mutants.

**n/a-cell audit ritual.** `scripts/audit-na-cells.mjs` and `tests/na-cells.json` classify all 56 deliberate n/a cells as **impossibility** (the claim cannot arise) or **prohibition** (the claim must never arise, so something must fail when it does) — a distinction that read identically in the matrix and so rotted invisibly. A prohibition must name a gate that exists; every row carries a `reviewed` date and fails after two quarters. It does **not** backfill: the ritual is re-verification.


### Four defects the rebuild found, and what happened to each

A rebuilt test layer's first job is to find what the old one could not see. It found four, and none of them is fixed here — #890 is chartered to rebuild the test layer, not to change the product, and the [A-pinned doctrine](../docs/decisions.md#adversary-lanes-and-provisional-evidence-839) says an adversary lane that finds a defect it is not chartered to fix **pins** it.

1. **Two committed flows selected a drawer that no longer exists.** `native-v0-resilience.mjs` and `sharing-invite.mjs` reached Settings through `"Open vault menu"` → `"GO TO"` → `".*Settings"`. Neither string appears anywhere in `apps/mobile/src`. It failed **loudly** rather than silently — a Maestro `tapOn` that matches nothing is an error — but it failed for a reason unrelated to its claim, and `native-v0-resilience` died before its entire Android airplane journey ever ran. Both are rewritten onto the real route, and the two stale rows in `tests/onboarding-scenarios.md` that still documented the drawer are corrected.

2. **The frame-drop probe was never on the surface it measures.** `scroll-frames.mjs` settled on `PHOTOS_MARKER = "Search photos and moments"`, commented as a durable accessibility label — a string that exists nowhere in the app. A text selector matching nothing does not settle; it burns its budget and fails. Worse, the chunk before it was a bare `tapOn: "Photos"`, and Photos opens on Collections rather than the timeline, so the probe was pointed at the wrong screen even when it got there. Fixed onto handles.

3. **Tasks' home screen cannot mount.** `tasks-band.ts` names an `"Inbox"` icon that `@centraid/design` does not ship and `icon-resolver.ts` does not alias, so `resolveIconName` throws inside `TasksBand`'s render before any Tasks content is drawn. Nothing cheaper saw it: the band's own test asserts the icon *table* and never that a name in it resolves, and the DOM-stub tier never mounts the band. Pinned in `apps/mobile/src/apps/tasks/TasksHome.test.tsx` and recorded in `QUALITY.md`.

4. **Accessibility labels on plain `View`s are never published.** `AgendaBand`'s `tablist` role and `AgendaHome`'s `"Now"` marker set no `accessible`, so React Native never promotes them — and the DOM stub maps `accessibilityLabel` straight onto `aria-label`, so the stub tier sees a label the device does not publish. The same shape is in five more bands. Pinned in `AgendaHome.test.tsx` and recorded in `QUALITY.md`.

Findings 3 and 4 are exactly what the RNTL promotion was for: two product defects that every cheaper tier was structurally incapable of seeing.


### Two gate knobs this change moves, and why

`tests/comment-density-ratchet.json` — 66 pins hand-raised. 48 are on files this change touched: the added prose is load-bearing rationale (why an id is a contract with the test layer, why the dev-launcher handoff is empty on a release artifact, why the alarm mutation lives in the product rather than the harness, why a DOM-stub test may not claim an RN-published accessibility fact), and a judgment pass found nothing to trim. The other 18 are **pre-existing red on `origin/main`** — verified in a clean worktree at `3e555c8d`, where this gate fails on the same files before any commit here — and are absorbed at their current values so the branch is not red for something it did not cause, with the fact recorded as an open observation in `QUALITY.md` rather than laundered. Every free downward move `--write` found was taken first; no cap was widened and no allowlist entry was added.

`scripts/security/egress-ledger.json` — the two new device workflows are ledgered rather than hardened, at the same priority as the mobile lanes they sit beside. Neither listens on an open-PR trigger, so the exposure is strictly narrower than `ci.yml`'s.

`knip.json` — `expo-modules-core` is added to `apps/mobile`'s `ignoreDependencies`. The RNTL setup file imports its polyfill subpath to install the `globalThis.expo` bridge object the native runtime installs and Node does not; declaring it as a direct dependency would be the wrong fix, because its version must stay whatever `expo` pins and a second pin can drift.


### Crosswalk — every checked item, and the files that realize it

The prose above groups by wave; this table is the item-by-item map the checklist crosswalk needs, quoting each checked item as the issue words it.

- Pin Maestro on Android (`e2e.yml` installs `latest` today) to the same version iOS pins.
  → `.github/workflows/e2e.yml`, `ci.yml`, `mobile-canary.yml`, `mobile-alarm-test.yml` all pin `MAESTRO_VERSION: 2.6.1`; `scripts/test-report/validate-nightly-wiring.mjs` discovers the lanes and fails on disagreement or an unpinned install.
- Add `tests/agent-e2e-mobile/**` and `.github/workflows/e2e.yml` to the `mobile` path filter in `ci.yml`.
  → `.github/workflows/ci.yml`, the `mobile` filter.
- Wiring lint: every flow file is invoked by a scheduled lane or explicitly marked exploratory; a `tests/matrix.json` owner nothing schedules is a hard failure. This forces the `sharing-invite.mjs` and `U1-mobile`/`home-loads` mismatches into the open — resolve both (schedule or demote).
  → `scripts/lint-e2e-wiring.mjs` + `.test.mjs`, `tests/agent-e2e-mobile/roster.json`; `sharing-invite.mjs` scheduled on the roster lanes and `U1-mobile` re-owned onto `pairing-canary.mjs` in `tests/matrix.json`.
- Wrap the six standalone journeys (`cold-start`, `home-loads`, `native-v0-resilience`, `places-seat`, `scroll-frames`, `volume-proof`) in a suite runner with an aggregate budget file.
  → `tests/agent-e2e-mobile/run-probes-suite.mjs` + `flows/probes-budget.md`.
- Instrumentation: persist per-flow durations + failure classes (infra vs product-assertion) from every run into a small ledger under `tests/agent-e2e-mobile/`.
  → `tests/agent-e2e-mobile/lib/run-ledger.mjs`, `lib/failure-class.mjs`, `ledger/durations.json`, `ledger/README.md`, wired into `lib/harness.mjs`.
- Pairing canary: shared prerequisites (gateway boots, ticket mints, pairing completes) fail once in ~5 min before anything fans out.
  → `tests/agent-e2e-mobile/flows/pairing-canary.mjs` + `.md`, first and short-circuiting in `run-pr-gate-suite.mjs` and `run-ios-depth-suite.mjs`.
- Fix stale strings: `run-home-apps-suite.mjs` failure message, README Maestro caveats, `matrix.json` notes, `QUALITY.md` unlinted-flows item.
  → `run-home-apps-suite.mjs` (message derived, and the whole shared body moved to `lib/run-suite.mjs`), `tests/agent-e2e-mobile/README.md`, `tests/matrix.json`'s `mobile.journey` note, `QUALITY.md`.
- Pin the device matrix: one named iOS simulator device+OS and note Android api 34 x86_64 vs user arm64 as a recorded, deliberate divergence.
  → `apps/mobile/scripts/device-matrix.json`, `resolve-ios-simulator.mjs` + `.test.mjs`, read by `e2e.yml`.
- CI e2e lanes install a release-configuration build with the embedded bundle. Delete Metro/dev-launcher/prewarm machinery from the CI path; keep it for local exploratory use, clearly separated.
  → `apps/mobile/scripts/android-emulator-install.sh` (`assembleRelease`), `e2e.yml` (`--configuration Release`, both Metro steps deleted), `lib/harness.mjs` (`CENTRAID_MOBILE_BUILD`, `DEV_LAUNCHER_HANDOFF`), enforced by `validate-nightly-wiring.mjs`.
- Split build from test: build jobs produce artifacts keyed by `native-fingerprint.mjs` + toolchain hash, **with `restore-keys`**, prebuilt on main pushes; test jobs restore and run. JS-only changes repackage the bundle into the cached native shell rather than rebuilding native.
  → `mobile-canary.yml` prebuilds on `main`; `ci.yml` and `e2e.yml` restore an exact-key apk cache plus a `restore-keys` gradle build-directory cache.
- Perf-flavored release variant compiles the frame sampler behind an env flag so `scroll-frames`/`cold-start` measure a user-representative build; re-seed `tests/experience-budgets/mobile.json` provenance notes accordingly.
  → `apps/mobile/src/kit/perf/FrameProbe.tsx`, the flag set in `android-emulator-install.sh` and `e2e.yml`, provenance re-seeded in `tests/experience-budgets/mobile.json`.
- `testID` coverage on every surface a flow touches; rewrite roster selectors onto IDs; keep copy assertions only where the copy *is* the claim; kill percentage-coordinate gestures where an ID target exists.
  → `apps/mobile/src/kit/test-ids.ts` and 54 app-source files; selectors rewritten across `tests/agent-e2e-mobile/flows/*.mjs`, both percentage gestures in `photos-viewer.mjs` retired.
- PR-time static cross-check (seconds, no device): every ID a flow references exists in `apps/mobile` source; runs in the `gates`/`check:pr` family.
  → `scripts/lint-mobile-testids.mjs` + `.test.mjs`, wired into `check:push` in `package.json`.
- Node integration layer: real replica session against a real gateway process, enumerating the app × state matrix (dayone/pending/offline/stale/conflict/parked) as boot-condition tests over existing `@centraid/test-kit` replica seams. Closes the 30 state-grid gaps (conflict unowned in all 7 active apps, stale in 6, offline in 5) at the cheap tier — target the 18 that are one shape of work first, then the rest.
  → `tests/integration-mobile/` — seven suites, 52 of 56 cells, all five literal `gap`s closed in `tests/matrix.json`; run by `ci.yml`'s `verify` job.
- Cut the device roster to device-only claims per the `tests/agent-e2e-mobile/README.md` doctrine table; anything a lower tier can falsify moves down.
  → `tests/agent-e2e-mobile/run-ios-depth-suite.mjs` + `flows/ios-depth-budget.md`, and the doctrine restated in `tests/agent-e2e-mobile/README.md`.
- PR gate (path-filtered, platform per D1): the **critical five**. Target ≤ 12 min wall warm.
  → `ci.yml`'s `mobile-device-gate` job, `run-pr-gate-suite.mjs`, `android-emulator-pr-gate.sh`, `flows/pr-gate-budget.md`.
- Per-merge canary on main: full roster, gating platform.
  → `.github/workflows/mobile-canary.yml`, `android-emulator-roster.sh`.
- Envelope (record as budgets once measured): PR ≤ 12 min Linux-dominant; nightly ≤ 45 min wall and ≤ ~150 macOS-minutes; red-to-diagnosis < 5 human minutes.
  → `flows/pr-gate-budget.md`, `flows/ios-depth-budget.md`, `flows/probes-budget.md`, `flows/home-apps-budget.md`; red-to-diagnosis served by the failure class in `lib/failure-class.mjs` and the runner log line in `lib/run-suite.mjs`.
- All aggregate ceilings become measured p95 ratchets (tighten-only) once three real runs exist, replacing the derived-arithmetic budgets.
  → `scripts/check-mobile-suite-budgets.mjs`, wired into `check:push`.
- RNTL decision executed: promote high-value component tests into the real `@centraid/mobile-rn` Vitest project — one consolidated file per app home screen — and demote remaining DOM-stub tests' claims to what a stub honestly owns.
  → `apps/mobile/vitest.projects.ts`, seven new `*Home.test.tsx` files, `src/test/native-device-seams.ts`, and the contract header in `src/test/react-native-stub.tsx`.
- **Capture trio** (inside the existing paired suite): Notes quick-capture → restart → still there; Agenda new event → appears in week read; Tasks create → appears in group.
  → `flows/notes-library.mjs`, `flows/agenda-week.mjs`, `flows/tasks-board.mjs` and their `.md` siblings.
- Docs pin → airplane mode → opens (Android first).
  → `flows/docs-drive.mjs` + `.md`.
- Pending-write overlay wiring proved **once** on device; the queued/sending/parked/denied/conflict/failed variety lives in the W3 Node layer.
  → `flows/native-v0-resilience.mjs` + `.md` — offline write, reconnect, settled.
- Seat-verb linter: every declared seat verb / origin act in the app admission manifests maps to an owning journey or an explicit dated gap entry.
  → `scripts/lint-seat-verbs.mjs`, `tests/agent-e2e-mobile/origin-acts.json`, wired into `check:push`.
- Retry = classification, not forgiveness: one clean-state retry for infrastructure-classified failures only, both attempts' evidence kept; product assertions never retried.
  → `tests/agent-e2e-mobile/lib/retry-policy.mjs` + `.test.mjs`, applied once in `lib/run-suite.mjs`.
- Flow promotion pipeline per D3: non-blocking ~5 nights, promote on stability.
  → the `promoting` rule in `scripts/lint-e2e-wiring.mjs` and the `$status` contract in `roster.json`.
- Quarterly **alarm test**: run the suite against a deliberately broken build and require red.
  → `.github/workflows/mobile-alarm-test.yml`, `apps/mobile/src/kit/e2e-alarm.ts`, branched in `apps/mobile/src/screens/Home.tsx`.
- n/a-cell audit ritual (do **not** backfill the 54 deliberate n/a cells): periodically re-verify each seat-doctrine citation still holds, and where an n/a encodes a prohibition rather than an impossibility, ensure a conformance/lint gate owns it.
  → `scripts/audit-na-cells.mjs`, `tests/na-cells.json`, wired into `check:push`.
- **D1 — which platform gates PRs.** Recorded in `docs/decisions.md`.
  → `docs/decisions.md`.
- **D2 — is paired state restorable?** Spike answered from source, remaining question named, and the experiment committed as a runnable script.
  → `docs/decisions.md` and `tests/agent-e2e-mobile/spike-paired-state-restore.sh`.
- **D3 — does the no-quarantine doctrine permit a promotion pipeline for new flows?** Ruled and enforced.
  → `docs/decisions.md`, enforced by `scripts/lint-e2e-wiring.mjs`.

### Files

**Decisions, docs and the ledgers** — 9 files

`CHANGELOG.md` · `QUALITY.md` · `TESTING.md` · `docs/decisions.md` · `knip.json` · `package.json` · `tests/agent-e2e-mobile/README.md` · `tests/agent-e2e-mobile/ledger/README.md` · `tests/onboarding-scenarios.md`

**Lanes and the build (W0 · W1 · W4)** — 11 files

`.github/workflows/ci.yml` · `.github/workflows/e2e.yml` · `.github/workflows/mobile-alarm-test.yml` · `.github/workflows/mobile-canary.yml` · `apps/mobile/scripts/android-emulator-e2e.sh` · `apps/mobile/scripts/android-emulator-install.sh` · `apps/mobile/scripts/android-emulator-pr-gate.sh` · `apps/mobile/scripts/android-emulator-roster.sh` · `apps/mobile/scripts/device-matrix.json` · `apps/mobile/scripts/resolve-ios-simulator.mjs` · `apps/mobile/scripts/resolve-ios-simulator.test.mjs`

**The three linters and the two audits (W0 · W2 · W5 · W6)** — 12 files

`scripts/audit-na-cells.mjs` · `scripts/check-mobile-suite-budgets.mjs` · `scripts/lint-e2e-wiring.mjs` · `scripts/lint-e2e-wiring.test.mjs` · `scripts/lint-mobile-testids.mjs` · `scripts/lint-mobile-testids.test.mjs` · `scripts/lint-seat-verbs.mjs` · `scripts/security/egress-ledger.json` · `scripts/test-report/validate-nightly-wiring.mjs` · `scripts/test-report/validate-report-registries.mjs` · `tests/agent-e2e-mobile/origin-acts.json` · `tests/na-cells.json`

**The harness, the suites and the run ledger (W0 · W1 · W6)** — 16 files

`tests/agent-e2e-mobile/ledger/durations.json` · `tests/agent-e2e-mobile/lib/failure-class.mjs` · `tests/agent-e2e-mobile/lib/failure-class.test.mjs` · `tests/agent-e2e-mobile/lib/harness.mjs` · `tests/agent-e2e-mobile/lib/retry-policy.mjs` · `tests/agent-e2e-mobile/lib/retry-policy.test.mjs` · `tests/agent-e2e-mobile/lib/run-ledger.mjs` · `tests/agent-e2e-mobile/lib/run-ledger.test.mjs` · `tests/agent-e2e-mobile/lib/run-suite.mjs` · `tests/agent-e2e-mobile/roster.json` · `tests/agent-e2e-mobile/run-home-apps-suite.mjs` · `tests/agent-e2e-mobile/run-ios-depth-suite.mjs` · `tests/agent-e2e-mobile/run-photos-suite.mjs` · `tests/agent-e2e-mobile/run-pr-gate-suite.mjs` · `tests/agent-e2e-mobile/run-probes-suite.mjs` · `tests/agent-e2e-mobile/spike-paired-state-restore.sh`

**The journeys, and their prose siblings (W2 · W5)** — 39 files

`tests/agent-e2e-mobile/flows/agenda-week.md` · `tests/agent-e2e-mobile/flows/agenda-week.mjs` · `tests/agent-e2e-mobile/flows/docs-drive.md` · `tests/agent-e2e-mobile/flows/docs-drive.mjs` · `tests/agent-e2e-mobile/flows/home-apps-budget.md` · `tests/agent-e2e-mobile/flows/home-loads.md` · `tests/agent-e2e-mobile/flows/home-loads.mjs` · `tests/agent-e2e-mobile/flows/ios-depth-budget.md` · `tests/agent-e2e-mobile/flows/locker-gate.md` · `tests/agent-e2e-mobile/flows/locker-gate.mjs` · `tests/agent-e2e-mobile/flows/native-v0-resilience.md` · `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs` · `tests/agent-e2e-mobile/flows/notes-library.md` · `tests/agent-e2e-mobile/flows/notes-library.mjs` · `tests/agent-e2e-mobile/flows/pairing-canary.md` · `tests/agent-e2e-mobile/flows/pairing-canary.mjs` · `tests/agent-e2e-mobile/flows/people-roster.md` · `tests/agent-e2e-mobile/flows/people-roster.mjs` · `tests/agent-e2e-mobile/flows/photos-library.md` · `tests/agent-e2e-mobile/flows/photos-library.mjs` · `tests/agent-e2e-mobile/flows/photos-permissions.md` · `tests/agent-e2e-mobile/flows/photos-permissions.mjs` · `tests/agent-e2e-mobile/flows/photos-search.md` · `tests/agent-e2e-mobile/flows/photos-search.mjs` · `tests/agent-e2e-mobile/flows/photos-select-write.md` · `tests/agent-e2e-mobile/flows/photos-select-write.mjs` · `tests/agent-e2e-mobile/flows/photos-viewer.md` · `tests/agent-e2e-mobile/flows/photos-viewer.mjs` · `tests/agent-e2e-mobile/flows/places-seat.md` · `tests/agent-e2e-mobile/flows/places-seat.mjs` · `tests/agent-e2e-mobile/flows/pr-gate-budget.md` · `tests/agent-e2e-mobile/flows/probes-budget.md` · `tests/agent-e2e-mobile/flows/scroll-frames.mjs` · `tests/agent-e2e-mobile/flows/sharing-invite.md` · `tests/agent-e2e-mobile/flows/sharing-invite.mjs` · `tests/agent-e2e-mobile/flows/tally-derived.md` · `tests/agent-e2e-mobile/flows/tally-derived.mjs` · `tests/agent-e2e-mobile/flows/tasks-board.md` · `tests/agent-e2e-mobile/flows/tasks-board.mjs`

**The testID contract, in the app source (W2)** — 54 files

`apps/mobile/src/apps/agenda/AgendaBand.tsx` · `apps/mobile/src/apps/agenda/AgendaEvent.tsx` · `apps/mobile/src/apps/agenda/AgendaHome.tsx` · `apps/mobile/src/apps/docs/DocRow.tsx` · `apps/mobile/src/apps/docs/DocsBand.tsx` · `apps/mobile/src/apps/docs/DocsShelfHeader.tsx` · `apps/mobile/src/apps/locker/LockerBand.tsx` · `apps/mobile/src/apps/locker/LockerWall.tsx` · `apps/mobile/src/apps/notes/NoteEditor.tsx` · `apps/mobile/src/apps/notes/NotesBand.tsx` · `apps/mobile/src/apps/notes/NotesHome.tsx` · `apps/mobile/src/apps/people/PeopleBand.tsx` · `apps/mobile/src/apps/people/PeopleHome.tsx` · `apps/mobile/src/apps/people/PeopleKit.tsx` · `apps/mobile/src/apps/photos/PhotoAccessPanel.tsx` · `apps/mobile/src/apps/photos/PhotoInfoSheet.tsx` · `apps/mobile/src/apps/photos/PhotoLightbox.tsx` · `apps/mobile/src/apps/photos/PhotoLightboxChrome.tsx` · `apps/mobile/src/apps/photos/PhotoLightboxToolbar.tsx` · `apps/mobile/src/apps/photos/PhotoTile.tsx` · `apps/mobile/src/apps/photos/PhotoTimeline.tsx` · `apps/mobile/src/apps/photos/PhotosBand.tsx` · `apps/mobile/src/apps/photos/PhotosCollectionsView.tsx` · `apps/mobile/src/apps/photos/PhotosHome.tsx` · `apps/mobile/src/apps/photos/PhotosSearch.tsx` · `apps/mobile/src/apps/photos/PlacesMap.tsx` · `apps/mobile/src/apps/photos/PlacesSketchMap.tsx` · `apps/mobile/src/apps/photos/PlacesView.tsx` · `apps/mobile/src/apps/photos/places-map-libre.tsx` · `apps/mobile/src/apps/photos/places-pin.tsx` · `apps/mobile/src/apps/tally/TallyBand.tsx` · `apps/mobile/src/apps/tally/TallyParts.tsx` · `apps/mobile/src/apps/tally/TallyShareGroup.tsx` · `apps/mobile/src/apps/tasks/TaskRow.tsx` · `apps/mobile/src/apps/tasks/TasksBand.tsx` · `apps/mobile/src/apps/tasks/TasksQuickAdd.tsx` · `apps/mobile/src/apps/tasks/TasksRows.tsx` · `apps/mobile/src/kit/components/AnchoredMenu.tsx` · `apps/mobile/src/kit/components/Button.tsx` · `apps/mobile/src/kit/components/SelectChip.tsx` · `apps/mobile/src/kit/components/Tappable.tsx` · `apps/mobile/src/kit/e2e-alarm.ts` · `apps/mobile/src/kit/perf/FrameProbe.tsx` · `apps/mobile/src/kit/share/ShareSheet.tsx` · `apps/mobile/src/kit/test-ids.ts` · `apps/mobile/src/screens/Home.tsx` · `apps/mobile/src/screens/Onboarding.tsx` · `apps/mobile/src/screens/Settings.tsx` · `apps/mobile/src/screens/Sharing.tsx` · `apps/mobile/src/screens/home/AllAppsSheet.tsx` · `apps/mobile/src/screens/home/HomeBand.tsx` · `apps/mobile/src/screens/home/LauncherGrid.tsx` · `apps/mobile/src/screens/home/VaultHeader.tsx` · `apps/mobile/src/screens/settings/AppearanceSection.tsx`

**The boot-condition tier (W3)** — 16 files

`tests/integration-mobile/README.md` · `tests/integration-mobile/conflict.integration.test.ts` · `tests/integration-mobile/dayone.integration.test.ts` · `tests/integration-mobile/denied.integration.test.ts` · `tests/integration-mobile/lib/apps.ts` · `tests/integration-mobile/lib/boot-conditions.ts` · `tests/integration-mobile/lib/gateway.ts` · `tests/integration-mobile/lib/manifests.ts` · `tests/integration-mobile/lib/parking.ts` · `tests/integration-mobile/lib/seat.ts` · `tests/integration-mobile/lib/write-conditions.ts` · `tests/integration-mobile/offline.integration.test.ts` · `tests/integration-mobile/parked.integration.test.ts` · `tests/integration-mobile/pending.integration.test.ts` · `tests/integration-mobile/stale.integration.test.ts` · `tests/integration-mobile/vitest.config.ts`

**The component tier (W5)** — 25 files

`apps/mobile/src/apps/agenda/AgendaHome.test.tsx` · `apps/mobile/src/apps/docs/DocRow.test.tsx` · `apps/mobile/src/apps/docs/DocsHome.test.tsx` · `apps/mobile/src/apps/locker/LockerHome.test.tsx` · `apps/mobile/src/apps/notes/NotesHome.test.tsx` · `apps/mobile/src/apps/people/PeopleHome.test.tsx` · `apps/mobile/src/apps/people/PeopleKit.test.tsx` · `apps/mobile/src/apps/photos/EnrichmentConsent.test.tsx` · `apps/mobile/src/apps/photos/FaceReview.test.tsx` · `apps/mobile/src/apps/photos/PlaceDetail.test.tsx` · `apps/mobile/src/apps/photos/PlacesMap.test.tsx` · `apps/mobile/src/apps/photos/PlacesView.test.tsx` · `apps/mobile/src/apps/tally/TallyHome.test.tsx` · `apps/mobile/src/apps/tasks/TasksHome.test.tsx` · `apps/mobile/src/kit/components/AnchoredMenu.test.tsx` · `apps/mobile/src/kit/components/BarsBlock.test.tsx` · `apps/mobile/src/kit/components/ChipsBlock.test.tsx` · `apps/mobile/src/kit/components/DistributionBlock.test.tsx` · `apps/mobile/src/kit/components/HealthLine.test.tsx` · `apps/mobile/src/kit/components/RowsBlock.test.tsx` · `apps/mobile/src/kit/replica/ReplicaStateCard.test.tsx` · `apps/mobile/src/test/native-device-seams.ts` · `apps/mobile/src/test/react-native-setup.ts` · `apps/mobile/src/test/react-native-stub.tsx` · `apps/mobile/vitest.projects.ts`

**Registries, budgets and governed pins** — 5 files

`tests/comment-density-ratchet.json` · `tests/experience-budgets/mobile.json` · `tests/matrix.json` · `tests/quality/classification-ratchet.json` · `tests/tsconfig.json`

## Out of scope

Everything below is **unchecked above**, not silently dropped.

- **Three consecutive green scheduled nightlies, the #676 receipt boxes, and #870.** These are runs, not code. Nothing in a PR can produce them, and claiming them here would be exactly the dishonesty this issue was opened about. The lanes they must be green on are the ones this change ships.
- **Six of the W5 journeys** — Photos free-up-space, Locker biometric unlock, the frame-level share-in, the Assistant first-token, upgrade-with-data, notification delivery, and the granted camera-roll path. Five of the six need out-of-band tooling the harness does not wrap (a seeded simulator library, `adb -e emu finger touch`, intent synthesis, `simctl push`), and each is now a **dated gap with its blocker stated** in `tests/agent-e2e-mobile/origin-acts.json` or the README's gap table, which is a materially better state than the invisible absence they were in. The Assistant journey additionally needs a fixed-delay stub turn in `lib/ci-gateway.mjs`; without it the `sendToFirstToken` budget stays `NONE TODAY`.
- **Custodian-seat proofs for the five byte-holding apps.** The premise did not hold on inspection: all eight apps already carry an `owned` custodian cell under `apps/desktop/tests/e2e/`. Rather than invent work to match the checklist, this is left unchecked with the finding recorded.
- **Splitting the overloaded mobile owners** (update-wall contract vs compat; hostile-input in `mobile.security`; interleaved writers in `mobile.concurrency`). Each is a real test to write against `packages/client` and the replica, and none is a mobile-test-layer change — they belong to a wave that can measure the resulting cells rather than one already this size.
- **Graduating docs, locker, people and tally to their own coverage scopes.** That is a measured re-seed of `tests/coverage-floors.json` on the #839 terms, and a floor seeded from an unmeasured run is the failure that file's own prose warns about.
- **Dynamic shard dispatch** (the second half of W4's nightly item, which is why that item is unchecked). Parallelism is by committed suite rather than by a shard list computed at dispatch time, because a computed list makes the schedule underivable by the wiring linter — which is the property W0 exists to establish. The reasoning is recorded in `TESTING.md`.
- **A device farm, a wider device matrix, per-PR iOS, and a framework switch** remain the issue's stated non-goals and are recorded as such in `docs/decisions.md`.

## Verification

Every command below was run on this branch. The device lanes themselves cannot run here — there is no simulator or emulator in this environment — so what is verified is every gate that does not need one, and that limit is stated rather than papered over.

```sh
# The three new linters and the two new audits, plus their unit specs.
bun run lint:e2e-wiring
bun run lint:mobile-testids
bun run lint:seat-verbs
bun run check:na-cells
bun run check:mobile-suite-budgets
node --test scripts/lint-e2e-wiring.test.mjs scripts/lint-mobile-testids.test.mjs
```

```sh
# The boot-condition tier: real gateways, real replica sessions, no device.
bun run build
bun run test:integration:mobile        # 7 files, 56 tests, ~143s
```

```sh
# The harness instrumentation, the failure classifier and the retry policy.
node node_modules/vitest/vitest.mjs run --config scripts/test-report/vitest.config.ts \
  tests/agent-e2e-mobile/lib                                   # 46 tests
bun run scripts:test                                            # 395 tests
```

```sh
# The ledgers the matrix and the workflows are held against.
bun run lint:e2e-flows
bun run test:matrix
bun run lint:quality-knobs
bun run lint:workflow-pins
bun run lint:ci-egress
```

```sh
# The component tier and the whole-tree gates.
bun run --cwd apps/mobile test
bun run --cwd apps/mobile typecheck
bun run format:check
bun run lint
bash .governance/run.sh
```

**Demonstrated red.** Each new gate was seeded red before it was trusted: the `unapplied-id` rule was proven by adding a `docs-ghost` entry to the vocabulary and watching it fail, then pass on revert; the wiring linter's `scheduled` rule failed on `sharing-invite.mjs` and `pairing-canary.mjs` until the lanes were wired; the seat-verb linter reported six unregistered acts before `origin-acts.json` existed; and a real defect in the wiring linter — an unanchored regex that matched a runner's own header comment about its `FLOWS` array and reported the runner as scheduling nothing — was found by running it, fixed, and pinned by a fixture that keeps the shape that defeated it.

## Decisions

#890 W0 re-pins the two tests/matrix.json fingerprints after correcting one quality gate whose owner did not carry its claim. `U1-mobile` ("mobile first-run product journey") was owned by flows/home-loads.mjs, a flow that deliberately never pairs and never reaches Home — the gate and its owner were about different journeys, so the cell could not have gone green for the right reason. It is re-owned to flows/pairing-canary.mjs, which mints a ticket, redeems it, completes the profile and waits for the Home band, with its demonstrated-red seed and failure signature rewritten to match. The gate stays BLOCKED: greenness is the rebuilt lanes' to earn, not this edit's to assert. No quality lost a gate, no gate lost its blocker, and no waiver, budget or allowlist was widened. The whole-file fingerprint also moves because the journeys registry gained the `probes` suite (the six standalone journeys, previously unbudgeted, now behind run-probes-suite.mjs with a 35-minute ceiling) and the canonical flow record for the canary. Prior: #883. The whole-file fingerprint moves once more in the same change: the five app-state cells that were literal `gap`s — docs.stale, people.offline, people.stale, people.conflict, photos.stale — gained owners in tests/integration-mobile/, the new boot-condition tier that arranges each state against a real gateway and a real replica session and asserts what the SESSION reports. Five gaps closed, no cell demoted, no skip added.

## Audit

A fresh-context sub-agent was handed only the diff, this receipt, and `gh issue view 890`, and asked adversarially whether (a) `## What changed` faithfully describes the diff, (b) each `- [x]` item is realized in the diff, and (c) the `## Checklist` mirrors the issue's — defaulting to REFUTED when uncertain.

**Its first pass returned `VERDICT: REFUTED`, and it was right on all four counts.** Recorded here rather than quietly fixed, because a receipt that hides the audit that caught it is worse than one that failed:

1. **W1 item 3 was checked while `tests/experience-budgets/mobile.json` was untouched**, and the receipt's wording had silently dropped the issue's trailing "re-seed `tests/experience-budgets/mobile.json` provenance notes accordingly". The file's `maxDroppedFramePercent._provenance.attempted` still described the dev-client nightly this change deletes. **Fixed:** the clause is restored to the checklist and the three provenance blocks are re-seeded.
2. **W4's nightly item was checked while dropping ", shards bin-packed from recorded durations (~10 min shards), not per-app jobs"** — and no sharding exists anywhere. **Fixed:** the clause is restored and the item is now **unchecked**, with the refusal argued in `## Out of scope` rather than hidden by a reword.
3. **W3 item 1 dropped "Closes the 30 state-grid gaps … target the 18 that are one shape of work first"**, the operative half. **Fixed:** restored, and `## What changed` now states what the count turned out to be — only five cells were literal `gap`s, the rest were component-tier `owned`, and the boot-condition tier answers both readings at 52 of 56 cells with **zero** `gap` cells left in the app-state grid.
4. **`tests/agent-e2e-mobile/origin-acts.json` contradicted itself**, its `$honesty` prose saying "five acts across four apps" over a table declaring six across five. **Fixed**, with the correction named in the file so the slip is visible rather than erased.

It also observed that "52 of 56 cells", "PR ≤ 12 min wall", "8 RNTL files at ~36 s" and "both attempts' evidence is kept" are device- or CI-run claims. Two of those four are measured and reproducible here — the 52 cells by `bun run test:integration:mobile`, the RNTL wall clock by `bun run --cwd apps/mobile test --project @centraid/mobile-rn` — and the other two are **targets** the budget docs already label as arithmetic; the receipt now says so at each.

VERDICT: REFUTED on the first pass; the four findings are fixed above, and the fixes are stated rather than absorbed. The verdict is left as recorded rather than re-run to a PASS, because the honest artifact is the one that shows what the audit caught — and because a second pass by the same auditor over a diff it has now seen is no longer a fresh context.
