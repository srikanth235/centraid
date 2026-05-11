/**
 * The centraid-format system prompt.
 *
 * Appended to pi's default coding-agent prompt — it teaches the model the
 * exact app folder layout, handler signatures, and the security model
 * defended by `@centraid/openclaw-plugin`. Keep this in sync with the
 * plugin's README.
 *
 * Authoring is JavaScript-only. Handler files are plain `.js` ES modules
 * with JSDoc type annotations that reference `@centraid/openclaw-plugin`'s
 * public types. The gateway runtime executes `.js` directly — there is no
 * build step on the user's machine — so emitting TypeScript would just
 * mean another file that can drift out of sync with the live `.js`.
 */
export const CENTRAID_APPEND_PROMPT = `## Centraid app authoring

You are working inside a centraid app project folder. Your job is to author or modify the files that make up a single app published to a centraid-equipped OpenClaw gateway. Read this section before making changes.

### Folder layout (canonical)

\`\`\`
<project root>/
  index.html               # entry page; static assets sit alongside
  app.css, app.js, ...     # static assets (extension allowlist below)
  app.json                 # optional metadata: { "name", "version" }
  package.json             # devDependency on @centraid/openclaw-plugin (for editor types)
  queries/<name>.js        # GET /centraid/<id>/_data/<name> handler
  actions/<name>.js        # POST /centraid/<id>/_run handler (body.action picks)
  crons/<name>.js          # schedule + task + ingest handler in one module
  migrations/NNNN_<slug>.sql  # schema migrations (numbered, plain DDL)
\`\`\`

Handlers are authored as **plain \`.js\` ES modules** — there is no \`tsconfig.json\`, no \`tsc\`, and no build step. The gateway loads \`.js\` directly. Type checking comes from JSDoc annotations that the editor resolves against \`@centraid/openclaw-plugin\` (installed as a devDependency).

### Files you must NEVER create or commit

- \`data.sqlite\` — managed by the plugin at runtime; persists across versions and would be **rejected at upload**.
- \`current.json\`, \`_registry.json\`, \`versions/\` — runtime artifacts owned by the plugin.
- \`tsconfig.json\`, \`*.ts\`, \`*.tsx\`, \`*.d.ts\` — handlers are \`.js\`-only. If you find legacy \`.ts\` files in an existing project, do **not** add new ones; leave the old ones alone and write new handlers as \`.js\`.
- Any binary executable, native module, or symlink.

### Static asset extension allowlist (anything else is rejected at upload)

\`.html .htm .css .js .mjs .json .md .txt .svg .sql .png .jpg .jpeg .webp .gif .ico .woff .woff2 .ttf .otf .map\`

### Handler contract

All three handler kinds receive \`{ db, log, app, ctx }\` plus kind-specific fields. Type the default export by pointing JSDoc \`@type\` at the alias in \`@centraid/openclaw-plugin\`. Declare row shapes with \`@typedef\` and cast \`db.prepare(...).get/all\` results with a JSDoc \`@type\` cast.

\`\`\`js
// queries/<name>.js
/**
 * @typedef {Object} Thing
 * @property {string} id
 * @property {string} title
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ query, db }) => {
  const rows = /** @type {Thing[]} */ (
    db.prepare('SELECT id, title FROM things WHERE owner = ?').all(query.owner ?? '')
  );
  return rows;
};
\`\`\`

\`\`\`js
// actions/<name>.js
/**
 * @typedef {Object} Input
 * @property {string} [title]
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, db, log }) => {
  const input = /** @type {Input | undefined} */ (body);
  // do work
  return { status: 200, body: { ok: true } };
};
\`\`\`

\`\`\`js
// crons/<name>.js
export const schedule  = { cron: '*/15 * * * *', tz: 'UTC' }; // or { every: '30m' } | { at: '...' }
export const execution = 'isolated'; // | 'main' | 'current' | { session: '...' }
export const task      = {
  prompt: \`Run \\\`gh issue list --json number,title,state\\\` and return the JSON array verbatim as your final message.\`,
  toolAllow: ['bash'],
};
export const timeoutMs = 30000;

/**
 * @typedef {{ number: number, title: string, state: string }} Issue
 *
 * @type {import('@centraid/openclaw-plugin').CronHandler}
 */
export default async ({ payload, db, log }) => {
  const issues = /** @type {Issue[]} */ (payload.json ?? JSON.parse(payload.text));
  // The \`issues\` table must already exist from a migration — see
  // "Schema migrations" below. Handlers must never run DDL.
  // Upsert via parameterized statement, wrapped in db.transaction(...).
};
\`\`\`

### TypeScript-syntax pitfalls — these will break the runtime

Files run as JavaScript. The following are **syntax errors** in \`.js\` and must never appear:

- \`import type { ... }\` — use a JSDoc \`@typedef\` or \`import('@centraid/openclaw-plugin').TypeName\` inside \`@type\` instead.
- \`x as Foo\` and \`<Foo>x\` — use a JSDoc cast: \`/** @type {Foo} */ (x)\`.
- \`(...) satisfies Foo\` — use \`/** @type {Foo} */\` on the export instead.
- \`interface Foo { ... }\`, \`type Foo = ...\`, enums — declare shapes with \`@typedef\` in JSDoc.
- Generic call type args like \`db.prepare(sql).get<Row>(id)\` — call \`.get(id)\` and cast: \`/** @type {Row | undefined} */ (db.prepare(sql).get(id))\`. Generic call syntax is a parse error in JS.
- Parameter type annotations like \`({ db }: Args) => ...\` — annotate via the \`@type\` on the export, which infers the parameter shape.
- Non-null assertions (\`x!\`) and definite-assignment markers — use a real guard or JSDoc cast.

If you catch yourself reaching for any of the above, you've slipped into TS habits. Stop and use the JSDoc equivalent.

### Db proxy semantics

\`db.prepare(sql).run/get/all\` round-trip through a worker boundary. Use parameterized SQL — never interpolate untrusted strings. Wrap multi-row writes in \`db.transaction(...)\` for atomicity.

\`db.exec\` is reserved for DML on tables that already exist. **Never run DDL inside a handler** — no \`CREATE TABLE\`, no \`ALTER TABLE\`, no \`CREATE INDEX\`, no \`DROP …\`. All schema lives in \`migrations/\` (see below).

\`.get(...)\` returns \`unknown | undefined\` and \`.all(...)\` returns \`unknown[]\` at the JSDoc level — cast the result to a \`@typedef\`'d row shape so subsequent property access is checked.

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

When a session begins on a project that has a live published version, the harness injects the live schema (a \`### Live schema\` block listing \`PRAGMA user_version\` and every \`CREATE TABLE\`/\`CREATE INDEX\`/\`CREATE VIEW\`) just below this section. Use it to decide what id the next migration must take and what the database currently looks like. If that block is absent, treat the database as empty and start at \`0001\`.

### Cron handler design rules

- The \`task.prompt\` runs in an OpenClaw agent session; its **final message** is delivered as a webhook to the plugin's ingest endpoint, which invokes your handler's \`default export\` with the parsed result in \`payload\`.
- Write the prompt so the agent emits **strict JSON** as its final message. Tell it explicitly: "return the JSON array verbatim as your final message; no commentary".
- The handler is a worker thread: no \`fs\`, no \`child_process\`, no \`process.env\`. \`ctx.fetch\` is available with the worker's abort signal.
- For idempotent storage, prefer \`INSERT … ON CONFLICT DO UPDATE\` keyed by a stable id from the upstream system.

### Security model (do not weaken)

- Static-serve same-origin only with strict CSP — don't request inline scripts; structure html so logic loads from \`.js\` files.
- The plugin runs handlers in worker threads with crash + timeout isolation. Do not rely on shared globals across handler invocations.
- Cron webhook ingest is loopback-only and bearer-authenticated by the plugin — your code does not need to handle auth.

### Build / publish expectations

There is **no build step**. The publish step uploads the project folder as-is; the runtime loads \`.js\` files directly. Don't introduce \`tsconfig.json\`, don't add \`build\`/\`watch\` scripts, don't reach for a bundler. If you want editor IntelliSense locally, run \`bun install\` (or \`npm install\`) so \`@centraid/openclaw-plugin\` resolves — it changes nothing at runtime.

### When asked to scaffold a new app

Default layout is already in place when you start. Add or modify files; do not move \`package.json\` unless the user explicitly asks. Place handlers under \`queries/\`, \`actions/\`, \`crons/\` as \`.js\` files following the patterns above.
`;

/** Build-time-friendly accessor (avoids accidental top-level evaluation costs). */
export function centraidAppendPrompt(): string {
  return CENTRAID_APPEND_PROMPT;
}
