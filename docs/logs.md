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

- `packages/server/src/paths.ts` — `logsDir`
- `packages/server/src/cli/paths.ts` — daemon `gateway-logs/`
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
| Diagnostics bundle | `GET /centraid/_gateway/diagnostics` → `config.commons` | Every mounted vault's `CommonsVaultObservability[]` (`packages/server/src/serve/commons-observability.ts`), assembled in `build-gateway.ts`'s `buildDiagnostics` closure. |
| Owner-tier recovery door | `GET /centraid/_gateway/commons/recovery?actorVaultId=…` | The same per-grant observability, scoped to one vault (`packages/server/src/routes/commons-recovery-routes.ts`). |
| Peer-plane sweep log | wherever `logger.warn` lands (see "Gateway process logs" above) | One line per pull whose steward status is `degraded`, `absent`, `link-down`, or `parked` — `commons steward <presence> for grant <id> (member <vaultId>, steward <vaultId>) — silent <ms>ms, <n> consecutive failures` (or `fault <tag>` when parked). Emitted by `logStewardConcern` in `packages/server/src/serve/peer-commons-sweep.ts`; `reachable`/`unknown` pulls stay silent. |

Each grant's entry carries: `steward` (the escalating presence + silence duration), `reachableRatio` (contacts / attempts), `absence` (episode count, total/longest/open duration), `pullOutcomes` (noop/tail/snapshot/tombstone/parked/unreachable counts), `opLog` (row count, last/checkpoint sequence, rows beyond checkpoint — the first go/no-go number in the [Commons decision](decisions.md#commons)), `memberLag` (member count, max/p50 ops behind, count beyond the K=256 window — the second go/no-go number), and `intentDwellMs` (parked-intent submitted→settled latency).

## Traces and work counters (#927)

The product measures itself: every hop of a user action — seat → tunnel → gateway → handler → SQLite → commit → SSE → apply → render — emits a span, and the journey budgets are queries over those spans, so a regression says _where_ and not only _whether_. The shared contract is `packages/core/src/protocol/trace.ts` (`TraceSpan`, `TraceRecord`, `WorkCounters`, `validateTraceRecord`, `waterfall`), imported by every emitter and every consumer so there is exactly one format.

**Sovereign and local-only.** A trace never leaves the machine that produced it. There is no telemetry endpoint, no sampling service, no opt-in upload — the store is part of the owner's own diagnostics under their vault directory, so it is backed up, moved and **purged with the vault** like any other vault content. Nothing in the trace path writes to a network socket; a span that reached one would be a security bug, not a configuration mistake.

| Property | How it holds |
| --- | --- |
| Never egressed | The record type is not part of any wire schema; no route serves it and no client posts it. |
| Purged with the vault | The store lives under the vault's diagnostics, so deleting the vault deletes the traces. |
| Bounded cost | Spans are **off by default** and sampled (`TraceSamplingPolicy`, `shouldSample`); only the integer work counters are always on. |
| Deterministic unit | `WorkCounters` — statements, rows scanned, fsyncs, bytes read/written, worker spawns, HTTP round trips, invalidations, re-reads — integers, so the merge rung compares them with no flake, no retry and no history. |

A trace id is not a new identifier: for a write it **is** the replica intent id (`traceIdOfIntent`), so the outbox row and the waterfall join without a lookup table; a read has no intent and mints one at the seat (`mintTraceId`).

**Reading the last tap's waterfall.** `centraid-gateway trace last` prints the most recent trace on this machine as a nested waterfall (each row: hop, name, offset from the root, duration, depth), rendered from the pure `waterfall()` helper the rigs also use. It is a developer tool on the owner's own machine, not product surface. _Lands in #927 w1-gateway_ — the contract in `packages/core` is here now, the command and the store that backs it arrive with the gateway emitter slice.

## What is not a log

| Path | Role |
| --- | --- |
| `vault.db` | Data plus the audit and ledger bands — query with tools, do not treat as greppable logs |
| `gateway.db` preferences / settings | Config ([config-ownership.md](config-ownership.md)) |
| Browser devtools console | Ephemeral client noise; useful but not canonical |

## Related

- [ARCHITECTURE.md](../ARCHITECTURE.md) — on-disk layout
- [recovery/](recovery/) — mid-flight recovery
- [AGENTS.md](../AGENTS.md) — pointer for agents
