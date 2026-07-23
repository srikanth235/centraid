# Receipt: #532 harden the constraint gauntlet

## Checklist

- [x] Mutation-testing lane (nightly Stryker on vault / client replica / automation)
- [x] `tests/mutation-floors.json` + up-only ratchet
- [x] Diff-coverage gate (≥80% changed instrumentable lines) + CI `verify`
- [x] fast-check via `@centraid/test-kit` on three state-machine contracts
- [x] Perf-budget tighten-only ratchet
- [x] `bun run check:pr:full` (dependents via `...[origin/main]`)
- [x] Coverage-scope-reachability governance directive
- [x] TESTING.md / AGENTS.md write-back; mutation removed from “Deliberately deferred”
- [x] Receipt + PR linking #532

## What changed

### Mutation-testing lane (nightly Stryker on vault / client replica / automation)

- `tests/mutation/stryker.vault.mjs`
- `tests/mutation/stryker.client-replica.mjs`
- `tests/mutation/stryker.automation.mjs`
- `scripts/mutation/run.mjs` + `scripts/mutation/run.test.mjs`
- `package.json` script `test:mutation`; devDependencies `@stryker-mutator/core`, `@stryker-mutator/vitest-runner`
- `bun.lock` (lockfile for stryker + fast-check)
- `.github/workflows/e2e.yml` job `mutation-testing` + artifact `nightly-evidence-mutation`
  (upload `path: artifacts/` so merge-multiple keeps `artifacts/mutation/scores.json`)
- `scripts/test-report/generate.mjs` mutation score rows in test-health report
- `scripts/test-report/validate-nightly-wiring.mjs` requires mutation-testing job +
  rejects flattened `path: artifacts/mutation/` upload
- `tests/matrix.json` note `G4.mutation` updated (no longer deferred)

### `tests/mutation-floors.json` + up-only ratchet

- `tests/mutation-floors.json` (provisional floors at 0 until first measured nightly scores)
- `scripts/test-report/ratchet-floors.mjs` — `diffMutationFloors` + wiring in `ratchetFloors` / CLI
- `scripts/test-report/ratchet-floors.test.mjs` — mutation floor unit tests

### Diff-coverage gate (≥80% changed instrumentable lines) + CI `verify`

- `scripts/test-report/diff-coverage.mjs` + `scripts/test-report/diff-coverage.test.mjs`
- `package.json` script `test:diff-coverage`
- `.github/workflows/ci.yml` verify step after `bun run coverage`
- `vitest.config.ts` coverage reporter adds `json` → `coverage/coverage-final.json`

### fast-check via `@centraid/test-kit` on three state-machine contracts

- `packages/test-kit/package.json` — `fast-check` dep + `./fast-check` export
- `packages/test-kit/src/fast-check.ts`
- `packages/test-kit/src/test-kit.test.ts` — re-export smoke
- `packages/vault/src/blob/custody-properties.test.ts`
- `packages/client/src/replica/intent-idempotency-properties.test.ts`
- `packages/automation/src/fire/scheduler-ledger.contract.test.ts` (no-backfill property)

### Perf-budget tighten-only ratchet

- `scripts/test-report/ratchet-floors.mjs` — `diffPerfBudgetNumbers`, `extractBudgetNumbersFromSource`, sources:
  `apps/web/tests/e2e/perf-budgets.ts`, `packages/gateway/benchmarks/low-end-budgets.json`
- `scripts/test-report/ratchet-floors.test.mjs` — widen/loosen unit tests

### `bun run check:pr:full` (dependents via `...[origin/main]`)

- `package.json` scripts `check:pr:full`, `test:affected:full`
- `AGENTS.md` documents when to use `check:pr:full`

### Coverage-scope-reachability governance directive

- `.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/directive.yaml`
- `.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/check.sh`
- `.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/constitution.md`
- `.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/allowlist.txt`

### TESTING.md / AGENTS.md write-back; mutation removed from “Deliberately deferred”

- `TESTING.md` — lane table, floors ratchet, diff coverage, mutation, fast-check, coverage-scope; deferred no longer lists mutation testing
- `AGENTS.md` — pre-push gates, `check:pr:full`, mutation floors, diff-coverage on verify

### Supporting

- `scripts/test-report/vitest.config.ts` includes `scripts/mutation/**/*.test.mjs`
- `knip.json` ignores Stryker packages (spawned by `scripts/mutation/run.mjs`, not imported)
- `receipts/issue-532-constraint-gauntlet.md` (this receipt)

### Receipt + PR linking #532

- This receipt (`receipts/issue-532-constraint-gauntlet.md`) is the issue-bound audit trail for #532.
- PR opened against the default branch with subject/body linking #532.

### Follow-up: fill coverage floor gaps (2026-07-23)

- `tests/coverage-floors.json` — ratcheted floors ~1pt under measured `bun run coverage`:
  repo **70**, gateway **79/73**, app-engine **84/78**, automation **72/77**,
  blueprints **89/83**, agent-runtime **71/84** (was 27/84), plus new scopes
  design-tokens **89/80**, tunnel **72/79**, protocol **66/69**, cli **69/56**.
- `TESTING.md` measured/floor table refreshed to match.
- `.governance/.../coverage-scope-reachability/allowlist.txt` — drop design-tokens,
  tunnel, protocol, cli (now floored).

## Out of scope

- Mutation beyond the three seed packages
- Per-PR mutation or perf gating
- Changing existing coverage floor values in `tests/coverage-floors.json`
- Second property library / RN component toolchain / Gherkin
- Making `check:pr` itself run dependents (only `check:pr:full`)

## Decisions

- Diff-coverage threshold starts at **80%** (issue decision; waive via `tests/diff-coverage-deviation.json`).
- Mutation floors provisional at **0** until first nightly measured scores; then raise a tight margin below measured.
- Nightly mutation job uses 90m timeout + `continue-on-error` so a slow Stryker package does not block report assembly.
- `check:pr` stays changed-packages-only; dependents live only on `check:pr:full`.

## Verification

```sh
bun run test:ratchet:unit
# 50 tests (ratchet floors/mutation/perf + diff-coverage + mutation helpers)

bun run test:ratchet
# ok on clean tree; first-land mutation floors vs origin/main

# Perf widen fails without approvedDeviation:
# temporarily set shell.maxRequests: 999 in apps/web/tests/e2e/perf-budgets.ts
# → bun run test:ratchet exits 1

bun run --cwd packages/vault test -- src/blob/custody-properties.test.ts
bun run --cwd packages/client test -- src/replica/intent-idempotency-properties.test.ts
bun run --cwd packages/automation test -- src/fire/scheduler-ledger.contract.test.ts
bun run --cwd packages/test-kit test

bun run test:matrix
# matrix + nightly-wiring green (mutation job present in e2e.yml)

bash .governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/check.sh
# ✓ coverage-scope-reachability
GOVERNANCE_COVERAGE_SCOPE_SELFTEST=1 \
  bash .governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/check.sh
# ✗ synthetic unowned package (expected)

node scripts/mutation/run.mjs --dry-run
# artifacts/mutation/scores.json structure

rg -n 'check:pr:full|test:affected:full|test:diff-coverage' package.json
rg -n 'test:diff-coverage' .github/workflows/ci.yml
rg -n 'mutation-testing' .github/workflows/e2e.yml

# Mutation artifact layout (#532 fix): upload path must be artifacts/ so
# merge-multiple download keeps artifacts/mutation/scores.json for generate.mjs
bun run test:matrix
# nightly-wiring includes mutation-testing + rejects path: artifacts/mutation/
```

## Audit

Verdict: PASS

Evidence:
1. What changed: Receipt sections map to present tree paths on branch `issue-532-constraint-gauntlet` — mutation lane (`tests/mutation/stryker.{vault,client-replica,automation}.mjs`, `scripts/mutation/run.mjs` + `run.test.mjs`, `package.json` `test:mutation`, `e2e.yml` `mutation-testing`, `tests/matrix.json` `G4.mutation`, knip Stryker ignores); mutation floors (`tests/mutation-floors.json` provisional 0s, `ratchet-floors.mjs` `diffMutationFloors` + unit tests); diff-coverage (`scripts/test-report/diff-coverage.mjs` + tests, `test:diff-coverage`, `ci.yml` verify step, `vitest.config.ts` json reporter); fast-check (`packages/test-kit` export + three contract tests in vault/client/automation); perf ratchet (`diffPerfBudgetNumbers` + unit tests); `check:pr:full` / `test:affected:full`; coverage-scope-reachability directive pack; TESTING.md / AGENTS.md write-back; this receipt. No major path class omitted relative to ## What changed.
2. Checklist realization:
   - [x] Mutation lane → Stryker configs + `scripts/mutation/*` + `test:mutation` + e2e `mutation-testing`
   - [x] mutation-floors + up-only ratchet → `tests/mutation-floors.json` + `diffMutationFloors` in `ratchet-floors.mjs`/tests
   - [x] Diff-coverage ≥80% + CI verify → `diff-coverage.mjs`, `ci.yml` `bun run test:diff-coverage`, json coverage reporter
   - [x] fast-check three contracts → test-kit re-export; `custody-properties`, `intent-idempotency-properties`, `scheduler-ledger.contract` tests
   - [x] Perf-budget tighten-only → `diffPerfBudgetNumbers` + sources wired in ratchet
   - [x] `check:pr:full` → package.json + AGENTS.md / TESTING.md docs
   - [x] coverage-scope-reachability → `.governance/.../coverage-scope-reachability/{directive.yaml,check.sh,constitution.md,allowlist.txt}`
   - [x] TESTING.md / AGENTS.md write-back; mutation not under “Deliberately deferred” (deferred lists only per-PR mutation gating)
   - [x] Receipt + PR linking #532 → this file
3. Checklist mirrors #532 acceptance criteria: mutation nightly + floors ratchet, diff-coverage gate, fast-check contracts, perf ratchet, check:pr:full, coverage-scope directive, TESTING.md docs — all present; matches issue decision/scope/acceptance (mutation floors provisional at 0 until first nightly, per receipt Decisions; issue allowed implementer seed-from-measurement).

## Steering

Verdict: PASS

No human steering events (interrupt or mid-task correction) occurred in this session. The user issued a single goal authorization for issue #532. No rows to append to the accounting ledger.

## Accounting

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
