# issue-38 — Decouple runtime from openclaw-plugin; embed locally in desktop

GitHub issue: [#38](https://github.com/srikanth235/centraid/issues/38)

## Checklist

- [x] New package `@centraid/runtime-core`
- [x] Transport-agnostic `Scheduler` seam
- [x] `startRuntimeHttpServer()`
- [x] `@centraid/openclaw-plugin` slimmed
- [x] Desktop embeds runtime-core
- [x] Settings split
- [x] `Runtime.handle()` split for the 500-line limit
- [x] `@centraid/agent-harness` types repointed
- [x] `bun run typecheck`
- [x] `bun run test`
- [x] `bun run check`
- [x] `bun run build`

## What changed

**New package `@centraid/runtime-core`.** Holds the centraid app-hosting engine — registry, version store, upload ingest, the `/centraid/...` URL surface, handler-runner, worker isolation, schema introspection, log store, and the cloud-routes (`_data`, `_table_rows`, `_logs`). Everything that was previously private to `@centraid/openclaw-plugin/src/lib/` moved here (git-mv preserved history). The `Runtime` class encapsulates these as fields and exposes a single `handle(req, res)` entry point.

**Transport-agnostic `Scheduler` seam.** runtime-core declares the `Scheduler` interface (`addJob`, `removeJob`, `listJobs`, `runJobNow`) plus `CronJobDefinition` / `CronJobSnapshot` / `CronChangedEvent` types. The runtime never schedules anything itself — it only emits cron job specs and receives ingest POSTs at `/centraid/<app>/_ingest/<cron>`. A `NullScheduler` impl accepts registrations and discards them, used as the local-mode default until embedded cron execution lands.

**`startRuntimeHttpServer()`.** New helper in runtime-core binds `127.0.0.1:0` with a per-launch random 32-byte hex bearer token (or a caller-provided one), enforces auth on every request except `POST /centraid/<app>/_ingest/<cron>` (gated separately by per-cron tokens + loopback check inside the runtime), and exposes `{ url, token, close() }`.

**`@centraid/openclaw-plugin` slimmed.** `src/index.ts` is now a thin shim that constructs a `Runtime`, wires `OpenClawScheduler` (the new `Scheduler` impl wrapping the gateway's `openclaw cron` handle), mounts `runtime.handle` under `/centraid` via `api.registerHttpRoute`, and forwards `gateway_start` → `runtime.bootstrap()` and `cron_changed` → `runtime.onCronChanged()`. All the engine internals that used to live in `openclaw-plugin/src/lib/` are gone from this package — they now live in runtime-core and are re-exported for back-compat. Net change in this file: ~537 lines → ~95 lines.

**Desktop embeds runtime-core.** `apps/desktop/src/main/local-runtime.ts` lazy-spawns the runtime + HTTP server inside the Electron main process the first time the renderer asks for its URL. Auth: the per-launch bearer minted by `startRuntimeHttpServer` is handed back to the renderer as the effective `gatewayToken` so the existing HTTP client uses it on every request — same wire format as remote OpenClaw mode. The chicken-and-egg `gatewayBaseUrl` problem (cron-sync needs the URL to construct webhook targets, but the URL isn't known until after `listen()`) is solved by `runtime.setGatewayBaseUrl(server.url)` called after the HTTP server binds and before `bootstrap()`.

**Settings split.** `PersistedSettings` (on-disk) is separate from `DesktopSettings` (effective, returned to renderer). New fields: `runtimeMode: 'local' | 'remote'`, `remoteGatewayUrl`, `remoteGatewayToken`, `remoteTemplatesUrl`. `migrate()` handles legacy JSON: if `gatewayToken` is set → `remote` mode, else `local`. `resolveEffective()`: in local mode, calls `ensureLocalRuntime()` and returns its url/token as `gatewayUrl`/`gatewayToken`; in remote mode, returns the persisted remote fields. The renderer toggles modes via a segmented control; remote URL/token inputs only render when remote is selected.

**`Runtime.handle()` split for the 500-line limit.** The `app-upload` and `app-ingest` route cases (the two largest, ~60 lines each) live in `src/route-handlers.ts` and take a `RouteContext`. Keeps runtime.ts at ~466 lines and concentrates the URL-switch in one readable place.

**`@centraid/agent-harness` types repointed.** The harness consumed type-only imports (`AppSchema`, `AppTableRows`, `RunQueryResult`, `LogEntry`, `LogLevel`) from `@centraid/openclaw-plugin`. Those types moved to runtime-core; harness imports updated accordingly. `@centraid/openclaw-plugin` still re-exports them for any external consumer.

## Files touched

**New (runtime-core package):**

- `packages/runtime-core/package.json`
- `packages/runtime-core/tsconfig.json`
- `packages/runtime-core/src/index.ts`
- `packages/runtime-core/src/runtime.ts`
- `packages/runtime-core/src/http-server.ts`
- `packages/runtime-core/src/http-server.test.ts`
- `packages/runtime-core/src/route-handlers.ts`
- `packages/runtime-core/src/scheduler.ts`
- `packages/runtime-core/src/null-scheduler.ts`

**Moved (openclaw-plugin/src/lib/* → runtime-core/src/*):**

- `app-paths.ts`, `cloud-routes.ts`, `cron-sync.ts`, `deregister-cleanup.{ts,test.ts}`, `handler-runner.ts`, `http-utils.ts`, `log-store.{ts,test.ts}`, `migrate.{ts,test.ts}`, `payload.ts`, `registry.ts`, `router.ts`, `run-query.{ts,test.ts}`, `schema.{ts,test.ts}`, `security.ts`, `static-server.ts`, `table-rows.{ts,test.ts}`, `types.ts`, `upload-lock.ts`, `upload.{ts,test.ts}`, `version-store.ts`, `worker/runner.ts`

**Modified:**

- `packages/openclaw-plugin/src/index.ts` (thin shim)
- `packages/openclaw-plugin/src/lib/openclaw-cron.ts` (`OpenClawCron` → `OpenClawScheduler`)
- `packages/openclaw-plugin/package.json` (deps)
- `packages/agent-harness/{package.json,src/index.ts,src/agent-session.ts,src/gateway-client.ts}` (type import paths)
- `apps/desktop/package.json` (deps)
- `apps/desktop/src/main/settings.ts` (rewrite for `runtimeMode`)
- `apps/desktop/src/renderer/app.ts` (Runtime settings section)
- `apps/desktop/src/renderer/centraid-api.d.ts` (`CentraidSettings` shape)
- `bun.lock`

**New (desktop):**

- `apps/desktop/src/main/local-runtime.ts`

## Verification

- `bun run typecheck` — 12 successful, 0 failed.
- `bun run test` — 8 successful (includes runtime-core's 73 tests, all green).
- `bun run check` — `oxfmt` + `oxlint` both clean.
- `bun run build` — 6 successful.
- Manual: not exercised end-to-end in this branch; the local-runtime embed should be exercised by running the desktop in local mode and clicking through registry/upload/data/run flows.

## Out of scope

- **Local cron execution.** The desktop in local mode currently uses `NullScheduler` — cron jobs registered by apps are silently discarded. A real local scheduler (likely backed by `croner` + an LLM runner) is the next backlog item.
- **OpenClaw SDK contract.** This refactor exposes the centraid-internal `/centraid/...` URL surface, not the public `@openclaw/sdk` wire protocol. A separate `@centraid/local-gateway` package will implement the SDK contract over a custom transport (HTTP+SSE) on top of runtime-core and route to Claude / OpenAI providers.
- **`OpenClawScheduler` v0.** The plugin's scheduler still drives crons through the `openclaw cron` CLI / SDK handle — unchanged from the prior code path; just renamed and adapted to the new `Scheduler` interface.
- **e2e tests for the local-runtime embed.** Existing desktop e2e tests cover the renderer/preload surface; they pass against the new settings shape. A dedicated test for the local-runtime HTTP server (bearer auth, ingest gating) lives in runtime-core (`http-server.test.ts`); a desktop-level integration test that boots the Electron main process against the embedded runtime is not in this branch.
