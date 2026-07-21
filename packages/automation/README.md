# @centraid/automation

The backend-agnostic **automation engine** — the automation domain that
surrounds the fire spine. An automation fire runs a deterministic `handler.js`
over the shared conversation ledger; the deterministic rails (`ctx.vault`,
`ctx.fetch`, `ctx.state`, `ctx.runs`, `ctx.input`) are serviced parent-side
in-process, and the one billed rail, `ctx.agent`, is injected via
`openDispatch`, never imported. (Its sibling, the single-turn chat-runner
core, lives in `@centraid/app-engine` next to the `ConversationRunner`
interface.)

Its public API drops the `Automation*` prefix — the package name already
carries it — so consumers import it namespaced (`import * as automation from
'@centraid/automation'`) and read `automation.Manifest`, `automation.runFire`,
`automation.list()`, etc.

It owns:

- **Fire spine** — `runFire` plus the `OpenDispatch` (`openDispatch`) seam:
  resolve the automation, open its execution conversation + turn in the
  ledger, run `handler.js` in a worker thread against the host-injected
  dispatch surface, cascade `onFailure`. The dispatch surface injects only
  `ctx.agent` (a bounded one-shot billed turn routed through the ACP backend);
  the deterministic rails are parent-side in-process and spend no tokens.
- **Manifest** (`automation.json`) — `Manifest` schema, validator, cron/webhook
  trigger helpers, output-schema validation.
- **On-disk model** — the `<appCodeDir>/automations/<id>/` layout, the
  globally-unique `<appId>/<id>` handle (`Ref`), and reads/writes (`list`,
  `readAppAt`, …).
- **Host interface + scheduling** — the `Host` contract that every "thing that
  fires automations on a schedule" implements.
- **Webhook ingress** and the **app scaffolders** (`scaffoldApp`).

## What it depends on

`@centraid/app-engine` (and `@centraid/blueprints`) only — for the per-app
engine primitives and the shared **conversation ledger** (`ConversationStore`,
the `conversation ⊃ turn ⊃ item` schema, analytics). The dispatch surface a
fire runs against — `ToolDispatcher` + `AgentDispatcher`, bundled as a
`DispatchSurface` — is the injected contract, defined here, not imported from
a backend.

It is **backend-agnostic by construction**: execution (`openDispatch`) and
scheduling (the `Host`'s `fire`) are injected callbacks, so this package never
imports an agent backend. `@centraid/agent-runtime` supplies the local
codex/claude backend (`runAutomation`, which builds the `openDispatch`
closure); `@centraid/gateway` wires it together.

```
agent-runtime ─▶ @centraid/automation ─▶ app-engine
gateway ─▶ @centraid/automation ─▶ app-engine
```

No cycles: `@centraid/automation` never imports `agent-runtime`.
