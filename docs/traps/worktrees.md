# Trap: git worktrees

## What goes wrong

A second worktree looks like a full checkout but is missing installs, `dist/`, native binaries, or shares mutable gateway state with another agent. Symptoms: "module not found", wrong platform iroh binary, SQLite locks, mysterious port conflicts.

## Correct setup

```sh
git worktree add ../centraid-wt issue-branch
cd ../centraid-wt
git config core.hooksPath .githooks   # if not inherited
bun install
bun run build
```

Use a **private** `--data-dir` / Electron profile for any gateway you start.

## How agents get it wrong

1. **Assuming root `node_modules` applies** — worktrees are separate directories; install locally.
2. **Skipping build** — many packages resolve `dist/`; tests and desktop can fail in confusing ways without it.
3. **Sharing `gw-data/` or userData** across worktrees or agents — WAL locks and enrollment files thrash.
4. **Symlinking `node_modules` from another OS/arch** — native addons (`@number0/iroh`, etc.) break; pairing Docker may need additive native fetch (`tests/agent-e2e-pairing/AGENTS.md`).
5. **Running full monorepo test suites in every worktree simultaneously** — thrash; see [multi-agent.md](../multi-agent.md).
6. **Editing the same package in two worktrees without coordinating branches** — merge pain; one owner per concern.

## Checklist

- [ ] `bun install` + necessary `build` in this worktree
- [ ] Unique ports and data dirs
- [ ] No kill of other agents' gateways
- [ ] `check:pr` only when preparing *this* branch for push

## Related

- [dev-environment.md](../dev-environment.md)
- [multi-agent.md](../multi-agent.md)
