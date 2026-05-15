# issue-56 — Local-mode chat + SSE change feed + builder/chat harness split

GitHub issue: [#56](https://github.com/srikanth235/centraid/issues/56)

## Checklist

- [x] Rename `@centraid/agent-harness` to `@centraid/builder-harness`
- [x] New `@centraid/chat-harness` package
- [x] Rewrite `apps/desktop/src/main/chat.ts` to use chat-harness
- [x] Rename `centraid_get_schema` to `centraid_sql_describe`
- [x] Rename `centraid_sql_select` to `centraid_sql_read`
- [x] Move chat-history storage into runtime-core
- [x] `ChangeBus` and `change-tracker`
- [x] Hook `runQuery()` and `handler-runner.ts` with `onWrite` notifier
- [x] SSE endpoint at `/_changes`
- [x] OpenClaw legacy `centraid_sql_write` emits via the same bus

## What changed

**Rename `@centraid/agent-harness` to `@centraid/builder-harness`.** The package was already the builder-only surface; the new name makes that explicit. `git mv` preserved history. Every importer updated (`apps/desktop/package.json`, `ipc.ts`, `settings.ts`, `centraid-api.d.ts`, mobile `gateway.ts`, READMEs, `runtime-core/upload.ts` doc comments).

**New `@centraid/chat-harness` package.** Sibling to builder-harness. Owns the in-app data-chat agent factory and the three SQL tools that talk to a deployed app's SQLite over the runtime's HTTP surface. Three files in `src/`:

- `sql-tools.ts` — three pi-coding-agent custom tools (`centraid_sql_describe`, `centraid_sql_read`, `centraid_sql_write`), each closure-scoped to a single `appId`. Calls `fetchAppSchema()` / `runAppQuery()` from `@centraid/builder-harness/gateway-client`. The `appId` is **not** a tool parameter — the model can't target another app, which is the in-process equivalent of openclaw-plugin's `before_tool_call` cross-check. Includes `isSelectOnly`/`isWriteDml` guards mirroring the openclaw legacy tool.
- `system-prompt.ts` — focused data-assistant prompt. No app-authoring boilerplate.
- `data-chat-session.ts` — `createCentraidDataChatSession({ config, appId, appName, sandboxDir, sessionMode })`. Uses `noTools: 'all'` so the model never sees file/bash tools, and `appendSystemPromptOverride: () => [promptBlock]` so pi's default coding-agent boilerplate is replaced entirely.

Depends on `@centraid/builder-harness` only for the shared `HarnessConfig` type and the gateway HTTP helpers.

**Rewrite `apps/desktop/src/main/chat.ts` to use chat-harness.** Drops `GatewayWsClient`, drops the `runtimeMode !== 'remote'` guard, drops the `agent` / `agent.wait` / `sessions.abort` WS RPC plumbing. Pi events translate to the same `centraid:chat:event` IPC contract (assistant deltas → `assistant-delta`, `tool_execution_start` → `tool-call` with sql extracted from `args.sql`, `tool_execution_end` → `tool-result`/`tool-error`, `agent_end` → `final`). `app-chat.ts` didn't need to change.

**Rename `centraid_get_schema` to `centraid_sql_describe` and rename `centraid_sql_select` to `centraid_sql_read`** in both surfaces (chat-harness + openclaw-plugin legacy tools). Plus the matching factory function names and every reference in app-chat.ts, the chat history test fixture, and doc comments.

**Move chat-history storage into runtime-core.** `git mv` of `chat-history.ts` and `chat-history.test.ts` from `openclaw-plugin/src/lib/` into `packages/runtime-core/src/`. `runtime-core/index.ts` exports `ChatHistoryStore` and `makeChatHistoryRouteHandler`. `startRuntimeHttpServer` gained an optional `chatHistoryDbPath` — when set, the server intercepts `/_centraid-chat/*` after the bearer check, before delegating to `Runtime.handle`. The openclaw-plugin keeps registering the same route via `api.registerHttpRoute`, now importing the implementation from runtime-core. Desktop local-runtime resolves the new path via `localRuntimeChatHistoryDb()`. Same SQLite schema, same file location convention — existing DBs keep working. Test suite moved with the file.

**`ChangeBus` and `change-tracker`.** New `change-bus.ts` is in-process pub-sub keyed by appId; new `change-tracker.ts` wraps a `DatabaseSync` in a SQLite session and extracts touched table names via `applyChangeset({ filter: () => false })` on an empty in-memory replica. `node:sqlite` doesn't expose `updateHook()`, so the session extension is the available primitive — verified empirically that the filter receives every touched table even when the replica has no matching schema. Empty changesets (read-only operations) suppress the emit at the bus layer.

**Hook `runQuery()` and `handler-runner.ts` with `onWrite` notifier.** `runQuery()` gains a `RunQueryOptions { onWrite }` parameter — opens a session, runs the statement, calls `onWrite(tables)` on success when the changeset is non-empty. `handler-runner.ts` wraps the parent-process `DatabaseSync` in a session for the duration of each action / cron handler turn (query handlers skipped as a perf optimization — see the `query-handlers-read-only` directive from #54). Failed handlers don't fire. `Runtime` exposes `changeBus` as a public field and provides an internal `emitForApp(appId)` closure threaded through to `handleQueryRoute`, `runHandler` for actions, and `runHandler` for crons (via `RouteContext.emitForApp`).

**SSE endpoint at `/_changes`.** New route `GET /centraid/<appId>/_changes` (router.ts + runtime.ts dispatch). `changes-sse.ts` writes `event: change\ndata: {"tables":[...],"ts":...}\n\n` per emit, sends `: ping\n\n` heartbeats every 30s, cleans up the bus subscription on client disconnect (listener-count drops to 0). Apps drop in `new EventSource('/centraid/<id>/_changes')` and re-fetch on `change` events. Auth is automatic in the desktop iframe — Electron's `webRequest.onBeforeSendHeaders` injects the bearer on outbound requests including SSE.

**OpenClaw legacy `centraid_sql_write` emits via the same bus.** `registerCentraidTools` now takes the full `Runtime` instead of just `Registry` so the legacy tool can access `runtime.changeBus`. Its `runQuery()` call passes an `onWrite` callback that emits with the appId it already knows from its `params`. Same notification path as the HTTP route — the SSE feed is comprehensive across both the chat-harness HTTP-driven path and the openclaw-side direct-call path.

## Out of scope

- **Splitting `runtime.ts` into `changes-feed.ts` / `app-routes.ts`.** The file crossed 500 lines (now 505) after the SSE wiring. A head-of-file `governance: allow-repo-hygiene file-size-limit pending split` waiver landed in #54's commit. The actual split is a separate, mechanical follow-up.
- **Replacing `node:sqlite` with `better-sqlite3`.** Considered for `updateHook` push-based notifications; rejected because openclaw itself uses `node:sqlite`, so swapping centraid would mean two SQLite implementations loaded in the same Node process when our plugin runs inside the openclaw gateway. Session-extension polling is the right call as long as openclaw stays on `node:sqlite`.
- **App-side client helper.** The five-line `new EventSource(...)` pattern is documented in `changes-sse.ts` but not bundled as a static helper file. If a future template needs it, we'll ship `/_centraid-client/changes.js` then.
- **Model picker in chat header.** The renderer previously read a list from the gateway's `models.list` RPC. The harness path defers model selection to pi-coding-agent's own settings/auth; the `MODELS` IPC now returns `[]` (the renderer falls back to the default). Wiring a proper picker (e.g. via `getModel(...)` from `@earendil-works/pi-ai`) is its own follow-up.

## Verification

- `bun run --filter '*' typecheck` — passes across all 8 packages.
- `bun run --filter '*' test` — 124 runtime-core tests pass (8 change-bus, 7 change-tracker, 4 change-events runQuery, 4 SSE integration are new). chat-harness, builder-harness, openclaw-plugin test suites all green.
- `bun run --filter '*' build` — passes.
- Smoke (planned for review): open desktop in local-runtime mode → chat panel works against a deployed app; iframe receives `event: change` over `/_changes` after a chat-driven write.
- Coverage matrix: chat-harness write → ✅ via HTTP `runQuery`; openclaw legacy tool write → ✅ via direct `runQuery` with `onWrite`; action handler write → ✅ via `handler-runner` session wrap; cron handler write → ✅ same; query handler write → ❌ by design (perf), enforced by governance directive in #54.
