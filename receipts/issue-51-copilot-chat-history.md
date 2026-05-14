# issue-51 — Copilot-style chat history in the app chat widget

GitHub issue: [#51](https://github.com/srikanth235/centraid/issues/51)

## Checklist

- [x] Persist per-app chat sessions on the gateway in a single shared SQLite
- [x] Plugin HTTP routes at /_centraid-chat for list / load / create / rename / delete / batch-append
- [x] Renderer panel exposes a Copilot-style history view with hamburger toggle, new-chat button, resume, and hover-delete
- [x] Session auto-titled server-side from the first user message
- [x] Batched persistence flushes one POST per turn; server assigns idx atomically
- [x] Each chat session gets its own openclaw agent sessionKey so resume picks up the same agent memory
- [x] Tool-event delivery restored by declaring the tool-events cap in the WS handshake
- [x] centraid_sql_write advertised in the plugin manifest contracts.tools so the agent sees it
- [x] Builder sidebar shows Drafts again
- [x] Clicking a draft inside the builder swaps cleanly to the new draft's builder
- [x] mountAppChat extracted from app.ts into its own renderer module
- [x] Unit tests for the chat-history store, route dispatcher, deriveTitle, and ordering across batches

## What changed

### Persist per-app chat sessions on the gateway in a single shared SQLite

New file `packages/openclaw-plugin/src/lib/chat-history.ts` opens `<stateDir>/centraid-chat-history.sqlite` with two tables — `chat_sessions(id, app_id, title, created_at, updated_at)` and `chat_messages(session_id, idx, payload_json, created_at)`. One shared DB (not one-per-app) keeps chat metadata out of each app's user-facing `data.sqlite` and out of reach of the agent's `centraid_sql_*` tools. WAL mode + a covering index on `(session_id)` cover the access patterns. Prepared statements are cached on the store instance so the append hot-path doesn't re-prepare every call.

### Plugin HTTP routes at /_centraid-chat for list / load / create / rename / delete / batch-append

Registered via `api.registerHttpRoute({ path: '/_centraid-chat', match: 'prefix', auth: 'gateway' })` from `packages/openclaw-plugin/src/index.ts`. The dispatcher in `chat-history.ts` covers `GET /sessions?appId=...`, `POST /sessions`, `GET /sessions/<id>`, `PATCH /sessions/<id>`, `DELETE /sessions/<id>`, and `POST /sessions/<id>/messages` (batch append). The `ChatHistoryStore` is lazy-initialised inside a closure (`getStore()`) so the SQLite connection only opens in the gateway context — `register()` runs in agent-worker subprocesses too, and they would otherwise hold stray DB handles to a file they never touch.

### Renderer panel exposes a Copilot-style history view with hamburger toggle, new-chat button, resume, and hover-delete

`apps/desktop/src/renderer/app-chat.ts` (new file, IIFE exposing `window.AppChat.mount`) holds the entire chat-widget surface. The panel header now has a hamburger (opens history list / morphs into a back-arrow when in list view), a session-title chip, a `+` for new chat, and the close button. The history view replaces the message scroll with a search input and rows grouped by Today / Yesterday / This week / This month / Earlier, each with a hover-revealed delete icon. Click a row → loads it via `chatHistoryLoad`, hydrates the renderer's `AppChatMsg[]` (consecutive tool rows fold back into tool groups), and reattaches to the openclaw session. New chat resets local state and re-issues `chatStart(sessionId: null)`.

### Session auto-titled server-side from the first user message

`deriveTitle` lives in `chat-history.ts`: collapse whitespace, then truncate at 60 with an ellipsis. The first user message in a batch triggers the derive only if the session's title is still empty (so explicit renames are preserved). `chatSend` returns `{ ok, sessionId, title }`; the renderer treats `title` as authoritative and writes it straight into the header — no client-side computation that could diverge.

### Batched persistence flushes one POST per turn; server assigns idx atomically

The shell's `chat.ts` now buffers the streaming tail of a turn (`acc.batch`) inside `runTurn` and flushes it via a single `historyAppendBatch` POST in the `finally` block. The user message is persisted synchronously in the `SEND` handler before `runTurn` fires, so the prompt is durable even if Electron crashes mid-turn. The server's `appendMessages` opens a `BEGIN IMMEDIATE` transaction, assigns sequential `idx` values, and commits — concurrent batches produce separable runs of indices rather than interleaved chaos.

### Each chat session gets its own openclaw agent sessionKey so resume picks up the same agent memory

`makeAgentSessionKey(appId, chatSessionId)` returns `centraid-chat:<appId>:s<uuid>`. Switching chats inside the same window swaps the sessionKey on the next agent call, so resuming an old chat picks up the same gateway-side agent memory the model had when the chat was originally running.

### Tool-event delivery restored by declaring the tool-events cap in the WS handshake

Openclaw 2026.5.7 moved tool frames off the global `agent` broadcast and onto per-recipient delivery gated by the `tool-events` WS capability. Our handshake in `apps/desktop/src/main/gateway-ws.ts` was sending `caps: []`; updated to `caps: ['tool-events']`. Assistant deltas had always been visible (those are broadcast); only the tool pills had vanished after the upgrade.

### centraid_sql_write advertised in the plugin manifest contracts.tools so the agent sees it

The write tool was registered at runtime in `tools.ts`, but `openclaw.plugin.json#contracts.tools` only listed the SELECT + schema tools. Openclaw uses the manifest's contract list to populate the agent's allowed-tools catalog, so the model genuinely couldn't see the write tool. Added it; after `openclaw plugins registry --refresh` + gateway restart the agent can mutate per-app data.

### Builder sidebar shows Drafts again

`apps/desktop/src/renderer/builder.ts` passed `drafts: []` to its sidebar — a placeholder masquerading as code. `BuilderOptions` now carries `drafts?: ChromeSidebarApp[]`; the shell's `enterBuilder` maps its hydrated drafts cache and forwards it. The currently-open draft highlights via the existing `activeId` mechanism.

### Clicking a draft inside the builder swaps cleanly to the new draft's builder

The builder's `onAppClick` used to call `handleExit()` (which fires `renderHome` — an `async` function awaiting disk reads) and *then* `Centraid.openApp(id)` synchronously. The sync mount ran first; `renderHomeAsync` then appended a second shell underneath when it finally resolved. Dropped the redundant `handleExit` — `openApp` already calls `clear()`, which fires the active builder's `currentCleanup` before the new view mounts. `openApp` itself was tightened to route drafts to `enterBuilder` so the builder sidebar's plain `Centraid.openApp(id)` call works for both apps and drafts without duplicating the branch.

### mountAppChat extracted from app.ts into its own renderer module

`apps/desktop/src/renderer/app-chat.ts` (new) holds the full chat-widget IIFE; `apps/desktop/src/renderer/app.ts` lost 967 lines and now calls `window.AppChat.mount({ view, app, appId, el })`. `index.html` loads `app-chat.js` before `app.js`. `Window.AppChat` declared in `types.d.ts`.

### Unit tests for the chat-history store, route dispatcher, deriveTitle, and ordering across batches

`packages/openclaw-plugin/src/lib/chat-history.test.ts` covers `deriveTitle` (whitespace, truncation, ellipsis), `isUserMessage`, store CRUD, ordering across batches, title-derive-once semantics, the route dispatcher (good paths, 400 / 404 / 405, "delegate" return for outside-prefix URLs). 24 new tests; plugin suite is 47/47 green.

## Verification

- `bun run typecheck` — 12/12 packages clean.
- `bun run build` — 6/6 packages clean.
- `bun run test` — runtime-core 73/73, openclaw-plugin 47/47 (24 new), 8/8 packages green.
- Plugin dist re-synced to `/Users/srikanth/gitspace/centraid/packages/openclaw-plugin/dist`; `openclaw plugins registry --refresh` + `openclaw gateway restart` applied to pick up the new manifest + route.
- Manual smoke: send a fresh prompt in the in-app chat panel → tool pills render → assistant final renders → close panel → reopen → history list shows the chat → resume restores messages.
- Manual smoke: open the builder, click a draft in the sidebar — panel swaps to the new draft's builder (no stacked shells).
- Manual smoke: ask the agent to mark a todo done — `centraid_sql_write` is invoked end-to-end.

## Out of scope

- Per-user / per-machine scoping on the shared chat-history SQLite. Schema would need a `created_by` column before multiple desktops can safely share a gateway. Single-user dev setups are fine today.
- Schema migrations. The store uses `CREATE TABLE IF NOT EXISTS` only; the runtime-core `migrate.ts` framework isn't wired in.
- Tool payload compression. Full row data is stored uncompressed; data-heavy chats could balloon over time.
- A "Templates" section in the sidebar (a wrong-tree diagnosis explored mid-session before the actual Drafts bug was identified). Drafts are already shown in their own section once the builder receives them.
