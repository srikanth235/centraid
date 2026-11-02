# Threads, runtimes and locks in this repository

Open this before adding a thread, a task, a lock or a `block_on`. Every row below was read in the source; the file names are where to look at the idiom in use. The pack rules on the same topics are [async-no-lock-await](rules/async-no-lock-await.md), [async-spawn-blocking](rules/async-spawn-blocking.md), [own-mutex-interior](rules/own-mutex-interior.md) and [anti-lock-across-await](rules/anti-lock-across-await.md).

## Who owns a runtime

| Crate | Shape | Where |
| --- | --- | --- |
| `centraid-core` (the phone) | **Synchronous API.** A call is a plain function on a `Handle`; the vault sits behind `Arc<Mutex<Option<Vault>>>`. Async exists only for the flows that dial a gateway, on **one** lazily built multi-thread runtime (two workers, thread name `centraid-phone`), reached with `Handle::runtime_handle()` and entered with `runtime.block_on(...)` from the sync call. | `crates/core/src/handle.rs` (`runtime_handle`), `crates/core/src/phone/` |
| `centraid-gateway` (`server`, `client` features) | `#[tokio::main]` binary. Accept loops and the sweep scheduler are `tokio::spawn`; every blocking SQLite or hashing pass inside them is `tokio::task::spawn_blocking`. | `crates/gateway/src/server/serve.rs`, `sweeps.rs`, `bin/centraid-gateway.rs` |
| `centraid-gateway` (`rules`) | No runtime, no socket, no file, no clock: `tests/pure_rules.rs` scans `src/rules` for every reach. | `crates/gateway/Cargo.toml` header |
| Every other library crate | Synchronous. `async fn` is declared only in `gateway` (the rest are string fixtures in `xtask`'s rule tests); the core's async is `runtime.spawn(async move { ... })` blocks. | `grep -rc 'async fn' crates/*/src` |

The runtime is multi-threaded on purpose: a current-thread runtime under `block_on` deadlocks the moment something it drives waits on another task, such as a streamed request body and its connection (`runtime_handle`'s doc comment).

## The decision

| Work | Use |
| --- | --- |
| Blocking SQLite, hashing, compression or file work reached from an async task | `tokio::task::spawn_blocking`, then `.await` the join handle and handle its `Err` (a panicked task) as a failure, as `sweeps.rs` does |
| Async work started from a sync core call | `runtime.block_on(...)` on the handle from `runtime_handle()`; or `runtime.spawn(...)` for fire-and-forget (`wake_after` in `crates/core/src/screens.rs`) |
| A guard that must live across an `.await` | `tokio::sync::Mutex` (one use: `Client::live`, the kept connection, in `crates/gateway/src/client/mod.rs`) |
| Any other shared state | `std::sync::Mutex`; never hold the guard across an `.await`, never return it to a caller |
| A background loop that blocks on a synchronous queue and has no async runtime on its path | A raw `std::thread` (below) |
| Parallel CPU work | None. `rayon` is out of the graph on purpose (`image` is built with `default-features = false`; "a command handler runs inside a SQLite transaction and must not fan out", `Cargo.toml`) |
| A scoped helper that borrows the stack | `std::thread::scope` (tests only today: `crates/core/tests/assist_plane.rs`) |

## The raw-thread sites

A raw thread is allowed only for the shapes below, and each existing site ends with its owner. A new one states which shape it is and how it ends.

| Site | Shape | How it ends |
| --- | --- | --- |
| `Handle::tidy_in_background` in `crates/core/src/handle.rs` | A named (`thread::Builder::name`) maintenance pass that runs in batches and sleeps between them | Holds only a `Weak<HandleState>`; upgrades per batch, so a dropped handle really drops and the thread leaves. Also ends on `Unpaired` or `Closed` |
| `off_thread` in `crates/core/src/screens.rs` | A synchronous job (`OffThreadWork`) that must not run on the calling screen thread; its result is pushed as a `JobDone` event | Runs once and returns |
| `Shelf::pump` in `crates/screens/src/vault/shelf.rs` | One forwarding loop per open core, blocked in `core.next_event(250 ms)` | Returns when `next_event` errs (the core is closed) or the `Weak` shelf is gone |
| The retry push after a full queue, same file | Retries `events.push` every 5 ms | Returns when the queue is closed |
| `crates/xtask/src/select.rs` | Writes a child's stdin on its own thread so a full output pipe cannot deadlock the pair | Joins |

Other `thread::spawn` calls are in tests (`events.rs`, `handle.rs` test modules).

## Locks

- **`std::sync::Mutex` is the default** (61 `Mutex<` sites; no `parking_lot`, no `RwLock` except `crates/screens/src/custody/keeper.rs`).
- **Never hold a guard across an `.await`.** Clone the `Arc` or copy the value out, drop the guard, then await ([async-clone-before-await](rules/async-clone-before-await.md)).
- **Read what you need from the vault, release it, then touch the network.** `Handle` does this for `PairPhone`: it reads the vault's history inside `with_vault_if_any`, lets the vault go, and only then calls `runtime_handle()`'s runtime.
- **Poison is decided per lock, in a comment beside the accessor**:
  - Recover with `.unwrap_or_else(PoisonError::into_inner)` when a panic elsewhere cannot break the lock's invariant or when refusing would be worse: the event queue's `lock()` in `crates/core/src/events.rs`, the locker's `lock_cell` (a poisoned cell still holds a session that must be lockable), `runtime_handle`.
  - Map to a typed refusal when the state can no longer be vouched for: `lock_sessions` in `crates/core/src/stage.rs` returns `CoreError::Unavailable` through `poisoned()`.
  - A panic that reaches the C ABI poisons the whole handle instead ([CONTRACT.md clause 9](../../../../crates/core-ffi/CONTRACT.md#9-a-rust-panic-never-crosses-the-boundary)).
- **`Vault` is `!Sync`.** One connection, one writer, the phone ([traps/wal-checkpoint.md](../../../../docs/traps/wal-checkpoint.md)). A snapshot is taken on the vault's own connection while the caller holds `&Vault`, so it cannot interleave with a commit. Do not add a second connection or a shared pool to get concurrency.
- **Atomics** for flags and counters only (`closed`, `draining`, diagnostic ids). Use the weakest ordering that is correct and say why in a comment ([conc-atomic-ordering](rules/conc-atomic-ordering.md)).
- **`Rc`/`RefCell`** are rare (35 sites); the vault's commit guard uses `RefCell` for state its rusqlite hooks share on one thread (`crates/vault/src/log/guard.rs`). Never for anything that crosses a thread.
