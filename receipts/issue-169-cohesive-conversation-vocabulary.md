# issue-169 — Cohesive conversation vocabulary for the run ledger

GitHub issue: [#169](https://github.com/srikanth235/centraid/issues/169)

Aligns the automation + chat vocabulary on one cohesive model —
**`conversation ⊃ run ⊃ turn ⊃ node`**. Pre-release v0, so DB
table/column renames are free (no migration shim).

**Decision update vs the original issue:** the issue proposed mirroring the
OpenAI Responses API (rename `run_nodes → items`, item discriminator
`kind → type`). On review we decided **not to chase the OpenAI convention** —
the existing `node` / `run_nodes` / `kind` ledger names are kept because they
are the house style and keep the discriminator symmetric with `runs.kind`
(and avoid a `type`-vs-event-`type` collision on the stream events). So the
Tier 1 "ledger rename" is intentionally dropped; what lands is the
`conversation` container, the cohesive layered model in the docs, and the
subagent framing for `ctx.invoke`.

## Checklist

- [x] Conversation container — chatSessionId → conversationId (+ conversationId on runs)
- [x] Docs adopt conversation ⊃ run ⊃ turn ⊃ node + subagent framing for ctx.invoke
- [x] Ledger node / run_nodes / kind names kept (no OpenAI rename); run, ctx.agent, ctx.invoke unchanged

## What changed

### Conversation container — chatSessionId → conversationId (+ conversationId on runs)

Every run now names its durable conversation (`conversation ⊃ run`); the
`run` activation noun is retained.

- **`chatSessionId` → `conversationId`** across `chat-runner.ts`,
  `chat-history.ts`, `chat-history-sql.ts`, `chat-routes.ts`,
  `agent-runs-store{,-sql}.ts`, `agent-runs-schema.ts`, `runtime.ts`, plus
  the desktop chat client (`gateway-client-chat.ts`, `app-chat.ts`,
  `builder.ts`) and the openclaw chat runner. Validators/locks rename too
  (`isValidConversationId`, `withConversationLock`, `conversationLocks`).
- **Column `runs.chat_session_id` → `runs.conversation_id`** (index
  `idx_runs_conversation`); `conversationId` is now present on runs.
- **`conversationId` on automation runs**: a fire's conversation is the
  automation id (the conversation spans all the automation's fires) — set in
  `automation-handler-runner.ts`.
- **Polymorphic column, no FK**: because `conversation_id` holds a
  chat-session id OR an automation id, its old `→ chat_sessions(id)` FK is
  dropped; the chat-session → runs cascade moves into
  `ChatHistoryStore.deleteSession` (run_nodes still cascade off the kept
  `run_nodes.run_id → runs.id` FK). `chat_sessions` keeps its name (it holds
  chat-specific conversation metadata: title, adapter handle, turn count).

### Docs adopt conversation ⊃ run ⊃ turn ⊃ node + subagent framing for ctx.invoke

No code change — terminology + framing only, on the existing `node` names.

- **`ARCHITECTURE.md`** gains a "Runtime model" section laying out
  `conversation ⊃ run ⊃ turn ⊃ node`, the `prompt` definition layer, the
  driver/trigger/fan-out axes, and the **subagent / sub-conversation**
  framing for `ctx.invoke` (call-and-return, not a handoff).
- **`docs/automations/handler.mdx`** — `ctx.invoke` documented as a
  subagent / child conversation.
- **`docs/automations/run-history.mdx`** — opens with the
  `conversation ⊃ run ⊃ turn ⊃ node` model and documents the new
  `conversation_id` column on `runs`.

### Ledger node / run_nodes / kind names kept (no OpenAI rename); run, ctx.agent, ctx.invoke unchanged

The unit-of-record stays `run_nodes` / `node` with a `kind` discriminator —
no rename to OpenAI's `items` / `type`. The `run` activation noun and the
`ctx.agent` / `ctx.invoke` handler verbs are untouched; the trigger /
schedule vocabulary stays Centraid-only.

## Out of scope

- **OpenAI value/name alignment** (`run_nodes → items`, `kind → type`,
  `message`/`function_call`/`reasoning`/`compaction` item types): deliberately
  **not** adopted — `node`/`kind`/`step`/`tool`/`agent`/`invoke` are clearer
  for Centraid's model and match the house style.
- A materialized `turn` layer (a `turnId` grouping a `ctx.agent` round + its
  tool round-trips) — `turn` stays a documented concept; nodes are flat.
- UI copy / labels and deeper doc prose (e.g. chat "window" wording).

## Verification

- `bunx turbo run typecheck` green (19/19). Full suites green —
  `app-engine` 307, `automation-engine` 85, `gateway` 83, `agent-runtime`
  40, `openclaw-plugin` 6 (16/16 turbo `test` tasks pass). `oxlint` (0/0) +
  `oxfmt --check` clean; `no-broken-internal-doc-links` green.
- Conversation container: the chat-session delete cascade is preserved via
  `ChatHistoryStore.deleteSession`; `gateway-db.test.ts` asserts `runs`
  declares no FK and that `run_nodes` still cascade off `runs`. `run` is
  retained as the activation unit.
- Pure behaviour-preserving change beyond populating `conversation_id` on
  runs; `run`, `ctx.agent`, `ctx.invoke` unchanged.
