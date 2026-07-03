# issue-262 — Apps browse: bounded, ordered reads instead of whole-entity pulls

GitHub issue: [#262](https://github.com/srikanth235/centraid/issues/262)

Follow-up to #261: search moved into the vault's FTS5 index; browsing was
the remaining unbounded pull — every app's initial query read whole
entities, capped only by the gateway's 10k LIMIT.

## Checklist

- [x] Commit 1 — vault: ReadRequest.orderBy — validated ordering for bounded windows
- [ ] Commit 2 — blueprints: browse queries read bounded recent windows + Show more

## What changed

### Commit 1 — vault: ReadRequest.orderBy — validated ordering for bounded windows

- `packages/vault/src/gateway/types.ts` — `OrderBy { column, dir? }` on
  `ReadRequest`; without ordering, a bounded read picks arbitrary rows, so
  ordering is what makes a window a RECENT window. UUIDv7 PKs sort by time,
  so tables with no timestamp column order by their id.
- `packages/vault/src/gateway/filters.ts` — `compileOrderBy`: the column
  must be a real column of the table (same allow-list discipline as
  FilterClause), the direction one of two literals — no caller string
  reaches SQL. `packages/vault/src/gateway/gateway.ts` appends the ORDER BY
  fragment before LIMIT in `read()`. `packages/vault/src/index.ts` exports
  the `OrderBy` type.
- `packages/vault/src/gateway/read-order.test.ts` (new) — 5 tests: recent
  window vs arbitrary rows, default ascending, UUIDv7-id time order,
  injection/direction validation, composition with caller filters.

## Decisions

- No cursor/offset pagination: apps grow the window (re-read with a larger
  limit) — simpler, dedup-free, and cheap at these scales; a cursor can
  land later without changing the surface.

## Out of scope

- Cursor/offset pagination (limit-growth is enough at these scales).
- The recipient/candidate pickers' in-memory filtering.
- Remaining projection-filtering apps (people, agenda, budgets, photos,
  home-inventory, subscriptions).

## Verification

```bash
cd packages/vault && npx vitest run && npm run typecheck   # 178 tests, incl. 5 in gateway/read-order.test.ts
```

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-ebbf4c46-af9-1783106558-1 | claude-code | ebbf4c46-af9f-44e5-b10a-49ab9071508f | #262 | claude-fable-5 | 137097 | 2029424 | 91571698 | 423792 | 2590313 | 139.5001 | 137097 | 2029424 | 91571698 | 423792 | feat(vault): ReadRequest.orderBy — validated ordering for bounded windows (#262) |
