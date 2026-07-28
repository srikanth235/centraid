# Receipt: #587 nightly zero-grey, honest evidence, and mobile prevention gates

## Checklist

### A — report honesty

- [ ] Playwright evidence keyed by basename matches its repo-relative matrix owner; the 9 affected cells render passed on the next nightly with no new tests written.
- [x] A regression test covers the basename-vs-repo-path mismatch using a fixture report with bare-basename `suite.file` values.
- [x] A declared owner matched by zero evidence keys across a full nightly fails the run.
- [x] `findUnmappedEvidence` inspects Playwright reports; orphaned evidence produces a non-zero exit and a named error.
- [x] `generate.mjs` exits non-zero when `cellsMissing > 0` and `reportScope` is nightly; `main` keeps ratcheted behaviour.
- [x] Evidence-unmatched, lane-did-not-run and owner-silent are distinct states with distinct rendering; every rendered state appears in the legend.
- [x] `blob-custody:performance` is green from a reliable test, or `gap` with a reason and tracking reference.

### B — labelling

- [x] The 10 "no harness yet" skips are `gap`; `skip` retains only structural N/A.
- [x] `gap` cells carry a structured tracking-issue field; a reference to a **closed** issue fails the validator, and no matrix note cites closed #545 as live work.
- [x] The 6 time-bound compat cells carry a revisit trigger.
- [x] `partial` renders visually distinct from `solid`.
- [x] The boilerplate `partial` note is rejected; all 42 state what is missing.
- [x] "n/a by design", "declared gaps" and "partial" are separate summary counts.

### C — gap closure

- [ ] All 10 C1 cells have a lane-wired harness with a budget and matrix owner, rendering passed in a full nightly.
- [x] Each new perf/scale test records via `recordQualityResult` with an `OWNER` matching its matrix owner exactly, verified by the matchability invariant rather than by eye.
- [x] All 14 C2 cells resolve to exactly one of: a written test, a `gap` with a live tracking issue, or a `skip` with a structural reason. None references a closed issue.
- [x] The 5 `partial` notes on those surfaces state what is missing and reference live work.
- [x] Before/after matrix totals are stated in the receipt (expected: `skip` drops from 49 to roughly 17–23 structural; `gap` becomes non-zero for the first time; `solid` rises by the C1 closures).
- [ ] A full nightly ends with `cellsMissing == 0`.

### D — blind spots

- [x] Durable history persists missing-cell and failed-cell IDs; a newly-grey or newly-red cell fails the run even when the total is flat or falling.
- [x] Flaky is a first-class state derived from Playwright's own classification; a pass-on-retry is no longer reported as a hard failure, and a per-owner flake rate is visible.
- [x] The inspector shows the first assertion error for a failed owner and links the owning CI job plus its trace/screenshot artifacts.
- [x] Perf and scale cards render real numeric trends across runs; no card reads "No trend yet" once two runs exist.
- [x] Coverage and mutation floors ratchet up toward the high-water mark, and an absolute-weakness signal flags `backup` at 44.5% mutation independently of its floor.
- [x] Skipped and env-gated tests are itemised with owner and reason; an unrecognised env-gate idiom fails loudly instead of leaving a cell `solid`.
- [x] A workspace package or app with no matrix surface fails validation with a named error.
- [x] A new red or newly-grey cell auto-files or updates a tracking issue, and a delta-since-last-run digest is emitted.
- [x] A recorded decision exists for each candidate dimension (supply-chain, bundle-size, accessibility), and `QUALITY.md ## Open` is consumed by the report.

### E — PR-time native gate

- [x] A PR touching only the root manifest / `bun.lock` triggers the mobile bundle smoke; a rerun of #565's diff against it fails on the `@babel/core` 8 transform error without reaching a mac runner.
- [x] The bundle smoke also fails on the `@babel/runtime` `regenerator` resolution error (the two classes are distinct — transform-time vs resolve-time — and the check must catch both).
- [x] Committed `ios/`/`android/` drift against the current SDK templates fails a PR with a named fingerprint mismatch, not a mid-build Swift error.
- [x] The mac nightly asserts its Xcode version against the SDK's minimum before building, and an Xcode-too-old failure renders as an environment/infra state (per A5), not a product red.
- [x] `TESTING.md` records the peer-range blind spot and names the bundle smoke as its compensating control.

### F — second-pass native blind spots

- [x] The E22 smoke is a `ci.yml` job behind `changes` (required-check-capable); a PR touching only `bun.lock` triggers it.
- [x] Replaying the pre-#610 tree fails F26 on ubuntu (hermes-era Podfile.lock vs RN 0.86 node_modules).
- [x] A `project.pbxproj` with a worktree-depth `REACT_NATIVE_PATH` fails F27 with a named error.
- [x] `expo install --check` / `expo-doctor` runs in the E22 job; its catch/can't-catch envelope is recorded in TESTING.md.
- [x] TESTING.md states the unit-lane-is-not-liveness rule (F29) next to the peer-range note (E25).
- [x] E23 is implemented as a committed-fingerprint ratchet, not template equality; an SDK bump that leaves the fingerprint file untouched fails.
- [x] Infra-mismatch states auto-file/update a tracking issue and alarm past a max age; the Xcode-vs-SDK instance is filed as the first occupant.
- [x] Dependabot's production group excludes semver-major updates, which arrive as individual PRs.
- [x] A recorded decision (guard, or skip with a structural reason) exists for each Android analog of E23/E24/F26.

## What changed

### A/B — evidence and matrix honesty

`scripts/test-report/report-signals.mjs` now resolves Playwright paths relative
to the config root and by unique suffix/basename, consumes Playwright's own
flaky/retry/error/attachment data, checks Playwright orphan evidence, reports
declared owners unmatched in a full nightly, records cell identities and
per-lane numeric history, and fails closed on unknown environment-gate shapes.
Depth/history helpers and focused coverage live in
`scripts/test-report/report-depth-signals.mjs` and
`scripts/test-report/report-depth-signals.test.mjs`.
`scripts/test-report/generate.mjs` makes the nightly zero-grey gate absolute,
renders `failed`, `flaky`, `infra-mismatch`, `evidence-unmatched`,
`owner-silent`, `lane-did-not-run`, `stale`, `gap`, `skip`, and `passed`
separately, distinguishes partial evidence, itemises debt, links run/artifact
details, displays numeric trends and flake rates, consumes `QUALITY.md ## Open`,
and emits sustained floor/infra-age signals. `scripts/test-report/smoke.mjs`
and `scripts/test-report/report-signals.test.mjs` cover those contracts.

`scripts/test-report/validate-matrix.mjs`,
`scripts/test-report/validate-matrix.test.mjs`, and
`tests/matrix.schema.json` add structured tracking issues/gaps/revisit triggers,
reject closed issue references and generic partial notes, enforce structural
skip reasons and compat migration globs, and require every workspace to map to
a surface. `tests/matrix.json` applies the contract to all 150 cells and
triages every extension/oauth-worker cell. The checked-out pre-change matrix
was **38 solid / 62 partial / 50 skip / 0 gap**; the issue's earlier snapshot
said **38 / 63 / 49 / 0**. The resulting matrix is
**48 solid / 62 partial / 38 structural skip / 2 tracked gap**. The difference
from the issue's rough expected 17–23 skips is deliberate C2 triage: structural
N/A remains a truthful outcome, not a quota to force green.

`tests/perf/blob-egress.perf.test.ts` now uses the supported explicit vault
creation path and real vault directory, so its evidence is reliable instead of
silently absent.

### C/D — depth, motion, and actionability

Four performance owners were added in
`tests/perf/backup-throughput.perf.test.ts`,
`tests/perf/app-engine-handler.perf.test.ts`,
`tests/perf/automation-fire.perf.test.ts`, and
`tests/perf/agent-turn.perf.test.ts`. Six scale owners were added in
`tests/scale/agent-sessions.scale.test.ts`,
`tests/scale/blueprint-clones.scale.test.ts`,
`tests/scale/desktop-windows.scale.test.ts`,
`tests/scale/web-tabs.scale.test.ts`,
`tests/scale/tunnel-pairs.scale.test.ts`, and
`tests/agent-e2e-mobile/flows/volume-proof.mjs`.
`tests/quality-rig-budgets.json` records each lane and volume. The shared
`packages/test-kit/src/quality-result.ts` API and
`tests/agent-e2e-shared/harness.mjs` now retain 30 samples and activate a
3×-trailing-median regression budget only after ten samples;
`packages/test-kit/src/test-kit.test.ts` and
`tests/agent-e2e-shared/harness.test.mjs` prove the warm-up, recording, and
failure behaviour.

`.github/workflows/e2e.yml` splits performance/scale into its own independently
failing 30-minute job, uploads its evidence, feeds it to the report, supplies
the nightly scope, performs the Xcode preflight, runs the mobile volume proof,
and uses `scripts/ci/report-cell-delta.mjs` to include newly red/grey/infra and
aged-infra identities in the auto-filed/updated nightly issue.
`tests/coverage-floors.json` records the sustained 3-run/2-point ratchet policy
and raises the two egregiously lagging line floors. The first clean Linux
coverage run measured OAuth worker at 90.65% and client React at 67.65%, so the
floors are 88% and 65% respectively—materially above their old 70%/45%
baselines without claiming more than CI demonstrated.
`tests/mutation-floors.json` defines the independent 60% weakness signal.

`TESTING.md` records zero-grey semantics, structural skip versus tracked gap,
the perf/scale lifecycle, the three D21 dimension decisions, the mobile
unit-versus-liveness boundary, Expo diagnostic envelope, peer-range blind spot,
fingerprint workflow, and Android decisions.
`docs/plans/test-report-zero-grey-587.md` is the durable progress/decision log.

### E/F — mobile prevention

The branch builds on the already-reviewed #609 prerequisite now present on
`main`; a required Metro gate over the older SDK 57 Babel/native breakage would
be red by construction. The prerequisite keeps its own receipt,
`receipts/issue-609-mobile-ios-build-babel7.md`.

`.github/workflows/ci.yml` extends the central `changes` job with a `mobile`
output covering the root manifest, root lockfile, mobile sources, and shared
client/design packages. The resulting required-check-capable `mobile-smoke`
job runs Expo compatibility diagnostics as advisory evidence, then blocks on
native-state verification, both iOS and Android Metro exports, and compilation
of the Android application and its native modules under JDK 17.

`apps/mobile/package.json` exposes only repo-script entry points for these
checks, including `ci:android-native`. `apps/mobile/native-fingerprints.json`
commits both expected hashes;
`apps/mobile/scripts/native-fingerprint.mjs` excludes that expectation file
from the input hash. `apps/mobile/scripts/verify-native-state.mjs` verifies
Expo/React Native pod-lock versions—including `React-Core-prebuilt` and
`ReactNativeDependencies`—the resolved Hermes tag, repository-relative native
paths, and both platform fingerprints.
`apps/mobile/scripts/check-xcode-minimum.mjs` derives
the minimum from the installed React Native helper, compares `xcodebuild`, and
writes named `infra-mismatch` evidence on failure.
`apps/mobile/scripts/verify-native-state.test.mjs` covers stale Pod locks,
seven-level worktree paths, fingerprint drift, and Xcode parsing;
`apps/mobile/vitest.config.ts` includes it.

The first real full-nightly run then caught the native compiler blind spot the
new gates are intended to expose: Expo's upgraded Android `Module` now owns a
`runtime` member, colliding with the tunnel module's private property even
though TypeScript tests and both Metro bundles were green.
`apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/CentraidTunnelModule.kt`
now uses the unambiguous `tunnelRuntime` name, and
`apps/mobile/native-fingerprints.json` explicitly accepts that reviewed native
source change. The Android journey build remains the compiler-backed
compatibility test for this class of dependency break.

The next full-nightly run exposed that compiling only the tunnel module was
still too narrow: the generated application shell imported Expo's removed
`ReactNativeHostWrapper`.
`apps/mobile/android/app/src/main/java/dev/centraid/mobile/MainApplication.kt`
now follows Expo SDK 57's `ExpoReactHostFactory` contract while preserving the
manually registered foreground-upload package, and `ci:android-native` compiles
`:app:compileDebugKotlin` so both the shell and every transitive native module
are covered in the required PR gate. The full compile also revealed Kotlin
daemon diagnostics under `android/.kotlin/` were changing the next native
fingerprint despite no source change; that machine-local directory is now
explicitly excluded from the cache-key input.

The following iOS nightly then exposed a second stale-lock variant:
`apps/mobile/ios/Podfile.lock` still resolved `React-Core-prebuilt` 0.86.0
beside React Native 0.86.2. Expo repaired it transiently during the job, after
which Xcode exited 65 while resolving the resulting build state. The committed
lock now resolves the prebuilt pod at 0.86.2; the strengthened
`apps/mobile/scripts/verify-native-state.mjs` and its
`apps/mobile/scripts/verify-native-state.test.mjs` coverage prevent either
prebuilt dependency from silently diverging again.

`.github/dependabot.yml` continues to propose all major upgrades, but leaves
each production major in its own attributable PR while grouping patch/minor
updates. The suite—not a version-ban policy—decides which major works.

The Xcode-versus-SDK infrastructure mismatch is filed as
[#620](https://github.com/srikanth235/centraid/issues/620), the first concrete
occupant of the new infra-mismatch lifecycle and max-age alarm.

## Decisions

- Kept main/per-PR grey legal and made only a full nightly absolutely zero-grey.
- Kept product failure, flaky, missing lane, silent owner, unmatched evidence,
  and infrastructure mismatch separate because they have different owners.
- Used sustained regression budgets and floor ratchets instead of invented
  absolute limits or one lucky high-water mark.
- Used committed native fingerprints rather than generated-template equality,
  preserving intentional native customizations while requiring explicit
  rebaselining.
- Made `expo install --check` advisory: it reports SDK-package compatibility
  but does not model the Babel core/runtime failures. Metro export blocks them.
- Kept Dependabot majors enabled and isolated, per the maintainer's direction,
  so test evidence determines compatibility one upgrade at a time.
- Accepted supply-chain as a cross-cutting gate rather than a duplicated
  matrix column. Bundle-size and accessibility merit future lanes/columns only
  after honest baselines exist; #587 remains their live umbrella until split.
- Android shares the fingerprint and dual-platform Metro guards. F26 is
  iOS-only because this repository commits a CocoaPods lock but no equivalent
  resolved Android dependency lock; Android native liveness remains in its
  journey lane.

## Out of scope

- Deepening the remaining 62 honestly-labelled `partial` cells to `solid`.
- Building new supply-chain, bundle-size, or accessibility lanes.
- Changing main/per-PR report semantics beyond preserving legal grey.
- Prohibiting major dependency upgrades; each remains eligible for an
  independently tested Dependabot PR.

## Verification

Focused report, matrix, mobile, performance, and scale verification:

```sh
bun run test:ratchet:unit
# 8 files, 114 tests passed

bun run test:matrix
# 15 surfaces × 10 dimensions, 58 canonical flows; passed

bun run test:report:smoke
# generated normal and intentionally-unhandled reports; smoke: ok

bun run --cwd apps/mobile test
# 37 files, 235 tests passed

bun run test:perf
# 11 files passed, 1 skipped; 11 tests passed, 2 skipped

bun run test:scale
# 12 files, 12 tests passed
```

Mobile prevention and prerequisite replay:

```sh
bun run --cwd apps/mobile ci:native-state
# native-state: Pod lock, project paths, and iOS/Android fingerprints agree

bun run --cwd apps/mobile ci:bundle
# iOS Bundled 2,132 modules; Android Bundled 2,129 modules

bun run --cwd apps/mobile ci:android-native
# :app:compileDebugKotlin (including native modules); BUILD SUCCESSFUL

bun run --cwd apps/desktop test:e2e -- appview-templates-insights.spec.ts --grep "10.2"
# 1 passed — automation template clone survives gateway + Electron restart
```

Before installing the #609 prerequisite, the same bundle command reproduced
the #565 failure:

```text
Requires Babel "^7.0.0-0", but was loaded with "8.0.1"
```

The native-state unit fixtures independently replace the Pod lock with the
pre-#610 React/hermes versions and the project path with the seven-level
worktree form; each produces its named failure.

Build and formatting:

```sh
bun run format
# finished on 2,899 files

bun run build
# 17/17 tasks successful (clean cold build)
```

The first sandboxed repository-wide coverage attempt could not bind loopback
sockets. Re-running outside the sandbox restored those suites, then exposed
several unrelated long-test timeouts under full-machine contention; the run
was stopped rather than misreported green.

Final local PR gate:

```sh
bun run check:pr:full
# all static/build/typecheck/governance gates passed
# affected tests: 36/36 tasks successful
# diff coverage: 760 files passed, 4 skipped; 6,255 tests passed, 36 skipped
# diff coverage accepted the repository's approved 47.6% < 80% deviation
```

GitHub checks are recorded after their successful runs.

The first full-nightly workflow run, `30397249331`, proved the new prevention
boundary by failing Android native compilation on the Expo `Module.runtime`
collision while the PR-time native-state and dual-platform Metro bundle gate
was green. That compiler finding was fixed in the same PR before rerunning the
nightly graph.

PR verification run `30397228787` passed all 6,286 coverage tests and then
rejected the initially proposed 92%/74% line floors against Linux measurements
of 90.65%/67.65%. The corrected 88%/65% floors apply the documented two-point
margin while still tightening the previous 70%/45% baselines.

The first two full-nightly attempts also exposed a deterministic stale desktop
fixture: `apps/desktop/tests/e2e/appview-templates-insights.spec.ts` invented a
`digest` automation template ID after Discover had moved to an explicit v0
catalog allowlist, so the product correctly rendered an empty catalog.
The journey now uses the public `obligation-extractor` catalog ID while
retaining its Daily Digest presentation and clone/restart assertions.

### Mechanical checklist crosswalk

The completed criteria are repeated verbatim so governance can mechanically
bind each checked box to this verification record:

- A regression test covers the basename-vs-repo-path mismatch using a fixture report with bare-basename `suite.file` values.
- A declared owner matched by zero evidence keys across a full nightly fails the run.
- `findUnmappedEvidence` inspects Playwright reports; orphaned evidence produces a non-zero exit and a named error.
- `generate.mjs` exits non-zero when `cellsMissing > 0` and `reportScope` is nightly; `main` keeps ratcheted behaviour.
- Evidence-unmatched, lane-did-not-run and owner-silent are distinct states with distinct rendering; every rendered state appears in the legend.
- `blob-custody:performance` is green from a reliable test, or `gap` with a reason and tracking reference.
- The 10 "no harness yet" skips are `gap`; `skip` retains only structural N/A.
- `gap` cells carry a structured tracking-issue field; a reference to a **closed** issue fails the validator, and no matrix note cites closed #545 as live work.
- The 6 time-bound compat cells carry a revisit trigger.
- `partial` renders visually distinct from `solid`.
- The boilerplate `partial` note is rejected; all 42 state what is missing.
- "n/a by design", "declared gaps" and "partial" are separate summary counts.
- Each new perf/scale test records via `recordQualityResult` with an `OWNER` matching its matrix owner exactly, verified by the matchability invariant rather than by eye.
- All 14 C2 cells resolve to exactly one of: a written test, a `gap` with a live tracking issue, or a `skip` with a structural reason. None references a closed issue.
- The 5 `partial` notes on those surfaces state what is missing and reference live work.
- Before/after matrix totals are stated in the receipt (expected: `skip` drops from 49 to roughly 17–23 structural; `gap` becomes non-zero for the first time; `solid` rises by the C1 closures).
- Durable history persists missing-cell and failed-cell IDs; a newly-grey or newly-red cell fails the run even when the total is flat or falling.
- Flaky is a first-class state derived from Playwright's own classification; a pass-on-retry is no longer reported as a hard failure, and a per-owner flake rate is visible.
- The inspector shows the first assertion error for a failed owner and links the owning CI job plus its trace/screenshot artifacts.
- Perf and scale cards render real numeric trends across runs; no card reads "No trend yet" once two runs exist.
- Coverage and mutation floors ratchet up toward the high-water mark, and an absolute-weakness signal flags `backup` at 44.5% mutation independently of its floor.
- Skipped and env-gated tests are itemised with owner and reason; an unrecognised env-gate idiom fails loudly instead of leaving a cell `solid`.
- A workspace package or app with no matrix surface fails validation with a named error.
- A new red or newly-grey cell auto-files or updates a tracking issue, and a delta-since-last-run digest is emitted.
- A recorded decision exists for each candidate dimension (supply-chain, bundle-size, accessibility), and `QUALITY.md ## Open` is consumed by the report.
- A PR touching only the root manifest / `bun.lock` triggers the mobile bundle smoke; a rerun of #565's diff against it fails on the `@babel/core` 8 transform error without reaching a mac runner.
- The bundle smoke also fails on the `@babel/runtime` `regenerator` resolution error (the two classes are distinct — transform-time vs resolve-time — and the check must catch both).
- Committed `ios/`/`android/` drift against the current SDK templates fails a PR with a named fingerprint mismatch, not a mid-build Swift error.
- The mac nightly asserts its Xcode version against the SDK's minimum before building, and an Xcode-too-old failure renders as an environment/infra state (per A5), not a product red.
- `TESTING.md` records the peer-range blind spot and names the bundle smoke as its compensating control.
- The E22 smoke is a `ci.yml` job behind `changes` (required-check-capable); a PR touching only `bun.lock` triggers it.
- Replaying the pre-#610 tree fails F26 on ubuntu (hermes-era Podfile.lock vs RN 0.86 node_modules).
- A `project.pbxproj` with a worktree-depth `REACT_NATIVE_PATH` fails F27 with a named error.
- `expo install --check` / `expo-doctor` runs in the E22 job; its catch/can't-catch envelope is recorded in TESTING.md.
- TESTING.md states the unit-lane-is-not-liveness rule (F29) next to the peer-range note (E25).
- E23 is implemented as a committed-fingerprint ratchet, not template equality; an SDK bump that leaves the fingerprint file untouched fails.
- Infra-mismatch states auto-file/update a tracking issue and alarm past a max age; the Xcode-vs-SDK instance is filed as the first occupant.
- Dependabot's production group excludes semver-major updates, which arrive as individual PRs.
- A recorded decision (guard, or skip with a structural reason) exists for each Android analog of E23/E24/F26.

## Audit

PASS — the final fresh-context audit found that the A–F checklist mirrors
issue #587 and its addendum, the checked items are materially represented in
the staged diff, and What changed faithfully describes that diff. It
specifically confirmed Expo/React Native/Hermes lock validation, the open #620
F30 occupant, and the honest decision to leave A1/C1/C6 unchecked until a real
full-nightly workflow supplies their outcome evidence.

PASS — a refreshed fresh-context audit after the first GitHub runs confirmed
the Expo `Module.runtime` fix is minimal, the required PR Android Kotlin compile
gate is wired through the existing aggregator, the 88%/65% coverage floors
faithfully apply the Linux evidence margin, all staged paths are covered, and
Dependabot majors remain enabled as individual PRs.

PASS — the final fresh-context delta audit confirmed
`obligation-extractor` is a public v0 catalog ID, the change repairs only stale
test data without weakening product filtering, every clone/restart assertion
remains intact, and the focused Electron journey passes.

## Steering

PASS — a fresh-context steering audit found one correction: the maintainer
clarified that Dependabot must continue proposing major upgrades and that the
test suite, not a version-ban policy, should accept or reject them. The
production group now batches only patch/minor updates, leaving majors enabled
as independent, attributable PRs.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fa9f8-a97-1785270252-1 | codex | 019fa9f8-a974-7022-83ce-110628053d14 | #587 | gpt-5.6-sol | 1121386 | 0 | 59632384 | 125730 | 1247116 | 19.5975 | 1121386 | 0 | 59632384 | 125730 | test(report): make nightly evidence zero-grey (#587) -m governance: allow-toolch |
| codex-019fa9f8-a97-1785270421-1 | codex | 019fa9f8-a974-7022-83ce-110628053d14 | #587 | gpt-5.6-sol | 10251 | 0 | 1448192 | 1166 | 11417 | 0.4052 | 1131637 | 0 | 61080576 | 126896 | test(report): make nightly evidence zero-grey (#587) -m governance: allow-toolch |
| codex-019fa9f8-a97-1785270587-1 | codex | 019fa9f8-a974-7022-83ce-110628053d14 | #587 | gpt-5.6-sol | 11164 | 0 | 1924864 | 1931 | 13095 | 0.5381 | 1142801 | 0 | 63005440 | 128827 | test(report): make nightly evidence zero-grey (#587) -m governance: allow-toolch |
| codex-019fa9f8-a97-1785272503-1 | codex | 019fa9f8-a974-7022-83ce-110628053d14 | #587 | gpt-5.6-sol | 237732 | 0 | 13811712 | 17343 | 255075 | 4.3074 | 1380533 | 0 | 76817152 | 146170 | fix(mobile): compile native module in PR gate (#587) -m governance: allow-toolch |
| codex-019fa9f8-a97-1785273583-1 | codex | 019fa9f8-a974-7022-83ce-110628053d14 | #587 | gpt-5.6-sol | 86351 | 0 | 13147648 | 8353 | 94704 | 3.6281 | 1466884 | 0 | 89964800 | 154523 | test(desktop): align template fixture with catalog (#587) |
| codex-019fa9f8-a97-1785275603-1 | codex | 019fa9f8-a974-7022-83ce-110628053d14 | #587 | gpt-5.6-sol | 237384 | 0 | 15204352 | 19753 | 257137 | 4.6908 | 1704268 | 0 | 105169152 | 174276 | fix(mobile): compile Expo application shell (#587) |
| codex-019fa9f8-a97-1785275651-1 | codex | 019fa9f8-a974-7022-83ce-110628053d14 | #587 | gpt-5.6-sol | 3983 | 0 | 637952 | 319 | 4302 | 0.1742 | 1708251 | 0 | 105807104 | 174595 | fix(mobile): compile Expo application shell (#587) -m governance: allow-toolchai |
| codex-019fa9f8-a97-1785277234-1 | codex | 019fa9f8-a974-7022-83ce-110628053d14 | #587 | gpt-5.6-sol | 158547 | 0 | 18686720 | 16161 | 174708 | 5.3105 | 1866798 | 0 | 124493824 | 190756 | fix(mobile): align iOS prebuilt React lock (#587) |
| codex-019fa9f8-a97-1785277279-1 | codex | 019fa9f8-a974-7022-83ce-110628053d14 | #587 | gpt-5.6-sol | 5554 | 0 | 251392 | 487 | 6041 | 0.0840 | 1872352 | 0 | 124745216 | 191243 | fix(mobile): align iOS prebuilt React lock (#587) |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-019fa9f8-1785266626-1 | 019fa9f8-a974-7022-83ce-110628053d14 | #587 | correction | classifier | Keep Dependabot majors enabled and let CI accept or reject each isolated PR | pending | 1096 | 2026-07-28T19:23:46.091Z |
