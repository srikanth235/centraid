# Canonical log locations (F5)

Every debugging session (human or agent) starts here. Do not invent alternate paths in issues or skills.

## Gateway process logs (first stop)

JSONL rotation of the gateway log ring (survives restart — issue #351).

| Host | Path |
| --- | --- |
| **Desktop local gateway** | `<Electron userData>/gateways/local/gateway-logs/` |
| **Other desktop gateways** | `<Electron userData>/gateways/<id>/gateway-logs/` |
| **Daemon (`centraid-gateway`)** | `<dataDir>/gateway-logs/` |

`userData` on macOS is typically `~/Library/Application Support/Centraid` (exact product name follows the Electron `name` / build). Daemon `dataDir` is whatever was passed to `serve --data-dir`.

Also redirected by OS service units (when H5 installed): stdout/stderr paths from `centraid-gateway service install` (see unit files under `~/Library/LaunchAgents/dev.centraid.gateway.plist` or `~/.config/systemd/user/centraid-gateway.service`).

Code pointers:

- `packages/gateway/src/paths.ts` — `logsDir`
- `packages/gateway/src/cli/paths.ts` — daemon `gateway-logs/`
- `apps/desktop/src/main/local-gateway.ts` — desktop `logsDir` wiring

## Desktop crash log

| Path | Contents |
| --- | --- |
| `<userData>/` crash log file (see `apps/desktop/src/main/crash-log.ts`) | Main-process exceptions |

Note: renderer/GPU crash coverage is still incomplete (issue #468 K12) — do not assume this file catches UI-only failures.

## Pairing / e2e workspaces

| Context | Path |
| --- | --- |
| Agent pairing e2e run | `tests/agent-e2e-pairing/runs/<runId>/gateway.log` |
| On FAIL, workspace kept | `…/runs/<runId>/workspace/…` (`gateway.db`, `keys/`, `vault/`) |

## CI

- Job logs on GitHub Actions (collapsible groups when E4 lands).
- Uploaded artifacts: Playwright traces/screenshots, test-health report under `dist/test-report/` / workflow artifacts.
- Public report (main/nightly): see [TESTING.md](../TESTING.md).

## Centraid Assist Worker

Cloudflare Analytics Engine dataset `centraid_oauth` is the canonical Assist edge signal. It stores only route, outcome, HTTP status, and count. The Worker emits no console events.

Keep Workers Logs, invocation logs, and automatic traces disabled for `oauth.centraid.dev`: callback query strings contain authorization code/state, and automatic traces retain full URLs. Any zone Logpush dataset must omit or redact query strings, headers, and request bodies. Never paste a raw start/bind/callback/exchange/refresh request into a ticket. Failure-ratio/429/5xx alert setup and incident handling are in [recovery/oauth-assist.md](recovery/oauth-assist.md).

## Commons sync observability (#731)

Steward-absence detection and local Commons sync instrumentation — no network egress, no new telemetry system, three tables in the device's own `vault.db`.

| Surface | Path | Contents |
| --- | --- | --- |
| Diagnostics bundle | `GET /centraid/_gateway/diagnostics` → `config.commons` | Every mounted vault's `CommonsVaultObservability[]` (`packages/gateway/src/serve/commons-observability.ts`), assembled in `build-gateway.ts`'s `buildDiagnostics` closure. |
| Owner-tier recovery door | `GET /centraid/_gateway/commons/recovery?actorVaultId=…` | The same per-grant observability, scoped to one vault (`packages/gateway/src/routes/commons-recovery-routes.ts`). |
| Peer-plane sweep log | wherever `logger.warn` lands (see "Gateway process logs" above) | One line per pull whose steward status is `degraded`, `absent`, `link-down`, or `parked` — `commons steward <presence> for grant <id> (member <vaultId>, steward <vaultId>) — silent <ms>ms, <n> consecutive failures` (or `fault <tag>` when parked). Emitted by `logStewardConcern` in `packages/gateway/src/serve/peer-commons-sweep.ts`; `reachable`/`unknown` pulls stay silent. |

Each grant's entry carries: `steward` (the escalating presence + silence duration), `reachableRatio` (contacts / attempts), `absence` (episode count, total/longest/open duration), `pullOutcomes` (noop/tail/snapshot/tombstone/parked/unreachable counts), `opLog` (row count, last/checkpoint sequence, rows beyond checkpoint — the fixed-window-sync plan's first go/no-go number, see [docs/plans/commons-fixed-window-sync.md](plans/commons-fixed-window-sync.md)), `memberLag` (member count, max/p50 ops behind, count beyond the K=256 window — the plan's second go/no-go number), and `intentDwellMs` (parked-intent submitted→settled latency).

## What is not a log

| Path | Role |
| --- | --- |
| `vault.db` / `journal.db` | Data + audit/ledger — query with tools, do not treat as greppable logs |
| `gateway.db` preferences / settings | Config ([config-ownership.md](config-ownership.md)) |
| Browser devtools console | Ephemeral client noise; useful but not canonical |

## Related

- [ARCHITECTURE.md](../ARCHITECTURE.md) — on-disk layout
- [recovery/](recovery/) — mid-flight recovery
- [AGENTS.md](../AGENTS.md) — pointer for agents
