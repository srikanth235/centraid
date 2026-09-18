# Trap: git worktrees

## What goes wrong

A second worktree looks like a full checkout but is missing installs, `dist/`, or its own cargo target directory, or shares mutable gateway state with another agent. Symptoms: "module not found", compile errors in crates the lane never touched, a gate verdict about the wrong tree, SQLite locks, a seat socket already in use.

## Correct setup

```sh
git worktree add ../centraid-wt issue-branch
cd ../centraid-wt
git config core.hooksPath .githooks   # if not inherited
export CARGO_TARGET_DIR=<unique per worktree>
touch crates/api-proto/build.rs       # force the proto generator into this target dir
bun install
cargo build -p centraid
```

Use a **private** `--data-dir`, seat socket and Electron `userData` for any gateway, seat or desktop you start.

## How agents get it wrong

1. **Assuming root `node_modules` applies** — worktrees are separate directories; install locally.
2. **Sharing a `CARGO_TARGET_DIR`** — generated Rust and xtask binaries leak between lanes, and no gate verdict from it is worth anything ([shared-cargo-target.md](shared-cargo-target.md)).
3. **Skipping the build** — `desktop/electron` spawns the `centraid` binary `CENTRAID_BINARY` names (under your `CARGO_TARGET_DIR`, not `target/`, once that is set) and loads its own `dist/`; a stale binary or a missing `dist/` fails in confusing ways.
4. **Sharing a `--data-dir` or `userData`** across worktrees or agents — the gateway is the single writer, and a second process fights its lock.
5. **Symlinking `node_modules` from another OS/arch** — native binaries (Electron, Playwright browsers) break.
6. **Running `cargo xtask gate --profile pr` in every worktree simultaneously** — thrash; see [multi-agent.md](../multi-agent.md).
7. **Editing the same crate or package in two worktrees without coordinating branches** — merge pain; one owner per concern.

## Checklist

- [ ] `CARGO_TARGET_DIR` unique to this worktree
- [ ] `bun install` + necessary builds in this worktree
- [ ] Unique data dirs and sockets
- [ ] No kill of other agents' gateways, seats or cargo processes
- [ ] `cargo xtask gate --profile pr` only when preparing _this_ branch for push

## Related

- [dev-environment.md](../dev-environment.md)
- [multi-agent.md](../multi-agent.md)
- [shared-cargo-target.md](shared-cargo-target.md)
