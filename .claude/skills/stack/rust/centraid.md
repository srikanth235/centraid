# Rust in Centraid

## Workflow and done criteria

Run the matching workspace gate and fix code rather than weakening checks:

- `cargo xtask gate --profile local` for focused development: fmt, clippy with warnings denied, touched-crate tests and dependents, rules, and doc links.
- `cargo xtask gate --profile pr` before opening a PR; it covers the full workspace.

The gate is canonical. Do not make standalone `cargo clippy --all-features` or blanket commands mandatory by default; workspace feature combinations and selected profiles are authoritative. Run a targeted command when it answers a question the selected gate does not.

**Done** when the applicable gate is green. Before a PR, the `pr` profile must be green. For performance changes, reproduce and measure, profile, fix, then measure again using the same optimized build and inputs; include before/after numbers. Routine changes do not need this loop.

## Centraid constraints

- Crates are internal application code unless they expose a library API. Keep application code direct; use typed errors with `thiserror` in libraries and `anyhow` at binary/tooling edges.
- Product code has no `unwrap()`. `expect` names the invariant. `unsafe` appears only in `core-ffi` and `assist-llama`; most other crates carry `#![forbid(unsafe_code)]`, and one without it must not add `unsafe`. Read [`../../../crates/core-ffi/CONTRACT.md`](../../../../crates/core-ffi/CONTRACT.md) before FFI edits.
- The phone's Rust core is the vault's only writer. Write through `Vault::commit`; never run blocking SQLite work on an async task. SQL stays in vault, ontology, search, and apps-kit crates.
- Keep work whose cost grows with the vault off request paths; paginate with keyset cursors and `LIMIT`.
- Do not add dependencies for convenience. `cargo deny` checks licenses and advisories. Comments state obligations; cite history with an issue link.
- A machine running `centraid-gateway` is a gateway.

### Compiler and clippy errors

Fix the first error first: later ones are often its echo. Clippy runs `cargo clippy --workspace --all-targets -- -D warnings` in the gate, so every warning is an error; fix the code, never add `#[allow]` to go green.

| Error | Fix |
| --- | --- |
| `E0382` use of moved value | Borrow it (`&x`), move the last use later, or restructure so one owner consumes it; clone only if two owners are really needed |
| `E0502` / `E0499` cannot borrow as mutable more than once | Shorten the first borrow (end it before the second), split the struct into disjoint fields, or collect indices first and mutate after |
| `E0505` move out while borrowed | End the borrow first, or move the data into the closure or thread that needs it |
| `E0106` missing lifetime specifier | Return an owned value, or name one lifetime tying the output to the input it borrows from |
| `E0597` / `E0515` does not live long enough, returns reference to local | Return the owned value, or take the buffer from the caller |
| "future is not `Send`" | A non-`Send` value (`Rc`, `RefCell` guard, `MutexGuard`) is held across an `.await`; drop it in a block before the await, or use `Arc` and an async-aware lock |
| `E0277` trait bound not satisfied | Read the "required by" note; add the bound to the generic, derive the trait, or convert the type |
| `E0308` mismatched types | Convert at the boundary (`.into()`, `?` with a `From` impl, `as_deref()`), not with a cast |
| `E0599` no method found | Import the trait that provides it, or the type lacks a derive or a feature flag |
| `clippy::unnecessary_unwrap`, `clippy::manual_unwrap_or` | Use `if let`, `?` or `unwrap_or`; product code has no `unwrap()` by house rule (clippy does not enforce it, review does) |
| `clippy::needless_borrow`, `redundant_clone`, `clone_on_copy` | Delete the `&` or `.clone()` it points at |
| `clippy::too_many_arguments`, `type_complexity` | Group arguments in a struct; name the type with an alias |
| `unused_must_use` / unused `Result` | Handle it with `?`; `let _ =` only for a deliberate best-effort call, with a comment |
| "usage of an `unsafe` block" under `#![forbid(unsafe_code)]` | Only the FFI crates may use `unsafe`; do not lift the forbid, move the code or use a safe API |

### Pitfalls

- **Never sort, key, hash or compare a `serde_json::Value` by its printed text.** `to_string` prints keys in insertion order when `preserve_order` is on and name order when off, and Cargo unifies that feature across the whole build, and any dependency can turn it on. A parity suite that sorted rows by printed JSON passed under `cargo test -p centraid-apps-people` and failed under `cargo test --workspace`. Use `crates/apps/kit`'s `canonical_json` (sorted keys, one number spelling), compare values with `==`, assert the order-independence property as well as the answer, and re-run JSON-ordering claims under `cargo test --workspace`. Do not toggle `preserve_order` to fix it, either way.
- **A test that writes an executable and runs it is slow on macOS.** The first exec of a just-written file waits on the system's code assessment, one file at a time: about 500 ms for one script, over 7 s for sixteen at once, which is exactly what nextest does under the `pr` gate. A fixed few-seconds window for a fake tool is a guess about the whole machine (the fake-`dns-sd` tests in `crates/gateway/src/server/bonjour.rs` failed this way while passing alone). Wait on a condition, not a sleep, with a generous ceiling (60 s) for a fake's first run; wait for a noted line to be whole (ends in a newline), not for the file to exist (`echo > f` creates it before writing); have production code answer the moment a watched child exits; and prefer a binary the system ships (`/bin/sh`) over a fresh one.

## General Rust guidance

Read [`general/general-practices.md`](general/general-practices.md) for ownership, API design, errors and panics, concurrency, unsafe, modules, tests, and idioms. Source digests: [`rust-api-guidelines.md`](general/rust-api-guidelines.md), [`effective-rust.md`](general/effective-rust.md), [`rust-design-patterns.md`](general/rust-design-patterns.md), [`microsoft-rust-guidelines.md`](general/microsoft-rust-guidelines.md), and [`google-rust-style-guide.md`](general/google-rust-style-guide.md).

The diagnostic table, measuring guidance, and done criteria adapt [Bama](https://github.com/daveebbelaar/bama) by Dave Ebbelaar (MIT, [`licenses/Bama-LICENSE`](licenses/Bama-LICENSE)). Adapted from [BeautifulRust](https://github.com/morganlinton/BeautifulRust) by Morgan Linton (MIT, [`licenses/BeautifulRust-LICENSE`](licenses/BeautifulRust-LICENSE)).
