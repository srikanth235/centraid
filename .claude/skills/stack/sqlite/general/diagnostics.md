# SQLite diagnostics for Centraid

> Diagnostic table and profiling guidance adapted from [Bama](https://github.com/daveebbelaar/bama) by Dave Ebbelaar (MIT, [license](../licenses/Bama-LICENSE)). Use this when a database error or a performance change calls for focused investigation; it does not make profiling a requirement for routine SQL work.

Fix the first error first. A failed statement inside a transaction often explains later errors.

| Symptom | What to check |
| --- | --- |
| `SQLITE_BUSY` / "database is locked" | Another writer holds the lock. Use a busy timeout, begin writers with `BEGIN IMMEDIATE`, shorten the transaction, and check for a reader holding a transaction open. In the vault, a second writable connection must not exist. |
| `FOREIGN KEY constraint failed` | The parent may be missing, or a delete may be blocked by a child. Insert parent before child, review the delete rule, and use `PRAGMA foreign_key_check` to list offenders. |
| `CHECK constraint failed` | The value is outside the allowed set. Find every writer; when adding an enum value, update the constraint and writers together. |
| `UNIQUE constraint failed` | Upsert with `ON CONFLICT (...) DO UPDATE`, or look up first inside the same transaction. |
| `NOT NULL constraint failed` | Supply the value or decide whether the column is genuinely optional. |
| `no such table` / `no such column` | The file may use an older schema, a migration may not have run, or the name may be misspelled. Compare with `PRAGMA table_info(t)`. In the vault, fix the source schema and digest; never patch a vault file. |
| "cannot start a transaction within a transaction" | One function begins a transaction while its caller already owns it. Own the transaction in one place and pass the transaction or connection down. |
| "cannot VACUUM from within a transaction" | Run it outside any transaction. The vault never runs `VACUUM`. |
| `rusqlite::Error::QueryReturnedNoRows` | `query_row` found nothing. Use `.optional()` (`rusqlite::OptionalExtension`) when absence is a normal answer. |
| `rusqlite::Error::InvalidColumnType` | The Rust type does not match the stored value. Fix the `get::<_, T>` type or the writer. |
| "too many SQL variables" | Chunk an `IN (...)` list, or join against a temporary table or `json_each`. |
| `VaultError::SchemaMismatch` on open | The file's tables differ from the build's `SCHEMA_DIGEST`. After a baseline edit, run `cargo test -p centraid-vault the_schema_digest_is_the_founded_files` and put its `found:` value in `SCHEMA_DIGEST`. A file changed outside the core is refused on purpose. |
| `VaultError::DowngradeRefused` | The file came from a newer build. Use the newer build; the core never guesses a schema down. |

## Performance investigation

When a change targets performance, use this loop:

```text
reproduce -> measure at realistic volume -> read the plan -> fix -> measure again -> report the numbers
```

1. Reproduce at year-three volume. A query that is fast over hundreds of rows can scan tens of thousands. Centraid's year-3 corpus (`crates/core/tests/year3_corpus`) has about 46,000 entities, and app year-three rigs are marked `#[ignore]`.
2. Measure a warm optimized build (`--release`) with multiple samples and report the p95, not one run. This is a diagnostic you run by hand; no gate step asserts on a duration (owner ruling 2026-11-04).
3. Read `EXPLAIN QUERY PLAN` before and after. `SCAN t` on a growing table is a finding; `SEARCH t USING INDEX` or `USING COVERING INDEX` is usually the goal. `USE TEMP B-TREE FOR ORDER BY` means the index does not serve the sort.
4. Make the smallest useful change, then measure again. Report before and after with the plan change where applicable.

| Symptom | Tool |
| --- | --- |
| Query slow | `EXPLAIN QUERY PLAN <sql>` (SQLite shell or `Vault::explain_query_plan`); run `ANALYZE` first if plans vary with database size. |
| App page may scan a growing table | [`crates/core/tests/query_plans.rs`](../../../../../crates/core/tests/query_plans.rs) plans app loader pages and refuses a scan of a growing table. |
| Writes slow | Batch related statements in one `BEGIN IMMEDIATE`; check `synchronous` and avoid a checkpoint after every commit. |
| Search slow | Read `EXPLAIN QUERY PLAN` for the search statement; the FTS door's bounds are in `crates/search`; time it by hand with a `--release` year-3 corpus (`crates/core/tests/year3_corpus`). |
| Whole app read path | `cargo test --release -p centraid-apps-<app> --test year3 -- --ignored --nocapture`; see each app's `tests/journeys.json` ceilings. |

A database file is data: do not attach a user's vault to a bug report. Delete profiler output (`perf` data, flamegraph SVGs, traces) after reading, because it can contain environment details and inherited tokens.

For engine-level plan interpretation and index design, see [`query-performance.md`](query-performance.md). For rusqlite ownership and transaction patterns, see [`concurrency-durability.md`](concurrency-durability.md).

## Query and schema review

Before changing SQL:

- Bind values with `?1` or named parameters; do not interpolate them into SQL.
- For performance work, inspect the plan on representative data and keep interactive reads bounded with a `LIMIT` and keyset paging.
- Sweep each `CHECK` value against its writers, each foreign-key delete rule against sibling references, mutable timestamps against the table policy, and each changed query's plan against realistic data.
- Put constraints in the schema where possible (`STRICT`, `NOT NULL`, `CHECK`, foreign keys with deliberate delete rules); enable foreign keys on every connection.

For Rust callers, cache repeated statements with `prepare_cached`, map rows into typed structs in one place, and use a `Transaction` or immediate transaction for grouped writes. Convert `rusqlite::Error` at the crate boundary, use `.optional()` when no row is a normal result, and keep blocking database calls off async executor threads.
