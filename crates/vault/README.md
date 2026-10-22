# `crates/vault` — the authority's file

Everything durable a Centraid phone knows about a vault is in one SQLite file, and everything that writes to it goes through `Vault::commit` ([#1020](https://github.com/srikanth235/centraid/issues/1020)). The phone is the vault's only writer ([#1029](https://github.com/srikanth235/centraid/issues/1029)); this crate is the file, its doors and its commands, and the backup plane that copies it to the member's gateways ([#1080](https://github.com/srikanth235/centraid/issues/1080)). It sits on `crates/ontology`'s reading of the model.

```sh
cargo test -p centraid-vault
cargo run -p centraid-vault --bin export-ladder-ddl > contracts/schema/vault-ddl.sql
cargo run -p centraid-vault --bin export-commands > contracts/schema/vault-commands.txt
cargo run -p centraid-vault --bin export-ontology-page   # the published page's schema section
```

## The map

| Module | What it owns |
| --- | --- |
| `file` | `Vault::create` / `open`, the one writable connection, `read` under `query_only`, the pragma set, `finish`. |
| `migrations` | The ladder (one rung, `001_baseline.sql`, hand-written), `application_id`. |
| `log` | The commit guard — `BEGIN IMMEDIATE`, the body, `COMMIT`, with an `update_hook` reporting which tables a commit touched — and SQL identifier quoting. |
| `value`, `canonical`, `clock`, `time`, `error` | A SQLite value and its JSON; the one canonical JSON spelling; time and ids as injected facts; civil time and recurrence; `VaultError`, with `DiskFull` typed. |
| `access` | `Principal`, `Verb`, `evaluate_access` — a deny is a value. |
| `commands`, `journal`, `model`, `index` | `CommandDefinition`, `Registry`, the gate order and the shared verbs (`entity`, `tag`, `flag`, `edge`, `container`, `blob`, `person`, `follow`) and Locker's; the journal row every command leaves; `Kind`, `Rel`, `Flag` and `fold_label`; the re-index at commit into the one `search` table. See [docs/vault-ontology.md](../../docs/vault-ontology.md). |
| `bootstrap` | `Vault::found`: the vault row and its owner. |
| `ontology_doc` | The published ontology page's schema section, rendered from a founded vault (`export-ontology-page`), and the sentence each table has on it; `tests/ontology_page.rs` holds the page to it. |
| `page`, `testdoor` | The paged door's vault-side hook (`page_raw`, the row-filter AND, the field mask); the questions a test asks of a copy. |
| `bytes`, `blob`, `originals` | The byte door (`BlobStore`, `Located`, and `FsBlobStore` over a plain directory); claiming bytes (`blob`, `derivative`), where they are, and garbage collection from `PRAGMA foreign_key_list`; the originals this device holds and the albums whose originals stay. |
| `custody` | The one sealed-value format (the Locker `lk1:` cell) and the phone's two Locker doors; no key material — see [`src/custody/README.md`](src/custody/README.md). |
| `snapshot` | The pre-migration safety copy `Vault::open` takes before it climbs the ladder. |
| `backup` | **The backup plane** (#1080): the vault as page-identical snapshots cut into 64 KiB ranges, every content file sealed under names its hash implies, a device-local ledger and spool, and the restore. See below. |

## The backup plane (`backup`)

| Module | What it owns |
| --- | --- |
| `naming` | The backup keys from the vault's root key, and the names the vault's content implies. |
| `files` | Every file the vault knows by hash, read from `blob` (which includes each derivative's own bytes), with what a pass decides by. |
| `snapshot` | The page-identical copy (`sqlite3_backup`, on the vault's own connection, off the request path once copied), its ranges and manifest, and the census counted on the copy; plan, spool, settle. |
| `store` | The `Store` trait one destination answers, and `MemoryStore`. |
| `ledger` | `<stem>.backup.db` beside the vault, never inside it: destinations, the queue, confirmations, snapshots, `local_bytes`. |
| `spool` | `<stem>.spool/`: sealed parts waiting to move, under a byte budget. |
| `mover` | The `PUT`s, the confirmations they earn, and the reconcile against `exists`. |
| `retention` | Which snapshots to keep, and which names are garbage. |
| `restore` | The file rebuilt from a destination and every check that it is the snapshot's (`db_hash`, `integrity_check`, the census); and `restore_check`, the structural check `centraid doctor` reports. |
| `drill` | Back up, lose the vault, its ledger and its spool, restore, and prove it is the vault that was lost, row for row (`dump`). |

There is **no backup index in the vault**: the tables the #1029 plane founded for one were dropped before the first release, because a part's name is a keyed hash of its plaintext and the gateway is asked what it holds ([R-1080-4](../../docs/decisions.md#backups-from-first-principles-1080)). The plane speaks to a destination through `Store` and never to a socket; the phone's core wires it to `crates/gateway`'s client.

## Decisions specific to this file format

Each with its reason in the module, and each recorded as a decision.

- **`application_id = CEN1` and a `user_version` counting this ladder's own migrations** (D-1020-D1-2).
- **The commit pair is the only writable connection** (D-1020-D1-5). `Vault::read` sets `PRAGMA query_only`, so a write through a read is refused by SQLite rather than by a reviewer.
- **The pragmas are stated, not inherited**: `journal_mode = WAL`, `synchronous = FULL`, `journal_size_limit`, no `secure_delete`, a 4 KiB page and no auto-vacuum; checkpoints are SQLite's own since #1080 ([R-1080-C33](../../docs/decisions.md#the-phone-core-and-the-cut-over-1080-lane-c)), so a last close folds the WAL into the file.
- **`VaultError::DiskFull` is a typed answer** (D-1020-D1-8), classified on SQLite's primary code and on `ErrorKind::StorageFull`, so a handler's own `?` carries it.
- **The vault keeps one full-text index**, `search`, contentless and keyed by `entity.n`, written by the commit guard from the entities a command touched (`index.rs`); `crates/search` only reads it.
- **The baseline migration and its `contracts/` fixture are ONE file** (D-1020-D1-13): `contracts/migrations/001_baseline.sql`, with `contracts/schema/vault-ddl.sql` rendered from it by `export-ladder-ddl` and held equal by `tests/ladder_ddl.rs`. The model was rebuilt whole in [#1135](https://github.com/srikanth235/centraid/issues/1135).

## The interface its consumers use

| Consumer | What it uses |
| --- | --- |
| `crates/core` | `Vault` and its commands and doors; `backup::{snapshot, ledger, spool, mover, restore, files, naming}` for the phone's passes. |
| `crates/apps/kit` | `Vault::page_raw`, `page::and_row_filters`, `page::apply_field_mask`, `commands::Registry`. The kit builds the statement and the binds; the vault never sees a `PageQuery` and the kit never sees a `Connection`. |
| `crates/blobs` | `bytes::BlobStore`, which `ContentBytes` implements, and the ledger's `local_bytes`. |
| `crates/centraid` | `backup::restore::restore_check` for `doctor`, and `backup::drill::dump` for the restore drill. |

`crates/api-proto` is deliberately **not** a dependency: everything here is plain Rust and the conversion to wire messages happens at the edge.

## The tests that hold it

`tests/restore_drill.rs` runs the plane's drill against the in-memory store; `crates/centraid/tests/restore_drill.rs` runs the product's against the real gateway. `tests/backup_snapshot.rs` covers a snapshot taken while another thread commits and every refusal a restore owes; `src/migrations.rs`'s tests prove the climb itself (order, contiguity, a rung that fails mid-way rolling back whole) and that a squash rebuilds the vault it was cut from; `tests/locker_plaintext_gate.rs` opens every sealed part of a snapshot and finds no Locker plaintext; `tests/snapshot_faults.rs` and `tests/disk_full.rs` are the failure matrix's vault half.

`#![forbid(unsafe_code)]`; there is no `unsafe` in this crate and no reason for there ever to be.
