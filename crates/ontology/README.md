# `centraid-ontology`

The schema authority: **open a vault file, know its shape, verify it** ([#1020](https://github.com/srikanth235/centraid/issues/1020)). `tests/golden_vault.rs` is its checkpoint: the crate opens the frozen golden corpora.

## Role

Everything above this crate needs the same three answers before it can do anything: is this file a vault I understand, what is in it, and is it sound. `crates/vault` owns the commit log, retention and the forward-only migration ladder; `crates/seat` the replica and applier; `crates/apps/*` the queries. All of them open a file first, and this is where that happens once.

| Module | What it holds |
| --- | --- |
| `vault` | `Vault::open` — foreign keys on, journal mode read, `user_version` compared. `ONTOLOGY_VERSION`, the accepted `user_version` window, the `sqlite_master` walk. |
| `snapshot` | The corpus digest format and `compare_snapshot`. |
| `jsvalue` | The digest's value encoding, which is a **JavaScript** fact — `typeof` and `String(value)` over what `node:sqlite` returned when the corpus was frozen, including `Number.prototype.toString`. |
| `golden` | Inflating a frozen corpus into a scratch directory. `GOLDEN_LABEL` is the baseline (`issue-1020`, the ladder head); `GOLDEN_LABEL_CHECKPOINT` is `issue-929`, the window's low end. The committed file is never opened in place ([`docs/traps/wal-checkpoint.md`](../../docs/traps/wal-checkpoint.md)). |
| `doctor` | `PRAGMA integrity_check` and `PRAGMA foreign_key_check`. |
| `registries` | The model's registries, embedded from `contracts/schema/v0-registries.json`. |
| `ddl` + `bin/export-ddl` | Rendering and regenerating `contracts/golden/issue-1020/vault-ddl.sql`, the corpus's own description. |
| `bin/export-golden-manifest` | Regenerating a corpus's `manifest.json` from the corpus itself. |

## What it does not do

- **No migrations.** `Vault::open` accepts a `PRAGMA user_version` inside a window and advances nothing: above the window it refuses with `DowngradeRefused` (the core never guesses at a shape a newer build wrote), below it with `UpgradeRequired`. The ladder is `crates/vault`'s.
- **The window is a contract, not a constant** (#1020, D-1020-A1). Both ends are embedded from `contracts/schema/v0-registries.json`: `userVersion` is what the #929 checkpoint corpus was frozen at, `ladderUserVersion` the ladder head the baseline corpus was frozen at (D-1020-D1-1). `both_ends_of_the_window_open` opens both files, and stamping is used only for the two outsides.
- **No DDL emission.** This crate reads a schema and renders it; founding a vault is `crates/vault`'s.
- **No blob custody.** The doctor here does not check content-addressed pointers that no foreign key covers. A clean report here is a claim about pages and keys and nothing more.
- **No writes, no commands, no receipts.** Commitments whose mechanism is the command pipeline are held by `crates/vault`; `tests/commitments.rs` holds only the ones a file-level check can.

## Frozen goldens

The registries and the corpora were produced by the TypeScript tree removed in [#1020](https://github.com/srikanth235/centraid/issues/1020), and are now fixed expectations. Two consequences worth stating plainly:

1. The registries are **embedded**, never re-typed. See [`contracts/README.md`](../../contracts/README.md).
2. The digests are **byte-compatible with the frozen manifest**, which is the only reason reproducing them proves anything. A different-but-reasonable encoding would turn every row into a finding, so `jsvalue` reproduces JavaScript's spelling of a value rather than choosing Rust's.

## Running it

```sh
cargo test -p centraid-ontology                 # the checkpoint, the commitments, the fixtures
cargo run -p centraid-ontology --bin export-ddl -- \
  contracts/golden/issue-1020/vault.db.gz > contracts/golden/issue-1020/vault-ddl.sql
```

`#![forbid(unsafe_code)]`; there is no `unsafe` in this crate and there is no reason for there ever to be.
