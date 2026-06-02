---
name: automation-authoring
description: How to author a centraid automation app — the automation.json manifest, the scheduled handler.js contract (ctx.tool/agent/state/runs), cron and webhook triggers, and the draft-then-enable flow. Use whenever creating or editing the files of a UI-less automation app.
---
## Centraid automation authoring

You are working inside a centraid **automation app** — an app folder that runs a scheduled, deterministic job with no human in the loop. It has no UI: the work you maintain is a manifest and a handler under `automations/`. Read this section before making changes.

### App layout (canonical)

```
<app root>/                       # an automation app (app.json#kind = "automation")
  app.json                            # app metadata — leave as the scaffold wrote it
  automations/<id>/automation.json     # the manifest you maintain
  automations/<id>/handler.js          # the handler you maintain
```

The two files under `automations/<id>/` ARE the automation. Maintain both across the conversation. There is no `index.html`, no `queries/`, no `actions/`, no `migrations/` — an automation app has no UI. `<id>` is the slug the scaffold created; do not rename it.

### Files you must NEVER create or edit

- `current.json`, `versions/`, `.centraid-builder-state.json` — runtime/harness artifacts.
- `*.ts`, `*.tsx`, `*.d.ts`, `tsconfig.json` — the handler is `.js`-only.
- `data.sqlite`, `runtime.sqlite` — runtime-managed databases.

### The manifest — `automation.json`

```json
{
  "name": "Daily PR digest",
  "version": "0.1.0",
  "description": "Summarize new PRs each morning.",
  "enabled": false,
  "prompt": "every morning, summarize new PRs in foo/bar",
  "triggers": [{ "kind": "cron", "expr": "0 9 * * *" }],
  "requires": {
    "mcps": ["github"],
    "tools": ["github.list_pull_requests"],
    "model": "anthropic/claude-3-5-sonnet"
  },
  "apps": ["my-app"],
  "outputSchema": {
    "type": "object",
    "properties": { "summary": { "type": "string" } },
    "required": ["summary"]
  },
  "onFailure": "alert-me",
  "history": { "keep": { "count": 100 } },
  "costEstimate": { "model": "anthropic/claude-3-5-sonnet", "tokensPerFire": 5000 },
  "generated": { "by": "centraid-builder", "at": "<ISO-8601 timestamp>" }
}
```

Rules for editing `automation.json`:

- **Never set `enabled` to `true`.** The automation stays a draft (`enabled: false`) until the user explicitly enables it from the builder. Enabling it starts the cron firing before the user has reviewed the result — that decision is the user's, not yours. Leave `enabled` exactly as the scaffold wrote it.
- **`triggers`** is an array. A cron trigger is `{ "kind": "cron", "expr": "<5-field UTC cron>" }`. Translate the user's natural-language schedule into a cron expression yourself: "every morning" → `0 9 * * *`, "every 30 minutes" → `*/30 * * * *`, "weekdays at 9" → `0 9 * * MON-FRI`, "top of every hour" → `0 * * * *`. An empty `triggers` array is legal — that's a manual-fire-only automation.
- **Webhook triggers.** When the user wants the automation to fire on an inbound HTTP POST, declare the trigger as `{ "kind": "webhook", "pending": true }` — nothing else. You cannot mint the route `id` or `secretHash`; that is a privileged server step, so never invent them. After your turn the builder provisions the webhook (mints the id + secret, rewrites the trigger to its final form) and shows the user the endpoint URL + secret once. At most one webhook trigger per automation; combine it with cron triggers freely.
- Keep `prompt` current — it is the canonical record of what the user asked for.
- `requires.tools` must list every fully-qualified tool name the handler calls via `ctx.tool(...)`; `requires.mcps` lists the MCP servers those tools belong to. The host enforces this allowlist — an undeclared tool call fails.
- `requires.model` is the model `ctx.agent` routes through (`provider/model-id`). Never set it to `centraid-mock/...` — that recurses into the runner.
- The runtime validates the manifest on every read; a malformed shape is rejected. Keep the structure exactly as shown.

### The handler — `handler.js`

A plain `.js` ES module. The same JS-only discipline as app handlers applies — no `import type`, no `x as Foo` casts, no `interface`, no generic call arguments. Use JSDoc `@type` / `@typedef` for types.

```js
/** @type {import('@centraid/openclaw-plugin').AutomationHandler} */
export default async ({ ctx, log }) => {
  log.info('automation fired');
  // do work
  return { summary: 'one-line run description', output: { /* ... */ } };
};
```

The handler receives `{ ctx, log }` — no `db`, no `body`, no `query`, no `window`. There is no human in the loop and no DOM.

`ctx` surface:

- `ctx.tool(name, args)` — invoke one host / MCP tool deterministically. Independent calls should be `Promise.all([...])` so the runner batches them into one turn.
- `ctx.agent({ prompt, json? })` — one constrained model turn. Always pass a `json` schema when the result is consumed structurally — it both parses the result and detects a model failure.
- `ctx.state.get(key)` / `ctx.state.set(key, value)` / `ctx.state.del(key)` — cross-run key/value store scoped to this automation. Use for watermarks, cursors, ETags, dedup hashes. JSON-serializable values only; survives restart.
- `ctx.runs.last({ status })` / `ctx.runs.list({ since, limit })` — this automation's prior run records. Use for "since last successful run" and aggregation windows. The in-progress self-run is filtered out.
- `ctx.input` — the payload this run was fired with (a webhook body, or the `onFailure` summary); `undefined` for a plain scheduled fire.

Return `{ summary?, output? }`: `summary` is the one-line description shown in the run list; `output` is persisted and, if the manifest declares `outputSchema`, validated against it (a shape mismatch fails the run).

There is **no runtime retry** on `ctx.tool` — a failed call rejects the Promise. Classify the error and write your own `try/catch` backoff when retry is warranted.

Avoid in handlers:

- `ctx.fetch` — does not exist. Use `ctx.tool` through an MCP for external data.
- Per-item `ctx.agent` loops when one structured call covers the batch — token cost is real.
- Any reference to `window`, the DOM, or an interactive chat surface — cron fires have none.

### Authoring flow

The scaffold already wrote a draft `automations/<id>/automation.json` and a starter `automations/<id>/handler.js`. On each turn:

1. Update `automations/<id>/automation.json` so `name`, `prompt`, `triggers`, `requires`, and `apps` match the user's current intent. Keep `enabled: false`.
2. Rewrite `automations/<id>/handler.js` to do the work the prompt describes.

The user reviews the manifest in the builder's config pane and enables the automation themselves when satisfied.
