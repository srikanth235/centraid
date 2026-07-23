# @centraid/gateway

Host-agnostic centraid gateway. `buildGateway()` wires
[`@centraid/app-engine`](../app-engine) +
[`@centraid/agent-runtime`](../agent-runtime) + stores + a conversation runner +
an in-process cron scheduler against injected paths, and `serve()` starts an
HTTP server in front of it.

Two hosts mount the same core:

| Host | Paths come from | Loopback bearer | App-code backend |
| --- | --- | --- | --- |
| [`@centraid/desktop`](../../apps/desktop) embed | `gateway-paths.ts` → `<userData>/gateways/<id>/` | per-launch token (in-memory) | git store |
| `centraid-gateway` CLI (this package) | a JSON config file or `--data-dir` flag | ephemeral per-boot secret (not persisted; pin via `CENTRAID_GATEWAY_TOKEN`) | legacy tarball upload |

No new wire protocol — every host serves the same `/centraid/*`,
`/_centraid-conversations/*`, and `/_centraid-user/*` routes, so desktop and
mobile clients reach any of them through their existing remote-gateway flow.

## `serve()` — library entry

```ts
import { serve } from '@centraid/gateway';

const handle = await serve({
  paths: {
    vaultDir: '/var/lib/centraid/vault',
    prefsFile: '/var/lib/centraid/prefs.json',
    modelCatalogFile: '/var/lib/centraid/model-catalog.json',
  },
  host: '0.0.0.0',
  port: 8765,
});
console.log(handle.url, handle.token);
```

`paths` is the only required option (see `GatewayPaths` in `src/paths.ts`);
`vaultDir` and `prefsFile` are its required fields. Post-#280 the vault is
the unit — everything personal (apps, code, conversation ledger, run
history) lives inside `<vaultDir>/<vaultId>/`, so the gateway level keeps
only plumbing (device prefs, model catalog). There is no `identity.sqlite`
or `analytics.sqlite`: the vault owner IS the user, and the run rollup is
now the `run_summary` view inside each vault's `journal.db`.
There is no `secrets` injection: the gateway is auth-agnostic about the coding
agent — codex and Claude Code each own their own auth (`codex login` /
`claude login` on the gateway host). Supply `appsStoreRoot` to opt into the git
store backend (the desktop does); omit it for the legacy
tarball-upload backend (what the standalone CLI below uses).

## `centraid-gateway` CLI — standalone daemon

```sh
# Boot. The loopback bearer is an ephemeral per-boot secret (issue #505 phase 7)
# — never written to disk, never printed. Pin a known value if a co-located
# client (e.g. the `centraid` product CLI) needs to reach the loopback listener.
CENTRAID_GATEWAY_TOKEN=$(openssl rand -hex 32) \
  centraid-gateway serve --data-dir /var/lib/centraid --host 0.0.0.0 --port 8765

# Enrol a device (the first one gets the revocable `owner` admin tier):
centraid-gateway pair --data-dir /var/lib/centraid --vault <name>
```

Bind defaults to `127.0.0.1:0` (loopback, OS-assigned port). Pass
`--host 0.0.0.0` for LAN. `serve` flags override the config file.

### Pointing the desktop at the daemon

The desktop's `GatewayKind = 'local' | 'remote'` already handles this — no new
gateway kind. There is **no** URL + admin-token paste (retired with the shared
bearer, issue #505 phase 7). In **Settings → Gateways → Add gateway**, paste a
one-time **pairing ticket** from `centraid-gateway pair`; for a self-fronted
`direct`-tier URL, open the advanced "Connect by URL" panel and redeem the same
ticket over that URL — either way the ceremony mints a per-device token.

Switch to that gateway. The home shelf, chat panel, automations, and Insights
screen all work — the daemon is just another host behind its own per-device
enrollment.

Mobile is identical: pair with a ticket. The phone never needs codex / Claude
Code installed locally — the runner runs on the daemon host.

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
`src/cli/config.ts`). The `runner` block seeds the gateway's device prefs
(`<dataDir>/prefs.json`) on first boot (`agent.runner.kind` / `binPath` /
`extraArgs`), so the per-turn prefs loader inside `serve()` reads it unchanged;
removing the block on a later boot clears those prefs. (#280 killed the old
`identity.sqlite` — the vault owner is the user, so what's left at the gateway
level is device configuration.) There is **no** `provider` block and no
provider-key file — model/provider routing is the coding agent CLI's own config.

## Daemon `<dataDir>` layout

Post-#280 the gateway level holds only plumbing; everything personal lives
inside a vault (see `daemonLayoutFor` in `src/cli/paths.ts`):

```
<dataDir>/
  prefs.json             — device prefs (runner choice, binPath, …)
  model-catalog.json     — chat picker's per-runner model + tool catalog
  devices.json           — device enrollments: device key ↔ vault + trust tier (#289/#505)
  pairing-tickets.json   — one-time pairing tickets, secret hashes only (#289)
  device-tokens.json     — per-device HTTP tokens for the direct tier, hashes only (#376)
  endpoint-key.bin       — the gateway's persistent iroh secret key (#289)
  endpoint.json          — the live endpoint's id + dial ticket, for the pair CLI (#289)
  vault/                 — vault registry root: one subdirectory per vault
    <vaultId>/
      vault.db           — the ontology schemas (one ACID boundary)
      journal.db         — audit stream + conversation ledger + run_summary view
      apps/              — per-app DATA (logs, settings, attachment blobs)
      code/              — app code git store (apps.git + worktrees/)
      runner-sessions/   — codex/claude thread state for in-app chat
```

Each vault is sovereign — a backup is `cp -r <dataDir>/vault/<vaultId>`. The
run rollup that feeds Insights is the `run_summary` VIEW inside `journal.db`,
not a separate file.

## v0 scope and gaps

Per [centraid#131](https://github.com/srikanth235/centraid/issues/131), the
daemon ships intentionally narrow:

- No shared admin token (retired #505 phase 7): the loopback bearer is an
  ephemeral per-boot secret, and admin capability is the per-device, revocable
  `owner` enrollment trust tier. Remote access is pairing-only; per-device
  tokens (revocable) back the `direct` transport tier.
- No TLS terminator. Bind loopback for same-machine use; for LAN, trust the
  network or front with Caddy / Tailscale Funnel / Cloudflare Tunnel.
- No mDNS / Bonjour discovery; pair with a one-time ticket.
- Single user. Multi-user identity is a larger design and lands separately.
- No daemon auto-update. Bumping the gateway is `git pull` + `bun install` +
  restart, by design.
- The CLI daemon runs the **legacy tarball-upload** code backend (no
  `appsStoreRoot`), so it has no draft worktree and uses the data-only chat
  runner rather than the unified builder chat the desktop gets.

## Tests

```sh
bun run test
```

Covers:

- `serve.test.ts` — boot, loopback bind + token mint, bearer auth, the
  `GET /centraid/_turn/runner-status` and `GET /centraid/_agents/status` routes.
- `cli.test.ts` — config validation, prefs-patch shape, and an end-to-end CLI
  spawn that authenticates with a parent-supplied `CENTRAID_GATEWAY_TOKEN`
  loopback secret (never printed), then SIGTERM.
- `serve-multiclient.test.ts` — two HTTP clients against the same daemon: one
  publishes an app, the other lists + static-serves it.
