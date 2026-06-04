# @centraid/automation-engine

The backend-agnostic **automation engine** — the automation domain that
surrounds the fire spine. An automation fire is a script-driven fan-out of
many model turns over the shared run ledger; the actual model turn is always
injected (`RunTurnFn`), never imported. (Its sibling, the single-turn
chat-runner core, lives in `@centraid/app-engine` next to the
`ConversationRunner` interface.)

It owns:

- **Fire spine** — `runAutomationFire` plus the `OpenAutomationDispatch`
  (`openDispatch`) seam: resolve the automation, open its ledger row, run
  `handler.js` in a worker thread against a host-injected dispatch surface,
  cascade `onFailure`. Includes the mock-LLM server + persistent session that
  make `ctx.tool` token-free.
- **Manifest** (`automation.json`) — schema, validator, cron/webhook trigger
  helpers, output-schema validation.
- **On-disk model** — the `<appCodeDir>/automations/<id>/` layout, the
  globally-unique `<appId>/<id>` handle (`automation-ref`), and reads/writes.
- **Host interface + scheduling** — the `AutomationHost` contract that every
  "thing that fires automations on a schedule" implements.
- **Webhook ingress** and the **automation-app scaffolders**.

## What it depends on

`@centraid/app-engine` only — for the per-app engine primitives, the shared
**agent-run ledger** (`AgentRunsStore`, the run schema, analytics), and the
**agent-turn contract** (`RunTurnFn`, `AgentTurnInput`, `ToolContext`).

It is **backend-agnostic by construction**: execution (`openDispatch`) and
scheduling (`fire`) are injected callbacks, so this package never imports an
agent backend. `@centraid/agent-runtime` supplies the local codex/claude
backend (`runAutomationLocal` implementing `openDispatch`);
`@centraid/openclaw-plugin` is the cloud host; `@centraid/gateway` wires them
together.

```
agent-runtime ─▶ @centraid/automation-engine ─▶ app-engine
gateway / openclaw-plugin ─▶ @centraid/automation-engine ─▶ app-engine
```

No cycles: `@centraid/automation-engine` never imports `agent-runtime`.
