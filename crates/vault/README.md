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
| `migrations`, `format` | The ladder (one rung, `001_baseline.sql`, hand-written); the file's `application_id` and schema digest. |
| `log` | The commit guard — `BEGIN IMMEDIATE`, the body, `COMMIT`, with an `update_hook` reporting which tables a commit touched — and SQL identifier quoting. |
| `value`, `canonical`, `clock`, `time`, `error` | A SQLite value and its JSON; the one canonical JSON spelling; time and ids as injected facts; civil time and recurrence; `VaultError`, with `DiskFull` typed. |
| `access` | `Principal`, `Verb`, `evaluate_access` — a deny is a value. |
| `commands`, `action_key`, `model`, `index` | `CommandDefinition`, `Registry`, the gate order and the shared verbs (`entity`, `tag`, `flag`, `edge`, `container`, `blob`, `person`, `follow`), which serve a Locker item as they serve every kind, and Locker's own (`locker.*`: what involves a secret or Locker's structure); the key an executed `act` leaves so a retried one is not applied twice, and the write counter on the `vault` row; `Kind`, `Rel`, `Flag` and `fold_label`; the re-index at commit into the one `search` table. |
| `history` | **Every record's earlier values** (#1185): temp triggers record an entity's state before a commit changes it, `settle` keeps it as one `revision` row only when the state differs, and `earlier_versions` / `history.restore_version` / `history.undo` read and restore it. `TABLES`, `OMITTED`, `BLOB_SLOTS` and `CONTENT` are the one classification; `tests/history.rs` fails on a table, kind, blob column or `OMITTED` column it does not cover. See the module's docs for how a Locker item's sealed cells are kept (as ciphertext, masked on read). |
| `bootstrap` | `Vault::found`: the vault row and its owner. |
| `ontology_doc` | The published ontology page's schema section, rendered from a founded vault (`export-ontology-page`), and the sentence each table has on it; `tests/ontology_page.rs` holds the page to it. |
| `page`, `testdoor` | The paged door's vault-side hook (`page_raw`, the row-filter AND, the field mask); the questions a test asks of a copy. |
| `bytes`, `blob`, `originals` | The byte door (`BlobStore`, `Located`, and `FsBlobStore` over a plain directory); claiming bytes (`blob`, `derivative`), where they are, and garbage collection from `PRAGMA foreign_key_list`; the originals this device holds and the albums whose originals stay. |
| `custody` | The one sealed-value format (the Locker `lk1:` cell) and the phone's Locker doors (a sealed item cell, a sealed field's value, a custom one-time-code field's seed); no key material — see [`src/custody/README.md`](src/custody/README.md). A custom field of kind `sealed` or `otp` holds its value only in `value_sealed` (`otp` keeps its kind so a page shows a rolling code): the schema forbids `value_text` for both and requires a sealed value for `otp`. A file founded before those CHECKs has another schema digest and is refused whole at open, never read, indexed or backed up. |
| `stage` | Named stages of founding and of a migration rung, with a per-thread hook a fault test uses to stop or fail a real run there (a child killed at a stage, a full disk). Absent in production. |
| `backup` | **The backup library** (#1209, #1212): the vault as a tree of small deterministic sealed objects (`centraid-sealed/4`), a snapshot that reads only the ranges the WAL names, the device state and staging, the engine that moves them to gateways, retention, restore. See below. |

## The backup library (`backup`)

The contract is `contracts/backup/spec.md`.

| Module | What it owns |
| --- | --- |
| `naming` | The backup keys from the vault's root key, and the vault's claims on content (`content_hashes`, `claims_after`). |
| `files` | Every file the vault knows by hash, read from `blob` (which includes each derivative's own bytes), with what a pass decides by. |
| `content` | The vault's content bytes read as chunks of at most 4 MiB, sealed on demand and never kept. |
| `tree` | Manifest v6 (§3): the root, range leaves of up to 1,024 ranges, and the blobs radix tree (`LEAF_ENTRIES = 256`) by the bytes of the content hash with rolled-up `BlobsStats` (`O(1)` `stats_of`, `O(depth)` `lookup_entry`, `O(Δ log N)` `diff_entries`), every node one `records` chunk and a pure function of its content. |
| `directory` | The sealed gateway directory (E8): addresses, pins and labels, never a token. |
| `wal` | The page numbers of the WAL's frames: what changed since the last snapshot, because every connection to the vault file sets `wal_autocheckpoint = 0` and only the core checkpoints, after a snapshot or when folding oversized WALs (`fold_wal_if_needed`). |
| `snapshot` | One lock-free pinned read (`take_unlocked` / `take_with_vault_slot`) of the vault into a tree (§5): the dirty ranges (plus folded `dirty_range` rows) only, a full read every 4th snapshot and at least daily (it sets `db_hash`), the checkpoint after tree assembly ends, a damaged vault refused before any root exists, and `hydrate_blob_chunks_from_root` on `VAULT_KNOWN` re-pair. |
| `state` | `<stem>.state.db` (`CBS2`) beside the vault, derived and never inside it: each gateway's pairing, what it confirmed (`conf`, `troot`, `oroot`) and persistent `GatewayNotes`, the node cache, staged files, `local_bytes`, `blob_chunk`, and `dirty_range`. **No outbox.** |
| `staging` | `<stem>.staging/`: the sealed ranges between the pin and their confirmation, under a budget of the smaller of 512 MiB and a tenth of the free space; a name is whole or absent, and opening sweeps partials. |
| `store` | The `Store` trait one gateway answers (bundle, exists, head, set_head, a delete naming its head, list, snapshots, held, undo, check, fetch and ranged get), and `MemoryStore` over the gateway's own rules. |
| `engine` | A pass per gateway and the scheduler over them (§6.2, §6.3): head, records, the commit rule, set head, thumbnails, originals newest first, read-back; the member's rule per class; OS bundles; status and debt. |
| `retention` | 7 daily, 4 weekly and 6 monthly snapshots; collection by one head-bound signed delete, which a kept root that will not open stops. |
| `restore` | The tree opened from the gateways and rebuilt in the order of R3: records (every check, then the vault opens), thumbnails, originals; "Check my backup"; and `restore_check`, the structural check `centraid doctor` reports. |
| `drill` | `dump`, every row of every table, for proving a restored vault is the one that was lost. The drill itself is `tests/restore_drill.rs`. |

There is **no backup index in the vault** and no outbox on the device: a name is a keyed hash of its plaintext, so what a gateway is owed is the difference between two trees, and the gateway is asked only when the phone cannot know (a recovery pass, a media phase). The plane speaks to a gateway through `Store` and never to a socket; the phone's core wires it to `crates/gateway`'s client.

## Decisions specific to this file format

Each with its reason in the module, and each recorded as a decision.

- **`application_id = CEN2`, a schema digest and a `user_version` counting this ladder's own migrations** (D-1020-D1-2). `format.rs` holds `SCHEMA_DIGEST`, and open and restore refuse a file of the model before #1135 (`CEN1`) or with other tables, with a sentence.
- **The commit pair is the only writable connection** (D-1020-D1-5). `Vault::read` sets `PRAGMA query_only`, so a write through a read is refused by SQLite rather than by a reviewer.
- **The pragmas are stated, not inherited**: `journal_mode = WAL`, `synchronous = FULL`, `secure_delete = ON` (a purge also merges the search indexes so the words leave their pages), `journal_size_limit`, `fullfsync` and `checkpoint_fullfsync` on Apple targets, a 4 KiB page and no auto-vacuum; checkpoints are SQLite's own since #1080, so a last close folds the WAL into the file.
- **`VaultError::DiskFull` is a typed answer** (D-1020-D1-8), classified on SQLite's primary code and on `ErrorKind::StorageFull`, so a handler's own `?` carries it.
- **One history, kept at the commit door** (#1185): a commit that changes an entity's title, kind row or child rows keeps the state it had BEFORE as one `revision` row (canonical JSON; a note's words and a document's bytes in their own cells so a blob is a real foreign key). A creation, an unchanged commit and trash/restore write none; a purge takes it with the record. A version stores no diff: `earlier_versions` derives what changed by comparing consecutive states. Each edit costs the size of the entity's captured state (about 600 bytes for a person with two contact points), once per commit and not per field.
- **The vault keeps one full-text index**, `search`, contentless and keyed by `entity.n`, written by the commit guard from the entities a command touched (`index.rs`); `crates/search` only reads it.
- **The baseline migration and its `contracts/` fixture are ONE file** (D-1020-D1-13): `contracts/migrations/001_baseline.sql`, with `contracts/schema/vault-ddl.sql` rendered from it by `export-ladder-ddl` and held equal by `tests/ladder_ddl.rs`. The model was rebuilt whole in [#1135](https://github.com/srikanth235/centraid/issues/1135).

## The interface its consumers use

| Consumer | What it uses |
| --- | --- |
| `crates/core` | `Vault` and its commands and doors; `backup::{snapshot, engine, state, staging, store, restore, retention, files, naming}` for the phone's passes. |
| `crates/core` (`api.rs`) | `Vault::page_raw`, `page::and_row_filters`, `page::apply_field_mask`, `commands::Registry`, until the read registry in `crates/domain` **(target)** replaces them. |
| `crates/blobs` | `bytes::BlobStore`, which `ContentBytes` implements, and the device state's `local_bytes`. |
| `crates/centraid` | `backup::restore::restore_check` for `doctor`, and `backup::drill::dump` for the restore drill. |

`crates/api-proto` is deliberately **not** a dependency: everything here is plain Rust and the conversion to wire messages happens at the edge.

## The tests that hold it

`tests/restore_drill.rs` backs up with the real engine, loses everything and restores in the order of R3; `tests/backup_tree.rs` holds the counts content addressing promises; `tests/backup_snapshot.rs` the dirty ranges, the full read, the checkpoint and a snapshot taken while another thread commits; `tests/backup_state.rs` the device state's constraints (raw SQL) and the staging area's crash; `tests/backup_engine.rs` the engine against `MemoryStore`; `tests/backup_sim.rs` the seeded simulation with its faults, its invariants and its planted bugs (`CENTRAID_SIM_SEEDS` for more seeds); `crates/centraid/tests/restore_drill.rs` runs the product's drill against the real gateway; `src/migrations.rs`'s tests prove the climb itself (order, contiguity, a rung that fails mid-way rolling back whole) and that a squash rebuilds the vault it was cut from; `tests/history.rs` edits a record of each kind twice, reads the versions and their diffs, restores, undoes and purges, and proves a creation and an unchanged commit write no history, and that a changed password is kept only as ciphertext, masked on read and restored with the item, and `tests/locker_plaintext_gate.rs` plants a one-time-code field's seed, opens every sealed part of a snapshot and finds no Locker plaintext, and holds every entity-wide reader (the entity and edge pages, the search index, `text_of`, the action keys, revisions, whose states hold plain fields and sealed ciphertext, never a plaintext) to carrying no cell and no Locker row; `tests/founding_kill.rs` (a child killed at each stage of founding, no timing), `tests/disk_full.rs` (the log insert, founding and a migration at open on a full disk) and `tests/clock_bound.rs` are the failure matrix's vault half. A migration at open makes no copy of the vault: it runs on the opened connection and the file is the only one.

`#![forbid(unsafe_code)]`; there is no `unsafe` in this crate and no reason for there ever to be.
