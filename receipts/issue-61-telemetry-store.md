# issue-61 — per-app telemetry store for user-app observability

GitHub issue: [#61](https://github.com/srikanth235/centraid/issues/61)

## Checklist

- [x] TelemetryWriter interface in runtime-core
- [x] Per-app TelemetryStore (one SQLite file per app) with spans, events, app_settings
- [x] LRU-cached connections (cap 16) with lazy open and read-side short-circuit
- [x] TTL via per-row expires_at with level/status defaults
- [x] Hourly bounded sweeper over open connections with incremental_vacuum
- [x] Write protection: per-invocation count cap, byte cap, per-app token-bucket admission, single transaction
- [x] Per-app settings stored in each app's own file (single-row table) with in-memory cache
- [x] HTTP routes for events and settings
- [x] handler-runner integration with W3C trace IDs and batched record at finish
- [x] Runtime plumbing through query/action/cron and deregister cleanup (telemetry before fs cleanup)
- [x] handleLogsRoute reads from telemetry with jsonl fallback
- [x] Wired in openclaw-plugin and desktop local-runtime
- [x] 19 unit tests in telemetry-store.test.ts

## What changed

**TelemetryWriter interface in runtime-core.** New `telemetry.ts` defines the contract the runtime needs from a host-supplied telemetry sink: `recordHandler(span+events)`, `readEvents(appId, opts)`, `deleteApp(appId)`, `getAppSettings(appId)`, `setAppSettings(appId, patch)`. The runtime owns no SQLite — the host injects an implementation. Public types (`TelemetrySpanRecord`, `TelemetryEvent`, `TelemetryReadEntry`, `TelemetryAppSettings`, `TelemetryAppSettingsPatch`, level/kind/status string unions) re-exported through the package root.

**Per-app TelemetryStore (one SQLite file per app) with spans, events, app_settings.** Implementation split across `telemetry-store.ts` (class, 499 lines), `telemetry-helpers.ts` (pure functions, schema SQL, constants, `prepareStmts`, `AppStmts`), `telemetry-routes.ts` (HTTP handler) to stay under the per-file line cap. Each app has its own `<appsDir>/<appId>/telemetry.sqlite`. The file IS the per-app scope, so neither `spans` nor `events` carries an `app_id` column, and `app_settings` is a single-row table with a `CHECK (id = 1)` constraint preventing a buggy upsert from inserting a second row. Schema: `spans(span_id, trace_id, parent_id, kind, handler, started_at, duration_ms, status, error, expires_at)`, `events(id, ts, trace_id, span_id, level, source, handler, msg, expires_at)`, `app_settings(id=1, enabled, min_level, overrides_json, updated_at)`. Indexes on `(started_at DESC)` / `(ts DESC)`, `expires_at`, `trace_id`, plus `(level, ts DESC)` for the level-filtered read path. Per-app sharding gives true isolation: a runaway handler in app A can never contend with reads of app B, `deleteApp` is a file unlink rather than a DELETE scan, and there's no cross-app composite index hot path.

**LRU-cached connections (cap 16) with lazy open and read-side short-circuit.** Connections are managed by an insertion-order `Map<appId, AppConn>` capped at `MAX_OPEN_APP_CONNS = 16`. `getOrOpen` promotes on access (delete + re-insert places the entry at the back); when size exceeds the cap, the front (least-recently-used) entry is evicted and its DB handle closed. Eviction never touches the on-disk file — subsequent calls reopen. Read paths (`readEvents`, `getAppSettings`) short-circuit to `[]` / defaults when the per-app file doesn't yet exist, so polling a never-active app doesn't materialize a spurious telemetry.sqlite or pin a connection. Write paths (`recordHandler`, `setAppSettings`) always open (and create the parent dir with `mkdirSync recursive`) because the act of writing IS the materialization.

**TTL via per-row expires_at with level/status defaults.** Each row stamps `expires_at` at insert time. Defaults: 7d info / 14d warn / 30d error events, 7d ok / 30d error spans. Sweeper just does `DELETE WHERE expires_at < now` against each open file — no per-app cursor needed.

**Hourly bounded sweeper over open connections with incremental_vacuum.** `setInterval` running once an hour iterates currently-open `AppConn` entries and runs `DELETE … LIMIT 5000` in a loop until each statement reports 0 changes per file, then `PRAGMA incremental_vacuum(1000)`. `auto_vacuum = INCREMENTAL` is applied to each connection *before* the first `CREATE TABLE` — SQLite ignores the pragma on an existing DB without an explicit `VACUUM`, and that subtlety is called out in the `getOrOpen` comment. Cold apps (no open conn) skip the sweep until their next access; at day-scale TTLs and <10 active users that's acceptable, and the trade-off is documented on `sweep()`.

**Write protection: per-invocation count cap, byte cap, per-app token-bucket admission, single transaction.** Four layers so a runaway `log.info` in a user handler can never crash the writer. (1) Per-invocation event count cap of 500 with a synthesized warn-level "events truncated" marker preserving the last event's timestamp. (2) Per-event byte cap of 8 KiB — byte-safe UTF-8 truncation that trims trailing U+FFFD chars from the multi-byte boundary so an emoji can't sneak past the cap. (3) Per-app token-bucket limiting spans to 200 records per second; the bucket lives on the `AppConn`, so a noisy app A can only starve itself — app B's writes are unaffected. Excess records are silently dropped with at most one `console.warn` per minute per app summarizing the drop count. (4) One `BEGIN IMMEDIATE … COMMIT` per invocation, so the write lock is never held across handler boundaries; SQLITE_BUSY causes a drop, never a block.

**Per-app settings stored in each app's own file (single-row table) with in-memory cache.** Three knobs in `app_settings`: `enabled` (default true; when false drops both span and events before admission), `minLevel` (`info` | `warn` | `error`; events below threshold filtered before write, but spans always written when enabled so failure-rate metrics survive), `retentionDaysOverrides` (per-bucket TTL override in days, applied at insert so the sweeper picks them up automatically). The settings table holds exactly one row (CHECK constraint), so `getSettings` is a parameterless prepared `WHERE id = 1` lookup. The cached `TelemetryAppSettings` lives on the `AppConn` itself — invalidation on `setAppSettings` is just an object assignment on the same conn, and eviction drops the cache along with the connection.

**HTTP routes for events and settings.** `GET /_centraid-telemetry/events?appId=&limit=&sinceTs=&level=`, `GET /_centraid-telemetry/settings?appId=`, `PUT /_centraid-telemetry/settings` (body `{appId, enabled?, minLevel?, retentionDaysOverrides?}`). Event writes happen in-process via the writer interface — no public write endpoint, because invoking a handler is the legitimate way to produce telemetry. Settings PUT is the one exception, since per-app controls are a user-facing knob.

**handler-runner integration with W3C trace IDs and batched record at finish.** Each invocation generates a fresh 32-hex `trace_id` and 16-hex `span_id` (W3C-compatible — future correlation with browser-side or external spans won't need a migration), tracks `startedAt`, and buffers events in an in-memory cap of 1000 (synthesizing a warn marker on overflow before the writer's caps kick in). At `finish()` the runner makes one fire-and-forget `recordHandler` call carrying the span + events; errors in the writer are swallowed because handler response latency must not depend on telemetry persistence. When no writer is wired, falls back to the legacy `appendLogs` path.

**Runtime plumbing through query/action/cron and deregister cleanup (telemetry before fs cleanup).** `RuntimeOptions` gains optional `telemetry?: TelemetryWriter`; threaded through all three `runHandler` call sites (`app-data` query, `app-run` action, `app-ingest` cron via `routeContext.telemetry`). `registry-deregister` calls `telemetry.deleteApp(appId)` **before** `cleanupDeregisteredApp` — telemetry now lives at `<appsDir>/<id>/telemetry.sqlite`, so an open DB handle would block the subsequent `rm -rf <appsDir>/<id>` on Windows. `deleteApp` closes the conn, unlinks the file (plus WAL/SHM siblings), and best-effort `rmdir`s the per-app dir if empty (for path-mode apps where there's no other content); failure is logged but non-fatal.

**handleLogsRoute reads from telemetry with jsonl fallback.** `/centraid/apps/:id/logs` checks for an injected writer and reads via `telemetry.readEvents` when available, falling back to the original `log-store.ts` jsonl reader. The desktop's existing Logs panel polls this route and keeps working unchanged.

**Wired in openclaw-plugin and desktop local-runtime.** The plugin keeps the lazy-proxy pattern from chat-history.ts: a `TelemetryWriter` whose methods construct the `TelemetryStore` on first call, so `register()` running in agent-worker contexts (where Runtime never executes handlers) doesn't even create the sweep `setInterval`. The desktop's `local-runtime.ts` constructs a `TelemetryStore(appsDir)` eagerly (single-process, no worker problem). Both hosts pass their existing `appsDir`; the store derives every per-app file path from it.

**19 unit tests in telemetry-store.test.ts.** Covering: write/read round-trip with newest-first ordering, per-app file isolation on disk, level + sinceTs filters, limit + hard cap behavior, byte-cap UTF-8 truncation, count-cap truncation marker, sweep + TTL with a 31-day-old span removed and a fresh one kept, settings defaults / merge / disabled-app drop / minLevel filter / retentionDaysOverrides shortening TTL. Newly added with the per-app sharding: read-on-never-active-app returns `[]` without creating a file, getAppSettings-on-never-active-app returns defaults without creating a file, deleteApp closes conn and unlinks file + rmdirs empty parent (but leaves a non-empty uploaded-mode parent intact for cleanupDeregisteredApp to rm -rf), per-app admission proves app-b is not starved by app-a's burst and that admission resumes after the window rolls, LRU evicts cold connections past the cap (cap=2, three apps, app-a's data survives the eviction on reopen).

## Out of scope

- Desktop UI exposure of the per-app settings — the Cloud panel still calls the existing `appLogs` IPC. A settings sub-panel calling `Api().telemetrySettings(...)` against `/_centraid-telemetry/settings` is the obvious follow-up.
- Removing the legacy `log-store.ts` jsonl path. Kept as a fallback so hosts not yet injecting a writer still serve `/centraid/apps/:id/logs` — should be removed once both hosts in the monorepo are confirmed migrated.
- Cron-scheduled sweep instead of `setInterval`. The Scheduler interface is generic enough that registering a sweep job would be cleaner, but it adds plumbing the in-tree hosts don't need today.
- Span-level reads from the HTTP surface (`GET /_centraid-telemetry/spans` for a traces UI). Schema + indexes are ready; not exposed yet because there's no consumer.
- Deep sweep across cold apps. The current sweeper only iterates open connections — a registry with dozens of historical apps could let expired rows linger in cold files. Easy follow-up: glob `<appsDir>/*/telemetry.sqlite` and open via the LRU. Not needed at <10 users with day-scale TTLs.
- OTel exporter. The data model uses W3C trace IDs so a custom `SpanExporter` could be added later, but the value at <10 users doesn't justify the dependency surface.

## Review fixes

- **P2 — reserved slot for truncation marker.** The earlier code dropped its own "events dropped" warning once the in-memory buffer was full: at `events.length >= MAX_EVENTS_BUFFERED`, `recordEvent('warn', …)` would itself be dropped. Reserved one slot (`USER_EVENT_CAP = MAX - 1`) for user events and added `recordMarker()` which bypasses the cap, so `finish()` can always append the synthesized warning. Invariant documented inline at the helper.
- **P1 — change-tracking + telemetry coexist after rebase.** `handler-runner.ts` now keeps both paths intact: `tracker = trackChanges(db)` setup, `tracker.extract()` snapshot before `db.close()` for the `onWrite(tables)` SSE feed, AND the W3C trace_id / span_id / events buffering for `telemetry.recordHandler(...)`. Threaded `onWrite` + `telemetry` through `RouteContext` and the three direct `runHandler` call sites in `runtime.ts`.

## Verification

- `bun run typecheck` is clean across all 14 packages.
- `bun run lint` is clean (oxlint).
- `bun run format` is clean (oxfmt).
- `bun run test` is clean — runtime-core has 187 tests total (19 telemetry-store + 168 pre-existing).
- Per-file line cap satisfied: telemetry-store.ts at 499 lines, telemetry-helpers.ts at 259, telemetry-routes.ts at 149, telemetry.ts at 125 (governance limit: 500).
