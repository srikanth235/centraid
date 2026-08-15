# Receipt — issue #795: first-open offline writes stay durable

## Checklist

- [x] First-open offline writes enter the durable intent outbox instead of
      throwing `not-bootstrapped`.
- [x] Optimistic projection is deferred until bootstrap supplies a shape
      catalog; the action input itself is not discarded.
- [x] Browser-shell and native-session regressions prove the write is queued
      without any gateway request.

## What changed

`packages/client/src/replica/shell-session.ts` and
`apps/mobile/src/lib/replica/native-session.ts` now separate durable intent
admission from optimistic projection. When a brand-new offline replica has no
catalog, both sessions enqueue the action with an empty projection/dependency
set. They also avoid canonical base-version reads until a cursor exists, so an
interrupted first bootstrap cannot turn a safe offline write into a
`not-bootstrapped` exception.

`packages/client/src/replica/shell-session.test.ts` and
`apps/mobile/src/lib/replica/native-session.test.ts` cover the two production
session implementations. Each starts with no cursor or catalog, writes while
offline, receives a `queued` acknowledgement, and proves that no canonical
read or gateway request was needed. The native test additionally reads the
SQLite-backed outbox and confirms the original action input is durable.

`docs/mobile-offline.md` records the current first-open behavior: action intent
first, projection after the shape catalog exists.

While keeping the focused shell suite at 25/25, two existing call-only
assertions in `packages/client/src/replica/shell-session.test.ts` were tightened
to exact call ledgers so the repository hygiene ratchet remains down-only.

### Checklist crosswalk

- **First-open offline writes enter the durable intent outbox instead of
  throwing `not-bootstrapped`.** Both session implementations now enqueue
  before any canonical read, and both tests assert the queued result.
- **Browser-shell and native-session regressions prove the write is queued
  without any gateway request.** The two focused test files exercise the web
  and native rails independently with the gateway mocked out.

- **First-open offline writes enter the durable intent outbox** — both session
  implementations now enqueue before any canonical read, and both tests assert
  the queued result.
- **Optimistic projection is deferred until bootstrap supplies a shape
  catalog** — the no-catalog branch writes empty `optimistic` and
  `dependencies` arrays while retaining the complete action input.
- **Browser-shell and native-session regressions** — the two focused test files
  exercise the web and native rails independently.

## Out of scope

The separate People pending-marker and modal-close UX observation in
`QUALITY.md` remains open. This fix preserves the write; it does not redesign
that app's presentation.

## Decisions

The pre-bootstrap intent deliberately has no optimistic row. Inventing a shape
before the gateway supplies the catalog would bypass the replica contract; the
durable action is the truthful pending state until bootstrap and canonical
replay establish the row schema.

## Verification

```sh
bun run --cwd packages/client test -- src/replica/shell-session.test.ts
bun run --cwd apps/mobile test -- src/lib/replica/native-session.test.ts
```

Focused green evidence: client shell-session is included in the 29 passing
client tests from the paired run; native-session passed 7/7 after the required
workspace build. With the browser-shell no-catalog admission branch temporarily
restored to its pre-fix implementation, the new regression failed 1/25 with
`ReplicaProtocolError: No offline shape for todos/core.task`; restoring this
change returned the focused suite to green. The native test is parity evidence
for the shared invariant; its Photos action already projected no rows in the
pre-fix implementation and therefore was not independently demonstrated red.

## Audit

PASS — fresh-context audit by `/root/receipt_audit_792_796`: the receipt mirrors
issue #795, names every issue-owned changed file, and both session rails retain
durable intent while deferring projection; focused regressions passed 29/29 and
7/7. The post-audit shell-test edits only strengthen call-count assertions into
exact mock ledgers (including an explicit zero-call check) and do not alter the
tested behavior.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-15 | codex | 01a003d7-1e6b-7d00-86a3-4831e330af63 |
