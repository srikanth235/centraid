# `centraid-core`

The message loop: one handle, four entry points, three roles ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 2, lane D2).

Everything a shell can ask for goes through `call` and everything the core volunteers comes back through `next_event`. There is no third surface, and that is the point: a shell that could reach the vault directly would be a second gateway.

## The four entry points

| Function | Contract |
| --- | --- |
| `Core::open(config)` | opens the file, runs migrations, **returns**. The endpoint starts afterwards, on a core thread. |
| `handle.call(request)` | synchronous from the caller's view. **Never from a UI thread** — a debug assertion fires when the shell named one. |
| `handle.next_event(timeout)` | blocks on a **bounded** queue (`EVENT_QUEUE_CAP = 1024`). `Ok(None)` is a timeout, not an error. |
| `handle.close()` | unblocks every waiter with `CoreError::Closed`, then releases. Idempotent. Calls afterwards are typed errors. |

Plus `handle.cancel(request_id)`: cancels an in-flight **unbounded** operation. A bounded read is refused rather than cancelled, and the refusal is typed — bounded reads hold a SQLite read transaction, and cancelling one leaves it to be rolled back by a dropped future.

## The event queue

Bounded, and **nothing is dropped**. When it fills, sync stalls and a `HealthEvent { stalled: true }` says so. A dropped change event would be a screen that stays wrong until something else happens to touch the same row, which may be never — slow is a state a member can be told about; wrong is not.

Change events **coalesce** per `(table, pk)` set while they wait, and the coalesced event carries the **highest** commit seq it covers, because an overlay clears against a commit seq. Coalescing is lossless: a change event never carried values, only the keys a screen re-reads.

A stall that happens with the queue full of change events is **reported late**, on the first slot a drain frees, rather than by dropping a change event to make room. Without that the shell would learn a stall ended without ever learning it began.

## The three roles

| Role | What it is |
| --- | --- |
| `Gateway` | the authority: the vault, the doors, the endpoint accepting seats |
| `Seat { Replicated }` | a full mirror: `crates/seat`'s applier over a local file, its own outbox |
| `Seat { Thin }` | no local rows. Every call is forwarded to the gateway **under the caller's principal**, and `Unavailable` when it cannot be reached. A thin seat is a pipe, not a deputy. |

All three expose the same `Request` surface, which is what makes "gateway anywhere" a deployment choice rather than a fork.

## The `VaultApi` v1 twin

`api.rs` holds eight verbs and the honest state of each. A stub is a **typed refusal**, never an empty answer: an empty page reads as "no data" and the truth is "this build cannot answer yet".

`page` `invoke` `describe` `parked` are live. `search` and `resolve` land in wave 4; `content` in wave 3. `reveal` is **online-only, always** — a mass reveal must never be queued, replayed or answered from a durable store.

## One mutex over the vault, in wave 2 (D-1020-D2-9)

`Vault` keeps its commit-guard depth in a `Cell` and is therefore `!Sync`. Real concurrent reads need a pool of read connections, which needs `PRAGMA` statements, which is SQL — and `sql-confinement` confines SQL to five crates this is not one of. So wave 2 serialises every call through one mutex, and the reader pool is an owner hand-off to `crates/vault`. See `handle.rs`'s module docs for the three options and what option 3 costs.

## The `call` budget

`cargo test -p centraid-core --test call_budget` measures p95 over 200 calls of one page of 100 rows and fails above `contracts/ledgers/call-budget.json`'s ceiling. `cargo xtask gate --profile pr`'s `call-budget` step runs it.

`cargo test -p centraid-core`.
