# A byte store that is never closed locks its index until the process exits

**The symptom.** `centraid_open` never returns. No error, no log line, no panic: the calling thread parks and stays parked. It bites on a **reopen in the same process** — `open → close → open` on one vault path, as `mobile/core`'s `AbiRoundTripSpec` does from one JVM — and a first open in a fresh process is fine. `sample` on the stuck process shows the new core inside `Handle::open_own_bytes`'s `block_on(ByteStore::open(..))`, and one `iroh-blob-store-N` thread per earlier core parked in `iroh_blobs::store::fs::Actor::run` → `drop(RtWrapper)` → `BlockingPool::shutdown`.

**The cause.** Two iroh-blobs 0.103 behaviours meet on `<vault>.bytes/blobs.db`, the store's redb index:

- redb holds an advisory lock on `blobs.db` for as long as a store has it open, and a second opener — in this process or another — gets `DatabaseAlreadyOpen`.
- `FsStore::load_with_opts` builds a private runtime and spawns its actor on it. When the actor ends — by a normal drop of the last store handle, or by an error in `Actor::new` — it drops that runtime **from a task running on it**. The blocking pool's shutdown waits for every pool thread, the one doing the dropping included, so it never finishes.

So a core dropped without closing its store leaves the unlock to a teardown that cannot complete: `blobs.db` stays locked for the life of the process. The next open's actor fails with `DatabaseAlreadyOpen`, its error path is the same self-drop, and the future `ByteStore::open` awaits never completes. The error that would have explained everything is swallowed.

**The fix.** Two halves, both required:

- **Close, don't drop.** `ByteStore::close` (iroh-blobs' `shutdown`) drops the redb database before it acknowledges, and it is the only path that unlocks `blobs.db`. `ContentBytes::close` drives it from a synchronous caller, and `Handle`'s `Drop` (`crates/core/src/handle.rs`) calls it on the byte store the core owns. Anything else that owns a `ByteStore` and means to open the same directory again in-process must close it the same way.
- **Refuse a held index by name.** `ByteStore::open` (`crates/blobs/src/store.rs`) probes `blobs.db` with the lock redb takes (`File::try_lock`) before handing it to iroh-blobs. `WouldBlock` there is exactly the `DatabaseAlreadyOpen` iroh-blobs would have swallowed, and it becomes a `StoreError::Open` that names the file.

`crates/core-ffi/tests/reopen.rs` is the JVM spec's sequence at the C boundary, with the second open on its own thread and a deadline, because a regression here is a hang and not a failure.

**The residue upstream, still present on iroh-blobs 0.103.**

- **One parked thread per closed store.** `close` unlocks the index, but the actor's runtime still self-drops afterwards, so every store a process has ever opened leaves an `iroh-blob-store-N` thread parked for the life of the process. Harmless at one open per app launch; a loop that opens and closes stores leaks a thread per turn.
- **Every other failed open still hangs.** The lock probe converts only the held-index case. Any other error in `Actor::new` — a corrupt or unreadable `blobs.db`, a redb version mismatch, a platform where the probe cannot lock — takes the same self-dropping error path, and `ByteStore::open` never returns. When an open hangs and the index is not held, suspect the index file, and read the stacks before the Kotlin.
