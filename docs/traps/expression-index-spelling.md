# Trap: an expression index only answers a query that spells the expression identically

## What goes wrong

SQLite matches an **expression** index by comparing the index's expression text with the query's, after its own normalization — not by evaluating the two and noticing they agree. Rename a helper, inline a constant, reorder an `IN` list, change `json_type(x)` to `json_type( x )` through a different builder, and the index silently stops being used. Nothing errors: the query still returns the right rows, from a full scan of the entity, and the only symptom is a read that used to take a millisecond taking tens.

The replica's ordered reads are built on exactly this. `packages/client/src/replica/store-core.ts` creates two expression indexes per ordered column — `replica_row_cen_*` over `censusClass(column)` and `replica_row_ord_*` over `jsonValue(column)` — and `packages/client/src/replica/read-plan.ts` then asks its guard questions with the same expressions. The class ladder (`0` oversized, `1` undisclosed, `2` unordered, `3` numeric, `4` text, `5` JSON null and anything SQLite adds later) is deliberately **fixed** and does not vary with the role or the schema, because a ladder that varied would be a second spelling.

## Invariants (code)

- One function emits each expression, and both the index and the probe call it: `censusClass` and `jsonValue` / `jsonType` in [`packages/client/src/replica/read-plan-clauses.ts`](../../packages/client/src/replica/read-plan-clauses.ts). Never hand-write either expression at a call site.
- `ensureCensusIndex` and `ensureOrderIndex` ([`store-core.ts`](../../packages/client/src/replica/store-core.ts)) are the only creators, and both build their DDL from those same functions.
- `ORDER_INDEX_MAX` caps how many of each a session creates; past the cap the index is skipped and the read falls back to a scan, which is a budget decision, not a correctness one.
- The rule is asserted, not just written down: [`packages/client/src/replica/order-census.test.ts`](../../packages/client/src/replica/order-census.test.ts) reads the query plan and fails unless every `replica_row` step of a census access names `replica_row_cen_`. It was landed red — the plan then said `SEARCH replica_row USING INDEX replica_row_ord_…`, which is the neighbouring index, not the census one.

## How agents get it wrong

1. **"Simplifying" the ladder** — collapsing two `WHEN` arms, or dropping the `ELSE 5`, changes the index expression and every probe that was not changed with it stops matching.
2. **Building the probe's SQL inline** because the guard "only needs the numeric case" — one call site with its own spelling is one silently unindexed read.
3. **Widening `UNORDERED_TYPES` / `NUMERIC_TYPES` / `TEXT_TYPES` without re-creating the index.** `CREATE INDEX IF NOT EXISTS` will not rewrite an index that already exists under that name, so an existing replica file keeps the old expression while the probes use the new one. A ladder change needs a new index name (or a schema-epoch rebuild), not a new list.
4. **Trusting a green suite.** Every assertion still passes on a full scan. Only the plan assertion catches it.

## Safe patterns

| Goal | Do |
| --- | --- |
| Add or change an ordering expression | change it in `read-plan-clauses.ts` only, and add the plan case to `order-census.test.ts` before the change |
| Add an ordered column to an app | nothing — `ensureOrderIndex` derives both indexes from the plan |
| Prove an index is really used | assert on `EXPLAIN QUERY PLAN` naming the index, not on the timing |
| Change the class ladder | give the index a new name in the same commit, so an existing file rebuilds instead of keeping the old expression |
