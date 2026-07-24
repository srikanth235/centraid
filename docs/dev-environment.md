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
| **gateway-daemon** | `CENTRAID_GATEWAY_TOKEN=<hex> centraid-gateway serve --data-dir <dir> --host 127.0.0.1 --port 8765` | **8765** (example) | No `print-token` (retired #505); set `CENTRAID_GATEWAY_TOKEN` to pin the loopback secret, or `centraid-gateway pair` for a device ticket |
| **product CLI** | `centraid status --url http://127.0.0.1:8765 --token <hex>` | (client) | Wire client (`@centraid/cli`); auth via `--token` / `CENTRAID_TOKEN` / `CENTRAID_GATEWAY_TOKEN` |
| **docs site** | `bun run docs:serve` | **4173** on 127.0.0.1 | After `docs:build` / `docs:bundle` |

Parameterize ports via CLI flags / env documented on each package; do not hardcode foreign ports into other apps without a single config owner.

## Preview the web app in a browser against an existing vault

The desktop app provisions its vault **in-process**, so a fresh browser origin
served by a standalone gateway lands on onboarding rather than your data. Do
**not** pick **This Mac** in that onboarding — it tries to *create* a vault over
HTTP, which the gateway rejects (vault creation is admin-only, issue #289, so you
get `Create vaults on the gateway host`). The supported way to reach an existing
vault from a browser is **pair a device**, exactly like a phone or a second
desktop:

1. **Serve the existing vault.** Point a gateway at the data dir that already has
   the vault. Desktop's lives at
   `~/Library/Application Support/@centraid/desktop/gateways/local`.

   ```sh
   centraid-gateway serve --data-dir "<data-dir>" --host 127.0.0.1 --port 17832
   ```

   The gateway serves the **API** on `--port` and the **web UI on a second port**
   — read the exact `web app: http://127.0.0.1:<p>` line it prints on startup.
   The web UI it serves is the **build-time snapshot** embedded in
   `packages/gateway/dist/web`. To preview *uncommitted client edits*, rebuild and
   re-embed first (no full gateway rebuild needed):

   ```sh
   bun run --cwd apps/web build && node packages/gateway/scripts/embed-web.mjs
   ```

2. **Mint a pairing ticket** for the vault (one line; redeems over plain HTTP via
   `POST /centraid/_gateway/pair`, issue #376):

   ```sh
   centraid-gateway pair --data-dir "<same data-dir>" --vault "<name-or-id>"
   ```

3. **Open the web UI in the browser pane.** Register the web port in
   `.claude/launch.json` and start it with the preview tool — ad-hoc navigation to
   a bare `http://localhost:<port>` is policy-blocked, but a `preview_start`-managed
   server (a config with just a `url` **attaches** to the already-running gateway)
   is the sanctioned path:

   ```json
   { "version": "0.0.1",
     "configurations": [{ "name": "centraid-web", "url": "http://127.0.0.1:17833", "port": 17833 }] }
   ```

4. In onboarding choose **Existing gateway → paste the ticket** (the ConnectFlow,
   `packages/client/src/react/shell/routes/ConnectFlow.tsx`). The ticket redeems
   for a per-device HTTP token and connects to the existing vault — its
   automations, runs, and data appear as in desktop.

Alternatively pin the loopback bearer with `CENTRAID_GATEWAY_TOKEN=<hex>` on the
`serve` (table above) and connect by URL + token; the pairing ticket is the less
fiddly path for a browser session. Do not point a standalone gateway at a data
dir the desktop app is **also** running against — two writers on one SQLite vault
(see [traps/wal-checkpoint.md](traps/wal-checkpoint.md)).

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
