# Testing strategy

Centraid tests protect important product flows and invariants, not a test-file
count. This document supersedes the product-shape assumptions from #212 and is
the durable contract for the suite reorganized in #458.

## Principles

1. **Coverage of flows, not count of tests.** Every important flow has one
   owner. More tests and more runtime are costs, not progress.
2. **One flow, one home.** Prove a flow at the cheapest tier that can falsify
   it. A higher tier does not repeat a lower tier's ownership.
3. **Runtime is a budget.** Unit, integration, and contracts run per PR. Full
   cross-client UI journeys, performance, and scale run nightly and on demand.
   Path-filtered client e2e and boot-the-artifact smoke are the PR-time client
   gates (issue #468 **L1** / **E2** — see [PR vs nightly](#pr-vs-nightly-l1--e2)).
4. **Duplication is visible.** Two candidate owners for one flow are merged;
   they are not both added to the catalog.
5. **Coverage floors ratchet up, never down.** A lower floor requires an
   approved constitutional deviation, not an ordinary refactor.

The machine-readable source of product-flow ownership is
[`tests/matrix.json`](tests/matrix.json). `bun run test:matrix` verifies its
surface/dimension references, owning paths, unique flow ids, and minimum size
of named contract suites. A new test either claims an unowned flow/cell or
extends its existing owner.

## Runner and test taxonomy

[Vitest](https://vitest.dev) is the single unit/integration/contract runner.
Every package extends one of the presets in
[`packages/test-kit`](packages/test-kit), and every node preset explicitly uses
the `forks` pool so `node:sqlite` and Worker threads are process-isolated. The
node and jsdom presets also set **`expect.requireAssertions: true`** (#496 E5)
so an assertion-free test fails; perf/scale configs opt out intentionally.
The root [`vitest.config.ts`](vitest.config.ts) aggregates all projects for one
v8 coverage result.

| Tier | Marker / location | Owns | Schedule |
| --- | --- | --- | --- |
| Unit / logic | `*.test.ts[x]` | one module's observable behaviour | per PR |
| Integration | `*.integration.test.ts` | real SQLite, sockets, processes, or cross-component behaviour | per PR |
| Contract | `*.contract.test.ts` | named product law that refactors must preserve | per PR |
| Boot-the-artifact smoke | `scripts/gateway-package/smoke.mjs` (+ `--base-url` for containers) + path-filtered `gateway-package` workflow | "builds but doesn't start" (host binary **and** Docker image with `/data` volume) | **PR path-filtered** (gateway/protocol/Dockerfile/scripts) + manual `bun run gateway:package:smoke` |
| Desktop journey | `apps/desktop/tests/e2e/*.spec.ts` | real Electron-only assertions | **PR path-filtered** + full nightly |
| Web journey | `apps/web/tests/e2e/*.spec.ts` | real Chromium/PWA/network assertions | **PR path-filtered** + full nightly |
| Mobile journey | `tests/agent-e2e-mobile/flows/*.mjs` | native installed-app assertions | nightly + exploratory |
| Pairing journey | `tests/agent-e2e-pairing/flows/*.mjs` | daemon/CLI/device and relay ceremony | nightly + exploratory |
| Performance | `tests/perf/*.perf.test.ts` | hot-path budgets | nightly |
| Scale | `tests/scale/*.scale.test.ts` | correctness and duration at volume | nightly |
| Mutation | StrykerJS on vault / client replica / automation | mutation-score floors | nightly |

### PR vs nightly (L1 / E2)

Decided in [#468](https://github.com/srikanth235/centraid/issues/468); cite
[docs/decisions.md](docs/decisions.md).

| Lane | Runs |
| --- | --- |
| **Every PR** | Unit, integration, contract; matrix validation + **floors ratchet** via `check:pr`; **affected-package vitest** (`turbo run test --filter='[origin/main]'` — changed packages only, not the full dependent graph); **boot-the-artifact smoke** when client-e2e-pr triggers (includes `packages/gateway` + `packages/app-engine` path filters — #496 E7); **path-filtered client e2e** |
| **Path filters (client e2e)** | **Web** e2e when `apps/web`, `packages/client`, or service-worker files change; **desktop** e2e when `apps/desktop` changes; **boot-smoke** also when gateway/app-engine change. Shard to keep wall-clock roughly under ten minutes. |
| **Nightly** | Full cross-client suites, perf budgets, mobile (**iOS + Android home-loads**), pairing journeys, scale, **mutation (Stryker)** |

**Promotion rule:** if a nightly-only area burns us **twice**, move it to PR-time.

### Nightly SLA (#496 E3)

Soft SLA (auto-issue, not a hard age gate):

1. A **scheduled** nightly that fails opens or updates a single tracking issue
   titled `[nightly] e2e lane red — tracking` with the Actions run URL and the
   nightly Pages report link.
2. **Expected response:** within **24 hours** or before the next scheduled run
   — triage, fix, or document a temporary waiver in the issue.
3. Branch `workflow_dispatch` runs **do not** publish to GitHub Pages (main-only
   guard on `publish-nightly-report`) so they cannot spuriously red the workflow
   with a Pages deploy error.
4. Missing nightly HTML is **visible** (error annotation + tracking issue), not
   a silent `::warning` only.

### Floors ratchet (#496 E4, extended #532)

`tests/coverage-floors.json` values, matrix flow `minimumTests`, and
`tests/mutation-floors.json` scores **move only upward**. Perf budget files
(`apps/web/tests/e2e/perf-budgets.ts`,
`packages/gateway/benchmarks/low-end-budgets.json`) are **tighten-only**:
ceilings may drop freely; widening a ceiling or lowering a `min*` floor fails.
CI and `bun run test:ratchet` / `check:pr` fail on any decrease/widen unless:

- top-level `approvedDeviation` on `coverage-floors.json` or `mutation-floors.json`,
- per-flow `approvedMinimumTestsDeviation` on the lowered flow, or
- `approvedDeviation` in the perf budget source when deliberately widening.

### Skipped-gate honesty + partial → solid (#496 B2/B3)

- Env-gated **cell or flow owners** (`CENTRAID_*`, `CLAWGNITION_*`, whole-file
  `describe.skipIf` / early `t.skip`) cannot keep a `solid` or `partial`
  assessment — `bun run test:matrix` fails until the gate is removed or the
  assessment is demoted.
- Closing a QUALITY / matrix note item **must** promote the assessment and
  delete/update the note. `partial` is temporary evidence, not permanent
  furniture.

### Confidence map (#496 J1)

```
HIGH  vault/backup/replica contracts, handler isolation, web offline/PWA,
      pairing when nightly green, engine coverage floors, ENOSPC fault-inject,
      agent chat journey (fake-acp integration)
MED   desktop Playwright, mobile Maestro iOS + Android home-loads, perf/scale
      (generous), tunnel native when module present, multi-writer double-write
SOFT  desktop copilot UI e2e (blocked on #470), builder publish (punted v0),
      mobile on-device perf/scale (honest skip), nightly red → human action
```

Parent backlog: [#496](https://github.com/srikanth235/centraid/issues/496).

`TESTING.md` wins over any suite README that contradicts this split (**L3**).

Playwright alone owns desktop and web regression journeys. The mobile journey
layer is the committed agent-driven flows under
[`tests/agent-e2e-mobile/`](tests/agent-e2e-mobile); their device-driving
substrate is **Maestro**, spawned by the harness
([`lib/harness.mjs`](tests/agent-e2e-mobile/lib/harness.mjs) `runMaestroChunk`
runs `maestro --udid … test <flow.yaml>` per step) against an installed
development app on a booted iOS Simulator or Android emulator. The `mobile-e2e`
job in [`e2e.yml`](.github/workflows/e2e.yml) installs a pinned Maestro CLI and
runs those flows nightly. There is no second native suite and no Detox suite.
Desktop agent-driven flows were retired after their unique restart/persistence
assertions moved to Electron Playwright.

Property-style checks follow the normal `*.test.ts` convention and say
`property` in the suite name. `.spec.ts` is Playwright-only.

Timeouts come in two tiers. Node projects — the `node:sqlite` ones, which
bootstrap real vault/daemon layouts and are therefore fsync-bound — get a 30s
default from the shared `nodeProject` preset in
[`packages/test-kit/src/vitest.ts`](packages/test-kit/src/vitest.ts); the
measurements justifying that number are in the comment there. jsdom projects do
no disk I/O and keep Vitest's tight 5s default. The budget is sized for
hosted-runner **disk latency variance**, which was measured at up to ~10x
between two runner instances executing the identical command — not for v8
coverage instrumentation, which is enabled in the per-PR `ci` lane too. Files
slower still than the node default escalate locally with `vi.setConfig` (the
gateway CLI suites use 60s); do not add a per-test `timeout` option that sits
*below* its file's budget.

## Product tiers and coverage gates

The deeply gated engine is vault, client replica, gateway, app-engine,
automation, backup, blueprints, agent-runtime, plus pure libraries
design-tokens, tunnel, protocol, and cli. Renderer screens and mobile UI are
covered by extracted logic plus journeys, not by a whole-surface line
percentage. `packages/client/src/replica/**` is gated independently from
`packages/client/src/react/**` for that reason.

Floors live in [`tests/coverage-floors.json`](tests/coverage-floors.json) and
are consumed directly by the root Vitest config. Floors are a tight margin
(~1pt) below the latest measured `bun run coverage` run (2026-07-23):

| Scope | Measured lines / branches | Floor lines / branches |
| --- | --- | --- |
| repo-wide (`lines`) | 71.89 / — | **70** / — |
| `packages/vault/src/**` | 91.78 / 78.97 | 90 / 78 |
| `packages/backup/src/**` | 90.79 / 79.18 | 89 / 78 |
| `packages/blueprints/src/**` | 90.77 / 84.09 | 89 / 83 |
| `packages/design-tokens/src/**` | 90.23 / 81.82 | 89 / 80 |
| `packages/app-engine/src/**` | 85.64 / 79.86 | 84 / 78 |
| `packages/gateway/src/**` | 80.55 / 74.67 | 79 / 73 |
| `packages/client/src/replica/**` | 75.63 / 76.73 | 74 / 75 |
| `packages/automation/src/**` | 73.80 / 78.94 | 72 / 77 |
| `packages/tunnel/src/**` | 73.22 / 80.42 | 72 / 79 |
| `packages/agent-runtime/src/**` | 72.89 / 85.88 | 71 / 84 |
| `packages/cli/src/**` | 70.14 / 57.78 | 69 / 56 |
| `packages/protocol/src/**` | 67.08 / 70.59 | 66 / 69 |

`bun run test` prints the active floors after package tests so the local loop
never hides the CI contract; `bun run coverage` measures and enforces them.
Floors move only upward (`bun run test:ratchet`).

### agent-runtime coverage strategy

`packages/agent-runtime` keeps a **high branch floor (~84%)**. The line floor
was ratcheted to **~71%** once measured coverage cleared the old deliberate 27%
seed (spawn-heavy adapters remain covered by contracts + integration rather
than a pure line chase).

Do **not** raise the agent-runtime line floor without a dedicated coverage
campaign. Do **not** lower any engine floor in this table without an explicit
issue + receipt. Prefer new pure modules (like `safe-stdin-write`) with unit
tests over expanding spawn-heavy turn drivers for coverage alone.

## Named invariant contracts

These suites encode product law and are cataloged by name. The matrix validator
also records their current minimum test count so a contract cannot silently
shrink in CI.

1. Vault consent gateway and journalled writes —
   `packages/vault/src/gateway/gateway.contract.test.ts`
2. Backup/restore round-trip and fencing —
   `packages/gateway/src/backup/backup-service.contract.test.ts`
3. Blob custody / CAS state machine —
   `packages/vault/src/blob/custody-proven.contract.test.ts`
4. Replica convergence, intent identity, and multi-writer admission —
   `packages/client/src/replica/intents.contract.test.ts` and
   `packages/client/src/replica/multi-writer.contract.test.ts`
5. Handler validation and worker isolation —
   `packages/app-engine/src/handlers/handler-runner.contract.test.ts`
6. Control/app/device session boundaries —
   `packages/gateway/src/serve/web-app-sessions.contract.test.ts`
7. Scheduler no-backfill semantics —
   `packages/automation/src/fire/scheduler-ledger.contract.test.ts`
8. Conversation digest → archive → custody-gated prune —
   `packages/app-engine/src/conversation/archive/archive.contract.test.ts`

Generated-state properties cover blob custody and replica intent idempotency.
The replica admission contract owns the multi-tab/same-id writer race.

## Shared test infrastructure

`@centraid/test-kit` is a private, source-exported workspace package. Use it
for:

- `tempDir()` / `tempDirSync()` with automatic test-file cleanup;
- `useFakeClock()` with automatic real-timer restoration;
- bootstrapped `createTestVault()` and listener-free `buildTestGateway()`;
- node and jsdom+JSX+CSS-module Vitest presets;
- deterministic parties, photos, conversations, turns, and blob custody
  volume fixtures;
- perf/scale JSON result emission.

Do not add another local helper when the shared package already owns the seam.

Deterministic automation fires need no mock: their handlers run in-process
against the parent-side `ctx.vault` / `ctx.fetch` / `ctx.state` rails, and only
`ctx.agent` reaches a provider. In tests that provider turn is faked through
the ACP fake-agent fixture
(`packages/agent-runtime/src/backends/acp/fake-acp-agent.mjs`), the same seam
chat turns use — there is no automation-specific mock LLM (the
`@centraid/mock-llm` package was removed with the `ctx.tool` rail).

## Lane schedule and commands

| Command / workflow | Contents |
| --- | --- |
| `bun run check:pr` | **Before every push:** format + oxlint + turbo lint + typecheck + lint:types + knip + lint:css + test:matrix + **test:ratchet** + **test:ratchet:unit** + **test:affected**. Superset of CI `static` (which omits `test:affected`; full vitest is on `verify`). Vitest alone is not a substitute. |
| `bun run check:pr:full` | Same as `check:pr`, but runs **dependents** via `turbo --filter='...[origin/main]'` (`test:affected:full`). Use before requesting merge when a shared package changed. |
| `bun run test` | package unit + integration + contract tests; prints floors |
| `bun run test:affected` | vitest for packages changed since `origin/main` (`turbo --filter='[origin/main]'` — changed packages only; dependents stay on full CI `verify`) |
| `bun run test:affected:full` | vitest for changed packages **and dependents** (`turbo --filter='...[origin/main]'`) |
| `bun run test:ratchet` | coverage floors + `minimumTests` + mutation floors up-only, and perf budgets tighten-only, vs `origin/main` |
| `bun run test:ratchet:unit` | Unit tests for the ratchet / diff-coverage pure functions (`scripts/test-report/vitest.config.ts`) |
| `bun run test:diff-coverage` | changed instrumentable lines vs merge base must be ≥ **80%** covered (`coverage-final.json`); CI `verify` after `coverage` |
| `bun run test:mutation` | StrykerJS on vault / client replica / automation (nightly); writes `artifacts/mutation/scores.json` |
| `bun run coverage` | unified per-PR suite, v8 report, floor enforcement, Vitest JSON (`ci.yml` **verify** job) |
| `bun run test:matrix` | catalog/owner/contract validation (also inside `check:pr`) |
| `bun run test:perf` | hot-path budget tests; nightly only |
| `bun run test:scale` | deterministic volume tests; nightly only |
| `bun run test:report` | build `dist/test-report/index.html` (+ `summary.json` / `summary.md`) from available evidence |
| `.github/workflows/ci.yml` | parallel **static** + **verify**, required **check** aggregator (ruleset-required); **publish-report** on main only (Pages); Bun/Turbo/Cargo caches |
| `.github/workflows/e2e.yml` | desktop, web, mobile (iOS + Android home-loads), pairing, perf, scale, **mutation**, full report → **publish-nightly-report** on main only; red scheduled nightly → auto-issue |

### Test-health report (main + nightly)

Public HTML publishes only from **main** (per-merge `ci`) and the **nightly**
e2e workflow — not from pull requests. Every `verify` / nightly report job
still writes a Job Summary and uploads the `test-health-report` artifact for
that run.

| Slot | URL |
| --- | --- |
| main | `https://srikanth235.github.io/centraid/test-report/main/` |
| Nightly | `https://srikanth235.github.io/centraid/test-report/nightly/` |
| Landing | `https://srikanth235.github.io/centraid/` |

Performance and scale budgets use generous regression multipliers. A noisy
budget is fixed or removed; it is never promoted to the per-PR loop. Lane
results are JSON under `artifacts/perf` and `artifacts/scale`; the nightly
workflow restores and appends their bounded cross-run history before the
combined report is published. Coverage, desktop Playwright, web Playwright,
performance, and scale commands stamp distinct lane-start markers: a cached
result not refreshed by that invocation turns grey immediately. Vitest,
Playwright, agent-e2e, performance, and scale evidence all carries a capture
time and expires after 36 hours. This staleness signal exists because a
nightly-only suite rots silently: #458 found the entire desktop Playwright
suite red after the React/CSS-modules migrations — hard-coded selectors like
`.cd-sb-item`, `.ctx-menu`, and `.modal-card` had all gone dead, exactly the
#225-class silent rot — while the per-PR loop stayed green. Grey (or expired)
evidence in the report is the standing guard against that class of drift.

## Unified report

[`scripts/test-report`](scripts/test-report) ingests the matrix, Vitest JSON,
`coverage/coverage-summary.json`, every Playwright JSON result, agent-e2e
evidence, and perf/scale JSON. It emits one self-contained page at
`dist/test-report/index.html` with:

- the clickable surface × quality-dimension heatmap first;
- canonical owners, tier, lane, last status, and runtime in the cell inspector;
- coverage versus floor, per-package wall clock, slowest ten files, and skip
  counts;
- perf/scale trends;
- grey missing or stale evidence instead of an absent lane.

PR CI uploads the report even when coverage fails. Nightly jobs upload surface
evidence; the final job merges the latest pairing/relay artifact, reruns the
full Vitest coverage suite, then publishes one report after performance and
scale run. `bun run test:report:smoke` verifies the generator without requiring
prior test artifacts.

## The test convention

Every test in this repo follows these rules. They are objective enough for an
agent to self-check and for review to enforce.

- **Behaviour over implementation.** Assert observable outcomes — return values,
  persisted state, emitted events — never that a private helper ran or a mock was
  called. If the refactor is behaviour-preserving, the test must still pass.
- **Real deps; fake only at the edges.** Use the real sqlite, real workers, real
  modules. Fake only what is non-deterministic or external: clock, network, fs
  randomness. The backend already does this; keep it the default.
- **One behaviour per test.** A test names a single behaviour and asserts it. No
  grab-bag tests that drift into asserting incidentals.
- **Assert outcomes, not mock calls.** `expect(result).toEqual(...)`, not
  `expect(mock).toHaveBeenCalled()`. A `toHaveBeenCalled` assertion is a smell —
  justify it or replace it with an outcome assertion.
- **Deterministic.** No real time (`Date.now()`/timers — inject or fake), no real
  randomness, no network. No committed `.only`. A test must pass on every run.
- **Clear failure output.** A failing test must say _what_ broke without a
  debugger. Prefer specific matchers and meaningful expected values over
  `toBeTruthy()`.

When in doubt, apply the adversarial check: _could the code be wrong and this
test still pass?_ If yes, the test is not yet meaningful.

### Diff coverage (#532)

After `bun run coverage`, CI `verify` runs `bun run test:diff-coverage`. It
intersects `git diff origin/main` added lines (instrumentable `packages/*` /
`apps/*` sources only) with Istanbul/v8 `coverage/coverage-final.json`. Threshold
is **80%** of changed instrumentable lines. Failures name uncovered hunks.
Waive with a non-empty `approvedDeviation` in
`tests/diff-coverage-deviation.json` (constitutional exception — temporary).

### Mutation testing (#532)

Nightly StrykerJS (`@stryker-mutator/vitest-runner`) on:

- `packages/vault`
- `packages/client/src/replica`
- `packages/automation`

Package-local Stryker configs (`packages/{vault,client,automation}/stryker.config.mjs`
+ `vitest.mutation.config.ts`) mutate the property-defended modules; root
pointers live under `tests/mutation/`. `bun run test:mutation` writes
`artifacts/mutation/scores.json` for the test-health report. Floors live in
`tests/mutation-floors.json` and ratchet up-only (seeded 2026-07-23: vault **97**,
client replica **67**, automation **80**). Per-PR mutation is out of scope.

### Property contracts (fast-check, #532)

`@centraid/test-kit/fast-check` re-exports a pinned `fast-check`. State-machine
contracts use model-based / property tests:

- blob custody / CAS — `packages/vault/src/blob/custody-properties.test.ts`
- replica intent idempotency — `packages/client/src/replica/intent-idempotency-properties.test.ts`
- scheduler no-backfill — `packages/automation/src/fire/scheduler-ledger.contract.test.ts`

Matrix `minimumTests` protect them from shrinking (2026-07-23 backfill):

| Flow | Owner | `minimumTests` |
| --- | --- | ---: |
| `blob-custody-properties` | vault custody-properties | **12** |
| `replica-intent-properties` | client intent-idempotency-properties | **10** |
| `scheduler-no-backfill` | automation scheduler-ledger.contract | **23** |

### Coverage-scope reachability (#532)

Governance directive `coverage-scope-reachability` fails when a `packages/*` or
`apps/*` tree has non-test TypeScript source but no coverage floor, matrix
owner, or intentional allowlist entry — so a new engine package cannot land
invisible to every floor.

## Deliberately deferred

- A second React Native component-test toolchain.
- Per-PR UI, performance, scale, or mutation gating.
- Chasing 100% or testing trivial getters.

## Related

- [Issue #458](https://github.com/srikanth235/centraid/issues/458) — current
  product-shape audit and reorganization.
- [Issue #212](https://github.com/srikanth235/centraid/issues/212) — original
  runner and meaningful-coverage strategy.
