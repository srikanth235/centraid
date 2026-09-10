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

## Seat (replica) doors

One line per answer from the seat doors, in the gateway log ring above ([#1011](https://github.com/srikanth235/centraid/issues/1011)):

| Line | Emitted by |
| --- | --- |
| `seat log page for <vaultId>: since <seq>, <n> rows, next <seq>, watermark <seq>, hasMore <bool>` | `packages/server/src/routes/seat-routes.ts` |
| `seat snapshot for <vaultId>: seq <seq>, <bytes> bytes, GET\|HEAD` | same |

Absence is the signal: a phone with an empty copy and NO `seat log page` lines never asked. The device-side counterpart lines and the two rows to compare are in [mobile-offline.md](mobile-offline.md#the-seat-is-stale-how-to-tell).

## Camera-roll import device rungs

The phone is the ONLY producer of display rungs for HEVC-coded HEIC (the gateway codec declines it — [photos/derived-ledger.md](photos/derived-ledger.md)), and the contribution is never fatal to the import. So its failures are swallowed by contract; they are not silent. In the Metro / device console, one line per still the phone rendered rungs for ([#1011](https://github.com/srikanth235/centraid/issues/1011)):

| Line | Means |
| --- | --- |
| `[centraid] import: device rungs landed for <filename> — thumb, preview, phash, thumbhash` | The variant door took every rung, before the publish claimed the original. |
| `[centraid] import: device rungs skipped for <filename> — could not render on device: <reason>` | Nothing was sent: the device imaging stack refused. |
| `[centraid] import: device rungs skipped for <filename> — contribution failed: <reason>` | Rendered, but the variant POST was refused — the HTTP status is in the reason. |

Both `skipped` lines mean the item stays exactly as backfillable as it was, and the gateway will stamp it `preview-codec@1` unsupported until a sweep or a re-import. Emitted by `contributeDeviceRungs` in `apps/mobile/src/apps/photos/camera-roll-import-run.ts`. Absence of all three for an HEIC still means the rung branch was never entered — check the candidate's filename extension, which is what routes it.

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

**Where the records live.** `<vaultDir>/<vaultId>/diagnostics/traces.jsonl`, one JSON record per line, rotated once at 2 MB. Inside the vault directory on purpose: `VaultRegistry.delete` removes that directory whole, so purge-with-vault is a property of the location and not of a sweeper anyone has to remember to run. Writes are best-effort and swallow their failures — a diagnostics record must never be the thing that fails a request — and a torn trailing line from a process that died mid-append is skipped by the reader, not fatal.

**Turning spans on.** They are **off in every shipped build**. `CENTRAID_TRACE=1` enables them for a gateway process; `CENTRAID_TRACE_SAMPLE_EVERY=N` records one action in N (deterministic in the action counter, not random, so two runs of a rig sample the same actions). The work counters underneath are not affected by this switch — they are always on and cost single-digit percent.

**Where the numbers come from.**

| Counter | Seam |
| --- | --- |
| `statements`, `rowsScanned`, `bytesRead`, `bytesWritten`, `fsyncs` | `packages/vault/src/gateway/work-counters.ts`, attached to the vault's one SQLite handle at `createGateway`. `fsyncs` counts **durability barriers** — `COMMIT`/`END` and WAL checkpoints, the statements that make SQLite sync — so the integer is a property of the product's own behaviour rather than of `strace` and a platform. `bytesRead`/`bytesWritten` are payload bytes: what a statement materialized out of SQLite, and what it bound into it. |
| `workerSpawns` | `packages/server/src/engine/handlers/work-counters.ts`, bumped in `WorkerPool.spawn()` — the one place a handler thread is created. A second registry on purpose: the engine must not import `@centraid/vault`, and `addCounters` is the contract's answer for summing them. |
| `httpRoundTrips`, `invalidations`, `reReads` | `packages/client/src/replica/work-counters.ts` — the seat's registry (a third, because this code runs in a browser, a worker and on Hermes). `httpRoundTrips` is bumped inside `shell-transport.ts`'s one transport seam, so an injected fetcher counts exactly like the default. **`invalidations` and `reReads` have no writer.** They were bumped by `LiveQueryRegistry` and `LiveQuery`, whose last consumer went with the old replica plane ([#996](https://github.com/srikanth235/centraid/issues/996)); a screen is now notified by the applier's `(table, pk)` sets per batch (R9). Both counters therefore read zero, and whether two protocol counters that can only read zero are deleted is a `packages/core` protocol decision open to the owner. |

**On a phone, spans are a ring buffer.** A phone has no gateway process to append to and no business doing disk I/O on a scroll, so the mobile seat buffers records in a bounded in-memory ring (`ClientTraceRing`) and writes them to `<replicaStorage>/diagnostics/traces.jsonl` at two moments only: the background sync pass (`runBackgroundReplicaSync`'s `finally`, so a pass that timed out still lands what it recorded) and the developer command. If the OS kills the app first the ring is lost — a diagnostics buffer, not evidence. `EXPO_PUBLIC_CENTRAID_TRACE=1` turns it on; Hermes has no `crypto.randomUUID`, so the mobile tracer is built with `nativeReplicaIdFactory` rather than the contract's web default. See [mobile-offline.md](mobile-offline.md).

**The gateway's per-request timing seam is this one and only this one.** `serve.ts` wraps the composed handler in `traceRequests` (`packages/server/src/serve/gateway-trace.ts`); `route-latency.ts` keeps aggregate per-route histograms for health, which answers "how slow is this route across many requests" and cannot answer "where did THIS request spend its milliseconds". #922's per-request gateway phase timing is absorbed here by ruling: do not add a second instrument beside it.

**Reading the last tap's waterfall.** `centraid-gateway trace last` prints the most recent trace on this machine as a nested waterfall (each row: hop, name, offset from the root, duration, depth), rendered from the pure `waterfall()` helper the rigs also use. It is a developer tool on the owner's own machine, not product surface: it opens no socket, contacts no daemon, and there is no route that would serve the file. `--vault-dir <path>` reads one vault; with none given it takes the most recently written trace file under the registry root, so "the last tap" means the last tap on this machine. `--json` hands back the record for a rig; `--clear` empties the store after printing. A machine with no records prints how to turn spans on rather than an empty table.

**The merge rung reads counters, not clocks.** `bun run test:perf:counters` (ci.yml, job `verify`) runs a fixed workload against the golden year-3 vault and compares the integers to `scripts/ci/work-counters.expected.json` — tighten-only, no retry step, no history, no `strace`. A seeded extra statement or durability barrier on a hot path fails it on the first run. The wall-clock rig (`bun run test:perf:pr`) still exists and still answers its own question, latency under a constrained hardware profile; it is simply not on the merge rung any more.

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
