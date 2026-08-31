# PR device-gate budget

`run-pr-gate-suite.mjs` runs the **critical five** — `pairing-canary`, `notes-library`, `native-v0-resilience`, `cold-start`, `photos-permissions` — on the gating platform (Android, per D1 in [docs/decisions.md](../../../docs/decisions.md#mobile-testing-890)). The runner fails when aggregate wall time is **twelve minutes or more**, measured from the first flow process start through the fifth verdict.

`pairing-canary` runs first and **short-circuits**: it is the shared prerequisite of the four after it, and when pairing is broken those four each fail on their own unrelated-looking assertion after their own several minutes. Everywhere else in this layer a mid-run failure must not grey the later cells ([#535](https://github.com/srikanth235/centraid/issues/535) F4); here the later cells would be greyed by a prerequisite and would name the wrong cause.

## Where twelve minutes came from

**This is a derived ceiling, not an observed one.** Nothing in this suite has run on a device in this configuration — the release-artifact lane is new with [#890](https://github.com/srikanth235/centraid/issues/890) W1 — so there is no distribution to sit on top of, and the number is arithmetic over the two measured neighbours plus one deliberate subtraction.

| Component | Minutes | Where the number comes from |
| --- | --- | --- |
| Fresh pairing (`pairing-canary`) | 4 | `lib/harness.mjs` prices a fresh pairing at ~4 minutes on the reviewed CI runner: "Fresh pairing is the slowest legitimate chunk". |
| Four reusing journeys | 6 | `run-home-apps-suite.mjs` allows 12 minutes for one pairing plus seven reusing journeys, i.e. ~8 minutes for seven — ~1.15 each. Four of them is ~4.6; `native-v0-resilience` opens every cover and is materially heavier than a single-cover journey, so it is priced at two units rather than one, giving ~5.7. Rounded up. |
| Headroom | 2 | Was labelled "emulator and install", which this budget does not in fact contain: `android-emulator-install.sh` boots the AVD and runs `adb install -r` **before** `run-pr-gate-suite.mjs` is invoked, and the suite's clock starts at its own first process start. Corrected under [#892](https://github.com/srikanth235/centraid/issues/892) to what the two minutes actually are — slack over the ten minutes of journeys above. |

**What is deliberately NOT in this budget: the native build.** [#890](https://github.com/srikanth235/centraid/issues/890) W1 splits building from testing precisely so that this number is a _test_ cost. On a warm runner the gate restores a fingerprinted native shell prebuilt on `main` and, for a JS-only change, re-runs only the bundle and packaging tasks. On a cold cache the build job pays its own separate time and this suite still owes twelve minutes from its own first process start. A budget that silently absorbed a 20-minute cold build would be a budget that only ever fires on the runs where it should not.

**The dev-harness savings are real and already subtracted.** The old lane paid a 300-second Metro bundle prewarm, a cold-bundle first launch measured at ~43 seconds, a dev-launcher `openLink` round trip, and a developer-menu explainer sheet, on every flow. None of that exists on a release artifact with an embedded Hermes bundle, which is why five journeys fit inside a budget the seven-journey home-apps suite also spends.

## The budget is a deadline, not a verdict

Twelve minutes is a **bound**, enforced while the run is happening ([#892](https://github.com/srikanth235/centraid/issues/892) Phase 0). It used to be scored only after all five members had finished, which is how the gate came to report **17m38s against a twelve-minute budget**: nothing in `lib/run-suite.mjs` stopped at twelve, and two things could each overrun it unbounded.

| What overran it | Why it could | What bounds it now |
| --- | --- | --- |
| The classified retry | One infrastructure-classified failure re-runs a whole journey inside the wall clock the budget measures. Five members at budget plus one multi-minute retry is the observed number. | `fitsInBudget()` refuses a retry whose expected cost (the first attempt's own elapsed time) exceeds what remains. The flow stays red either way; what is refused is answering five minutes late. |
| One wedged Maestro chunk | `MAESTRO_CHUNK_TIMEOUT_MS` is twelve minutes — the entire suite budget — so a single chunk could spend it alone. | `run-suite.mjs` publishes the run's absolute deadline as `CENTRAID_MOBILE_DEADLINE_MS`; `maestroChunkTimeoutMs()` clamps every chunk to the smaller of the flat ceiling and the time left (never below 15s, or the kill would report a driver fault where the truth is "the budget was gone"). |
| A member started with no budget left | The loop ran all five unconditionally. | The runner refuses to start a member past the deadline and names the unrun ones. A greyed cell whose cause is stated beats a red one that spent five extra minutes earning the same verdict. |

The dev-client launch ceiling was the third contributor and is now build-typed: `FIRST_LAUNCH_TIMEOUT_MS` was 120s because `clearState` drops a **dev** build's cached bundle and Metro must re-serve it. A release artifact carries its own Hermes bundle, so on that path it is 45s — still ~4x a healthy cold launch under the emulator's software GPU. It only ever cost time on the way to a failure, and that is precisely where two minutes per doomed wait came from.

**None of this raises the number.** Twelve minutes was never the problem; nothing enforced it.

## What to do when it is breached

The moment the gate produces **three real runs**, re-derive this ceiling from the observed p95 in [`../ledger/durations.json`](../ledger/durations.json) and **tighten** it. A ceiling assembled out of three arithmetic estimates is not a budget; it is a placeholder that says so.

Until then, if two consecutive gate runs exceed twelve minutes:

1. Combine adjacent Maestro chunks and delete duplicate arrival assertions — each `ctx.run()` spawns `maestro test` once, and the per-spawn overhead is real.
2. Check the ledger's failure classes. A run that spent minutes retrying an infrastructure-classified failure is an infrastructure problem, not a budget problem.
3. Move a claim down a tier. If a member's claim can be falsified by the Node integration layer (`tests/integration-mobile/`), it does not belong on a device at all — that is the E-device-only ruling, and it is the correct first move, not the last resort.

**Do not raise the budget to buy time, and do not add retries.** The gate's whole value is that it answers before a human context-switches; a gate that takes half an hour is a nightly with extra steps. Do not weaken a structural assertion, and do not drop a member — the five are the smallest set whose failure means "do not merge this", so dropping one does not make the gate faster, it makes it a different gate.
