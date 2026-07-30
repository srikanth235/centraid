# Test-gap closure map — 2026-07 (#545)

Working checklist for [issue #545](https://github.com/srikanth235/centraid/issues/545). Close A first so later floors and CI honestly gate the rest.

## Non-goals (from issue Out list only)

- Raising agent-runtime **line** floor beyond incidental gains
- Second RN component-test toolchain; per-PR UI/scale lanes; 100% coverage chase
- Un-skip builder-publish e2e; desktop copilot e2e (#470)
- Perfecting every desktop Electron wrapper beyond named C1–C3 extract-and-test progress

## A. Enforcement holes

- [x] **A1** Nightly coverage/perf/scale outcomes re-read into job failure (`e2e.yml`)
- [x] **A2** Mutation nightly gated + `mutation-testing` in `nightly-failure-issue` needs
- [x] **A3** `coverage-scope-reachability` pathspecs include flat `src/*.ts`
- [x] **A4** `apps/oauth-worker` floor + matrix + coverage-instrumented (not `index.ts`-blind)
- [x] **A5** Mutation floors fail on missing scores; floors ⊆ seed ids
- [x] **A6** `test:report:smoke` in CI static
- [x] **A7** scripts/release vitest + `release:surfaces:test` + sanitize-connector-svg in CI
- [x] **A8** `lint:css` / `lint:protocol-routes` / `lint:acp-min-versions` in CI static
- [x] **A9** Unit tests for `validate-matrix` / `validate-nightly-wiring`
- [x] **A10** `status-admin` platform gates use `test.skipIf`
- [x] **A11** Nightly issue-create `::error::` fallback; history-copy honesty; fetch-main degrade safe

## B. Engine cold spots

- [x] **B1** `packages/vault/src/gateway/execution.ts`
- [x] **B2** `packages/vault/src/gateway/duties.ts`
- [x] **B3** `packages/gateway/src/routes/lifecycle-automation-routes.ts`
- [x] **B4** app-engine `store-sql` / `turn-sse` / `archive/segment`
- [x] **B5** automation `worker/` + `handler/ctx|audit`; app-engine `worker/`
- [x] **B6** vault blob + ingest (stream-ingress, direct-transfers, enrich-publishers, sigv4, pdf-text, parsers)
- [x] **B7** gateway backup + CLI + preview + skills + store/lifecycle routes
- [x] **B8** client pure modules + replica ceiling-draggers
- [x] **B9** protocol routes/capabilities/handshake depth
- [x] **B10** cli branch depth
- [x] **B11** agent-runtime named files
- [x] **B12** backup conformance (+ testing exclude if needed)
- [x] **B13** blueprints scaffold snapshot; protocol/cli floors ratchet up

## C. App surfaces

- [x] **C1–C3** desktop gateway-store / ipc / preload / auth-injector (+ core extractions as needed)
- [x] **C4–C7** mobile Onboarding / Spaces / Insights / Photos owners
- [x] **C8** web `iroh-transport` depth
- [x] **C9** web + mobile vitest `*.test.tsx` include
- [x] **C10** extension content/worker/transport/popup
- [x] **C11** oauth-worker availability/failure-mode cases

## D. Matrix / floors / infra

- [x] **D1** matrix surfaces `extension` + `oauth-worker`
- [x] **D2** notes on all partial cells
- [x] **D3** real issues or drop “child issue for X”
- [x] **D4** `minimumTests` required-or-warned (+ low floors raised)
- [x] **D5** `packages/client/src/react/**` coverage floor
- [x] **D6** gateway + agent-runtime mutation seeds
- [x] **D7** test-kit vitest/quality-result tests
- [x] **D8** factories wire-or-delete; agent-e2e harness tests
- [x] **D9** shellcheck governance/hooks + scope self-test in CI
- [x] **D10** `scripts/**` coverage floor on ratchet-unit lane

## E. Hygiene

- [x] **E1** clear named worst `toHaveBeenCalled*` files; material reduction from ~600
- [x] **E2** clear named worst `toBeTruthy` files; material reduction from ~364
- [x] **E3** named fixed sleeps → fake timers / poll; client flushMicrotasks helper
- [x] **E4** QUALITY.md + COVERAGE_REPORT.md stale claims fixed

## Status

**Done** — PR [#548](https://github.com/srikanth235/centraid/pull/548) on branch `feat/issue-545-test-gap-closure` closes issue #545 (A–E).

### Review follow-up (pre-merge)

- **Blocker:** `isProcessMainModule` realpaths Node bin symlinks so `centraid-gateway` is not a silent no-op.
- **Major:** vault `afterEach` closes + drop `--dangerouslyIgnoreUnhandledErrors`; perf-waterfall resource-timing settle; `backupMetrics` asserts oldest clocks / slowest cadence.
- **Minor/nits:** tautology smokes, dead e2e aggregator step, matrix/QUALITY notes, protocol floors 98/96, flush → `@centraid/test-kit/flush`, delete redundant `routes-capabilities.test.ts`, etc.
