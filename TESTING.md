# Testing strategy

Centraid tests protect important product flows and invariants, not a test-file count. This document supersedes the product-shape assumptions from #212 and is the durable contract for the suite reorganized in #458 and rebuilt in #656.

## The axiom

This repo is written almost entirely by agents, and agents fail in predictable ways. They optimize for the green checkmark. They grade their own homework. They cannot see the whole suite, so they duplicate. They have no memory, so prose conventions decay. And the agent that writes the code writes the tests that _confirm_ it rather than tests that try to _falsify_ it.

This is not a hypothesis — the repo's own history demonstrates each mode. A probe sentinel was once left behind in a live assertion. Matrix cells were graded solid on the strength of prose. Owners of "solid" cells could skip themselves. Eight files hand-rolled a vault bootstrap that already existed in the test kit. `tests/journeys.json#rigs` drifted to describing 9 of 24 rigs while nothing in the repo actually read it.

Therefore:

> **Every quality claim is either computed by a machine or adversarially verified — never asserted by its author.**

Five principles follow, each with a mechanical consequence:

1. **Tests are the spec.** Contracts are the only statement of intent that survives context loss. The priority is more _named laws_, not more tests.
2. **Never trust a green from the author.** Mutation testing is the mechanical adversary: it asks whether a test would notice if the code changed. Line coverage proves execution; only mutation proves detection.
3. **Whatever is not mechanically enforced will regress.** Matrix grades are computed outputs, not typed-in inputs.
4. **Gates must be cheap and deterministic, or agents route around them.** Flakes are quarantined with an expiry — never deleted inline, never retried-in-place until green. Suite wall clock ratchets tighten-only.
5. **Make the right thing the only expressible thing.** Test-kit seams are enforced by lint; one-owner-per-law by a registry check, not by review.

The older working principles still hold and are now consequences rather than assertions: coverage of flows rather than a count of tests; one flow, one home, proven at the cheapest tier that can falsify it; runtime is a budget; duplication is visible; floors ratchet up, never down.

The machine-readable source of product-flow ownership is [`tests/claims.json`](tests/claims.json), joined with the mobile roster by `node scripts/test-report/derive-flows.mjs --json`. `bun run test:claims` verifies its vocabulary, its lane registry, every owning path, unique flow ids, and minimum contract sizes. A new test either claims an unowned flow or extends its existing owner.

## What the machine cannot check

The mechanisms below make dishonesty expensive, not impossible. These judgements have no gate, so this is where human scrutiny concentrates:

- **Whether a law is worth writing.** A registry entry proves a law has exactly one owner. It cannot tell you the law matters. A suite of true, trivial laws passes every gate here.
- **Whether a skip's reason is honest.** `tests/inventory.json#skips` forces every skip to cite an open issue and give a reason. Nothing checks that the reason is the _real_ reason, or that the issue is being worked.
- **Whether a journey covers what its name claims.** `minimumTests` counts tests; the computed grade checks that they ran. Neither reads the assertions. A journey named "pairing survives a network partition" that never partitions a network is green.
- **Whether a mutation-killing test asserts a law or an implementation detail.** Both raise the score. Only one survives a refactor.
- **Whether a deletion was a de-duplication or a loss.** #656 deleted a dozen restatements and _refused_ four more because the surviving owner turned out to be weaker. That call needed reading both tests, and no gate could have made it.

If you are reviewing agent-authored test work, spend your attention here and let the gates handle the rest.

## Runner and test taxonomy

[Vitest](https://vitest.dev) is the single unit/integration/contract runner. Every package extends one of the presets in [`packages/test-kit`](packages/test-kit), and every node preset explicitly uses the `forks` pool so `node:sqlite` and Worker threads are process-isolated. The node and jsdom presets also set **`expect.requireAssertions: true`** (#496 E5) so an assertion-free test fails; perf/scale configs opt out intentionally. The root [`vitest.config.ts`](vitest.config.ts) aggregates all projects for one v8 coverage result.

| Tier | Marker / location | Owns | Schedule |
| --- | --- | --- | --- |
| Unit / logic | `*.test.ts[x]` | one module's observable behaviour | per PR |
| React Native component | RNTL tests under `apps/mobile/src/**/*.test.tsx` | native roles/state, responder events, and component composition that jsdom cannot falsify | per PR |
| Integration | `*.integration.test.ts` | real SQLite, sockets, processes, or cross-component behaviour | per PR |
| Contract | `*.contract.test.ts` | named product law that refactors must preserve | per PR |
| Boot-the-artifact smoke | `scripts/gateway-package/smoke.mjs` (+ `--base-url` for containers) + path-filtered `gateway-package` workflow | "builds but doesn't start" (host binary **and** Docker image with `/data` volume) | **PR path-filtered** (gateway/protocol/Dockerfile/scripts) + manual `bun run gateway:package:smoke` |
| Desktop journey | `apps/desktop/tests/e2e/*.spec.ts` | real Electron-only assertions | **PR path-filtered** + full nightly |
| Web journey | `apps/web/tests/e2e/*.spec.ts` | real Chromium/PWA/network assertions | **PR path-filtered** + full nightly |
| Mobile boot-condition | `tests/integration-mobile/*.integration.test.ts` | the app × state matrix (`dayone`/`pending`/`offline`/`stale`/`conflict`/`parked`) produced by a **real replica session against a real gateway process**, on Linux with no device | per PR |
| Mobile journey | `tests/agent-e2e-mobile/flows/*.mjs` | native **release-artifact** assertions — OS state, gestures, process boundaries | **PR-gated (Android, the critical five)** + per-merge canary + nightly |
| Pairing journey | `tests/agent-e2e-pairing/flows/*.mjs` | daemon/CLI/device and relay ceremony | nightly + exploratory |
| Performance | `tests/perf/*.perf.test.ts` | hot-path budgets | nightly |
| Scale | `tests/scale/*.scale.test.ts` | correctness and duration at volume | nightly |
| Mutation | StrykerJS on 24 seeded packages | mutation-score floors | nightly (full) + per-PR diff-scoped |
| Fuzz | `scripts/fuzz/` targets, plus `scripts/fuzz/replay.test.mjs` for the committed crasher corpus | parser invariants over bytes nobody chose deliberately | nightly (`fuzz-parsers`) |
| Protocol join | `packages/server/src/serve/protocol-join-lane.test.ts` | N seats on one gateway speaking the real tunnel wire | per PR at 3 seats + nightly at 5 |

### Opt-in live adapter smoke

`bun run --cwd packages/server test:live-harnesses` launches the configured external ACP harnesses and is intentionally outside CI: it needs local CLI installs and credentials. Run it monthly and before releases or ACP adapter changes; ordinary PR validation uses the deterministic adapter tests instead.

### PR vs nightly (L1 / E2)

Decided in [#468](https://github.com/srikanth235/centraid/issues/468); cite [docs/decisions.md](docs/decisions.md).

Restructured into the six-rung Quality Ladder by [#915](https://github.com/srikanth235/centraid/issues/915); the **Rung** column is the ladder's number, and each rung asks exactly one question.

| Rung | Lane | Runs |
| --: | --- | --- |
| 2 | **Every PR** (`ci.yml` `check`, ≤ 15 min p95) | Unit, integration, contract — including the **protocol join lane** at its 3-seat floor, which is an ordinary `packages/server` test; matrix validation + **floors ratchet** via `check:pr`; **affected-package vitest** (`turbo run test --filter='[origin/main]'` — changed packages only, not the full dependent graph); **boot-the-artifact smoke** when the `client` filter triggers (includes `packages/server` paths — #496 E7); **path-filtered client e2e** (the `client-e2e` lane of `ci.yml` since #557) |
| 2 | **Path filters** | **Web** e2e when `apps/web`, `packages/client`, or service-worker files change; **desktop** e2e when `apps/desktop` changes. **boot-smoke moved to `verify`** under [#892](https://github.com/srikanth235/centraid/issues/892) — it was 4m38s of build for a ~0s L2 assertion over a dist `verify` already produces, and `verify` is unfiltered, so the check now also runs on PRs that never woke the `client` filter. With boot-smoke gone the lane's caller gates on `web \|\| desktop` rather than the wider `client`, which only ever existed to wake boot-smoke for gateway-only PRs; a `packages/server`-only change was starting a caller whose every job skips. Every top-level path must be claimed by a filter or ledgered, and every read of a filter output must carry the `\|\| …outputs.all == 'true'` fallback (`bun run lint:path-filters`), because `check` counts `skipped` as a pass. |
| 4 | **Nightly** (`e2e.yml`, on the promoted candidate, ≤ 90 min) | Full cross-client suites, perf budgets, the **full Android mobile roster** plus the **iOS depth roster** (the claims only iOS carries, never a second copy), pairing journeys, scale, **mutation (Stryker)**, **fuzz (`fuzz-parsers`)**, **protocol join at width (`protocol-join`)** |
| 3 | **Per merge to `main`** (`candidate.yml`, ≤ 45 min) | The **promotion lanes**: the rung-3 Android suites (`mobile-canary-android`, which also prebuilds the native shell the PR device gate restores from), `mobile-ios-smoke` (every candidate carries an iOS verdict — the `.app` is a separate artifact), web + desktop Playwright on Linux, `desktop-e2e-macos`, the gateway package smoke, `mutation-full`, CodeQL and the Rust supply chain. On green, `promote` moves `refs/candidates/latest` and publishes `test-report/candidate.json`; on red the pointer stays and each red lane's rolling issue is rewritten |
| 2 | **New-test burn-in** | Every added or modified `*.test.*` / `*.spec.*` Vitest file in the diff runs **3× in isolation** (`scripts/ci/burn-in.mjs`). Any disagreement between the three is red, not just a failure: the file that passes twice and fails once is the expensive one and the one a single run cannot see. Playwright and Maestro specs are skipped with a printed reason |
| 5 | **Quarterly** | The **mobile alarm test** — the critical five against a build with Home deliberately blanked, which must FAIL. Mutation testing for the E2E layer: a suite that cannot be shown to go red is not evidence. |
| 5 | **Weekly / release opt-in** (on the promoted candidate) | Real-weight enrichment goldens: pinned runtime + weights, capability handshake, OCR text, embedding cosine tolerance, face count/geometry, and licence pins. This lane is scheduled, manually dispatchable, and required after model/preprocessing changes; it never joins PR CI. |

**Promotion rule:** if a deeper lane burns us **twice**, move it to PR-time. Since [#915](https://github.com/srikanth235/centraid/issues/915) the burns are counted rather than remembered: `scripts/ci/lane-health.mjs` tallies escapes (a rung ≥ 3 lane red on a SHA whose rung-2 gate was green) and files `[lanes] promote <lane>` on the second in 30 days. The inverse rule is enforced too — a rung-2 lane below 99 % first-attempt pass gets `[lanes] demote <lane>`.

**Every rung 2–5 lane writes evidence.** Each ends with a `Write lane evidence` step calling `scripts/test-report/write-evidence.mjs`, which emits `artifacts/evidence/<lane>.json` with the lane's rung, platform, candidate SHA, verdict, budget and cases. A lane that claims `qualities × surfaces` and writes no evidence renders **no evidence** in every cell it claims — that is what makes absence visible rather than silent.

**Parks are deadlines, not mutes.** [`tests/quarantine.json`](tests/quarantine.json)'s `lanes` block carries an `issue`, an `expires` and a `why` per parked lane. A parked lane still runs and still writes evidence; it renders as **parked** rather than red, is excluded from the nightly verdict, and counts as red again the day its expiry passes. More than three parked lanes, or any park longer than 30 days, is a report-level **HOLD**.

### Nightly SLA (#496 E3)

Soft SLA (auto-issue, not a hard age gate):

1. A **scheduled** nightly that fails opens or updates **one rolling issue per red lane**, titled `[nightly] lane red — <lane>` ([#915](https://github.com/srikanth235/centraid/issues/915)). The body is **rewritten in place** every night, never appended to and never re-created, so the issue always states that lane's current condition and closing it means the lane is green. It replaces the single `[nightly] e2e lane red — tracking` issue, thirteen of which were opened and closed as noise: an issue that says "something was red" every night for a month is a cadence, not a signal. The red-lane list comes from `toJSON(needs)` via jq, so a lane added to `needs:` is covered without editing a second list. The report link is the **immutable dated slot** for that run (`test-report/nightly/runs/<date>-<runId>/`), not the `nightly/` alias — the alias is overwritten the next night, so an issue citing it would silently start describing a different run (#557).
2. **Expected response:** within **24 hours** or before the next scheduled run — triage, fix, or document a temporary waiver in the issue.
3. A job result of `cancelled` counts as red alongside `failure` (#557): a dead runner is not a pass. The condition reads `needs.*.result` in aggregate, so a job added to `needs:` is covered without editing a second list.
4. Branch `workflow_dispatch` runs **do not** publish to GitHub Pages (main-only guard on `publish-nightly-report`) so they cannot spuriously red the workflow with a Pages deploy error.
5. A **failed** `test-health-report` job still publishes (#557). The report's purpose is to show red, and the job fails on its own honesty exits _after_ writing the HTML — gating publish on success meant every honesty exit also suppressed the page that would have shown the failure. Only `cancelled` and `skipped` suppress the publish; `skipped` because single-lane dispatch skips the report job and publishing then would false-alarm "HTML missing".
6. Missing nightly HTML is **visible** (error annotation + tracking issue + a failed job), not a silent `::warning` only.
7. The scheduled `companion` lane in `extension-e2e.yml` and the weekly `backup-interop` lane both file their own tracking issues on the same terms.

### The ledgers (#915 Wave 4, #927)

Twenty tighten-only JSON ledgers under `tests/` are five, behind one validator — `bun run lint:ledgers` ([`scripts/check-ledgers.mjs`](scripts/check-ledgers.mjs)), a rung-1 contract gate inside the `lint:product` bundle.

| Ledger | Direction | Sections |
| --- | --- | --- |
| [`tests/floors.json`](tests/floors.json) | **up-only** | `coverage` (the globs the root Vitest config takes as its v8 thresholds and the constitution's `coverage-scope-reachability` directive reads), `mutation` (Stryker score per seed), `minimumTests` |
| [`tests/budgets.json`](tests/budgets.json) | **down-only** | `suiteWallClock`, `rungs` (the ladder's p95 budget per rung), `designTokenCss`, `mobileSuites` |
| [`tests/journeys.json`](tests/journeys.json) | **down-only** | `entries` (every user-facing ceiling, keyed `surface / journey / volume / hardware`), `rigs` (the nightly rig register), `drift` (the sampled-rig knobs) |
| [`tests/inventory.json`](tests/inventory.json) | **down-only, with an issue and an expiry** | `skips`, `envRed`, `sleeps`, `hygiene`, `commentDensity`, `naCells`, `advisory` |
| [`tests/quarantine.json`](tests/quarantine.json) | **down-only, with an expiry** | `entries` (flaky tests), `lanes` (parked CI lanes) |

Four rules make the merge safe rather than merely tidier:

1. **The waiver did not merge with the files.** Each section carries its own `approvedDeviation`, and a widen is waived only by a CHANGED note in the section being widened (#781: presence never waives). Before the merge, seven files each scoped their own waiver; one file-level note would have let a reviewed widen of the desktop cold-start ceiling silently waive a coverage-floor drop riding the same PR.
2. **The rename cannot widen anything.** Every comparison reads the merged file at the merge base first and falls back to the section's pre-merge path (`tests/coverage-floors.json`, `tests/suite-wall-clock.json`, …). Without that fallback every ratchet in the repo would go silent for exactly one commit — the one that did the renaming.
3. **Two sections are derived mirrors, not second copies.** `floors.minimumTests` mirrors `tests/claims.json#flows[].minimumTests` and `budgets.mobileSuites` mirrors `tests/agent-e2e-mobile/roster.json#suites[].budgetMs`; `lint:ledgers` asserts equality and `node scripts/check-ledgers.mjs --write` refreshes them. The source of each number is still the one document that also holds its context — the flow's surface/dimension/tier, the suite's flows and rung — so nothing is typed twice.
4. **A ceiling states its volume and its hardware, or it is not a budget (#927).** [`tests/journeys.json`](tests/journeys.json) replaced four per-surface experience files, the rig register and the query-count file, whose keys named the SURFACE and nothing else — several of them silently meant "empty vault". Every entry is keyed `surface / journey / volume / hardware` against a declared vocabulary, and names the trace SPANS it is measured from and the CONSUMERS that assert it, so a ceiling with no reader and a reader with no ceiling are both visible. `bun run lint:journey-ledger` holds that shape and fails on any surviving reference to the five files it replaced.

Two more things earn their own note. `commentDensity` is 3,600 per-file pins and 44% of all ledger bytes; the bespoke serializer that kept `--write` output passing `format:check` moved into `serializeLedger` and now serves every section, so any scanner's `--write` produces exactly what oxfmt would. And `designTokenCss` is deliberately **empty** — see [docs/traps/design-tokens.md](docs/traps/design-tokens.md); folding it in kept the emptiness, it did not repopulate it.

**Ledgers that are NOT ratchets stay separate files**, because merging a structural contract into a budget file would say something false about it: [`tests/design-grammar-matrix.json`](tests/design-grammar-matrix.json) (a design contract), [`tests/mobile-resource-evidence.json`](tests/mobile-resource-evidence.json) (observations with per-row tolerances), [`tests/diff-coverage-deviation.json`](tests/diff-coverage-deviation.json) (a waiver slot whose whole point is the ABSENCE of a key), [`tests/path-filter-ledger.json`](tests/path-filter-ledger.json) (the CI path-filter inverse register), [`tests/schema-export-fingerprint.json`](tests/schema-export-fingerprint.json) (a sha256 coupling gate, neither up- nor down-only) and [`tests/quality/classification-ratchet.json`](tests/quality/classification-ratchet.json).

### Floors ratchet (#496 E4, extended #532)

`tests/floors.json#coverage` values, claims flow `minimumTests`, and `tests/floors.json#mutation` scores **move only upward**. Perf budget files (`apps/web/tests/e2e/perf-budgets.ts`, `packages/server/benchmarks/low-end-budgets.json`) and every `tests/budgets.json` section are **tighten-only**: ceilings may drop freely; widening a ceiling or lowering a `min*` floor fails. CI and `bun run test:ratchet` / `bun run lint:ledgers` / `check:pr` fail on any decrease/widen unless:

- the section's own `approvedDeviation` in `tests/floors.json` or `tests/budgets.json` CHANGED in the same change set,
- per-flow `approvedMinimumTestsDeviation` on the lowered flow, or
- `approvedDeviation` in the perf budget source when deliberately widening.

### Computed grades (#656 Layer 2)

A cell's `solid` / `partial` / `gap` is **derived from evidence**, not read from the JSON. `assessment` survives in `tests/claims.json` only as a _declared expectation that the computation checks_: declaring above the computed ceiling is a hard error, and declaring below it needs a note. An agent may still type `solid` — the gate simply rejects it.

The ceiling is computed from, in order: the owner exists and declares tests (a zero-test owner is a `gap` at PR time, with no lane run needed); the owner has no inventoried skip site and no default-CI env gate; the cell has a flow with a met `minimumTests`; the declared owner owns one of the cell's flows and no backing file is _oversubscribed_ (the floors it owns exceed the tests it declares — this is what kills "one four-test file owns fifteen cells" as a class); a tier-appropriate adversary exists (a coverage-floor scope for unit/contract/integration, a registered rig budget for perf/scale); mutation score, where a seeded package below `_absoluteWeaknessBelow` can never back a `solid`; and finally fresh run evidence, which can only _lower_ a grade. Absent or stale evidence reports `unknown` — never health.

`solid` is therefore **uncomputable** for a cell whose owner can skip itself, whose flow has no `minimumTests`, or whose package is mutation-weak.

### The weekly hygiene lane (#915)

Seven gates are **hygiene**: tighten-only ratchets over the test suite's own quality rather than over the product. The skip budget, the environment-red inventory, the assertion-hygiene budgets, the fixed-sleep inventory, the comment-density pin, the type floor, and the schema/export fingerprint. They protect the suite from the agents; none of them can prove the phone works, and charging every push for them (10.2 s for comment density alone) bought a latency nobody used. They run in [`.github/workflows/hygiene.yml`](.github/workflows/hygiene.yml) on Saturdays at 05:00 UTC and on `workflow_dispatch`, driven by `bun run hygiene:lane`, and one **rolling** issue (`[hygiene] weekly ratchets red`) is replaced in place on any red.

This is not "enforced by the pre-push hook", which [#782](https://github.com/srikanth235/centraid/issues/782) ruled is enforcement in name only. It is a third tier: CI runs it, against `main`, on a schedule, and files an issue. Nothing depends on a developer's hook, and `test:comment-density` had no CI job at all before this, so weekly is strictly more enforcement than it had. What makes the move safe is that every one of the seven is a **standing** check over the whole tree — a count, an inventory, a fingerprint — never a diff-scoped one, so a weekly run on `main` sees exactly what a per-push run would have seen. The cost is detection latency (push → within 7 days), and nothing else. The classification and the reason for each gate live in [`scripts/ci/gate-classes.json`](scripts/ci/gate-classes.json), enforced by `scripts/ci/gate-classes.test.mjs`; the ruling is in [docs/decisions.md](docs/decisions.md).

Running one by hand is unchanged — `bun run test:sleep-inventory` and friends still work, and `bun run hygiene:lane` runs all seven.

### Skip budget (#656 Layer 2)

Every `test.skip` / `describe.skipIf` / env gate is inventoried in [`tests/inventory.json`](tests/inventory.json)'s `skips` section with an **open** issue, a reason, and an `expires` date. An uninventoried skip fails `bun run test:skip-inventory`, which runs in the weekly [hygiene lane](#the-weekly-hygiene-lane-915); the up-only floors half kept the `test:ratchet` name at rung 1. The total is a **down-only** budget: removing a skip demands you tighten the budget, and adding one is a visible, reviewed edit. Keys are `<path>#<ordinal>`, so line drift is a warning rather than churn.

### Deterministically-environment-red inventory (#781)

The quarantine owns nondeterministic failures and the skip budget owns declared skips, which left a third class homeless: a test that fails **every** time in a known environment — the wal-shipper `[G4]` chmod fault injection that root ignores, fixed as an instance in #782. Quarantining such a test would exclude it from the required checks everywhere, deleting live coverage on every environment where it is green to silence the one where it is red; leaving it naked makes a lane untrustworthy for whoever runs in the red environment.

The mechanism is a hybrid. The test **must carry an env guard** — `skipIf(predicate)` or a runtime `t.skip` — so it is honest at runtime everywhere (the guard also lands it in the skip budget), and the guard must be inventoried in [`tests/inventory.json`](tests/inventory.json)'s `envRed` section with the guarded test's title, the human-readable environment predicate, the guard mechanism (`skipIf`, `runtime-skip`, `reduced-assertion`, or `hard-fail`), an **open** tracking issue, and an `expiresAt` date or a `revisitTrigger` sentence. `bun run test:env-red` (in the weekly [hygiene lane](#the-weekly-hygiene-lane-915)) discovers the population by scanning the same globs as the skip inventory for environment-predicate comparisons (`process.platform`, `process.arch`, `process.getuid`/`geteuid`) and fails on an uninventoried guard, a stale entry, a vanished test title, a declared guard the file does not contain, a closed or missing issue, an expired entry, and any drift from the **down-only** `_budget` — the only way to shrink the file is the #782 move: rewrite the test so the environment stops mattering (there, a path-shape fault no uid can bypass replaced a permission bit root ignores). Keys are `<path>#<ordinal>`; `--write` refreshes lines and stubs new sites undocumented so it cannot launder a new hole.

What no static scan can find is the _unguarded_ instance — G4's chmod named no platform or uid. The contract is therefore about the response: the moment a deterministic environment red is diagnosed, it is either rewritten environment-independent or guarded, and a guard cannot land uninventoried.

### Named live/hardware lanes (#790)

An opt-in environment gate is not itself a defect: it is honest only when its required rig and invocation are named. The current inventory splits into these two states:

| Lane | Current rig |
| --- | --- |
| Clawgnition backup interop | `interop-weekly.yml` sets `CLAWGNITION_INTEROP=1` but does not provision `CLAWGNITION_REPO` or its `.dev.vars`, so the suite collection-skips on a clean runner; no effective rig |
| 10 GiB restore | `restore-year3` in `.github/workflows/e2e.yml` runs `CENTRAID_SCALE_RESTORE_GIB=10 node node_modules/vitest/vitest.mjs run --config vitest.scale.config.ts tests/scale/restore-10gib.scale.test.ts` on an isolated 90-minute Linux job |
| vault-write fsync count | Linux PR installs `strace`, sets `CENTRAID_BENCH_REQUIRE_FSYNC=1`, and runs `bun run test:perf:pr`; nightly installs `strace` and runs `bun run test:perf`. Missing `strace` in Linux CI is a hard failure |
| launchd install/uninstall | No named mutable macOS user-session rig; local opt-in only |
| native QUIC relay | The Linux `verify` job builds the workspace then runs `bun run --cwd packages/tunnel test:native` (the package command sets `CENTRAID_RUN_NATIVE_TUNNEL=1`) |
| real disk-full filesystem | No privileged APFS image or Linux loop-device rig; local Darwin opt-in only |
| byte-plane-over-HTTP | The Linux `verify` job runs `bun run --cwd packages/tunnel test:data-plane`, including both TypeScript and built-Rust HTTP contracts |
| live automation failover | No runner provisioned with the real harness binaries; local opt-in only |
| mobile strict perf evidence | No uncontended native SQLite evidence runner sets `CENTRAID_PERF_EVIDENCE=1` |
| reflink allocation | No named APFS/btrfs/xfs runner; ordinary ext4 CI proves only the byte-identical fallback |
| desktop launch perf evidence | Nightly `desktop-e2e` runs `bun run test:e2e` in `apps/desktop` and publishes `nightly-evidence-desktop`; `quality-performance-scale` restores it and runs `bun run test:perf` |
| PWA waterfall perf evidence | Nightly `web-e2e` runs `bun run e2e` in `apps/web` and publishes `nightly-evidence-web`; `quality-performance-scale` restores it and runs `bun run test:perf` |
| native tunnel load perf evidence | `quality-performance-scale` runs `bun run build` to produce the host module, then `bun run test:perf`; the inverse absent-module assertion owns environments without a built native |

The missing rigs remain explicit #790 blockers. Do not delete or narrow their `tests/inventory.json#skips` / `#envRed` entries merely to close the tracker; an entry shrinks only when the named rig actually runs the law or a current decision retires the claim.

### Assertion-hygiene ratchet (#781)

Two matcher families are weak enough to erode a suite from the inside, and neither is wrong in isolation, so no lint rule can ban them: `toBeTruthy()` / `toBeFalsy()` accept `1`, `'x'`, `[]`, `{}` where the house style asserts an exact `toBe(true)`, and a bare `toHaveBeenCalled()` proves a call happened without proving it was the right one. [`tests/inventory.json`](tests/inventory.json)'s `hygiene` section makes their totals **down-only** budgets under `bun run test:hygiene-ratchet`, the same shape as the skip budget: a slice may not add sites without a reviewed edit, and slack is a hard failure so the ceiling cannot drift upward by neglect. `--write` reconciles budgets with `Math.min(previous, measured)`, so the escape hatch can only lower a number, never launder a regression.

### Fixed-sleep ratchet (#781)

A fixed sleep — `await new Promise((r) => setTimeout(r, 50))`, a `setTimeout as sleep` alias, a local `delay(20)` helper — bets that the awaited work finishes inside the literal, and pays for that bet in flake on a loaded runner and in wall clock everywhere else. [`tests/inventory.json`](tests/inventory.json)'s `sleeps` section inventories every site by file with a **down-only** `_budget` under `bun run test:sleep-inventory`, the same shape as the skip budget: an uninventoried sleep or a file that grew fails with the remedy (`useFakeClock()` + `clock.advance()`, an event-driven wait such as `vi.waitFor` or a deferred the test resolves, or an outcome poll), and a total under budget fails until the ceiling is ratcheted down (`--write` reconciles and can only lower it).

Three shapes are deliberately **not** counted: 0ms yields (`flushMacrotasks()` and friends wait on the queue, not the clock), non-literal delays (`setTimeout(r, timeoutMs)` is configurable, not hard-coded), and rejecting deadlines (`setTimeout(() => reject(new Error(…)), 10_000)` — a watchdog is the upper bound on an event-driven wait, which is the remedy, not the defect). `scripts/test-report/**` is excluded as the detector's own fixtures; `packages/test-kit/**` is excluded because the kit's seam tests schedule literal timers under `useFakeClock()` to prove the fake clock runs them.

Negated bare `.not.toHaveBeenCalled()` is **exempt** — asserting a call did _not_ happen is complete on its own, and there is nothing stronger to demand. `.not.toHaveBeenCalledWith(...)` and `.not.toHaveBeenCalledTimes(...)` do count, because those carry an argument or arity the positive form should also carry.

### Law registry (#656 Layer 4)

A named product law carries a machine-readable tag in its test title — `test("[law:backup-no-change] …")` — and is registered under `laws` in `tests/claims.json` with a statement and its owning file. `bun run lint:law-registry` fails when a tag appears in more than one file (this is "one flow, one home" enforced at write time, which is what makes de-duplication _stick_), when a registered law has no tagged test, or when a tag names no registered law.

### Flake quarantine (#656 Layer 5)

A test that fails nondeterministically moves to [`tests/quarantine.json`](tests/quarantine.json) with an issue, a reason describing _how_ it flakes, and an expiry date. It is **never deleted inline** — that loses the coverage silently — and **never retried-in-place until green**, which converts a real defect into latency. While quarantined it is excluded from the required checks, so the lane stays trustworthy.

On expiry it either returns fixed or is deleted with a receipt. `bun run test:quarantine` (in `check:pr`) makes that stick: an expired entry is a hard failure, so the debt cannot be parked forever. The entry count is a down-only budget, because a quarantine list that only grows is a slow way of deleting a suite.

### Suite wall-clock ratchet (#656 Layer 5)

Every other gate here pushes one way — more tests, higher floors — so the cheapest way for an agent to look thorough was to flood the suite, and the bill arrived as PR latency nobody owned. [`tests/budgets.json`](tests/budgets.json)'s `suiteWallClock` section is the backpressure: the PR lane's total wall clock is a **tighten-only** ceiling, ratcheted like a perf budget. Adding tests means making something else faster, or widening the ceiling in a reviewed edit that records what the extra time buys. Current `pr-vitest` ceiling is **2,867,000 ms**, reseeded 2026-08-29 under [#883](https://github.com/srikanth235/centraid/issues/883) from CI verify (1,487 files, 2,492.7 s measured, 15% headroom). The prior seed was [#850](https://github.com/srikanth235/centraid/issues/850)'s 1,332 files / 2,018.1 s / 2,321,000 ms; before that, 2026-07-31, 849 files / 1,408.3 s / 1,620,000 ms.

A **second lane, `pr-gate`, with a different metric and the same tighten-only rule**, was added by [#915](https://github.com/srikanth235/centraid/issues/915): the rung-2 gate's RUNNER TIME — the union of the `started_at → completed_at` intervals across `check`'s `needs:` jobs, read from the Actions API by `scripts/ci/pr-gate-wall-clock.mjs` inside the `check` job (which therefore holds `actions: read`). The budget is **900,000 ms (15 min)**, the ladder's rung-2 price of a merge. It is neither a sum nor a raw span: summing the lanes would punish the parallelism that makes the gate fast, and the raw `max(completed_at) − min(started_at)` charged the PR for the account's runner backlog — two consecutive PRs reddened on queue wait alone against a ≤ 2 % false-red target, which is why [#931](https://github.com/srikanth235/centraid/issues/931) moved the metric to the union of busy intervals **without moving the ceiling**. Overlapping lanes collapse into one interval exactly as before; only the gaps in which no gate job was running are excluded, and both the elapsed span and the queue wait are reported beside the budgeted number. Over budget, the fix is to move a lane to rung 3 or make it faster — both numbers are ratcheted by `scripts/test-report/ratchet-floors.mjs`, which fails any widen without a changed `approvedDeviation`.

**`lanes["pr-gate"]` is the GATE'S RUNNER TIME, not the device suite of the same name.** The `pr-gate` Maestro suite's own 480,000 ms ceiling lives in [`tests/agent-e2e-mobile/roster.json`](tests/agent-e2e-mobile/roster.json) and fails one lane; this 900,000 ms figure is the rung-2 budget for the whole required check, across every job in `check`'s `needs:`. They share a name because they answer to the same rung, and they must not be reconciled into one number: the suite ceiling would leave fourteen other lanes unpriced, and the job span would let a device suite triple while the gate still fit.

It measures the sum of per-file durations from the vitest JSON report rather than the run's elapsed time, because elapsed time varies with host load and concurrency while the sum is the work the suite actually asked for. With no report present it prints "not measured" and exits 0 — a budget that could not be measured must never read as a budget that was met.

The lane that enforces it is CI **`verify`** — the single-job, unsharded half of the [#892](https://github.com/srikanth235/centraid/issues/892) split — in the `Suite wall-clock ceiling` step. It must be scored **only** there: the metric is NOT shard-invariant. Every file's span stretches when workers timeshare a slow runner, so the four-way sharded `coverage` lane reads ~3,824 s for the same 1,508 files that measure ~2,370 s uninstrumented on one host ([#905](https://github.com/srikanth235/centraid/issues/905)). That step asserts the report exists before invoking the gate, because the "not measured" exit-0 above is right on a laptop and wrong in the lane that enforces the ceiling — a missing report there means the wiring rotted, not that the suite met its budget.

### Collection-error tripwire (#842 W0.3)

A test file that throws while it is being _loaded_ registers no `test()` at all. Vitest reports it as one failed file with a message and an empty `assertionResults` array, and every counting gate here — matrix `minimumTests` floors, the skip budget, the quarantine ledger, the coverage floors — then sees a smaller universe rather than a violated one, so the suite reads as absent instead of red. `bun run test:collection-tripwire` reads `artifacts/test-results/vitest.json` and fails on exactly that shape; CI runs it with `--require-report` **twice** — on `verify` (the earliest place the shape can be seen, and a collection error is a "do not merge" answer) and on `coverage` (the world the floors were measured against, where an error that appears only under instrumentation would show) — so a missing artifact fails rather than passing as "not measured". An ordinary red (a failed file _with_ a failed assertion) and a wholly skipped file are not its business. Quarantining or deleting the offender is not a fix — it hides the gap the file leaves.

### Chaos lanes (#842 W3)

Two seeded chaos lanes ask the same question of different planes: does adversity change _whether_ work is applied, or only _when_? `tests/quality/network-chaos.integration.test.ts` injects eight fault shapes over a **real** iroh connection against the replica intent plane — latency, jitter, fragmentation, asymmetric bandwidth, mid-request abort, mid-response disconnect, endpoint restart, address rebind — and asserts no-loss, apply-exactly-once and convergence on real `schedule_task` and `replica_intent_outcome` rows. `tests/quality/component-chaos.integration.test.ts` kills a gateway, replica, automation worker or model runtime mid-work and asserts the same laws across the restart. Both lease-shaped faults use the primitives' injectable clocks, so neither lane waits on a wall clock or asserts on timing.

Byte-level packet loss and reorder are deliberately **not** injected. QUIC converts both into delay, delivery, or connection failure, so dropping bytes from an ordered stream would model a corrupt QUIC implementation rather than a lossy network. The two faults that genuinely need a privileged runner (`tc qdisc … netem`, CAP_NET_ADMIN) are declared at tier `needs-netem`, excluded from the runnable schedule, and — this is the part that matters — **cannot be claimed for free**: setting `CENTRAID_NET_CHAOS_NETEM` with no driver wired fails the lane with the unblock condition rather than passing.

Scheduling is `chaosSchedule(catalog, seed, {mode})`. `cover` is a seeded Fisher–Yates permutation running every fault exactly once (the PR default, ~18 s); `sample` draws with repetition (`CENTRAID_CHAOS_ITERATIONS`, 40 on the nightly, ~68 s). `CENTRAID_CHAOS_SEED` replays any run, and each case name carries `seed 0x… step N`. Both lanes carry an in-process guard asserting the schedule replays byte-for-byte from its seed and that cover mode really is a permutation, so a fault cannot quietly drop out of the catalog.

### Long-run soak and load rigs (#842 W3.4, W4)

`tests/scale/{composite-load,stress-to-failure,long-run-soak}.scale.test.ts` are nightly-only (`tests/scale` is never in the PR lane). They live there rather than anywhere else on purpose: `validate-nightly-wiring.mjs` walks only `tests/perf` and `tests/scale`, and for every file it finds there it _forces_ a `tests/journeys.json#rigs` entry, bans inline `const BUDGET_MS`, and requires the rig to read its own drift history. A rig placed elsewhere gets none of that and could land unbudgeted.

The soak is **not** an env-gated skip. `CENTRAID_SOAK_MINUTES` defaults to `0.75`, so the rig always runs and always gates its always-true invariants; only the _growth_ ceilings assert at `>= declaredSoakMinutes`. That split is not a convenience — at 45 seconds the per-cycle RSS slope reads ~58× higher than it does over ten minutes, because warm-up has not amortized, so a growth ceiling asserted at the nightly duration would be measuring start-up. `declaredSoakMinutes` is 10 because ten minutes is the longest run the ceilings were derived from; `soak-weekly.yml` runs the same file at 240 minutes to turn them into a distribution.

### Test-kit seams (#656 Layer 4)

The kit path is enforced, not merely recommended. In test files, oxlint bans raw `fs.mkdtemp*` (use `tempDir()` / `tempDirSync()`), `vi.useFakeTimers` / `vi.setSystemTime` / `vi.useRealTimers` (use `useFakeClock()`), and `Math.random()` (use `seededRandom()`). `bootstrappedVault()` exists so the shortest path to a vault fixture is also the correct one.

`Date.now()` is deliberately **not** banned: the defect worth catching is wall clock inside an assertion's expected value, and oxlint cannot express that shape. A blanket ban would touch 162 call sites that are overwhelmingly relative offsets, id suffixes, and elapsed measurement — it would buy a rename, not determinism.

### Skipped-gate honesty + partial → solid (#496 B2/B3)

- Env-gated **cell or flow owners** (`CENTRAID_*`, `CLAWGNITION_*`, whole-file `describe.skipIf` / early `t.skip`) cannot keep a `solid` or `partial` assessment — `bun run test:claims` fails until the gate is removed or the assessment is demoted.
- Closing a QUALITY / matrix note item **must** promote the assessment and delete/update the note. `partial` is temporary evidence, not permanent furniture.

### Confidence map (#496 J1)

```
HIGH  vault/backup/replica contracts, handler isolation, web offline/PWA,
      pairing when nightly green, engine coverage floors, ENOSPC fault-inject,
      harness conversation journey (fake ACP integration)
MED   desktop Playwright, mobile Maestro (Android gates PRs, iOS nightly depth), perf/scale
      (generous), tunnel native when module present, multi-writer double-write
SOFT  mobile on-device perf/scale (honest skip), nightly red → human action
```

Parent backlog: [#496](https://github.com/srikanth235/centraid/issues/496).

`TESTING.md` wins over any suite README that contradicts this split (**L3**).

Playwright alone owns desktop and web regression journeys. The mobile journey layer is the committed agent-driven flows under [`tests/agent-e2e-mobile/`](tests/agent-e2e-mobile); their device-driving substrate is **Maestro**, spawned by the harness ([`lib/harness.mjs`](tests/agent-e2e-mobile/lib/harness.mjs) `runMaestroChunk` runs `maestro --udid … test <flow.yaml>` per step). There is no second native suite and no Detox suite. Desktop agent-driven flows were retired after their unique restart/persistence assertions moved to Electron Playwright.

Since [#890](https://github.com/srikanth235/centraid/issues/890) the mobile layer holds six properties the rest of this document assumes:

1. **CI drives the release artifact.** Every scheduled lane installs a Release-configuration build with the Hermes bundle embedded — no Metro, no dev launcher, no bundle prewarm. The dev client is the _local exploratory_ rig. `validate-nightly-wiring.mjs` refuses a lane that starts Metro or builds iOS without `--configuration Release`, and it discovers mobile lanes rather than listing them so a new lane cannot join unpinned.
2. **Device signal lands before merge.** `mobile-device-gate` in `ci.yml` runs the `pr-gate` suite on Android as ONE emulator leg within eight minutes warm; `candidate.yml` runs `mobile-canary-android` (the rung-3 Android suites) and `mobile-ios-smoke` per merge to `main`; `e2e.yml` owns nightly depth. Android gates PRs per D1 in [docs/decisions.md](docs/decisions.md#mobile-testing-890).
3. **Four linters make a green run unfakeable.** `lint:e2e-wiring` (a flow the ledger claims and no lane runs is a hard failure), `lint:mobile-testids` (every id a flow references exists in the app source), `lint:seat-verbs` (every act only a phone can perform has a journey or a dated gap), and `lint:app-conformance` (the five tables that decide whether a launcher tile reaches a screen agree with `apps/mobile/app-conformance.json`, in both directions). Each carries a self-test and silent-no-op guards.
4. **The roster shrinks rather than fans out.** State variety moved down to the boot-condition tier; the device proves the native wiring once.
5. **Every app is covered identically, by manifest.** `apps/mobile/app-conformance.json` is the shell↔app contract's one source of truth, read by the RNTL sweep in `apps/mobile/src/screens/Home.test.tsx`, by `lint:app-conformance`, and by the Maestro `.mjs` runners. Registering an app with no launcher route, no switch arm or no tile handle fails on the per-PR loop, in the PR that registers it — no per-app authoring, and no roster to remember to extend (E-conformance-manifest in [docs/decisions.md](docs/decisions.md#mobile-testing-890), [#905](https://github.com/srikanth235/centraid/issues/905)).
6. **Retry is classification, not forgiveness.** One clean-state retry for an infrastructure-classified failure only — driver disconnect, a precondition that never came up, a timeout with zero assertions run. A product assertion is never retried, because an `assertVisible` timeout is the exact shape a real regression takes.

React Native component tests use `@testing-library/react-native` 13 on the **same Vitest runner**. They are reserved for claims that need the RN accessibility/responder tree; pure transforms stay unit tests and recognizer/device integration stays Maestro. A component test over roughly 200ms must state what cheaper layer cannot falsify and should be consolidated with adjacent scenarios rather than spawning another cold renderer file.

The mobile suite therefore runs as **two Vitest projects**, defined in [`apps/mobile/vitest.projects.ts`](apps/mobile/vitest.projects.ts):

- `@centraid/mobile-rn` — the RNTL tier. Real React Native, loaded in Node by `src/test/react-native-setup.ts`, with device services seamed once for the whole project in `src/test/native-device-seams.ts`. **One consolidated file per app home screen**, named in the `nativeComponentFiles` array: Agenda, Docs, Locker, Notes, People, Photos, Tally, Tasks. A file belongs here only for claims the DOM stub cannot falsify — real accessibility role / accessible name / state traits, the real responder tree, list slot behaviour, and real `StyleSheet` flattening.
- `@centraid/mobile` — everything else, including the DOM-stub component tier (`src/test/react-native-stub.tsx`).

`nativeComponentFiles` is spread into `mobile-rn`'s `include` **and** `mobile`'s `exclude`, because the two must stay exact complements: a file in both runs twice and its stub-tier `vi.mock("react-native")` shadows the host tree the RNTL run exists to observe, while a file in neither runs nowhere. Vitest reports both mistakes as green.

The stub tier's contract — what it may and may not claim — is stated at the head of `src/test/react-native-stub.tsx`. In short it owns props, model output, rendered strings, and the computed style object; it owns neither RN's published accessibility nodes, nor responder-level refusal, nor native layout, nor list windowing. A stub-tier title that overstates is a green test standing in for a claim nobody makes.

Accessibility ownership follows the same cheapest-falsifying-layer rule. The web Playwright lane scans the cold connection screen, the connected Home shell, and a shipped first-party app renderer with axe WCAG A/AA. Desktop deliberately reuses that owner: both desktop's Vite entry and the web host execute `packages/client/src/react/boot.tsx`, so a second Electron axe pass would scan the same DOM with the same rule engine; Electron-specific focus and keyboard journeys remain desktop Playwright claims. Mobile role, accessible-name, and state/trait semantics are RNTL claims, consolidated one file per app home screen in the `@centraid/mobile-rn` project (`nativeComponentFiles` in [`apps/mobile/vitest.projects.ts`](apps/mobile/vitest.projects.ts)); Maestro keeps device/runtime integration and does not stand in for roles or traits its text selectors cannot observe. `scripts/accessibility-contract.test.mjs` remains a fast source-level tripwire, not a matrix evidence owner.

### App admission contract

When an app graduates beyond sample data, its current design record and matrix entries must name:

- the app, north star, seat class (`record-only` or `byte-bearing`), and graduation issue;
- a `*-model.ts` beside each view for pure product arithmetic;
- one cheapest falsifying layer per scenario: `U`, `C`, or `E` (`U + E` only when the assertions differ);
- a handler contract for every vault-facing action, including refusal, receipt/postcondition, and partial-batch behavior;
- structurally impossible engine/app combinations as `skip` in `tests/claims.json#appEngines`, with a seat-doctrine citation;
- one north-star journey and tighten-only budget per byte-bearing app/platform, or the shared replica journey for record-only apps;
- the seeded `@centraid/test-kit/year3-vault` profile, destructive-flow reseed order, app path filter, and a measured app coverage floor.

The smallest reusable record is:

| Claim                                 | Layer | Evidence                  |
| ------------------------------------- | ----- | ------------------------- |
| Pure product arithmetic               | `U`   | `<feature>-model.test.ts` |
| Native role/state/responder semantics | `C`   | `<Feature>.test.tsx`      |
| Device/runtime integration            | `E`   | `<app>-<journey>.mjs`     |

Every vault action records its happy-path postcondition, refusal/partial-failure behavior, and owning contract file. Every structural exclusion records why the engine is impossible and cites `docs/blueprint-seats.md#engine-contracts`. The shared profile is paid for once per platform; a byte-bearing app's journey owns its budget and PR filter.

The reusable table shape is [docs/app-scenario-layer-template.md](docs/app-scenario-layer-template.md); per-app instances live in `docs/apps/` and are promoted into `tests/claims.json#appScenarios` (Docs: [docs/apps/docs-scenarios.md](docs/apps/docs-scenarios.md); Photos: [docs/apps/photos-scenarios.md](docs/apps/photos-scenarios.md); Notes, Tasks, Agenda, People, Locker, Tally: the matching `docs/apps/<app>-scenarios.md`). The nightly report renders that ledger as §3b.

### Photos native renderer contract (#716)

Photos uses `@testing-library/react-native` on Vitest, not Jest, Detox, or Appium. The consolidated `PhotosHome.test.tsx` holds Photos' RNTL scenario cases in one file — the shape every other app's home screen now follows — because the cold-renderer startup cost is paid once per file and accepted because it falsifies RN roles, responder wiring, accessibility labels, and host geometry that jsdom cannot represent (the renderer comparison and measurements are recorded in [#716](https://github.com/srikanth235/centraid/issues/716)). Pure models remain ordinary tests.

Production application components and JS helpers stay real. Mocks are limited to native host/device seams: AsyncStorage, Expo device services, replica/data providers, `expo-image`, `react-native-svg`, and media URI resolution. A future direct `op-sqlite`, FlashList measurement, or RNGH dependency receives an import-typed seam mock; it must not replace the component or its pure model. Recognizer precedence, native modal layering, pinch/pan/swipe, keyboard alignment, and denied OS permissions remain Maestro claims.

`apps/mobile/src/apps/photos/photos-fixtures.ts` is the deterministic in-process corpus shared by pure and component tests. The device seed separately provides 19 byte-bearing assets across months and years, one video, the Tahoe album/place, and named people. The five structural journeys and their under-eight-minute aggregate budget are listed in the Photos table below; `photos-budget.md` owns the tighten-only response. Offline write/reconnect replay is a separate host-network reliability journey, not a sixth Photos UI flow — the web owner is `apps/web/tests/e2e/offline-reconnect.spec.ts` (an offline write survives a reload and settles exactly once on reconnect); the device-native airplane-mode variant is owned on Android by `flows/native-v0-resilience.mjs` under [#890](https://github.com/srikanth235/centraid/issues/890) W5, and the state VARIETY behind it moved down to `tests/integration-mobile/`.

### Photos scenario × layer contract (#716)

`U` is a pure/unit test, `C` is the RNTL/Vitest component file, and `E` is one named Maestro journey. A row owns one cheapest falsifying layer; `U + E` is intentional only where the claims differ (model arithmetic versus device gesture/runtime integration).

This table is the reference instance of the app admission contract above. It records the pure-model-beside-the-view, handler-contract, structural-exclusion, north-star-journey, shared-profile, and per-app budget conventions.

| Photos scenario | U | C | E | Owner / evidence |
| --- | --- | --- | --- | --- |
| drawer activity, hide timer, pinned summary grains | — | ✅ | ✅ | `PhotosHome.test.tsx`; `photos-library.mjs` owns recognizer-vs-sibling hit testing |
| scrub offset → month bubble | ✅ | ✅ | — | timeline-row/model units + native responder geometry |
| empty/loading skeleton geometry | ✅ | ✅ | — | skeleton row packing + rendered progress/grid geometry |
| Select word, role, disabled state | — | ✅ | ✅ | `PhotosSelectChip` semantics; select-write journey |
| search resting/no-hits and grouped album result | ✅ | ✅ | ✅ | search grouping units; no-hits component; `photos-search.mjs` |
| viewer mode chrome and filmstrip current item | ✅ | ✅ | ✅ | viewer models; top chrome/filmstrip component; `photos-viewer.mjs` |
| Collections shelves, empty/collapsed bodies, and menu commands | ✅ | ✅ | ✅ | collection model; shelf component; Photos device entry/drill-down |
| permission-refused behavior (empty-device takeover / seeded-vault continuity) | ✅ | ✅ | ✅ | access predicate/copy proves both branches; panel component and `photos-permissions.mjs` own the empty-vault takeover on a denied device grant |
| selection trash + restore write | ✅ | — | ✅ | write batch units; `photos-select-write.mjs` |

The five Photos device journeys use one gateway and paired profile and target **under eight minutes together per platform**. The denied-permission flow runs first against an explicitly purged vault; the next flow seeds the deterministic scenario for the remaining journeys through normal replica sync. The operational response to a budget breach lives beside them in [`photos-budget.md`](tests/agent-e2e-mobile/flows/photos-budget.md). Mobile offline write/reconnect replay belongs to a separate reliability journey because it requires host network control rather than a sixth Photos UI path. The contract is owned at its cheapest honest tier by `apps/web/tests/e2e/offline-reconnect.spec.ts`, over the same durable-outbox and intent-identity rails the phone uses; the device-native airplane-mode variant is owned on Android by `flows/native-v0-resilience.mjs` under [#890](https://github.com/srikanth235/centraid/issues/890) W5 — the device proves the native wiring once, and the state variety around it belongs to `tests/integration-mobile/`.

### Home-app device journeys (#839)

The seven non-Photos home seats have one Maestro suite, `home-apps` in [`tests/agent-e2e-mobile/roster.json`](tests/agent-e2e-mobile/roster.json): `docs-drive`, `agenda-week`, `notes-library`, `tasks-board`, `people-roster`, `tally-derived`, `locker-gate`. Its shape is the Photos suite's — the Docs journey pairs fresh, the remaining four run under `MAESTRO_REUSE_PAIRED_STATE=1` against that paired profile, and every journey writes an independent verdict even after an earlier failure, so a mid-run failure cannot grey the later cells. Tally's journey landed under [#873](https://github.com/srikanth235/centraid/issues/873); the [#831](https://github.com/srikanth235/centraid/issues/831) hold that once excluded it is over.

Each flow owns a claim the device is the only layer that can falsify — a React Navigation pop that a push would also render, two replica reads joined on the phone, a withheld Locker count that survives a real process restart — and the roster's per-flow assertions are the `tests/agent-e2e-mobile/README.md` device-only claims table.

The aggregate ceiling is twelve minutes across the seven, in [`flows/home-apps-budget.md`](tests/agent-e2e-mobile/flows/home-apps-budget.md), and it is a **first-land ceiling derived from the Photos suite's measured neighbour, not an observed distribution** — nothing in this suite has run on a device yet. The first nightly runs are what turn it into a measured budget: once three real runs exist the ceiling is re-derived from the observed p95 and **tightened**, under the tighten-only rule every other budget file follows. A budget nothing has ever approached is not a budget.

### The mobile roster and its rungs (#915 Wave 2)

**One document, one runner.** [`tests/agent-e2e-mobile/roster.json`](tests/agent-e2e-mobile/roster.json) is the single source for the device layer, and [`tests/agent-e2e-mobile/lib/roster.mjs`](tests/agent-e2e-mobile/lib/roster.mjs) is its only reader:

- `suites` — the ordered member list, the aggregate `budgetMs`, the `rungs`, the `platform`, the canary/reuse rules and the budget doc.
- `flows` — the claim, the `status` (`scheduled` / `promoting` / `exploratory`), the suites it belongs to and a per-journey marginal `budgetMs`.
- `lanes` — the workflow, the job id, the `rung` and whether the lane blocks.

One runner reads it:

```sh
node tests/agent-e2e-mobile/run-roster.mjs --rung <2|3|4|5> --platform <android|ios> [--suite <id>] [--dry-run]
```

It replaced seven `run-*-suite.mjs` files whose `const FLOWS` and `const BUDGET_MS` literals `lint:e2e-wiring`, `check:mobile-suite-budgets` and the report each parsed off disk in their own dialect, and none of which carried a rung. The six one-line shims that bridged the swap are gone with the last workflow that spelled their paths, so `run-roster.mjs` is the only runner on disk.

**The flags are the wiring, not a convenience.** `lint:e2e-wiring` derives what each lane schedules by reading the invocation the shipped workflow or shell script contains and resolving it through the roster. A runner selected by an environment variable would make every lane look identical to the gate whose whole job is telling a blocking lane from a nightly one — which is also why there is still one committed shell script per lane shape.

| Rung | Android | iOS | Warm budget |
| --- | --- | --- | --- |
| 2 merge (`ci.yml` `mobile-device-gate`) | `pr-gate` — `pairing-canary`, `notes-library`, `cold-start` | **none** (a #915 non-goal) | 8 min |
| 3 candidate (`candidate.yml`) | `resilience`, `home-apps` | `ios-smoke` — `pairing-canary`, `cold-start`, `notes-library` | 12 + 12 / 10 min |
| 4 nightly (`e2e.yml`) | `probes-suite`, `photos`, `home-apps`, `sharing`, `promoting-suite` | `ios-depth` | 35 / 8 / 12 / 5 / 16 / 25 min |

`sharing` is new only as a _suite_: `sharing-reach` already ran, as a bare `node …/flows/sharing-reach.mjs` line with no ceiling — the one journey on the roster nothing priced.

**Two ceilings, and they measure different things.** A suite's `budgetMs` is the aggregate wall clock `lib/run-suite.mjs` enforces as a deadline and prices the pairings the suite pays; a flow's `budgetMs` is its marginal cost with no fresh pairing in it. A suite's members may therefore sum past the suite's own number, and `validateRoster` refuses only a member that cannot fit its suite at all. Both are TIGHTEN-ONLY: `check:mobile-suite-budgets` reads the merge base's roster, then any suite named by `supersedes`, then the retired runner literal, so a ceiling cannot be laundered by moving it or renaming it. The p95-slack rule is unchanged and still dormant — `ledger/durations.json` holds zero records.

### The iOS shell cache (#915 Wave 2)

`mobile-ios-smoke` and `mobile-e2e-ios` restore a built `Centraid.app` keyed on the **native** fingerprint alone (`ios-shell-<os>-xc<toolchain>-fp<native>` — no `js` component), and [`apps/mobile/scripts/ios-simulator-install.sh`](apps/mobile/scripts/ios-simulator-install.sh) makes the JavaScript current instead of rebuilding: it re-exports this SHA's bundle into the banked `.app`, the "pay packaging, not compilation" path Android has used since [#905](https://github.com/srikanth235/centraid/issues/905). On a JS-only commit that is ~32 minutes of a 51-minute macOS job.

The injection runs **both** commands the Xcode build phase runs — `expo export:embed` and then `hermesc -emit-binary` — because `export:embed` emits plain JavaScript by design and Hermes will run it without complaint, which would leave every `cold-start` and `scroll-frames` number describing an engine path nobody ships. `hermesc` is banked beside the `.app` under the same key, and the injected bundle is asserted to carry the Hermes magic `0xC61FBC03`. Read [docs/traps/ios-shell-injection.md](docs/traps/ios-shell-injection.md) before touching any of it. The branch itself is `apps/mobile/scripts/ios-shell-cache.mjs`, with a unit suite: a wrong rebuild costs minutes, a wrong reuse reports green over another commit's JavaScript.

### A journey waits for the launcher, not for the band (#870)

`HOME_READY_MARKER` is the Home band's accessibility label, and the band renders over `DayOne` as well as over the launcher grid. A flow that waits only for it walks into an empty-vault Home and then fails on its own tile selector — which is exactly what the 2026-09-01 nightly reported twelve times: `Element not found: Open <App>`, naming the app, while the app was correct and the demo corpus had simply arrived after the phone cloned. `AWAIT_LAUNCHER` waits for `home-grid`, which `LauncherGrid` alone publishes, and `lint:e2e-flows`'s RULE `launcher-await` now requires it in every chunk that reaches a launcher tile. Flows that deliberately face an empty vault mark the chunk `# e2e-lint-allow: launcher-await — <reason>`.

A journey whose own script throws is a third failure class, `harness`: never retried, and stated as a defect in the flow rather than in the product.

## Five testing layers for the app axis (#725)

Eight apps do not imply eight copies of their shared machinery. The strategy mirrors the product architecture: **engines are tested once; apps are tested as deltas**.

### Layer 1 — engine law

Placement, custody, consent, triage, search, and enrichment each have one canonical matrix flow and named `[law:…]` ownership. Pure surfaces use property or contract tests and qualifying packages carry mutation seeds. An app joins an engine by passing its cell in `tests/claims.json#appEngines`; it does not restate that engine's behavior in an app-local suite. Every pass cell points to the canonical conformance gate. Every structural non-applicability is a `skip` with a reason and the [seat-doctrine contract](docs/blueprint-seats.md#engine-contracts) citation, never a gap disguised as health.

The recognition boundary law is especially strict: blueprint apps enqueue consent-scoped `enrich_request` rows and read vault projections, while bundled recognition automations alone own local model execution. The conformance gate scans web, native, and automation source for direct provider SDKs, obsolete service clients/endpoints, and generic `ctx.infer` / `ctx.enrich` calls.

### Layer 2 — app delta

A graduating app completes the [app admission contract](#app-admission-contract). Each claim names its cheapest falsifying layer: `U` for a pure model beside the view, `C` for React Native component semantics, or `E` for one named platform journey. `U + E` is allowed only when the two layers prove different claims. Vault-facing actions also have handler contracts. Structural exclusions follow the seat doctrine and are recorded as matrix skips rather than tests of impossible UI.

Byte-bearing apps own one north-star journey per platform and one tighten-only budget file beside their flows. Record-only apps share one representative replica write/read/offline journey until an app gains a genuinely app-specific native integration. Journeys in one platform run reuse a seeded `@centraid/test-kit/year3-vault` profile; a destructive/exclusive-state journey runs first and explicitly reseeds. PR workflows path-filter app journeys by the changed app directory. The suite wall-clock ratchet remains the global backpressure.

### Layer 3 — ML evidence ladder

Each tier makes a different claim. A higher tier does not retroactively turn judgement into a deterministic gate.

| Tier | What runs | What it proves |
| --- | --- | --- |
| **PR** | Injected handler-model fixtures plus pure tokenizer, CTC, NMS, PDF/OCR, DB postprocess, and geometry units | Handler contracts, typed vault content/invoke flow, consent gating, honest local-asset unavailability, image/PDF OCR behavior, and deterministic preprocessing/postprocessing without weights or native ML dependencies in the root install. |
| **Nightly** | Handler failure injection, scale rigs, and provenance/backfill selection properties | Volume correctness, drain invariants, failure isolation, and model-upgrade-as-backfill behavior. |
| **Weekly / release opt-in live** | `bun run --cwd packages/model-runtime setup`, then `bun run test:enrich:live` over pinned real weights and committed goldens | Actual tensor layouts and preprocessing: exact model pins, image/PDF OCR text with confidence/box tolerance, embedding cosine tolerance, face count/geometry tolerance, and lock/licence pin integrity. Run after model or preprocessing changes and before releases. |
| **Never a CI gate** | OCR recall, cluster purity, search relevance, and other model-quality judgements | Dogfood evidence, not product law. Findings belong to the D2 ritual in [`docs/photos/dogfood.md`](docs/photos/dogfood.md), not a pass/fail assertion. |

The weekly artifact has its own **eight-day freshness window** in the health report. An absent artifact renders grey/missing, never green; an artifact older than eight days renders stale. Scheduled failure or cancellation opens/updates the lane's tracking issue under the same response terms as the nightly SLA.

### Layer 4 — cost discipline

Per-app journey budgets are tighten-only and sit beside the flows they own, so an overrun has an addressable app owner. Pairing/import/seeding is paid once per platform through the shared profile. Exclusive-state flows run first and restore the deterministic seed for the remaining apps. PR-time path filtering runs an app's journey only when its app surface changes. Parallelism is by SUITE, not by dynamic shard: `probes-suite`, `photos`, `home-apps`, `sharing` and `promoting-suite` are declared units with declared budgets in [`roster.json`](tests/agent-e2e-mobile/roster.json), and their partition is statically readable by `lint:e2e-wiring` through `tests/agent-e2e-mobile/lib/roster.mjs`. A shard list computed at dispatch time would be faster to bin-pack and would make the schedule underivable by the very linter that exists to prove a flow is scheduled, which is the wrong trade. Re-cut the partition from the observed p95 in `tests/agent-e2e-mobile/ledger/durations.json` once it holds three real runs.

### Layer 5 — honest floors per app

A graduating app leaves the blended coverage floor and receives its own ratcheted scope. Photos was the first ([#725](https://github.com/srikanth235/centraid/issues/725)); [#839](https://github.com/srikanth235/centraid/issues/839) graduates **tasks, agenda, and notes**, so four apps now hold their own measured floors and the blend has shrunk to `_shared` plus `docs`, `locker`, `people`, `tally`. The blend shrinks as later graduation issues land; a well-tested app cannot subsidize another app forever. Graduation also re-seeds what remains: a blend held down for years by its weakest members measures far above its floor once they leave, and #839 re-seeded the shrunken blend from 20/14 to 41/33 on that basis. Any down-only reseed caused by splitting a denominator is an explicit approved deviation tied to the graduation issue; changing the _shape_ of a blended key is likewise recorded there, because the ratchet reads a renamed scope as a removal even when every tree it governed ends up floored higher.

The same rule reaches outside `packages/blueprints`. Mobile's **screens** are still ungated on purpose, but since #839 its extracted pure logic is not: `apps/mobile/src/lib/**` and the `*-model.ts` view models under `apps/mobile/src/**` each carry a measured floor. Those modules are the surface a device journey is worst at falsifying, so leaving them to journeys alone was the same subsidy in a different tree.

Property-style checks follow the normal `*.test.ts` convention and say `property` in the suite name. `.spec.ts` is Playwright-only.

Timeouts come in two tiers. Node projects — the `node:sqlite` ones, which bootstrap real vault/daemon layouts and are therefore fsync-bound — get a 30s default from the shared `nodeProject` preset in [`packages/test-kit/src/vitest.ts`](packages/test-kit/src/vitest.ts); the measurements justifying that number are in the comment there. jsdom projects do no disk I/O and keep Vitest's tight 5s default. The budget is sized for hosted-runner **disk latency variance**, which was measured at up to ~10x between two runner instances executing the identical command — not for v8 coverage instrumentation, which is enabled in the per-PR `ci` lane too. Files slower still than the node default escalate locally with `vi.setConfig` (the gateway CLI suites use 60s); do not add a per-test `timeout` option that sits _below_ its file's budget.

## Product tiers and coverage gates

The deeply gated engine is vault, client replica, gateway, app-engine, automation, backup, blueprints (including its co-located app sources), design (tokens + the kit runtime), agent-runtime, plus pure libraries tunnel, protocol, and cli. Renderer screens and mobile UI are covered by extracted logic plus journeys, not by a whole-surface line percentage. `packages/client/src/replica/**` is gated independently from `packages/client/src/react/**` for that reason — and since [#839](https://github.com/srikanth235/centraid/issues/839) the same split is made inside `apps/mobile`, where the extracted logic (`src/lib/**`, the `*-model.ts` view models) is floored while the screens around it are not. "Mobile has no coverage floor" was true until then; what remains true is that no floor covers a mobile screen.

Floors live in [`tests/floors.json`](tests/floors.json)'s `coverage` section and are consumed directly by the root Vitest config — that file, not this table, is the enforced contract. Floors are a conservative integer margin below the measured `bun run coverage` run that seeded them; most were seeded by the 2026-08-08 run (1,065 files / 11,719 tests **as of that run** — the suite has grown since, so treat the counts as the measurement's provenance, not a current census). A row whose floor was re-seeded by a later issue carries that issue's measurement instead, and says so.

| Scope | Measured lines / branches | Floor lines / branches |
| --- | --- | --- |
| repo-wide (`lines`) | 63.05 / — | **62** / — |
| `packages/vault/src/**` | 87.7 / 73.9 (#638) | **87** / **73** |
| `packages/backup/src/**` | 90.03 / 77.63 | **90** / **74** |
| `packages/core/src/blob/**` | — / — | **98** / **96** |
| `packages/blueprints/src/**` | 90.68 / 78.27 | **90** / **75** |
| `packages/blueprints/apps/photos/**` | 46.82 / 42.81 | **44** / **40** |
| `packages/blueprints/apps/agenda/**` | 42.27 / 32.47 (#839) | **40** / **30** |
| `packages/blueprints/apps/notes/**` | 41.05 / 29.47 (#839) | **39** / **27** |
| `packages/blueprints/apps/tasks/**` | 39.36 / 27.76 (#839) | **37** / **25** |
| `_shared` + non-graduated blueprint apps | 44.12 / 36.31 (#839) | **41** / **33** |
| `packages/model-runtime/src/**` | 68.01 / 51.44 | **66** / **49** |
| `packages/design/src/**` | 95.1 / — (#709) | **94** / **70** |
| `packages/server/src/engine/**` | 85.45 / 74.44 | **84** / **73** |
| former gateway dirs under `packages/server/src/` | 79.9 / 66.37 (#638) | **79** / **65** |
| `packages/core/src/time/**` | 84.5 / 67.0 | **82** / **65** |
| `packages/client/src/*.{ts,tsx}` | — / — | **78** / **65** |
| `packages/client/src/replica/**` | 76.82 / 63.37 | **75** / **62** |
| `packages/client/src/react/**` | 67.58 / 56.31 | **65** / **54** |
| `packages/server/src/automation/**` | 84.36 / 77.52 | **82** / **75** |
| `packages/tunnel/src/**` | 72.06 / 52.24 | **70** / **51** |
| `packages/server/src/acp/**` | 86.4 / 76.29 | **84** / **75** |
| `packages/cli/src/**` | 84.50 / 82.85 | **83** / **81** |
| `packages/core/src/protocol/**` | 100.00 / 98.59 | **98** / **96** |
| `apps/mobile/src/lib/**` | 58.12 / 50.65 (#839) | **56** / **48** |
| `apps/mobile/src/**/*-model.ts` | 88.62 / 74.26 (#839) | **86** / **72** |
| `apps/desktop/src/main/*-core.ts` | — / — | **96** / **89** |
| `apps/oauth-worker/src/**` | 90.65 / 84.23 | **88** / **82** |

Three rows read `—` rather than a number because the measurement that seeded them is not recorded in `tests/floors.json#coverage`; the floor is still enforced, and the next `bun run coverage` that touches those scopes is what fills the column in. `packages/vault` and the former-gateway scopes under `packages/server/src` carry the [#638](https://github.com/srikanth235/centraid/issues/638) re-seed (the #630 vault expansion diluted the older 88/80 seeds) and `packages/design/src` the [#709](https://github.com/srikanth235/centraid/issues/709) re-seed measured on CI verify run 30901194404; those provenance notes live in the JSON's `approvedDeviation`.

The #630 denominator expansion is an approved measurement deviation: the old 71% aggregate excluded 11,639 executable lines under `packages/blueprints/apps` and `packages/design/kit`. Issue #725 graduated Photos to its own scope, measured on the complete 2026-08-08 run with the down-only change from the old 17/12 blend documented in `tests/floors.json#coverage`. Issue #839 graduated tasks, agenda, and notes on a 2026-08-21 measurement and re-seeded what the blend still covers (`_shared`, `docs`, `locker`, `people`, `tally`) from 20/14 to 41/33; the mobile pure-logic rows were seeded by the same run. That run was path-filtered to the `packages/blueprints` and `apps/mobile` suites rather than the full unified pass, which can only under-measure — cross-package suites add coverage, never remove it — so every floor it seeded sits under a number the unified run would only raise. Real handler contracts and platform journeys own correctness while the line/branch floors ratchet upward from here. The `packages/model-runtime` scope covers recognition model/build sources; its live model lane is intentionally separate from PR coverage.

`bun run test` prints the active floors after package tests so the local loop never hides the CI contract; `bun run coverage` measures and enforces them. Floors move only upward (`bun run test:ratchet`).

### ACP coverage strategy

`packages/server/src/acp` keeps a **high branch floor (~85%)**. The line floor sat at the 27%-era seed long after measured coverage cleared it; the 2026-07-31 audit (#656) found sustained 86.4% lines, so the floor now follows the standard ratchet policy (two points under sustained level ⇒ **84**) — the "dedicated coverage campaign" the old note demanded had already happened.

Do **not** lower any engine floor in this table without an explicit issue + receipt. Prefer new pure modules (like `safe-stdin-write`) with unit tests over expanding spawn-heavy turn drivers for coverage alone.

## Named invariant contracts

These suites encode product law and are cataloged by name. The matrix validator also records their current minimum test count so a contract cannot silently shrink in CI.

1. Vault consent gateway and journalled writes — `packages/vault/src/gateway/gateway.contract.test.ts`
2. Backup/restore round-trip and fencing — `packages/server/src/backup/backup-service.contract.test.ts`
3. Blob custody / CAS state machine — `packages/vault/src/blob/custody-proven.contract.test.ts`
4. Replica convergence, intent identity, and multi-writer admission — `packages/client/src/replica/intents.contract.test.ts` and `packages/client/src/replica/multi-writer.contract.test.ts`
5. Handler validation and worker isolation — `packages/server/src/engine/handlers/handler-runner.contract.test.ts`
6. Control/device session boundaries — `packages/server/src/serve/web-control-sessions.contract.test.ts`
7. Scheduler no-backfill semantics — `packages/server/src/automation/fire/scheduler-ledger.contract.test.ts`
8. Conversation digest → archive → custody-gated prune — `packages/server/src/engine/conversation/archive/archive.contract.test.ts`
9. Pending-write projection, seat parity, settlement, and exclusions — `scripts/lint-engine-conformance.test.mjs`, `packages/blueprints/apps/_shared/pending-overlay.test.ts`, and `packages/client/src/replica/intents.contract.test.ts`

Generated-state properties cover blob custody and replica intent idempotency. The replica admission contract owns the multi-tab/same-id writer race.

## Shared test infrastructure

`@centraid/test-kit` is a private, source-exported workspace package. Use it for:

- `tempDir()` / `tempDirSync()` with automatic test-file cleanup;
- `useFakeClock()` with automatic real-timer restoration — the leak it prevents is expensive, because fake timers left installed by a test that threw before its `afterEach` make the _rest of the file_ fail as timeouts rather than as the leak;
- `seededRandom()` for deterministic draws;
- `bootstrappedVault()` — the kit's vault fixture, and the seam lint points every `mkdtemp` vault bootstrap at it;
- node and jsdom+JSX+CSS-module Vitest presets;
- the recording automation-handler rails shared by recognition and published connector/enricher source suites;
- deterministic parties, photos, conversations, turns, and blob custody volume fixtures;
- perf/scale JSON result emission.

Do not add another local helper when the shared package already owns the seam — for `mkdtemp`, fake timers, and `Math.random` this is enforced by lint, not left to review (see [Test-kit seams](#test-kit-seams-656-layer-4)).

One factory sits outside the kit, in [`tests/helpers/factories.ts`](tests/helpers/factories.ts), because it resolves workspace TypeScript entries directly for the root perf/scale/quality projects. `createTestVault()` builds a bootstrapped on-disk vault over the kit's `bootstrappedVault()` and is the owner of that seam for those projects. A suite needing a real wire uses the [protocol join lane](#protocol-join-lane-839) instead of a local gateway factory; the listener-free `buildTestGateway()` that used to sit beside `createTestVault()` was retired unused in [#915](https://github.com/srikanth235/centraid/issues/915).

Deterministic automation fires need no mock: their handlers run in-process against the parent-side `ctx.vault` / `ctx.fetch` / `ctx.state` rails, and only `ctx.delegate` reaches a provider. In tests that provider turn is faked through the ACP fake-harness fixture (`packages/server/src/acp/backends/acp/fake-acp-harness.mjs`), the same seam conversation turns use — there is no automation-specific mock LLM (the `@centraid/mock-llm` package was removed with the `ctx.tool` rail).

## Lane schedule and commands

| Command / workflow | Contents |
| --- | --- |
| `bun run check:pr` | **Before every push:** `bun install --frozen-lockfile`, then `check:push` — the 17-gate deterministic set (38 sub-second contract gates ride inside the one `lint:product` bundle) driven by [`scripts/ci/run-gates.mjs`](scripts/ci/run-gates.mjs), whose argument list in `package.json` is the authoritative enumeration — plus `typecheck`, `lint:types`, `lint:workflow-pins`, and `check:diff-coverage`. Do not restate the gate list here; read the script's arguments. Vitest alone is not a substitute. |
| `bun run check:full` | `check:pr` plus affected dependents, unified coverage, affected mutation/perf, and desktop/web e2e. Required before requesting merge when shared infrastructure changed. |
| `bun run test` | package unit + integration + contract tests; prints floors |
| `bun run test:affected` | vitest for packages changed since `origin/main` (`turbo --filter='[origin/main]'` — changed packages only; dependents stay on full CI `verify`) |
| `bun run test:affected:full` | vitest for changed packages **and dependents** (`turbo --filter='...[origin/main]'`) |
| `bun run test:ratchet` | coverage floors + `minimumTests` + mutation floors up-only, and perf budgets tighten-only, vs `origin/main` |
| `bun run lint:ledgers` | the four merged ledgers: direction per section, per-section waiver scope, issue-and-expiry, and the two derived mirrors, vs `origin/main` |
| `bun run test:ratchet:unit` | Unit tests for the ratchet / diff-coverage pure functions (`scripts/test-report/vitest.config.ts`) |
| `bun run test:diff-coverage` | changed instrumentable lines vs merge base must be ≥ **80%** covered (`coverage-final.json`); CI `verify` after `coverage` |
| `bun run test:mutation` | StrykerJS on all twenty-four property-defended seeds (nightly); writes `artifacts/mutation/scores.json` |
| `bun run test:mutation:pr` | Per-PR: Stryker on **affected** seeds only + enforce mutation floors |
| `bun run test:fuzz` | full seeded fuzz lane over the six parser targets (nightly); writes `artifacts/fuzz/summary.json`. `test:fuzz:smoke` is the seconds-per-target variant |
| `bun run test:fuzz:replay` | replay every committed crasher and the whole seed corpus (`scripts/fuzz/vitest.config.ts`); needs `bun run build` first |
| `bun run test:join` | the protocol join lane with a JSON report at `artifacts/join/summary.json`; raise `CENTRAID_JOIN_SEATS` to widen it |
| `bun run test:perf:pr` | Per-PR: gateway low-end budget gate (also verify CI step) |
| `bun run test:suite` | the uninstrumented serial suite, plus the suite wall-clock ceiling it alone can measure (`candidate.yml` **suite** job, rung 3 — moved off `verify` by the rung-2 ceiling, #915); on the merge gate the sharded `coverage` pair is the pass/fail answer |
| `bun run coverage` | unified suite + v8 report + floor enforcement, one runner (nightly, and local) |
| `bun run coverage:shard` | one quarter of the suite under `vitest.shard.config.ts`, blob report only (`ci.yml` **coverage-shard** matrix) |
| `bun run coverage:merge` | refuses a partial blob set, then merges and enforces every floor (`ci.yml` **coverage** job) |
| `bun run test:claims` | claims-file, nightly-wiring and release-wiring validation (also inside `check:pr`) |
| `bun run lint:evidence-mapping` | every `Write lane evidence` step names a registered lane |
| `bun run test:perf` | hot-path budget tests; nightly only |
| `bun run test:scale` | deterministic volume tests; nightly only |
| `bun run test:report` | build `dist/test-report/index.html` (+ `summary.json` / `summary.md`) from available evidence |
| `.github/workflows/ci.yml` (rung 2) | parallel **static** + **gates** + **verify** + **coverage-shard**×4 → **coverage**, plus **new-test-burn-in** and a one-leg **mobile-device-gate**; required **check** aggregator (ruleset-required), which also enforces the `pr-gate` wall-clock budget; **publish-report** on main only; Bun/Turbo/Cargo caches. `governance.yml` is kit-managed and rolls up into NO aggregate — it needs its own required-check entry (see [docs/decisions.md](docs/decisions.md#the-pr-gate-loop-892)) |
| `.github/workflows/candidate.yml` (rung 3) | push to `main`: **mobile-canary-android** (the `resilience` + `home-apps` suites + the native-shell prebuild the PR device gate restores from), **mobile-ios-smoke** (the `ios-smoke` suite on the fingerprint-cached iOS shell), **web-e2e-linux**, **desktop-e2e-linux**, **desktop-e2e-macos**, **lane-gateway-package**, **mutation-full**, **codeql**, **rust-supply-chain**; then **promote** — on green it moves `refs/candidates/latest`, writes `artifacts/candidate.json` and publishes `test-report/candidate.json`; on red the pointer stays put and each red lane's `[candidate] lane red — <lane>` issue is rewritten. **lane-health** scores the rung-3 rules table afterwards |
| `.github/workflows/e2e.yml` (rung 4) | on the **promoted candidate**: desktop, web, cross-browser web, the full Android mobile roster + the iOS depth roster, pairing, perf, scale, **mutation**, **fuzz-parsers**, **protocol-join**, full report → **publish-nightly-report** on main only; every red lane gets one rolling `[nightly] lane red — <lane>` issue, rewritten in place |
| `.github/workflows/mobile-alarm-test.yml` | weekly (Sun 03:00 UTC): the rung-2 `pr-gate` suite against a deliberately blanked Home, **required to fail**; a green suite there fails the job |

A gate that runs only in `check:push` is a gate nobody can be required to pass: it is skippable by pushing without it, and a broken `main` cannot be attributed. CI's `gates` job exists to close that hole — it carries the deterministic design/governance gates (reachability, the design-token/mobile-design/logical-insets/hairline/aria-label/container-opacity/type-floor/motion-rule linters, `lint:design-md`, engine-conformance, law-registry, quality-knobs, schema-export, `check:ui-receipt`, `test:quarantine`) and feeds the required `check` aggregator; `test:qualities` rides `verify` because it needs `bun run build` first. **`design:gallery`** now has its own path-gated CI job (`design-gallery` in `ci.yml`) that installs the pinned Playwright browser; since [#799](https://github.com/srikanth235/centraid/issues/799) it builds `apps/web` and photographs the shell’s own `#ui-preview` gallery with the product’s self-hosted faces, and the baselines are Linux-captured, so whether darwin `check:push` agrees with them is the open question the job’s comment records (#781). **`check:mobile-native-state`** is deliberately absent from `gates`: CI's `mobile-smoke` runs the identical `apps/mobile ci:native-state` command on a strictly wider path filter (root dependency drift triggers it where the local check's `apps/mobile/**` filter would not — #587 E22), so the delegation is complete, not a hole. `check:pr` remains a superset of CI in one further respect: it runs `test:affected`, where CI runs the full vitest suite on `verify` (uninstrumented) and again across the `coverage-shard` matrix (instrumented) instead.

### Test-health report (main + nightly)

Public HTML publishes only from **main** (per-merge `ci`) and the **nightly** e2e workflow — not from pull requests. Every `verify` / nightly report job still writes a Job Summary and uploads the `test-health-report` artifact for that run.

| Slot | URL |
| --- | --- |
| main | `https://srikanth235.github.io/centraid/test-report/main/` |
| Nightly (newest — **mutable**, moves every night) | `https://srikanth235.github.io/centraid/test-report/nightly/` |
| A specific nightly (**immutable**, HTML kept 30 deep) | `…/test-report/nightly/runs/<date>-<runId>/` |
| Landing | `https://srikanth235.github.io/centraid/` |

Cite the dated slot when linking a report from an issue or a PR; the `nightly/` alias is only correct for "whatever ran most recently". The full run series (never pruned, even after its HTML is) is `…/test-report/history/index.json`.

Performance and scale budgets use generous regression multipliers. A noisy budget is fixed or removed; it is never promoted to the per-PR loop. Lane results are JSON under `artifacts/perf` and `artifacts/scale`; the nightly workflow restores and appends their bounded cross-run history before the combined report is published. Coverage, desktop Playwright, web Playwright, performance, and scale commands stamp distinct lane-start markers: a cached result not refreshed by that invocation turns grey immediately. Vitest, Playwright, agent-e2e, performance, and scale evidence all carries a capture time and expires after 36 hours. This staleness signal exists because a nightly-only suite rots silently: #458 found the entire desktop Playwright suite red after the React/CSS-modules migrations — hard-coded selectors like `.cd-sb-item`, `.ctx-menu`, and `.modal-card` had all gone dead, exactly the #225-class silent rot — while the per-PR loop stayed green. Grey (or expired) evidence in the report is the standing guard against that class of drift.

The full nightly has a stricter contract than a PR/main report: **no silent absence**. Every registered lane must write evidence, and a lane that does not renders `no evidence` in every cell it claims rather than disappearing from the page — a gating lane that says nothing degrades the night's verdict, and a night in which nothing reported is a HOLD. PR/main reports carry `no evidence` on the nightly-only lanes by design. An `n/a` cell is a claim the [`tests/claims.json`](tests/claims.json) register says cannot arise, with the reason and the date it was last re-read; anything else missing is a lane to wire or a claim to own. Performance harnesses live in `tests/perf/`, scale rigs in `tests/scale/`, and both write `recordQualityResult` evidence whose `OWNER` matches a derived flow owner exactly.

### Quality-dimension decisions (#587 D21)

- **Supply chain:** accepted as a cross-cutting gate, not a matrix column. The lockfile linter and dependency-review job already own it; duplicating the same result 15 times would imply per-surface evidence that does not exist.
- **Bundle/app weight:** accepted for a follow-up lane and tracking issue. Desktop, web, and mobile have materially different artifacts and need measured baselines before budgets can be honest.
- **Accessibility:** accepted for a follow-up lane and tracking issue. It belongs in the matrix because failures are surface-specific; the first work should establish web/desktop automated coverage and the mobile device path.

The report also consumes `QUALITY.md`'s `## Open` section so field-observed problems sit beside laboratory evidence instead of living in a separate, unseen ledger.

### Mobile liveness and native consistency (#587 E/F)

A green mobile unit lane proves correctness of the code paths it executes; it does **not** prove that Metro can transform/resolve the app or that either native project builds. Expo/React Native peer ranges can accept incompatible major Babel versions at install time. The required PR `mobile-smoke` job is the compensating control: it runs Expo's compatibility check as an advisory, then requires iOS and Android Metro exports plus compilation of the Android application and its native modules to succeed. `expo install --check` currently catches Expo's bundled-native-module version drift, but it does not model the Babel-core/runtime constraints that broke #565 or Kotlin members added by a new Expo Module base class. Metro catches the transform-time and resolve-time failures; the Kotlin compile catches native source/API collisions.

Dependabot continues to propose production major-version updates. Patch and minor updates stay grouped for noise control; each major arrives in its own PR so the test suite can identify precisely which upgrade works and which one breaks a compatibility contract. A failing gate is evidence about that proposed upgrade, not a policy that majors are forbidden.

The same job verifies the committed iOS Pod lock against resolved Expo and React Native, including `React-Core`, `React-Core-prebuilt`, `ReactNativeDependencies`, and Hermes; rejects machine/worktree-shaped native paths; and compares both platforms with `apps/mobile/native-fingerprints.json`. A native dependency, SDK, config-plugin, or generated-project change therefore requires an explicit fingerprint rebaseline after reviewing the native diff. The fingerprint hashes the Iroh tag and separate framework/Swift checksums in `CentraidTunnel.podspec`, not its git-ignored reconstructed framework and Swift binding; running CocoaPods must not change the same checkout's native input identity. The app bundles no maps SDK, so no map-package path is excluded; the native map stack arrives with its first real imports under [#816](https://github.com/srikanth235/centraid/issues/816) and will need its own fingerprint rebaseline then.

The nightly iOS lane runs on `macos-26` and selects Xcode ≥26.4 before the build. Expo SDK 57's `expo-modules-jsi` declares `swift-tools-version: 6.2` and documents Xcode 26.4+ (Swift 6.3); `macos-15`'s default Xcode 16.4 satisfies React Native's 16.1 floor but fails the JSI xcframework step with exit 65 and an empty "Could not resolve package dependencies" footer (run 30417451436). `apps/mobile/scripts/check-xcode-minimum.mjs` takes the max of React Native's helper minimum and that ExpoModulesJSI floor so a future image roll that drops below 26.4 fails as an `infra-mismatch` before the cold build.

Android decisions mirror iOS where the artifact exists: Android uses the same fingerprint ratchet and path-safe `require.resolve` project configuration. There is no separately committed Android dependency-resolution lock equivalent to `Podfile.lock`, so F26 is structurally N/A there; Gradle resolves against the root Bun install, Metro smoke, and PR-time tunnel-module compile. The nightly Android toolchain remains separately pinned by its JDK/Gradle setup; unlike iOS, React Native exposes no single checked-in minimum-host-version contract to compare before Gradle configuration, so E24's explicit minimum-version preflight is iOS-only.

## Unified report

The nightly report is **Night Watch**: one page that answers three questions in order — _can we ship the candidate_, _what changed since the last one_, _who owes what by when_ — and treats everything below that as evidence for one of the three. It is a single self-contained HTML file at `dist/test-report/index.html`, both themes, no runtime fetches, with the product's tokens lowered from `@centraid/design` by [`scripts/site-tokens.mjs`](scripts/site-tokens.mjs). Ruling: [docs/decisions.md](docs/decisions.md#night-watch-v2-915).

### The evidence contract

The page is a **pure function of a directory**. Every lane on rungs 2–5 ends with a `Write lane evidence` step that calls [`scripts/test-report/write-evidence.mjs`](scripts/test-report/write-evidence.mjs) with `if: always()`, writing one `artifacts/evidence/<lane>.json`:

```json
{
  "schema": 1,
  "lane": "mobile-e2e-ios",
  "rung": 4,
  "platform": "ios",
  "candidate": "<sha>|null",
  "startedAt": "<ISO>",
  "finishedAt": "<ISO>",
  "verdict": "passed|failed|parked|no-evidence",
  "budgetMs": 0,
  "durationMs": 0,
  "cases": [
    { "id": "locker-gate", "verdict": "failed", "durationMs": 0, "attempts": 3 }
  ],
  "parked": { "until": "YYYY-MM-DD", "issue": 870 },
  "tags": { "qualities": ["journey"], "surfaces": ["mobile-native"] }
}
```

[`evidence-schema.mjs`](scripts/test-report/evidence-schema.mjs) validates it on write and on read; a malformed file is an error the page prints, never a file that is silently dropped. The writer downgrades a `failed` verdict to `parked` by itself when the lane has an unexpired entry in `tests/quarantine.json#lanes`, so a park is a date on the debt rather than a mute.

**The cell vocabulary is exactly four words plus `n/a`**: `passed`, `failed`, `parked`, `no-evidence`, and `n/a`-with-a-reason. There is no "flaky", no "stale", no "partial" — a run either falsified the claim or did not. A lane that declares `tags.qualities × tags.surfaces` and then writes nothing renders **no evidence** in every cell it claims. Evidence naming a lane the claims file does not register is a rung-2 lint failure (`bun run lint:evidence-mapping`), not a banner on the page.

### The claims file, and what is derived

[`tests/claims.json`](tests/claims.json) replaced `tests/claims.json`. It holds **only what a machine cannot derive**:

- the `vocabulary` — 11 qualities × 10 surfaces — that §7 joins lane tags against;
- the **lane registry** (`id, rung, platform, budgetMs, qualities[], surfaces[], status`), which is the list of lanes the page has a row for;
- the 45 **claim rows** (the retired user-facing qualities panel), each with a declared severity `S1`–`S4` and the date it was last demonstrated red;
- the law registry, the consent ledger, the join laws, the app-seat / app-state / app-scenario registries;
- the deliberate **n/a cells** with their reasons and their 183-day re-verification date (`bun run check:na-cells`);
- the revisit triggers, and the flow ownership + `minimumTests` floors.

Everything observable is derived at read time by [`derive.mjs`](scripts/test-report/derive.mjs): journeys and their tighten-only suite budgets from [`tests/agent-e2e-mobile/roster.json`](tests/agent-e2e-mobile/roster.json), mutation seeds from [`scripts/mutation/seeds.mjs`](scripts/mutation/seeds.mjs), fuzz targets from [`scripts/fuzz/targets.mjs`](scripts/fuzz/targets.mjs), the Vitest projects from `vitest.config.ts`, the Stryker configs by glob, and the rig and experience budgets from their ledgers. `bun run test:claims` validates the file, holds every owner path to disk, and pins the app-axis registries to the code they name.

Flow ownership no longer lives in one file, so the constitution's `coverage-scope-reachability` directive reads the derived view instead: `node scripts/test-report/derive-flows.mjs --json`.

### The page, section by section

| § | What it answers | Source |
| --- | --- | --- |
| §0 masthead + verdict lamp | can we ship? | the lane board, over **unparked** lanes |
| §1 blockers | what is holding it | S1/S2 reds, with first-red and last-green candidates |
| §2 since yesterday | what changed | tonight's evidence against the previous night's directory |
| §3 attention queue | who owes what, oldest first | one row per lane, each with a concrete deadline |
| §4 lane health board | the promotion and demotion rules | 30-run history, pass rate, p95 vs budget, last green |
| §5 journeys | every committed flow and its cost | the roster's suites and their budgets |
| §6 coverage grid | what the product is proven to do | app × platform, three modes |
| §7 promises × surfaces | which promise has evidence where | the join of lane tags with tonight's verdicts |
| §8 adversaries | what the author did not write | mutation seeds, fuzz targets, engine property flows |
| §9 trends | what is drifting | series with ≥ 14 candidates, trailing-30 IQR band |
| §10 evidence | the ratchets and registries | floors, consent ledger, join laws, inventory, parks, QUALITY.md |
| §11 how to read this | the vocabulary and the contract | the glossary, the tab map, the `evidence.json` shape |

The verdict is `HOLD | DEGRADED | SHIPPABLE`, computed over unparked lanes: **HOLD** on any S1/S2 red, more than 3 parks, a park older than 30 days, or a night in which nothing reported at all; **DEGRADED** on S3/S4 reds, a series outside its noise band, a lane whose p95 walked past its rung budget, or a gating lane that wrote nothing; **SHIPPABLE** otherwise. Parked and no-evidence lanes never count as red. The lamp carries one sentence of why and the single change that would flip it.

### Wiring

`generate.mjs` is a CLI shell: [`collect.mjs`](scripts/test-report/collect.mjs) reads, [`read-model.mjs`](scripts/test-report/read-model.mjs) builds the model with no I/O, and [`render/`](scripts/test-report/render) draws it. `bun run test:report:smoke` renders the committed fixture root at `scripts/test-report/fixtures/` and asserts every section §0–§11 with zero validation errors, plus a second root where the only evidence is a park. The per-lane rolling issue is rendered by [`rolling-issue-body.mjs`](scripts/test-report/rolling-issue-body.mjs) from the same attention-queue model, so the issue body and §3 cannot disagree.

Publishing is unchanged in shape — a mutable `nightly/` alias plus an immutable `nightly/runs/<date>-<runId>/` — and the immutable copy now also carries the `evidence/` directory that produced it, so the next night can compute a candidate-to-candidate delta. `summary.json` carries `{schema, verdict, why, flip, blockers[], deltas{}, parks[], candidate, generatedAt, lanes{}}`; [`history-point.mjs`](scripts/test-report/history-point.mjs) is the read boundary for the durable series and reads every #915 field as null or empty on nights recorded before it.

### Issue #679 lane and fixture decisions

- First-run remains **path-gated on PR and unconditional nightly**. Making desktop, web, and two native device journeys unconditional would exceed the tighten-only PR wall-clock budget; the quality row therefore renders partial when those lanes did not run, never green. Mobile offline writes and reconnect replay are defined product behaviour under the single-gateway topology in [`docs/mobile-offline.md`](docs/mobile-offline.md), so R2 is a testable reliability contract rather than a new product design.
- `@centraid/test-kit/year3-vault` owns the deterministic seed, multi-year/ledger/sealed/parked profile, and cache key used by quality and scale rigs. Byte-heavy owners materialize their own CAS payloads from that identity; never copy a live SQLite file into a cache. Regenerate by changing the explicit fixture version/seed and rerunning the owning rig, after reading [`docs/traps/wal-checkpoint.md`](docs/traps/wal-checkpoint.md).
- `bun run test:qualities` is the deterministic PR gate. Timing evidence remains in nightly perf/scale and uses the existing rig-drift and `tests/journeys.json` owners rather than a parallel budget file.

## The test convention

Every test in this repo follows these rules. They are objective enough for an agent to self-check and for review to enforce.

- **Behaviour over implementation.** Assert observable outcomes — return values, persisted state, emitted events — never that a private helper ran or a mock was called. If the refactor is behaviour-preserving, the test must still pass.
- **Real deps; fake only at the edges.** Use the real sqlite, real workers, real modules. Fake only what is non-deterministic or external: clock, network, fs randomness. The backend already does this; keep it the default.
- **One behaviour per test.** A test names a single behaviour and asserts it. No grab-bag tests that drift into asserting incidentals.
- **Assert outcomes, not mock calls.** `expect(result).toEqual(...)`, not `expect(mock).toHaveBeenCalled()`. A `toHaveBeenCalled` assertion is a smell — justify it or replace it with an outcome assertion.
- **Deterministic.** No real time (`Date.now()`/timers — inject or fake), no real randomness, no network. No committed `.only`. A test must pass on every run.
- **Clear failure output.** A failing test must say _what_ broke without a debugger. Prefer specific matchers and meaningful expected values over `toBeTruthy()`.

When in doubt, apply the adversarial check: _could the code be wrong and this test still pass?_ If yes, the test is not yet meaningful.

### ultracite vitest preset (#573)

The convention above is now mechanically enforced where it can be: as of #573 the repo lints test files with **ultracite's `vitest` oxlint preset**, on top of the `core` + `react` presets it already composed. Wiring and caveats:

- **It is spliced, not extended.** The preset delivers every rule through a single `overrides` entry, and an extended preset's overrides outrank the consumer's — so `extends: [vitest]` would leave no way to scope it. Its override is therefore spread into `overrides` in `oxlint.config.ts` verbatim (same rules, same `**/*.{test,spec}.*` glob); only the ordering is ours. This is what makes the two scoping decisions below expressible at all. Partial adoption is otherwise impossible: you cannot turn one of its rules off from the top-level `rules` block the way the core/react opinions are pinned.
- **Playwright e2e is out of scope.** The preset's glob also matches `apps/*/tests/e2e/**.spec.ts`, which are Playwright, not vitest. Left in scope, `prefer-importing-vitest-globals` autofixes a `from 'vitest'` import on top of the `@playwright/test` one and the files stop parsing. A later override turns the `vitest/*` rules off there. This is about which runner owns the file, not about opting out of a rule.
- **`prefer-to-be-truthy` / `prefer-to-be-falsy` are off.** They are the only two rules in the preset that contradict the convention above — `expect(x).toBe(true)` asserts `x` is exactly `true`, `toBeTruthy()` also passes for `1`, `'x'`, `[]`, `{}`. Autofixing them over this suite rewrote 1,117 `toBe(true)` and 720 `toBe(false)` into strictly weaker assertions, so they stay off and `toBe(true)` / `toBe(false)` remain the house style. What the lint cannot do, the count gate does: the standing total of `toBeTruthy` / `toBeFalsy` sites is a down-only budget under the [assertion-hygiene ratchet](#assertion-hygiene-ratchet-781), so the convention is enforced by direction of travel rather than by an autofix that would have weakened 1,837 assertions to buy it.
- **`prefer-strict-equal` rewrites were hand-reviewed.** The autofix converted 2,436 `toEqual` call sites to `toStrictEqual`, which additionally compares prototypes, `undefined`-valued keys, and array sparseness. Every test the rewrite broke was fixed by tightening the assertion, never by reverting the matcher.
- **Null-prototype rows.** `node:sqlite` returns rows as null-prototype objects, so `expect(stmt.get()).toStrictEqual({ … })` fails against an object literal even when every column matches. The house fix is to spread the actual — `expect({ ...stmt.get() }).toStrictEqual({ … })` — which compares the column data (the contract) without asserting the driver's choice of prototype, and keeps strictness over keys and values. Do not reach for `toEqual` here.
- **`prefer-called-with` autofixes are unsound.** It rewrites `expect(fn).toHaveBeenCalled()` to `expect(fn).toHaveBeenCalledWith()`, which asserts the mock was called with _zero_ arguments. Comply by naming the real arguments, which is what the rule is actually asking for — and what the convention above wants anyway.
- **`valid-expect` is configured with `maxArgs: 2`.** The rule defaults to jest's signature; vitest's `expect` takes an optional second argument, the message printed on failure — `expect(res.status, JSON.stringify(body)).toBe(400)`. Complying with the default would mean deleting those messages. Reach for that second argument when a bare boolean assertion would otherwise print nothing useful — comparing two ordered strings, say, where `toBeGreaterThan` cannot be used because it only accepts a number or bigint:

  ```ts
  expect(a > b, `${a} > ${b}`).toBe(true);
  ```

- **`prefer-import-in-mock` is a type upgrade, so expect fallout.** Rewriting `vi.mock('m', factory)` to `vi.mock(import('m'), factory)` makes vitest typecheck the factory against the real module. That caught 53 mock factories whose stand-ins did not match the module's real types (most often because `Parameters<typeof x>` captures only the _last_ overload of an overloaded export). Fix the factory rather than reverting the form; assert on the single offending property, never the whole module. Two further notes: drop any now- redundant `importOriginal<typeof import('m')>()` type argument, and be aware that the typed form pulls the target into the TS program — for a module outside the package's `rootDir` that breaks typecheck, which is why `packages/blueprints/src/photos-media.test.ts` carries the repo's one justified suppression of this rule.
- **`prefer-describe-function-title` can produce invalid code.** It swaps a string title for a same-named import without checking that the import is callable, so `describe('WAL_CAPTURE_ORDER', …)` became `describe(WAL_CAPTURE_ORDER, …)` — `describe` takes a string or a function, so that fails typecheck. Title such blocks in prose instead. Three sites hit this, and only `typecheck` catches it: the tests still _run_.

### Diff coverage (#532)

After `bun run coverage`, CI `verify` runs `bun run test:diff-coverage`. It intersects `git diff origin/main` added lines (instrumentable `packages/*` / `apps/*` / `tools/*` sources plus the co-located blueprint app/kit runtimes) with Istanbul/v8 `coverage/coverage-final.json`. Threshold is **80%** of changed instrumentable lines. Failures name uncovered hunks. Waive with a non-empty `approvedDeviation` in `tests/diff-coverage-deviation.json` (constitutional exception — temporary).

### Mutation testing (#532)

Nightly StrykerJS (`@stryker-mutator/vitest-runner`) on 24 property-defended seeds, including the recognition handlers' tokenizer/CTC/NMS pure-math seed. The canonical seed list is [`scripts/mutation/seeds.mjs`](scripts/mutation/seeds.mjs); examples of its engine scopes include:

- `packages/vault` (custody)
- `packages/client/src/replica` (intents + payload-hash)
- `packages/server/src/automation` (scheduler ledger)
- `packages/backup` (AES-GCM seal + WAL address keys)
- `packages/core/src/blob` (CBSF directory codec)
- `packages/core/src/protocol` (handshake judge)
- `packages/tunnel` (wire frame / pair QR / sanitize)
- `packages/server/src/engine` (pricing cost formula)

Package-local Stryker configs (`stryker.config.mjs` + `vitest.mutation.config.ts`) mutate the property-defended modules. [`scripts/mutation/seeds.mjs`](scripts/mutation/seeds.mjs) is canonical for where each seed's config lives: the runner resolves `seed.cwd` + `seed.config` and spawns Stryker there. The eight root pointers formerly under `tests/mutation/` were deleted in #842 W0.6: they indexed only eight of the twenty-four seeds and were read by nothing. `scripts/mutation/seeds.mjs` is the only catalog — do not add a pointer file expecting it to run. `bun run test:mutation` writes `artifacts/mutation/scores.json` for the test-health report. Floors live in `tests/floors.json#mutation` and ratchet up-only (measured 2026-07-23/24 — see file comment).

### The golden-vault gate, and the invariant sweep

Migration tests replay the ladder over vaults the running build just created, which proves the ladder is self-consistent and says nothing about the file a member has had on disk since the last release. [#892](https://github.com/srikanth235/centraid/issues/892) closes that:

- **Golden vaults.** `packages/vault/tests/golden/<label>/` holds a populated vault frozen by a release (`bun run golden-vault:freeze -- --label <v>`). `packages/vault/src/golden-vault.test.ts` runs on the PR loop: it inflates each corpus into a scratch dir, opens it — which runs today's migration ladder — and requires every frozen row to survive with its values intact. A dropped row and a rewritten value are failures; a **retired column** is its own class, and the remedy is to re-freeze the corpus in the release that retires it, never to loosen the comparison. **Freeze one per release**: a corpus frozen by today's tree is only prior-release evidence tomorrow.
- **`vault doctor`.** `vaultDoctor` / `assertVaultTreeHealthy` (`packages/vault/src/doctor.ts`) checks page integrity, foreign keys, the polymorphic `(type, id)` pointers SQLite cannot enforce (walking [#441](https://github.com/srikanth235/centraid/issues/441)'s own registry, so the sweep and the purge can never disagree about the set), and blob custody accounting. It is read-only and runs at teardown in `tests/integration-mobile/lib/gateway.ts`. **Call it from any harness that boots a real gateway** — it is what turns thousands of existing writes into a data-corruption detector for the cost of a few PRAGMAs.

### Deny by default

`packages/server/src/serve/authz-deny-matrix.test.ts` enumerates `ROUTES` from `@centraid/core/protocol` and requires every entry to refuse an anonymous caller, a bearer the gateway does not honour (the wire signature of a revoked pair and an expired grant alike), and — on the gateway-wide admin surfaces — a proved device. A route escapes only through `DELIBERATELY_PUBLIC` with a stated reason, so **a new route without a grant check cannot pass by omission**. Its hand-written sibling `authz-matrix.smoke.test.ts` keeps the deeper per-route claims; this one keeps the surface honest.

**Per-PR mutation** (`bun run test:mutation:pr` / CI job `mutation-pr`): runs Stryker only for seeds whose `watch` paths intersect `git diff origin/main...HEAD` (or all seeds when the mutation runner, the seed catalog or the floors change), then **enforces** floors on measured packages. Unrelated PRs skip Stryker in ~1s.

`MUTATION_GLOBAL_WATCH` deliberately does NOT list `package.json` or `bun.lock` ([#892](https://github.com/srikanth235/centraid/issues/892)): watching them made any dependency bump run every seed inside the PR loop at ~19 minutes, which is what made this lane bimodal. **Two tiers own the full set instead** — `mutation-canary` (ci.yml, per merge to main, outside the required `check`, so a regression is attributable to one commit with nobody waiting on it) and the nightly `mutation-testing` lane (which catches a seed that rots without any commit touching its watch list).

#### Seeds beyond the engine (#839)

Eight of the twenty-four seeds are not engine packages. [#839](https://github.com/srikanth235/centraid/issues/839) carries the adversary into the blueprint **app** layer — `tasks`, `notes`, `agenda`, and the `_shared` pending-overlay, selection, triage, and search-scaffold modules — and into the phone's extracted logic under `apps/mobile/src/lib`. Those are the surfaces a member actually stands in: which rows a route paints, how a write is narrated, what a pending row says while the vault is quiet. Everything below the shell's own boundary is engine; the app layer above it is where the seeds go now.

Every mutate set added there is browser-side TypeScript with no DOM in it, run under a plain **node** vitest project on purpose. Stryker's vitest runner dry-runs a jsdom project as "No tests were executed", so a suite carrying the `@vitest-environment jsdom` docblock defends nothing in this lane, however green it is — which is why `apps/_shared/untrusted.ts` takes no seed until a node-side suite exists, and why each seed's Stryker config states what it leaves out.

**Provisional-local floors.** This file's standing rule is that a floor is seeded from **CI**, because seeding from the author's own machine is the author-asserted claim the mutation lane exists to eliminate. The eight #839 floors are the recorded exception: each is seeded from a local linux/x64 run and therefore sits at **(local measured − 11)** rather than the usual (measured − 2/3). Eleven points is the local/CI gap #656 measured on `packages/backup` and `packages/blueprints`, applied in the pessimistic direction because the direction of that gap was never verified — a floor too low fails to catch a regression it should have, while a floor too high reds a lane that is fine, and only the first is recoverable by the next measurement. **Re-seed each of them to (CI measured − 3) on the first green nightly mutation lane that includes them**, and delete the `_w2Comment` note in `tests/floors.json#mutation` when that happens. The ruling and its rationale are in [decisions.md](docs/decisions.md#adversary-lanes-and-provisional-evidence-839).

**Per-PR perf** (`bun run test:perf:pr` / `verify` step): gateway low-end budget gate (`packages/server` `perf:low-end`, fsync-required on Linux). Perf budget _numbers_ also tighten-only via `test:ratchet`. Full `test:perf` / Playwright waterfall remains nightly.

### Fuzz lane (#839)

Mutation testing asks whether a test would notice a changed line. The fuzz lane asks a different question: what happens to a parser fed bytes nobody chose deliberately. [`scripts/fuzz/`](scripts/fuzz) holds the whole engine — there is **no fuzzing dependency in this repo and none may be added** — as `mutate.mjs` (seeded PRNG + mutation table), [`targets.mjs`](scripts/fuzz/targets.mjs) (entry points + invariants), and [`run.mjs`](scripts/fuzz/run.mjs). Six targets: the gateway info handshake judge, the pair-QR/header frame codec, the CBSF v2 blob directory decoder, the WAL segment/closer/pair-marker key parsers, the FTS5 MATCH expression compilers, and the replica compiler's claim to mirror the canonical gateway one.

- **Seeded, iteration-counted determinism.** The program seed defaults to `839001` and is never `Date.now()`; work is measured in iterations, never wall clock, so two runs at one seed execute the same inputs in the same order and produce a byte-identical summary apart from timings. `--time-budget-ms` is a runaway guard that reports itself in the summary, not a schedule. `replay.test.mjs` runs one target twice at a fixed seed, which makes "deterministic" a tested claim rather than a design note.
- **Coverage-guided-lite.** There is no coverage instrumentation. Feedback is each target's **behaviour signature** — the outcome class it reports per execution — and an input producing an unseen signature is promoted into the live corpus and mutated further. That is the feedback shape a coverage-guided fuzzer gets, at the granularity a target chooses to expose.
- **Corpus, crashers, and the register.** Each target has a committed seed corpus under `scripts/fuzz/corpus/<target>/`, which runs unmutated first so a seed input that already violates an invariant is reported before any mutation happens. Every finding is written back as a committed crasher under `scripts/fuzz/crashers/<target>/`, named by its finding class. [`known-findings.json`](scripts/fuzz/known-findings.json) partitions the two populations: a finding whose class is **registered** is reported without failing the lane, because it is a recorded defect awaiting a product decision; a finding whose class is **not** registered fails the run, and the remedy the runner prints is to commit the crasher, pin it in the replay suite, and register the class with its issue. **Removing an entry is how a fix gets locked in — never add one to go green.** The register is **empty** today: the three classes it carried under #839 — two halves of the replica-mirrors-gateway search claim, and a WAL closer key the parser admitted and the formatter refused to re-emit — were fixed under [#846](https://github.com/srikanth235/centraid/issues/846) and their entries deleted with the fix. Their crashers stay committed, so the replay suite now asserts each of those inputs runs clean, which is the regression lock the removal buys.
- **The replay lock.** [`replay.test.mjs`](scripts/fuzz/replay.test.mjs) is the lane's memory, and it reads the register in both directions. Registered class ⇒ the replay pins the finding's exact class and message, so the day the product moves — fixed, or made worse — the suite goes red and the entry must be revisited on purpose. Class absent ⇒ the replay asserts the input runs clean, forever, which is the regression lock. It also fails when a registered finding has no committed crasher, and when a crasher names a target that no longer exists.
- **Lane placement.** Nightly, in the `fuzz-parsers` job of [`e2e.yml`](.github/workflows/e2e.yml), which runs `bun run test:fuzz` and then `bun run test:fuzz:replay` under `if: always()` — the crasher corpus must keep replaying exactly as recorded even when the search above found something new. Both the search and the replay are nightly-only because **five of the six targets import each package's built `dist`**, so the lane needs a `bun run build` the PR gate chain does not do; the replay suite is its own vitest project (`scripts/fuzz/vitest.config.ts`) rather than a member of the root aggregate for the same reason — it is the one surface importing a built `dist` and `packages/client`'s TypeScript source in one process. Evidence is `artifacts/fuzz/summary.json`, uploaded as `nightly-evidence-fuzz`, and the wiring is held by [`scripts/test-report/validate-nightly-wiring.mjs`](scripts/test-report/validate-nightly-wiring.mjs).

### Protocol join lane (#839)

Every other suite that exercises two vaults talking to each other calls the vault package directly — a `Map` of mounted vaults, a hand-rolled `IncomingMessage`. Nothing **joined**: nothing put N seats on one gateway and made them speak the real wire. [`packages/server/src/serve/protocol-join-lane.test.ts`](packages/server/src/serve/protocol-join-lane.test.ts) is that rig — one `serve()` daemon, N mounted vaults, one iroh tunnel client per seat — so every assertion travels the transport a paired phone uses.

A seat here is a **vault identity plus the device that reaches it**, not a client bundle: `seat()` in `host-platform.ts` is a build-time constant, so custodian-versus-viewer cannot be varied at runtime. The topology is one gateway with N mounted vaults and never N gateways, because fulfillment resolves an audience vault through the host's own registry and a grant to a vault on another gateway parks at `syncing` deliberately (see [Sharing v1](docs/decisions.md#sharing-v1--the-grant-plane-825) and [protocol.md](docs/protocol.md)).

Four laws, and the laws are the same at every N:

1. A grant crosses mounted vaults over the real transport, and **only the addressed seat** receives it.
2. Revocation propagates across the join and **severs** delivery rather than merely pausing it.
3. A parked payload survives a transport reconnect, then **settles once** and never unparks.
4. An N−1 client meets **one update wall** over the real transport, with no fallback mode.

The suite runs on the **PR path at its 3-seat floor** — an origin, an addressed audience, and a bystander that proves addressing is real — as an ordinary `packages/server` test. The nightly `protocol-join` job widens it, it does not own it: `CENTRAID_JOIN_SEATS=5` asserts fan-out and severance at width, and the vitest JSON report at `artifacts/join/summary.json` is the evidence, because per-test durations for the join laws are what a widening seat count moves. It gets its own job for the `restore-year3` reasons: N real iroh endpoints per case must not compete with the 30-minute `quality-performance-scale` budget, a correctness rig has no volume/duration descriptor for `tests/scale`, and real QUIC is environment-sensitive enough that a red join lane must not mask coverage and report rendering.

Law 4 is asserted with **synthetic version integers**. A pinned N−1-client artifact lane is out of scope here rather than missing: the protocol window is a single point (`GATEWAY_PROTOCOL_VERSION === GATEWAY_MIN_PROTOCOL_VERSION`), so no legal N−1 client exists to pin, and producing one is a release-pipeline change.

### Property contracts (fast-check, #532)

`@centraid/test-kit/fast-check` re-exports a pinned `fast-check`. Core contracts use model-based / property tests across the load-bearing pure surfaces:

| Flow | Owner | `minimumTests` |
| --- | --- | --: |
| `blob-custody-properties` | vault custody-properties | **12** |
| `vault-json-schema-properties` | vault json-schema-properties | **7** |
| `commons-convergence-properties` | vault commons-convergence-properties | **3** |
| `replica-intent-properties` | client intent-idempotency-properties | **10** |
| `replica-payload-hash-properties` | client payload-hash-properties | **7** |
| `scheduler-no-backfill` | automation scheduler-ledger.contract | **19** |
| `backup-crypto-properties` | backup crypto-properties | **8** |
| `backup-wal-address-properties` | backup wal-address-properties | **7** |
| `blob-format-cbsf-properties` | blob-format cbsf-properties | **6** |
| `protocol-handshake-properties` | protocol handshake-properties | **9** |
| `tunnel-wire-properties` | tunnel wire-properties | **5** |
| `app-engine-cost-properties` | app-engine cost-properties | **7** |

### The time zoo (#839)

A doctrine demonstrated on one zone at two hand-picked minutes is not a doctrine tested: a matcher that special-cased a whole-hour, northern-hemisphere, positive-DST shift would pass it. The time zoo re-states the civil-time laws of [cron-timezone.md](docs/cron-timezone.md) over the calendars that are not ordinary, across a zoo of adversarial zones — a negative-DST zone whose standard time is the summer one, a zone whose shift is thirty minutes rather than sixty, and a fixed-offset control that must produce neither case — and over **seeded samples of wall minutes drawn from inside each transition band**, so a law is asserted about the band and not about one minute inside it. Every zone band is read off the runtime's own tzdata rather than assumed, so tzdata drift surfaces as a failure. All of it runs on the PR path under the fake clock.

| Suite | What it states |
| --- | --- |
| `packages/server/src/automation/fire/time-zoo-cron.test.ts` | the Gap (skip) and Overlap (once) rows of the DST policy over the zone zoo, plus the fixed-offset control |
| `packages/server/src/automation/fire/time-zoo-calendar.test.ts` | the two civil irregularities that are not DST — February 29 including the Gregorian century rule, and the 53-week ISO year (2026 is one) — with year-long claims asserted over a tiling of `dueInstants` windows, which also proves the `(from, to]` windows compose |
| `packages/core/src/time/time-zoo-recurrence.test.ts` | the same Gap/Overlap doctrine and the same two calendars for RRULE expansion |
| `packages/core/src/time/time-zoo-zone-crossing.test.ts` | the collapse law for a recurrence **defined** in one zone and **read** from another: however the range is cut, the occurrences are the same multiset, in the same order, once each |

The zone table is deliberately duplicated between the `@centraid/core` and `packages/server` halves: core is the dependency-free contracts package and must not reach into a server test helper, and a shared fixture would let one edit weaken both suites at once.

The overlap law is where the zoo found a real defect. A gateway that is **up** across a fall-back fires the repeated wall minute twice, because the dedupe lives inside one `dueInstants` call while the persisted cursor carries only a millisecond window position — so the two absolute minutes carrying the same wall clock land in two different one-minute ticks, each deduping perfectly against itself. `cron-cursor.test.ts` covers the single wide window that follows downtime, which is why the gap went unseen. The zoo pins the current behaviour under [#839](https://github.com/srikanth235/centraid/issues/839) so a fix has to change an expectation deliberately; the documented law is unchanged and the divergence is recorded at [cron-timezone.md](docs/cron-timezone.md#dst-policy).

### Coverage-scope reachability (#532)

Governance directive `coverage-scope-reachability` fails when a `packages/*`, `apps/*`, or `tools/*` source tree, or any executable tree co-located outside `src/` inside a package or app (discovered from the tree, not enumerated — #781), has non-test executable source but no coverage floor, matrix owner, or intentional allowlist entry — and a floored non-src tree must also appear in the root `coverageInclude`, so a floor that measures nothing is itself a violation — so a new product surface cannot land invisible to every floor.

## Deliberately deferred

- Per-PR UI / scale / full Playwright perf waterfall (nightly only).
- Chasing 100% or testing trivial getters.
- Mutating whole large modules (WAL seal/replay, tunnel stream I/O, keyring I/O, React shells) — pure property-defended mutate sets only.

## Related

- [Issue #458](https://github.com/srikanth235/centraid/issues/458) — current product-shape audit and reorganization.
- [Issue #212](https://github.com/srikanth235/centraid/issues/212) — original runner and meaningful-coverage strategy.
