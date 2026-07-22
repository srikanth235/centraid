# Dev environment (G1)

Stand up Centraid development without tribal knowledge. **Do not invent a new manifest format** — promote `.claude/launch.json` when present; otherwise use the patterns below ([decisions.md](decisions.md)).

## Prerequisites

- [Bun](https://bun.sh) matching root `packageManager` (pinned in `package.json`)
- Node ≥ 24 (built-in `node:sqlite` for gateway/runtime)
- For desktop: platform deps for Electron
- For mobile: Xcode / Android SDK as needed
- Optional: Docker for `tests/agent-e2e-pairing` cross-network relay

## Fresh clone

```sh
git clone <repo-url> centraid && cd centraid
git config core.hooksPath .githooks   # once per clone
bun install
bun run build                         # packages emit dist/; blueprints regenerate manifest/vendors as needed
```

Smoke:

```sh
bun run dev:desktop    # Electron + local gateway
bun run dev:web        # Vite PWA
# headless:
bun run build && centraid-gateway serve --data-dir ./gw-data --host 127.0.0.1 --port 8765
```

## Named services and ports

| Name | Command | Default bind | Notes |
| --- | --- | --- | --- |
| **desktop** | `bun run dev:desktop` | Electron window; gateway loopback (often ephemeral until H4) | Embeds gateway today; H1 targets detached |
| **web** | `bun run dev:web` | Vite default (see `apps/web`) | Needs a reachable gateway or ticket path |
| **mobile** | `bun run dev:mobile` | Metro **8081** | Pair via desktop Settings → Phone |
| **gateway-daemon** | `centraid-gateway serve --data-dir <dir> --host 127.0.0.1 --port 8765` | **8765** (example) | Print token: `centraid-gateway print-token --data-dir <dir>` |
| **product CLI** | `centraid status --url http://127.0.0.1:8765 --data-dir <dir>` | (client) | Wire client (`@centraid/cli`); auth via `--token` / `CENTRAID_TOKEN` / `token.bin` |
| **docs site** | `bun run docs:serve` | **4173** on 127.0.0.1 | After `docs:build` / `docs:bundle` |

Parameterize ports via CLI flags / env documented on each package; do not hardcode foreign ports into other apps without a single config owner.

## Worktrees

Agents often work in git worktrees (including under `.claude/worktrees/`).

1. **Install** — each worktree needs its own `bun install` (do not assume root `node_modules` is visible unless you deliberately symlink — prefer install).
2. **Build** — run `bun run build` (or filtered turbo) so `dist/` exists for packages that resolve compiled output.
3. **Do not share** writable `gw-data/`, Electron `userData`, or SQLite vault dirs across concurrent agents.
4. **Symlinks** — if you symlink `node_modules` for speed, rebuild native addons for the active platform; pairing Docker flows may fetch platform-specific `@number0/iroh` binaries (see `tests/agent-e2e-pairing/AGENTS.md`).
5. **Seed data** — optional; use a dedicated `--data-dir` and vault create rather than copying a live vault (see [traps/wal-checkpoint.md](traps/wal-checkpoint.md)).

More traps: [traps/worktrees.md](traps/worktrees.md). Multi-agent rules: [multi-agent.md](multi-agent.md).

## `.claude/launch.json`

If a local `.claude/launch.json` exists (may be gitignored), treat it as the **named service list** for Claude/desktop launch integrations (ports, cwd, commands). Keep it in sync when you add a long-lived dev process. If absent, the table above is the source of truth until someone adds the file.

## Tools only via repo scripts

Never raw `npx vitest`, `npx tsc`, etc. Use:

```sh
bun run test
bun run typecheck
bun run check:pr    # required before push
bun run format
```

Pinned toolchain lives in root `package.json` / workspaces.

## Related

- [multi-agent.md](multi-agent.md)
- [logs.md](logs.md)
- [README.md](../README.md)
