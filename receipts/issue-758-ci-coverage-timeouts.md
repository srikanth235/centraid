# issue-758 — Restore the CI coverage lane after gateway test timeouts

GitHub issue: [#758](https://github.com/srikanth235/centraid/issues/758)

The main branch `ci / verify` job was failing in `bun run coverage` because
two gateway integration tests exhausted timing budgets while doing durable
SQLite work under V8 instrumentation. After those tests were fixed, the PR
run still exceeded the workflow's 25-minute cap while coverage continued to
pass, so the bounded job budget now has explicit headroom as well.

## Checklist

- [x] Investigate the `ci / verify` coverage timeout on main.
- [x] Add narrowly scoped timeout headroom for the two affected gateway tests.
- [x] Keep the hosted coverage job within a bounded timeout with sufficient headroom.
- [x] Verify the focused tests and repository coverage gate.

## What changed

- Investigate the `ci / verify` coverage timeout on main.
- Add narrowly scoped timeout headroom for the two affected gateway tests.
- Keep the hosted coverage job within a bounded timeout with sufficient headroom.
- Verify the focused tests and repository coverage gate.
- `packages/gateway/src/lifecycle/webhook-route-over-http.test.ts` gives the
  durable-ingress polling `vi.waitFor` a 30-second budget. The existing
  10-second cursor wait is unchanged.
- `packages/gateway/src/serve/demo-seed.test.ts` gives the full shipped-scenario
  seed-and-purge test a 60-second test budget.
- `.github/workflows/ci.yml` raises the `verify` job timeout from 25 to 35
  minutes, preserving a finite CI bound while allowing the full instrumented
  suite to finish on a slow hosted runner.
- `receipts/issue-758-ci-coverage-timeouts.md` records the issue, scope, and
  verification evidence.

The gateway changes are test-only timing budgets and do not change gateway
behavior or production timeouts. The workflow change only extends the
existing bounded `verify` job timeout; coverage thresholds and coverage
policy remain unchanged.

## Out of scope

- Production gateway or automation behavior.
- Coverage-floor, formatter, or other toolchain configuration.
- The pre-existing V8 coverage parse warning for `apps/web/src/main.ts`; it is
  reported as an excluded file and does not fail the coverage command.

## Verification

```sh
bun install --frozen-lockfile
bun run build
bun run --cwd packages/gateway test -- src/lifecycle/webhook-route-over-http.test.ts
bun run --cwd packages/gateway test -- src/serve/demo-seed.test.ts
bun run --cwd packages/gateway test -- --coverage src/lifecycle/webhook-route-over-http.test.ts src/serve/demo-seed.test.ts
bun run lint:workflow-pins
bun run format:check
bun run coverage
git diff --check
```

The full coverage run passed with 1,123 test files, 4 skipped (1,127 total),
and 12,160 tests passing;
the focused normal and V8-covered runs also passed.

## Decisions

Keep the remedy at the two affected test call sites rather than widening
shared Vitest defaults. Also increase only the `verify` job's bounded timeout:
the hosted runner canceled a still-passing coverage run at 25 minutes, so
35 minutes supplies headroom without removing the runaway-job guard.

## Audit

PASS — the independent fresh-context audit confirmed that the diff is limited
to the two failing gateway tests, the bounded `verify` timeout, and this
receipt. It preserves production behavior and coverage policy; the workflow
change only gives the existing full-coverage lane enough finite runtime on
slow hosted runners. Its initial test-file count discrepancy was corrected
above: 1,123 passed, 4 skipped, 1,127 total.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-12 | codex | 019ff736-d929-78c0-a5b0-d00fe24f378e |
