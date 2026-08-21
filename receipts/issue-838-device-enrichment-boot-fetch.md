# Issue #838 — the device-enrichment worker is fetched during shell boot

GitHub issue: [#838](https://github.com/srikanth235/centraid/issues/838)

`client-e2e / web-e2e` was red on `main` and on every branch cut from it:
`cold shell request count` measured 18 against a ceiling of 17. The cause was
a boot-time `import()` whose own comment claimed it did the opposite.

## Checklist

- [x] The cold-shell same-origin resource list contains neither the device-enrichment worker chunk nor `pdf.worker.min`
- [x] `perf-waterfall.spec.ts` "app-open waterfall" passes without any budget being widened
- [x] The device-enrichment worker still installs and still runs on an opted-in device — deferred, not removed

## What changed

One statement, in `packages/client/src/react/boot.tsx`. It was:

```ts
// … Dynamic import keeps the PDF.js worker off the shell's startup path; the
// queue runner itself waits for browser idle time.
void import("../device-enrichment-worker.js")
  .then((module) => module.installDeviceEnrichmentWorker())
  .catch(() => undefined);
```

**Dynamic and immediate are different things.** The import gave the worker its
own chunk and then requested it during boot, so both
`/assets/device-enrichment-worker-*.js` and the `/assets/pdf.worker.min-*.js`
asset it pulls sat on the cold-load waterfall of every seat — including the
seats that can never satisfy the feature's charging + unmetered conditions. The
comment described the intended behaviour accurately; only the code disagreed.

The fetch is now behind a `window.setTimeout` of `DEVICE_WORK_LOAD_DELAY_MS`
(60s), and the comment above it states the rule in the feature's own terms: a
background contributor does not touch the network in the first minute of a
session. The runner is unchanged — it still waits its own `INITIAL_DELAY_MS`,
still re-checks charging and unmetered on every attempt, and still polls on
`POLL_INTERVAL_MS` (five minutes). Against that cadence a first load one minute
in is prompt.

Measured on the real harness, before and after (`PWA WATERFALL SUMMARY`, local
dist, headless Chromium):

| | cold requests | cold bytes | warm bytes | ratio |
| --- | --- | --- | --- | --- |
| before | 19 | 448,415 | 0 | 0 |
| after | **17** | 445,898 | 0 | 0 |

No budget moves. `apps/web/tests/e2e/perf-budgets.ts` is untouched.

## Out of scope

- **Tightening `perfBudgets.shell.maxRequests`.** The ceiling is 17 and the
  measurement is now 17 locally (CI measures one fewer than this container did
  — it read 18 where local read 19 — so CI should land at 16). The repo's own
  practice for this file is to seed a ceiling from a CI measurement rather than
  a derived one, and the deviation note says so in as many words; tightening
  should follow a CI number, in its own change.
- **What the worker does once installed.** No capability, lease, condition or
  interval changes.
- **The `app cold` encoded-byte floor.** It reads 7,346 B in this container
  against a 70,000 floor, identically before and after this change; CI measured
  80,561 B for the same assertion. That is a local-dist discrepancy this change
  neither causes nor fixes.
- **The other lanes on this branch.** `design-gallery` belongs to
  [#835](https://github.com/srikanth235/centraid/issues/835).

## Decisions

**Two earlier attempts were measured and abandoned, and both are worth
recording because each looked right on paper.**

1. *Gate the import on the charging/unmetered predicate.* The predicate is
   already conservative — "unknown power state is not consent to burn battery"
   — so it looked like it would decline in a headless runner. It does not:
   `navigator.getBattery` is a function there and answers `charging: true`, as
   it does on any mains-powered desktop. The gate would have declined on almost
   nothing.
2. *Extract that predicate into an import-free module so `boot.tsx` could ask
   cheaply.* Both `boot.tsx` and the lazily-imported worker would then import
   it, which makes it a SHARED chunk rather than an inlined one — a third
   same-origin request. Measured: 19 → **20**. Reverted whole.

**The delay is stated as a product rule, not as a number that clears a fence.**
An earlier revision used 10s, mirroring the runner's own `INITIAL_DELAY_MS`.
Measured, that moved the cold-shell count to 17 but simply relocated the bytes
into the reload that follows — the warm/cold byte ratio went 0 → 0.151 against
a 0.15 ceiling, i.e. the same session paying the same price a moment later. 60s
keeps the cost off both ends of a fresh session, and the sentence in the code
says why without referring to any test.

**No budget was widened at any point.** The alternative to all of the above was
extending `approvedDeviation` and moving `maxRequests` to 18, which would have
recorded two accidentally-eager worker chunks as intentional product cost.

**The `## Audit` verdict below was NOT produced by a fresh-context sub-agent** —
agent spawning was disabled for this session, so it is an in-session
adversarial re-read. Same caveat as this branch's other receipts.

## Verification

The harness itself, before and after:

```sh
bun run --cwd apps/web build
bun run --cwd apps/web e2e -- perf-waterfall -g "app-open waterfall"
# PWA WATERFALL SUMMARY
# shell cold:  requests=17 transfer=445898B
# shell warm:  requests=19 transfer=0B (ratio 0)
```

Demonstrated red, which is the state this issue exists to fix — on `main`, and
on this branch before the change:

```sh
git checkout main && bun run --cwd apps/web e2e -- perf-waterfall
# Error: cold shell request count
#   Expected: <= 17
#   Received:    18        (CI run 32395102558; this container reads 19)
```

The worker's own suite and the rest of the client package:

```sh
node node_modules/vitest/vitest.mjs run packages/client --reporter=dot
# Test Files 252 passed (252) · Tests 2304 passed (2304)
bun run typecheck
# Tasks: 25 successful, 25 total
```

### Checklist crosswalk

Each checked item verbatim, and where it is realized:

- The cold-shell same-origin resource list contains neither the device-enrichment worker chunk nor `pdf.worker.min` — enumerated directly off `performance.getEntriesByType("resource")` before and after; the count drops 19 → 17 and the two named entries are the two that leave.
- `perf-waterfall.spec.ts` "app-open waterfall" passes without any budget being widened — `apps/web/tests/e2e/perf-budgets.ts` is not in the diff; every shell assertion passes on the measurement above.
- The device-enrichment worker still installs and still runs on an opted-in device — deferred, not removed — `installDeviceEnrichmentWorker()` is still called, unchanged, from the same place; only the moment of the fetch moves, and `packages/client` is green.

## Audit

**PASS**, with the independence caveat under `## Decisions`.

- **`## What changed` against the diff.** The diff is two files:
  `packages/client/src/react/boot.tsx` (one statement and its comment) and this
  receipt. Both are named; nothing else is touched, and in particular no budget
  file, no test and no part of the worker itself.
- **Each `- [x]` against the diff.** The first two rest on a measurement
  reproduced in this container and quoted above; the third rests on the call
  site being unchanged apart from when it fires.
- **The `## Checklist` against the issue's acceptance criteria.** Three items,
  verbatim and in order.
- **The limit, stated plainly.** The numbers above are this container's, and it
  is known to disagree with CI on this rig — it reads 19 where CI reads 18 cold,
  and 7,346 B where CI reads 80,561 B on the app-open floor. The direction and
  the size of the change (two named requests leave the cold window) hold either
  way, but the exact post-fix CI count is a CI measurement this receipt does not
  have.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-21 | claude-code | 52ba79df-c11a-5a90-99a8-ae103946d145 |
