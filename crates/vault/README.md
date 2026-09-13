# `crates/vault` — the authority's file

Everything durable a Centraid gateway knows is in one SQLite file, and everything that writes to it goes through `Vault::commit`. Second crate of the v1 tree ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 2, lane D1), sitting on `crates/ontology`'s reading of the v0 model.

```sh
cargo test -p centraid-vault                    # 119 tests
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p centraid-vault --bin export-baseline -- \
  contracts/golden/issue-1020/vault.db.gz > contracts/migrations/001_baseline.sql
```

## The map

| Module | What it owns |
| --- | --- |
| `file` | `Vault::create` / `open`, the one writable connection, `read` under `query_only`. |
| `migrations` | The forward-only ladder, the baseline, `application_id`, the derived entity-kind registry. |
| `value` | A SQLite value, a row image, and the log's own JSON — `{i}`, `{b64}`, JavaScript's numbers. |
| `clock` | Time and ids as injected facts, so a retention EDGE is testable. |
| `log` | Session capture, the decode, the commit guard, the doors, the applier. |
| `snapshot` | One content-addressed artifact for backup, bootstrap and pre-migration safety, with its fault points. |
| `access` | `Principal`, `Verb`, `evaluate_access` — a deny is a value. |
| `commands` | `CommandDefinition`, `Registry`, the gate order, the three real `core.*` commands and the 23 `tally.*` skeletons. |
| `audit` | The invocation journal, the check rows, the receipt hash chain. |
| `intents` | The canonical payload hash and the 30-day replay ledger. |
| `devices` | Enrol, revoke, `is_enrolled` — unknown and revoked are one refusal. |
| `page` | The paged door's vault-side hook: `page_raw`, the row-filter AND, the field mask. |
| `bootstrap` | `Vault::found`: the vault row and its owner. |

## What is v0-faithful

Reproduced because a fixture, a seat or the file's own format depends on the exact behaviour. Each module's docs name the v0 path.

- The `replica_meta` / `replica_log` DDL and every constant, read from `contracts/schema/v0-registries.json` rather than re-typed.
- **One session per table.** `rusqlite` does expose `table_filter`, and v1 still does not use it: `node:sqlite` accepted the same filter and silently ignored it, shipping excluded rows, and the failure mode is a private table reaching every seat. A table that was never attached produces no changes at all, which a test sees.
- The changeset decode, including the three distinctions that cost v0 incidents: **`absent` is not NULL**, a **PK-changing UPDATE is DELETE + INSERT**, and a DELETE image is **positional** against a column cache keyed on `PRAGMA schema_version`.
- The delta prior: `prior_json` holds only the touched columns, `{}` is a real answer, `null` forces a re-bootstrap.
- The log door's paging rules — never mid-commit, `local` filtered not gapped, a separate `has_more` probe, one read transaction over all four statements.
- Retention's commit edge and the 14-day live-cursor hold; the epoch bump deriving its floor from the log.
- The snapshot pipeline's seven steps **in that order**, including `secure_delete` before any drop and the JSON redaction between the trigger drops and the VACUUM.
- The command gate order, the audit band, and the canonical payload hash — sorted by **UTF-16 code unit**, because the seat that computed it may be a JS engine.

## What is v1-only

Each with its reason in the module, and each recorded as a decision on #1020.

- **`application_id = CEN1` and a `user_version` counting v1's own migrations** (D-1020-D1-2). The v0 rung number is irrelevant to a v1 file.
- **The commit pair is the only writable connection** (D-1020-D1-5). `Vault::read` sets `PRAGMA query_only`, so a write through a read is refused by SQLite rather than by a reviewer — the `bracketed-replica-writes` invariant as a type.
- **Doors are functions, not routes** (D-1020-D1-6). The local socket, the iroh handler and a test call the same function, so they cannot disagree about the paging rules.
- **One snapshot, three uses** (D-1020-D1-7), content-addressed on `blake3(epoch:seq)`.
- **`VaultError::DiskFull` is a typed answer** (D-1020-D1-8), classified on SQLite's primary code in `From<rusqlite::Error>` so a handler's own `?` carries it.
- **The baseline migration and its `contracts/` fixture are ONE file** (D-1020-D1-13).
- **The entity-kind registry is derived from the DDL** (D-1020-D1-15), not transcribed.

## The interface D2, D3 and R consume

| Consumer | What it uses |
| --- | --- |
| `crates/seat` (D2) | `log::apply_log_page` — the same applier the CONVERGENCE gate runs — plus `LogRow`, `Cursor`, `read_log_page`, `record_seat_cursor`. |
| `crates/apps/kit` (D3) | `Vault::page_raw`, `page::and_row_filters`, `page::apply_field_mask`, `commands::Registry`, and the `tally.*` stubs to fill. The kit builds the statement and the binds; the vault never sees a `PageQuery` and the kit never sees a `Connection`. |
| recovery (R) | `snapshot::build_snapshot`, `SnapshotHead`, `Vault::found`, `Vault::enrol_device`, `Vault::revoke_device`. |

`crates/api-proto` is deliberately **not** a dependency: lane C defines the proto messages concurrently, so everything here is plain Rust and D2 wires the conversion at the edge. `crates/vault::devices` carries the method set lane C's `AllowlistStore` trait needs — `enrol`, `revoke`, `is_enrolled`, `live_devices` — and the trait is implemented over it in one block when `crates/net` lands.

## The gates

`contracts/applier/` holds ORACLE, CONVERGENCE and ATOMICITY as data, and `tests/gates.rs` runs all three. `tests/snapshot_faults.rs` and `tests/disk_full.rs` are the failure matrix's vault half: an interrupted build, a full disk at the log insert, a full disk at the snapshot copy, a duplicate delivery. Process death and restore-with-seats are D2's and R's.

`#![forbid(unsafe_code)]`; there is no `unsafe` in this crate and no reason for there ever to be.
