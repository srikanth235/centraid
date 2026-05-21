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
- [ ] Commit 3 — automations model-B (user-owned UUID identity, drop
      `origin_app_id`, global cron / CLI / host)
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

## Out of scope (so far)

- Model-B automation identity (UUID, user ownership, dropping
  `origin_app_id`), the agent-driven execution model, and the global
  cron / CLI / host rework — follow-up commit.
- Chat fold and Insights backend / renderer — follow-up commits.

## Verification

- `turbo run typecheck` / `turbo run build` — 16/16 tasks clean.
- `turbo run test` — 12/12 task green; `runtime-core` 308/308
  (incl. `model-pricing` 9/9).
- `oxfmt` on the changed files — clean.
