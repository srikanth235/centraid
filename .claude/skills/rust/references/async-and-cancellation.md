# Async patterns, cancellation and shutdown

Open this when writing `async` code in `crates/gateway`, or any code that runs on the core's runtime. Where the runtimes are and which thread or task primitive to pick is [threads-and-locks.md](threads-and-locks.md); this file is the patterns inside async code. Pack rules: [async-cancel-safety](rules/async-cancel-safety.md), [async-select-racing](rules/async-select-racing.md), [async-joinset-structured](rules/async-joinset-structured.md), [async-bounded-channel](rules/async-bounded-channel.md), [async-cancellation-token](rules/async-cancellation-token.md), [async-fn-in-trait](rules/async-fn-in-trait.md). General background: the [Tokio tutorial](https://tokio.rs/tokio/tutorial) (shared state, channels, select, graceful shutdown) and the [Asynchronous Programming in Rust book](https://rust-lang.github.io/async-book/), both MIT.

## Patterns in use

| Need | Pattern, and where to see it |
| --- | --- |
| Bound a wait on the network | `tokio::time::timeout(DURATION, fut).await`, with the timeout a named `const` (`HANDSHAKE_TIMEOUT` in `crates/gateway/src/server/serve.rs`; dial timeouts in `crates/gateway/src/client/mod.rs`) |
| Hand accepted connections from an accept loop to the serving loop | A **bounded** `mpsc::channel(64)`; never `unbounded_channel` (`serve.rs`) |
| Stop a server | Pass a `shutdown: impl Future<Output = ()> + Send + 'static` and use the framework's `with_graceful_shutdown`; the test harness drives it with a `oneshot` (`serve.rs`, `harness.rs`) |
| A periodic job | One `tokio::spawn`ed loop with `tokio::time::sleep(TICK)`; each pass runs blocking work through `spawn_blocking` and records the outcome (`sweeps.rs`) |
| A one-shot answer | `oneshot` |
| One writer, many cheap clones of a handle | `Arc` the shared state; clone the `Arc` into the task before the `.await` |

## Always

- **Name every timeout and bound as a constant** with a comment saying what it protects. A network call with no timeout is a hung member.
- **Check cancel safety before putting a future in `select!`.** The branch that loses is dropped mid-await; state it half-wrote is lost. Prefer a design where each branch is a `recv()` or a sleep.
- **Treat a `JoinError` as a failure to report**, not a panic to propagate (a panicked blocking task is `Err` from `spawn_blocking(...).await`).
- **Drop a lock, then await.** Copy the value out first ([anti-lock-across-await](rules/anti-lock-across-await.md)).
- **Keep a spawned task's owner** (a `JoinHandle`, a `JoinSet`, or a shutdown signal) so the task ends with its owner; a detached task that holds an `Arc` keeps the state alive forever.
- **Give a trait that is awaited a native `async fn`** (stable; no `async_trait`, which is not in the graph). A trait object that must be `dyn` returns a boxed future explicitly.

## Never

- `block_on` inside an async context, `std::thread::sleep`, blocking `std::fs` or a SQLite call on a runtime worker. Move it to `spawn_blocking`.
- An unbounded channel, an unbounded `Vec` of in-flight work, or an accept loop with no cap on handshakes.
- `tokio::spawn` for work that must finish before the caller returns; await it.
- Panicking in a task to report an expected failure.

## Cancellation in the core

Cancellation across the C ABI is not tokio cancellation. A `Cancel` request names an in-flight **unbounded** operation by request id; the core records the id and the running operation polls for it at its checkpoints and stops itself. A bounded read is never cancelled, because it holds a SQLite read transaction that a dropped future would break. Write an unbounded loop so that it checks `cancelled` between units of work and leaves nothing half-applied. The contract is [CONTRACT.md clause 4](../../../../crates/core-ffi/CONTRACT.md#4-every-request-carries-a-request-id-and-cancel-names-one); the state is `cancelled: Mutex<Vec<u64>>` in `crates/core/src/handle.rs`.
