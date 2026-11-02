# Unsafe and the FFI boundary

Open this before touching `crates/core-ffi`, `crates/assist-llama/src/engine.rs`, or any `unsafe`. The ABI contract is [crates/core-ffi/CONTRACT.md](../../../../crates/core-ffi/CONTRACT.md) and is normative: read the clause before changing the behaviour it describes. Pack rules: [unsafe-safety-comment](rules/unsafe-safety-comment.md), [unsafe-minimize-scope](rules/unsafe-minimize-scope.md), [unsafe-miri-ci](rules/unsafe-miri-ci.md), [unsafe-extern-block](rules/unsafe-extern-block.md), [unsafe-no-mangle-unsafe](rules/unsafe-no-mangle-unsafe.md), [unsafe-maybeuninit](rules/unsafe-maybeuninit.md), [unsafe-send-sync-manual](rules/unsafe-send-sync-manual.md); background in [The Rustonomicon](https://doc.rust-lang.org/nomicon/) (MIT/Apache-2.0).

## The layout

| Fact | Where |
| --- | --- |
| Five exported `#[unsafe(no_mangle)] pub extern "C"` symbols: `centraid_open`, `centraid_call`, `centraid_next_event`, `centraid_free`, `centraid_close`. `abi-five-symbols` counts them on every gate run; `tests/symbols.rs` counts the exported ones in the built `cdylib` | `crates/core-ffi/src/lib.rs`, CONTRACT.md clause 10 |
| `#![deny(unsafe_op_in_unsafe_fn)]`: each unsafe operation sits in its own `unsafe { }` with a `// SAFETY:` comment; each `unsafe fn` has `# Safety` | `crates/core-ffi/src/lib.rs` |
| Slice reconstruction, out-pointer writes and the `Vec` to raw to `Vec` round trip are confined to `marshal.rs`, so Miri can run over them: `cargo miri test -p centraid-core-ffi --test marshal_miri` | `src/marshal.rs`, CONTRACT.md "Miri" |
| Every entry point is wrapped in `catch_unwind`; a caught panic poisons the handle and returns `PANICKED` with a diagnostic id | CONTRACT.md clause 9 |
| Buffers are allocated by this library and freed only by `centraid_free(buf, len)`; inputs are borrowed for the call | clauses 1 and 2 |
| The open configuration is JSON; the vault seed crosses the ABI and this library writes no key down | clauses 4a, 4b |
| The `debug-fault` feature adds a panicking `act` for the contract test; it exports no symbol and is absent from every release profile | `Cargo.toml` of `core-ffi`, `fault-door` step |
| The only other unsafe: one `unsafe extern "C"` declaration of `atexit` with its `// SAFETY:` | `crates/assist-llama/src/engine.rs` |

## Always

- **Prefer a request kind to a symbol.** New capability crosses the ABI as a protobuf request through `centraid_call`, never as a sixth function ([protobuf-prost.md](protobuf-prost.md)).
- Write the `// SAFETY:` comment as a statement of what the caller promised and what you checked (null, length, lifetime, aliasing), not "this is safe".
- Keep the unsafe region to the one operation; do the safe work around it.
- Prove a clause with a test named after it in `tests/contract.rs`, called through the C symbols.
- Run the `contract` test and the Miri command after any change to `core-ffi`, and rebuild the shells' copy of the core ([stale-core-slice trap](../../../../docs/traps/stale-core-slice.md)).
- Keep `panic = "unwind"`: abort would take the host app down.

## Never

- A new `unsafe` outside those two crates, or a new `#![allow(unsafe_code)]`; new crates start with `#![forbid(unsafe_code)]`.
- Freeing a library buffer with `free(3)`, `delete` or a platform deallocator.
- `unsafe impl Send` or `Sync` to silence the compiler; fix the type.
- Holding a Rust reference across the boundary or returning a pointer into borrowed memory.
- `mem::uninitialized`, `mem::zeroed` on a type with a validity invariant, or `transmute` to extend a lifetime or cast an enum.
