# @centraid/conversation-engine

The backend-agnostic **run engine** — one home for the two runners that sit
over the shared run ledger. A chat run is one model-driven turn; an automation
fire is a script-driven fan-out of many. They differ on driver and fan-out,
not on substance, so they live together here; the actual model turn is always
injected (`RunTurnFn`), never imported.

It owns:

- **Chat-runner core** — `makeChatRunnerCore`, the per-turn chat spine. The
  data-only `makeChatRunner` (agent-runtime) and the gateway's
  `makeUnifiedChatRunner` are thin configs over it, each injecting a
  `RunTurnFn` (codex/claude `runAgentTurn`).
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

It is **backend-agnostic by construction**: the model turn (`runTurn`),
execution (`openDispatch`), and scheduling (`fire`) are all injected
callbacks, so this package never imports an agent backend.
`@centraid/agent-runtime` supplies the local codex/claude backend
(`runAgentTurn`, and `runAutomationLocal` implementing `openDispatch`);
`@centraid/openclaw-plugin` is the cloud host; `@centraid/gateway` wires them
together.

```
agent-runtime ─▶ @centraid/conversation-engine ─▶ app-engine
gateway / openclaw-plugin ─▶ @centraid/conversation-engine ─▶ app-engine
```

No cycles: `@centraid/conversation-engine` never imports `agent-runtime`.
