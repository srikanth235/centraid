# @centraid/automation-engine

The automation **domain** — one home for everything an automation is, minus
the parts that belong to other layers.

It owns:

- **Manifest** (`automation.json`) — schema, validator, cron/webhook trigger
  helpers, output-schema validation.
- **On-disk model** — the `<appCodeDir>/automations/<id>/` layout, the
  globally-unique `<appId>/<id>` handle (`automation-ref`), and reads/writes.
- **Fire spine** — `runAutomationFire` plus the `OpenAutomationDispatch`
  (`openDispatch`) seam: resolve the automation, open its ledger row, run
  `handler.js` in a worker thread against a host-injected dispatch surface,
  cascade `onFailure`.
- **Host interface + scheduling** — the `AutomationHost` contract that every
  "thing that fires automations on a schedule" implements.
- **Webhook ingress** and the **automation-app scaffolders**.

## What it depends on

`@centraid/app-engine` only — for the per-app engine primitives and the
shared **agent-run ledger** (`AgentRunsStore`, the run schema, analytics).

It is **backend-agnostic by construction**: execution (`openDispatch`) and
scheduling (`fire`) are injected callbacks, so this package never imports an
agent backend. `@centraid/agent-runtime` supplies the local execution
surface (`runAutomationLocal` implements `openDispatch`); `@centraid/openclaw-plugin`
is the cloud host; `@centraid/gateway` wires them together.

```
agent-runtime ─▶ @centraid/automation-engine ─▶ app-engine
gateway / openclaw-plugin ─▶ @centraid/automation-engine ─▶ app-engine
```

No cycles: `@centraid/automation-engine` never imports `agent-runtime`.
