# `centraid-ontology`

The v1 schema authority: **open a vault file, know its shape, verify it.** First crate of the v1 tree ([#1020](https://github.com/srikanth235/centraid/issues/1020)), and wave 1's checkpoint is one sentence — _the ontology crate opens the v0 golden vault_ — which `tests/golden_vault.rs` is.

## Role in the v1 tree

Everything above this crate needs the same three answers before it can do anything: is this file a vault I understand, what is in it, and is it sound. `crates/vault` will own the commit log, retention and the forward-only migration ladder; `crates/seat` the replica and applier; `crates/apps/*` the queries. All of them open a file first, and this is where that happens once.

| Module | What it holds |
| --- | --- |
| `vault` | `Vault::open` — foreign keys on, journal mode read, `user_version` compared. `ONTOLOGY_VERSION`, `EXPECTED_USER_VERSION`, the `sqlite_master` walk. |
| `snapshot` | A faithful port of v0's `golden-snapshot.ts`: the corpus digest format and `compare_snapshot`. |
| `jsvalue` | The digest's value encoding, which is a **JavaScript** fact — `typeof` and `String(value)` over what `node:sqlite` returns, including `Number.prototype.toString`. |
| `golden` | Inflating the frozen corpus into a scratch directory. The committed file is never opened in place (`docs/traps/wal-checkpoint.md`). |
| `doctor` | `PRAGMA integrity_check` and `PRAGMA foreign_key_check`. |
| `registries` | The v0 registries, embedded from `contracts/schema/v0-registries.json`. |
| `ddl` + `bin/export-ddl` | Rendering and regenerating `contracts/schema/vault-ddl.sql`. |

## What it does not do yet

- **No migrations.** There is no ladder. A file behind `EXPECTED_USER_VERSION` is refused with `UpgradeRequired`, not advanced; a file ahead of it with `DowngradeRefused`. That refusal is the compatibility policy the issue's _Compatibility between v1 releases_ section states, arriving before the mechanism it guards.
- **`EXPECTED_USER_VERSION` is the corpus's number, not v0's.** v0's ladder has added rungs since the #929 freeze, so a vault founded by v0's current code stands ahead of this constant and `Vault::open` refuses it. That is correct for a crate that ports no rungs and wrong as a long-term answer; closing it is `crates/vault`'s job.
- **No DDL emission.** This crate reads a schema and renders it; it cannot create one. A vault is still founded by v0.
- **No blob custody.** v0's `vaultDoctor` asks a third question — the content-addressed pointers no foreign key covers — and this one does not, because v1 has no CAS. A clean report here is a claim about pages and keys and nothing more.
- **No writes, no commands, no receipts.** Every commitment whose mechanism is the command pipeline stays with v0's oracle; `tests/commitments.rs` says in its header which rows those are.

## The oracle

`packages/vault/src/schema` is the **source of the model** until wave 6 deletes the v0 tree, and `packages/vault/src/golden-vault.test.ts` is the oracle this crate is measured against. Two consequences worth stating plainly:

1. The registries here are **transcribed**, never re-typed. See [`contracts/README.md`](../../contracts/README.md).
2. The digests are **byte-compatible with the frozen manifest**, which is the only reason reproducing them proves anything. A different-but-reasonable encoding would turn every row into a finding, so `jsvalue` reproduces JavaScript's spelling of a value rather than choosing Rust's.

## Running it

```sh
cargo test -p centraid-ontology                 # the checkpoint, the commitments, the fixtures
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p centraid-ontology --bin export-ddl -- \
  contracts/golden/issue-929/vault.db.gz > contracts/schema/vault-ddl.sql
```

`#![forbid(unsafe_code)]`; there is no `unsafe` in this crate and there is no reason for there ever to be.
