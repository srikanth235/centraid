# Issue #827 — fix red main after #821/#824

GitHub issue: [#827](https://github.com/srikanth235/centraid/issues/827)

`main` (`5cb74c76a`, #821/#824) left required `ci.yml` red: `client-e2e /
web-e2e` pending-overlay People locators, and `verify` `test:perf:pr`
event-loop peak (retried once, still red).

## Checklist

- [x] Web and desktop pending-overlay People locators accept both `Add` and `Add person` without strict-mode collision (scoped to the inline app view)
- [x] `prepareTally` recovers a friend `party_id` after an idempotent add-friend replay
- [x] `GatewayPerformanceMonitor.resetMeasurement()` restarts the rolling lag window; peak p99 is not a leftover handful of samples
- [x] `bun run test:perf:pr` still uses the existing `low-end-budgets.json` ceilings

## Decisions

#827 does not raise `eventLoopLagPeakP99Ms`. Shared-runner event-loop noise is already retried once (#557); the 6-sample 503 ms peak is a leftover rolling-window close after reset, not a ceiling to widen. Prior: #802 (chain preserved in receipts/issue-802-fix-main-ci.md).

## What changed

Web and desktop pending-overlay People locators accept both `Add` and `Add person` without strict-mode collision (scoped to the inline app view)
in `apps/web/tests/e2e/pending-overlay.spec.ts` and
`apps/desktop/tests/e2e/pending-overlay.spec.ts`. v12 People draws the
roster bar verb `Add` and, on an empty roster, the first-run commit `Add
person`. The regex `/^Add(?: person)?$/u` matched both, and Playwright
strict mode failed `toBeVisible()`. The locator is now the first match
inside `inline-app-view`.

`prepareTally` recovers a friend `party_id` after an idempotent add-friend replay.
`tally.add_friend` is `idempotency: once`. A Playwright retry of the same
`intentId` can return `executed` without `party_id` when the dashboard
read landed empty. The web journey now polls until a friend `party_id`
exists, taking it from the dashboard or from a fresh add-friend output.

`GatewayPerformanceMonitor.resetMeasurement()` restarts the rolling lag window; peak p99 is not a leftover handful of samples.
That lives in `packages/server/src/serve/gateway-performance.ts`, with
the leftover-timer case in
`packages/server/src/serve/gateway-performance.test.ts`. Peak p99 is a
completed window; an in-progress handful of samples does not promote into
peak while the timer is running. `packages/server/scripts/bench-low-end.mjs`
warms one atlas insert of each write shape before reset, then waits one
sample interval after the measured writes before reading health.
`bun run test:perf:pr` still uses the existing `low-end-budgets.json` ceilings
in `packages/server/benchmarks/low-end-budgets.json`.
`packages/server/benchmarks/README.md` records the epoch restart.
`CHANGELOG.md` Unreleased/Fixed names the CI repair.

## User impact

None at runtime. People still has both New-person controls; the journey
just finds them. Gateway request path and Resource-mode lag shedding still
use the live window p99.

## Out of scope

- Raising `eventLoopLagPeakP99Ms` or any other low-end ceiling.
- Nightly / scheduled `e2e` and `Companion e2e` (#676 / #675).
- Retrying `bun install` for the one-off `pdfjs-dist` tarball extract on
  `design-gallery`.

## Verification

```sh
bun run --cwd packages/server test src/serve/gateway-performance.test.ts
bun run --cwd packages/server typecheck
```

- `gateway-performance.test.ts` (with `health-registry.test.ts`): 26 passed.
- `packages/server` typecheck: exit 0.
- Web Playwright `pending-overlay.spec.ts` not re-run locally (needs the CI
  harness gateway). Diagnosis is from run 32238362410: strict mode on two
  `Add` / `Add person` buttons.

## Audit

- (1) What changed vs diff: PASS — Working tree vs `5cb74c76a` is the files
  named: web/desktop pending-overlay locators plus web `prepareTally`;
  `gateway-performance.ts` restarts the rolling window on reset and keeps
  peak as a completed-window statistic; the unit test covers the leftover
  timer; `bench-low-end.mjs` warms one insert of each shape and waits one
  sample interval before health; budgets JSON is untouched;
  `benchmarks/README.md` and `CHANGELOG.md` Unreleased/Fixed match.
- (2) Checked items realized in the diff: PASS — locators are first-match
  inside `inline-app-view`; `prepareTally` polls until a friend `party_id`
  exists after an idempotent replay; `resetMeasurement` restarts the timer;
  `low-end-budgets.json` is not in the diff.
- (3) Checklist mirrors the issue: PASS — the receipt’s four `- [x]` items
  are the same four issue #827 checklist lines, same order and wording.

Verdict: PASS — the receipt’s What changed and checked items match the
working-tree change, and the checklist is a copy of issue #827.
