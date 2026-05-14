# issue-41 — Per-app agentic chat in the app view (openclaw WS + SQL tools)

GitHub issue: [#41](https://github.com/srikanth235/centraid/issues/41)

## Checklist

- [x] FAB at the bottom-right of the app view
- [x] Slide-out chat panel scoped to one centraid app at a time
- [x] Real-time streaming of `assistant.delta` events into the bubble
- [x] Plugin-registered agent tools (`centraid_get_schema`, `centraid_sql_select`)
- [x] Session-scoped tool guard via `before_tool_call` hook
- [x] SELECT-only guard (writes/DDL/PRAGMA/ATTACH refused upfront)
- [x] Minimal Gateway WS client (loopback-only, no SDK dep)
- [x] Stop button for in-flight turns
- [x] Model picker in Settings (populated from `models.list`) with Refresh button
- [x] Unit tests for `isSelectOnly` and `appIdFromSessionKey`
- [x] README + `setup-tools.mjs` helper for `tools.alsoAllow`

## What changed

**FAB at the bottom-right of the app view.** `apps/desktop/src/renderer/app.ts` gets a new `mountAppChat(view, app, projectId)` helper that's called from `openApp` for every centraid-backed app. It builds a Sparkle-glyph button anchored to the bottom-right of `.app-view` (`position: absolute; right: 18px; bottom: 18px`) and toggles a side panel on click.

**Slide-out chat panel scoped to one centraid app at a time.** The panel slides in from the right edge of the same `.app-view` container, so it overlays the running app's iframe rather than pushing it. Each window+app pair owns its own chat session via `chat.ts`'s session map keyed by `${windowId}:${appId}`, and the panel's events filter on the matching `appId` so two open windows don't cross-talk.

**Real-time streaming of `assistant.delta` events into the bubble.** `chat.ts` subscribes to the gateway's `agent` event stream and forwards every `payload.stream === "assistant"` frame to the renderer as an `assistant-delta` IPC event. The renderer's `handleEvent` appends each delta to `state.streamed` and rewrites `nodes.answer.textContent`, so the bubble grows token-by-token. Verified empirically — `agent` frames carry both `data.text` (cumulative) and `data.delta` (incremental); we consume `delta`.

**Plugin-registered agent tools (`centraid_get_schema`, `centraid_sql_select`).** New `packages/openclaw-plugin/src/lib/tools.ts` calls `api.registerTool` for both. `centraid_get_schema({ appId })` reads `data.sqlite` via runtime-core's `readAppSchema` and returns `{ tables, views, indexes }`. `centraid_sql_select({ appId, sql })` runs one statement via runtime-core's `runQuery` and returns up to 50 rows. Both are declared in `openclaw.plugin.json#contracts.tools` so the gateway can resolve a tool name to the owning plugin without loading every plugin runtime. The plugin's `register()` runs both in the gateway and in the agent worker context — only the gateway sees `gateway_start`, so tool execute functions lazy-call `await registry.load()` to hydrate the worker's `Registry.cache`.

**Session-scoped tool guard via `before_tool_call` hook.** The same `tools.ts` registers an `api.on('before_tool_call', (event, ctx) => ...)` handler with signature `(event, ctx)` — `ctx.sessionKey` carries the run's session key, which the chat client opens as `centraid-chat:<appId>:w<windowId>`. The handler parses the app id out of the key (using `indexOf` because openclaw prefixes session keys with `agent:<agentId>:` internally) and refuses any `centraid_*` tool call whose `appId` param doesn't match. It also auto-fills `appId` when the model omits it.

**SELECT-only guard (writes/DDL/PRAGMA/ATTACH refused upfront).** `tools.ts#isSelectOnly` strips `--` line and `/* */` block comments, requires the first keyword to be `SELECT` or `EXPLAIN`, and refuses any of `insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex|pragma` as a standalone word anywhere in the statement. Applied inside `centraid_sql_select.execute` before runtime-core ever opens the DB.

**Minimal Gateway WS client (loopback-only, no SDK dep).** New `apps/desktop/src/main/gateway-ws.ts` because `@openclaw/sdk` is monorepo-internal — its `GatewayClientTransport` imports `GatewayClient` from a relative path inside the openclaw repo and the package is marked `private: true`. The client speaks the wire protocol directly: read `connect.challenge`, send `connect` as `{client: { id: "gateway-client", mode: "backend" }, auth: { token }, ...}`, wait for `hello-ok`, then issue typed RPC requests and listen for server-pushed events. Frame shapes verified against the openclaw monorepo's `packages/sdk/src/index.e2e.test.ts`. Loopback-only by design — non-loopback gateways with device pairing would reject this handshake.

**Stop button for in-flight turns.** The chat panel renders Send and Stop as a hidden-toggle pair (`hidden=""` attribute). `setBusy(true)` flips Stop visible while a turn is active; on click it calls `window.CentraidApi.chatAbort({ appId })`, which routes to a main-process IPC that calls `sessions.abort` over WS with `{ runId, key }`. The renderer surfaces the abort as an `aborted` event, swaps the bubble to "(stopped)" if nothing streamed, and restores Send.

**Model picker in Settings (populated from `models.list`) with Refresh button.** The Settings page gains a "Chat" drawer group with a `<select>` populated by `window.CentraidApi.listChatModels()` (which routes to `chat.ts#listModels` → gateway `models.list` over WS). The selection persists via `chatModel` on `DesktopSettings`. A Refresh button next to the select re-hits `models.list` without restarting the app — useful when a user adds a provider profile in openclaw.

**Unit tests for `isSelectOnly` and `appIdFromSessionKey`.** New `packages/openclaw-plugin/src/lib/tools.test.ts` exercises 15 cases under `node:test`: SELECT/EXPLAIN acceptance, comment stripping, write/DDL/PRAGMA/ATTACH refusal, EXPLAIN-INSERT and WITH-CTE-INSERT refusal, bare and gateway-prefixed session keys, hyphenated app ids, and missing-marker handling.

**README + `setup-tools.mjs` helper for `tools.alsoAllow`.** `packages/openclaw-plugin/README.md` adds an "Agent tools" section explaining what the two tools do, the scope guard, and how to enable them. `packages/openclaw-plugin/scripts/setup-tools.mjs` is a Node CLI that reads `~/.openclaw/openclaw.json`, merges the two tool ids into `tools.alsoAllow` (the documented additive form that's merged on top of the active profile), and writes the file atomically with mode `0600`. Idempotent — safe to re-run.

## Out of scope

- **Hydrating chat history on reopen.** The openclaw session is durable on disk but the renderer state isn't. Marked as `TODO(#41)` in `chat.ts`; a follow-up can call a session-read RPC (or parse the `~/.openclaw/agents/main/sessions/*.jsonl` file directly) and emit synthetic chat events before the first user turn.
- **Local-mode chat.** When desktop runs in `runtimeMode: 'local'`, `runtime-core` lives inside Electron with no agent runtime around it. Wiring a Claude/OpenAI agent loop into local mode would be a separate feature.
- **Non-loopback gateways.** `GatewayWsClient` skips device pairing on the assumption that the gateway URL is loopback. Talking to a remote/public openclaw would need device-token + signature support in `sendConnect`.
- **Refresh on focus.** The model dropdown only refreshes via the explicit Refresh button (or when the Settings page is opened). Auto-refresh on window focus or on provider-auth changes is not wired.
- **Persistence of `tools.alsoAllow`.** The setup helper is one-shot — it patches the local user's `~/.openclaw/openclaw.json`. We do not write to that file at desktop runtime or auto-sync it across machines.

## Verification

- `bun run typecheck` — passes
- `bun run test` — 88 tests pass (15 new for `tools.ts`)
- `bun run lint` — clean
- `bun run build` — clean
- Manual: opened the Todos app, sent "are there any todo tasks", agent called `centraid_get_schema` → `centraid_sql_select` and streamed the answer
