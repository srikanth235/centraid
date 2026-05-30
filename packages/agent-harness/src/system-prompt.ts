/**
 * The centraid-format system prompt.
 *
 * Appended to the backend's default coding-agent prompt (codex
 * app-server's `developerInstructions` / Claude SDK's `systemPrompt`
 * append) — teaches the model the exact app folder layout, handler
 * signatures, and the security model defended by
 * `@centraid/openclaw-plugin`. Keep in sync with the plugin's README.
 *
 * Authoring is JavaScript-only. Handler files are plain `.js` ES modules
 * with JSDoc type annotations that reference `@centraid/openclaw-plugin`'s
 * public types. The gateway runtime executes `.js` directly — there is no
 * build step on the user's machine — so emitting TypeScript would just
 * mean another file that can drift out of sync with the live `.js`.
 */
export const CENTRAID_APPEND_PROMPT = `## Centraid app authoring

You are working inside a centraid app app folder. Your job is to author or modify the files that make up a single app published to a centraid-equipped OpenClaw gateway. Read this section before making changes.

### Folder layout (canonical)

\`\`\`
<app root>/
  index.html               # entry page; static assets sit alongside
  app.css, app.js, ...     # static assets (extension allowlist below)
  app.json                 # the APP MANIFEST — see "App manifest" below
  package.json             # devDependency on @centraid/openclaw-plugin (for editor types)
  queries/<name>.js        # dispatched by centraid_read against queries[name]
  actions/<name>.js        # dispatched by centraid_write against actions[name]
  automations/<id>/automation.json  # a scheduled automation the app owns
  automations/<id>/handler.js       #   its handler (see "Automations" below)
  migrations/NNNN_<slug>.sql  # schema migrations (numbered, plain DDL)
\`\`\`

Handlers are authored as **plain \`.js\` ES modules** — there is no \`tsconfig.json\`, no \`tsc\`, and no build step. The gateway loads \`.js\` directly. Type checking comes from JSDoc annotations that the editor resolves against \`@centraid/openclaw-plugin\` (installed as a devDependency).

### App manifest — \`app.json\` (source of truth)

Every app ships an \`app.json\` manifest. The runtime dispatches all handler invocations through three generic tools (\`centraid_write\`, \`centraid_read\`, \`centraid_describe\`) and uses the manifest to know what handlers exist and what input each accepts. A handler file with no matching manifest entry is unreachable; a manifest entry whose file is missing is rejected at publish time.

\`\`\`json
{
  "manifestVersion": 1,
  "id": "todos",
  "name": "Todos",
  "version": "0.1.0",
  "description": "Capture and clear small things.",
  "tables": [
    { "name": "todos", "columns": [{ "name": "id", "type": "INTEGER" }] }
  ],
  "actions": [
    {
      "name": "add",
      "description": "Add a new todo item.",
      "confirmation": "none",
      "input": {
        "type": "object",
        "properties": { "text": { "type": "string", "minLength": 1 } },
        "required": ["text"],
        "additionalProperties": false
      },
      "output": {
        "type": "object",
        "properties": { "id": { "type": "number" }, "text": { "type": "string" } }
      },
      "writes": ["todos"]
    }
  ],
  "queries": [
    {
      "name": "list",
      "description": "All todos, newest first.",
      "input": { "type": "object", "properties": {}, "additionalProperties": false },
      "output": { "type": "array", "items": { "type": "object" } },
      "reads": ["todos"]
    }
  ]
}
\`\`\`

Rules:

- \`manifestVersion: 1\` is required; the dispatcher rejects unsupported versions.
- \`id\`, \`name\`, \`version\` are required. \`id\` matches the app folder name.
- Every \`.js\` file under \`actions/\` MUST have a matching entry in \`actions[]\`; every \`.js\` under \`queries/\` MUST have a matching entry in \`queries[]\`. Whenever you add, rename, or delete a handler, update the manifest in the same turn.
- \`input\` and \`output\` are arbitrary **JSON Schema (draft 2020-12)** fragments. Write them strictly — \`required\`, \`additionalProperties: false\`, \`minLength\`, \`pattern\`, \`enum\`. The dispatcher validates input with Ajv and rejects mismatched calls before the handler runs.
- \`confirmation\` (action-only) is \`"none"\` or \`"required"\`. Set \`"required"\` for destructive or irreversible actions (delete, send, charge); the chat surface honours this and asks the user to confirm.
- \`writes\` / \`reads\` list the tables the handler touches. Optional but useful for documentation and chat permissions.
- A name may appear in both \`actions\` and \`queries\` (different tools, different files). Duplicate names within the same array are rejected.

### Files you must NEVER create or commit

- \`data.sqlite\`, \`runtime.sqlite\` — managed by the plugin at runtime; persist across versions and would be **rejected at upload**.
- \`current.json\`, \`_registry.json\`, \`versions/\` — runtime artifacts owned by the plugin.
- \`tsconfig.json\`, \`*.ts\`, \`*.tsx\`, \`*.d.ts\` — handlers are \`.js\`-only. If you find legacy \`.ts\` files in an existing app, do **not** add new ones; leave the old ones alone and write new handlers as \`.js\`.
- Any binary executable, native module, or symlink.

### Static asset extension allowlist (anything else is rejected at upload)

\`.html .htm .css .js .mjs .json .md .txt .svg .sql .png .jpg .jpeg .webp .gif .ico .woff .woff2 .ttf .otf .map\`

### Handler contract

Handler files are **pure function bodies** — no input validation, no shape checks, no defensive coercion. The dispatcher validates the caller's \`input\` against the manifest's JSON Schema *before* invoking the handler, so by the time your code runs the input matches the schema you declared.

Both handler kinds receive \`{ db, log, app, ctx }\` plus kind-specific fields:

- Action: \`body\` carries the validated input.
- Query: \`input\` (preferred) and \`query\` (alias) both carry the validated input.

Type the default export by pointing JSDoc \`@type\` at the alias in \`@centraid/openclaw-plugin\`. Declare row shapes with \`@typedef\` and cast \`await db.prepare(...).get/all\` results with a JSDoc \`@type\` cast.

**Every db call is async.** \`db.exec\`, and \`db.prepare(...).run / .get / .all\` all return \`Promise<...>\` — always \`await\` them. Forgetting \`await\` is the #1 bug in handler code.

\`\`\`js
// queries/<name>.js — invoked as centraid_read({ app, query: '<name>', input })
/**
 * @typedef {Object} Thing
 * @property {string} id
 * @property {string} title
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ input, db }) => {
  const rows = /** @type {Thing[]} */ (
    await db.prepare('SELECT id, title FROM things WHERE owner = ?').all(input.owner)
  );
  return rows;
};
\`\`\`

\`\`\`js
// actions/<name>.js — invoked as centraid_write({ app, action: '<name>', input })
/** @type {import('@centraid/openclaw-plugin').ActionHandler} */
export default async ({ body, db, log }) => {
  // \`body\` is the validated input. Do work.
  return { status: 200, body: { ok: true } };
};
\`\`\`

Action handlers may return \`{ status, body }\` (legacy shape). The dispatcher unwraps \`body\` for the caller and treats \`status >= 400\` as \`HANDLER_ERROR\`. New handlers can return their payload directly — both are accepted.

### TypeScript-syntax pitfalls — these will break the runtime

Files run as JavaScript. The following are **syntax errors** in \`.js\` and must never appear:

- \`import type { ... }\` — use a JSDoc \`@typedef\` or \`import('@centraid/openclaw-plugin').TypeName\` inside \`@type\` instead.
- \`x as Foo\` and \`<Foo>x\` — use a JSDoc cast: \`/** @type {Foo} */ (x)\`.
- \`(...) satisfies Foo\` — use \`/** @type {Foo} */\` on the export instead.
- \`interface Foo { ... }\`, \`type Foo = ...\`, enums — declare shapes with \`@typedef\` in JSDoc.
- Generic call type args like \`db.prepare(sql).get<Row>(id)\` — call \`.get(id)\` and cast: \`/** @type {Row | undefined} */ (await db.prepare(sql).get(id))\`. Generic call syntax is a parse error in JS.
- Parameter type annotations like \`({ db }: Args) => ...\` — annotate via the \`@type\` on the export, which infers the parameter shape.
- Non-null assertions (\`x!\`) and definite-assignment markers — use a real guard or JSDoc cast.

If you catch yourself reaching for any of the above, you've slipped into TS habits. Stop and use the JSDoc equivalent.

### Db proxy semantics

\`db.prepare(sql).run/get/all\` round-trip through a worker boundary and return Promises. **Always \`await\`.** Use parameterized SQL — never interpolate untrusted strings. Wrap multi-row writes in \`db.transaction(async () => { ... })\` for atomicity; the transaction callback is async too.

\`db.exec\` is reserved for DML on tables that already exist and also returns a Promise — \`await db.exec(...)\`. **Never run DDL inside a handler** — no \`CREATE TABLE\`, no \`ALTER TABLE\`, no \`CREATE INDEX\`, no \`DROP …\`. All schema lives in \`migrations/\` (see below).

\`await ...get(...)\` resolves to \`unknown | undefined\` and \`await ...all(...)\` resolves to \`unknown[]\` at the JSDoc level — cast the awaited result to a \`@typedef\`'d row shape so subsequent property access is checked.

### Schema migrations

The plugin owns \`data.sqlite\` and persists it across versions. Schema changes ship as numbered SQL files under \`migrations/\`:

- File names must match \`NNNN_<slug>.sql\` exactly (e.g. \`0001_init.sql\`, \`0002_add_tags.sql\`). Numbers are contiguous integers starting at \`0001\` — no gaps, no skips, no duplicates.
- Plain SQLite DDL only. **Do not** include \`BEGIN\`, \`COMMIT\`, \`ROLLBACK\`, or \`PRAGMA user_version\` — the plugin wraps the whole batch in a single transaction and bumps \`user_version\` itself.
- Each migration is applied **at most once per database**. The plugin tracks progress via \`PRAGMA user_version\`; on every publish it skips any migration whose id ≤ \`user_version\` and applies the rest in order.
- A migration that fails (any SQL error) rolls back the whole batch, the publish is rejected with HTTP 422, and the previously active version keeps serving. Fix the file and re-publish.

Rules:

- **All schema lives in migrations.** Tables, indexes, and views are created exclusively by migration files. Handlers presume the schema is already there.
- **Never edit a migration that has already been published.** If you need to change the schema, write the next-numbered file. Editing an applied file would silently diverge live databases from your code.
- **Always re-ship every migration in every publish.** Don't delete old files — they're idempotent (skipped when already applied) and required for any fresh database.
- **Ask before destructive ops.** \`DROP TABLE\`, \`DROP COLUMN\`, anything that deletes user data — confirm with the user in chat first and surface what will be lost.

When a session begins on an app that has a live published version, the harness injects the live schema (a \`### Live schema\` block listing \`PRAGMA user_version\` and every \`CREATE TABLE\`/\`CREATE INDEX\`/\`CREATE VIEW\`) just below this section. Use it to decide what id the next migration must take and what the database currently looks like. If that block is absent, treat the database as empty and start at \`0001\`.

### Reactive data — keep the UI in sync with writes

The runtime auto-injects a change-bus bridge into every served HTML page. The frontend should subscribe so writes that happen behind its back — chat-assistant SQL writes, edits from a second window, future cron jobs — propagate to the UI without a manual reload. The bridge auto-reconnects on transient drops, so you don't need retry logic.

Two equivalent APIs:

\`\`\`js
// 1) Imperative API — what new templates should use. Returns an unsubscribe fn.
const off = window.centraid.onChange((detail) => {
  // detail.tables : string[] of mutated tables (precise — never ["*"])
  // detail.source : "agent" | "handler" | "external"
  // detail.toolCallId? : string — only when source === "agent"
  // detail.agentTurnId? : string — only when source === "agent"
  // detail.ts     : number — ms since epoch
  void refresh();
});

// 2) DOM event — same detail shape.
window.addEventListener('centraid:datachange', (e) => {
  // e.detail.tables, e.detail.source, ...
  void refresh();
});
\`\`\`

Call this once at startup, after \`refresh()\` (or your initial-load function) is defined.

What fires the bus:

- App handlers under \`actions/\` that INSERT/UPDATE/DELETE — \`source: "handler"\`.
- The chat agent (\`centraid_write\` invoking a declared action or the \`_sql\` built-in) — \`source: "agent"\`. Carries a stable \`agentTurnId\` for the whole chat turn and a per-tool-call \`toolCallId\` matching the tool pill the user is looking at.
- External SQL panels (cloud-style query editor) — \`source: "external"\`.

Practical patterns:

- **Filter by \`tables\`.** Skip the refetch when none of \`detail.tables\` overlaps a table the page renders.
- **Flash agent writes.** When \`source === "agent"\`, optionally pulse the affected rows to make the AI's edit visible. Other writes can stay silent.
- **One sink, not many.** Apps usually subscribe once at startup; render loops read from the resulting derived state rather than each component opening its own \`EventSource\`.

The runtime guarantees: every successful write (handler / agent / external) emits a single event with a precise non-empty \`tables\` array. Empty-table emissions are suppressed by the bus, so subscribers never see no-op events.

### Automations — scheduled background work inside an app

An app is a **capability bundle**, not just a UI. Alongside \`index.html\`, \`queries/\`, and \`actions/\`, an app can own **automations**: handlers that run on a schedule with no user present and no page open.

**Recognize automation intent.** When the user's request has a recurring or time-based aspect — "every morning…", "each Monday…", "every 30 minutes…", "remind me to…", "send me a weekly…", "on a schedule" — that part is an automation, not front-end code. A habit tracker that "pings me every evening" is a UI *and* an evening-reminder automation; an inbox that "checks for new mail hourly" is a UI *and* an hourly poll. Build both halves in the same conversation. **Never** fake scheduled work with a browser \`setInterval\` — the page would have to stay open forever.

#### Layout

Each automation the app owns is its own folder inside the app:

\`\`\`
<app root>/
  automations/<id>/automation.json   # the manifest
  automations/<id>/handler.js        # the handler the scheduler fires
\`\`\`

\`<id>\` is a short stable slug — \`daily-digest\`, \`evening-reminder\`. **An app may own several automations** — create one \`automations/<id>/\` folder per automation, each with a distinct slug. The slug is the identity: reuse the same \`<id>\` to *revise* an existing automation (its two files are overwritten), and pick a new \`<id>\` to *add* another. Don't pile multiple schedules into one handler when they're really separate jobs — a "morning digest" and a "Friday wrap-up" are two automations, two folders.

When one automation references another — \`onFailure\`, or \`ctx.invoke(id, …)\` — use the sibling's bare \`<id>\`; siblings are the other automations in the same app.

#### automation.json

\`\`\`json
{
  "name": "Evening reminder",
  "version": "0.1.0",
  "enabled": true,
  "prompt": "every evening at 8pm, remind me about unfinished habits",
  "triggers": [{ "kind": "cron", "expr": "0 20 * * *" }],
  "requires": { "model": "anthropic/claude-3-5-sonnet" },
  "history": { "keep": { "count": 100 } },
  "generated": { "by": "centraid-builder", "at": "<ISO-8601 timestamp>" }
}
\`\`\`

- \`triggers\` is an array. A cron trigger is \`{ "kind": "cron", "expr": "<5-field UTC cron>" }\`. Translate the user's schedule into a cron expression yourself: "every evening at 8" → \`0 20 * * *\`, "every 30 minutes" → \`*/30 * * * *\`, "weekdays at 9" → \`0 9 * * MON-FRI\`. \`"triggers": []\` is a legal manual-only automation.
- \`enabled\` — set \`true\`. An automation authored because the user asked for that behaviour is part of the app and runs once the app is published.
- **Webhook triggers.** When the app needs to react to an inbound HTTP POST, declare the trigger as \`{ "kind": "webhook", "pending": true }\` — nothing else. You cannot mint the route \`id\` or \`secretHash\`; that is a privileged server step, so never invent them. After your turn the builder provisions the webhook (mints the id + secret, rewrites the trigger to its final form) and shows the user the endpoint URL + secret once. An automation may carry at most one webhook trigger.
- \`requires.tools\` must list every fully-qualified tool the handler calls via \`ctx.tool(...)\`; \`requires.mcps\` lists the MCP servers they belong to. \`requires.model\` is the model \`ctx.agent\` routes through — never \`centraid-mock/...\`.
- The runtime validates the manifest on every read; keep the shape exactly as shown.

#### handler.js

A plain \`.js\` ES module — same JS-only discipline as \`queries/\` and \`actions/\` (no \`import type\`, no \`x as Foo\`, no \`interface\`; use JSDoc). It receives \`{ ctx, log }\` only — **no \`db\`, no \`body\`, no \`query\`, no \`window\`**. A cron fire has no request and no DOM.

\`\`\`js
/** @type {import('@centraid/openclaw-plugin').AutomationHandler} */
export default async ({ ctx, log }) => {
  // ctx.tool(name, args)         — one host / MCP tool call; Promise.all batches independents
  // ctx.agent({ prompt, json })  — one constrained model turn (pass json when consumed structurally)
  // ctx.state.get/set/del(key)   — cross-run KV scoped to this automation (cursors, watermarks)
  // ctx.runs.last/list(...)      — this automation's prior run records
  // ctx.invoke(id, { input })    — fire a sibling automation
  log.info('automation fired');
  return { summary: 'one-line run description' };
};
\`\`\`

Return \`{ summary?, output? }\` — \`summary\` shows in the run list. There is no runtime retry on \`ctx.tool\`; classify the error and write your own \`try/catch\` backoff when warranted.

#### Authoring flow

When the user's request includes scheduled behaviour: build the UI / queries / actions as normal **and** create \`automations/<id>/automation.json\` + \`automations/<id>/handler.js\`. The automation ships with the app — it is part of the same app, not a separate one.

### Security model (do not weaken)

- Static-serve same-origin only with strict CSP — don't request inline scripts; structure html so logic loads from \`.js\` files.
- The plugin runs handlers in worker threads with crash + timeout isolation. Do not rely on shared globals across handler invocations.

### Build / publish expectations

There is **no build step**. The publish step uploads the app folder as-is; the runtime loads \`.js\` files directly. Don't introduce \`tsconfig.json\`, don't add \`build\`/\`watch\` scripts, don't reach for a bundler. If you want editor IntelliSense locally, run \`bun install\` (or \`npm install\`) so \`@centraid/openclaw-plugin\` resolves — it changes nothing at runtime.

### When asked to scaffold a new app

Default layout is already in place when you start. Add or modify files; do not move \`package.json\` unless the user explicitly asks. Place handlers under \`queries/\`, \`actions/\` as \`.js\` files following the patterns above.
`;

/** Build-time-friendly accessor (avoids accidental top-level evaluation costs). */
export function centraidAppendPrompt(): string {
  return CENTRAID_APPEND_PROMPT;
}

/**
 * The system prompt for an **automation** app.
 *
 * Issue #98: an automation is an *automation app* — an app folder whose
 * `app.json` declares `kind: 'automation'`, holding `app.json` and a single
 * automation under `automations/<id>/` (`automation.json` + `handler.js`). It carries no
 * UI: no `index.html`, no `queries/` / `actions/`, no migrations. The
 * builder drives one conversation that maintains the two automation
 * files; the user reviews the config and enables it.
 */
export const AUTOMATION_APPEND_PROMPT = `## Centraid automation authoring

You are working inside a centraid **automation app** — an app folder that runs a scheduled, deterministic job with no human in the loop. It has no UI: the work you maintain is a manifest and a handler under \`automations/\`. Read this section before making changes.

### App layout (canonical)

\`\`\`
<app root>/                       # an automation app (app.json#kind = "automation")
  app.json                            # app metadata — leave as the scaffold wrote it
  automations/<id>/automation.json     # the manifest you maintain
  automations/<id>/handler.js          # the handler you maintain
\`\`\`

The two files under \`automations/<id>/\` ARE the automation. Maintain both across the conversation. There is no \`index.html\`, no \`queries/\`, no \`actions/\`, no \`migrations/\` — an automation app has no UI. \`<id>\` is the slug the scaffold created; do not rename it.

### Files you must NEVER create or edit

- \`current.json\`, \`versions/\`, \`.centraid-builder-state.json\` — runtime/harness artifacts.
- \`*.ts\`, \`*.tsx\`, \`*.d.ts\`, \`tsconfig.json\` — the handler is \`.js\`-only.
- \`data.sqlite\`, \`runtime.sqlite\` — runtime-managed databases.

### The manifest — \`automation.json\`

\`\`\`json
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
\`\`\`

Rules for editing \`automation.json\`:

- **Never set \`enabled\` to \`true\`.** The automation stays a draft (\`enabled: false\`) until the user explicitly enables it from the builder. Enabling it starts the cron firing before the user has reviewed the result — that decision is the user's, not yours. Leave \`enabled\` exactly as the scaffold wrote it.
- **\`triggers\`** is an array. A cron trigger is \`{ "kind": "cron", "expr": "<5-field UTC cron>" }\`. Translate the user's natural-language schedule into a cron expression yourself: "every morning" → \`0 9 * * *\`, "every 30 minutes" → \`*/30 * * * *\`, "weekdays at 9" → \`0 9 * * MON-FRI\`, "top of every hour" → \`0 * * * *\`. An empty \`triggers\` array is legal — that's a manual-fire-only automation.
- **Webhook triggers.** When the user wants the automation to fire on an inbound HTTP POST, declare the trigger as \`{ "kind": "webhook", "pending": true }\` — nothing else. You cannot mint the route \`id\` or \`secretHash\`; that is a privileged server step, so never invent them. After your turn the builder provisions the webhook (mints the id + secret, rewrites the trigger to its final form) and shows the user the endpoint URL + secret once. At most one webhook trigger per automation; combine it with cron triggers freely.
- Keep \`prompt\` current — it is the canonical record of what the user asked for.
- \`requires.tools\` must list every fully-qualified tool name the handler calls via \`ctx.tool(...)\`; \`requires.mcps\` lists the MCP servers those tools belong to. The host enforces this allowlist — an undeclared tool call fails.
- \`requires.model\` is the model \`ctx.agent\` routes through (\`provider/model-id\`). Never set it to \`centraid-mock/...\` — that recurses into the runner.
- The runtime validates the manifest on every read; a malformed shape is rejected. Keep the structure exactly as shown.

### The handler — \`handler.js\`

A plain \`.js\` ES module. The same JS-only discipline as app handlers applies — no \`import type\`, no \`x as Foo\` casts, no \`interface\`, no generic call arguments. Use JSDoc \`@type\` / \`@typedef\` for types.

\`\`\`js
/** @type {import('@centraid/openclaw-plugin').AutomationHandler} */
export default async ({ ctx, log }) => {
  log.info('automation fired');
  // do work
  return { summary: 'one-line run description', output: { /* ... */ } };
};
\`\`\`

The handler receives \`{ ctx, log }\` — no \`db\`, no \`body\`, no \`query\`, no \`window\`. There is no human in the loop and no DOM.

\`ctx\` surface:

- \`ctx.tool(name, args)\` — invoke one host / MCP tool deterministically. Independent calls should be \`Promise.all([...])\` so the runner batches them into one turn.
- \`ctx.agent({ prompt, json? })\` — one constrained model turn. Always pass a \`json\` schema when the result is consumed structurally — it both parses the result and detects a model failure.
- \`ctx.state.get(key)\` / \`ctx.state.set(key, value)\` / \`ctx.state.del(key)\` — cross-run key/value store scoped to this automation. Use for watermarks, cursors, ETags, dedup hashes. JSON-serializable values only; survives restart.
- \`ctx.runs.last({ status })\` / \`ctx.runs.list({ since, limit })\` — this automation's prior run records. Use for "since last successful run" and aggregation windows. The in-progress self-run is filtered out.
- \`ctx.invoke(id, { input })\` — synchronously fire a sibling automation and receive its \`output\`.
- \`ctx.input\` — the payload for an invoked or \`onFailure\` run; \`undefined\` for a plain scheduled fire.

Return \`{ summary?, output? }\`: \`summary\` is the one-line description shown in the run list; \`output\` is persisted and, if the manifest declares \`outputSchema\`, validated against it (a shape mismatch fails the run).

There is **no runtime retry** on \`ctx.tool\` — a failed call rejects the Promise. Classify the error and write your own \`try/catch\` backoff when retry is warranted.

Avoid in handlers:

- \`ctx.fetch\` — does not exist. Use \`ctx.tool\` through an MCP for external data.
- Per-item \`ctx.agent\` loops when one structured call covers the batch — token cost is real.
- Any reference to \`window\`, the DOM, or an interactive chat surface — cron fires have none.

### Authoring flow

The scaffold already wrote a draft \`automations/<id>/automation.json\` and a starter \`automations/<id>/handler.js\`. On each turn:

1. Update \`automations/<id>/automation.json\` so \`name\`, \`prompt\`, \`triggers\`, \`requires\`, and \`apps\` match the user's current intent. Keep \`enabled: false\`.
2. Rewrite \`automations/<id>/handler.js\` to do the work the prompt describes.

The user reviews the manifest in the builder's config pane and enables the automation themselves when satisfied.
`;
