---
name: rust
description: Rust and protobuf/prost rules for Centraid's crates (the vault, the core, the gateway, the C ABI, the apps, xtask). Covers errors, async versus blocking, locks, unsafe, logging, tests, performance and the .proto schema. Use when writing, reviewing or debugging .rs or .proto files in this repo, or on a clippy finding, a borrow-checker or "future is not Send" error, an unwrap in review, an unsafe block, a new thread or task, a buf lint failure, or the `sql-confinement`, `abi-five-symbols` and `no-listening-socket` rules.
---

# Rust

The code is right when `cargo xtask gate --profile local` is green and the change does what the issue says. Edition 2024, toolchain `1.94.1` (`rust-toolchain.toml`), `rust-version` `1.91`: do not use a std API stabilised after 1.94. Rules the repository already states are linked, never copied; where this file and a doc differ, the doc wins ([CENTRAID.md](CENTRAID.md) lists the places a pack differs).

| Need | Owner |
| --- | --- |
| House style, comments, performance, atomicity | [docs/coding-standards.md](../../../docs/coding-standards.md) |
| The strategy and what each gate step proves | [TESTING.md](../../../TESTING.md), [crates/xtask/README.md](../../../crates/xtask/README.md) |
| The C ABI | [crates/core-ffi/CONTRACT.md](../../../crates/core-ffi/CONTRACT.md) |
| Footguns (open the matching one first) | [docs/traps/](../../../docs/traps/README.md): `wal-checkpoint`, `shared-cargo-target`, `stale-core-slice`, `serde-json-preserve-order` |
| Where a failing run's logs are | [docs/logs.md](../../../docs/logs.md) |
| Vocabulary: the phone is the vault; `centraid-gateway` is a _gateway_ | [AGENTS.md](../../../AGENTS.md) |

SQL, schema and migrations are the `sqlite` skill; the rusqlite call sites are Rust but the statements are not written here.

## Errors and panics

Ruling R4 ([#1160](https://github.com/srikanth235/centraid/issues/1160)): `thiserror` for typed errors in library crates; `anyhow` only at binary and tooling edges.

| Work | Use |
| --- | --- |
| A library function that can fail | `-> Result<T>` with the crate's alias over its own `thiserror` enum (`CoreError`, `VaultError`, `StoreError`, `OntologyError`, `ProtocolError`) |
| Wrapping a lower error | `#[from]` for a plain wrap, `#[source]` plus a field when the call site adds context. Never `map_err(\|_\| ...)` that drops the cause |
| A failure a caller handles differently | Its own variant, with the remedy in the doc comment (`DiskFull`, `RebootstrapRequired`, `Unpaired`) |
| A refusal that crosses the C ABI | A `CoreError` variant that maps to exactly one `ErrorCode` in `CoreError::code()` |
| A deny from the authority plane | A value (`Decision`), not an error |
| `main`, a CLI verb, xtask | `anyhow::Result` with `.context(...)`. These are the only places `anyhow` is a dependency: `gateway` (the `server` feature, `bin/centraid-gateway.rs`), `xtask`. (`media` also depends on it; that is not a pattern, see [CENTRAID.md](CENTRAID.md).) |
| A bug or violated invariant | `.expect("<the invariant>")`, `assert!`, `unreachable!` |

- Library `src` outside `#[cfg(test)]` has **no `.unwrap()` today** and about 40 `.expect(...)`, each message stating why it cannot fail (`"n - k is non-negative here"`). Keep it at zero: a new `.unwrap()` in product code is a review blocker. `?` for anything input, disk, network or a lock can cause.
- Tests, `tests/`, and `fn main` of a throwaway binary may `.unwrap()`.
- Error text is lowercase, no trailing period, and names the thing (`"there is no vault at this path yet; create one, or restore one"`). Each fallible `pub fn` has an `# Errors` section.
- `Result<T, String>` exists (mostly in `assist`, where the text is the tool result shown to the model). Do not add it to a library API a caller branches on. `Box<dyn Error>` has no use in `src`; do not introduce one.
- A failure a member or shell must see is returned, not only logged ([fallible-action contract](../../../docs/coding-standards.md#fallible-action-contract)). Catch only to recover, translate or at a boundary; `let _ = fallible()` needs a comment saying why dropping it is correct.
- `catch_unwind` belongs to `crates/core-ffi` and nowhere else. A panic that reaches the ABI poisons the handle by design ([CONTRACT.md clause 9](../../../crates/core-ffi/CONTRACT.md#9-a-rust-panic-never-crosses-the-boundary)); the release profile is `panic = "unwind"` so that works.

## Async, threads and locks

Details and the file each idiom lives in: [references/threads-and-locks.md](references/threads-and-locks.md). Open it before adding a thread, task, lock or `block_on`.

| Work | Use |
| --- | --- |
| Library code on the phone (`core`, `vault`, `screens`, `apps/*`) | Synchronous. No `async fn` |
| Dialing a gateway from a sync call | `Handle::runtime_handle()` (the core's one lazily built runtime) and `block_on` / `spawn` on it |
| Blocking SQLite, hashing or file work inside an async gateway task | `tokio::task::spawn_blocking`, and handle the `JoinError` |
| A guard held across `.await` | `tokio::sync::Mutex` (only `Client::live` does) |
| All other shared state | `std::sync::Mutex`; guard never crosses an `.await` or leaves the function |
| A long-lived loop blocking on a sync queue | A named raw thread that holds a `Weak` and ends when its owner closes (`tidy_in_background`, `Shelf::pump`) |
| Parallelism for speed | None. No `rayon`; a command handler must not fan out |

- Never add a second SQLite connection or a connection pool: the phone is the single writer, `Vault` is `!Sync` ([wal-checkpoint trap](../../../docs/traps/wal-checkpoint.md)).
- Never `block_on` from inside a runtime worker; never `std::thread::sleep` inside an `async fn`.
- Decide poison per lock and say so beside the accessor: recover with `PoisonError::into_inner` when the invariant survives a panic, return a typed refusal when it does not.
- A listening socket is not yours to add: `no-listening-socket` allows one gateway file (`crates/gateway/src/server/serve.rs`). The phone dials and accepts nothing.

## Ownership and types

- Own your data; borrow in parameters (`&str`, `&[T]`, `&Path`; never `&String`, `&Vec<T>`). Take `T` by value when you store or consume it. A clone that exists only to end a borrow is a bug: use `mem::take`, restructure, or split the borrow ([own-borrow-over-clone](references/rules/own-borrow-over-clone.md)).
- `Arc` only for state that crosses threads. A background thread or callback holds `Weak` (the `me: Weak<Self>` + `Arc::new_cyclic` shape in `Handle`) so dropping the owner really drops.
- Newtype ids and units; an enum for a closed set; `Option` for absence, never `-1` or `""`. No `bool` parameter in a signature with more than one call site; use a two-variant enum.
- Parse at the boundary into a validated type, then pass the type ([api-parse-dont-validate](references/rules/api-parse-dont-validate.md)). A `serde_json::Value` past the boundary is a smell ([serde-json-preserve-order trap](../../../docs/traps/serde-json-preserve-order.md): its printed text is not canonical).
- Match owned enums exhaustively; a `_ =>` arm hides the next variant. Prefer `let ... else` for early exit and `if let ... && ...` chains over nesting.
- Public enums and structs that cross a crate seam: derive `Debug`; add `#[must_use]` on pure functions and result-like types (it is already the house style: ~1,500 uses).
- Go through a crate's public API, never into a sibling crate's modules. A module named `utils`, `helpers` or `*_manager` is a [filename smell](../../../docs/coding-standards.md#filename-smells--utils-and--manager); name the domain.
- Time and ids in `centraid-vault` come from the `Clock` and `Ids` traits ([references/testing.md](references/testing.md)), never inline.
- A new dependency: declare the version once in the root `[workspace.dependencies]`, take it with `name.workspace = true`, expect `cargo deny` (`deny.toml`) and review to ask why. Never add a crate for a micro-optimisation.

## Unsafe

- `#![forbid(unsafe_code)]` is the default and sits in 15 crates (`vault`, `core`, `gateway` and its binary, `identity`, `ontology`, `protocol`, `search`, `media`, `blobs`, `api-proto`, `nativetools`, `xtask`, `centraid`, `design`, `apps/notes`); the rest have no `unsafe` either. A new crate starts with it.
- Unsafe lives in exactly two crates: `crates/core-ffi` (the C ABI) and `crates/assist-llama` (`engine.rs`, one `atexit` registration). Do not add a third; if a safe API exists, use it.
- Every `unsafe` block has a `// SAFETY:` comment naming the promise it relies on, and every `unsafe fn` a `# Safety` section. Keep the block to the one operation. `core-ffi` denies `unsafe_op_in_unsafe_fn`.
- Edition 2024 spellings: `unsafe extern "C" { ... }` and `#[unsafe(no_mangle)]`.
- The ABI is five symbols and ten clauses, each with a test named after it. Do not add a sixth symbol, change a clause, or free a library buffer with anything but `centraid_free(buf, len)`. Read [CONTRACT.md](../../../crates/core-ffi/CONTRACT.md) before touching `crates/core-ffi`; a new capability is a request kind in the proto, not a symbol. `abi-five-symbols` and the `symbols` test enforce it.
- A change to the core must reach the shells as a rebuilt file ([stale-core-slice trap](../../../docs/traps/stale-core-slice.md)).

## Logging

- `tracing` events, one line each, with the error as a field: `tracing::warn!(%error, "the sweeps cannot record their times")`. `info` for a thing an operator wants, `warn` for a degraded step, `debug` for the rest.
- A library emits and never installs a subscriber. Only a binary does (`install_tracing` in `crates/centraid/src/run.rs`, the gateway's `main`). `core-ffi` installs none, so on a device the events are dropped: what a caller must know travels in the returned error.
- No `println!`, `eprintln!` or `dbg!` in library `src`. A binary's stdout is its interface (the gateway's `listening` line is parsed by service units).
- Log once, at the point of handling; never log and also return the same error up.
- Never log a seed, a key, a token, a pairing secret, an original's path or vault content. Sweeps log counts only ([docs/logs.md](../../../docs/logs.md)).

## Protobuf and prost

All of it in [references/protobuf-prost.md](references/protobuf-prost.md). The four rules that bite: new field numbers only and `reserved` number plus name on removal; a new `.proto` goes in `PROTOS` in `crates/api-proto/build.rs`; a field on a screens message is read by both shells or is a parity-register row; never edit a `.proto` on a target directory another worktree shares.

## Tests

Where a test goes, the idioms, and what is banned: [references/testing.md](references/testing.md). Names are sentences that state the law (`exactly_five_symbols_are_exported`); one law has one owning file; time, ids and directories are injected; SQL in a test is a testdoor call, not a string.

## Performance

[Nothing O(vault-size) on the request path](../../../docs/coding-standards.md#nothing-ovault-size-on-the-request-path), [no load-bearing "vaults are small"](../../../docs/coding-standards.md#no-load-bearing-vaults-are-small-assumptions), [compute once, share the result](../../../docs/coding-standards.md#compute-once-share-the-result). A `LIMIT`ed query, a paged cursor, a fixed-size digest are bounded; a scan, a whole-blob hash or a per-subscriber recompute is not. A hot path ships with a measured budget (`call-budget`, `search-budget`). Measure before optimising ([perf-profile-first](references/rules/perf-profile-first.md)); the release profile and codegen settings belong to `Cargo.toml`.

## Comments and docs

Comments are forward-facing obligations: contract, rationale, warning or orientation; delete the rest and apply the tense test ([coding-standards](../../../docs/coding-standards.md#comments-face-forward)). Put the mental model in a `//!` module header; use a capitalised heading for a named invariant. History is cited by `(#N)`, never narrated. Public items get a one-line `///`; add `# Errors` and `# Panics` where they apply.

## Always

- Run the gate, not one crate's `cargo test`, before saying done.
- Fix the code, not the lint. An `#[expect(clippy::name, reason = "...")]` on the narrowest item is the exception, and the reason is real.
- Read the doc comment and tests of the module you edit; the invariant is usually written next to the code.
- Keep a diff an edit: change the module in place, delete the old path in the same change, no `_v2` beside the original.

## Never

- `.unwrap()` in product code; `Box<dyn Error>`; a string as an error type a caller must match on.
- `anyhow` in a library crate's public API.
- A guard across `.await`; a second vault connection; a new raw thread without an owner that ends it.
- A new `unsafe` outside the two crates; an `unsafe` block without `// SAFETY:`.
- `#![deny(warnings)]`, a `[lints]` table, or an edit to `deny.toml`, a ledger or a rule allowlist to get green.
- `println!` in a library; a secret in a log line; a gateway called a "server" or "host" in a comment or error.
- A SQL string outside `crates/{ontology,vault,search}` and `crates/apps/kit` (`sql-confinement`).
- Generated code committed, or a `.proto` edited on a shared `CARGO_TARGET_DIR`.

## Compiler and linter error to fix

| Message | Fix |
| --- | --- |
| `future cannot be sent between threads safely` ... `MutexGuard` held across `.await` | Scope the guard in a block or `drop(guard)` before the `.await`; copy or `Arc::clone` what the await needs |
| `usage of an `unsafe` block` under `forbid(unsafe_code)` | You are in the wrong crate. Use a safe API; the ABI work belongs in `core-ffi`. Never remove the `forbid` |
| `E0382` use of moved value | Borrow it, move it last, or `Arc::clone` before the `move` closure; not a blanket `.clone()` |
| `E0373` closure may outlive the current function | `move` the owned values in; a thread needs `'static` data, so `Arc` it or use `std::thread::scope` |
| `E0502` / `E0499` cannot borrow as mutable | End the earlier borrow (a block, a `let` copy), or `mem::take` the field out; do not `clone` to silence it |
| `E0599` no method `decode` / `encode_to_vec` | `use prost::Message;` |
| `clippy::large_enum_variant`, `clippy::result_large_err` | `Box` the large variant or payload |
| `clippy::too_many_arguments` | Group the arguments into a struct named for the thing they describe |
| `clippy::type_complexity` | A `type` alias or a small struct |
| `clippy::needless_borrow`, `redundant_clone`, `needless_pass_by_value` | Apply what it says; `cargo clippy --fix` only after reading the diff |
| A reviewer's "unwrap" (no lint enforces it) | `?`, a typed variant, or `.expect("<invariant>")` when it is a real invariant |
| `unused_imports`, `dead_code` (fatal under `-D warnings`) | Delete the item. In a shared `tests/common/mod.rs` the file-level `#![allow(dead_code)]` with its stated reason is the existing exception |
| `cargo fmt --all --check` diff | `cargo fmt --all` |
| `doc-links` finding | Make the link target a tracked file and the anchor a GitHub slug |
| `rules`: `sql-confinement` | Move the statement into `ontology`, `vault`, `search` or `apps/kit`; a test asks the testdoor |
| `rules`: `abi-five-symbols`, `no-listening-socket` | You added an exported symbol or a listener. Remove it; see CONTRACT.md or the gateway's one file |
| `buf breaking` | A number was reused, a field retyped or a removal not `reserved` (number and name). Restore, then follow the api-proto README |
| `tests/tree.rs` mismatch | The new `.proto` is missing from `PROTOS` in `build.rs` |
| `native-shell-parity` | The new screens field is unread by Compose or SwiftUI: read it in both, or add the register row with a reason |
| A generated type "missing a field" you just added | A shared `CARGO_TARGET_DIR`; build in a private one ([shared-cargo-target trap](../../../docs/traps/shared-cargo-target.md)) |
| Errors naming an edition-2024 item (`gen` as an identifier, `unsafe extern`, `#[unsafe(no_mangle)]`) | Rename the identifier (`r#gen`) or use the 2024 spelling |

## Reading list

| Open | When |
| --- | --- |
| [references/threads-and-locks.md](references/threads-and-locks.md) | adding a thread, task, lock, runtime or `block_on` |
| [references/protobuf-prost.md](references/protobuf-prost.md) | any `.proto`, `build.rs` or encode/decode |
| [references/testing.md](references/testing.md) | writing or moving a test, a fixture or a clock |
| [references/rules-index.md](references/rules-index.md) | a topic not covered above; ~230 pack rules by prefix, each a short file with a bad and good example |
| [references/best-practices.md](references/best-practices.md) | designing an API, a type or a module layout |
| [references/review-checklist.md](references/review-checklist.md) | reviewing a diff; priority order and report format |
| [references/guides/](references/guides/) | the reasoning behind a rule: API Guidelines, Effective Rust, design patterns, Google and Microsoft guides |
| [CENTRAID.md](CENTRAID.md) | a pack rule seems to conflict with the repo |

## Done when

`cargo xtask gate --profile local` is green (fmt, clippy `-D warnings`, the tests the change touches, `restore-drill`, `rules`, `doc-links`, `ledgers`); before a push `cargo xtask gate --profile pr`, which adds `buf`, `deny`, `call-budget`, `search-budget` and `fault-door`. A change in `crates/core-ffi` also runs its `contract` test and `cargo miri test -p centraid-core-ffi --test marshal_miri`.
