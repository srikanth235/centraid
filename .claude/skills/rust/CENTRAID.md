# Where this repository departs from the packs

The rule files under [references/](references/) come from open packs written for general Rust. **Every pack rule is copied; a rule that contradicts this repository stays in the tree with an override banner and is listed below, so read the banner and this file before applying any rule whose row says "Override".** Repository docs win ([#1160](https://github.com/srikanth235/centraid/issues/1160), ruling R5): a skill never overrides [AGENTS.md](../../../AGENTS.md), [docs/](../../../docs/) or [DESIGN.md](../../../DESIGN.md). Each row names the conflict, the winner and the owner. Rows marked **skill ruling** are decisions this skill makes from the code as it stands; they are the first place for the owner to overturn.

## Errors and panics

| Pack says | This repository | Owner |
| --- | --- | --- |
| `err-anyhow-app`, and BeautifulRust "application code favors `anyhow`-style errors, `String` parameters" | `anyhow` only at binary and tooling edges: `gateway` (the `server` feature and `bin/centraid-gateway.rs`), `xtask`. The "application" crates (`core`, `screens`, `apps/*`) are libraries to the shells, so they take typed errors. `crates/media/src/format.rs` also uses `anyhow` in a library; it is not a pattern to copy | R4 in [#1160](https://github.com/srikanth235/centraid/issues/1160) |
| `anti-unwrap-abuse` / `err-no-unwrap-prod` allow `.unwrap()` with a justification | Product `src` has no `.unwrap()` today and about 40 `.expect("<invariant>")`. Zero is the bar. No lint enforces it; review does | **skill ruling**, measured over `crates/*/src` outside `#[cfg(test)]` |
| BeautifulRust review flags "a poisoned lock recovered with `into_inner`" as a hazard | Recovery is deliberate where the invariant survives a panic (`events.rs`, `locker/phone.rs`); a typed refusal where it does not (`stage.rs`). Judge each lock by the comment beside its accessor | [references/threads-and-locks.md](references/threads-and-locks.md) |
| "Never catch a panic in a library" | `catch_unwind` exists at the C ABI entry points in `crates/core-ffi/src/lib.rs` only, and a caught panic poisons the handle | [crates/core-ffi/CONTRACT.md](../../../crates/core-ffi/CONTRACT.md) clause 9 |
| `err-custom-type` / `Result<T, String>` are both tolerated | About 200 `Result<_, String>` exist, mostly in `crates/assist` where the string is the tool result shown to the model. New APIs a caller branches on take a typed error | **skill ruling** |

## Async, threads, parallelism

| Pack says | This repository | Owner |
| --- | --- | --- |
| `conc-rayon-par-iter` | No `rayon`: the `image` codec is built with `default-features = false` to keep its thread pool out, "a command handler runs inside a SQLite transaction and must not fan out". The rule file is overridden | `Cargo.toml` (the `image` comment) |
| `async-tokio-runtime`: configure one runtime for the application | The core is synchronous and builds one two-worker runtime lazily for the flows that dial a gateway. The gateway binary is `#[tokio::main]` | [references/threads-and-locks.md](references/threads-and-locks.md) |
| `async-*` assumes an async application | Only `gateway` declares `async fn`. Do not make a library function async to match a pack example | same |
| `obs-instrument-spans` suggests `#[tracing::instrument]` | No `#[instrument]` in the tree. Events with fields, no spans. Introduce a span only with a reason a log line cannot carry | **skill ruling** |
| A thread is "just spawn and detach" | Each raw thread has an owner that ends it (`Weak`, a closed queue); see the table of sites | [references/threads-and-locks.md](references/threads-and-locks.md) |

## Unsafe

| Pack says | This repository | Owner |
| --- | --- | --- |
| `unsafe-*` rules are general | Unsafe is confined to `core-ffi` (the ABI) and one `atexit` in `assist-llama`; 15 crates `forbid(unsafe_code)`. `unsafe-miri-ci` is practised for `marshal.rs` (`cargo miri test -p centraid-core-ffi --test marshal_miri`) | CONTRACT.md, "Miri" |
| `type-repr-transparent` and FFI-layout rules | The ABI passes encoded protobuf bytes through five functions and an opaque `Handle`; `crates/core-ffi` has no `#[repr(C)]` type. Do not add one: a new capability is a request kind | **skill ruling**, CONTRACT.md clause 10 |

## Build, lint and dependencies

| Pack says | This repository | Owner |
| --- | --- | --- |
| `lint-*` (13 rules) and BeautifulRust's `lints.toml`, `clippy.toml`, "suggest a `[lints]` table", `-W clippy::pedantic` | Override (banner; do not apply). The gate runs `cargo clippy --workspace --all-targets -- -D warnings` and nothing stricter; there is no `[workspace.lints]`. A lint table is a follow-up of the umbrella and is not added in a feature change; the reasoning behind each lint is kept in [references/lint-rationale.md](references/lint-rationale.md) for review by eye. `-W clippy::pedantic` may be used locally to inspect, never committed | [#1160](https://github.com/srikanth235/centraid/issues/1160) "Out of scope", [TESTING.md](../../../TESTING.md) |
| `opt-lto-release`, `opt-codegen-units`, `opt-pgo-profile`, `opt-target-cpu`, `perf-release-profile`, and the pack's `panic = "abort"` | Override (banner; do not apply). Profiles belong to the root `Cargo.toml`. `panic = "unwind"` is required so the FFI can catch a panic; `target-cpu=native` would break artifacts built for phones | `Cargo.toml` `[profile.*]` comments |
| `mem-smallvec`, `mem-arrayvec`, `mem-thinvec`, `mem-compact-string`, `mem-arena-allocator`, `perf-ahash` | Override (banner; do not apply): they recommend dependencies. Add a crate only through `[workspace.dependencies]`, `deny.toml` and a measured budget | [deny.toml](../../../deny.toml), [TESTING.md](../../../TESTING.md) |
| `api-serde-optional`: make serde a feature | `serde` is a hard dependency in the crates that use it. Override (banner; do not apply) | the crates' manifests |
| `doc-cargo-metadata`, `doc-crate-readme`, `proj-workspace-large`-style publishing advice | Every crate is `publish = false`. Override (banner; do not apply) | `[workspace.package]` |
| `proj-prelude-module` | No prelude in the tree; go through the crate's public API. Override (banner; do not apply) | [centraid-engineering](../centraid-engineering/SKILL.md#structure) |
| `proj-mod-rs-dir` vs `foo.rs` + `foo/` | Both layouts exist (59 `mod.rs` files). Follow the neighbouring modules in the crate you are in | **skill ruling** |
| `macro-proc-*` | No proc-macro crate. Override (banner; do not apply); a new one is an architecture decision | [docs/decisions.md](../../../docs/decisions.md) |
| Rules and examples using std APIs newer than 1.94: `std::hint::cold_path` (1.95), `assert_matches!` (1.96), `From<[MaybeUninit<T>; N]>` (1.95) | Unusable until `rust-toolchain.toml` moves. The files still describe them | `rust-toolchain.toml` |

## Tests

| Pack says | This repository | Owner |
| --- | --- | --- |
| `test-mockall-mocking`, `test-snapshot-testing` (`insta`), `test-criterion-bench`, `test-loom-concurrency`, `perf-black-box-bench` | Override (banner; do not apply): none of those crates is in `Cargo.lock`. Seams are hand-written traits and committed fixtures regenerated and diffed; budgets are down-only ledgers and `call-budget` / `search-budget` | [TESTING.md](../../../TESTING.md) |
| `test-fixture-raii`, `test-tokio-async` | Kept. Scratch directories remove themselves on drop; `#[tokio::test]` is used in the gateway | [references/testing.md](references/testing.md) |
| Examples that `.unwrap()` in tests | Fine in tests, and the rest of the rule files assume that too | [references/testing.md](references/testing.md) |

## Documentation and comments

| Pack says | This repository | Owner |
| --- | --- | --- |
| `doc-all-public`, `doc-examples-section`, `lint-missing-docs`: document every public item with examples | Comments are forward-facing obligations; "deletion is the default disposition", a comment that restates the name fails the deletion test, and a file-level density budget applies. Document what the types cannot say (`# Errors`, `# Panics`, a contract); `# Examples` where a runnable doctest earns its place | [centraid-engineering](../centraid-engineering/SKILL.md#comments) |
| BeautifulRust "magic numbers become named consts with a doc comment saying where the value comes from" | Kept, but the comment states the obligation, not the history, and cites `(#N)` | same |
| History in comments ("replaced the old X") | Banned by the tense test | same |
| `serde-default-compat` | A `#[serde(default)]` that exists only for an older peer is tagged `COMPAT(name): ...` | [docs/protocol.md](../../../docs/protocol.md#c2--compatname-tagging) |

## Vocabulary

Pack text says "server", "host", "client/server" and "database". Here the phone is the vault, and a machine running `centraid-gateway` is a _gateway_, never a server or a host ([AGENTS.md](../../../AGENTS.md)). Code, comments and error text use the repository's words ([docs/glossary.md](../../../docs/glossary.md)).
