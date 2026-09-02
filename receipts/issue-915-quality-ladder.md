# Issue #915 — the Quality Ladder: six rungs, candidate promotion, mobile-first pyramid, Night Watch v2

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-02 | claude-code | - |
| 2026-09-02 | claude-code | 5aab7e77-9dff-50a0-a8f3-bb925566a8c9 |

## Checklist

Mirrors [#915](https://github.com/srikanth235/centraid/issues/915)'s checklist, in
its order, across all five waves.

### Wave 0 — stop the bleeding (target: one week)

- [x] Run `e2e.yml` against the last green `main` SHA instead of the tip (interim: a `workflow_dispatch` input, or read the SHA from the last green `ci.yml` run)
- [x] Park `mobile-e2e-android` and `mobile-e2e-ios` in `tests/lane-quarantine.json` with a 14-day expiry against #870 and #864
- [x] Replace the daily `nightly-failure-issue` job with one rolling issue per lane (update in place; never re-create) and close the open "[nightly] e2e lane red — tracking" issues into it
- [x] Compute the nightly verdict over unparked lanes only; render parked lanes as parked with their expiry
- [x] Fix #870 (Android home-app journeys never see home) — the one product bug in the pile
- [x] Add `web-e2e-cross-browser` to `test-health-report.needs` and the failure-issue path once it has one green run on a candidate
- [ ] **Exit:** the published nightly verdict reads something other than RED for the first time since 2026-08-03

### Wave 1 — the candidate pointer and the merge diet (target: two weeks)

- [x] Add a `candidate.yml` workflow on `push: main` that runs: the current `mobile-canary` Android roster, desktop Playwright (Linux), `desktop-e2e-macos`, `lane-gateway-package`, full mutation with floors, CodeQL + Rust supply chain
- [x] On green, move `refs/candidates/latest` and write `artifacts/candidate.json` (`sha`, `promotedAt`, `previousSha`); on red, leave the pointer and update the lane's rolling issue
- [x] Point `e2e.yml`, `soak-weekly.yml`, `interop-weekly.yml`, `enrichment-live-weekly.yml`, and `release.yml` at the candidate; `release:classify` refuses a SHA that is not a candidate
- [x] Remove `client-e2e / desktop-e2e`, `desktop-e2e-macos`, `gateway-package`, and the `mobile-device-gate` resilience leg from `check.needs` in `ci.yml` (they now gate promotion, not merge)
- [x] Reduce `mobile-device-gate` to one leg (pairing canary, one home-app journey, cold start) with an 8-minute warm budget; a cold cache is a named lane failure, not a 60-minute wait
- [x] Add a **new-test burn-in** lane: every added or modified `*.test.*` / `*.spec.*` file in the diff runs 3× in isolation; any disagreement is red
- [x] Cap `mutation-pr` at 8 minutes of affected seeds; over the cap it defers to rung 3 and comments on the PR
- [x] Diagnose and fix the ~4.5-minute `build:ci` remote-cache miss recorded in `ci.yml` (five lanes pay it)
- [x] Move `security.yml` CodeQL and Rust supply chain off the weekly cron onto rung 3
- [x] Ratchet the rung 2 budget: add a `pr-gate` wall-clock ceiling (15 min p95) to the suite wall-clock mechanism
- [x] Extend `scripts/ci/lane-health.mjs` to compute pass rate on candidates, escapes, and consecutive reds, and to apply the demote / promote / park rules above
- [ ] **Exit:** PR gate p95 ≤ 15 min over 20 runs; promotion rate is measured and published

### Wave 2 — mobile builds and the single roster (target: three weeks)

- [x] Cache the iOS simulator `.app` keyed by the native fingerprint (`apps/mobile/native-fingerprints.json` + `verify-native-state.mjs`); build only when the fingerprint changes
- [x] Inject the JS bundle for the SHA under test into the cached iOS shell (the "pay packaging, not compilation" path the Android gate already uses)
- [x] Add `mobile-ios-smoke` to rung 3: pairing canary, cold start, one home-app journey on the pinned simulator, ≤ 10 min warm
- [x] Collapse the seven `tests/agent-e2e-mobile/run-*-suite.mjs` runners into one `roster.json` (flow, platform, rungs, budgetMs, claim) and one runner taking `--rung` and `--platform`
- [x] Point `check-mobile-suite-budgets.mjs`, `lint-mobile-testids.mjs`, `lint-e2e-wiring.mjs`, `lint-e2e-claims.mjs`, and the report at the single roster
- [x] Move the Android resilience leg and probes, and the iOS-only claims (`run-ios-depth-suite`), onto rungs 3 and 4 per the roster tags
- [x] Grow `tests/integration-mobile` to cover every app × designed state cell the matrix declares (it is the workhorse; state variety never goes to a device)
- [x] Raise `mobile-alarm-test.yml` from quarterly to monthly (weekly once the roster is single-sourced)
- [ ] **Exit:** every candidate carries an iOS verdict; device minutes per PR ≤ 8 Android, 0 iOS

### Wave 3 — Night Watch v2 (target: two weeks)

**Data layer**

- [x] One evidence writer (`scripts/test-report/write-evidence.mjs`): every lane on every rung emits `artifacts/evidence/.json` with `lane, rung, platform, candidate, startedAt, finishedAt, verdict ∈ {passed, failed, parked, no-evidence}, budgetMs, durationMs, cases[{id, verdict, durationMs, attempts}], parked{until, issue}|null, tags{qualities[], surfaces[]}`; the schema is validated on write and on read
- [x] `artifacts/candidate.json` (from Wave 1) and the previous night's evidence directory are inputs, so every delta is computed candidate-to-candidate
- [x] Replace `tests/matrix.json` with `tests/claims.json` holding only what a machine cannot derive: laws, consent ledger layers, join laws, deliberate n/a cells with reasons, revisit triggers, severity per claim; owners, flows, journeys, budgets, seeds, engines, and fuzz targets are derived from the roster, the Vitest projects, the Stryker configs, `scripts/fuzz/targets.mjs`, and the engine registry; keep and shorten the validators that pin report rows to code
- [x] A lane that declares `tags.qualities × tags.surfaces` but writes no evidence renders **no evidence** in every cell it claims; "unmapped evidence" (a file naming no claim) becomes a rung-2 lint failure, not a report banner
- [x] Cell vocabulary is exactly passed / failed / parked / no-evidence plus n/a-with-reason; the 45-gate user-facing qualities panel retires into the claims file

**Page, in order (numbers are the mockup's sections)**

- [x] **§0 Masthead + verdict lamp.** Night, candidate SHA and promotion time, evidence age, minutes used of the 90 budget, links to the Actions run, previous night, and the immutable dated copy. Verdict `HOLD | DEGRADED | SHIPPABLE` computed over unparked lanes (HOLD: any S1/S2 red, > 3 parks, or a park > 30 d; DEGRADED: S3/S4 reds or an out-of-band series), one sentence of why, the delta line, and the single change that would flip the verdict
- [x] **§1 Blockers.** S1 and S2 only; per row: lane · case, platform, first-red candidate, last-green candidate, owner (or "unowned — claim"), age vs the 24 h owned-SLA, issue
- [x] **§2 Since yesterday.** Six columns: new red, new green, newly parked, park expiring within 7 d, series outside their noise band, lanes over 80 % of budget with a rising p95
- [x] **§3 Attention queue.** One row per lane, oldest first: severity, state pill, owner, age, concrete deadline (owned-by, fix-or-park-by, park expiry, or revisit trigger), rolling issue; iOS and Android are always separate rows
- [x] **§4 Lane health board.** Every lane on rungs 2–5: tonight's verdict and duration, 30-run history sparkline on candidates (pass / fail / parked / not run), pass rate with the demote flag below 99 % on rung 2, p95 vs budget bar, last-green SHA, gating / advisory / parked status; filter chips by rung, platform, and needs-attention; name search; click-to-expand cases; keys `/`, `e`, `?`
- [x] **§5 Journeys.** Every flow from the single roster (Wave 2), grouped by suite with the suite's tighten-only budget, per-flow cost vs flow budget, attempts, claim; parked suites show the park inline; a suite budget > 1.5× observed p95 is flagged with the number to lower to; the alarm's last sounding and next date sit above the table
- [x] **§6 Coverage grid.** App × platform with three modes: rung proven (2/3/4, gap in red, n/a with reason), designed states (d p o s c k n owned in the Linux suite), scenarios by verb (create / read / update / delete / share counts, zeros in red with reason)
- [x] **§7 Promises × surfaces.** 11 qualities × 10 surfaces as the join of lane tags with tonight's verdicts; four states plus n/a; each cell names its backing lane; footer counts
- [x] **§8 Adversaries.** Mutation seeds with score vs floor and survivors, all fuzz targets with execs / corpus / new / known, engine registry with property-flow owner or "no owner" per engine
- [x] **§9 Trends.** A series appears only at ≥ 14 candidates, drawn with its trailing-30 interquartile band and an emphasized endpoint; "No trend yet" is removed; the set is iOS and Android cold start, gateway p99, large-vault open p95, PR-gate p95, backup throughput, plus any rig that reaches 14 points
- [x] **§10 Evidence (collapsed).** Coverage floors with sustained-headroom ratchet candidates, full consent ledger (8 layers, seats covered), join laws (10, kind, seats, cases), inventory (skips, env-red, sleeps, quarantine), parks ledger, field observations from QUALITY.md with age and a 60-day rung-5 red
- [x] **§11 How to read this.** Glossary of every state, severity, and column, plus the `evidence.json` contract

**Wiring**

- [x] `generate.mjs` becomes a pure function of the evidence directory + claims file + previous night; split the reader from the renderer so each is testable; `report:smoke` asserts every section renders from the fixture root
- [x] The rolling per-lane issue (Wave 0) is written from the same attention-queue model, so the issue body and §3 never disagree
- [x] Publish as today (mutable `nightly/` alias + immutable `nightly/runs/-/`), and additionally emit `summary.json` (verdict, blockers, deltas) for the job summary and the release lane
- [x] Update TESTING.md's report section, docs/decisions.md (three-question page supersedes the evidence-archive design of #862), and the `validate-report-registries` tests
- [x] **Exit:** the first screen fits a laptop viewport without scrolling and names every blocker with an owner and an age; every tab of the current report has a home in the new one (checklist above); `report:smoke` is green from the fixture root

### Wave 4 — gate and ledger diet (rolling)

- [x] Classify every gate in `check:push` as **product** (rungs 1–4), **contract** (rung 2; bundled into one `lint:product` at rung 1 where each runs < 1 s), or **hygiene** (rung 5)
- [x] Move hygiene ratchets (`test:comment-density`, `test:sleep-inventory`, `test:hygiene-ratchet`, skip and env-red budgets, `lint:type-floor`, `lint:schema-export`) to a weekly `hygiene.yml` with one rolling issue
- [x] Move the two ~32 s vendored governance directives from pre-commit to pre-push so rung 0 is ≤ 5 s
- [x] Trim `check:push` to ≤ 25 gate names, wall clock still bounded by `test:affected`
- [x] Merge the 20 ledgers into `tests/floors.json` (coverage, mutation, minimumTests; up-only), `tests/budgets.json` (suite wall clock, rung budgets, quality rigs, experience, design-token CSS, mobile suites; down-only), `tests/inventory.json` (skips, env-red, sleeps, hygiene, comment density, n/a cells, advisory; down-only with issue + expiry), `tests/quarantine.json` (tests + lane parks; down-only with expiry) — one validator, same tighten-only semantics
- [x] Update TESTING.md, docs/dev-environment.md (the gate loop table), docs/decisions.md, and the CONSTITUTION's `coverage-scope-reachability` enforcing tests to the new files
- [x] Retire `scripts/ci/retry.mjs` (no callers) and `tests/helpers/factories.ts#buildTestGateway` (no callers); fix the stale TESTING.md reference to `golden-vault.test.ts`
- [ ] Give `governance.yml` a `timeout-minutes` and confirm its `pull_request` listener is an allowlisted exception to `lint-workflow-pins` rule 5
- [x] **Exit:** four ledger files; ≤ 25 pre-push gates; the constitution's tighten-only test passes against the new files

Four items stay unchecked, and each needs a live run on `main` that no receipt
can stand in for. Wave 0's, Wave 1's and Wave 2's exits are read off the lane
health board once the pointer exists: the first nightly verdict, the PR-gate p95
over 20 runs with the promotion rate beside it, and the first candidate carrying
an iOS verdict. Wave 4's `governance.yml` item is unchecked for a different
reason — half of it is impossible in this tree and the other half was already
true; both halves are recorded under `## Decisions` and `## Out of scope`.

## What prompted it

The issue's own evidence table, dated 2026-09-02: zero green nightly `e2e.yml`
runs in the 30 days to 2026-09-01, a PR gate observed at ~26 minutes against a
documented 12.3, 59 gates in `check:push`, a 252 KB hand-maintained
`tests/matrix.json`, 20 tighten-only JSON ledgers, zero green recent main-push
`mobile-canary.yml` runs, and 13+ auto-filed nightly tracking issues closed as
noise. The diagnosis it draws from them is that the doctrine is sound and the
machinery has outgrown the signal it produces — a gate red every night carries
no information, the primary platform has the weakest signal, the PR gate is
heavy in the wrong places, meta-quality crowds out product quality, and nothing
marks a known-good build.

## What changed

Organised by wave; each bullet opens with the checklist item it realizes.

### Wave 0 — stop the bleeding (target: one week)

- **Run `e2e.yml` against the last green `main` SHA instead of the tip (interim: a `workflow_dispatch` input, or read the SHA from the last green `ci.yml` run)** — `.github/workflows/e2e.yml` gains a first `resolve-candidate` job and a `ref` dispatch input; all 20 product checkouts take `ref: ${{ needs.resolve-candidate.outputs.sha }}`, the two gh-pages checkouts are untouched, and both gradle cache keys move off `github.sha`. `scripts/ci/resolve-candidate.mjs` (with `scripts/ci/resolve-candidate.test.mjs`) resolves `refs/candidates/latest`, falls back to the last green `ci.yml` run's head SHA on `main`, then to `github.sha`, and prints which link of the chain fired to the step summary.

- **Park `mobile-e2e-android` and `mobile-e2e-ios` in `tests/lane-quarantine.json` with a 14-day expiry against #870 and #864** — Both lanes are parked with `expires: 2026-09-16`. `#864` is closed, so it cannot hold a park: both entries name issue 870 and the `why` line carries #864's M16 finding. `tests/lane-quarantine.json` is where the parks were written and is retired later in the same change — Wave 4 merges it into `tests/quarantine.json#lanes`, which is the file the parks live in today. `scripts/ci/lane-health.mjs` and `scripts/ci/lane-rules.mjs` read them.

- **Replace the daily `nightly-failure-issue` job with one rolling issue per lane (update in place; never re-create) and close the open "[nightly] e2e lane red — tracking" issues into it** — `scripts/ci/file-tracking-issue.mjs` gains `--update` (exact-title match, `gh issue edit`, create only when none is open) with cases in `scripts/ci/file-tracking-issue.test.mjs`; `.github/workflows/e2e.yml`'s `nightly-failure-issue` becomes `nightly-lane-issues`, looping the needs graph through jq. The body comes from `scripts/test-report/rolling-issue-body.mjs` — the same attention-queue model the report renders — and falls back to `scripts/ci/rolling-issue-fallback-body.mjs` (`scripts/ci/rolling-issue-fallback-body.test.mjs`) when the report or its `summary.json` is absent. A one-shot `close-legacy-tracking` dispatch input closes the legacy tracking issues with a pointer to their replacements.

- **Compute the nightly verdict over unparked lanes only; render parked lanes as parked with their expiry** — `scripts/test-report/write-evidence.mjs` stamps `verdict: parked` on a failed run of a lane with an unexpired park, so the park is a property of the evidence rather than of the renderer. `scripts/test-report/model/lanes.mjs`, `scripts/test-report/model/severity.mjs` and `scripts/test-report/model/attention.mjs` compute the lamp over unparked lanes; `scripts/test-report/render/masthead.mjs` and `scripts/test-report/render/lane-board.mjs` draw a parked lane as parked with its expiry and issue. `scripts/test-report/collect.mjs` and `scripts/test-report/read-model.mjs` are the reader half.

- **Fix #870 (Android home-app journeys never see home) — the one product bug in the pile** — **The product-side fix is not in this change.** The seeding-order fix landed on `main` in `0a3258e3` (#905/#907) before this branch existed; what this change adds is the harness half — the missing `shQuote` import, the `harness` failure class, `AWAIT_LAUNCHER` with RULE `launcher-await`, and oxlint's `no-undef` over the e2e harness — plus the lane park, and the confirmation run on the fixed tree is still pending. In detail: the root cause is closed and it is not a phone defect: the nightly the issue cites (`e2e` run 33498199941, sha `f5ca34fb64`) ran a tree whose `apps/mobile/scripts/android-emulator-install.sh` seeded the demo corpus AFTER the phone had cloned, so every replica read settled empty, Home rendered its day-one branch, and twelve journeys failed at their first launcher tile. That seeding order landed on `main` in `0a3258e3` (#905/#907), and its first device run — `ci.yml` run 33589902587 — is green on both `mobile-device-gate` legs. Three further harness defects found in the same logs are fixed here: `tests/agent-e2e-mobile/flows/share-intent-in.mjs` was missing its `shQuote` import; `tests/agent-e2e-mobile/lib/failure-class.mjs` (with `tests/agent-e2e-mobile/lib/failure-class.test.mjs`) grows a third `harness` class so a flow crash is no longer reported as a broken product; and `AWAIT_LAUNCHER` now guards every chunk that taps a launcher tile — `tests/agent-e2e-mobile/flows/agenda-week.mjs`, `tests/agent-e2e-mobile/flows/docs-drive.mjs`, `tests/agent-e2e-mobile/flows/locker-gate.mjs`, `tests/agent-e2e-mobile/flows/op-sqlite-probe.mjs`, `tests/agent-e2e-mobile/flows/people-roster.mjs`, `tests/agent-e2e-mobile/flows/photos-library.mjs`, `tests/agent-e2e-mobile/flows/photos-search.mjs`, `tests/agent-e2e-mobile/flows/photos-select-write.mjs`, `tests/agent-e2e-mobile/flows/photos-viewer.mjs`, `tests/agent-e2e-mobile/flows/places-seat.mjs`, `tests/agent-e2e-mobile/flows/scroll-frames.mjs`, `tests/agent-e2e-mobile/flows/sharing-reach.mjs`, `tests/agent-e2e-mobile/flows/tally-derived.mjs` and `tests/agent-e2e-mobile/flows/tasks-board.mjs` — with RULE `launcher-await` in `scripts/lint-e2e-flows.mjs` making it mechanical, and `oxlint.config.ts` enabling `no-undef` over the e2e harness so the `shQuote` class of defect cannot return. **The confirmation run is pending and the lane park stands until it is green**: the rung-3 and rung-4 Android rosters have not run on the fixed tree, so the fourteen journeys other than `pairing-canary`, `notes-library`, `native-v0-resilience` and `cold-start` are fixed by inference. After this wave merges, `gh workflow run candidate.yml --ref main` and `gh workflow run e2e.yml --ref main -f suite=mobile`, then check that no journey fails at `AWAIT_LAUNCHER` (`id: home-grid`); #870 closes on that run, not on this receipt.

- **Add `web-e2e-cross-browser` to `test-health-report.needs` and the failure-issue path once it has one green run on a candidate** — The lane is in both `test-health-report.needs` and `nightly-lane-issues.needs` in `.github/workflows/e2e.yml`. "Once it has one green run" is mechanical rather than manual: the lane is parked (`issue: 915`, `expires: 2026-09-16`, `why: first green on a candidate is the baseline`), so it renders parked and files no rolling issue until its first green promotes it out of the park.

Also in this wave: `.github/workflows/ci.yml` and `.github/workflows/e2e.yml`
grow the `id: start` step every evidence step reads, and
`scripts/test-report/read-evidence.mjs` is the reader that turns a directory of
lane files into the night's model.

### Wave 1 — the candidate pointer and the merge diet (target: two weeks)

- **Add a `candidate.yml` workflow on `push: main` that runs: the current `mobile-canary` Android roster, desktop Playwright (Linux), `desktop-e2e-macos`, `lane-gateway-package`, full mutation with floors, CodeQL + Rust supply chain** — `.github/workflows/candidate.yml` is the new rung-3 workflow: `mobile-canary-android` (the roster moved verbatim out of the deleted `.github/workflows/mobile-canary.yml`, all three caches intact), two `lane-client-e2e.yml` calls reporting as `web-e2e-linux` and `desktop-e2e-linux`, `desktop-e2e-macos`, `lane-gateway-package`, `mutation-full` with floors, `codeql` and `rust-supply-chain`, plus `mobile-ios-smoke` (Wave 2) and a `promote` job. Every lane carries the evidence step of contract C2.

- **On green, move `refs/candidates/latest` and write `artifacts/candidate.json` (`sha`, `promotedAt`, `previousSha`); on red, leave the pointer and update the lane's rolling issue** — `scripts/ci/write-candidate.mjs` (with `scripts/ci/write-candidate.test.mjs`) writes the pointer document; `candidate.yml`'s `promote` job force-updates the ref, uploads `candidate.json`, merges it into the gh-pages tree at `test-report/candidate.json`, appends `{sha, promotedAt}` to a capped `test-report/candidates.json` history, and writes evidence for the three reusable-workflow lanes that have no `steps:` of their own. A red leaves the ref where it is and updates the lane's rolling issue through the same `file-tracking-issue.mjs --update` path.

- **Point `e2e.yml`, `soak-weekly.yml`, `interop-weekly.yml`, `enrichment-live-weekly.yml`, and `release.yml` at the candidate; `release:classify` refuses a SHA that is not a candidate** — `.github/workflows/soak-weekly.yml`, `.github/workflows/interop-weekly.yml` and `.github/workflows/enrichment-live-weekly.yml` each gain the same `resolve-candidate` job, `ref` input and parameterised checkouts as `e2e.yml`; `.github/workflows/release.yml` gains a `require-candidate` job backed by `scripts/release/candidate-guard.mjs` and `scripts/release/candidate-guard.test.mjs`. The refusal is mandatory in `scripts/release/prepare.mjs` (which is what a human runs) and opt-in in `scripts/release/classify.mjs` behind `--require-candidate [--sha]`, because classify is a pure CHANGELOG read with no SHA of its own; `scripts/release/publish-guards.test.mjs` covers both. `docs/release.md` states the rule.

- **Remove `client-e2e / desktop-e2e`, `desktop-e2e-macos`, `gateway-package`, and the `mobile-device-gate` resilience leg from `check.needs` in `ci.yml` (they now gate promotion, not merge)** — `.github/workflows/ci.yml` drops `client-e2e`, `gateway-package`, `desktop-e2e-macos` and `mutation-canary` as jobs and out of `check.needs`; the resilience leg leaves with the device gate's matrix and `apps/mobile/scripts/android-emulator-pr-gate-resilience.sh` is deleted. `lane-client-e2e.yml` and `lane-gateway-package.yml` are untouched and stay `workflow_call`-only — `candidate.yml` is now their caller. `gitleaks` and `osv-scanner` stay in `check.needs`, and the `changes` job is byte-exact so `lint:path-filters` still holds.

- **Reduce `mobile-device-gate` to one leg (pairing canary, one home-app journey, cold start) with an 8-minute warm budget; a cold cache is a named lane failure, not a 60-minute wait** — `ci.yml`'s `mobile-device-gate` loses its matrix and runs `apps/mobile/scripts/android-emulator-pr-gate.sh` directly with `timeout-minutes` cut 60 → 20 and an evidence budget of 480,000 ms; the script's `pr-gate` suite is `pairing-canary`, `notes-library` and `cold-start`. A cold cache fails the job with `::error title=mobile-device-gate cold cache::` and an evidence case `cold-cache` before any build starts.

- **Add a **new-test burn-in** lane: every added or modified `*.test.*` / `*.spec.*` file in the diff runs 3× in isolation; any disagreement is red** — `scripts/ci/burn-in.mjs` (six `node:test` cases in `scripts/ci/burn-in.test.mjs`) diffs against the merge base, runs each touched test file three times from its owning package, and reds on disagreement or on failure; Playwright and Maestro files are skipped with a printed reason and "nothing to burn in" is a success. The `new-test-burn-in` job in `ci.yml` is in `check.needs` and checks out with `fetch-depth: 0`.

- **Cap `mutation-pr` at 8 minutes of affected seeds; over the cap it defers to rung 3 and comments on the PR** — `scripts/ci/mutation-cap.mjs` (`scripts/ci/mutation-cap.test.mjs`, six cases) enforces an 8-minute default cap (`MUTATION_PR_CAP_MS`), escalates SIGTERM to SIGKILL, prints `::notice::mutation-pr deferred to rung 3`, posts a deduplicated PR comment behind a marker, records an evidence case `deferred` and exits 0 — the deferral is a hand-off to `candidate.yml`'s `mutation-full`, not a red.

- **Diagnose and fix the ~4.5-minute `build:ci` remote-cache miss recorded in `ci.yml` (five lanes pay it)** — Two causes, both fixed: `turbo.json`'s `build.inputs` admitted test files into the build hash (one appended line in a `packages/core` test moved 11 of 16 build hashes; after the fix it moves none), and `coverage-shard`/`coverage` in `ci.yml` were missing the `cargo-cache: verify` input the other lanes pass. The floor is enforced rather than assumed: `scripts/ci/turbo-floor.mjs` (`scripts/ci/turbo-floor.test.mjs`) runs behind the new `build:ci:floored` script in `package.json` and fails a lane under a 0.15 hit rate, downgrading to a named warning only when the diff touches a computed global-hash input. No flag turns the floor off.

- **Move `security.yml` CodeQL and Rust supply chain off the weekly cron onto rung 3** — `codeql` and `rust-supply-chain` are jobs of `.github/workflows/candidate.yml`; `.github/workflows/security.yml` is deleted because nothing else lived in it. `scripts/security/egress-ledger.json` drops the retired `mobile-canary.yml` entry (it never had a `security.yml` key) and `SECURITY.md`'s two rows are re-pointed at the candidate lane.

- **Ratchet the rung 2 budget: add a `pr-gate` wall-clock ceiling (15 min p95) to the suite wall-clock mechanism** — The `pr-gate` lane enters the suite wall-clock ledger at 900,000 ms — written into `tests/suite-wall-clock.json` and now held in `tests/budgets.json#suiteWallClock` — and `scripts/ci/pr-gate-wall-clock.mjs` (`scripts/ci/pr-gate-wall-clock.test.mjs`) enforces it inside `check` with `actions: read`. Tighten-only comes free: `scripts/test-report/ratchet-floors.mjs` already flattens every `budgetMs` in that source, so a widen fails without an approved deviation.

- **Extend `scripts/ci/lane-health.mjs` to compute pass rate on candidates, escapes, and consecutive reds, and to apply the demote / promote / park rules above** — The rules table is `scripts/ci/lane-rules.mjs` (new) and `scripts/ci/lane-health.mjs` grows `--rung`, `--escape-workflow`, and findings plus a `verdict`/`reasons` block in its summary JSON; `scripts/ci/lane-health.test.mjs` carries 21 cases. It runs in `candidate.yml` after `promote` and in `e2e.yml`'s existing lane-health job. Only `park-expired`, `over-budget` and `park-required` red the lane — a demote or promote files an issue, because reding the nightly for advice is the disease this issue treats.

### Wave 2 — mobile builds and the single roster (target: three weeks)

- **Cache the iOS simulator `.app` keyed by the native fingerprint (`apps/mobile/native-fingerprints.json` + `verify-native-state.mjs`); build only when the fingerprint changes** — `apps/mobile/scripts/ios-shell-cache.mjs` is the pure decision helper (build / inject / install), with seven cases in `apps/mobile/scripts/ios-shell-cache.test.mjs`, and `apps/mobile/scripts/ios-simulator-install.sh` is the step that runs it. The cache key in `.github/workflows/e2e.yml`'s `mobile-e2e-ios` drops its `js` component and is now `ios-shell-<os>-xc<toolchain>-fp<native>`, restore-then-save with the save under `if: always()` so a red lane still banks the shell. There are no `restore-keys`: a partial match is the stale-binary false pass this must never allow.

- **Inject the JS bundle for the SHA under test into the cached iOS shell (the "pay packaging, not compilation" path the Android gate already uses)** — `ios-simulator-install.sh` re-exports this SHA's bundle into the restored `.app` and re-signs it rather than compiling; `docs/traps/ios-shell-injection.md` records the trap found while building it — `expo export:embed` emits SOURCE, not Hermes bytecode, so the injected bundle must be compiled to bytecode before it goes into a Release shell.

- **Add `mobile-ios-smoke` to rung 3: pairing canary, cold start, one home-app journey on the pinned simulator, ≤ 10 min warm** — The `ios-smoke` suite is `pairing-canary` + `cold-start` + `notes-library` in `tests/agent-e2e-mobile/roster.json`, run by `apps/mobile/scripts/ios-simulator-smoke.sh` with a 600,000 ms budget documented in `tests/agent-e2e-mobile/flows/ios-smoke-budget.md`. The `mobile-ios-smoke` job in `.github/workflows/candidate.yml` is in `promote.needs`, so a candidate cannot be promoted without an iOS verdict; it selects Xcode with `e2e.yml`'s version-scanning loop rather than a hard-coded patch version.

- **Collapse the seven `tests/agent-e2e-mobile/run-*-suite.mjs` runners into one `roster.json` (flow, platform, rungs, budgetMs, claim) and one runner taking `--rung` and `--platform`** — `tests/agent-e2e-mobile/roster.json` gains `suites`, `rungs`, `platform`, `budgetMs`, `claim` and per-lane `rung`; `tests/agent-e2e-mobile/lib/roster.mjs` is the one reader (21 cases in `tests/agent-e2e-mobile/lib/roster.test.mjs`) and `tests/agent-e2e-mobile/run-roster.mjs` the one runner. All seven runners are gone — `tests/agent-e2e-mobile/run-pr-gate-suite.mjs`, `run-pr-gate-resilience-suite.mjs`, `run-ios-depth-suite.mjs`, `run-photos-suite.mjs`, `run-home-apps-suite.mjs`, `run-probes-suite.mjs` and `run-promoting-suite.mjs` — first reduced to literal-free shims and then deleted once every caller moved. `flows[].suite` is an array because a flow belongs to several suites and per-suite order is load-bearing; `suites[id].flows` is the ordered list and `validateRoster` fails when the two disagree.

- **Point `check-mobile-suite-budgets.mjs`, `lint-mobile-testids.mjs`, `lint-e2e-wiring.mjs`, `lint-e2e-claims.mjs`, and the report at the single roster** — `scripts/check-mobile-suite-budgets.mjs` reads the roster's suite budgets with a `supersedes`-aware merge-base read so a rename cannot launder a ceiling (`scripts/check-mobile-suite-budgets.test.mjs`, six cases); `scripts/lint-mobile-testids.mjs` and `scripts/lint-e2e-claims.mjs` cross-check the roster against disk discovery rather than replacing it; `scripts/lint-e2e-wiring.mjs` reads the roster and the derived claims view, and — having crossed the file-size ceiling — is split by question into `scripts/lint-e2e-wiring.reach.mjs` (parsers, selectors, reach resolution) and `scripts/lint-e2e-wiring.rules.mjs` (RULE `state-variety`, RULE `corpus`), with `scripts/lint-e2e-wiring.cases.mjs` and `scripts/lint-e2e-wiring.test.mjs` following. On the report side `scripts/test-report/validate-report-registries.mjs` and its test read `roster.json#suites` through `plan()` instead of regexing runner literals, and `scripts/test-report/validate-nightly-wiring.mjs` (with `scripts/test-report/validate-nightly-wiring.test.mjs`) pins `run-roster.mjs`.

- **Move the Android resilience leg and probes, and the iOS-only claims (`run-ios-depth-suite`), onto rungs 3 and 4 per the roster tags** — The roster tags `resilience` rung 3 and `probes-suite`, `photos`, `sharing`, `promoting-suite` and `ios-depth` rung 4; `home-apps` carries rungs 3 and 4 so a merge keeps per-candidate attribution. `apps/mobile/scripts/android-emulator-canary.sh` is the new rung-3 entry point, `apps/mobile/scripts/android-emulator-roster.sh` runs `--rung 4 --platform android`, `apps/mobile/scripts/android-emulator-pr-gate.sh` runs the three-member `pr-gate` suite and `apps/mobile/scripts/android-emulator-install.sh` no longer names the deleted `mobile-canary.yml`. The budget docs move with them: `tests/agent-e2e-mobile/flows/pr-gate-budget.md`, `tests/agent-e2e-mobile/flows/probes-budget.md`, `tests/agent-e2e-mobile/flows/photos-budget.md`, `tests/agent-e2e-mobile/flows/home-apps-budget.md`, `tests/agent-e2e-mobile/flows/promoting-budget.md`, `tests/agent-e2e-mobile/flows/ios-depth-budget.md`, the new `tests/agent-e2e-mobile/flows/sharing-budget.md`, plus `tests/agent-e2e-mobile/flows/sharing-reach.md`, `tests/agent-e2e-mobile/flows/native-v0-resilience.md` and `tests/agent-e2e-mobile/flows/cold-start.mjs`, whose claim lines are now byte-identical to the roster's, and `tests/agent-e2e-mobile/README.md`, which states the one-runner shape.

- **Grow `tests/integration-mobile` to cover every app × designed state cell the matrix declares (it is the workhorse; state variety never goes to a device)** — **No test was added here: the cover was re-derived and found already complete** — 56 cells, 52 arranged by the suite's own tests and 4 held by the blocker assertion in `tests/integration-mobile/parked.integration.test.ts`, so no cell was uncovered to grow into. The re-derivation is the evidence: the grid was recomputed from `packages/blueprints/apps/*/app.json#states` rather than trusted from a README, and the recount is recorded in `tests/integration-mobile/README.md`: the grid is 56 cells — 52 arranged, 4 covered by the blocker assertion in `tests/integration-mobile/parked.integration.test.ts`, 0 skipped and 0 n/a — so the cover is complete and no cell needed a new test. The four parked cells are a product fact, not deferred work: the assertion is computed from the shipped vault registry and goes red the day a parking path exists. `tests/integration-mobile/README.md` states the derivation, and RULE `state-variety` in `scripts/lint-e2e-wiring.rules.mjs` now fails any state cell whose owner is a Maestro flow, so state variety cannot drift back onto a device.

- **Raise `mobile-alarm-test.yml` from quarterly to monthly (weekly once the roster is single-sourced)** — The roster is single-sourced in this same wave, so `.github/workflows/mobile-alarm-test.yml` goes straight to weekly (`0 3 * * 0`, Sunday 03:00 UTC, before the 04:00 slot) with its pins, timeout, harden-runner and inverted verdict unchanged. Its `alarm` lane now writes evidence, and that evidence is deliberately the inverted verdict: the job succeeds exactly when the alarm sounded.

### Wave 3 — Night Watch v2 (target: two weeks)

#### Data layer

- **One evidence writer (`scripts/test-report/write-evidence.mjs`): every lane on every rung emits `artifacts/evidence/.json` with `lane, rung, platform, candidate, startedAt, finishedAt, verdict ∈ {passed, failed, parked, no-evidence}, budgetMs, durationMs, cases[{id, verdict, durationMs, attempts}], parked{until, issue}|null, tags{qualities[], surfaces[]}`; the schema is validated on write and on read** — `scripts/test-report/write-evidence.mjs` is the only writer and `scripts/test-report/evidence-schema.mjs` validates on both sides — `scripts/test-report/read-evidence.mjs` re-validates what it reads, and `scripts/test-report/evidence-contract.test.mjs` pins the shape. Every rung-2 lane in `ci.yml`, every rung-3 lane in `candidate.yml`, every rung-4 lane in `e2e.yml` and the five rung-5 lanes in `soak-weekly.yml`, `interop-weekly.yml`, `enrichment-live-weekly.yml`, `mobile-alarm-test.yml` and `hygiene.yml` carry the `Write lane evidence` step with `--verdict auto --job-status`.

- **`artifacts/candidate.json` (from Wave 1) and the previous night's evidence directory are inputs, so every delta is computed candidate-to-candidate** — `scripts/test-report/collect.mjs` takes `--candidate` and `--evidence-previous`; `e2e.yml`'s report job stages `artifacts/candidate.json` from the gh-pages `test-report/candidate.json` and `artifacts/evidence-previous/` from the newest immutable run before calling the generator, and `scripts/test-report/prepare-pages-site.mjs` publishes each night's `evidence/` into the dated slot so the next night has a previous one. Absence of either is a warning, never a failure — the first night after this lands has no predecessor.

- **Replace `tests/matrix.json` with `tests/claims.json` holding only what a machine cannot derive: laws, consent ledger layers, join laws, deliberate n/a cells with reasons, revisit triggers, severity per claim; owners, flows, journeys, budgets, seeds, engines, and fuzz targets are derived from the roster, the Vitest projects, the Stryker configs, `scripts/fuzz/targets.mjs`, and the engine registry; keep and shorten the validators that pin report rows to code** — `tests/matrix.json` and `tests/matrix.schema.json` are deleted and `tests/claims.json` replaces them; `tests/na-cells.json` is absorbed into `claims.naCells` and deleted, with `scripts/audit-na-cells.mjs` keeping the 183-day re-verification ritual. `scripts/test-report/derive.mjs` (`scripts/test-report/derive.test.mjs`) derives journeys, budgets, seeds, engines and fuzz targets, and `scripts/test-report/derive-flows.mjs` is the single derived flow view the constitution's `coverage-scope-reachability` check and the linters read. The validators shrank rather than multiplied: `scripts/test-report/validate-matrix.mjs` (622 lines) and its test are replaced by `scripts/test-report/validate-claims.mjs` (145) with `scripts/test-report/claims-schema.mjs`, `scripts/test-report/matrix-fixture.mjs` becomes `scripts/test-report/claims-fixture.mjs`, and `scripts/test-report/validate-matrix-app-axes.test.mjs` becomes `scripts/test-report/validate-claims-app-axes.test.mjs`. The readers that only moved path are `scripts/check-quality-knobs.mjs`, `scripts/lint-law-registry.mjs` (with `scripts/lint-law-registry.test.mjs`), `scripts/lint-seat-verbs.mjs`, `scripts/test-report/validate-app-scenarios.test.mjs` and `scripts/test-report/validate-citations-open.mjs` (with `scripts/test-report/validate-citations-open.test.mjs`).

- **A lane that declares `tags.qualities × tags.surfaces` but writes no evidence renders **no evidence** in every cell it claims; "unmapped evidence" (a file naming no claim) becomes a rung-2 lint failure, not a report banner** — `buildPromises` in `scripts/test-report/model/grids.mjs` inks a claimed-but-silent cell as `no-evidence`, unit-tested in `scripts/test-report/read-model.test.mjs`; the other direction is `scripts/test-report/lint-evidence-mapping.mjs`, wired as `bun run lint:evidence-mapping` in `package.json`, in `check:push` and as a step of `ci.yml`'s `static` job.

- **Cell vocabulary is exactly passed / failed / parked / no-evidence plus n/a-with-reason; the 45-gate user-facing qualities panel retires into the claims file** — `VERDICTS` in `scripts/test-report/evidence-schema.mjs` and `STATE_WORDS` in `scripts/test-report/render/util.mjs` are the whole vocabulary, asserted in `scripts/test-report/render.test.mjs`; `scripts/test-report/report-state-words.test.mjs` and `scripts/test-report/expected-grey.mjs` are retired with the states they described. The 45 gates are 45 claim rows in `tests/claims.json`, each carrying its family, declared severity and `demonstratedRed`, and `tests/quality/user-facing-qualities.test.ts` reads them there. `scripts/test-report/report-theme.mjs`, `report-theme.test.mjs`, `report-tokens.css` and `scripts/test-report/report-theme.test.mjs`, `scripts/test-report/report-tokens.css` and `scripts/site-tokens.mjs` rename the `flaky` tone family to `park`, so one hue means one thing.

#### Page, in order

- ****§0 Masthead + verdict lamp.** Night, candidate SHA and promotion time, evidence age, minutes used of the 90 budget, links to the Actions run, previous night, and the immutable dated copy. Verdict `HOLD | DEGRADED | SHIPPABLE` computed over unparked lanes (HOLD: any S1/S2 red, > 3 parks, or a park > 30 d; DEGRADED: S3/S4 reds or an out-of-band series), one sentence of why, the delta line, and the single change that would flip the verdict** — `scripts/test-report/render/masthead.mjs` over the verdict computed in `scripts/test-report/model/severity.mjs`.

- ****§1 Blockers.** S1 and S2 only; per row: lane · case, platform, first-red candidate, last-green candidate, owner (or "unowned — claim"), age vs the 24 h owned-SLA, issue** — `scripts/test-report/render/questions.mjs`, rows from `scripts/test-report/model/attention.mjs`.

- ****§2 Since yesterday.** Six columns: new red, new green, newly parked, park expiring within 7 d, series outside their noise band, lanes over 80 % of budget with a rising p95** — `scripts/test-report/render/questions.mjs`, computed candidate-to-candidate against the previous night's evidence in `scripts/test-report/read-model.mjs`.

- ****§3 Attention queue.** One row per lane, oldest first: severity, state pill, owner, age, concrete deadline (owned-by, fix-or-park-by, park expiry, or revisit trigger), rolling issue; iOS and Android are always separate rows** — `scripts/test-report/model/attention.mjs` is the model both this section and the rolling issue render; lane identity is the job id, so iOS and Android can never collapse into one row.

- ****§4 Lane health board.** Every lane on rungs 2–5: tonight's verdict and duration, 30-run history sparkline on candidates (pass / fail / parked / not run), pass rate with the demote flag below 99 % on rung 2, p95 vs budget bar, last-green SHA, gating / advisory / parked status; filter chips by rung, platform, and needs-attention; name search; click-to-expand cases; keys `/`, `e`, `?`** — `scripts/test-report/render/lane-board.mjs` over `scripts/test-report/model/lanes.mjs`; the sparkline reads `scripts/test-report/history-point.mjs`, which now carries the candidate and per-lane verdicts.

- ****§5 Journeys.** Every flow from the single roster (Wave 2), grouped by suite with the suite's tighten-only budget, per-flow cost vs flow budget, attempts, claim; parked suites show the park inline; a suite budget > 1.5× observed p95 is flagged with the number to lower to; the alarm's last sounding and next date sit above the table** — `scripts/test-report/render/grids.mjs`, grouped by `plan()` from `tests/agent-e2e-mobile/lib/roster.mjs` so the report and the runner cannot disagree about what a suite is.

- ****§6 Coverage grid.** App × platform with three modes: rung proven (2/3/4, gap in red, n/a with reason), designed states (d p o s c k n owned in the Linux suite), scenarios by verb (create / read / update / delete / share counts, zeros in red with reason)** — `scripts/test-report/render/grids.mjs` over `scripts/test-report/model/grids.mjs`; `scripts/test-report/app-scenario-grid.mjs`, `report-grids.mjs` and their tests are retired into it.

- ****§7 Promises × surfaces.** 11 qualities × 10 surfaces as the join of lane tags with tonight's verdicts; four states plus n/a; each cell names its backing lane; footer counts** — `buildPromises` in `scripts/test-report/model/grids.mjs`. The 11 qualities are the matrix's dimensions unchanged; the 10 surfaces are new and each declares the old ids it `absorbs`, so the n/a register and the workflows' existing `--surfaces` tags still resolve.

- ****§8 Adversaries.** Mutation seeds with score vs floor and survivors, all fuzz targets with execs / corpus / new / known, engine registry with property-flow owner or "no owner" per engine** — `scripts/test-report/render/adversaries.mjs`, fed by `scripts/test-report/derive.mjs` reading the Stryker configs, `scripts/mutation/seeds.mjs` and the fuzz targets.

- ****§9 Trends.** A series appears only at ≥ 14 candidates, drawn with its trailing-30 interquartile band and an emphasized endpoint; "No trend yet" is removed; the set is iOS and Android cold start, gateway p99, large-vault open p95, PR-gate p95, backup throughput, plus any rig that reaches 14 points** — `scripts/test-report/render/index.mjs` draws it from `scripts/test-report/history-point.mjs`; a series under 14 points is a number in §10 instead of an empty chart.

- ****§10 Evidence (collapsed).** Coverage floors with sustained-headroom ratchet candidates, full consent ledger (8 layers, seats covered), join laws (10, kind, seats, cases), inventory (skips, env-red, sleeps, quarantine), parks ledger, field observations from QUALITY.md with age and a 60-day rung-5 red** — `scripts/test-report/render/evidence.mjs`, reading `scripts/test-report/report-floors.mjs`, `scripts/test-report/skip-inventory.mjs`, `scripts/test-report/env-red-inventory.mjs`, `scripts/test-report/sleep-inventory.mjs`, `scripts/test-report/hygiene-ratchet.mjs`, `scripts/test-report/quarantine.mjs` and `QUALITY.md`.

- ****§11 How to read this.** Glossary of every state, severity, and column, plus the `evidence.json` contract** — `scripts/test-report/render/index.mjs`, including the old-tab-to-new-section table asserted by `scripts/test-report/render.test.mjs`.

#### Wiring

- **`generate.mjs` becomes a pure function of the evidence directory + claims file + previous night; split the reader from the renderer so each is testable; `report:smoke` asserts every section renders from the fixture root** — `scripts/test-report/generate.mjs` goes from 1,928 lines to 205 and is now only the CLI shell: `scripts/test-report/collect.mjs` reads, `scripts/test-report/read-model.mjs` is pure, `scripts/test-report/render/index.mjs` and its siblings render. `scripts/test-report/smoke.mjs` is rewritten against a committed fixture root — `scripts/test-report/fixtures/claims.json`, `scripts/test-report/fixtures/candidate.json`, the five lane files `scripts/test-report/fixtures/evidence/static.json`, `scripts/test-report/fixtures/evidence/verify.json`, `scripts/test-report/fixtures/evidence/web-e2e.json`, `scripts/test-report/fixtures/evidence/mobile-e2e-android.json` and `scripts/test-report/fixtures/evidence/mobile-e2e-ios.json`, their five predecessors `scripts/test-report/fixtures/evidence-previous/static.json`, `scripts/test-report/fixtures/evidence-previous/verify.json`, `scripts/test-report/fixtures/evidence-previous/web-e2e.json`, `scripts/test-report/fixtures/evidence-previous/mobile-e2e-android.json` and `scripts/test-report/fixtures/evidence-previous/mobile-e2e-ios.json`, the parked-only root `scripts/test-report/fixtures/evidence-parked-only/mobile-e2e-android.json`, and fifteen nights of history — `scripts/test-report/fixtures/history/2026-08-11.json`, `scripts/test-report/fixtures/history/2026-08-12.json`, `scripts/test-report/fixtures/history/2026-08-13.json`, `scripts/test-report/fixtures/history/2026-08-14.json`, `scripts/test-report/fixtures/history/2026-08-15.json`, `scripts/test-report/fixtures/history/2026-08-16.json`, `scripts/test-report/fixtures/history/2026-08-17.json`, `scripts/test-report/fixtures/history/2026-08-18.json`, `scripts/test-report/fixtures/history/2026-08-19.json`, `scripts/test-report/fixtures/history/2026-08-20.json`, `scripts/test-report/fixtures/history/2026-08-21.json`, `scripts/test-report/fixtures/history/2026-08-22.json`, `scripts/test-report/fixtures/history/2026-08-23.json`, `scripts/test-report/fixtures/history/2026-08-24.json` and `scripts/test-report/fixtures/history/2026-08-25.json` — so every section is proven to render from data, not from production. `scripts/test-report/report-fixture-root.mjs`, `generate.test.mjs`, `generate-app-grids.test.mjs`, `generate-app-scenarios.test.mjs`, `generate-briefing.test.mjs`, `generate-nightly-semantics.test.mjs`, `render-briefing.mjs`, `report-verdict.mjs`, `report-verdict.test.mjs`, `matrix-grades.mjs` and `matrix-grades.test.mjs` are retired; the surviving signal tests (`scripts/test-report/report-signals.test.mjs`, `scripts/test-report/report-depth-signals.test.mjs`) move to the new model.

- **The rolling per-lane issue (Wave 0) is written from the same attention-queue model, so the issue body and §3 never disagree** — `scripts/test-report/rolling-issue-body.mjs` renders from `scripts/test-report/model/attention.mjs`, and `scripts/test-report/render.test.mjs` asserts that the issue body and §3 name the same deadline for the same lane.

- **Publish as today (mutable `nightly/` alias + immutable `nightly/runs/-/`), and additionally emit `summary.json` (verdict, blockers, deltas) for the job summary and the release lane** — `scripts/test-report/prepare-pages-site.mjs` keeps both publications and now copies `artifacts/evidence` into the dated slot; `scripts/test-report/summary-markdown.mjs` emits the new `summary.json` / `summary.md` pair that the job summary, the release lane and the rolling issue read.

- **Update TESTING.md's report section, docs/decisions.md (three-question page supersedes the evidence-archive design of #862), and the `validate-report-registries` tests** — `TESTING.md`'s report section, `docs/decisions.md`'s Night Watch v2 rulings (marking #862's evidence-archive design superseded), `docs/glossary.md`, `docs/design-divergences.md`, `docs/blueprint-seats.md`, `docs/coding-standards.md`, `docs/app-scenario-layer-template.md`, the eight app scenario pages (`docs/apps/agenda-scenarios.md`, `docs/apps/docs-scenarios.md`, `docs/apps/locker-scenarios.md`, `docs/apps/notes-scenarios.md`, `docs/apps/people-scenarios.md`, `docs/apps/photos-scenarios.md`, `docs/apps/tally-scenarios.md`, `docs/apps/tasks-scenarios.md`), `docs/traps/README.md` and the new `docs/traps/lane-evidence.md`; `scripts/test-report/validate-report-registries.test.mjs` and `scripts/test-report/validate-release-wiring.test.mjs` follow the new registries, and `scripts/test-report/vitest.config.ts` ratchets its coverage thresholds up (35/30/30/35 → 62/57/74/62) to match what the split now measures.

- ****Exit:** the first screen fits a laptop viewport without scrolling and names every blocker with an owner and an age; every tab of the current report has a home in the new one (checklist above); `report:smoke` is green from the fixture root** — Measured, not asserted: at 1440 × 900 the verdict lamp closes at 347 px and the blockers table at 625 px, leaving 275 px of headroom, so §0 and all of §1 are above the fold. The old-tab mapping is written into §11 as a table and asserted by `scripts/test-report/render.test.mjs`, and `bun run test:report:smoke` renders all twelve sections from the fixture root. Commands and numbers are in `## Verification`.

### Wave 4 — gate and ledger diet (rolling)

- **Classify every gate in `check:push` as **product** (rungs 1–4), **contract** (rung 2; bundled into one `lint:product` at rung 1 where each runs < 1 s), or **hygiene** (rung 5)** — `scripts/ci/gate-classes.json` carries 64 rows (class, rung, one-line reason) and `scripts/ci/gate-classes.test.mjs` holds the register and the weekly lane to each other. `scripts/lint-product.mjs` (`scripts/lint-product.test.mjs`) is the bundle: 39 gate names become one, spawning `bun run <gate>` at full machine parallelism — 1.8 s standalone against ≈5.6 s serial. The taxonomy is deliberately narrow: hygiene means a tighten-only ratchet over the test suite's own meta-quality, which makes the hygiene class exactly the seven gates this issue names.

- **Move hygiene ratchets (`test:comment-density`, `test:sleep-inventory`, `test:hygiene-ratchet`, skip and env-red budgets, `lint:type-floor`, `lint:schema-export`) to a weekly `hygiene.yml` with one rolling issue** — `.github/workflows/hygiene.yml` runs the seven through `scripts/hygiene-lane.mjs` and files one rolling issue via `file-tracking-issue.mjs --update`; the five steps that used to run them leave `ci.yml`'s `gates` job with their comment blocks. `package.json` splits `test:ratchet` so the up-only floors stay on the push loop and the skip inventory becomes the weekly `test:skip-inventory` — a floor is a contract, an inventory is hygiene.

- **Move the two ~32 s vendored governance directives from pre-commit to pre-push so rung 0 is ≤ 5 s** — No supported overlay exists (the kit reads `hook:` straight out of each directive's manifest, `conf_get` refuses an undeclared key, and both folders are digested), so `.githooks/pre-commit` skips the ids listed in `.governance/conf/srikanth235/centraid/pre-commit-deferred.conf` and `.githooks/pre-push` runs exactly those before `check:push`. `.governance/run.sh` is untouched, so CI still runs all 22 directives on every PR, and `.governance/packs/srikanth235/centraid/directives/pre-push-gate/check.sh`, `.governance/packs/srikanth235/centraid/directives/pre-push-gate/directive.yaml` and `.governance/packs/srikanth235/centraid/directives/pre-push-gate/constitution.md` state the split. Measured on this container: 88.7 s → 6.2 s. `internal-doc-links` was deliberately not deferred — a broken link is exactly the well-formedness question rung 0 exists to answer.

- **Trim `check:push` to ≤ 25 gate names, wall clock still bounded by `test:affected`** — `package.json`'s `check:push` goes from 59 named gates at the issue's baseline (60 on the branch base) → 17, and the wall clock is `test:affected` (474 s of the run's 474 s) — the property the trim was for. `lint:ledgers` and the other sub-second contract gates ride inside `lint:product` rather than adding a name.

- **Merge the 20 ledgers into `tests/floors.json` (coverage, mutation, minimumTests; up-only), `tests/budgets.json` (suite wall clock, rung budgets, quality rigs, experience, design-token CSS, mobile suites; down-only), `tests/inventory.json` (skips, env-red, sleeps, hygiene, comment density, n/a cells, advisory; down-only with issue + expiry), `tests/quarantine.json` (tests + lane parks; down-only with expiry) — one validator, same tighten-only semantics** — `tests/floors.json`, `tests/budgets.json` and `tests/inventory.json` are new, `tests/quarantine.json` grows a `lanes` block, and one validator — `scripts/check-ledgers.mjs` with 19 cases in `scripts/check-ledgers.test.mjs`, run as `bun run lint:ledgers` — holds all 19 sections against the merge base through a base-side fallback that reads the pre-merge standalone file when the merged key is absent. Twelve ledgers are retired: `tests/advisory-ledger.json`, `tests/comment-density-ratchet.json`, `tests/coverage-floors.json`, `tests/design-token-css-budget.json`, `tests/env-red.json`, `tests/hygiene-budgets.json`, `tests/lane-quarantine.json`, `tests/mutation-floors.json`, `tests/quality-rig-budgets.json`, `tests/skips.json`, `tests/sleep-inventory.json` and `tests/suite-wall-clock.json`. Every number carried across byte-for-byte. The consumers move with them: `vitest.config.ts`, `vitest.shard.config.ts`, `tests/helpers/rig-budgets.ts`, `tests/agent-e2e-shared/harness.mjs`, `tests/experience-budgets/README.md`, `tests/experience-budgets/client-query-counts.json`, `tests/perf/desktop-launch.perf.test.ts`, `tests/quality/classification-ratchet.json`, `packages/blueprints/stryker.untrusted.config.mjs`, `scripts/test-report/ratchet-floors.mjs` (with `scripts/test-report/ratchet-floors.test.mjs`), `scripts/test-report/collect.mjs`, `scripts/test-report/generate.mjs`, `scripts/test-report/report-floors.mjs`, `scripts/test-report/derive.mjs`, `scripts/test-report/skip-inventory.mjs`, `scripts/test-report/env-red-inventory.mjs`, `scripts/test-report/sleep-inventory.mjs`, `scripts/test-report/hygiene-ratchet.mjs`, `scripts/test-report/quarantine.mjs`, `scripts/test-report/suite-wall-clock.mjs`, `scripts/test-report/write-evidence.mjs`, `scripts/check-comment-density-ratchet.mjs`, `scripts/lint-design-tokens.mjs` (with `scripts/lint-design-tokens.test.mjs`), `scripts/ci/advisory-expiry.mjs` (with `scripts/ci/advisory-expiry.test.mjs`), `scripts/ci/pr-gate-wall-clock.mjs`, `scripts/ci/lane-health.mjs`, `scripts/ci/lane-rules.mjs`, `scripts/ci/rolling-issue-fallback-body.mjs`, `scripts/mutation/run.mjs` (with `scripts/mutation/run.test.mjs`), `scripts/mutation/seeds.mjs`, `scripts/check-quality-knobs.mjs`, `scripts/check-mobile-suite-budgets.mjs`, `scripts/lint-e2e-claims.mjs`, `scripts/ci/collection-tripwire.mjs`, `tests/integration-mobile/parked.integration.test.ts`, `tests/agent-e2e-mobile/flows/cold-start.mjs`, `docs/traps/design-tokens.md`, `docs/traps/coverage-run-filters.md` and `docs/traps/lane-evidence.md`.

- **Update TESTING.md, docs/dev-environment.md (the gate loop table), docs/decisions.md, and the CONSTITUTION's `coverage-scope-reachability` enforcing tests to the new files** — `TESTING.md` gains the four-ledger and weekly-hygiene sections; `docs/dev-environment.md`'s gate loop is rewritten as rungs 0–5 with measured costs; `docs/decisions.md` gains `## The Quality Ladder (#915)` with the gate-and-ledger rulings; `QUALITY.md` and `docs/glossary.md` follow. The constitution's enforcing test moves with the file it reads: `.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/check.sh` reads `tests/floors.json#coverage`, and `.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/directive.yaml`, `.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/constitution.md` and `.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/allowlist.txt` plus `CONSTITUTION.md`'s directive text and a dated Evolution Log entry move with it.

- **Retire `scripts/ci/retry.mjs` (no callers) and `tests/helpers/factories.ts#buildTestGateway` (no callers); fix the stale TESTING.md reference to `golden-vault.test.ts`** — `scripts/ci/retry.mjs` is deleted and `ci:retry` leaves `package.json`; `buildTestGateway`, its two interfaces and the now-unused `@centraid/server` type import leave `tests/helpers/factories.ts`, with `TESTING.md`'s sentence about it retired — `bun run knip` and `bun run typecheck` are green after both. The third clause is recorded rather than done, because its premise is wrong: `TESTING.md` names `packages/vault/src/golden-vault.test.ts` and `packages/vault/tests/golden/v0-baseline/` and **both exist**, so there is nothing stale to fix (see `## Decisions`). The genuinely stale fact nearby — the `pr-vitest` wall-clock prose — was corrected with the ledger move.

- ****Exit:** four ledger files; ≤ 25 pre-push gates; the constitution's tighten-only test passes against the new files** — `tests/floors.json`, `tests/budgets.json`, `tests/inventory.json` and `tests/quarantine.json` are the four; `check:push` names 17 gates, under the 25 cap; and `bash scripts/test.sh` — the `coverage-scope-reachability` self-test plus its live check against `tests/floors.json#coverage` — passes, as does `bash .governance/run.sh` on all 22 directives. Commands in `## Verification`.

Retired in this change, and named here because a deleted path is not a path a
link may point at: the workflows `.github/workflows/mobile-canary.yml` and
`.github/workflows/security.yml`; the seven mobile suite runners
`tests/agent-e2e-mobile/run-pr-gate-suite.mjs`,
`tests/agent-e2e-mobile/run-pr-gate-resilience-suite.mjs`,
`tests/agent-e2e-mobile/run-ios-depth-suite.mjs`,
`tests/agent-e2e-mobile/run-photos-suite.mjs`,
`tests/agent-e2e-mobile/run-home-apps-suite.mjs`,
`tests/agent-e2e-mobile/run-probes-suite.mjs` and
`tests/agent-e2e-mobile/run-promoting-suite.mjs`, together with
`apps/mobile/scripts/android-emulator-pr-gate-resilience.sh`; the matrix layer
`tests/matrix.json`, `tests/matrix.schema.json` and `tests/na-cells.json`; the
twelve ledgers listed above; `scripts/ci/retry.mjs`; and the report modules
`scripts/test-report/validate-matrix.mjs`,
`scripts/test-report/validate-matrix.test.mjs`,
`scripts/test-report/validate-matrix-app-axes.test.mjs`,
`scripts/test-report/matrix-fixture.mjs`,
`scripts/test-report/matrix-grades.mjs`,
`scripts/test-report/matrix-grades.test.mjs`,
`scripts/test-report/report-verdict.mjs`,
`scripts/test-report/report-verdict.test.mjs`,
`scripts/test-report/report-grids.mjs`,
`scripts/test-report/report-grids.test.mjs`,
`scripts/test-report/report-state-words.test.mjs`,
`scripts/test-report/render-briefing.mjs`,
`scripts/test-report/app-scenario-grid.mjs`,
`scripts/test-report/expected-grey.mjs`,
`scripts/test-report/report-fixture-root.mjs`,
`scripts/test-report/generate.test.mjs`,
`scripts/test-report/generate-app-grids.test.mjs`,
`scripts/test-report/generate-app-scenarios.test.mjs`,
`scripts/test-report/generate-briefing.test.mjs` and
`scripts/test-report/generate-nightly-semantics.test.mjs`.

## Out of scope

- **The three live-run exits.** Wave 0's non-RED nightly verdict, Wave 1's PR-gate
  p95 over 20 runs with a published promotion rate, and Wave 2's "every candidate
  carries an iOS verdict" are all read off the board after the pointer exists.
  `refs/candidates/latest` does not exist until `candidate.yml` runs green once on
  `main`; until then every deep lane resolves through the fallback chain and prints
  `source: last-green-ci`.
- **#870's confirmation run.** The cause is closed and the harness defects are
  fixed, but the rung-3 and rung-4 Android rosters have not run on the fixed tree.
  The lane park (expiring 2026-09-16) is the right holder until one green rung-4
  Android run exists; that run, not this receipt, closes
  [#870](https://github.com/srikanth235/centraid/issues/870).
- **`governance.yml`'s `timeout-minutes`.** Impossible by hand in this tree — see
  `## Decisions`. The remedy is a kit update, recorded in `docs/dev-environment.md`
  and `docs/decisions.md`.
- **Two environment reds in this container**, neither a code failure and neither
  worked around: `design:gallery` needs a Playwright headless-shell build that is
  not installed here (`ci.yml`'s `design-gallery` job installs it), and one of
  3,442 `@centraid/server` tests, `gateway-db-lock.integration.test.ts`, spawns the
  `sqlite3` CLI, which is not on PATH here.
- **`mobile-ios-smoke`'s first run is cold.** No `ios-shell-*` cache key has ever
  been banked, so the first candidate pays the ~32-minute build once inside the
  60-minute backstop; the ten-minute figure is the warm budget.
- **`mobile-canary-android`'s evidence budget stays at 2,700,000 ms** rather than
  the 1,440,000 ms suite sum: the evidence duration is the job span, which also
  carries the gateway build, the AVD boot, the install and the corpus seed. Moving
  it means moving `tests/claims.json#lanes` in the same edit and picking a job-span
  figure.
- **The issue's four open decisions are recorded as recommendations, not settled
  here.** No GitHub merge queue yet; mutation stays on PRs under the 8-minute cap
  with deferral; macOS minutes are spent on every candidate rather than every
  second one; the alarm cadence went to weekly rather than monthly because the
  roster was single-sourced in the same wave.
- **Escapes are an over-approximation.** No case ids cross workflows in the Actions
  API, so `countEscapes` counts a deep-rung red on a SHA whose rung-2 gate was
  green, and prints that caveat beside the number.

## Decisions

Every ruling below is also written where the next reader will look — mostly
`docs/decisions.md`, otherwise the comment beside the code it governs.

**The candidate pointer and the merge diet**

1. **`release:classify` cannot refuse a SHA it does not have.** Classify is a pure
   CHANGELOG read, so the refusal is mandatory in `scripts/release/prepare.mjs`
   (what a human runs, refusing before the clean-tree and `check:pr` gates because
   its remedy takes longest) and opt-in in `scripts/release/classify.mjs` behind
   `--require-candidate [--sha]`, with `release.yml`'s `require-candidate` job as
   the backstop. Recorded as **G-release-candidate**.
2. **`require-candidate` accepts the candidate history, not only the newest
   pointer.** A tag cut on yesterday's promoted candidate is correct and `main`
   keeps moving, so `promote` appends `{sha, promotedAt}` to a 200-entry
   `test-report/candidates.json`.
3. **Two `lane-client-e2e.yml` calls, not one.** `web-e2e-linux` and
   `desktop-e2e-linux` report as separate lanes; one caller with both booleans
   would collapse two verdicts into one nobody could act on.
4. **The three `uses:` lanes get their evidence from `promote`.** A
   reusable-workflow caller job has no `steps:`, so it cannot carry an evidence
   step; `promote` writes `web-e2e-linux`, `desktop-e2e-linux` and
   `lane-gateway-package` from `needs.*.result`. Only per-case detail is lost, and
   those lanes produce none today.
5. **`coverage-shard`'s lane id carries its shard**, so four legs write four
   evidence files instead of overwriting one.
6. **`changes`, `publish-report` and `check` write no evidence.** They are a path
   filter, a publisher and an aggregator — plumbing, not lanes that can falsify a
   claim.
7. **The turbo floor's one exception is computed, not waivable.**
   `scripts/ci/turbo-floor.mjs` downgrades to a named warning only when the diff
   touches a global-hash input (`bun.lock`, the root `package.json`, `turbo.json`,
   `.npmrc`, `bunfig.toml`, `Cargo.lock`, `.node-version`, `rust-toolchain*`,
   `.github/actions/setup/**`); a package-local manifest is deliberately not a
   mover, and no flag or env var turns the floor off. Recorded as
   **G-turbo-floor-waiver**.
8. **`--min-hit-rate` lives in a new `build:ci:floored` script**, not inlined three
   times — `bun run build:ci -- --min-hit-rate …` would be passed through to turbo
   itself.
9. **Escape counting is a stated over-approximation** (**G-lane-rules**), and
   `lane-health` reds only `park-expired`, `over-budget` and `park-required`: a
   demote or a promote files an issue instead, because reding the nightly for
   advice is the disease this issue treats.
10. **Rung budgets began as a map in `scripts/ci/lane-rules.mjs`** and are read
    from `tests/budgets.json#rungs` after the ledger merge, so the ladder's own
    numbers are ratcheted like every other budget.

**Night Watch v2**

11. **`flows` stays in `tests/claims.json`, and the flow VIEW is derived.** Only
    the ~22 mobile journeys are derivable; the other ~170 rows are a hand-typed
    register of owner file, `minimumTests` floor and tier, and no machine derives
    an ownership decision. `scripts/test-report/derive-flows.mjs --json` is the one
    reader the constitution's check and the linters use.
12. **`tests/na-cells.json` is absorbed into `claims.naCells` and deleted**, with
    the 183-day re-verification ritual unchanged. `surfaces[].assessment` is gone
    because §7 is now the join of lane tags with tonight's verdicts, so the 27
    `surface.*` rows are authoritative rather than derived.
13. **`cellOwners` (165), `notes` (148), `surfaces[].assessment`, `dimensions`,
    `journeys`, `legend` and the grade computation are retired, not migrated.**
    They existed to declare a per-cell expectation that the grades then checked;
    that is where most of the 252 KB went.
14. **10 surfaces, with the old 15 accepted as aliases.** Each new surface declares
    the matrix ids it `absorbs`, so the n/a register and the workflows' existing
    `--surfaces` tags resolve unchanged.
15. **Severity is declared, not computed.** A lane inherits the worst severity
    among the claims naming it; unclaimed gating is S2, unclaimed advisory S4.
16. **A night in which nothing reported is HOLD, and a gating lane that wrote
    nothing is DEGRADED.** Parked and no-evidence never count as red, but a lamp
    reading SHIPPABLE over an empty directory would be the silent all-clear this
    report exists to prevent.
17. **The `flaky` tone family is renamed `park`.** There is no "green only on
    retry" in a four-word vocabulary, so plum now means one thing, and the
    one-hue-one-meaning law in `report-theme.test.mjs` has less to excuse.
18. **`no-evidence` inks in `--nw-ink3`, not `--nw-grey`** — the grey mark rung
    reads at 3.03:1 on its own tint in light, which the contrast test caught.
19. **The new report tests are vitest, not `node:test`.** Every sibling in
    `scripts/test-report/` is vitest and `test:ratchet:unit`'s config globs
    `**/*.test.mjs`, so a `node:test` file there would not run at all.
20. **`test:ratchet:unit`'s coverage thresholds were ratcheted UP** (35/30/30/35 →
    62/57/74/62) because the reader/renderer split took measurement from ~36 % to
    66/61/79/66. Seeded a few points under, tighten-only.
21. **`ratchet-floors.mjs` reads the old paths on the BASE side.** A tighten-only
    check that goes silent for exactly the merge that renames its input is worse
    than no check; the fallback exists so the rename cannot launder a floor.
22. **The identity hook created a slugless `receipts/issue-915.md` twice** while
    the hooks were being timed. It was removed both times: two files carrying the
    same `issue-915` token fail `receipt-per-issue`, and the slugged
    `receipts/issue-915-quality-ladder.md` this text lives in is the receipt for
    the umbrella.

**The single roster**

23. **`flows[].suite` is an array and the ordered member list lives on the suite.**
    `cold-start` is in four suites and per-suite order is load-bearing (canary
    first, `locker-gate` last, `photos-permissions` first), so `suites[id].flows`
    is the order and `validateRoster` fails when the two disagree.
24. **Two budgets, and they are not the same ceiling.** `suites[].budgetMs` is the
    aggregate deadline that prices the pairings; `flows[].budgetMs` is a journey's
    marginal cost. A suite's members may sum past its own number; only a member
    that cannot fit its suite at all is a defect.
25. **A rename cannot launder a ceiling.** `pr-gate-resilience` → `resilience`
    keeps its ratchet through `supersedes`: the checker looks in the merge base's
    roster, then the superseded suite, then the retired runner literal.
26. **The `sharing` suite is new; `sharing-reach` is not** — it ran as a bare flow
    invocation with no ceiling, the one roster member nothing priced.
27. **`home-apps` is on rungs 3 AND 4.** Per-merge attribution is the whole point
    after #870 went unnoticed for a month, and `rungs` is an array, so it costs no
    machinery.
28. **The roster linters cross-check disk discovery rather than replace it.**
    Discovery catches a flow that landed after a list was written; the roster
    catches a row whose file was renamed or deleted. Reading only the roster would
    be strictly weaker.
29. **A bespoke "every referenced helper is imported" lint was attempted and
    reverted** — the heuristic fired on ~29 of 37 files without a scope chain. The
    honest home is oxlint's `no-undef` over `tests/agent-e2e-*/**/*.mjs`, which is
    what `oxlint.config.ts` now enables; it found no remaining undefined
    identifier, so the rule is what keeps `shQuote` fixed rather than what fixed
    it. A second, one-file override declares `chrome` and `document` readonly for
    `tests/agent-e2e-pairing/flows/extension-companion.mjs`, whose callbacks are
    serialised into a browser page — turning the whole `browser` env on would let a
    genuine `document` typo in a Node-side flow pass, which is the defect class the
    rule was enabled for.
30. **The four parked integration cells need no n/a rows.** They are covered by a
    blocker assertion computed from the shipped vault registry — better than a skip
    and better than an n/a, and it turns red the day the product gains a parking
    path.
31. **`mobile-ios-smoke` is a rung-3 lane with `blocking: false`.** `validateRoster`
    refuses any lane with `rung > 2 && blocking === true` — only rung 2 blocks a
    merge — and the job is in `promote.needs`, so it blocks the promotion, which is
    exactly what that pair means. Weakening the validator to accept a `blocking`
    rung-3 lane would have been weakening policy to go green. Recorded as
    **G-candidate-ios**.
32. **The iOS lane selects Xcode by scanning versions, not by naming a patch.**
    Hard-coding `Xcode_26.4` is the failure the existing loop's comment was written
    about: an image roll drops it and the lane dies with no product signal.

**The gate and ledger diet**

33. **The `lint:product` bundle spawns; it does not host in-process.** Every
    candidate is a CLI behind a main guard ending in `process.exit`, so hosting
    them means monkey-patching `process.exit` and `argv` per gate — a bundle that
    can silently swallow a failure is strictly worse than the ~3 s it saves.
    Recorded as **G-product-bundle**.
34. **`lint:type-floor` and `lint:schema-export` moved weekly with the tradeoff
    stated, not hidden** (**G-weekly-tradeoff**): type floor is the one
    hygiene-class gate whose red is user-visible, and schema-export's comparison is
    a standing fingerprint check, so weekly detects the same drift and only the
    diff-scoped hint is lost.
35. **The hygiene class is narrow on purpose** — a tighten-only ratchet over the
    test suite's own meta-quality — so `check:na-cells`, `test:quarantine`,
    `test:advisory-expiry`, `check:ui-receipt`, `knip`, `format:check` and `lint`
    stay contract gates and nothing leaves the required loop that the issue did not
    sanction.
36. **`test:ratchet` was split** so the up-only floors stay at rung 1 under the old
    name while the skip inventory becomes the weekly `test:skip-inventory`;
    otherwise the skip budget could not move without taking the floors with it.
37. **`check:mobile-native-state` dropped to rung 2 rather than being removed** —
    `mobile-smoke` already runs it on the PR loop, and it was 30.5 s of the push
    loop.
38. **The rung-0 deferral is a hook-level list, because no supported overlay
    exists.** `hook:` is read straight out of each directive's manifest, `conf_get`
    refuses a key a directive does not declare, there is no per-directive disable
    anywhere in the kit's library, and both folders are digested — so the split
    lives in `.githooks/*` plus a conf file, `.governance/run.sh` is untouched, and
    `managed-tree-integrity` still passes. Recorded as **G-rung0-deferral**.
39. **`golden-vault.test.ts` — the issue's premise is wrong, so nothing was
    edited.** `TESTING.md` names `packages/vault/src/golden-vault.test.ts` and
    `packages/vault/tests/golden/v0-baseline/`, and both exist; the same pair is
    cited correctly at `docs/decisions.md`'s **G-golden**. Recorded under
    **G-retirements** rather than "fixed".
40. **`governance.yml` cannot receive a `timeout-minutes` by hand, and its
    `pull_request` listener IS the allowlisted exception.** The exemption is
    confirmed and it is whole-file: `lint-workflow-pins` skips any workflow
    carrying `# governance-kit:managed` and says so in its output, which is why both
    the bare `pull_request:` and the missing timeout are legal by the same
    mechanism. The timeout itself is impossible in this tree — `install.yaml`'s
    `managed_digests` pins the file, `managed-tree-integrity` fails any edit,
    neither `install.yaml` nor the kit library exposes a timeout knob, and no
    `governance` CLI is vendored to recompute the digest. The remedy is a kit
    update. Recorded as **G-governance-timeout**.
41. **`minimumTests` is a derived MIRROR in `tests/floors.json`, not a move.** The
    up-only rule for a flow RENAME compares the replacement's surface, dimension
    and tier against the removed flow's, and those are claims data; moving only the
    number strands the waiver and the rename mapping. So `floors.json` holds a
    `{flowId: n}` mirror asserted equal by `lint:ledgers`, and the ratchet still
    runs over the claims rows. `budgets.mobileSuites` is the same pattern over the
    roster. Recorded as **G-mirrors**.
42. **`budgets.experience` is a REFERENCE, not an absorption** (**G-experience-reference**).
    The five `tests/experience-budgets/*.json` files are imported directly by
    fifteen consumers, several with import attributes, and the directory's README
    defines the year-3 volume vocabulary every ceiling is stated at; the section
    lists the files instead, and `check-quality-knobs.mjs` reads that list. Same
    reasoning keeps `inventory.naCells` a reference to `tests/claims.json#naCells`.
43. **Two entry shapes in `tests/inventory.json`, and the difference is declared.**
    "Down-only with issue + expiry per entry" cannot apply uniformly — `sleeps` is
    a path→count map, `hygiene` is two totals, `commentDensity` is 3,600 pins — so
    each section declares `_entries: "exceptions" | "population"`: exceptions carry
    an issue and a deadline per row, populations carry them on the section.
    `envRed`'s existing `revisitTrigger` is accepted as its deadline because an
    event is a sharper one than a guessed date. Recorded as **G-inventory-deadlines**.
44. **No new pins-vs-merge-base rule for comment density.** A prototype reported
    104 pins that legitimately rose on this branch — a new rule the tree cannot
    satisfy, which would have to be weakened to land. Dropped; nothing that was
    enforced stopped being enforced.
45. **The waiver did not merge.** `approvedDeviation` stays per section, in both
    the validator and `ratchet-floors.mjs`, so a section's waiver never reaches its
    neighbour (**G-waiver-scope**) — proven by a test and by hand.
46. **The mutation watch stayed narrow** (**G-section-watch**): a coverage-floor
    edit selects zero seeds, because `tests/floors.json` is expanded into
    `#<section>` tokens for the sections that actually differ from the base.
47. **`tests/quarantine.json`'s count is not diffed.** Lane parks legitimately grew
    0 → 3 here, because Wave 0 parked the lanes this issue mandates; the pressure
    on parks is `MAX_PARKED_LANES` and the report's HOLD verdict, and an issue plus
    an unexpired date per park is enforced.
48. **`scripts/check-ledgers.mjs` carries a `governance: allow-repo-hygiene
    file-size-limit` header**, used deliberately: splitting the section table from
    the rules it drives would reintroduce the drift the merge removed.

**Approved deviation, quoted verbatim for `lint:quality-knobs`** — this is the note
now standing in `tests/quality/classification-ratchet.json`, and this receipt is
what approves it:

#915 re-pins the governed classification payload after the Quality Ladder replaced tests/matrix.json with tests/claims.json. The 45-gate user-facing qualities panel retired into 45 claim ROWS: each keeps its id, owner, evidence selector, lane, knob and governance regime unchanged, and gains a declared severity (S1-S4, previously computed from the cell assessment) plus its demonstratedRed date and seed folded in from the matrix top-level block. No gate id was removed, no owner moved, and no date was bumped. The fingerprint is therefore renamed matrixGovernanceFingerprint -> claimsGovernanceFingerprint over the same content in a new shape, and the per-file fingerprint follows the file rename.

## Verification

The gate loop CONTRIBUTING requires before a push, run by the root on the merged
tree of all six slices:

```sh
bun run check:push
```

`14/17 gates passed in 474.4 s`, wall clock bounded by `test:affected` — the
property Wave 4 was for. The three failures, none of them a defect in this change:

- `design:gallery` — `Executable doesn't exist at /opt/pw-browsers/chromium_headless_shell-1234/…`.
  The Playwright headless-shell build is not installed in this container; `ci.yml`'s
  `design-gallery` job installs it.
- `test:affected` — 1 of 3,442 `@centraid/server` tests:
  `src/serve/gateway-db-lock.integration.test.ts:139` expects the `sqlite3` CLI's
  exit status and gets `null`, because that CLI is not on PATH here.
- `lint:product` — its single red member is `lint:quality-knobs`
  (`classification-ratchet.json: governed classifications changed without a
  receipt-approved deviation`), which closes with this receipt: the gate looks for a
  changed `receipts/issue-<N>-<slug>.md` carrying a `## Decisions` heading and the
  file's `approvedDeviation` note verbatim, and both are above.

All three reds were environment, not code, and all three are now closed in this
same container — the 14/17 above is kept as the first record of this session, not
superseded prose. The `sqlite3` CLI was installed here (`apt-get install sqlite3`,
3.45.1) and `packages/server/src/serve/gateway-db-lock.integration.test.ts` passes
(1/1). The pre-installed Playwright Chromium
(`/opt/pw-browsers/chromium_headless_shell-1194`) was aliased under the pinned
build id through a scratch `PLAYWRIGHT_BROWSERS_PATH` — no download, because
`cdn.playwright.dev` is refused by this environment's network policy — and
`bun run design:gallery` then verified all 8 product-grammar baselines at 0.00 %
change. `lint:quality-knobs` closed when this receipt landed. A fresh run of the
whole loop is green:

```sh
bun run check:push           # 17/17 gates passed in 516.6 s
                             #   test:affected   516.6 s (wall clock)
                             #   test:qualities  120.4 s
                             #   design:gallery   18.8 s
```

The pre-push hook therefore ran `check:push` green — after the two deferred
governance directives — for the push that carries this branch.

The whole-repo gates, all green:

```sh
bun run typecheck            # 25/25 tasks, plus `tsc -p tests`
bun run lint                 # 0 errors, with oxlint `no-undef` newly live over the e2e harness
bun run lint:types
bun run format && bun run format:check   # clean, 5,336 files
bun run lint:workflow-pins   # 23 workflow(s) clean; governance.yml skipped as governance-kit:managed
bun run lint:quality-knobs   # green once this receipt exists
bash .governance/run.sh      # 22/22 directives pass
```

Workflow and wiring linters, over the rewired 23 workflows:

```sh
bun run lint:path-filters    # 10 filters cover every path; every read carries `all`
bun run lint:ci-egress       # 3 enforce a policy, 16 ledgered
bun run lint:turbo-cache     # 2 turbo config(s) clean
bun run lint:evidence-mapping        # 47 registered lanes, every evidence step mapped
bun run test:claims                  # claims + nightly-wiring + release-wiring
node scripts/test-report/validate-nightly-wiring.mjs
node scripts/test-report/validate-release-wiring.mjs
python3 -c "import yaml,glob;[yaml.safe_load(open(f)) for f in glob.glob('.github/workflows/*.yml')]"
```

`bunx actionlint` is not available in this container, so YAML validity is proven by
parsing all 23 workflows with the `yaml` module. `validate-claims.mjs` reports
`45 claims, 47 lanes, 192 derived flows, 56 n/a cells`.

The mobile roster, the four mobile linters and the budget ratchet against it:

```sh
bun run lint:e2e-wiring              # 22 flow(s), 1 runner(s), 5 lane(s) — was 7 runners / 4 lanes
bun run lint:e2e-flows               # 342 Maestro steps across 37 files
bun run lint:e2e-claims              # 6/22 state their claim, 16 pinned (down-only)
bun run lint:mobile-testids          # 123 id selectors across 37 flow files
bun run check:mobile-suite-budgets   # 9 suites from roster.json, tighten-only
bun run lint:app-conformance         # 8 apps
node tests/agent-e2e-mobile/run-roster.mjs --rung 4 --platform android --dry-run
node node_modules/vitest/vitest.mjs run --config tests/integration-mobile/vitest.config.ts
```

`tests/integration-mobile` is 9 files / 62 tests green in 183 s, and its 56-cell
grid was re-derived from `packages/blueprints/apps/*/app.json#states` rather than
trusted from its README.

Unit suites behind the new machinery:

```sh
bun run test:ratchet:unit    # 37 files, 503 tests; coverage 66.71/61.26/78.69/65.64
bun run scripts:test         # 566 tests, 0 fail
bun run lint:ledgers         # 19 sections across 4 ledgers hold against origin/main
bun run test:ratchet         # no decreases vs origin/main
bun run test:report:smoke    # all 12 sections render from the fixture root
bun run check:na-cells       # 29 deliberate n/a cells
node --test scripts/ci/*.test.mjs                       # 130 pass
node --test scripts/lint-product.test.mjs scripts/ci/gate-classes.test.mjs   # 14 pass
node --test scripts/check-ledgers.test.mjs              # 19 pass
node node_modules/vitest/vitest.mjs run --config scripts/release/vitest.config.ts   # 53 pass
```

The constitution's own enforcing test, over the merged floors file:

```sh
bash scripts/test.sh
```

The self-test observes the synthetic violation and the live
`coverage-scope-reachability` check is clean while reading
`tests/floors.json#coverage`.

Wave 3's exit, measured rather than asserted — the first screen fits a laptop
viewport without scrolling and names every blocker with an owner and an age:

```bash
node scripts/test-report/generate.mjs \
  --evidence scripts/test-report/fixtures/evidence \
  --evidence-previous scripts/test-report/fixtures/evidence-previous \
  --candidate scripts/test-report/fixtures/candidate.json \
  --claims scripts/test-report/fixtures/claims.json \
  --history scripts/test-report/fixtures/history --output /tmp/report-fx
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --input-type=module -e "
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('file:///tmp/report-fx/index.html');
console.log(JSON.stringify(await p.evaluate(() => ({
  verdictBottom: Math.round(document.getElementById('verdict').getBoundingClientRect().bottom),
  blockersTableBottom: Math.round(document.querySelector('#ship table').getBoundingClientRect().bottom) }))));
await b.close();"
```

At 1440 × 900: verdict lamp bottom 347 px, §1 heading top 411 px, blockers table
bottom 625 px — 275 px of headroom. Every tab of the old report has a home in the
new one (Attention → §1 + §3, Product → §6 rung mode, States → §6 states toggle,
Scenarios → §6 verb toggle, Consent and Joins → §10, Journeys → §5, Adversaries →
§8, Infrastructure → §7, Detail shelf → §10), written into §11 as a table and
asserted by `render.test.mjs`.

Wave 4's rung-0 measurement, before and after the deferral:

```sh
AGENT_ISSUE=915 bash .githooks/pre-commit
```

88.7 s → 6.2 s on this container, which runs the vendored directives ~2.7× slower
than the machine `docs/dev-environment.md` is otherwise measured on, so 6.2 s here
≈ 2.3 s there. `repo-hygiene` (51.2 s) and `receipt-per-issue` (35.1 s) now run at
pre-push; `internal-doc-links` (2.7 s) and `managed-tree-integrity` (1.4 s) stay.
`bun run lint:product` runs 39 gates in **1.8 s** standalone against ≈5.6 s serial.

The turbo diagnosis, reproducible in this container — the numbers are measured, not
estimated:

```sh
rm -rf .turbo/runs && bun run build:ci   # cold: 0/13 cached, 349 s; @centraid/tunnel#build = 278 s
bun run build:ci                         # warm: 13/13 cached locally, 0 s
node_modules/.bin/turbo run build --dry=json   # hashes moved by one appended test line: 11/16 before, 0 after
```

The two ledger properties that make the rename safe, proven by hand as well as by
`scripts/check-ledgers.test.mjs` (each case builds a throwaway repo whose HEAD is
the pre-merge tree):

```
ratchet-floors: tests/budgets.json#qualityRigs "minimumSamples" loosened 10 → 2 (min floors may only rise)
ratchet-floors: tests/budgets.json#suiteWallClock "lanes.pr-vitest.budgetMs" widened 2867000 → 9999999
check-ledgers:  tests/floors.json#coverage: coverage floor "packages/backup/src/**.lines" decreased 90 → 40
                (1 error — the neighbouring section's changed note waived its OWN widen and nothing else)
```

**What this receipt cannot demonstrate, and where it will be demonstrated.** Each
wave's exit criterion is read off the lane health board and the scorecard after
merge, not asserted here; this receipt cites the candidate SHA and the dated
nightly run (`test-report/nightly/runs/<date>/`) that demonstrates each exit once
they exist. The scorecard's "Today" column — PR gate p95 ~26 min, promotion rate
~0 %, 0 green nights in the trailing 30, device minutes ≈ 25 Android / 0 iOS — is
the pre-change reading from the issue; the post-change readings are board facts,
and `refs/candidates/latest` does not exist until `candidate.yml` runs green once
on `main`. The same holds for whether the GitHub-backed remote turbo cache serves
the hits the floor now demands, for `mobile-ios-smoke`'s warm figure (its first run
is cold), and for #870's fourteen inferred journeys, whose confirmation is
`gh workflow run candidate.yml --ref main` and
`gh workflow run e2e.yml --ref main -f suite=mobile`.

## Audit

**Verdict: PASS**

A fresh-context sub-agent, handed only the change set, this receipt and issue #915, audited
the three claims a receipt can falsify. All 55 `[x]` checklist items were traced to code in
the diff and proven; the four `[ ]` items match the accounting above. Thirty `## What changed`
claims were sampled against the tree and the `## Verification` block was re-run end to end,
with every quoted command number reproducing exactly. The `## Checklist` mirror compared
byte-for-byte against the issue: 67 of 67 lines identical apart from the `[ ]`/`[x]` marker.
The gate, ledger and line counts were recomputed independently; the slips it found — checkout,
gate-class, `lint:product`, line-count and baseline-gate figures, the omitted `hygiene.yml`
evidence step, two bullets softer than their boxes, and stale quarterly prose in
`scripts/security/egress-ledger.json` — are corrected above and in that file.
