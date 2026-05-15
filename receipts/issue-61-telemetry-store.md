# issue-61 — shared telemetry store for user-app observability

GitHub issue: [#61](https://github.com/srikanth235/centraid/issues/61)

## Checklist

- [x] TelemetryWriter interface in runtime-core
- [x] TelemetryStore SQLite implementation with spans, events, app_settings
- [x] TTL via per-row expires_at with level/status defaults
- [x] Hourly bounded sweeper with incremental_vacuum
- [x] Write protection: per-invocation count cap, byte cap, token-bucket admission, single transaction
- [x] Per-app settings with in-memory cache
- [x] HTTP routes for events and settings
- [x] handler-runner integration with W3C trace IDs and batched record at finish
- [x] Runtime plumbing through query/action/cron and deregister cleanup
- [x] handleLogsRoute reads from telemetry with jsonl fallback
- [x] Wired in openclaw-plugin and desktop local-runtime
- [x] 14 unit tests in telemetry-store.test.ts

## What changed

**TelemetryWriter interface in runtime-core.** New `telemetry.ts` defines the contract the runtime needs from a host-supplied telemetry sink: `recordHandler(span+events)`, `readEvents(appId, opts)`, `deleteApp(appId)`, `getAppSettings(appId)`, `setAppSettings(appId, patch)`. The runtime owns no SQLite — the host injects an implementation. Public types (`TelemetrySpanRecord`, `TelemetryEvent`, `TelemetryReadEntry`, `TelemetryAppSettings`, `TelemetryAppSettingsPatch`, level/kind/status string unions) re-exported through the package root.

**TelemetryStore SQLite implementation with spans, events, app_settings.** Implementation split across `telemetry-store.ts` (class), `telemetry-helpers.ts` (pure functions, schema SQL, constants), `telemetry-routes.ts` (HTTP handler) to stay under the per-file line cap. Schema: `spans(span_id, trace_id, parent_id, app_id, kind, handler, started_at, duration_ms, status, error, expires_at)`, `events(id, app_id, ts, trace_id, span_id, level, source, handler, msg, expires_at)`, `app_settings(app_id, enabled, min_level, overrides_json, updated_at)`. Indexes on `(app_id, ts DESC)` / `(app_id, started_at DESC)`, `expires_at`, `trace_id`, plus composite `(app_id, level, ts DESC)` for the level-filtered read path. Mirrors the chat-history layout: one file (`centraid-telemetry.sqlite`) sibling to `apps/`, not inside any app's `data.sqlite`, so telemetry is unreachable from the agent's `centraid_sql_*` tools and doesn't fan out across N app DBs.

**TTL via per-row expires_at with level/status defaults.** Each row stamps `expires_at` at insert time. Defaults: 7d info / 14d warn / 30d error events, 7d ok / 30d error spans. Sweeper just does `DELETE WHERE expires_at < now` — no per-app cursor needed.

**Hourly bounded sweeper with incremental_vacuum.** `setInterval` running once an hour executes `DELETE … LIMIT 5000` in a loop until each statement reports 0 changes, then `PRAGMA incremental_vacuum(1000)` so the SQLite page count actually shrinks on disk. `auto_vacuum = INCREMENTAL` is applied to the connection *before* the first `CREATE TABLE` — SQLite ignores the pragma on an existing DB without an explicit `VACUUM`, and that subtlety is called out in the constructor comment.

**Write protection: per-invocation count cap, byte cap, token-bucket admission, single transaction.** Four layers so a runaway `log.info` in a user handler can never crash the writer. (1) Per-invocation event count cap of 500 with a synthesized warn-level "events truncated" marker preserving the last event's timestamp. (2) Per-event byte cap of 8 KiB — byte-safe UTF-8 truncation that trims trailing U+FFFD chars from the multi-byte boundary so an emoji can't sneak past the cap. (3) Token-bucket admission limiting spans to 200 records per second; excess records are silently dropped with at most one `console.warn` per minute summarizing the drop count. (4) One `BEGIN IMMEDIATE … COMMIT` per invocation, so the write lock is never held across handler boundaries; SQLITE_BUSY causes a drop, never a block.

**Per-app settings with in-memory cache.** Three knobs in `app_settings`: `enabled` (default true; when false drops both span and events before admission), `minLevel` (`info` | `warn` | `error`; events below threshold filtered before write, but spans always written when enabled so failure-rate metrics survive), `retentionDaysOverrides` (per-bucket TTL override in days, applied at insert so the sweeper picks them up automatically). Cache is an in-process `Map<appId, settings>` invalidated synchronously on `setAppSettings` / `deleteApp` so the per-invocation lookup is a hash-get, not a SELECT. `deleteApp` drops spans + events + the settings row in one transaction so a deregister/reregister starts at defaults.

**HTTP routes for events and settings.** `GET /_centraid-telemetry/events?appId=&limit=&sinceTs=&level=`, `GET /_centraid-telemetry/settings?appId=`, `PUT /_centraid-telemetry/settings` (body `{appId, enabled?, minLevel?, retentionDaysOverrides?}`). Event writes happen in-process via the writer interface — no public write endpoint, because invoking a handler is the legitimate way to produce telemetry. Settings PUT is the one exception, since per-app controls are a user-facing knob.

**handler-runner integration with W3C trace IDs and batched record at finish.** Each invocation generates a fresh 32-hex `trace_id` and 16-hex `span_id` (W3C-compatible — future correlation with browser-side or external spans won't need a migration), tracks `startedAt`, and buffers events in an in-memory cap of 1000 (synthesizing a warn marker on overflow before the writer's caps kick in). At `finish()` the runner makes one fire-and-forget `recordHandler` call carrying the span + events; errors in the writer are swallowed because handler response latency must not depend on telemetry persistence. When no writer is wired, falls back to the legacy `appendLogs` path.

**Runtime plumbing through query/action/cron and deregister cleanup.** `RuntimeOptions` gains optional `telemetry?: TelemetryWriter`; threaded through all three `runHandler` call sites (`app-data` query, `app-run` action, `app-ingest` cron via `routeContext.telemetry`). `registry-deregister` calls `telemetry.deleteApp(appId)` after the existing registry-side cleanup, with the failure logged but non-fatal.

**handleLogsRoute reads from telemetry with jsonl fallback.** `/centraid/apps/:id/logs` checks for an injected writer and reads via `telemetry.readEvents` when available, falling back to the original `log-store.ts` jsonl reader. The desktop's existing Logs panel polls this route and keeps working unchanged.

**Wired in openclaw-plugin and desktop local-runtime.** The plugin uses the lazy-proxy pattern from chat-history.ts: a `TelemetryWriter` whose methods open SQLite on first call, so `register()` running in agent-worker contexts (where Runtime never executes handlers) doesn't hold stray DB handles. The desktop's `local-runtime.ts` constructs a `TelemetryStore` eagerly (single-process, no worker problem) sibling to its `apps/` directory under `app.getPath('userData')`.

**14 unit tests in telemetry-store.test.ts.** Covering: write/read round-trip with newest-first ordering, level + sinceTs filters, limit + hard cap behavior, deleteApp scope, byte-cap UTF-8 truncation, count-cap truncation marker, sweep + TTL with a 31-day-old span removed and a fresh one kept, settings defaults / merge / disabled-app drop / minLevel filter / retentionDaysOverrides shortening TTL, deleteApp also clearing settings, and token-bucket admission with a fixed clock proving over-limit records are dropped (not queued) and that admission resumes after the window rolls.

## Out of scope

- Desktop UI exposure of the per-app settings — the Cloud panel still calls the existing `appLogs` IPC. A settings sub-panel calling `Api().telemetrySettings(...)` against `/_centraid-telemetry/settings` is the obvious follow-up.
- Removing the legacy `log-store.ts` jsonl path. Kept as a fallback so hosts not yet injecting a writer still serve `/centraid/apps/:id/logs` — should be removed once both hosts in the monorepo are confirmed migrated.
- Cron-scheduled sweep instead of `setInterval`. The Scheduler interface is generic enough that registering a sweep job would be cleaner, but it adds plumbing the in-tree hosts don't need today.
- Span-level reads from the HTTP surface (`GET /_centraid-telemetry/spans` for a traces UI). Schema + indexes are ready; not exposed yet because there's no consumer.
- OTel exporter. The data model uses W3C trace IDs so a custom `SpanExporter` could be added later, but the value at <10 users doesn't justify the dependency surface.

## Review fixes

- **P2 — reserved slot for truncation marker.** The earlier code dropped its own "events dropped" warning once the in-memory buffer was full: at `events.length >= MAX_EVENTS_BUFFERED`, `recordEvent('warn', …)` would itself be dropped. Reserved one slot (`USER_EVENT_CAP = MAX - 1`) for user events and added `recordMarker()` which bypasses the cap, so `finish()` can always append the synthesized warning. Invariant documented inline at the helper.
- **P1 — change-tracking + telemetry coexist after rebase.** `handler-runner.ts` now keeps both paths intact: `tracker = trackChanges(db)` setup, `tracker.extract()` snapshot before `db.close()` for the `onWrite(tables)` SSE feed, AND the W3C trace_id / span_id / events buffering for `telemetry.recordHandler(...)`. Threaded `onWrite` + `telemetry` through `RouteContext` and the three direct `runHandler` call sites in `runtime.ts`.

## Verification

- `bun run typecheck` is clean across all 14 packages.
- `bun run lint` is clean (oxlint).
- `bun run format` is clean (oxfmt).
- `bun run test` is clean — runtime-core gains 14 telemetry tests (87 total in runtime-core; plugin tests unchanged at 47).
- Per-file line cap satisfied: telemetry-store.ts at 461 lines, telemetry-helpers.ts at 173, telemetry-routes.ts at 149, telemetry.ts at 125 (governance limit: 500).
