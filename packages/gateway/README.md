# @centraid/gateway

Host-agnostic centraid gateway. `buildGateway()` wires
[`@centraid/app-engine`](../app-engine) +
[`@centraid/agent-runtime`](../agent-runtime) + stores + a conversation runner +
an in-process cron scheduler against injected paths, and `serve()` starts an
HTTP server in front of it.

Three hosts mount the same core:

| Host | Paths come from | Bearer token | App-code backend |
| --- | --- | --- | --- |
| [`@centraid/desktop`](../../apps/desktop) embed | `gateway-paths.ts` → `<userData>/gateways/<id>/` | Electron `safeStorage` | git store |
| `centraid-gateway` CLI (this package) | a JSON config file or `--data-dir` flag | persisted at `<dataDir>/token.bin` | legacy tarball upload |
| [`@centraid/openclaw-plugin`](../openclaw-plugin) | OpenClaw state dir | OpenClaw owns auth | git store |

No new wire protocol — every host serves the same `/centraid/*`,
`/_centraid-conversations/*`, and `/_centraid-user/*` routes, so desktop and
mobile clients reach any of them through their existing remote-gateway flow.

## `serve()` — library entry

```ts
import { serve } from '@centraid/gateway';

const handle = await serve({
  paths: {
    appsDir: '/var/lib/centraid/apps',
    identityDb: '/var/lib/centraid/identity.sqlite',
    analyticsDb: '/var/lib/centraid/analytics.sqlite',
    conversationRunnerSessionDir: '/var/lib/centraid/conversation-runner-sessions',
    modelCatalogFile: '/var/lib/centraid/model-catalog.json',
  },
  host: '0.0.0.0',
  port: 8765,
});
console.log(handle.url, handle.token);
```

`paths` is the only required option (see `GatewayPaths` in `src/paths.ts`).
There is no `secrets` injection: the gateway is auth-agnostic about the coding
agent — codex and Claude Code each own their own auth (`codex login` /
`claude login` on the gateway host). Supply `appsStoreRoot` to opt into the git
store backend (the desktop and OpenClaw do); omit it for the legacy
tarball-upload backend (what the standalone CLI below uses).

## `centraid-gateway` CLI — standalone daemon

```sh
# First boot — mints + persists token at <dataDir>/token.bin, prints URL + token
centraid-gateway serve --data-dir /var/lib/centraid --host 0.0.0.0 --port 8765

# Read back the persisted token
centraid-gateway print-token --data-dir /var/lib/centraid
```

Bind defaults to `127.0.0.1:0` (loopback, OS-assigned port). Pass
`--host 0.0.0.0` for LAN. `serve` flags override the config file.

### Pointing the desktop at the daemon

The desktop's `GatewayKind = 'local' | 'remote'` already handles this — no new
gateway kind. In **Settings → Gateways → Add remote**, paste:

- **URL:** `http://<your-lan-ip>:<port>` (e.g. `http://192.168.1.42:8765`)
- **Token:** the value printed by `centraid-gateway`

Switch to that gateway. The home shelf, chat panel, automations, and Insights
screen all work — the daemon is just another host behind the same bearer.

Mobile is identical: paste URL + token in the remote-gateway form. The phone
never needs codex / Claude Code installed locally — the runner runs on the
daemon host.

### Config file

```json
{
  "dataDir": "/var/lib/centraid",
  "host": "0.0.0.0",
  "port": 8765,
  "runner": {
    "kind": "codex",
    "binPath": "/opt/homebrew/bin/codex",
    "extraArgs": ["--model", "<model-id>"]
  }
}
```

```sh
centraid-gateway serve --config /etc/centraid-gateway.json
```

Every field is optional except `dataDir` (see `validateConfig` in
`src/cli/config.ts`). The `runner` block seeds the gateway's identity DB on
first boot (`agent.runner.kind` / `binPath` / `extraArgs`), so the per-turn
prefs loader inside `serve()` reads it unchanged; removing the block on a later
boot clears those prefs. There is **no** `provider` block and no provider-key
file — model/provider routing is the coding agent CLI's own config.

## Daemon `<dataDir>` layout

```
<dataDir>/
  apps/                          — registered apps + _registry.json + per-app state (logs, settings)
  identity.sqlite                — users + per-user prefs
  analytics.sqlite               — one summary row per run
  conversation-runner-sessions/  — codex/claude thread state for in-app chat
  model-catalog.json             — per-runner model + tool catalog
  token.bin                      — persistent bearer token (mode 0o600)
```

## v0 scope and gaps

Per [centraid#131](https://github.com/srikanth235/centraid/issues/131), the
daemon ships intentionally narrow:

- Single shared bearer token (no per-device tokens, no revocation list).
- No TLS terminator. Bind loopback for same-machine use; for LAN, trust the
  network or front with Caddy / Tailscale Funnel / Cloudflare Tunnel.
- No mDNS / Bonjour discovery; paste URL + token only.
- Single user. Multi-user identity is a larger design and lands separately.
- No daemon auto-update. Bumping the gateway is `git pull` + `bun install` +
  restart, by design.
- The CLI daemon runs the **legacy tarball-upload** code backend (no
  `appsStoreRoot`), so it has no draft worktree and uses the data-only chat
  runner rather than the unified builder chat the desktop/OpenClaw get.

## Tests

```sh
bun run test
```

Covers:

- `serve.test.ts` — boot, loopback bind + token mint, bearer auth, the
  `GET /centraid/_turn/runner-status` and `GET /centraid/_agents/status` routes.
- `cli.test.ts` — config validation, prefs-patch shape, token mint/read,
  end-to-end CLI spawn + SIGTERM.
- `serve-multiclient.test.ts` — two HTTP clients against the same daemon: one
  publishes an app, the other lists + static-serves it.
