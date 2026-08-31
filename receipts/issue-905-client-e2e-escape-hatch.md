# issue-905 — two lanes in the #892 gate loop that reported what they had not run

Two defects in [#892](https://github.com/srikanth235/centraid/issues/892)'s own remedies, both found on `main` after it merged, both the same shape: a required lane reporting a verdict it had not earned. #892's receipt is on the default branch and therefore immutable, so this is a new issue with its own receipt rather than an edit to that one. The file slug names the first defect because it was found first; the receipt covers both.

## Checklist

### A — client-e2e never ran under the one trigger meant to force it

- [x] Thread `|| needs.changes.outputs.all == 'true'` into both `with:` inputs
- [x] Narrow the caller's gate from `client` to `web || desktop`, now that `boot-smoke` has left the lane
- [x] Extend `bun run lint:path-filters` with a third sub-check: any read of a `changes` output without the `all` fallback fails, whatever construct does the reading
- [x] Correct the comment on the `changes` job that promised the property for "every lane `if:`"

### B — verify demanded a report its own lane never wrote

- [x] Make `test:suite` emit the report, matching `coverage`'s shape minus `--coverage`
- [x] Add a wiring guard so a lane cannot again demand `--require-report` without running a script that writes the report

### C — the AVD snapshot never saved on a red lane

- [x] Convert the AVD cache to restore-then-save in all four mobile workflows, the arrangement the apk and gradle caches beside it already use
- [x] Give the Android release build `--stacktrace`, so a 35-minute build failure names its cause

### D — `desktop-e2e-macos`'s non-required status, investigated

- [x] Establish whether `desktop-e2e-macos` is a gap or a decision, and change nothing if it is a decision

### E — the mobile lanes seeded their fixture after the phone had already cloned

- [x] Seed the demo corpus once per LANE, before anything pairs, rather than per flow after the first pairing
- [x] Give `lint:e2e-wiring` a `corpus` rule holding both halves: no tile tap for an app that cannot earn the grid, and no seeding after the lane's handoff to Maestro

### F — the PR gate's short-circuiting prerequisite failed twice and named nothing

- [x] Let a sensitive chunk print its failing directive on failure, without ever letting its capability reach the log

### G — a coverage shard could go red and name no test

- [x] Give `coverage:shard` the default reporter alongside the blob, so a failing shard says which test failed

### H — an unreadable springboard rendered a launcher with no tiles

- [x] Keep every app on the grid when no tile is readable, so an unmounted replica cannot leave a member with no way into any app
- [x] Move grid membership into `springboard-policy`, the module that claims it, so the rule is testable without a renderer

## What changed

Where each checked item lands, then the reasoning behind it:

- Thread `|| needs.changes.outputs.all == 'true'` into both `with:` inputs — "The defect", below; `.github/workflows/ci.yml`.
- Narrow the caller's gate from `client` to `web || desktop`, now that `boot-smoke` has left the lane — "The gate was also wider than what remains in the lane"; `.github/workflows/ci.yml`.
- Extend `bun run lint:path-filters` with a third sub-check: any read of a `changes` output without the `all` fallback fails, whatever construct does the reading — "The lint that makes it the last time"; `scripts/lint-path-filters.mjs`, `scripts/lint-path-filters.test.mjs`.
- Correct the comment on the `changes` job that promised the property for "every lane `if:`" — "The lint that makes it the last time", final paragraph; `.github/workflows/ci.yml`.
- Make `test:suite` emit the report, matching `coverage`'s shape minus `--coverage` — "B — verify's tripwire"; `package.json`.
- Add a wiring guard so a lane cannot again demand `--require-report` without running a script that writes the report — "B — verify's tripwire", second half; `scripts/ci/collection-tripwire.test.mjs`.
- Convert the AVD cache to restore-then-save in all four mobile workflows, the arrangement the apk and gradle caches beside it already use — "C — the AVD snapshot"; `.github/workflows/ci.yml`, `.github/workflows/mobile-canary.yml`, `.github/workflows/mobile-alarm-test.yml`, `.github/workflows/e2e.yml`.
- Give the Android release build `--stacktrace`, so a 35-minute build failure names its cause — "C — the AVD snapshot", final paragraph; `apps/mobile/scripts/android-emulator-install.sh`.
- Establish whether `desktop-e2e-macos` is a gap or a decision, and change nothing if it is a decision — "D — `desktop-e2e-macos` is a decision, not a gap"; no file changed.
- Seed the demo corpus once per LANE, before anything pairs, rather than per flow after the first pairing — "E — the corpus arrived after the clone"; `tests/agent-e2e-mobile/seed-demo-corpus.mjs`, `tests/agent-e2e-mobile/lib/demo-corpus.mjs`, `tests/agent-e2e-mobile/lib/harness.mjs`, `apps/mobile/scripts/android-emulator-install.sh`.
- Give `lint:e2e-wiring` a `corpus` rule holding both halves: no tile tap for an app that cannot earn the grid, and no seeding after the lane's handoff to Maestro — "E — the corpus arrived after the clone", final paragraphs; `scripts/lint-e2e-wiring.mjs`, `scripts/lint-e2e-wiring.cases.mjs`, and `tests/agent-e2e-mobile/README.md`, whose `ctx.ensureDemo` entry described the per-flow contract without saying that a CI lane makes it a no-op.
- Let a sensitive chunk print its failing directive on failure, without ever letting its capability reach the log — "F — a prerequisite that fails without saying how"; `tests/agent-e2e-mobile/lib/spawn.mjs`, `tests/agent-e2e-mobile/lib/harness.mjs`, `tests/agent-e2e-mobile/lib/spawn-redaction.test.mjs`.
- Give `coverage:shard` the default reporter alongside the blob, so a failing shard says which test failed — "G — a shard that fails in silence"; `package.json`.
- Keep every app on the grid when no tile is readable, so an unmounted replica cannot leave a member with no way into any app — "H — the launcher with no tiles"; `apps/mobile/src/screens/home/springboard-policy.ts`.
- Move grid membership into `springboard-policy`, the module that claims it, so the rule is testable without a renderer — "H — the launcher with no tiles"; `apps/mobile/src/screens/Home.tsx`, and the policy cases move from `apps/mobile/src/screens/home/tile-model.test.ts` into a new `apps/mobile/src/screens/home/springboard-policy.test.ts`, with `tests/comment-density-ratchet.json` re-pinned for the arithmetic that split produced.

### The defect

`.github/workflows/ci.yml`'s `client-e2e` honoured `needs.changes.outputs.all` in its `if:` and not in its two `with:` inputs, which read `outputs.web` / `outputs.desktop` alone. The `changes` job **skips** the paths-filter step on a `workflow_dispatch` (`if: github.event_name != 'workflow_dispatch'`), so on a manual run every filter output is the empty string. The caller started — its `if:` saw `all` — and handed `.github/workflows/lane-client-e2e.yml` `web: false, desktop: false`. Both inner jobs took their own `if: inputs.web` / `if: inputs.desktop` and skipped. The lane finished in 0s having run nothing and reported satisfied to `check`, which counts `skipped` as a pass.

The consequence is the sharp one: `workflow_dispatch` is the only way to force every path-gated lane on for a commit whose diff woke none of them, and it was the one trigger under which this lane could not run at all. That is the `skipped`-counts-as-a-pass hazard #892 Phase 3 exists to close, one level down, reached through its own remedy.

Both `with:` inputs now carry the fallback.

### The gate was also wider than what remains in the lane

The caller gated on `client`, a superset of `web ∪ desktop` — it also matches `packages/server/**`. That was deliberate under #496 E7, while `boot-smoke` lived in this lane and had to run for gateway-only PRs. #892 Phase 1 moved `boot-smoke` into `verify`, and nothing gated on `client` remained here, so a `packages/server`-only PR had been starting a caller whose every job skips — on ordinary PRs, not only on dispatch. The gate is now `web || desktop || all`.

### The lint that makes it the last time

`scripts/lint-path-filters.mjs` gains a third sub-check beside `claimed` and `tidy`: `escape`. Every read of a `changes` output must carry `|| needs.changes.outputs.all == 'true'`, and the check is deliberately blind to which construct does the reading — those two `with:` lines were the only reads in `ci.yml` outside an `if:`, and every prior reading of this table had assumed `if:` was the only place an output could be consumed.

The scanner folds YAML block scalars back into one unit under the line number of their key (`scannableUnits`) rather than banning them. A per-line scan would read the fallback half of a folded `if:` as absent; the cheaper alternative — refusing folded conditions outright — would have made collateral of `publish-report`'s, which is folded for length alone and contains no filter output. `scripts/lint-path-filters.test.mjs` pins both directions: the pre-fix `with:` shape is caught, a folded condition carrying the fallback passes, and the line after a folded block is not swallowed.

The comment on the `changes` job in `.github/workflows/ci.yml` promised this property for "every lane `if:`" — the wording that *is* the blind spot. It now says "every read", names how the two `with:` inputs came to be the exception, and points at the lint that checks it instead of the wording promising it. The comment on `static`'s `lint:path-filters` step names the new sub-check.

### B — verify's tripwire required a report its own lane never wrote

`.github/workflows/ci.yml`'s `verify` ends with `bun run test:collection-tripwire -- --require-report`. `scripts/ci/collection-tripwire.mjs` reads `artifacts/test-results/vitest.json`. `package.json`'s `test:suite` — the only thing in that job that runs the suite — was `vitest run --reporter=default`, with no `--reporter=json` and no `--outputFile`, and neither `vitest.config.ts` nor `vitest.shard.config.ts` declares reporters. On a clean runner the file cannot exist, so the step failed every time it was reached.

`verify` is in `check`'s `needs:`, so the required check could not pass on any run that got that far — every PR, not only `main`. It shipped unobserved because the preceding main-push runs were each cancelled by a superseding push before `verify` reached its last step. The dispatch run that exposed defect A exposed this one too: the suite was fully green (`1502 passed | 4 skipped` files, `18162 passed | 5 expected fail | 37 skipped` tests, 1158 s) and the job died on the step after it.

`test:suite` now carries `--reporter=default --reporter=json --outputFile=artifacts/test-results/vitest.json` — `coverage`'s shape minus `--coverage`. That is the arrangement the `coverage` job's own comment already described ("Scored on the merged report as well as on `verify`'s own run"), so the reporter was the missing half of an intent already written down. Dropping `--require-report` would also have gone green and is the wrong fix: the flag is what separates "no file failed to collect" from "nothing was looked at", and the script's non-strict mode already prints `not measured` for a laptop.

`scripts/ci/collection-tripwire.test.mjs` gains the wiring assertion, derived from the shipped YAML the way `lint-e2e-wiring` is: every `ci.yml` job running the tripwire with `--require-report` must also run a package script whose body writes the report path. Producers are read out of `package.json` rather than named, so a new producer or lane inherits the check.

That assertion's first draft **passed against the very defect it was written for**. It joined each job's raw lines, and `verify`'s header comment contains the words "`bun run coverage` alone at 20m15s" — so a check looking for a producer invocation found one in prose. A wiring check that reads commentary is the same class of mistake as the wiring it checks. Comment lines are stripped now, and the correction was verified by reverting `test:suite` and watching the assertion fail with the job named.

### C — the AVD snapshot never saved on a red lane

`mobile-device-gate` failed on the main-tip dispatch after 34m55s, and it failed in the **build**, not the suite: `:app:packageRelease FAILED` inside `PackageAndroidArtifact$IncrementalSplitterRunnable`, with `1414 actionable tasks: 1414 executed` — nothing cached, a fully cold compile. The emulator suite never started, `tests/agent-e2e-mobile/runs/` was empty, no evidence was uploaded, and the twelve-minute suite budget never engaged because there was no suite.

Two things are fixed here. **Neither is the `packageRelease` failure itself**, whose cause is still unknown — see Out of scope.

The AVD cache was the one-step `actions/cache` in all four mobile workflows, while the apk and gradle caches beside it are `restore` + `save`. The comment explaining why sits three lines above it in `mobile-canary.yml`: "`actions/cache` declares `post-if: success()`, so on a lane that is currently red the cache never populates and the expensive build is paid on every run — the warm path stays unreachable until the greenness the cache exists to help deliver." The reasoning was written, applied to two caches, and not to the third. The logs state it twice: `Post AVD cache` reported `skipped` on every red run, and `Create AVD + snapshot (cache miss only)` ran on every run — ~2 minutes each time, forever, on lanes that are red.

`ci.yml`, `mobile-canary.yml`, `mobile-alarm-test.yml` and `e2e.yml` now restore with `actions/cache/restore` and save with a `Save the AVD snapshot` step placed immediately after the create. Immediately after, not at job end: it banks the snapshot **before** the long emulator step can fail, and it inherits `success()` so a failed create never banks a broken AVD. The key is a pure description of the AVD's shape and the test step runs `-no-snapshot-save`, so nothing a suite does can poison what is stored.

`apps/mobile/scripts/android-emulator-install.sh` gains `--stacktrace` on the release build. That build reported its failure as a bare `IncrementalSplitterRunnable` line with no cause, because gradle prints one only when asked — so the 34m55s produced a red lane and no diagnosis, and the next person pays another 35 minutes to learn what this run already knew. Stack traces are emitted on failure only, so a green build's output is unchanged.

### D — `desktop-e2e-macos` is a decision, not a gap

It is absent from `check`'s `needs:` while every other path-gated lane is present, and this receipt's earlier draft called that a gap. It is not, and no code changed. `ci.yml` states the ruling directly above the job: "`desktop-e2e-macos` stays, and stays NON-REQUIRED. #892 asked whether a 10x-multiplier runner belongs on the PR loop at all; the answer recorded here is that it does while it is advisory, because the twice-burned promotion rule in `lane-client-e2e.yml` is the thing that would move it, and demoting it to nightly would delete the only darwin signal that rule could ever read."

The reason to record it rather than drop it is that "advisory" is exactly the state #892 Phase 3 spent an issue bounding, so the question worth asking is whether *this* advisory lane is bounded by anything. It is: `scripts/ci/lane-health.mjs` tallies every job name from main's runs with no allowlist, so a `desktop-e2e-macos` that stays red on main for more than three days fails the nightly health lane unless it carries an unexpired entry in `tests/lane-quarantine.json`. Non-required is not unwatched. Nothing to fix.

### E — the corpus arrived after the clone, so a working app looked broken

With A, B and C landed, `mobile-device-gate` was the one lane still red — and, once the cold build stopped hiding it, the suite reached the emulator and failed somewhere new. `pairing-canary` passed (182s, then 174s on the PR head — three consecutive passes, which retires the one 73s failure recorded above as a blip). What failed was every journey after it, at its first tap:

```
Assert that "All apps and places" is visible... COMPLETED
Tap on "Open Notes.*"... FAILED
Element not found: Text matching regex: Open Notes.*
```

The same shape on `main`, across the whole canary roster: `Open Photos.*`, `Open Docs.*`, `Open Agenda.*`, `Open Notes.*`, `Open Tasks.*`, `Open People.*` and `id: home-tile-photos`, all `Element not found`, while pairing, onboarding and cold start passed.

**The app was correct.** `springboardState` (`apps/mobile/src/screens/home/springboard-policy.ts`) reads every tile settled and empty, returns `first-run`, and `Home.tsx` renders `<DayOne>` **instead of** `<LauncherGrid>`. There is no launcher tile on an empty vault, by design. `HOME_READY_MARKER` did not catch it because it is `"All apps and places"` — a `HomeBand` accessibility label that renders in *both* states. The harness comment beside that constant already said so: "it is a render signal, not a settled signal".

So why was the vault empty when every flow seeds? Because **`ensureDemo` writes to the gateway, and a lane is many flows sharing one pairing.** Each flow does the right thing alone — `ensureDemo("notes")` then `configureGateway()` — but only the FIRST flow of a lane actually pairs. `run-pr-gate-suite` opens with `pairing-canary`, which pairs and seeds nothing; the roster pairs inside `run-probes-suite` and then runs three more suites against that profile. Every seed after that lands on a gateway whose client has already cloned, and nothing pulls a post-clone write down. The run log states it plainly, in order:

```
note : paired the journey with the gateway at http://127.0.0.1:18789
note : notes demo seeded (16 rows)
note : reused the paired nightly profile for http://127.0.0.1:18789
```

Sixteen rows written, none of them ever on the phone. `native-v0-resilience` is the clincher: it seeds `tally` and then opens all eight covers, so even a perfectly-synced phone would have needed seven scenarios it never asked for.

**AND THIS DIAGNOSIS IS WRONG — or at least not sufficient. Recorded rather than rewritten, because the correction is the useful part.** The fix below shipped and did exactly what it says: `seed-demo-corpus: 7 scenario(s) ready before first pairing` precedes the first `[runFlow]`, `pairing-canary` then passed (234s), and `notes-library` reported `notes demo already present (16 rows)` before reusing that pairing. The corpus was in the gateway before the clone, the phone paired, and `Tap on "Open Notes.*"` **still** failed with `Element not found`. Seeding order was not the cause.

What fits every run instead, and fits the empty-vault and seeded-vault cases *identically* — which is precisely why the seeding changed nothing:

- `replicaQueryConnection` (`apps/mobile/src/kit/hooks/replica-query-state.ts`) returns `"unavailable"` when there is no replica **session**, before it ever considers rows.
- `combineStatus` in `useSpringboardTiles.ts` maps `connection === "unavailable"` to `unknown`.
- `tileEarnsGrid` promotes only `content`, `loading` or Locker, so **no tile earns the grid**.
- `springboardState` sees every tile `unknown`, takes its `readable.length === 0` branch and returns `content` — so Home renders `LauncherGrid` rather than `DayOne`, with an EMPTY `earned` list.

That is a rendered launcher with no tiles, under a `HomeBand` still publishing "All apps and places". Identical symptom, no dependence on rows at all. The open question is why a freshly-paired phone has no replica session, and the standing suspicion is the one #890's receipt already flagged as unproven: the on-device `op-sqlite` driver was never exercised, its 52-of-56 boot-condition cells being evidence about the `NodeSqliteDriver` stand-in rather than the native module the app ships. A replica that cannot open its database has no session, and every home journey fails at its first tile.

That belongs to #904/#870 with this evidence attached, not to a CI-wiring issue, and it is not fixed here.

**Why the change below stays anyway.** It is correct on its own terms: `ensureDemo`'s documented contract is "seed before the initial replica clone", the lane violated it, and a suite whose fixture lands after the clone is broken whether or not something else is also broken. Keeping it costs one HTTP call per lane and removes a real confound from the next diagnosis — the next person can rule the corpus out by reading one line instead of re-deriving it. What is withdrawn is the claim that it fixes the tile taps.

The fix is one line of ordering. `tests/agent-e2e-mobile/seed-demo-corpus.mjs` seeds every app that ships a `packages/blueprints/apps/*/seed.js` — seven scenarios, 166 rows — and `android-emulator-install.sh` runs it before it hands off to Maestro, so both device lanes get it and the corpus precedes the first clone by construction. It is lane-wide rather than per-suite because a tile is a property of the vault, not of whichever flow ran first. The HTTP moves to `lib/demo-corpus.mjs` so the lane seeder and `ctx.ensureDemo` cannot disagree about the row-count guard that makes a second call free; the per-flow calls stay, because they document each journey's fixture and are what makes a flow runnable on its own.

`lint:e2e-wiring` gains RULE `corpus`, in two halves, because the two ways to get this wrong are different. (a) A flow may only tap `Open <App>` for an app that ships a scenario or is one the springboard promotes on an empty vault — `locker` is the sole exemption, and it is an exemption rather than an oversight because its tile body is a *state* rather than a query result. (b) The lane preamble must run the seeder, and must do it **before** `export MAESTRO_PLATFORM`: ordering it after the handoff restores the defect while looking like the fix, so the rule checks position, not presence. The app table is read from `packages/blueprints/apps/` rather than listed, on the linter's existing principle that a hand-kept list is the thing that drifts.

### F — a prerequisite that fails without saying how

The corpus fix landed exactly as designed — `seed-demo-corpus: 7 scenario(s) ready before first pairing`, ahead of the first `[runFlow]` line — and the lane was still red, because `pairing-canary` failed before any tile could be tapped. That is the fourth data point on one chunk:

| head | corpus | `pairing-canary` |
| --- | --- | --- |
| `42c66389` | empty | **FAIL** 73s |
| `36bad90e` | empty | PASS 183s |
| `277e054c` | empty | PASS 174s |
| `f221b862` | seeded | **FAIL** 125s |

Failing under both corpus states rules out the seeding as its cause, which is worth stating because the ordering invited the opposite conclusion: the failure arrived in the same push as the change, and reading it as a regression would have been the obvious mistake. Both durations are *shorter* than a pass, so neither is the flow running long; each is a wait inside `01-configure-gateway` expiring — a different one each time, 73s against the 45s first-launch wait and 125s against the 90s redemption wait.

Neither could be diagnosed, and that is the defect this section fixes. The chunk runs `sensitive: true`, which kept its capability out of the log by keeping *everything* out of it: `stdio: "ignore"`, and the `maestro-debug` directory deleted before upload. Two failures of the PR gate's short-circuiting prerequisite — the one whose failure takes the other four journeys with it — reported `maestro sensitive flow exited 1` and nothing else, twice.

The output is now captured and, **on failure only**, the redacted step lines are printed; a green run stays silent. The capability is no more printable than before, held by two independent controls so that neither one being wrong is enough: only lines in Maestro's step shape survive the filter (a directive name and a verb, never a value — `inputText` renders as the `${MAESTRO_*}` placeholder, which is literally what the retained YAML holds), and every secret is replaced by exact-string match regardless. `spawn-redaction.test.mjs` drives each control alone, including the case where a secret reaches a step line anyway.

This does not fix the flake. It makes the next occurrence name the directive it died on, which is the thing four runs could not say — the same trade as the `--stacktrace` under C, and the honest extent of what one more red run can buy without a diagnosis.

The spec sits beside the harness and is run by the `test-report-scripts` vitest project, whose `include` already carries `tests/agent-e2e-mobile/lib/**/*.test.mjs`.

**A wrong turn worth recording, because CI caught it and reasoning did not.** Grepping for what ran `sh-quote.test.mjs` — the spec next door — returned nothing, so this receipt briefly claimed it was an orphan that had never executed, and F's spec was written for `node --test` and added to `scripts:test` to avoid the same fate. Both halves were wrong. The directory is included by a config that names it only through a glob, so no grep for the filename could find it; `test:ratchet:unit` then failed with `No test suite found`, because that project had picked the file up and `node:test`'s `test()` is not vitest's. The spec is now vitest, matching its neighbour, and the `scripts:test` entry is removed so it is not run twice. The claim about the orphan is withdrawn: `sh-quote.test.mjs` runs, on that lane, with coverage.

### G — a shard that fails in silence

`coverage-shard (2)` went red on this branch, and its log ends:

```
blob report written to /home/runner/work/centraid/centraid/.vitest-reports/blob-2-4.json
error: script "coverage:shard" exited with code 1
```

That is the whole diagnosis. `--reporter=blob` writes the machine artifact and prints nothing a human reads, and the failure detail inside the blob is only ever rendered by the `coverage` merge job — which `needs:` the shards, so a red shard means nobody ever sees why. Four runners can spend six minutes each and produce one line naming no test.

`coverage:shard` now passes `--reporter=default` alongside `--reporter=blob`, the same shape B gave `test:suite`. The blob is still written (49 MB locally, and the merge lane's `assert-shard-blobs` guard is unaffected); a green shard gains a summary line; a red one names its file, its test and its assertion.

It paid immediately. Running shard 4 locally with the new reporter surfaced two named failures in `packages/server/src/acp/backends/acp/launch.test.ts` — `expected 'yes' to be '1'` on `plan.env.IS_SANDBOX`. That is **this container**, not the repo: `IS_SANDBOX=yes` is set in the agent sandbox and `planLaunch` reads ambient env, so the two cases that assert on its absence cannot hold here. Nothing is changed for it — it is a third local-environment finding, recorded beside the other two rather than "fixed".

The CI failure itself is NOT this PR's, and the check is deliberate rather than assumed: `coverageProjects` in `vitest.config.ts` does not include `scripts/test-report/vitest.config.ts`, so the only test file this branch adds is outside every shard — confirmed by grepping a local shard run for it (zero occurrences) rather than by reading the config alone. Shard 2 passes locally on this exact tree. No re-run was spent because this session has no tool that can re-run a job; that is stated in Out of scope rather than left as an unexplained omission.

### H — the launcher with no tiles

The product defect behind the red device gate, found by reading the grading path after E's ordering hypothesis was falsified. Two rules, each correct alone, each tested alone:

- `tileEarnsGrid` demotes an `unknown` tile — "rather than showing a body it cannot stand behind", and its test says exactly that.
- `springboardState` returns `content` when every tile is `unknown` — deliberately NOT `first-run`, because "we do not KNOW the vault is empty, so we do not say so".

Composed, they produce the one outcome neither intends. With no replica session every tile reads `unknown` (`replicaQueryConnection` returns `unavailable` before it considers rows at all, and `combineStatus` maps that to `unknown`), so `springboardState` routes to the grid — and `Home.tsx`'s membership filter then demotes every tile, rendering that grid **empty**. The member is not told the vault is empty and has no way into any app. Offline, that is the whole product.

Nothing tested it because nothing could: the membership loop lived inline in `Home.tsx`, there is no `Home` screen test, and both halves pass their own unit tests. So the rule moves to `springboard-policy.ts` — the module whose header already claims "which earned the grid" as its law and whose stated reason for staying pure is that its decisions are "testable without a renderer" — as `gridMembership`, beside a new `everyTileUnreadable`. `Home.tsx` now decides nothing about membership.

The tests land in a new `springboard-policy.test.ts`. They had gone into `tile-model.test.ts`, which then crossed the 625-line god-file ceiling — and the policy module had no test file of its own, which is part of how this stayed invisible. The split follows the precedent #890 set when the wiring linter's fixtures moved to a sibling module for the same reason.

Verified in both directions: with the pre-fix rule restored, two of the four new cases fail (`keeps every app when nothing is readable`, `populates the grid in exactly the state springboardState routes there`); with the fix, 24 pass in that file and 170 across `screens/home`.

**What this does not claim.** It does not establish that an absent replica session is why CI's tiles are missing — the two states that produce no tiles (`unknown` everywhere, or `empty` everywhere routing to DayOne) are indistinguishable from the Maestro log, and the run artifact that would settle it is on a host this container cannot reach. What is established is that ONE of those two states is a genuine shipped defect, independent of CI: a phone whose replica has not mounted shows a home screen it cannot act on. If the device gate is red for the other reason, this fix is still correct and the gate will say so next run.

**One approved deviation, with its arithmetic.** `apps/mobile/src/screens/home/tile-model.test.ts` is hand-re-pinned from `[1525, 14787]` to `[1391, 11523]` — 10.31% to 12.07%. Its comment content did not grow; it SHRANK. The file lost 134 comment characters and 3264 total characters when the policy describes moved out, so it shed proportionally more code than prose and the share rose on a smaller denominator. Same shape as the two pins #892 re-pinned for the same reason, and the reason is stated here rather than laundered through `--write`, which refuses to raise a pin precisely so this has to be argued.

### Docs

`docs/decisions.md` gains **G-filter-escape-hatch** beside the existing G-filter-inverse. `TESTING.md`'s path-filter row records both the narrowed `client-e2e` gate and the new fallback requirement.

## Decisions

1. **The gate narrows to `web || desktop` rather than staying at `client` with the inputs fixed.** Fixing only the inputs would have left a caller that starts for `packages/server`-only PRs and runs nothing — the same empty shell, still reporting satisfied, just on a different trigger. The `client` filter itself is not deleted: `verify` is unfiltered and `boot-smoke` rides it, so the coverage `client` used to buy is already paid for elsewhere.
2. **The lint checks reads, not `if:`s.** Scoping it to `if:` would have reproduced the exact assumption that produced the bug. The rule is "a read of a filter output carries the fallback", and it does not care whether the read is in an `if:`, a `with:`, an `env:`, or something not yet written.
3. **Block scalars are folded, not banned.** The first draft refused any multi-line `if:` so the per-line scan stayed sound; `publish-report`'s folded `if:` — long for length, no filter output in it — failed immediately, which is the check inventing work rather than finding it. Joining the block is a dozen lines and refuses nothing that is fine.
4. **`desktop-e2e-macos` is left exactly as it is, and the earlier claim that it was a gap is withdrawn.** See "D" above. It is a ruling recorded in `ci.yml` and bounded by `lane-health.mjs`'s chronic-red rule, which has no lane allowlist. Changing it would have overturned a decision on the strength of a pattern ("every other path-gated lane is in `needs:`") without reading the paragraph that explains the exception.
5. **Two local-environment findings are recorded but produced no code change.** They cost most of the time spent and would cost the next reader the same. See Verification.
6. **Both defects ride one issue and one receipt.** They are separate bugs, and a second issue was briefly opened for B (#906, closed as a duplicate onto this one). Keeping them together is the deliberate call: they were found in the same dispatch run, they are the same failure shape — a lane in `check`'s needs reporting a verdict it had not earned — and splitting them would put two halves of one "is main actually green" answer in two places. The file slug still names A alone; the `## Checklist` is split A/B so neither is buried.
7. **B's producer set is derived, not listed.** The wiring assertion finds every script whose body contains `--outputFile=artifacts/test-results/vitest.json` and requires one per demanding job. Hard-coding `coverage`/`test:suite` would have to be edited by exactly the person who would forget the reporter.
8. **B's guard lives in `collection-tripwire.test.mjs`, not a new linter.** It is one assertion about one gate's wiring; a new `scripts/lint-*.mjs` plus a `package.json` entry plus a `static` step would be three files of ceremony. `scripts:test` already runs this file on the per-PR loop.

## Out of scope

- **`:app:packageRelease`'s actual failure.** NOT fixed here, and not diagnosed. Gradle reported only `A failure occurred while executing PackageAndroidArtifact$IncrementalSplitterRunnable` with no cause, on a build with no `--stacktrace`. The canary built and packaged the same tree successfully at 08:37, so packaging is not systematically broken and a guess would be a guess. The `--stacktrace` added under C is what makes the next occurrence diagnosable; that is the honest extent of it. Whoever picks it up should start from the daemon's 2 GiB max heap and a fully cold 1414-task build on a shared runner.

  **It did not recur, and the reason narrows the search.** The branch dispatch (run 33374941598, 08:52) restored the apk cache on key `android-release-Linux-jdk6ea3257c17f4-fp…-js0601c949dd337c83` — 147 MB, a hit — so the installer took its warm path (`Android cache hit … skipping gradle`) and no gradle ran at all. Two things follow. The 34m55s failure was reached only through the cold path, which supports the cold-cache-window bullet below as its precondition rather than a coincidence; and it is not deterministic on this tree, so the `--stacktrace` may have to wait for the next cold miss to pay out. Neither observation is a diagnosis, and the bullet stands.
- **`mobile-device-gate` is still red, now for an unrelated reason in the product.** With the build skipped, the suite ran and `pairing-canary` failed at its first chunk `01-configure-gateway` after 73s with **0 completed assertions**, classified `product`; the four journeys behind that shared prerequisite never started. The chunk's own diagnostics are deliberately unreadable — it is a `sensitive: true` flow whose stdout is suppressed and whose `maestro-debug/*-configure-gateway` directory the `Remove sensitive pairing diagnostics` step deletes before upload, because it would otherwise ship a live enrollment capability. That control is correct and is not to be weakened to make this easier to read. The 73s is consistent with the flow's first `extendedWaitUntil` (`FIRST_LAUNCH_TIMEOUT_MS`, 45s on a release build) plus install and `clearState`, i.e. the app never reached "Connect your gateway." — consistent, not established, because the verdict could not be read from here (the artifact host is off this container's egress allowlist).
- **`coverage-shard (2)`'s own red.** Judged infra or flake: the shard is outside this branch's reach (see G), it passes locally, and all four shards were green on an earlier head of this same PR. It could not be confirmed by the one re-run the rules allow, because no tool in this session can re-run a job — so the honest position is "not reproduced, not explained", and G is what makes the next occurrence explain itself.
- **`IS_SANDBOX` leaking into `launch.test.ts`.** Two cases in `packages/server/src/acp/backends/acp/launch.test.ts` assert on `plan.env.IS_SANDBOX` being unset or forced, and `planLaunch` reads ambient env — so they fail in any environment that exports it, as this agent sandbox does. Hermetic-ising them is a `packages/server` change with its own blast radius and no bearing on this issue.
- **The `01-configure-gateway` flake itself.** F makes the next failure name its directive; it does not make the chunk stable. Two failures in four runs on the PR gate's short-circuiting prerequisite is a real reliability problem, and the two expiries were different waits, so there is probably more than one cause. Diagnosing it needs the step lines F now emits.
- **`verify` has almost no headroom against its 30-minute cap, and tipped over once.** Observed, not fixed, and this receipt should not pretend it is unrelated to B. Job durations for the lane: 27m35s when the suite last ran to completion green, and 30m17s on `914555a3`, where `timeout-minutes: 30` cancelled `test:suite` at 20m22s with the preamble having already spent ~10m. Roughly 8% headroom, so ordinary runner variance decides it — `test:qualities` alone moved 1m04s → 2m13s between two runs of the same tree.

  B's reporter is a contributor: `test:suite` now serializes a JSON report for 18k tests that it did not write before. That is very likely seconds rather than minutes, and the lane already measured 27m before this branch existed, so the cap was being approached without it — but "small" is not "none", and the honest statement is that this change spends part of a budget that had none to spare.

  **The cap is deliberately not raised.** Raising a bound because the thing it bounds grew is how the twelve-minute device-gate budget became a verdict rather than a bound, which is the defect #892 Phase 0 opened by fixing. If the lane needs more room the answer is to move work out of it, as Phase 1 already did once by splitting coverage off; that is a change with its own sizing argument and is not this issue's.
- **Why a freshly-paired phone has no replica session.** The evidence chain is in E; the cause is not established and is not this issue's. It is the thing #904 and #870 actually need, and the first place to look is the on-device `op-sqlite` driver, which #890's receipt records as never having been exercised on a device.
- **The Android roster's remaining red, after E.** E fixes the cause of every `Element not found` tile tap. It does NOT re-verify the journeys behind those taps: `photos-permissions` also failed its own `photos-collections` assertion after warnings about `^Open$` and `^Continue$`, which is a permission-dialog path this change does not touch, and no lane has run past the tile tap yet to say what else is behind it. #904 and #870 stay open until a green roster closes them.
- **The Android roster is broadly red on `main` itself, and is already tracked.** The `mobile-canary` run on main tip `f5ca34fb` (33370541215) paired and onboarded fine — `mobile-cold-start`, `home-loads` and `volume-proof` all PASS, and "All apps and places" asserts visible — then failed nearly every remaining journey at the tile tap: `Open Photos.*`, `Open Docs.*`, `Open Agenda.*`, `Open Notes.*`, `Open Tasks.*`, `Open People.*` and `id: home-tile-photos` are all `Element not found`. One shared symptom, a home screen rendering its heading without its tiles. The canary's own `File a tracking issue on a red canary` step filed **#904** for it, and **#870** is the older sibling ("home-app journeys never see home"). Nothing here changes app code; it is recorded because it is the actual reason the mobile lanes are red on main, and it is not the CI wiring this issue is about.
- **The window in which the canary has not yet warmed the apk and gradle caches.** `mobile-canary.yml` saves them `if: always()`, which is already right, but it saves *after* the full roster — roughly 55 minutes after the build finishes. So for about an hour after each merge to `main`, a device-gate run on that content is cold by construction. Splitting the build out of the emulator-runner step would fix it and is a restructure of the mobile lanes, not a line change; out of scope for a PR that is otherwise about gate wiring.
- **The other ten path-gated lanes.** All were verified to wake correctly on a `workflow_dispatch` run of main tip; none needed a change.
- **`mutation-pr` and `dependency-review` reporting `skipped` on a main push.** Both are gated on `github.event_name` by design (PR-only / non-main-push), not by a path filter, and neither is a defect.
- **The wall-clock ceiling's own report dependency.** `coverage`'s "Suite wall-clock ceiling" step guards the same artifact with its own explicit existence check and is unaffected by B.

## Verification

Every command below was run in this container against this branch, on Node 24.4.1 and Bun 1.3.13 (the versions `.node-version` and `packageManager` pin).

The lint fails on the pre-fix shape and passes on the fixed tree:

```sh
bun run lint:path-filters
node --test scripts/lint-path-filters.test.mjs   # 15 passed, 0 failed
```

The workflow still parses and the block reads as intended:

```sh
node -e "const {parse}=require('./node_modules/yaml');console.log(JSON.stringify(parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8')).jobs['client-e2e'],null,2))"
```

B's guard fails on the pre-fix tree and passes on the fixed one — both directions, not just the green half:

```sh
node --test scripts/ci/collection-tripwire.test.mjs          # 10 passed
# then, with test:suite reverted to `--reporter=default` alone:
#   1 failing — "ci.yml job `verify` runs the tripwire with --require-report
#   but no step in it runs a script that writes artifacts/test-results/vitest.json
#   (one of: coverage, coverage:merge). The gate cannot pass there."
```

B's failure itself reproduces with no report on disk:

```sh
node scripts/ci/collection-tripwire.mjs --require-report
# collection-tripwire: artifacts/test-results/vitest.json is missing, so no file could be scored.
```

C's four rewired workflows parse, and each carries exactly one restore and one save:

```sh
node -e "const {parse}=require('yaml');const fs=require('fs');
for(const f of ['ci.yml','mobile-canary.yml','mobile-alarm-test.yml','e2e.yml']){
  const d=parse(fs.readFileSync('.github/workflows/'+f,'utf8'));
  let r=0,s=0;
  for(const j of Object.values(d.jobs)) for(const st of (j.steps||[])){
    if(st.name==='AVD cache'&&String(st.uses).includes('cache/restore'))r++;
    if(st.name==='Save the AVD snapshot'&&String(st.uses).includes('cache/save'))s++;}
  console.log(f,r,s);}"
# ci.yml 1 1 / mobile-canary.yml 1 1 / mobile-alarm-test.yml 1 1 / e2e.yml 1 1
bun run lint:workflow-pins
bun run test:matrix          # includes validate-nightly-wiring
bun run test:governance-shell
```

D changed no file; the evidence is a read, reproducible as:

```sh
grep -n -B12 '^  desktop-e2e-macos:' .github/workflows/ci.yml   # the NON-REQUIRED ruling
grep -n 'job.name' scripts/ci/lane-health.mjs                   # no lane allowlist
```

Gates touching the changed files:

```sh
bun run format:check
bun run lint
bun run lint:workflow-pins
bun run lint:turbo-cache
bun run scripts:test
bun run test:comment-density
bun run test:matrix
bash .governance/run.sh   # 22 directive(s) passed
```

Field evidence for A — run `33372386799` (`workflow_dispatch` on `f5ca34fb`) reported `client-e2e / web-e2e` and `client-e2e / desktop-e2e` as `skipped` in 0s while all ten other path-gated lanes woke; its `changes` job shows `Run dorny/paths-filter@… skipped`, which is the empty-string source. The fix is proved by the dispatch of this branch (run `33374941598`), where both inner jobs execute instead of skipping.

Field evidence for C — the defect and the fix are both visible in the step lists, on `main` and on this branch respectively. The `mobile-canary` job on main tip (`99430723132`) reports `AVD cache` **success** (a miss), `Create AVD + snapshot (cache miss only)` **success** (95 s), and `Post AVD cache` **skipped** — the save declining to run because the job was red, exactly the shape the fix removes. The same lane on this branch (`mobile-device-gate`, job `99443239488`) reports the new `Save the AVD snapshot` step as **success** in 15 s, before the emulator step it used to sit behind.

Field evidence for B — the same run's `verify` job: `Test Files 1502 passed | 4 skipped (1506)`, `Tests 18162 passed | 5 expected fail | 37 skipped (18204)` in 1158.30 s, then `##[error]Process completed with exit code 1` on the step after it, with the tripwire's "is missing, so no file could be scored" as the last line of output.

Two local-environment findings, recorded because each looked like a repo defect and was not:

1. **`receipt-per-issue` and `toolchain-config-protection` failed on a clean checkout of main tip.** The cause is a stale local `main` ref (`3b8c3f0c`, ten behind `origin/main`): the directive resolves its change set from `merge-base(HEAD, main)`, so the walk pulled #892's entire squash into scope. CI is green on the same commit because there `merge-base == HEAD` and the rule is skipped. `git branch -f main origin/main` clears it. This is the second time a stale `origin/main` in a container has produced a red gate attributable to nothing in the tree — see #892's receipt, Decisions 10.
2. **`agent-session-identity` reads the issue anchor from the git process argv.** `git commit -F <file>` therefore has no anchor even when the subject carries `(#905)`; `AGENT_ISSUE` is the supported alternative.

## Audit

**VERDICT: REFUTED — the independent audit required by `receipt-per-issue` rule 7 has NOT been performed.**

Recorded as REFUTED because the directive defaults to REFUTED under uncertainty and "nobody independent has looked" is the strongest form of that. The verdict is about the audit's absence, not about a finding.

**Why it is absent.** Rule 7 wants the verdict of a fresh-context sub-agent handed only the diff, this receipt, and the issue. This session was instructed not to spawn sub-agents, so none ran. Writing PASS would be an author attesting to their own work in the section reserved for someone who has not seen their reasoning — and mechanically indistinguishable from a real audit.

**What to do before merging.** Hand a fresh-context agent only `git diff origin/main`, this receipt, and issue #905; ask it adversarially whether `## What changed` describes the diff, whether each `- [x]` is realized in it, and whether the checklist mirrors the issue. Replace this section with its verdict.

**Author's own review, which is NOT that audit.** Recorded so the auditor has claims to attack rather than reconstruct:

- The narrowed gate is the one change here that could *reduce* coverage. It cannot: `web ∪ desktop ⊂ client`, and the difference (`packages/server/**`, `packages/core/**` via neither) only ever reached jobs that were already gated on `inputs.web` / `inputs.desktop`, both false for a server-only diff. Nothing that used to run stops running.
- The lint's per-line scan is the weakest part. It is sound for `${{ }}` expressions and one-line conditions, and `scannableUnits` covers folded and literal scalars; a filter output read from a composite action or a script the workflow calls would not be seen. That is outside what a line scanner over `ci.yml` can promise, and the header says so.
- The claim "those two `with:` lines were the only reads in `ci.yml` outside an `if:`" is checkable: `grep -n "needs.changes.outputs" .github/workflows/ci.yml` returns thirteen lines, eleven of them `if:`.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-31 | claude-code | 91a550cd-d7f2-5fa3-9d41-c4d75aaf2c05 |
