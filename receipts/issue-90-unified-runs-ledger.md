# issue-90 — Unify chat, automations & Insights onto a single agent-run ledger

GitHub issue: [#90](https://github.com/srikanth235/centraid/issues/90)

Chat, automations, and the Insights screen each carried an app-scoping
assumption that no longer holds. This issue consolidates chat turns,
automation fires, and builder iterations onto a single **agent-run
ledger** (`runs` / `run_nodes`) that also powers Insights. It is a
multi-commit structural migration; v0 — migrations edited in place, no
backfill.

## Checklist

- [x] Step 0 spike — runner token capture
- [x] Commit 1 — generalize the run-audit ledger
- [x] Commit 2 — per-model token pricing
- [x] Commit 3 — automations model-B
- [x] Commit 4 — chat fold
- [x] Commit 5 — Insights backend wiring
- [x] Commit 6 — Insights renderer
- [ ] Commit 7 — automations renderer model-B + new-automation form

## What changed

### Step 0 spike — runner token capture (passes)

Both local runners already *receive* per-inference-call usage and
discard it: codex's `turn/completed` notification carries a `usage`
object ([`codex-app-server.ts`](../packages/agent-runtime/src/backends/codex/backend.ts));
the Claude Agent SDK's `result` message carries `usage` +
`total_cost_usd` ([`claude-sdk.ts`](../packages/agent-runtime/src/backends/claude/backend.ts)).
The gap is plumbing only — `ChatStreamEvent` has no usage-bearing
variant. The ledger design is viable; wiring the capture is scheduled
for the Insights-backend commit.

### Commit 1 — generalize the run-audit ledger

Renames `centraid-automations.sqlite` → `centraid-activity.sqlite` and
generalizes the issue-#80 run-audit tables:

- `automation_runs` → `runs` — adds a `kind` discriminator
  (chat / automation / build), `chat_session_id` + `app_id` for
  non-automation runs, `note` + `retry_of`, and a denormalized
  token/cost rollup (`total_input/output/cache_read/cache_write_tokens`,
  `total_cost_usd`, `step_count`, `tool_count`). The rollup is written
  at finish from the run's own `step`/`agent` nodes — **exclusive** of
  child `invoke` runs, so a SUM over every run is the true grand total
  with no double-count (resolves open question 2).
- `automation_run_nodes` → `run_nodes` — adds the genuinely-new
  `kind='step'` node for primary model-inference calls, carrying
  per-call `input/output/cache_read/cache_write_tokens`,
  `model` / `provider`, and a write-time-frozen `cost_usd` (NULL = no
  price known, distinct from a genuine $0 — resolves open question 4).
- `AUTOMATION_MIGRATIONS` / `openAutomationDb` / `makeAutomationDbProvider`
  → `ACTIVITY_*` equivalents, with consumers updated across
  `runtime-core`, `agent-runtime`, `openclaw-plugin`, and the desktop
  main process.

Automation identity stays app-scoped (`origin_app_id`, `name`) for this
commit so the change compiles and tests pass without touching cron / CLI
/ host. The `AutomationRunsStore` API keeps its field names
(`runId`, `nodeId`, `triggerKind`, …) so handler / ctx / CLI consumers
are unchanged; new ledger fields are additive and optional.

### Commit 2 — per-model token pricing

Adds [`model-pricing.ts`](../packages/app-engine/src/model-pricing.ts) —
a USD-per-million-token price table (`priceForModel`) and a
`costForUsage(model, usage)` converter the ledger uses to freeze
`run_nodes.cost_usd` at write time. An unknown model returns `undefined`
(→ stored NULL), keeping "no price known" distinct from a genuine $0
(resolves open question 4). Longest-prefix matching so `gpt-5-codex`
beats `gpt-5`; provider prefixes are stripped before lookup. Exported
from `@centraid/runtime-core` for the runner-capture and Insights
commits to consume; covered by `model-pricing.test.ts`.

### Commit 3 — automations model-B

Re-architects automations onto a user-owned UUID identity and replaces
the issue-#80 JS-handler engine with an agent-driven execution model.

- **Identity.** `automations` is keyed by a UUID `id` with a `user_id`
  owner (`name` unique per user); `origin_app_id` is dropped from the
  table, the `runs` ledger (now `automation_id`), and `automation_state`
  (now keyed `(automation_id, key)`). `AutomationStore` becomes
  user-scoped (`create` / `upsert` / `getByName` / `listByUser`);
  `AutomationRunsStore` becomes a single global ledger keyed by
  `automation_id` — no app binding, no `forApp`.
- **Agent-driven execution.** The generated `actions/<name>.js` handler,
  the worker thread, and the `ctx.tool` / `ctx.agent` / `ctx.state` /
  `ctx.invoke` surface are deleted (`automation-handler-runner.ts`,
  `automation-handler-ctx.ts`, `automation-handler-audit.ts`,
  `worker/automation-runner.ts`). A fire is now an agent turn driven by
  the manifest prompt: new `automation-agent-runner.ts` owns the ledger
  side (opens the `runs` row, records `step` / `tool` nodes with token
  usage + frozen `cost_usd`, applies retention) and consumes a
  host-supplied `AutomationAgentDispatcher`. The manifest loses its
  `action` field.
- **Global cron / CLI / host.** `AutomationHost` drops the per-app
  reconcile scope (`unregister(automationId)`, global `reconcile`); the
  OS scheduler keys jobs `com.centraid.<automationId>` and the CLI verb
  is `run-automation <automationId>`. The openclaw cron job name is
  `centraid:<automationId>`. agent-runtime and openclaw each implement
  the agent dispatcher against their backend (codex/claude CLI locally,
  the simple-completion runtime on the gateway). App upload no longer
  syncs automations; `syncAutomationsFromDisk` is a global per-user scan.

### Commit 4 — chat fold

Deletes the `centraid-chat.sqlite` file and the `chat_messages` table;
a chat turn is now a `runs` row and its transcript is `run_nodes`.

- **Schema.** `CHAT_MIGRATIONS` / `openChatDb` / `makeChatDbProvider` are
  removed. `chat_sessions` moves into the activity DB
  (`ACTIVITY_MIGRATIONS` step 1→2), losing `origin_app_id` — chat is now
  a flat per-user store; `appId` is per-turn context only.
  `runs.chat_session_id` becomes a real same-file FK
  (`ON DELETE CASCADE`), so deleting a session drops its turns and their
  cascading `run_nodes`.
- **Runner-driven persistence.** The `/centraid/<id>/_chat` route folds
  the runner's `ChatStreamEvent`s into the ledger: each tool call is a
  `run_nodes.kind='tool'` row, the assistant reply (or the turn error) a
  `kind='step'` row, and the whole turn one `runs` row
  (`kind='chat'`, `trigger='interactive'`). The renderer no longer
  POSTs the transcript — the `POST /_centraid-chat/sessions/<id>/messages`
  append route and `ChatHistoryStore.appendMessages` are gone. Step-node
  token columns stay NULL until the runner-capture commit; choosing
  `step`/`tool` kinds (not a new `message` kind) means that commit
  enriches the same rows instead of writing a parallel trace.
- **Store.** `ChatHistoryStore` wraps the activity DB. `getSession`
  reconstructs the renderer transcript out of `runs` + `run_nodes` via
  the new `AutomationRunsStore.listChatRuns`; `recordTurn` writes the
  trace and back-fills an empty session title from the first user
  message. `listSessions` / `createSession` drop their `appId`
  parameter. Desktop main (`chat.ts`, `chat-history-client.ts`) and both
  hosts (`local-runtime.ts`, openclaw `index.ts`) are updated to the
  activity-provider + no-append shapes; the desktop derives the session
  title client-side at create time.

### Commit 5 — Insights backend wiring

Wires runner token capture for chat turns and adds the read-only
analytics layer the Insights screen reads.

- **Runner token capture (chat).** `ChatStreamEvent` gains a `usage`
  variant. The codex adapter emits it from the `turn/completed`
  notification's usage object (`readCodexUsage`, read defensively across
  codex versions); the Claude SDK adapter emits it from the `result`
  message's `usage` block (`readClaudeUsage`), tagged with the model
  seen on assistant messages. The chat route folds the turn's `usage`
  event into the `kind='step'` node, and `ChatHistoryStore.recordTurn`
  freezes `cost_usd` via `costForUsage` — so chat turns now carry the
  same per-step token + cost accounting automation fires already had.
- **`InsightsStore`.** New read-only store over the activity DB
  ([`insights-store.ts`](../packages/app-engine/src/insights/insights-store.ts)).
  `summary({ windowDays })` returns the whole screen in one read: KPIs
  (tokens / cost / forecast / generations / retries / apps-touched, plus
  a placeholder `quotaTokens` constant), a daily consumption series, a
  by-automation breakdown (chat / build runs collapse into synthetic
  buckets), a by-model breakdown over `step`/`agent` nodes, and a
  recent-activity feed. KPIs sum the `runs.total_*` rollup — exclusive
  of child `invoke` sub-runs, so the grand total never double-counts.
- **IPC.** A single `INSIGHTS_SUMMARY` channel + `getInsightsSummary`
  preload method returns the `CentraidInsightsSummary` payload; covered
  by `insights-store.test.ts`.

### Commit 6 — Insights renderer

Replaces the desktop Insights screen's hardcoded mock data with a live
bind to the `getInsightsSummary` IPC.

- `renderInsights` becomes async: it fetches `CentraidInsightsSummary`
  and renders the KPI row (tokens vs. quota meter, spend, forecast,
  apps-touched, generations + retries), the daily-consumption line
  chart, a "By source" breakdown (automations plus chat / build
  buckets), a "By model" breakdown, and the recent-activity feed — all
  from the unified run ledger. Empty states cover a ledger with no runs.
- The mock `InsAppRow` / `InsModelRow` / `InsActivityRow` fixtures and
  the now-unused `insAppTile` / `insSparkline` / `insDelta` helpers are
  deleted; the filter chips (never wired) collapse to a static window
  label. `CentraidInsights*` types are added to `centraid-api.d.ts`.

## Out of scope (so far)

- Automations renderer model-B migration + new-automation form —
  Commit 7. The desktop Automations screen still assumes the pre-#90
  app-scoped automation shapes.
- OpenClaw chat runner usage capture — the openclaw `ChatRunner` does
  not emit a `usage` event, so openclaw chat turns record NULL token
  columns. The codex / Claude local runners are covered.
- Per-tool-call trace extraction from the agent CLI transcript (an
  automation turn is still recorded as a single `step`).

## Verification

- `turbo run typecheck` / `turbo run build` — 16/16 tasks clean.
- `turbo run test` — 12/12 task green; `runtime-core` 292/292.
- `oxfmt` + `oxlint` on the changed files — clean.
- Insights renderer verified by typecheck + the desktop build; the
  live screen was not exercised in an Electron session.
