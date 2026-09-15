# `centraid-seat`

The seat replica: the applier, the state tables, the outbox, the intent grammar. The other half of the plane whose authority half is [`crates/vault`](../vault) ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 2, lane D2).

A seat holds a **copy** of the vault — every replicated table, none of the private ones — plus three tables the gateway never ships: `seat_state`, `seat_outbox` and `seat_outbox_settled`.

## Modules

| Module | What it holds |
| --- | --- |
| `applier` | the four rules plus idempotent-by-seq, the two hooks, one transaction per commit |
| `state` | `seat_state`'s DDL, the singleton, the watermark arithmetic |
| `outbox` | `seat_outbox` / `seat_outbox_settled`, the queue and the bounded journal |
| `intent` | **three** vocabularies — ten seat states, seven gateway statuses, five outcome statuses |
| `payload` | the canonical hash, re-exported from the vault, plus the astral-plane tests |
| `chain` | minted rows, synthetic ids, holds, the backoff, the six-step cutover |
| `settlement` | an answer is the gateway's fact, an overlay is this seat's |
| `occ` | `row_version`, and what `actual_version == 0` means |
| `identity` | `(gateway_id, vault_id)` and the file names it derives |
| `error` | the typed refusals, each one a different remedy |

## The five rules of the applier

1. `INSERT … ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE` — REPLACE fires the delete triggers only under `recursive_triggers`, and a seat's only triggers are FTS sync.
2. One transaction per commit, with the cursor in it.
3. The epoch gate, checked **per row** — the page header is what the gateway _believes_.
4. Table order, not dependency order, with foreign keys off.
5. **Idempotent by seq**: a row at or below `applied_seq` is dropped _before it is bound_. "Harmless upsert" is false for a delete followed by a re-insert.

Rule 5 is where this applier is **stronger** than the gateway-side one. `contracts/applier/atomicity.json`'s third case states that re-feeding an older commit walks a value backwards, and its own `$why` explains that what makes redelivery safe is the door refusing to serve rows below a cursor. Rule 5 makes that structural instead of procedural — `tests/convergence.rs` asserts both answers and names which is which.

## The hooks, and why they are two

`on_commit_in_transaction` runs **inside** the transaction carrying the commit's rows, which is what lets an overlay be cleared atomically with the rows that replace it — the whole reason the outbox shares a _database_ with the mirrored rows. `on_commit_durable` runs **after** `COMMIT`, because work told before COMMIT has been told a fact that is not yet durable.

## SQL confinement

SQL string literals are allowed here: this is one of the five crates the xtask `sql-confinement` rule names. The seat's own three tables are its own, and nothing outside this crate may reach them.

## Tests

| File | What it proves |
| --- | --- |
| `tests/convergence.rs` | the CONVERGENCE and ATOMICITY fixtures, through **this** applier |
| `tests/properties.rs` | the payload hash's invariances, the UTF-16 total order, the backoff |
| `tests/failure_matrix.rs` | process death, duplicate delivery, disk full, restore with paired seats, interrupted bootstrap |

`cargo test -p centraid-seat`.
