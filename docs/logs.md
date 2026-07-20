# Canonical log locations (F5)

Every debugging session (human or agent) starts here. Do not invent alternate paths in issues or skills.

## Gateway process logs (first stop)

JSONL rotation of the gateway log ring (survives restart — issue #351).

| Host | Path |
| --- | --- |
| **Desktop embedded / supervised local gateway** | `<Electron userData>/gateways/local/gateway-logs/` |
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
| On FAIL, workspace kept | `…/runs/<runId>/workspace/…` (`devices.json`, `pairing-tickets.json`, `endpoint.json`) |

## CI

- Job logs on GitHub Actions (collapsible groups when E4 lands).
- Uploaded artifacts: Playwright traces/screenshots, test-health report under `dist/test-report/` / workflow artifacts.
- Public report (main/nightly): see [TESTING.md](../TESTING.md).

## What is not a log

| Path | Role |
| --- | --- |
| `vault.db` / `journal.db` | Data + audit/ledger — query with tools, do not treat as greppable logs |
| `prefs.json` / settings JSON | Config ([config-ownership.md](config-ownership.md)) |
| Browser devtools console | Ephemeral client noise; useful but not canonical |

## Related

- [ARCHITECTURE.md](../ARCHITECTURE.md) — on-disk layout
- [recovery/](recovery/) — mid-flight recovery
- [AGENTS.md](../AGENTS.md) — pointer for agents
