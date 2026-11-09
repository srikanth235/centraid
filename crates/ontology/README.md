# `centraid-ontology`

The schema authority's narrow end: **open a vault file, render its shape, check it is sound** ([#1020](https://github.com/srikanth235/centraid/issues/1020), [#1135](https://github.com/srikanth235/centraid/issues/1135)). The model itself — kinds, relations, seeds — is `crates/vault`'s baseline (`contracts/migrations/001_baseline.sql`); this crate keeps no copy of it, no registry and no corpus.

| Module | What it holds |
| --- | --- |
| `vault` | `Vault::open` — foreign keys on, journal mode read — and the `sqlite_master` walk (`schema_objects_of`). |
| `ddl` + `bin/export-ddl` | The renderer behind `contracts/schema/vault-ddl.sql` (written by `centraid-vault`'s `export-ladder-ddl`, diffed by `crates/vault/tests/ladder_ddl.rs`), and a command that prints any vault copy's schema. |
| `doctor` | `PRAGMA integrity_check` and `PRAGMA foreign_key_check`. |
| `graph` | The catalogue of how entities are joined (the nine edge relations and the foreign-key columns that say the same fact) and the one reading of both as a graph: `links_at`, `links_outside_locker`. People's "In your vault", Notes' About and the assistant world read through it (the app kit's `graph` is the same reader over a page door). |
| `jsvalue` | A SQLite value's JSON spelling, which is JavaScript's own (`Number.prototype.toString`): the row image `crates/vault` hands its callers. |
| `scratch` | A directory name for a vault a test will throw away, and the repository root. |

## What it does not do

- **No migrations and no version window.** The ladder, `application_id` and the downgrade refusal are `crates/vault`'s.
- **No blob custody.** The doctor does not check content-addressed pointers; since every hash column is a foreign key into `blob(hash)`, `foreign_key_check` is that check for the vault's side, and the byte store's side is `crates/vault::bytes`.
- **No second copy of the graph.** Nothing stores it: a link read here is a row some command wrote for its own sake. A link that starts or ends at a Locker item is flagged (`Link::touches_locker`) and every reader outside Locker drops it.
- **No writes, no commands.** Commitments whose mechanism is the command gate are held by `crates/vault/tests/commitments.rs`.

```sh
cargo test -p centraid-ontology
cargo run -p centraid-ontology --bin export-ddl -- <a copy of vault.db>
```

`#![forbid(unsafe_code)]`; there is no `unsafe` in this crate and there is no reason for there ever to be.
