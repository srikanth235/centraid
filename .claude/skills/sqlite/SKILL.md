---
name: sqlite
description: SQLite schema, migrations, queries and their rusqlite access in Centraid's vault and gateway. Use when writing, reviewing or debugging SQL, DDL, a migration rung, an index, a transaction or a rusqlite call in this repo, or on SQLITE_BUSY, constraint-failure, "no such table", slow-query, snapshot or `sql-confinement` errors.
---

# SQLite in Centraid

Two databases, one rule set. **The vault** (`vault.db`, on the phone) is the member's data; the core is its only writer. **The gateway's `state.db`** is a blind store's bookkeeping. The schema is the product's contract: `docs/vault-ontology.md` says what each table means and which commitments the tests enforce. This skill says how to write the SQL.

Laws that live elsewhere are linked, not restated: [docs/traps/wal-checkpoint.md](../../../docs/traps/wal-checkpoint.md) (pragmas, snapshots, `VACUUM`) · [docs/vault-ontology.md](../../../docs/vault-ontology.md) (indexes, commitments, adding a table) · [centraid-engineering](../centraid-engineering/SKILL.md) (store atomicity, nothing O(vault-size) on the request path, no "vaults are small", year-3 scale rigs) · [docs/decisions.md](../../../docs/decisions.md) (R-1029-5, D-1020-D1-2, R-1047-R1, R8, R-1146-1B-6).

## Where SQL may live

| Work | Where |
| --- | --- |
| Vault schema, vault queries, commands | `crates/vault`, `crates/ontology`, `crates/search`, `crates/apps/kit` (the `SQL_ALLOWED_ROOTS` of the `sql-confinement` rule in `crates/xtask/src/rules.rs`) |
| Gateway `state.db` | `crates/gateway/src/server/sql/*.sql`, reached by `include_str!` in `server/sql.rs` |
| Anything else (core, screens, apps, assist, FFI, shells) | Ask the vault or the kit through a typed method. No SQL |

- The rule scans Rust string literals for uppercase `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE`, `PRAGMA`. A crate outside the roots that needs a statement has reached past its layer; move the work to the owning crate. Never rename a keyword to dodge the scan.
- A new gateway statement is a new `.sql` file plus a `statement!` line, one caller each.

## Connection setup

- One opener: `Vault::wrap` in `crates/vault/src/file.rs` applies the pragma set (`journal_mode = wal`, `synchronous = FULL`, `journal_size_limit`, busy timeout) to every connection. `page_size` and `auto_vacuum` are set once in `create_with`. Read the [trap](../../../docs/traps/wal-checkpoint.md) before touching any of it.
- Foreign keys are connection-scoped and off by default: the vault sets `foreign_keys = ON` after the ladder on a create and before it on an open; the gateway sets it in `SqliteState::prepared`. A new opener sets it explicitly.
- Reads go through `Vault::read` (`query_only = ON`). Writes go through `Vault::commit` only ([R-1047-R1](../../../docs/decisions.md): every vault write is under the commit guard).
- Never open a second writable connection to `vault.db`, never `cp` it, never `VACUUM` it. A snapshot is the online backup API under the write lock.

## Transactions and atomicity

| Work | Use |
| --- | --- |
| A vault write | `vault.commit(\|tx\| …)`: `BEGIN IMMEDIATE`, body, reindex, `COMMIT`; one commit is one atomic step |
| A write that reads first | `BEGIN IMMEDIATE` (a deferred read-then-write is `SQLITE_BUSY` at once, `busy_timeout` ignored) |
| Gateway read-decide-write | `SqliteState`'s `atomically` (`BEGIN IMMEDIATE`), never a bare read then write |
| A migration rung | `migrations::run_rungs`: own transaction per rung, `user_version` set inside it |
| Read-only work | `Vault::read` |

- Callers never read, merge and write across statements outside a transaction ([Store atomicity](../centraid-engineering/SKILL.md#state-and-cost)).
- A transaction holds no network I/O, no sleep, no user wait.
- Upsert, never `INSERT OR REPLACE`: REPLACE displaces rows without firing the update hook or delete triggers ([R-1047-R1](../../../docs/decisions.md)).

## Schema rules (verified against `contracts/migrations/001_baseline.sql`)

| Concern | Rule |
| --- | --- |
| Tables | `STRICT` always; `WITHOUT ROWID` for small keyed child and key-value tables (each is covered by `install_without_rowid_census`, because `update_hook` never fires for them) |
| Vault ids | TEXT, minted UUIDv7 from the injected clock ([D-1020-X3-2](../../../docs/decisions.md)); `entity.n` is the integer handle. Never persist a counter |
| Vault timestamps | TEXT, `YYYY-MM-DDTHH:MM:SS.mmmZ` UTC, exactly `strftime('%Y-%m-%dT%H:%M:%fZ','now')`; code writes `Clock::now_text()`. Date-only columns are `CHECK (date(c) = c)` |
| Gateway timestamps | INTEGER `*_ms` since the epoch. A different database, a different convention; never mix inside one |
| Money | INTEGER minor units (`amount_minor`) |
| Enumerations | `CHECK (col IN (...))`, and a Rust enum that a test holds equal to it (`Kind`, `Rel`) |
| Optional JSON | `CHECK (col IS NULL OR json_valid(col))` |
| Row-shape invariants | `CHECK` across columns, e.g. `(deleted_at IS NULL) = (purge_at IS NULL)` |
| Foreign keys | Kind rows, children and edges `ON DELETE CASCADE`; attribution pointers `SET NULL`; the rest no action with a purge rule (commitment 4, 4b) |
| Kind rows | Generated constant `kind … VIRTUAL` plus composite `FOREIGN KEY (id, kind)` |
| Hashes | A column holding a hash is a foreign key into `blob(hash)` |
| Bytes | Large content stays out of rows (`blob:blake3-<hex>` in the byte store) |
| Dormant tables | None. A table with no producer and no consumer leaves the schema ([ONT-dormant](../../../docs/decisions.md)) |

- Every foreign key's first child column leads an index (commitment 9); mostly-NULL columns get a partial index.
- A new `entity.kind`, relation or table is a decision about the model first: follow [Adding or changing a table](../../../docs/vault-ontology.md#adding-or-changing-a-table).

## Migrations

| Situation | Do |
| --- | --- |
| No release has needed to migrate (check `git tag` and [docs/release.md](../../../docs/release.md)) | Edit `contracts/migrations/001_baseline.sql` in place ([R-1029-5](../../../docs/decisions.md)), regenerate `contracts/schema/vault-ddl.sql`, update `SCHEMA_DIGEST` |
| A released baseline exists | Append `002_<name>.sql`, an `include_str!` constant and a `Migration` in `LADDER` (`crates/vault/src/migrations.rs`). Never insert, never edit an applied rung |
| Gateway `state.db` | `schema.sql` is idempotent (`IF NOT EXISTS`), applied on every open; an incompatible change needs its own plan |

- Forward-only. A file above the binary is `DowngradeRefused`; a failing rung leaves the file unmigrated, proved by `999_fails.sql` and the restore drill.
- A rung is proved by founding a vault, winding it back to the previous `user_version`, writing rows the old shape allowed, and opening it. A table recreate follows the 12-step procedure in [references/migration-patterns.md](references/migration-patterns.md) with `foreign_key_check` clean before commit; remember the ladder runs with `foreign_keys` OFF on create and ON on open.
- `SCHEMA_DIGEST` (`crates/vault/src/format.rs`) must equal the founded file: `the_schema_digest_is_the_founded_files` prints the new value.
- Schema changes land with their snapshot and restore evidence ([X-630-migrations](../../../docs/decisions.md)).

## Queries and planning

- Nothing O(vault-size) on a request path ([rule](../centraid-engineering/SKILL.md#state-and-cost)): every list is keyset-paged by a stable `(sort_key, pk)` cursor, never `OFFSET`, with a `LIMIT` ([R8](../../../docs/decisions.md)). Never continue a keyset over a nullable sort column.
- Every hand-written statement in the allowed crates is planned by `crates/core/tests/query_plans.rs` over the year-3 corpus. A full scan or a sort after a paged read fails unless `contracts/ledgers/query-plans.json` says why (down-only ledger). A new statement either streams from an index or gets the index in the baseline.
- Run `EXPLAIN QUERY PLAN` before you ship a statement; the word `COVERING`, no `USE TEMP B-TREE`, no `SCAN` of a large table. Query-planning depth: [references/query-performance.md](references/query-performance.md).
- Index the question the code asks (equality columns, then the range or sort column, then coverage). A partial index only helps a literal predicate that implies its `WHERE`.
- Plan text changes between SQLite versions; the gate is measured work at year-3 scale, not a plan snapshot.
- Page reads are `Request::Page` over `PAGE_TABLES` under an authorizer; do not widen it.

## Parameter binding and rusqlite idioms

- Bind values with `?1` placeholders with `params![]`; never format a value into SQL. `format!` is for identifiers that came from `sqlite_master` or a `PRAGMA`, wrapped in `log::quoted` (`crates/vault/src/log/identifiers.rs`).
- `prepare_cached` for statements on a hot path, `query_row(...).optional()` (`OptionalExtension`) for zero-or-one.
- Dynamic `IN` lists and optional filters: build the placeholder string and bind with `params_from_iter` (`crates/search/src/sqlite.rs`).
- Read columns by index with a typed `get::<_, T>`; STRICT makes a mismatch an error at write, not a surprise at read.
- Convert errors through `VaultError::from_sqlite(context, e)` (classifies `SQLITE_FULL` as `DiskFull` once); do not hand-match `rusqlite::Error` at call sites. Gateway code maps to `StoreFault`.
- `rusqlite` is `bundled` with `session`, `hooks`, `functions`, `backup` (root `Cargo.toml`); do not link a system SQLite.
- Library code returns errors, never `unwrap`s a SQL result outside tests.

## Always / Never

Always

- Add the test with the schema change: commitments (`crates/vault/tests/commitments.rs`), `ladder_ddl.rs`, the digest, and a command test that writes through `Vault::commit`.
- Run the mechanical sweeps below before calling a schema change done.
- State a bound in code (`LIMIT`, retention cap, cursor) for every query over a growing table.
- Seed a scale rig to the declared year-3 volumes when a statement's cost depends on volume.

Never

- Never write to the vault outside the commit guard; never add a second writer.
- Never `VACUUM`, change `auto_vacuum`, or copy `vault.db` with `cp` ([trap](../../../docs/traps/wal-checkpoint.md)).
- Never edit an applied rung; never add a dormant table "for later".
- Never `INSERT OR REPLACE` on a vault table.
- Never `SELECT *` into a typed row on a hot path; name columns.
- Never put SQL in a Rust literal outside the confinement roots.
- Never add a "tables stay small" comment as the justification for a scan.

## Mechanical sweeps (a schema change is not reviewed by reading)

[AGENTS.md](../../../AGENTS.md) and [vault-ontology.md](../../../docs/vault-ontology.md#how-this-model-is-reviewed) make these part of a model review. Run each and record the result in the PR:

1. **CHECK values against writers**: for every `CHECK (col IN (...))` you touched, grep each value in the Rust writers and each writer's value in the CHECK (`rg "'<value>'" crates/vault/src crates/apps`). Both directions; a value nobody writes is dormant, a value a writer emits that the CHECK rejects is a bug.
2. **Delete rules against siblings**: list `PRAGMA foreign_key_list` for the new table and its siblings; the rule must match commitment 4/4b, and the purge path must still be one `DELETE` of the entity row.
3. **Timestamps**: every `*_at`/`*_on` column of the table uses the table's convention (vault ISO text, gateway `*_ms`), is `NOT NULL` only if every writer sets it, and is written from the injected clock, not `now()` in Rust code.
4. **Indexes**: each foreign key's first child column leads an index (commitment 9); each new statement is in `query_plans.rs`' coverage.
5. **Founded tables and census**: a new table is in commitment 8's list of founded tables, and a `WITHOUT ROWID` table is covered by the update-hook shim (`install_without_rowid_census`).

## Error to fix

| Symptom | Cause and fix |
| --- | --- |
| `SQLITE_BUSY` / "database is locked" | A second connection or a deferred read-then-write. Open writes `BEGIN IMMEDIATE`; the vault has one writer, so look for a second opener. Retry the whole transaction, never the statement |
| `SQLITE_LOCKED` | Writing a table while a cursor on it is open. Collect rows first, then write. Not retryable |
| `FOREIGN KEY constraint failed` | Parent missing, or a delete rule bites. Check `PRAGMA foreign_key_check`; a seed written out of order |
| `CHECK constraint failed` | The writer emits a value the CHECK rejects (sweep 1) or breaks a row-shape invariant |
| `NOT NULL constraint failed` | A writer skips the column; fix the writer, not the column |
| `cannot store TEXT value in INTEGER column` | STRICT doing its job; fix the bound type |
| `UNIQUE constraint failed` on upsert | The conflict target does not name the unique index; use `ON CONFLICT (cols) DO UPDATE` |
| `SQLITE_FULL` / `DiskFull` | Already classified by `VaultError::from`; render, do not retry |
| `no such table` in a statement | A table outside `PAGE_TABLES` read through the page door, or a migration not run on this file |
| Schema digest / `DowngradeRefused` / "made by an earlier version" | `SCHEMA_DIGEST` not updated, or a file from another build. Do not touch the file; update the constant or use a founded vault |
| `sql-confinement` finding | SQL in a crate outside the roots; move it |
| `query_plans` red | Full scan or sort after a paged read; add the index to the baseline or fix the predicate (planning reference) |
| Snapshot / backup drill red | A `VACUUM`, a second writer, or a page-moving change; read the trap |
| `last_insert_rowid` surprises | `WITHOUT ROWID` tables have none; key by the declared primary key |

## References

- [references/schema-design.md](references/schema-design.md): affinity, STRICT, keys, generated columns, collation. Open when designing a table.
- [references/query-performance.md](references/query-performance.md): reading `EXPLAIN QUERY PLAN`, covering and partial indexes, keyset paging. Open when a plan is red.
- [references/concurrency-durability.md](references/concurrency-durability.md): one-writer model, `SQLITE_BUSY` vs `LOCKED`, transaction modes. Open on a lock error.
- [references/migration-patterns.md](references/migration-patterns.md): `ALTER TABLE` limits and the table-recreate procedure. Open when a rung changes a table's shape.
- [CENTRAID.md](CENTRAID.md): where this repo departs from those files.

## Done when

`cargo xtask gate --profile local` is green, and the tests that touch the change pass: `cargo test -p centraid-vault` (commitments, `ladder_ddl`, `restore_drill`, `backup_snapshot`), `cargo test -p centraid-gateway` for `state.db`, and `cargo test -p centraid-core --test query_plans` for any new statement. A schema change also has the regenerated `contracts/schema/vault-ddl.sql`, the new `SCHEMA_DIGEST`, and the sweeps' results.
