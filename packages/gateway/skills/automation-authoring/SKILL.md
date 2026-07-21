---
name: automation-authoring
description: How to author a centraid automation app — the automation.json manifest, the scheduled handler.js contract (ctx.vault/agent/state/runs/fetch), cron, webhook, data and condition triggers (with their required vault block), and the draft-then-enable flow. Use whenever creating or editing the files of a UI-less automation app.
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

The two files under `automations/<id>/` ARE the automation. Maintain both across the conversation. There is no `index.html`, no `queries/`, no `actions/` — an automation app has no UI. `<id>` is the slug the scaffold created; do not rename it.

### Files you must NEVER create or edit

- `current.json`, `versions/`, `.centraid-builder-state.json` — runtime/harness artifacts.
- `*.ts`, `*.tsx`, `*.d.ts`, `tsconfig.json` — the handler is `.js`-only.
- `*.sqlite`, `*.db`, `*.sql` — there are no per-app databases; all data lives in the owner's vault.

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
- **Data triggers** — fire when watched vault entities change. Declare `{ "kind": "data", "entities": ["<schema>.<table>", ...], "every": "<5-field cron>" }`. On the `every` gate (omit it for the default `* * * * *`, every minute) the host polls the vault's consented change feed (`ctx.vault.changes`) for those entities and fires with the new change entries as `ctx.input`. The cursor is a strictly time-ordered journal id persisted across evaluations and bootstrapped at the *current* watermark — a fresh watcher reacts to what happens next, never to history. Use this when a data change should provoke work: "a credit posted → reconcile the invoice", "my parked send was confirmed → resume". Example:

  ```json
  {
    "kind": "data",
    "entities": ["core.transaction"],
    "every": "*/10 * * * *"
  }
  ```

  (`outbox.*` entities cannot be watched — a drain's own receipts would re-fire the automation; validation rejects them.)
- **Condition triggers** — fire when a row matches a data-state window. Declare `{ "kind": "condition", "entity": "<schema>.<table>", "where": [{ "column", "op", "value" }], "every": "<5-field cron>" }`. On the `every` gate (omit it for the default `*/5 * * * *`, every five minutes) the host runs the declared consented read under the automation's grant and fires **once per row it has not seen before** — row-content dedup: a row that changes fires again, one that merely stays matched does not. The `op` is one of: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `is-null`, `not-null`, `within-days`, `within-next-days`. This makes "due in N days" a fire without wall-clock guesswork — the time semantics live in the data, the trigger just watches the window. Example — "invoice due in 3 days":

  ```json
  {
    "kind": "condition",
    "entity": "business.invoice",
    "where": [
      { "column": "status", "op": "eq", "value": "open" },
      { "column": "due_date", "op": "within-next-days", "value": 3 }
    ],
    "every": "0 8 * * *"
  }
  ```

- **Data/condition triggers require a `vault` block (hard rule).** A data or condition trigger *is* a consented vault read, so the manifest must carry a top-level `vault` block whose read scopes cover every watched entity — validation rejects the manifest otherwise, and at runtime the read runs under that owner-approved grant (a receipted deny disables the evaluation, it never widens it). Mirror the shape real templates use: a `purpose` (`"dpv:ServiceProvision"`), a one-line `why`, and a `scopes` array. Each scope is `{ "schema": "<schema>", "verbs": "read" }` to cover a whole domain, or add `"table": "<table>"` to narrow to one entity. For the two examples above:

  ```json
  "vault": {
    "purpose": "dpv:ServiceProvision",
    "why": "Watches new transactions to reconcile them against open invoices.",
    "scopes": [
      { "schema": "core", "verbs": "read" }
    ]
  }
  ```

  A watched entity whose schema no scope covers is an incoherent manifest — grant the covering `read` scope for every `entities[]`/`entity` you declare.
- **Which trigger?** React to a data change as it happens → **data**. A data-state time window ("due / expiring in N days") → **condition** (`within-next-days`). A wall-clock schedule ("every morning", "top of the hour") → **cron**. An inbound HTTP POST → **webhook**. Do **not** approximate data-reactivity with a cron poll that re-scans and re-diffs the vault yourself — that is exactly what data/condition triggers exist to do, with a persisted cursor and dedup the host owns. Reach for cron only when the fire is genuinely tied to the clock, not to the data.
- Keep `prompt` current — it is the canonical record of what the user asked for.
- **No tool allowlist.** Deterministic work goes through the built-in `ctx.vault` / `ctx.fetch` / `ctx.state` rails, which need no declaration — there is no `requires.tools` field (it was removed with the `ctx.tool` rail). Leave `requires` to just `model` unless you need an MCP for `ctx.agent`.
- `requires.model` is the capability tier `ctx.agent` routes through (`provider/model-id`). Pick the **cheapest tier that does the inference** — a small/cheap tier for summarize/classify/extract; reserve a stronger tier for genuinely hard reasoning. `ctx.agent` is the only billed path (see *Two cost rails* below), so the tier you declare is the per-fire cost.
- The runtime validates the manifest on every read; a malformed shape is rejected. Keep the structure exactly as shown.

### The handler — `handler.js`

A plain `.js` ES module. The same JS-only discipline as app handlers applies — no `import type`, no `x as Foo` casts, no `interface`, no generic call arguments. Use JSDoc `@type` / `@typedef` for types.

```js
/** @type {import('@centraid/automation').AutomationHandler} */
export default async ({ ctx, log }) => {
  log.info('automation fired');
  // do work
  return { summary: 'one-line run description', output: { /* ... */ } };
};
```

The handler receives `{ ctx, log }` — no `db`, no `body`, no `query`, no `window`. There is no human in the loop and no DOM.

`ctx` surface:

- `ctx.vault` — the consented vault surface (SQL reads, typed `invoke` writes, content reads) under this automation's grant. Deterministic and in-process — zero model tokens. This is how a handler reads and writes the owner's data.
- `ctx.fetch(url, init?)` — the sanctioned deterministic path to reach external HTTP. Also in-process and unbilled; use it instead of a raw `fetch(...)`.
- `ctx.agent({ prompt, json?, model? })` — one constrained, billed model turn against the user's real provider. Always pass a `json` schema when the result is consumed structurally — it both parses the result and detects a model failure.
- `ctx.state.get(key)` / `ctx.state.set(key, value)` / `ctx.state.del(key)` — cross-run key/value store scoped to this automation. Use for watermarks, cursors, ETags, dedup hashes. JSON-serializable values only; survives restart.
- `ctx.runs.last({ status })` / `ctx.runs.list({ since, limit })` — this automation's prior run records. Use for "since last successful run" and aggregation windows. The in-progress self-run is filtered out.
- `ctx.now` — the fire-start instant as an ISO string, fixed for the whole run so lease/window checks stay deterministic on replay.
- `ctx.input` — the payload this run was fired with (a webhook body, or the `onFailure` summary); `undefined` for a plain scheduled fire.

Return `{ summary?, output? }`: `summary` is the one-line description shown in the run list; `output` is persisted and, if the manifest declares `outputSchema`, validated against it (a shape mismatch fails the run).

There is **no runtime retry** on `ctx.fetch` or `ctx.agent` — a failed call rejects the Promise. Classify the error and write your own `try/catch` backoff when retry is warranted.

### Audited rails + determinism (non-negotiable)

Every outside effect **must go through the `ctx.*` surface**. `ctx.vault` / `ctx.fetch` / `ctx.agent` / `ctx.state` / `ctx.runs` calls are recorded in the run ledger (the run history you see per fire). A raw `fetch(...)` or `fs` call is **invisible to the run history** — so it never appears in a fire's trace and can't be reasoned about. Reach external HTTP with `ctx.fetch`, never a bare `fetch`.

Keep the handler **deterministic** too. A fire has no crash-resume journal: if a fire dies partway, it simply re-runs from the top. A handler that reads the wall clock or a random value produces a *different* result on that re-run and re-fires effects under fresh ids — non-idempotent and hard to dedup. So a handler **must not**:

- Read the wall clock: no `Date.now()`, no `new Date()` (argless), no `performance.now()`. (`new Date(value)` with an explicit argument is fine.)
- Use randomness: no `Math.random()`, no `crypto.randomUUID()` / `randomBytes()` / `getRandomValues()`.
- Touch ambient I/O directly: no raw `fetch(...)`, no `node:fs` / `child_process` / `net` / `http`, no `process.env` / `process.cwd()`.

There is no `ctx.random()` / `ctx.uuid()` — get these needs deterministically instead:

- **"Now"** → use the fixed `ctx.now` fire instant. **"Since last run"** → derive from `ctx.runs.last({ status: 'ok' })` (its `startedAt`/`endedAt`) or a watermark in `ctx.state`.
- **A unique/derived id** → derive it from the run's inputs (`ctx.input`, `ctx.state`, a `ctx.vault` / `ctx.fetch` result), or have the vault mint it.

**Pure JS between `ctx.*` calls is free** — loops, conditionals, filters, maps, string/JSON shaping. Put as much work there as possible. The builder's publish gate runs a static lint for these patterns, so an unsafe handler is rejected at publish time, not discovered at fire time — keep the handler clean.

### Two cost rails

- **Deterministic rails are free.** `ctx.vault`, `ctx.fetch`, `ctx.state`, and `ctx.runs` are serviced parent-side, in-process, by the gateway — **zero model tokens, zero child processes, zero HTTP servers**, on every runner kind. A fire whose handler never calls `ctx.agent` cannot bill anything. Prefer these (plus plain JS) for anything that doesn't need judgment: reading/writing vault data, fetching external HTTP, listing, filtering, shaping.
- **`ctx.agent` is the only billed path.** It is a bounded one-shot turn against the user's real provider. Reserve it for genuine inference — summarize, classify, extract, draft. Don't reach for it to do work a `ctx.vault` / `ctx.fetch` call or a deterministic JS transform already covers. When you do use it, pass a `json` schema and batch (one structured call over the whole set, never a per-item `ctx.agent` loop), and declare the cheapest sufficient `requires.model` tier.

The publish gate lints for the removed `ctx.tool` rail: a handler that calls it fails with *"ctx.tool was removed: handlers do deterministic work with ctx.vault / ctx.fetch / ctx.state, and delegate judgment to ctx.agent."*

Also avoid in handlers:

- Any reference to `window`, the DOM, or an interactive chat surface — cron fires have none.

### Authoring flow

The scaffold already wrote a draft `automations/<id>/automation.json` and a starter `automations/<id>/handler.js`. On each turn:

1. Update `automations/<id>/automation.json` so `name`, `prompt`, `triggers`, `requires`, and `apps` match the user's current intent. Keep `enabled: false`.
2. Rewrite `automations/<id>/handler.js` to do the work the prompt describes.

The user reviews the manifest in the builder's config pane and enables the automation themselves when satisfied.
