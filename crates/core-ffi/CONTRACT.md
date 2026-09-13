# The C ABI contract

Five symbols. Ten clauses. **Each clause has a test** in `tests/contract.rs`, named after the clause, and the test calls through the C symbols — both directly as `extern "C"` functions and, for one, through `libloading` on the built `cdylib`, so the exported names are what a shell links.

This file is normative. A shell author reads it once and then relies on it; nothing here may be relaxed without a shell change, which is why every clause has a reason rather than only a rule.

From [#1020](https://github.com/srikanth235/centraid/issues/1020)'s Execution model, wave 2 lane D2, ruling D-1020-D2-3.

```c
int32_t centraid_open      (const uint8_t *config, size_t len, Handle **out);
int32_t centraid_call      (Handle *h, const uint8_t *req, size_t len,
                            uint8_t **out_buf, size_t *out_len);
int32_t centraid_next_event(Handle *h, uint32_t timeout_ms,
                            uint8_t **out_buf, size_t *out_len);
void    centraid_free      (uint8_t *buf, size_t len);
int32_t centraid_close     (Handle *h);
```

---

## 1. Buffers are callee-allocated and released only through `free`

Every out-buffer this library writes was allocated by this library's allocator. The caller must release it with `centraid_free` and the exact `len` it was given, and **must not** use `free(3)`, `delete`, a Swift `Data(bytesNoCopy:)` deallocator, or a JVM cleaner that calls anything else.

_Why:_ Rust's allocator is not the C one, and on Windows it is not even in the same DLL. Freeing a Rust allocation with `free(3)` corrupts the heap silently.

`len` is a parameter rather than tracked because the allocator needs the layout to deallocate. A length header inside the buffer would offset the bytes the shell reads from the pointer it was handed — a mistake every shell makes once.

**A null `buf` is a no-op**, so a caller need not branch on the timeout case.

Test: `buffers_are_callee_allocated_and_released_only_through_free`

## 2. Inputs are borrowed for the call

`config` and `req` are read during the call and never retained. The caller may free or reuse them the instant the call returns — a Kotlin `ByteArray` may leave its pinned scope, a Swift `withUnsafeBytes` closure may end.

_Why:_ the alternative is a lifetime a shell cannot see. A retained input would make every `call` a hidden allocation the shell has to outlive.

A null pointer with length **zero** is the empty slice; a null pointer with a non-zero length is `BAD_ARGUMENT`.

Test: `inputs_are_borrowed_for_the_call_and_never_retained`

## 3. `call` is reentrant, and two concurrent calls never block on the FFI

`centraid_call` may be entered from any number of threads on one handle. This layer takes **no lock of its own**.

_Why, precisely:_ the honest version of this clause is that the FFI is never the bottleneck. The core's own serialisation is another matter — in wave 2 `crates/core` holds one mutex over the vault (D-1020-D2-9, with the three options and the reason in `crates/core/src/handle.rs`), so two concurrent reads of the vault do serialise _there_. When that becomes a reader pool inside `crates/vault`, no shell changes, because this clause never promised the vault was concurrent — only that this boundary adds nothing.

Test: `call_is_reentrant_across_threads_and_the_ffi_adds_no_lock`

## 4. Every request carries a request id, and `Cancel` names one

The `Envelope`'s `request_id` is the caller's. A non-zero id is used as-is; the core answers under it and does not mint its own. Id **0** is reserved for the handshake and means "mint one for me".

A `Cancel` body cancels the **unbounded** operation its `request_id` names. A `Cancel` naming a bounded read returns `BAD_ARGUMENT` with an `ERROR_CODE_INVALID_REQUEST` body: bounded reads hold a SQLite read transaction, and a cancellation that leaves it to a dropped future breaks the log door's four-statements-in-one-read-transaction rule. A `Cancel` naming an id nobody is waiting for is a **no-op**, because ids are monotonic and never reused. A `Cancel` with id 0 names nothing and is refused rather than read as "cancel everything".

Test: `every_request_carries_a_request_id_and_cancel_names_one`

## 5. `next_event` surfaces bounded-queue backpressure as a health event

The event queue is bounded at 1024 and **drops nothing**. When it fills, sync stalls and a `HealthEvent { stalled: true, queue_depth, capacity, behind }` reaches the shell — later, on the first slot a drain frees, if the queue is full of change events, because a change event may not be dropped to make room for the report.

_Why:_ a dropped change event is a screen that stays wrong until something else happens to touch the same row, which may be never. Slow is a state a member can be told about; wrong is not.

`behind` is a distance in **log positions**, not rows and not seconds.

Test: `next_event_surfaces_bounded_queue_backpressure_as_a_health_event`

## 6. A timeout allocates nothing

`centraid_next_event` returns `TIMEOUT` (-5) with the out-pointers **untouched**. There is nothing to free, and a caller that called `centraid_free` on them would free whatever was in them before the call.

_Why it is a clause and not a note:_ the natural shell wrapper is `defer { centraid_free(buf, len) }` written once, and it is wrong here unless the status is checked first. Clause 1's null no-op is the other half of the answer: a shell that zeroes its locals before the call is then safe either way.

Test: `a_timeout_allocates_nothing`

## 7. `close` unblocks `next_event` with a terminal answer

`centraid_close` releases every thread parked in `centraid_next_event`, which returns `CLOSED` (-3) once the events already accepted have been handed out. A close is **not** a discard: accepted events come out first.

After `close` the handle pointer is **dangling**. A shell must null its own copy; no ABI can make a use-after-free safe. `close` on a null pointer is `BAD_ARGUMENT`, and `close` twice on the same pointer is undefined — that is a statement about C and not a gap in this library.

Test: `close_unblocks_next_event_with_a_terminal_answer`

## 8. Calls after close return a typed error

Every entry point on a closed handle returns `CLOSED` (-3) — never a hang, never a panic, never a partial answer. (Reached through a handle the shell has not yet dropped; see clause 7 on the pointer itself.)

Test: `calls_after_close_return_a_typed_error`

## 9. A Rust panic never crosses the boundary

Every entry point is wrapped in `catch_unwind`. A caught panic becomes an error response carrying `ERROR_CODE_INTERNAL` and a **diagnostic id**, returns `PANICKED` (-4), and **poisons the handle**: every later call returns `PANICKED` with the same diagnostic id, so the shell restarts the core deliberately rather than carrying on over state nobody can vouch for.

_Why:_ unwinding into C is undefined behaviour. And the poison is not belt-and-braces — a panic means an invariant this library believed did not hold, and the next call would be running on state that violates it.

The **first** panic is the one filed. A later one is a symptom of running on poisoned state, and overwriting would lose the cause.

A panic in `centraid_open` returns `PANICKED` and hands back **no handle**: there is nothing to poison, and a handle the caller never received cannot be restarted.

**The fault door.** A shell that cannot make this library panic cannot test its own handling of it. The `debug-fault` cargo feature makes a `Command` named `debug.panic` panic inside `Handle::call`; it rides an existing request rather than a sixth symbol, because clause 10 says five symbols and means it, and a shell that needed a sixth to test the fifth would have a sixth in production. It is absent from every release profile, exports nothing, and a default build answers `debug.panic` as an unregistered command ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 3, lane E finding 4).

Its first run found that `centraid_next_event` did **not** check the poison: the queue was empty, so it answered `TIMEOUT` (-5), which is a normal answer — a shell whose core had panicked would have polled a dead core once a second forever. Fixed in `crates/core`'s `next_event`; a poisoned handle refuses at every entry point, which is what the paragraph above claims.

Tests: `a_rust_panic_never_crosses_the_boundary`, `a_real_panic_inside_call_poisons_the_handle_through_the_abi` (needs `--features debug-fault`), `the_fault_door_is_absent_from_a_default_build`

## 10. Exactly five symbols are exported

`nm -D --defined-only libcentraid_core_ffi.so | grep ' T centraid_'` is 5. The xtask rule `abi-five-symbols` counts the `#[unsafe(no_mangle)] pub extern "C"` declarations in this crate's source on every gate run, and `tests/symbols.rs` counts the **exported** symbols in the built `cdylib` — two different questions, because a symbol can be declared and not exported, or exported by a dependency.

_Why five:_ every symbol is a thing three shells must wrap, three build systems must see, and compatibility must hold for. A per-verb ABI would be forty symbols that change whenever a verb does; one `call` over encoded bytes moves that churn into the protobuf schema, where `buf breaking` already governs it.

Test: `exactly_five_symbols_are_exported`, `the_exported_names_are_what_a_shell_links`

---

## What this contract does not promise

- **That the vault is concurrent.** See clause 3.
- **That a handle survives a fork.** SQLite handles do not.
- **That `close` is safe to race with a `call` on the same handle.** The shell owns the pointer's lifetime; this library owns what is behind it. A shell that closes while another thread is inside `call` has a use-after-free, and the remedy is the shell's own ordering.
- **Unknown protobuf fields survive a round trip.** prost 0.14 does not retain them (`crates/api-proto`'s D-1020-C13). Nothing across this boundary relays a decoded message, which is what makes that unreachable rather than merely unlikely.

## Miri

`cargo miri test -p centraid-core-ffi --test marshal_miri` runs over `src/marshal.rs`'s unsafe surface: the slice reconstruction, the out-pointer writes, the `Vec` → raw → `Vec` round trip `centraid_free` inverts, and the null-pointer refusals. It cannot run the whole crate, because SQLite is a C library and miri does not execute foreign code — so the unsafe surface is _confined_ to that module for exactly this reason.
