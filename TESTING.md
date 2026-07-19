# Testing strategy

Centraid tests protect important product flows and invariants, not a test-file
count. This document supersedes the product-shape assumptions from #212 and is
the durable contract for the suite reorganized in #458.

## Principles

1. **Coverage of flows, not count of tests.** Every important flow has one
   owner. More tests and more runtime are costs, not progress.
2. **One flow, one home.** Prove a flow at the cheapest tier that can falsify
   it. A higher tier does not repeat a lower tier's ownership.
3. **Runtime is a budget.** Unit, integration, and contracts run per PR. UI
   journeys, performance, and scale run nightly and on demand.
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
root [`vitest.config.ts`](vitest.config.ts) aggregates all projects for one v8
coverage result.

| Tier | Marker / location | Owns | Schedule |
| --- | --- | --- | --- |
| Unit / logic | `*.test.ts[x]` | one module's observable behaviour | per PR |
| Integration | `*.integration.test.ts` | real SQLite, sockets, processes, or cross-component behaviour | per PR |
| Contract | `*.contract.test.ts` | named product law that refactors must preserve | per PR |
| Desktop journey | `apps/desktop/tests/e2e/*.spec.ts` | real Electron-only assertions | nightly |
| Web journey | `apps/web/tests/e2e/*.spec.ts` | real Chromium/PWA/network assertions | nightly |
| Mobile journey | `tests/agent-e2e-mobile/flows/*.mjs` | native installed-app assertions | nightly + exploratory |
| Pairing journey | `tests/agent-e2e-pairing/flows/*.mjs` | daemon/CLI/device and relay ceremony | nightly + exploratory |
| Performance | `tests/perf/*.perf.test.ts` | hot-path budgets | nightly |
| Scale | `tests/scale/*.scale.test.ts` | correctness and duration at volume | nightly |

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
`property` in the suite name. `.spec.ts` is Playwright-only. Slow files set a
local timeout with `vi.setConfig`; packages do not raise the timeout for every
fast test.

## Product tiers and coverage gates

The deeply gated engine is now vault, client replica, gateway, app-engine,
automation, backup, blueprints, and agent-runtime. Renderer screens and mobile
UI are covered by extracted logic plus journeys, not by a whole-surface line
percentage. `packages/client/src/replica/**` is gated independently from
`packages/client/src/react/**` for that reason.

Floors live in [`tests/coverage-floors.json`](tests/coverage-floors.json) and
are consumed directly by the root Vitest config. The new floors were seeded a
tight margin below the 2026-07-18 measurements:

| Scope | Measured lines / branches | Floor lines / branches |
| --- | --- | --- |
| `packages/vault/src/**` | 91.77 / 79.10 | 90 / 78 |
| `packages/backup/src/**` | 90.76 / 79.20 | 89 / 78 |
| `packages/client/src/replica/**` | 72.93 / 76.44 | 69 / 73 |
| `packages/gateway/src/**` | 80.51 / 72.79 | 75 / 71 |
| `packages/app-engine/src/**` | 84.89 / 79.81 | 75 / 73 |
| `packages/automation/src/**` | 72.63 / 78.53 | 68 / 74 |
| `packages/blueprints/src/**` | 89.43 / 81.82 | 83 / 74 |
| `packages/agent-runtime/src/**` | 31.60 / 85.71 | 27 / 84 |

The repo-wide line floor remains 30%. `bun run test` prints the active floors
after package tests so the local loop never hides the CI contract;
`bun run coverage` measures and enforces them. Floors move only upward.

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
- the shared mock-LLM test entry point;
- node and jsdom+JSX+CSS-module Vitest presets;
- deterministic parties, photos, conversations, turns, and blob custody
  volume fixtures;
- perf/scale JSON result emission.

Do not add another local helper when the shared package already owns the seam.
The mock LLM implementation lives in the dependency-neutral
`@centraid/mock-llm` package. Automation keeps a compatibility re-export for
its development path, while tests consume the same implementation through
test-kit's stable facade.

## Lane schedule and commands

| Command / workflow | Contents |
| --- | --- |
| `bun run test` | package unit + integration + contract tests; prints floors |
| `bun run coverage` | unified per-PR suite, v8 report, floor enforcement, Vitest JSON |
| `bun run test:matrix` | catalog/owner/contract validation |
| `bun run test:perf` | six generous hot-path budget tests; nightly only |
| `bun run test:scale` | five deterministic volume tests; nightly only |
| `bun run test:report` | build `dist/test-report/index.html` from available evidence |
| `.github/workflows/e2e.yml` | desktop, web, mobile, three pairing journeys (lifecycle, ticket-hygiene, cross-network-relay), perf, scale, full report |

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

## Deliberately deferred

- Mutation testing for the engine packages.
- A second React Native component-test toolchain.
- Per-PR UI, performance, or scale gating.
- Chasing 100% or testing trivial getters.

## Related

- [Issue #458](https://github.com/srikanth235/centraid/issues/458) — current
  product-shape audit and reorganization.
- [Issue #212](https://github.com/srikanth235/centraid/issues/212) — original
  runner and meaningful-coverage strategy.
