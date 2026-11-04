---
name: sqlite
description: >-
  Design and review SQLite schemas, queries, migrations, indexes, transactions, triggers, FTS5, and Rust rusqlite access. Use for SQL and DDL work, database errors, locking, durability, or query performance. Follow Centraid's repository constraints first; use the references for general SQLite craft.
---

# SQLite in Centraid

## Repository constraints

Apply these before general SQLite advice:

- **Vault ownership:** `vault.db` lives on the phone, and the Rust core is its only writer. Writes go through `Vault::commit` in [`crates/vault/src/lib.rs`](../../../crates/vault/src/lib.rs); reads go through `Vault::read`. SQL belongs in the vault, ontology, search, or apps-kit crates. The gateway's `state.db` is separate bookkeeping.
- **Current vault schema policy:** [`contracts/migrations/001_baseline.sql`](../../../contracts/migrations/001_baseline.sql) is the only rung and is edited directly until the first release; from the first release on it is frozen and a schema change appends a new rung, because compatibility between releases is a requirement. [`contracts/schema/vault-ddl.sql`](../../../contracts/schema/vault-ddl.sql) is generated. Follow [`vault-change`](../vault-change/SKILL.md) for model changes.
- **Fixed file behavior:** the opener sets WAL, `synchronous = FULL`, a busy timeout, foreign keys on, and `auto_vacuum = NONE`. `VACUUM` does not run because backups preserve page ranges. Live vault copies use SQLite's online backup API on the vault connection.
- **Write discipline:** use short `BEGIN IMMEDIATE` transactions and `INSERT ... ON CONFLICT ... DO UPDATE`; never `OR REPLACE`. Keep list reads bounded and paginate by key rather than `OFFSET`.
- **Identity and types:** vault ids are UUIDv7 text and timestamps are ISO-8601 text; gateway timestamps are integer milliseconds.

## Checks for the change

Start with the repository checks that match the change:

- Schema or model change: run `cargo test -p centraid-vault`; regenerate the artifacts with the commands in [`vault-change`](../vault-change/SKILL.md).
- Gateway schema or SQL change: run `cargo test -p centraid-gateway`.
- Read path or index change: inspect the query plan and run the relevant app/core query-plan check; use the `pr` gate when the schema, index, or query behavior changes.
- For any change, run the matching `cargo xtask gate --profile <local|pr|nightly|release|mobile-jvm>` and `bun run check` as applicable. The `mobile-jvm` profile runs in Linux CI with Cargo, Bun, and JDK 21; no Android SDK is required.

Profile queries only when the change targets performance or measurements show a regression. Seed data at realistic volume, inspect `EXPLAIN QUERY PLAN`, and compare before and after. See [`diagnostics.md`](references/diagnostics.md) for the performance loop, repo tools, and error table; see [`query-performance.md`](references/query-performance.md) for deeper plan interpretation and index design.

## General SQLite references

These references cover engine-level techniques; apply the repository constraints above where they differ:

- [`schema-design.md`](references/schema-design.md): types, constraints, keys, and normalization.
- [`query-performance.md`](references/query-performance.md): indexes, plans, pagination, and measurement.
- [`concurrency-durability.md`](references/concurrency-durability.md): WAL, locking, busy handling, and durability.
- [`migration-patterns.md`](references/migration-patterns.md): generic deployed-database versioning and table rebuilds.

For a deployed database that must preserve existing files, the general rule is to leave an applied migration immutable, add a forward migration, and test it against representative old data. Centraid's vault follows it from the first release on; before then the single baseline is edited in place, as the vault skill describes.

The error table and guidance are adapted from [Bama](https://github.com/daveebbelaar/bama) by Dave Ebbelaar (MIT, [license](licenses/Bama-LICENSE)). The SQLite references are from [claude-mods](https://github.com/0xDarkMatter/claude-mods) by 0xDarkMatter (MIT, [license](licenses/claude-mods-LICENSE)).
