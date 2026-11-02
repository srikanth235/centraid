# Where Centraid departs from the packs

The pack files in `references/` are general SQLite advice. [R5 on #1160](https://github.com/srikanth235/centraid/issues/1160): repo docs win, and this file names each conflict and the winner. [SKILL.md](SKILL.md) states the winner.

| Pack says | This repo does | Owner |
| --- | --- | --- |
| `synchronous = NORMAL` with WAL is the standard choice | `synchronous = FULL`, stated on every connection, vault and gateway | [docs/traps/wal-checkpoint.md](../../../docs/traps/wal-checkpoint.md) |
| Back up with `VACUUM INTO`, or Litestream-style WAL shipping | The online backup API (`sqlite3_backup`) into a scratch file under the write lock; `VACUUM` never runs and `auto_vacuum` stays `NONE`, so a snapshot is page-identical | [docs/traps/wal-checkpoint.md](../../../docs/traps/wal-checkpoint.md), [R-1080-B6](../../../docs/decisions.md) |
| Tune `wal_autocheckpoint`; run `wal_checkpoint` from a background task | SQLite's default autocheckpoint; a last close folds the WAL in | [R-1080-C33](../../../docs/decisions.md) |
| Track migrations in a `schema_migrations` table with checksums | `PRAGMA user_version` counts a forward-only ladder; `application_id` and a BLAKE3 `SCHEMA_DIGEST` of `sqlite_schema` identify and verify the file; a pre-migration snapshot is taken first | [D-1020-D1-2](../../../docs/decisions.md), [R-1146-1B-9](../../../docs/decisions.md) |
| Never edit an applied migration | The same, but before the first release that must migrate, the one baseline `001_baseline.sql` is edited in place | [R-1029-5](../../../docs/decisions.md) |
| Down-migrations, rollback scripts | None. Forward-only; a file above the binary is refused; recovery is the pre-migration snapshot | [D-1020-D1-2](../../../docs/decisions.md) |
| `INTEGER PRIMARY KEY` unless a distributed id is needed | Vault ids are TEXT UUIDv7 from an injected clock; `entity.n` is the integer handle | [D-1020-X3-2](../../../docs/decisions.md) |
| Timestamps: ISO-8601 TEXT or epoch seconds, pick one | Vault: ISO text with milliseconds and `Z`, from the injected clock. Gateway: epoch milliseconds. One per database | [SKILL.md](SKILL.md) |
| Use `INSERT OR REPLACE` for upserts | Banned on vault writers; `ON CONFLICT DO UPDATE` | [R-1047-R1](../../../docs/decisions.md) |
| `OFFSET` is acceptable for small tables | Keyset only; no "the table is small" bound | [R8](../../../docs/decisions.md), [centraid-engineering](../centraid-engineering/SKILL.md) |
| Plan with `EXPLAIN QUERY PLAN` and ship | Also held by `query_plans.rs` over the year-3 corpus and a down-only ledger; the performance gate is measured work, not plan text | [docs/vault-ontology.md](../../../docs/vault-ontology.md#indexes) |
| Connection pools; many reader connections | One connection per vault is the single writer; reads toggle `query_only` on it | [D-1020-D1-5](../../../docs/decisions.md) |
| Statements as string literals in app code | SQL is confined to four crates; the gateway keeps its statements in `.sql` files | `sql-confinement` in `crates/xtask/src/rules.rs`, [R-1080-A2](../../../docs/decisions.md) |
| Default SQLite build | Bundled build with session, hooks, functions and backup | root `Cargo.toml` |

Not used from the pack: D1, Turso, host-specific, async-driver, Python and JavaScript material (see [SOURCES.md](SOURCES.md)).
