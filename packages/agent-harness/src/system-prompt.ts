/**
 * The centraid-format system prompt.
 *
 * Appended to pi's default coding-agent prompt — it teaches the model the
 * exact app folder layout, handler signatures, and the security model
 * defended by `@centraid/openclaw-plugin`. Keep this in sync with the
 * plugin's README.
 */
export const CENTRAID_APPEND_PROMPT = `## Centraid app authoring

You are working inside a centraid app project folder. Your job is to author or modify the files that make up a single app published to a centraid-equipped OpenClaw gateway. Read this section before making changes.

### Folder layout (canonical)

\`\`\`
<project root>/
  index.html               # entry page; static assets sit alongside
  app.css, app.js, ...     # static assets (extension allowlist below)
  app.json                 # optional metadata: { "name", "version" }
  package.json             # devDependencies on @centraid/openclaw-plugin + typescript
  tsconfig.json            # compiles .ts -> .js in place
  queries/<name>.ts        # GET /centraid/<id>/_data/<name> handler
  actions/<name>.ts        # POST /centraid/<id>/_run handler (body.action picks)
  crons/<name>.ts          # schedule + task + ingest handler in one module
\`\`\`

The runtime file is the **.js** sibling of each .ts (compiled in place by tsc).

### Files you must NEVER create or commit

- \`data.sqlite\` — managed by the plugin at runtime; persists across versions and would be **rejected at upload**.
- \`current.json\`, \`_registry.json\`, \`versions/\` — these are runtime artifacts owned by the plugin.
- Any binary executable, native module, or symlink.

### Static asset extension allowlist (anything else is rejected at upload)

\`.html .htm .css .js .mjs .ts .json .md .txt .svg .png .jpg .jpeg .webp .gif .ico .woff .woff2 .ttf .otf .map\`

### Handler contract

All three handler kinds receive \`{ db, log, app, ctx }\` plus kind-specific fields. Use the public types from \`@centraid/openclaw-plugin\`.

\`\`\`ts
// queries/<name>.ts
import type { QueryHandler } from "@centraid/openclaw-plugin";
export default (async ({ query, db }) => {
  return db.prepare("SELECT ...").all(query.foo);
}) satisfies QueryHandler;
\`\`\`

\`\`\`ts
// actions/<name>.ts
import type { ActionHandler } from "@centraid/openclaw-plugin";
export default (async ({ body, db, log }) => {
  // do work
  return { status: 200, body: { ok: true } };
}) satisfies ActionHandler;
\`\`\`

\`\`\`ts
// crons/<name>.ts
import type { CronHandler } from "@centraid/openclaw-plugin";

export const schedule  = { cron: "*/15 * * * *", tz: "UTC" }; // or { every: "30m" } | { at: "..." }
export const execution = "isolated"; // | "main" | "current" | { session: "..." }
export const task      = {
  prompt: "Run \\\`gh issue list --json number,title,state\\\` and return the JSON array verbatim as your final message.",
  toolAllow: ["bash"],
};
export const timeoutMs = 30000;

export default (async ({ payload, db, log }) => {
  const rows = payload.json ?? JSON.parse(payload.text);
  db.exec(\\\`CREATE TABLE IF NOT EXISTS issues (number INTEGER PRIMARY KEY, ...)\\\`);
  // upsert via parameterized statement, wrapped in db.transaction(...)
}) satisfies CronHandler;
\`\`\`

### Db proxy semantics

\`db.prepare(sql).run/get/all\` round-trip through a worker boundary. Use parameterized SQL — never interpolate untrusted strings. Wrap multi-row writes in \`db.transaction(...)\` for atomicity.

\`db.exec\` is for DDL (\`CREATE TABLE IF NOT EXISTS …\`). Always make schema setup idempotent — handlers run independently and may be the first to touch the database after a fresh upload.

### Cron handler design rules

- The \`task.prompt\` runs in an OpenClaw agent session; its **final message** is delivered as a webhook to the plugin's ingest endpoint, which invokes your handler's \`default export\` with the parsed result in \`payload\`.
- Write the prompt so the agent emits **strict JSON** as its final message. Tell it explicitly: "return the JSON array verbatim as your final message; no commentary".
- The handler is a worker thread: no \`fs\`, no \`child_process\`, no \`process.env\`. \`ctx.fetch\` is available with the worker's abort signal.
- For idempotent storage, prefer \`INSERT … ON CONFLICT DO UPDATE\` keyed by a stable id from the upstream system.

### Security model (do not weaken)

- Static-serve same-origin only with strict CSP — don't request inline scripts; structure html so logic loads from \`.js\` files.
- The plugin runs handlers in worker threads with crash + timeout isolation. Do not rely on shared globals across handler invocations.
- Cron webhook ingest is loopback-only and bearer-authenticated by the plugin — your code does not need to handle auth.

### Build expectations

The publish step runs \`bun run build\` (or \`tsc\`) in this folder before uploading. Make sure handlers in \`queries/\`, \`actions/\`, and \`crons/\` compile cleanly. The runtime loads only \`.js\` files; \`.ts\` sources travel along but are inert at runtime.

### When asked to scaffold a new app

Default layout is already in place when you start. Add or modify files; do not move \`tsconfig.json\` or \`package.json\` unless the user explicitly asks.
`;

/** Build-time-friendly accessor (avoids accidental top-level evaluation costs). */
export function centraidAppendPrompt(): string {
  return CENTRAID_APPEND_PROMPT;
}
