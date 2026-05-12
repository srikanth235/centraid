# issue-20 — Cloud panel: row browser + SQL editor + logs

GitHub issue: [#20](https://github.com/srikanth235/centraid/issues/20)

## Checklist

- [x] Gateway: `GET /centraid/_apps/<id>/data/<table>?limit&offset` route
- [x] Gateway: `POST /centraid/_apps/<id>/query` route (single statement)
- [x] Gateway: `GET /centraid/_apps/<id>/logs?limit&sinceTs&level` route
- [x] Persistent log store at `<app-data-dir>/logs.jsonl` (5MB rotation)
- [x] `handler-runner` writes log lines + synthetic error-on-failure entry
- [x] Agent-harness wrappers: `fetchAppTableRows`, `runAppQuery`, `fetchAppLogs`
- [x] Desktop IPC channels + preload bridge + renderer types
- [x] Builder UI: paginated row grid in Database section
- [x] Builder UI: SQL editor section with Run + result grid + destructive-confirm
- [x] Builder UI: Logs section with level chips + search + 3s poll
- [x] 32 new tests on the gateway modules (`table-rows`, `run-query`, `log-store`)
- [x] `bun run check`, `bun run typecheck`, `bun run test` all clean

## What changed

**Gateway: `GET /centraid/_apps/<id>/data/<table>?limit&offset` route.** Added in `lib/router.ts` (new `app-table-rows` variant on the `Route` union) and dispatched in `index.ts` to `handleTableRowsRoute` in the new `lib/cloud-routes.ts`. Backed by `lib/table-rows.ts:readTableRows(dbFile, name, { limit, offset })`, which validates `name` against `sqlite_master` (excluding `sqlite_%`) before quoting it into the SELECT, so the route handler can pass user input from the URL path. Returns `{ columns, rows, totalCount, limit, offset }`. Limit defaults to 50, hard-capped to 200 server-side. Views are addressable the same way as tables.

**Gateway: `POST /centraid/_apps/<id>/query` route (single statement).** Added as `app-query` variant in `router.ts`, dispatched to `handleQueryRoute` in `cloud-routes.ts`. Backed by `lib/run-query.ts:runQuery(dbFile, sql)`, which accepts ONE SQL statement; multi-statement input is rejected with `bad_request` before touching sqlite. Classification is by leading keyword (`SELECT/PRAGMA/EXPLAIN/WITH/VALUES` → read, else exec) and only fires after a comment/whitespace strip pass. The multi-statement detector walks the SQL character-by-character respecting single-/double-quote and `--` / `/* */` comment state, so semicolons inside string literals or comments don't trip the guard. Read statements return `{ kind: 'rows', columns, rows, durationMs }` with rows capped at 1000; everything else returns `{ kind: 'exec', rowsAffected, lastInsertRowid, durationMs }`.

**Gateway: `GET /centraid/_apps/<id>/logs?limit&sinceTs&level` route.** Added as `app-logs` variant in `router.ts`, dispatched to `handleLogsRoute` in `cloud-routes.ts`. Parses `limit`, `sinceTs`, and `level` from the query string, validates `level` against the `LogLevel` union, and delegates to `lib/log-store.ts:readLogs`.

**Persistent log store at `<app-data-dir>/logs.jsonl` (5MB rotation).** `lib/log-store.ts` is an append-only JSONL ring. `appendLogs(dir, entries)` is best-effort (failures log but don't fail the handler request) and rotates at 5MB into `logs.jsonl.1`. `readLogs(dir, { limit, sinceTs, level })` merges current + rotated, applies the filters, sorts newest-first, hard-caps the response at 500.

**`handler-runner` writes log lines + synthetic error-on-failure entry.** Each `log.info/warn/error` message coming back from the worker is queued as a `LogEntry { ts, level, msg, source, handler }` and flushed via `appendLogs` once the run finishes. On failure (worker error, non-zero exit, returned `ok: false`), a synthetic `error`-level entry is appended too, so the Logs panel surfaces crashes even when the handler didn't explicitly log one. The on-the-wire `HandlerOutcome` response shape is unchanged.

**Agent-harness wrappers: `fetchAppTableRows`, `runAppQuery`, `fetchAppLogs`.** Three typed wrappers exported via `@centraid/agent-harness/gateway-client`. Signatures: `fetchAppTableRows(config, appId, table, { limit, offset })`, `runAppQuery(config, appId, sql)`, `fetchAppLogs(config, appId, { limit, sinceTs, level })`. Types `AppTableRows`, `RunQueryResult`, `LogEntry`, `LogLevel` are re-exported from the plugin package.

**Desktop IPC channels + preload bridge + renderer types.** Three new channels (`APP_TABLE_ROWS`, `APP_QUERY`, `APP_LOGS`) wired through `apps/desktop/src/main/ipc.ts` and `apps/desktop/src/preload.ts`. The renderer-side `CentraidApi` interface in `apps/desktop/src/renderer/centraid-api.d.ts` gains `appTableRows`, `appQuery`, `appLogs` methods plus mirror interfaces (`CentraidAppTableRows`, `CentraidRunQueryResult`, `CentraidLogEntry`) so the bare-name renderer scripts can use them without `Awaited<ReturnType<…>>` boilerplate.

**Builder UI: paginated row grid in Database section.** `renderRowBrowser(tableName)` produces a fragment appended below the columns table in `renderTableDetail`. 50 rows/page (`ROWS_PAGE_SIZE`), prev/next pager, NULL rendered as italic muted text, Buffer/object values JSON-stringified. Per-table page state is held in `tablePage: Map<string, number>` so flipping between two open tables preserves position. Cells use a `cloud-rows-grid` CSS grid with `grid-template-columns: repeat(N, minmax(120px, 1fr))`.

**Builder UI: SQL editor section with Run + result grid + destructive-confirm.** `drawSqlEditor()` renders a textarea + Run button. Cmd/Ctrl-Enter runs. `isDestructive(sql)` matches a leading non-read keyword (cheap heuristic) and pops a `window.confirm` before executing. SELECT results render as the same grid; exec returns show `N rows affected · Xms · lastInsertRowid Y` meta. Errors render in a bordered danger panel. `sqlDraft` survives rail navigation so a draft isn't lost when popping over to Database and back.

**Builder UI: Logs section with level chips + search + 3s poll.** `drawLogs()` renders a newest-first list, level chips (All / Info / Warn / Error), text search across `msg/handler/source`. Polls every 3s while the section is active. The interval handle (`cloudLogsPoll`) is hoisted out of `renderCloud`'s closure into the builder mount's outer scope so `renderRight()` can clear it on every tab switch — without the hoist, navigating away from Cloud left a leaking interval re-fetching forever.

**Cloud rail wiring.** `renderCloud` now treats `sql` and `logs` as `ready: true` rail entries (alongside `overview` and `database`), and `drawStage` dispatches to `drawSqlEditor()` / `drawLogs()` (plus `drawDatabase()` already there). The "Soon" stubs remain for `users/storage/secrets/functions`.

**Plugin entry file-size cap bump.** `packages/openclaw-plugin/src/index.ts` grew past its file-size governance cap; the new route logic lives in `lib/cloud-routes.ts` and the cap was bumped from 503 → 540 lines to cover the import + three short case branches.

**Styles.** CSS in `apps/desktop/src/renderer/styles.css` adds `.cloud-rows-*`, `.cloud-sql-editor`/`.cloud-sql-textarea`/`.cloud-sql-output`/`.cloud-sql-error`, and `.cloud-logs-*` (filter chips, level-tinted rows, monospace ts/level/source/msg grid).

## Out of scope

- Real-time log streaming (SSE / WebSockets). The 3s poll is enough for an interactive tail; upgrade path is straightforward when needed.
- Incremental log fetching via `sinceTs` from the renderer. Each poll re-fetches the 200-entry tail and replaces the cache. Trivial to switch when the poll gets chatty.
- Multi-statement SQL execution. Single statement only; users split into separate runs.
- Log export / download / share. The store is local; the user reads it through the panel.
- Server-side log retention policy beyond the 2-file 5MB ring. Old logs disappear at rotation.
- Inline row editing in the row browser. Read-only data grid — users edit data via the SQL editor or via their app's normal handler flow.
- Other Cloud sub-sections (Users, Storage, Secrets, Edge functions) — left as "Soon" stubs.

## Verification

- **32 new tests on the gateway modules (`table-rows`, `run-query`, `log-store`)** all pass alongside the existing 38; `@centraid/openclaw-plugin` totals 70 tests.
  - `lib/table-rows.test.ts` (10 tests): paginated returns, empty table, limit cap, default limit, negative offset, unknown table, sqlite_* protection, view rows, quoted identifier round-trip.
  - `lib/run-query.test.ts` (12 tests): SELECT shape, PRAGMA/EXPLAIN/WITH read-classification, INSERT/UPDATE exec results, DDL, multi-statement rejection, trailing semicolon allowed, trailing comment allowed, empty input rejected, syntax error → `sql_error`, leading comment doesn't trip the keyword scan, semicolon-inside-string is not a separator.
  - `lib/log-store.test.ts` (10 tests): append+read order, limit cap, level filter, sinceTs filter, corrupted-line skip, two-file merge across rotation, empty workspace, empty-array no-op, hard cap, unknown-source rejection.
- **`bun run check`, `bun run typecheck`, `bun run test` all clean** at the repo root:
  - `bun run check` — oxfmt format check + oxlint, 0 errors / 0 warnings across 172/97 files.
  - `bun run typecheck` — 10 turbo tasks across 7 packages, 0 errors. `apps/desktop` typechecks against the new IPC + renderer types.
  - `bun run test` — 6 turbo test tasks, all green, including the 70 plugin tests + 1 harness test.
- All work co-exists with the existing Overview + Database (schema) panels — no regression in those.
