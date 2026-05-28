# @centraid/gateway-runtime

Host-agnostic centraid gateway. Wires [`@centraid/runtime-core`](../runtime-core) +
[`@centraid/agent-runtime`](../agent-runtime) + stores + chat runner against
injected paths and secrets, and starts an HTTP server in front of it.

Two consumers ship today:

| Consumer | Paths come from | Secrets come from |
| --- | --- | --- |
| [`@centraid/desktop`](../../apps/desktop) embed | `gateway-paths.ts` → `<userData>/gateways/<id>/` | Electron `safeStorage` |
| `centraid-gateway` CLI (this package) | a JSON config file or `--data-dir` flag | sealed file at `<dataDir>/provider-key.bin` |

No new wire protocol — the daemon serves the exact same `/centraid/*` and
`/_centraid-*` routes the Electron embed does, so desktop and mobile
clients reach it through their existing remote-gateway flow.

## `serve()` — library entry

```ts
import { serve } from '@centraid/gateway-runtime';

const handle = await serve({
  paths: {
    appsDir: '/var/lib/centraid/apps',
    identityDb: '/var/lib/centraid/identity.sqlite',
    analyticsDb: '/var/lib/centraid/analytics.sqlite',
    chatRunnerSessionDir: '/var/lib/centraid/chat-runner-sessions',
    codexHomeBaseDir: '/var/lib/centraid/codex-home',
  },
  secrets: { async getProviderApiKey() { return process.env.PROVIDER_KEY; } },
  host: '0.0.0.0',
  port: 8765,
});
console.log(handle.url, handle.token);
```

## `centraid-gateway` CLI — standalone daemon

```sh
# First boot — mints + persists token, prints URL + token to stdout
centraid-gateway serve --data-dir /var/lib/centraid --host 0.0.0.0 --port 8765

# Subsequent boots reuse the persisted token
centraid-gateway print-token --data-dir /var/lib/centraid
```

### Pointing the desktop at the daemon

The desktop's `GatewayKind = 'local' | 'remote'` already handles this —
no new gateway kind. In **Settings → Gateways → Add remote**, paste:

- **URL:** `http://<your-lan-ip>:<port>` (e.g. `http://192.168.1.42:8765`)
- **Token:** the value printed by `centraid-gateway`

Switch to that gateway. The home shelf, chat panel, automations, and
Insights screen all work — the daemon is just another `/centraid/*` host
behind the same bearer.

Mobile is identical: paste URL + token in the remote-gateway form. The
phone never needs codex / claude-code installed locally — the runner
runs on the daemon host.

### Config file

```json
{
  "dataDir": "/var/lib/centraid",
  "host": "0.0.0.0",
  "port": 8765,
  "runner": {
    "kind": "codex",
    "binPath": "/opt/homebrew/bin/codex"
  },
  "provider": {
    "id": "ollama-local",
    "name": "Local Ollama",
    "baseUrl": "http://127.0.0.1:11434/v1",
    "wireApi": "chat",
    "envKey": "OLLAMA_API_KEY",
    "apiKey": "<plaintext key — sealed at <dataDir>/provider-key.bin>"
  }
}
```

```sh
centraid-gateway serve --config /etc/centraid-gateway.json
```

CLI flags override file fields. The `runner` / `provider` blocks seed
the gateway's identity DB on first boot, so the per-turn prefs loader
inside `serve()` reads them without modification.

## v0 scope and gaps

Per [centraid#131](https://github.com/srikanth235/centraid/issues/131),
the daemon ships intentionally narrow:

- Single shared bearer token (no per-device tokens, no revocation list).
- No TLS terminator. Bind loopback for same-machine use; for LAN, trust
  the network or front with Caddy / Tailscale Funnel / Cloudflare Tunnel.
- Provider API key stored as plaintext at mode `0o600` under `<dataDir>`.
  No OS keychain integration on the daemon side — the Electron embed
  still uses `safeStorage`.
- No mDNS / Bonjour discovery; paste URL + token only.
- Single user. Multi-user identity is a much larger design (whose
  AGENTS.md? whose `~/.codex`?) and lands separately.
- No daemon auto-update. Bumping the gateway is `git pull` + `bun
  install` + restart, by design.

These build cleanly on top of the slice this package lands — no further
`runtime-core` API changes are needed.

## Tests

```sh
bun run test
```

Covers:

- `serve.test.ts` — boot, bearer auth, the `runnerStatus` route.
- `cli.test.ts` — config validation, prefs-patch shape, token mint/read,
  filesystem secrets round-trip, end-to-end CLI spawn + SIGTERM.
- `serve-multiclient.test.ts` — two HTTP clients against the same
  daemon: one uploads an app, the other lists + static-serves it.
