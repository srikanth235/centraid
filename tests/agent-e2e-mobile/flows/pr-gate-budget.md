# PR device-gate budget

The gate runs the rung-2 `pr-gate` suite — `pairing-canary`, `notes-library`, `cold-start` — on the gating platform (Android, per D1 in [docs/decisions.md](../../../docs/decisions.md#mobile-testing-890)), on ONE emulator. It fails when its aggregate wall time is **eight minutes or more**, measured from its first flow process start through its last verdict. It was the critical five as two parallel legs until [#915](https://github.com/srikanth235/centraid/issues/915) Wave 2 — see [One leg, from two](#one-leg-from-two-915-wave-2) for where the other two members went and why the number came DOWN rather than up.

`pairing-canary` runs first in **each leg** and **short-circuits**: it is the shared prerequisite of every other member, and when pairing is broken those members each fail on their own unrelated-looking assertion after their own several minutes. Everywhere else in this layer a mid-run failure must not grey the later cells ([#535](https://github.com/srikanth235/centraid/issues/535) F4); here the later cells would be greyed by a prerequisite and would name the wrong cause.

## Where twelve minutes came from

**This is a derived ceiling, not an observed one.** Nothing in this suite has run on a device in this configuration — the release-artifact lane is new with [#890](https://github.com/srikanth235/centraid/issues/890) W1 — so there is no distribution to sit on top of, and the number is arithmetic over the two measured neighbours plus one deliberate subtraction.

| Component | Minutes | Where the number comes from |
| --- | --- | --- |
| Fresh pairing (`pairing-canary`) | 4 | `lib/harness.mjs` prices a fresh pairing at ~4 minutes on the reviewed CI runner: "Fresh pairing is the slowest legitimate chunk". |
| Four reusing journeys | 6 | the `home-apps` suite allows 12 minutes for one pairing plus seven reusing journeys, i.e. ~8 minutes for seven — ~1.15 each. Four of them is ~4.6; `native-v0-resilience` carries a process restart and the airplane arc on top of its navigation, so it is priced at two units rather than one, giving ~5.7. Rounded up. Measured at ~9 minutes — see below. |
| Headroom (retired at 8 min) | 2 | Was labelled "emulator and install", which this budget does not in fact contain: `android-emulator-install.sh` boots the AVD and runs `adb install -r` **before** the `pr-gate` suite is invoked, and the suite's clock starts at its own first process start. Corrected under [#892](https://github.com/srikanth235/centraid/issues/892) to what the two minutes actually are — slack over the ten minutes of journeys above. |

**What is deliberately NOT in this budget: the native build.** [#890](https://github.com/srikanth235/centraid/issues/890) W1 splits building from testing precisely so that this number is a _test_ cost. On a warm runner the gate restores a fingerprinted native shell prebuilt on `main` and, for a JS-only change, re-runs only the bundle and packaging tasks. On a cold cache the build job pays its own separate time and this suite still owes twelve minutes from its own first process start. A budget that silently absorbed a 20-minute cold build would be a budget that only ever fires on the runs where it should not.

**The dev-harness savings are real and already subtracted.** The old lane paid a 300-second Metro bundle prewarm, a cold-bundle first launch measured at ~43 seconds, a dev-launcher `openLink` round trip, and a developer-menu explainer sheet, on every flow. None of that exists on a release artifact with an embedded Hermes bundle, which is why five journeys fit inside a budget the seven-journey home-apps suite also spends.

## What ten runs measured

Ten PR-gate runs on [#905](https://github.com/srikanth235/centraid/issues/905) all ended at **727–742s** against the 720s deadline, every one of them with a later member starved by the clamp rather than finished. Per-journey figures below are Android CI; run 33573882728 is the fullest single sample.

| Journey | Measured on CI (s) | Derived price (s) |
| --- | --- | --- |
| `pairing-canary` | 167–209 (192 typical) | 240 |
| `notes-library` | 112–154 (126 typical) | 72 |
| `native-v0-resilience` | 390+ without finishing; the ten-surface tour alone 187 | 144 |
| `cold-start` | 116–150 for its eight launches, when it had budget left | 72 |
| `photos-permissions` | 36–79 while failing on its own assertion, or never started when the four before it spent the budget | 72 |
|  | **≈950 to pass in the shape it had** | **600 + 120 headroom** |

The derivation was not wrong about pairing; it was wrong about the four behind it, pricing ~6 minutes of work that measures ~9. **The ceiling stays at twelve minutes and the suite is fitted to it instead.** Two things were cut: the ten-surface cover tour moved down a tier under remedy 3 (the covers-open claim is `apps/mobile/src/screens/Home.test.tsx`'s manifest-generated sweep plus the per-cover canary and nightly journeys), and six Maestro spawns — four reuse-mode gateway configures and two restarts, ~9–15s of JVM start each — now stage onto the next chunk instead of spawning `maestro test` of their own, under remedy 1.

## One leg, from two (#915 Wave 2)

The five ran as **two legs on two emulators in parallel** under [#905](https://github.com/srikanth235/centraid/issues/905), because in sequence they measured ≈795s against a 720s deadline and the fifth member was starved on every run. Measured on run 33582899886 (head `1485d8f4`, after the cover tour moved down a tier and six spawns folded): `pairing-canary` 187s, `notes-library` 106s, `native-v0-resilience` 267s, `cold-start` 145s, `photos-permissions` ~90s to pass.

[#915](https://github.com/srikanth235/centraid/issues/915) makes the smaller cut instead of buying a second emulator. **Rung 2 is `pairing-canary`, `notes-library`, `cold-start` on ONE emulator at eight minutes warm** — 187 + 106 + 145 ≈ 438s of the 480s ceiling, with `cold-start` reusing the paired profile rather than pairing again. The two members that left are not deleted and not loosened:

| Member | Where it went | Why |
| --- | --- | --- |
| `native-v0-resilience` | the `resilience` suite, rung 3 | Settings from the all-apps sheet, a process restart and an offline write that reconnects are a question about the **candidate**, not about the diff. Same three members as the retired leg, same twelve minutes, one rung later — and `check:mobile-suite-budgets` follows the rename through `supersedes` so the ceiling is still a ratchet. |
| `photos-permissions` | the `photos` suite (rung 4) and `ios-depth` (rung 4) | A refused OS media grant is per-platform and per-OS-version; it belongs where the Photos seat already is. It is also the one member that clears the client, which is why it had to be last in its leg. |

`pairing-canary` is still first and still **short-circuits**: it is the shared prerequisite, and on a broken one the members behind it each fail on their own unrelated-looking assertion after their own several minutes. `cold-start` is still last — its eight launches run over the profile the member before it leaves.

The members and the ceiling are rows in [`../roster.json`](../roster.json) now, not literals in a runner file: suite `pr-gate`, `budgetMs` 480000, run by `run-roster.mjs --rung 2 --platform android --suite pr-gate`.

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

The moment the gate produces **three real runs**, re-derive this ceiling from the observed p95 in [`../ledger/durations.json`](../ledger/durations.json) and **tighten** it. Every device lane uploads that ledger as the artifact `mobile-run-ledger-<lane>` on every run ([`../ledger/README.md`](../ledger/README.md)), so the sample is read off CI rather than off whatever a local run happened to commit. A ceiling assembled out of three arithmetic estimates is not a budget; it is a placeholder that says so.

Until then, if two consecutive gate runs exceed twelve minutes:

1. Combine adjacent Maestro chunks and delete duplicate arrival assertions — each `ctx.run()` spawns `maestro test` once, and the per-spawn overhead is real.
2. Check the ledger's failure classes. A run that spent minutes retrying an infrastructure-classified failure is an infrastructure problem, not a budget problem.
3. Move a claim down a tier. If a member's claim can be falsified by the Node integration layer (`tests/integration-mobile/`), it does not belong on a device at all — that is the E-device-only ruling, and it is the correct first move, not the last resort.

**Do not raise the budget to buy time, and do not add retries.** The gate's whole value is that it answers before a human context-switches; a gate that takes half an hour is a nightly with extra steps. Do not weaken a structural assertion, and do not drop a member — the five are the smallest set whose failure means "do not merge this", so dropping one does not make the gate faster, it makes it a different gate.
