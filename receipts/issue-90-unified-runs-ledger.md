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
- [ ] Commit 4 — chat fold (delete `centraid-chat.sqlite`, eliminate
      `chat_messages`)
- [ ] Commit 5 — Insights backend wiring
- [ ] Commit 6 — desktop renderer (Insights data, new-automation form)

## What changed

### Step 0 spike — runner token capture (passes)

Both local runners already *receive* per-inference-call usage and
discard it: codex's `turn/completed` notification carries a `usage`
object ([`codex-app-server.ts`](../packages/agent-runtime/src/codex-app-server.ts));
the Claude Agent SDK's `result` message carries `usage` +
`total_cost_usd` ([`claude-sdk.ts`](../packages/agent-runtime/src/claude-sdk.ts)).
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

Adds [`model-pricing.ts`](../packages/runtime-core/src/model-pricing.ts) —
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

## Out of scope (so far)

- Chat fold and Insights backend / renderer — follow-up commits.
- Per-tool-call trace extraction from the agent CLI transcript (the
  turn is currently recorded as a single `step`) — wired with the
  chat runner's usage capture in the Insights commit.

## Verification

- `turbo run typecheck` / `turbo run build` — 16/16 tasks clean.
- `turbo run test` — 12/12 task green; `runtime-core` 288/288.
- `oxfmt` on the changed files — clean.
