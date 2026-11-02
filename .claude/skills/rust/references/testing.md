# Rust tests in this repository

Open this before writing or moving a Rust test. The strategy is [TESTING.md](../../../../TESTING.md) (read its axiom and "what the machine cannot check" first); the one-law-one-home rule is in [docs/coding-standards.md](../../../../docs/coding-standards.md#one-law-one-home). This file records the idioms the crates actually use. The pack rules are [test-cfg-test-module](rules/test-cfg-test-module.md), [test-integration-dir](rules/test-integration-dir.md), [test-descriptive-names](rules/test-descriptive-names.md), [test-proptest-properties](rules/test-proptest-properties.md) and [test-mock-traits](rules/test-mock-traits.md).

## Where a test goes

| Test of | Home |
| --- | --- |
| A private function or one module's behaviour | `#[cfg(test)] mod tests` at the **bottom** of the file (over 200 `src` files do this). A large suite moves to a sibling `*_tests.rs` (`crates/core/src/app_query/locker_tests.rs`) |
| A crate's public behaviour | `crates/<crate>/tests/<topic>.rs`, one file per topic; shared setup in `tests/common/mod.rs` |
| The C ABI | `crates/core-ffi/tests/contract.rs`, one test per clause, named after the clause, called through the C symbols ([CONTRACT.md](../../../../crates/core-ffi/CONTRACT.md)) |
| The unsafe surface | `cargo miri test -p centraid-core-ffi --test marshal_miri` (CONTRACT.md, "Miri") |
| A property over many inputs | `proptest` (a dev-dependency of `vault` and `nativetools`; `crates/vault/tests/properties.rs`) |
| A wire message | `crates/api-proto/tests/roundtrip.rs` |
| A structural repository rule | `crates/xtask`, with a fixture the rule **must** catch |

## Always

- **Name a test as the sentence it proves**: `a_full_disk_at_the_log_insert_rolls_the_whole_commit_back`, `exactly_five_symbols_are_exported`. A named law lives in one owning file; a second file asserting it is a restatement, delete it.
- **Inject time and ids.** In `centraid-vault` every timestamp and id comes from the `Clock` and `Ids` traits (`crates/vault/src/clock.rs`), never an inline `SystemTime::now()` or random source. Tests use `FixedClock` (move it with the `Arc` the test holds) and `SeededIds`. A retention edge cannot be asserted on a clock the test cannot move.
- **Give every test its own scratch directory.** `centraid_ontology::scratch::scratch_dir()` makes a name no other test holds, and `tests/common/mod.rs` in `vault` wraps it in a `Scratch` that is removed on drop. `tempfile` is a dev-dependency of `blobs`, `core`, `gateway`. Never open a committed vault path: opening writes a `-wal` sidecar ([traps/wal-checkpoint.md](../../../../docs/traps/wal-checkpoint.md)).
- **Ask the vault's own test door, not SQL.** `sql-confinement` refuses SQL string literals outside `crates/{ontology,vault,search}` and `crates/apps/kit`, tests included. Use `centraid_vault::testdoor` and `crates/apps/kit/src/testdoor.rs`, named for the question (`vault_rows(connection)`).
- **Put a seed behind every random draw** and keep a failing proptest seed as a permanent test.
- **Make a skip loud.** A test that cannot run says so and names the command that makes it run; it is never a silent pass.
- **Test through the seam a caller uses.** A behaviour-preserving refactor keeps tests green without rewriting assertions.
- **Treat an in-test `sleep` as a last resort and say why** (the existing one, in `events.rs`, explains that the alternative is a second condvar testing the test).

## Never

- **Never write a test that cannot fail.** A structural rule with no fixture it must catch is a claim, not a gate.
- **Never add a mocking, snapshot or benchmark crate** (`mockall`, `insta`, `criterion`, `loom`: none is in `Cargo.lock`). Dependencies are a `cargo deny` and review matter; the seams are hand-written traits (`Clock`, `Ids`) and committed fixtures that are regenerated and diffed, not edited.
- **Never change a budget, ledger number or allowlist to turn a test green.** Fix the code ([AGENTS.md](../../../../AGENTS.md)).
- **Never spawn a task or thread in a test that outlives it.** Join it, or hold its handle until the assertion.
- **Never mutate the process environment in a test** (`env::set_var` is `unsafe` in edition 2024, and most crates forbid unsafe): pass the value in.

## Unwrap and expect in tests

`.unwrap()` and `.expect("...")` are normal in test code and in `tests/`; `?` in a `-> Result<()>` test is preferred when the setup is fallible (the vault's `Scratch` helpers return `Result`). The rule that binds is for product code: [SKILL.md](../SKILL.md#errors-and-panics).

## Commands

| Need | Run |
| --- | --- |
| One crate while iterating | `cargo test -p centraid-<crate>` |
| The edit-run loop before a push | `cargo xtask gate --profile local` (tests only the crates the change touches and their dependents; with `cargo-nextest` it runs `nextest` plus doctests) |
| What `local` would test, and why | `cargo xtask test-plan` |
| Everything CI runs | `cargo xtask gate --profile pr` |
