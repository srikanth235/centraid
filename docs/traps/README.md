# Traps — one doc per known footgun

Read the matching trap before working near its area; each one was paid for once.

| Doc | Topic |
| --- | --- |
| [design-tokens.md](design-tokens.md) | Token source of truth vs hardcoded CSS; the two layers of `packages/design` |
| [worktrees.md](worktrees.md) | Install/build/data isolation in worktrees |
| [wal-checkpoint.md](wal-checkpoint.md) | Copying a live vault tears it; the one safe copy is a snapshot through SQLite's online backup API, under the write lock, page for page |
| [generated-and-committed.md](generated-and-committed.md) | A file that is generated _and_ committed, with a guard on the generated half: green while the source is wrong |
| [coverage-run-filters.md](coverage-run-filters.md) | Filtering a vitest coverage run without over-measuring |
| [emulator-snapshot-settings.md](emulator-snapshot-settings.md) | `settings put global` on a lane that restores a cached AVD RAM snapshot |
| [stale-core-slice.md](stale-core-slice.md) | A Kotlin/Native framework links `libcentraid_core_ffi.a` by PATH, so a changed Rust core ships as the old one with no error |
| [shared-cargo-target.md](shared-cargo-target.md) | Two worktrees on one `CARGO_TARGET_DIR`: a build script's `OUT_DIR` is keyed by package identity, and a gate verdict is then worthless |
| [serde-json-preserve-order.md](serde-json-preserve-order.md) | A `serde_json::Value`'s printed text is not canonical — `preserve_order` unifies across a build, so one crate's feature decides another crate's sort |
