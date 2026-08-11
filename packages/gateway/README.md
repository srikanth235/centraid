# @centraid/gateway

Host-agnostic centraid gateway. `buildGateway()` wires [`@centraid/app-engine`](../app-engine) + [`@centraid/agent-runtime`](../agent-runtime) + stores + a conversation runner + an in-process cron scheduler against injected paths, and `serve()` starts an HTTP server in front of it.

Two hosts mount the same core:

| Host | Paths come from | Loopback bearer | App-code backend |
| --- | --- | --- | --- |
| [`@centraid/desktop`](../../apps/desktop) controller | shared platform-default `dataDir` | per-launch host bearer (in-memory) | git store |
| `centraid-gateway` CLI (this package) | the same platform default, a JSON config, or `--data-dir` | custody-derived loopback bearer; optional parent-supplied override | legacy tarball upload |

No new wire protocol — every host serves the same `/centraid/*`, `/_centraid-conversations/*`, and `/_centraid-user/*` routes, so desktop and mobile clients reach any of them through their existing remote-gateway flow.

## `serve()` — library entry

```ts
import { serve } from "@centraid/gateway";

const handle = await serve({
  paths: {
    dataDir: "/var/lib/centraid",
    vaultDir: "/var/lib/centraid/vault",
    cacheDir: "/var/lib/centraid/cache",
    modelCatalogFile: "/var/lib/centraid/cache/model-catalog.json",
  },
  host: "127.0.0.1",
  port: 8765,
});
console.log(handle.url, handle.token);
```

There is no bootstrap option to pass (issue #603 removed `initVaultName`). If `vaultDir` holds no vault, `buildGateway()` **auto-founds** two — `Shared` (created first) and `Personal` (marked as the registry default) — synchronously at construction, and enrols the host device as `admin` on both. If it already holds vault directories, nothing is created and the data dir is left exactly as found; a directory that fails to mount still counts, so corruption can never make an existing gateway look fresh.

`paths` is the only required option (see `GatewayPaths` in `src/paths.ts`); `vaultDir` is its required field. Post-#280 the vault is the unit — everything personal (apps, code, conversation ledger, run history) lives inside `<vaultDir>/<vaultId>/`; gateway-level preferences, enrollments, tickets, and backup/storage state live in `gateway.db`, while disposable catalogs live under `cache/`. There is no `identity.sqlite` or `analytics.sqlite`: the vault owner IS the user, and the run rollup is now the `run_summary` view inside each vault's `journal.db`. There is no `secrets` injection: the gateway is auth-agnostic about the coding agent — codex and Claude Code each own their own auth (`codex login` / `claude login` on the gateway host). Supply `appsStoreRoot` to opt into the git store backend (the desktop does); omit it for the legacy tarball-upload backend (what the standalone CLI below uses).

## `centraid-gateway` CLI — standalone daemon

```sh
# Boot. A fresh --data-dir auto-founds `Shared` + `Personal` (issue #603);
# an existing one is never modified.
centraid-gateway serve --data-dir /var/lib/centraid --port 8765

# Mint a pair ticket from the running daemon. No --vault → the registry
# default, which is the owner's `Personal` vault.
centraid-gateway pair --data-dir /var/lib/centraid
centraid-gateway pair --data-dir /var/lib/centraid --vault <name>
```

The loopback bearer is **derived from custody, not minted per boot** (issue #568 item J corrects the earlier #505 description): it is `HMAC(endpoint-key.bin, "centraid/landlord-http/v1")`, stable for the life of the gateway's endpoint identity, never written to disk as a token and never printed. Any local process that can open the gateway's `KeyStore` — the admin CLI included — derives the same value, so **nothing needs to be pinned**.

`CENTRAID_GATEWAY_TOKEN` exists for a parent process that **spawns** the daemon and must know the bearer without deriving it (the desktop does this). Pinning it and then running `centraid-gateway pair` from a shell without the same value makes the daemon reject the CLI's derived bearer; `pair` reports that as an explicit bearer-mismatch error (issue #603). See [docs/dev-environment.md](../../docs/dev-environment.md).

Bind defaults to loopback. Remote devices use the iroh endpoint; the HTTP listener is host-local control/data plumbing. `serve` flags override the config file.

### Pointing the desktop at the daemon

There is **no** URL + admin-token paste and no direct transport tier. In **Settings → Gateways → Add gateway**, paste a one-time pairing ticket from `centraid-gateway pair`. The ticket dials the iroh endpoint, and the successful response records the gateway's stable EndpointId; its relay/address ticket is only refreshable cache.

Switch to that gateway. The home shelf, chat panel, automations, and Insights screen all work — the daemon is just another host behind its own per-device enrollment.

Mobile is identical: pair with a ticket. The phone never needs codex / Claude Code installed locally — the harness runs on the daemon host.

### Config file

```json
{
  "dataDir": "/var/lib/centraid",
  "host": "127.0.0.1",
  "port": 8765,
  "harness": {
    "kind": "codex",
    "binPath": "/opt/homebrew/bin/codex",
    "extraArgs": ["--model", "<model-id>"]
  }
}
```

```sh
centraid-gateway serve --config /etc/centraid-gateway.json
```

Every field is optional except `dataDir` (see `validateConfig` in `src/cli/config.ts`). The `harness` block seeds the `prefs` table in `gateway.db` (`agent.harness.kind` / `binPath` / `extraArgs`), so the per-turn prefs loader inside `serve()` reads it unchanged; removing the block on a later boot clears those prefs. (#280 killed the old `identity.sqlite` — the vault owner is the user, so what's left at the gateway level is device configuration.) There is **no** `provider` block and no provider-key file — model/provider routing is the coding agent CLI's own config.

## Daemon `<dataDir>` layout

Desktop, the CLI, and the OS service use this identical shape (see `daemonLayoutFor` in `src/cli/paths.ts`):

```
<dataDir>/
  gateway.db             — control state and the kernel-held exclusive process lock
  keys/                  — wrapped KeyStore envelopes (endpoint, keyring, credentials, DEKs)
  cache/                 — disposable model/template/code-bundle/harness cache
  gateway-logs/          — diagnostic JSONL logs
  vault/                 — vault registry root: one subdirectory per vault
    <vaultId>/
      vault.db           — the ontology schemas (one ACID boundary)
      journal.db         — audit stream + conversation ledger + run_summary view
      apps/              — per-app DATA (logs, settings, attachment blobs)
      code/              — app code git store (apps.git + worktrees/)
```

`vault/` contains content only. Backups are provider snapshots plus the passphrase-wrapped recovery kit; copying a live SQLite/WAL tree is not a backup. The run rollup that feeds Insights is the `run_summary` VIEW inside `journal.db`, not a separate file.

## v0 scope and gaps

Per [centraid#131](https://github.com/srikanth235/centraid/issues/131), the daemon ships intentionally narrow:

- No shared admin token or per-device HTTP token. The loopback host bearer is custody-derived and stable for the gateway endpoint identity, while remote requests authenticate as real iroh EndpointId enrollments in a specific vault.
- No direct/LAN URL transport or TLS terminator. Remote access is iroh-only.
- No mDNS / Bonjour discovery; pair with a one-time ticket.
- Single user. Multi-user identity is a larger design and lands separately.
- No daemon auto-update. Bumping the gateway is `git pull` + `bun install` + restart, by design.
- The CLI daemon runs the **legacy tarball-upload** code backend (no `appsStoreRoot`), so it has no draft worktree and uses the data-only chat runner rather than the unified builder chat the desktop gets.

## Tests

```sh
bun run test
```

Covers:

- `serve.test.ts` — boot, loopback bind + derived bearer auth, the `GET /centraid/_turn/harness-status` and `GET /centraid/_agents/status` routes.
- `cli.test.ts` — config validation, prefs-patch shape, and an end-to-end CLI spawn that authenticates with a parent-supplied `CENTRAID_GATEWAY_TOKEN` loopback secret (never printed), then SIGTERM.
- `serve-multiclient.test.ts` — two HTTP clients against the same daemon: one publishes an app, the other lists + static-serves it.
