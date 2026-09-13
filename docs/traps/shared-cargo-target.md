# Trap: one `CARGO_TARGET_DIR` across two worktrees

## What goes wrong

Two worktrees of this repository that share a `CARGO_TARGET_DIR` do not merely contend for cargo's build lock. They hand each other build output, and the errors land in files neither lane touched.

Two mechanisms, both real and both observed under [#1020](https://github.com/srikanth235/centraid/issues/1020) wave 4:

1. **A build script's `OUT_DIR` is keyed by package identity, not by source directory.** `crates/api-proto/build.rs` generates Rust from `.proto` files into `OUT_DIR`, and the package's identity — name, version, metadata hash — is identical in every worktree. A lane that edits a `.proto` therefore publishes its generated Rust to every other lane sharing the directory. The symptom is a compile error inside a crate the lane never opened: `missing field 'identity' in initializer of Hello`, `missing field 'sentence'`.
2. **A compiled binary remembers where it was built.** `crates/xtask` resolved `repo_root()` from `env!("CARGO_MANIFEST_DIR")`, which is baked in at compile time. `cargo xtask gate` run from worktree A, with a binary the shared directory built from worktree B, walked **B's** tree — observed as `sql-confinement` reporting 98 scanned files against the 89 the worktree holds. Fixed in `crates/xtask` (`repo_root()` resolves at run time and the warm/cold reading comes off `CARGO_TARGET_DIR`), so this half is closed; the `OUT_DIR` half is not, and cannot be fixed from inside the workspace.

The consequence worth stating plainly: **no gate verdict taken from a shared target directory is worth anything**, whichever lane produced it.

## Correct setup

One target directory per worktree, exported before any cargo or xtask command:

```sh
export CARGO_TARGET_DIR=/home/user/cargo-target-<lane>
touch crates/api-proto/build.rs      # force the generator to re-run into this directory
cargo xtask gate --profile local
rm -rf "$CARGO_TARGET_DIR/release"   # after any release build — it is the large half
```

Disk is the reason anybody shares one, so budget for it: a warm debug tree of this workspace is several GB, and `cargo build --release` adds its own. `df -h` before a release build, and clear `release/` after.

## How agents get it wrong

1. **Sharing one directory to save disk, then trusting the gate.** The disk is saved and the verdict is worthless. Re-establish every claim in a private directory before quoting it in a receipt.
2. **Assuming a build error names the lane that caused it.** It names the crate that failed to compile. When the failing file is one the lane never edited and the field it complains about is in generated code, suspect the shared directory first.
3. **Killing another lane's cargo process to get the lock.** Cargo serialises concurrent builds on purpose; waiting is correct and killing corrupts.
4. **Re-running `cargo xtask` after switching worktrees without rebuilding it.** The alias runs whatever binary the shared directory holds.

## Checklist

- [ ] `CARGO_TARGET_DIR` set, unique to this worktree
- [ ] `touch crates/api-proto/build.rs` before the first build in a fresh directory
- [ ] `$CARGO_TARGET_DIR/release` removed after a release build
- [ ] Any gate verdict quoted in a receipt was taken in this worktree's own directory

## Related

- [worktrees.md](worktrees.md)
- [../multi-agent.md](../multi-agent.md)
- [../dev-environment.md](../dev-environment.md#the-local-gate-loop)
