# Trap: an expression index only answers a query that spells the expression identically

> **Superseded by [#996](https://github.com/srikanth235/centraid/issues/996) W5.** The machinery this trap was about is deleted. It is kept because [QUALITY.md](../../QUALITY.md)'s resolved-issue record for [#922](https://github.com/srikanth235/centraid/issues/922) C3 cites it, and that record is frozen history.

## What it was about

The replica's ordered reads used to run over `replica_row`, a projection of the vault into JSON blobs. Ordering them meant two **expression** indexes per ordered column — `replica_row_ord_*` over `jsonValue(column)` and `replica_row_cen_*` over `censusClass(column)`, a fixed 0–5 ladder — and SQLite matches an expression index by comparing the index's expression TEXT with the query's, after its own normalization. Rename a helper, inline a constant, reorder an `IN` list, and the index silently stops being used: nothing errors, the query still returns the right rows from a full scan, and a read that took a millisecond takes tens. So one function had to emit each expression, and both the index and the probe had to call it.

## Why it cannot happen now

A seat holds the vault's own file. An ordered read is a keyset statement over the canonical table, and its ordering is served by a COMPOSITE index — plain columns, `(equality predicate columns, sort column, primary key)` — stated in the baseline DDL in `packages/vault/src/schema/read-path-indexes.ts`. A stated index over a real column has no second spelling to drift from, and the assertion is a plan snapshot rather than a per-expression rule: `packages/server/src/serve/app-query-plans.snapshot.md` went from 36 `USE TEMP B-TREE FOR ORDER BY` steps to 0 when those indexes landed, and it is regenerated with the schema.

`replica_row`, `censusClass`, the class ladder, `ORDER_INDEX_MAX` and the plan assertion in `order-census.test.ts` are all gone with the plane. The general SQLite fact is still true of any expression index anyone adds later; nothing in this repo has one.
