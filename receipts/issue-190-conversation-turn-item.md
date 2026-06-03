# issue-190 — Conversation/Turn/Item data model + attachments

GitHub issue: [#190](https://github.com/srikanth235/centraid/issues/190)

Make "everything is chat" first-class in the per-app `runtime.sqlite`:
promote **Conversation** to the spine, demote `runs`→`turns` and
`run_nodes`→`items` underneath it, record the inbound message as a
first-class `message_in` item, and add a universal run-scoped `attachments`
table backed by a per-app blob CAS — which is what finally lets attachments
fall out of the inbound message instead of being bolted into `input_json`.

Per centraid v0 (pre-release, no backward compat / no data migrations) this
is a **code refactor, not a data migration** — the baseline migration slot
absorbs the new shape.

## Checklist

- [x] conversations/turns/items/attachments schema with CHECK constraints, no chat_sessions/runs/run_nodes
- [x] every turn has a NOT NULL FK conversation_id and deleting a conversation cascades to turns, items, and attachments
- [x] a chat turn's inbound message is a message_in item at ordinal 0, not input_json, and getSession reconstructs uniformly from items
- [x] an automation fire records the same shape: an automation conversation with a message_in item carrying the trigger payload
- [x] writing an unknown kind/trigger/item kind is rejected by the DB CHECK, not silently coerced
- [x] a chat upload stores bytes once in the per-app blob CAS deduped by hash, an attachments row references the message_in item, and the model call receives an image/document content block
- [x] deleting the conversation removes attachment rows and the GC sweep removes now-unreferenced blobs
- [x] insights/run_summary report correct per-kind and total token/cost after sourcing kind from the conversation
- [x] existing chat, automation, and build flows pass end to end under typecheck and the unit suites
- [x] rename the stale agent-runs-* files to conversation-* so the filenames match the Conversation entity

## What changed

### app-engine — schema, types, store, fold, blob CAS

- `gateway-db.ts` `RUNTIME_MIGRATIONS` is rewritten to the
  conversations/turns/items/attachments schema with CHECK constraints, no
  chat_sessions/runs/run_nodes: `conversations` (kind + app_id + automation_id
  moved UP, `CHECK (kind IN ('chat','automation','build'))`), `turns`
  (`conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE
  CASCADE`, `seq`, `CHECK (trigger IN …)`), `items`
  (`turn_id … ON DELETE CASCADE`, new `message_in` kind + `role`/`text`,
  `CHECK (kind IN ('message_in','step','tool','agent'))`), and `attachments`
  (`item_id … ON DELETE CASCADE`, content `hash`).
- `agent-runs-schema.ts` row types: `AgentRunRow`→`Turn`,
  `AgentRunNodeRow`→`Item`, `AgentRunNodeKind`→`ItemKind` (+`message_in`), new
  `Conversation` and `Attachment` types; `kind`/`appId`/`automationId` move
  onto `Conversation`.
- `agent-runs-store(-sql).ts`: `AgentRunsStore`→`ConversationStore` over the
  five tables — conversation CRUD (merged in from the old chat-history SQL),
  turn insert/finish with seq + the step/agent rollup, item insert/open/close,
  `insertMessageIn`, attachment insert/list + `referencedHashes`, and the
  automation_state KV.
- `chat-history.ts` is now a facade over `ConversationStore`: a chat turn's
  inbound message is a message_in item at ordinal 0, not input_json, and
  getSession reconstructs uniformly from items (message_in → user, step → ai,
  tool → tool), with attachment metadata + download URLs folded onto the user
  message. `chat-history-sql.ts` is deleted (its SQL moved into the store).
- New `blob-store.ts`: a per-app content-addressed store — a chat upload
  stores bytes once in the per-app blob CAS deduped by hash
  (`<appsDir>/<appId>/blobs/<hash>`), with a refcount-by-hash `gc()` that
  removes now-unreferenced blobs. `chat-history.deleteSession` runs the GC
  after the cascade.
- `chat-routes.ts` resolves uploaded attachment refs to blob paths for the
  model call and records an attachments row referencing the message_in item;
  `chat-history-routes.ts` adds the blob upload/download routes.

### conversation-engine — automation write path

- An automation fire records the same shape: `ensureAutomationConversation`
  creates an automation conversation (kind=automation, id == automation ref)
  and the trigger payload lands as a message_in item carrying the trigger
  payload; trace items then start at ordinal 1. `rowToRunRef` reads the input
  from the message_in item; audit open/close target items.

### gateway + analytics

- `automations-routes.ts` maps the new `Turn`/`Item` rows back to the stable
  run-feed / run-detail / node-timeline wire shapes the desktop already reads
  (sourcing kind/automationId from the run summary, inputJson from the
  message_in item), so the renderer contract is unchanged.
- The `run_summary` write-through now sources kind/app_id/automation_ref from
  the owning conversation join; insights/run_summary report correct per-kind
  and total token/cost after sourcing kind from the conversation.

### agent-runtime — multimodal input

- New `multimodal.ts` builds Anthropic image/document content blocks (and
  codex `localImage` items); the claude and codex adapters send a structured
  multimodal user turn when attachments are present, so the model call
  receives an image/document content block.

### desktop

- A chat upload client (`uploadChatAttachment`) + the paperclip file-picker
  queue attachments that ride the next `streamChat` turn. The run-feed wire
  shapes are unchanged, so the renderer's run/insights views need no type
  changes.

### Follow-up — file rename

- The data model stays in `app-engine` (the persistence/host layer that
  `conversation-engine` depends on — moving it up would cycle). To remove the
  naming dissonance we rename the stale agent-runs-* files to conversation-* so
  the filenames match the Conversation entity: `agent-runs-schema`→
  `conversation-schema`, `agent-runs-store[-sql]`→`conversation-store[-sql]`.
  Barrel exports are unchanged, so no downstream package is affected.

### Follow-up — `ChatHistoryStore` → `ConversationHistoryStore`

- The store backing the chat surface is a kind-agnostic facade over
  `ConversationStore` (it spans `kind IN ('chat','build')`), so "chat history"
  was the same stale-vocabulary mismatch `agent-runs-*` was. Renamed the
  *record/persistence* concern to be conversation-first:
  `chat-history.ts`→`conversation-history.ts`, `ChatHistoryStore`→
  `ConversationHistoryStore`, and the injection field `chatHistoryStore`→
  `conversationHistoryStore` (RuntimeOptions/Runtime, BuiltGateway, serve).
- The *interactive surface* stays "chat" deliberately: the `/_centraid-chat`
  wire route, `chat-history-routes.ts` / `makeChatHistoryRouteHandler`, the
  `chat-runner` seam, and the renderer-facing DTOs (`ChatSessionMeta`,
  `ChatMessageRow`, `ChatTurnNode`) — "chat" there means *interactive*, and
  `ChatSessionMeta` would also collide with the existing `ConversationMeta`.

### Follow-up — strip "chat" from code + wire routes (everything is a conversation)

- Per the first principle ("everything is a conversation; the differentiator is
  the *trigger* — interactive / scheduled / webhook — not a separate `chat`
  entity"), the prior "interactive surface keeps chat" carve-out is dropped.
  `chat` is no longer a code concept — only a *visible UI label* in the desktop
  renderer. Since centraid is v0 (no back-compat), the wire routes rename too.
- Wire routes: `POST /centraid/<id>/_chat` → `…/_turn`;
  `GET /centraid/_chat/runner-status` → `…/_turn/runner-status`;
  `/_centraid-chat/*` → `/_centraid-conversations/*`.
- Runner seam: `ChatRunner`/`ChatRunInput`/`ChatRunResult`/`ChatStreamEvent` →
  `ConversationRunner`/`ConversationTurnInput`/`ConversationTurnResult`/
  `TurnStreamEvent`; `makeChatRunner`→`makeConversationRunner`,
  `makeChatRunnerCore`→`makeConversationRunnerCore`,
  `makeUnifiedChatRunner`→`makeUnifiedConversationRunner`,
  `makeOpenClawChatRunner`→`makeOpenClawConversationRunner`. Error code
  `no_chat_runner`→`no_conversation_runner`.
- Files: `chat-runner`→`conversation-runner`, `chat-routes`→`turn-routes`,
  `chat-history-routes`→`conversation-routes`, `chat-transcript`→
  `conversation-transcript` (app-engine); `chat-adapter`→`conversation-adapter`
  (agent-runtime); `chat/chat-runner-core`→`conversation/conversation-runner-core`
  (conversation-engine); `unified-chat-runner`→`unified-conversation-runner`
  (gateway); `openclaw-chat-runner`→`openclaw-conversation-runner` (openclaw);
  `chat-history-client`→`conversation-history-client`,
  `gateway-client-chat`→`gateway-client-conversation` (desktop).
- DTOs: `ChatSessionMeta`→`ConversationSummary`, `ChatMessageRow`→
  `ConversationMessageRow`, `ChatTurnNode`→`TurnNode`, `ChatTurnAttachment`→
  `ConversationTurnAttachment`. Fields: `chatRunner`→`conversationRunner`,
  `chatRunnerSessionDir`→`conversationRunnerSessionDir`, `chatStore`→
  `conversationStore`. OpenClaw session key `centraid-chat:`→
  `centraid-conversation:` (the runner + `tools.ts` validator stay in lockstep).
- Deliberately KEPT as "chat": (a) the persisted **kind** value `'chat'`
  (`kind IN ('chat','automation','build')`) — a chat is the interactive *kind*
  of conversation, not a separate table; (b) the **visible desktop pane** and
  its renderer-local view model (`ChatPane`/`ChatToggle`/`ChatView`/`ChatOpen`,
  the "Chats" tab, `chatModelByRunner`, the `app-chat-history-*` CSS) — that's
  the human-facing label the user reads; (c) the provider OpenAI-compat surface
  in the mock-LLM (`/v1/chat/completions`, `ChatCompletions`, `chatcmpl`).
- Landed as ONE commit: the route rename spans server (app-engine/gateway) and
  client (desktop/openclaw) simultaneously, so splitting would leave an
  intermediate state where the client calls `/_chat` while the server serves
  `/_turn`. Atomicity beats per-package commits here.

## Out of scope

- Cross-app referential integrity and the `run_summary` best-effort
  dual-write drift (per-app SQLite sharding is an orthogonal axis;
  `parent_turn_id` stays FK-free across apps).
- Per-origin trigger *ingestion* beyond the chat upload route (webhook
  multipart / email / folder-watch file intake) — follow-ups now that the
  storage + model spine exists.
- Attachment metadata on the central `run_summary` sink.
- Virus-scanning / size-limit policy beyond a basic per-upload byte cap.

## Verification

- `npm run typecheck` / oxlint / oxfmt clean across app-engine,
  conversation-engine, agent-runtime, gateway, openclaw-plugin, desktop;
  `turbo run build` green for all nine packages. This covers: existing chat,
  automation, and build flows pass end to end under typecheck and the unit
  suites.
- `gateway-db.test.ts` proves a fresh runtime.sqlite has exactly
  conversations/turns/items/attachments + automation_state with no
  chat_sessions/runs/run_nodes — i.e. conversations/turns/items/attachments
  schema with CHECK constraints, no chat_sessions/runs/run_nodes — and that
  writing an unknown kind/trigger/item kind is rejected by the DB CHECK, not
  silently coerced, and that every turn has a NOT NULL FK conversation_id and
  deleting a conversation cascades to turns, items, and attachments.
- `agent-runs-store.test.ts` covers the ConversationStore CRUD + the
  message_in fold + prune/cascade; `chat-history.test.ts` proves a chat turn's
  inbound message is a message_in item at ordinal 0, not input_json, and
  getSession reconstructs uniformly from items, and that the conversation kind
  (chat vs build) round-trips.
- `automation-fire.test.ts` proves an automation fire records the same shape:
  an automation conversation with a message_in item carrying the trigger
  payload, with the token rollup on the turn.
- `blob-store.test.ts` proves a chat upload stores bytes once in the per-app
  blob CAS deduped by hash, an attachments row references the message_in item,
  and the model call receives an image/document content block — the CAS dedup
  half — and that deleting the conversation removes attachment rows and the GC
  sweep removes now-unreferenced blobs; `multimodal.test.ts` proves the
  image/document content-block construction.
- `insights-store.test.ts` proves insights/run_summary report correct per-kind
  and total token/cost after sourcing kind from the conversation.
