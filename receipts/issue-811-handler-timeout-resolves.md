# Issue #811 — hung handler timeout must resolve `runHandler`

GitHub issue: [#811](https://github.com/srikanth235/centraid/issues/811)

`main` went red on `7f7583de7` (`#810`). `ci / verify` failed because
`handler-pool.test.ts` > "a hung handler is still terminated on timeout
without poisoning the pool" hit Vitest's 60s outer budget. `Governance`
failed because that merge's subject is 113 characters (max 100). `check`
only aggregated the verify failure.

The verify failure is a product hang, not a budget that needed raising
again. `runHandler` treated `timeoutMs` as "call `worker.terminate()` and
wait for `exit`". Under the instrumented coverage suite that exit can
arrive after the test (and the request) has already given up. The next
commit's subject heals the tip-only `commit-message-format` check on
`main`.

## Checklist

- [x] Make `runHandler` resolve on timeout without waiting for worker exit
- [x] Pin the hung-handler test to the timeout error (not an exit-code race)
- [x] Keep handler-pool tests off the shared production admission gate
- [x] Record the CI repair (changelog + receipt)

## What changed

Make `runHandler` resolve on timeout without waiting for worker exit.
`packages/server/src/engine/handlers/handler-runner.ts` now calls `finish()`
from the timeout itself with `worker timed out after ${timeoutMs}ms`,
persists that error to the app log, releases the admission slot, and lets
`finish()` terminate the worker. A late `exit`/`error`/`result` is ignored
by the existing `resolved` guard.

Pin the hung-handler test to the timeout error (not an exit-code race).
`packages/server/src/engine/handlers/handler-pool.test.ts` now expects
`/timed out after 100ms/iu` instead of `/exited with code|worker/iu`, so a
slow-exit success cannot hide a timeout that never resolved.

Keep handler-pool tests off the shared production admission gate. The file
builds a private `WorkerAdmission(4, 0, 1000)` per case and routes every
dispatch through it, so a coverage worker's other files cannot queue these
cases behind the process-wide slot cap.

Record the CI repair (changelog + receipt). `CHANGELOG.md` Unreleased /
Fixed names the fail-closed timeout. This receipt is the audit trail.

## Decisions

None. The timeout contract was already "the handler is terminable"; the
implementation waited on a thread event that is not the contract. The 60s
outer test budget from #630 stays as load headroom; it is not raised.

## Out of scope

- Rewriting the already-landed #810 subject on `main`. History is not
  rewritten; the next tip commit is what Mode B inspects.
- The pre-existing V8 coverage parse warning for `apps/web/src/main.ts`
  (excluded file; does not fail `bun run coverage`).
- Raising Vitest or workflow timeouts.
- Changing automation-handler timeout (separate runner).

## Verification

```sh
bun run --cwd packages/server test src/engine/handlers/handler-pool.test.ts src/engine/handlers/handler-runner.contract.test.ts
bun run typecheck:affected
```

- `handler-pool.test.ts` + `handler-runner.contract.test.ts`: 12/12 passed in 809ms (hung-handler case included; the file finished in 640ms).
- `bun run typecheck:affected`: 19/19 packages green (vault built first; bare `packages/server` typecheck without that build fails on pre-existing #810 vault export types and is not this change).

## Audit

- (1) What changed vs diff: PASS — Working tree vs `7f7583de7` is the four files the receipt names. `handler-runner.ts` no longer `terminate()`s on the timer and waits for `exit`; the timeout now `finish()`es with `worker timed out after ${timeoutMs}ms`, persists that error, and lets `finish()` release the slot / terminate. `handler-pool.test.ts` pins `/timed out after 100ms/iu` and routes every case through a private `WorkerAdmission(4, 0, 1_000)` via `dispatch()`. `CHANGELOG.md` Unreleased/Fixed adds the fail-closed #811 bullet. This receipt is new.
- (2) Checked items realized in the diff: PASS — Timeout unblocks without waiting on worker exit (`setTimeout` → `finish({ ok: false, error })`; late `exit`/`error`/`result` hit the existing `resolved` guard). Hung-handler assertion is the timeout string, not `/exited with code|worker/iu`. Pool tests no longer take the shared production admission default. Changelog + receipt record the CI repair.
- (3) Checklist mirrors the issue: PASS — Issue #811 `## Checklist` is the same four items, same order and wording, as the receipt. GitHub boxes are unchecked; the receipt marks them `[x]`.

Verdict: PASS — receipt matches the working-tree diff and issue #811.
