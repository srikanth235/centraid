---
name: sqlite
description: >-
  Design SQLite schemas and write correct, fast, durable SQL. Use this skill whenever you write, review, refactor, debug or explain SQL, DDL, a migration, an index, a transaction, a trigger, FTS5, or database access from Rust through rusqlite. Trigger on SQLITE_BUSY, constraint failures, "no such table", slow queries, WAL or checkpoint questions, even when the user does not ask for "best practices". Closes with how Centraid's vault and gateway apply them.
---

# SQLite best practices

Where common advice disagrees, this file says which to follow and why. The digests in `references/` go deeper on schema design, query performance, concurrency and migrations.

## 1. Mindset

- **The schema is the contract.** Constraints the database enforces (types, `NOT NULL`, `CHECK`, foreign keys, unique indexes) hold for every writer, forever; constraints in application code hold only for the code you remembered to write.
- **SQLite is a library, not a server.** Connections are cheap, there is one writer at a time, and the file is the whole database. Design for that instead of imitating a client/server database.
- **Measure queries, don't guess.** `EXPLAIN QUERY PLAN` says what a query will do; read it before and after adding an index.
- **Cost that grows with the data is a design bug,** not a tuning task. Every query on an interactive path is bounded.

## 2. Before you hand back SQL

- Every statement uses bound parameters (`?1`, `:name`). Never build SQL by string formatting with values; it is both an injection hole and a cache miss.
- Every query on a hot path has been checked with `EXPLAIN QUERY PLAN`: no full scan of a table that grows.
- Every schema change comes with a migration and a test that opens an old database.
- Writes that belong together are in one transaction.

## 3. Schema design

- **`STRICT` tables** so a column's declared type is enforced; without it SQLite accepts any value in any column (type affinity).
- **Primary keys:** a stable, meaningful key or a generated id. Pick one id format per database and keep it; time-ordered ids (UUIDv7) keep inserts local in the index.
- **`NOT NULL` by default.** A nullable column means "unknown or not applicable", and every reader must handle it.
- **`CHECK` constraints** for enumerations and shapes (`CHECK (status IN ('open','done'))`, "exactly one of these columns is set"). When you add a value to a `CHECK`, find every writer and reader of that column.
- **Foreign keys with a deliberate delete rule:** `CASCADE` for parts owned by the parent, `RESTRICT`/`NO ACTION` for references that must block a delete, `SET NULL` only when null is meaningful. Siblings referencing the same parent should agree. Foreign keys are off by default in SQLite and are a per-connection setting: turn them on in every connection.
- **Timestamps in one format per database** (ISO-8601 text or integer milliseconds), with a clear `created_at`/`updated_at` policy applied to every table.
- **`WITHOUT ROWID`** for tables keyed by a composite or text primary key with small rows; note that `update_hook` does not fire for them.
- **Normalise first,** denormalise only for a measured read path, and keep the copy maintained in one place.

## 4. Queries and indexes

- An index serves a query when its leading columns match the equality filters, followed by the range or sort column. Design indexes from the queries, not the columns.
- **Covering indexes** (all selected columns in the index) avoid table lookups on hot reads.
- **Partial indexes** (`WHERE deleted_at IS NULL`) keep indexes small for common filters; **expression indexes** serve queries on `lower(name)` or JSON fields.
- **Paginate by key, not offset.** `WHERE (sort_key, id) > (?1, ?2) ORDER BY sort_key, id LIMIT ?3` stays fast at any depth; `OFFSET` reads and discards every skipped row.
- `SELECT` the columns you need. Avoid functions on indexed columns in `WHERE` unless an expression index matches.
- Correlated subqueries and `IN (SELECT …)` are fine when they use an index; check the plan.
- Run `ANALYZE` (or `PRAGMA optimize`) so the planner has statistics, when the database is large enough for plans to vary.

## 5. Writes, transactions and concurrency

- **Group related writes in one transaction.** It is atomic, and far faster than many autocommit statements.
- **Use `BEGIN IMMEDIATE` for a transaction that will write.** A deferred transaction that reads first and writes later can fail with `SQLITE_BUSY` immediately, without waiting, when another writer got there first.
- **Keep write transactions short;** never hold one across network calls or user input.
- **Set a busy timeout** on every connection so a waiting writer retries instead of failing.
- **WAL mode** lets readers proceed during a write. Readers see a snapshot as of their transaction's start.
- **Upsert with `INSERT … ON CONFLICT (…) DO UPDATE`.** `INSERT OR REPLACE` deletes the old row and inserts a new one: it fires no delete trigger (unless recursive triggers are on), is not reported to the update hook as a delete, and can cascade through foreign keys.
- **Read-modify-write belongs inside one transaction** owned by one function, never spread across callers.

## 6. Durability and file safety

- `synchronous = FULL` when every acknowledged commit must survive power loss; `NORMAL` under WAL can lose the last commits.
- Copy a live database only through the online backup API or `VACUUM INTO`, never by copying the file: a file copy during a write can be torn, and the `-wal` file holds committed data.
- Don't put the database on a network file system, and never delete or move `-wal` and `-shm` files while a connection is open.
- `VACUUM` rewrites the whole file and renumbers pages. Decide deliberately whether to run it; it changes every page a page-level backup tracks.

## 7. Migrations

- **Track the schema version** with `PRAGMA user_version` (and `application_id` to tag the file as yours), migrating forward one step at a time, each step in its own transaction.
- **Forward-only.** Refuse to open a file from a newer schema rather than guessing.
- **Never edit a migration that has shipped;** add a new one. Changing a column usually means create a new table, copy, drop, rename, with foreign keys off during the copy and a `PRAGMA foreign_key_check` after.
- **Test migrations against real old files,** including rows that the old schema allowed and the new one constrains.

## 8. Triggers, FTS and JSON

- Triggers for invariants the schema cannot express (immutability, append-only history, shape checks), kept short and side-effect-free beyond the database.
- FTS5 for full-text search; keep the index in sync in the same transaction as the source rows, and rebuild it rather than patch it when its definition changes.
- JSON columns for genuinely schemaless data only; anything queried often deserves a real column or an expression index.

## 9. rusqlite

- `prepare_cached` for statements run repeatedly; `params![]` or named parameters; map rows with `query_row`/`query_map` into typed structs in one place.
- `Transaction` (or `transaction_with_behavior(Immediate)`) for multi-statement writes; it rolls back on drop unless committed.
- Convert `rusqlite::Error` into the crate's own error type at the module boundary; callers should not match on SQLite error codes.
- Blocking database calls do not run on an async executor thread.

## 10. Reviewing a schema change

Reading the DDL is not enough. Sweep mechanically:

- every `CHECK` value against every writer of that column;
- every foreign key's delete rule against its siblings on the same parent;
- every table's timestamp columns against the policy;
- every new query's plan against a database seeded at realistic volume.

## 11. Final checklist

- Parameters bound; no SQL built from values.
- Hot queries checked with `EXPLAIN QUERY PLAN`; paging by key with a `LIMIT`.
- Constraints in the schema: `STRICT`, `NOT NULL`, `CHECK`, foreign keys with chosen delete rules, foreign keys enabled per connection.
- Writes grouped in short `BEGIN IMMEDIATE` transactions; upserts, never `OR REPLACE`.
- A forward-only migration and a test from an old file.

## 12. In this repo

There are two databases. **The vault** (`vault.db`) lives on the phone and the Rust core is its only writer. **The gateway's `state.db`** is the blind store's bookkeeping.

- **SQL lives only in the vault, ontology, search and apps-kit crates**; a check (`sql-confinement`) fails on SQL elsewhere. The gateway keeps its statements in `.sql` files loaded with `include_str!`.
- **One connection, one writer per vault.** Every vault write goes through `Vault::commit` (`BEGIN IMMEDIATE`); reads go through `Vault::read`. Never open a second writable connection or copy the file.
- **Pragmas are fixed by the vault's opener:** WAL, `synchronous = FULL`, a busy timeout, foreign keys on, `auto_vacuum = NONE`. **`VACUUM` never runs**, because the backup is the file cut into page ranges and a vacuum would make every range new. Backups use the online backup API. Read `docs/traps/wal-checkpoint.md` before changing any of this.
- **Schema versioning:** `application_id` tags the file, `user_version` counts migration rungs, and a schema digest is checked on open. The baseline (`contracts/migrations/001_baseline.sql`) is edited in place until the first release that must migrate; after that, changes are new rungs. `contracts/schema/vault-ddl.sql` is generated, not edited.
- Vault ids are UUIDv7 text and vault timestamps ISO-8601 text; the gateway uses millisecond integers.
- Upsert, never `OR REPLACE`, in vault writers. Lists page by key, never `OFFSET`.

## References

Read when the task touches the area:

- `references/schema-design.md`: types, constraints, keys, normalisation.
- `references/query-performance.md`: indexes, query plans, pagination.
- `references/concurrency-durability.md`: WAL, locking, busy handling, durability.
- `references/migration-patterns.md`: versioning and table rebuilds.

The references are from [claude-mods](https://github.com/0xDarkMatter/claude-mods) by 0xDarkMatter (MIT, [license](licenses/claude-mods-LICENSE)). Where they recommend `VACUUM`, `synchronous = NORMAL` or a migrations table, section 12 wins.
