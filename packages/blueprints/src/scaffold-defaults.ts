// Default content templates emitted by `scaffoldApp`. Kept in their
// own module so `scaffold.ts` stays focused on the scaffolding logic
// rather than carrying long template literals inline.
//
// app.css is the per-app styling layer built on top of tokens.css. It
// ships utility classes (.head, .add-bar, .list, .row, .empty, etc.)
// matching the "Component primitives" block in the agent prompt — so a
// model that follows the prompt examples gets working UI immediately.
//
// Rules baked in here:
//   - No hex literals; every color is `var(--…)` from tokens.css.
//   - Hit targets ≥ 44px via min-height on inputs/buttons/circle.
//   - `:focus-visible` outlines preserved with `var(--accent)`.
//   - `prefers-reduced-motion` respected.
//   - Mobile-first with one breakpoint at 720px.
//   - Honors the four standard per-app knobs declared in the matching
//     `app.json#knobs[]`: `appFont` / `appWidth` / `appRadius` via
//     `:root[data-app-*]` selectors, and `appColor` consumed wherever
//     the accent paints (primary button, focus rings, links, pressed
//     circle) via `var(--app-color, var(--accent))`. Falls back to
//     `--accent` when no knob value is set.
export const DEFAULT_APP_CSS = `* { box-sizing: border-box; }

body {
  margin: 0;
  padding: max(1rem, env(safe-area-inset-top)) 1rem env(safe-area-inset-bottom);
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
}

main {
  max-width: 36rem;
  margin: 0 auto;
  padding: 0.5rem 0 2rem;
}

@media (min-width: 720px) {
  body { padding: 1.5rem 2rem; }
  main { max-width: 56rem; }
}

/* --- Page header --- */
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.head h1 {
  font-size: 1.75rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 0.1rem;
}
.muted { color: var(--ink-3); font-size: 0.85rem; margin: 0; }
.small { font-size: 0.8rem; }

/* --- Surface / card --- */
.surface {
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 1rem 1.125rem;
}

/* --- Inputs --- */
input[type='text'], input[type='search'], textarea {
  flex: 1;
  min-height: 2.75rem;
  padding: 0.625rem 0.875rem;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--bg-elev);
  color: var(--ink);
  font: inherit;
  font-size: 1rem;
  -webkit-appearance: none;
}
input:focus-visible, textarea:focus-visible {
  outline: none;
  border-color: var(--app-color, var(--accent));
}

/* --- Buttons --- */
button { font: inherit; cursor: pointer; }
.primary {
  min-height: 2.75rem;
  padding: 0 1.125rem;
  border-radius: var(--r-md);
  border: none;
  background: var(--app-color, var(--accent));
  color: var(--ink-inv, #fff);
  font-weight: 600;
  font-size: 0.9375rem;
  -webkit-tap-highlight-color: transparent;
}
.primary:disabled { opacity: 0.4; cursor: not-allowed; }
.primary:focus-visible { outline: 2px solid var(--app-color, var(--accent)); outline-offset: 2px; }

.ghost {
  min-height: 2.75rem;
  padding: 0 0.875rem;
  border-radius: var(--r-md);
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink-2);
  font-weight: 500;
}
.ghost:hover { background: var(--bg-elev); }
.ghost:focus-visible { outline: 2px solid var(--app-color, var(--accent)); outline-offset: 2px; }

.link {
  background: none; border: none; padding: 0;
  color: var(--app-color, var(--accent)); text-decoration: underline; font: inherit;
}

/* --- Bars (input + button paired) --- */
.add-bar { display: flex; gap: 0.5rem; margin-bottom: 1.25rem; }

/* --- Lists --- */
.list { display: flex; flex-direction: column; gap: 0.25rem; }
.row {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.625rem 0;
  border-bottom: 1px solid var(--line);
}
.row:last-child { border-bottom: none; }
.row-text { flex: 1; min-width: 0; font-size: 0.95rem; line-height: 1.35; word-break: break-word; }
.row[data-done='true'] .row-text { color: var(--ink-4); text-decoration: line-through; }

/* --- Circle toggle (used inside list rows) --- */
.circle {
  width: 1.75rem; height: 1.75rem;
  min-width: 1.75rem;
  border-radius: 50%;
  border: 1.5px solid var(--ink-4);
  background: transparent;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0;
  color: var(--ink-inv, #fff);
  -webkit-tap-highlight-color: transparent;
}
.circle[aria-pressed='true'] { background: var(--app-color, var(--accent)); border-color: var(--app-color, var(--accent)); }
.circle:focus-visible { outline: 2px solid var(--app-color, var(--accent)); outline-offset: 2px; }

/* --- Quiet icon button (e.g. row delete) --- */
.del {
  background: transparent; border: none;
  width: 2.25rem; height: 2.25rem;
  border-radius: var(--r-sm);
  color: var(--ink-4);
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0;
  -webkit-tap-highlight-color: transparent;
}
.del:hover { color: var(--ink-2); }
.del:active { color: var(--danger); }
.del:focus-visible { outline: 2px solid var(--app-color, var(--accent)); outline-offset: 2px; }

/* --- State triad --- */
.empty { color: var(--ink-3); font-size: 0.9rem; text-align: center; padding: 2rem 0; }
.loading { color: var(--ink-3); font-size: 0.9rem; text-align: center; padding: 1rem 0; }
.error {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 25%, transparent);
  border-radius: var(--r-md);
  padding: 0.625rem 0.875rem;
  font-size: 0.9rem;
}

/* --- Motion --- */
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
}

/* ---------- App-level knobs ----------
   Per-app aesthetic customizations declared in 'app.json#knobs[]' and
   persisted in the '__centraid_settings' table. The runtime bakes
   '<html data-app-* style="--app-color: ...">' before serving and
   live-updates the same surface via postMessage. Defaults match the
   base look above so an unset knob renders unchanged. */

:root[data-app-font='sans'] {
  font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
}
:root[data-app-font='serif'] {
  font-family: 'New York', Georgia, 'Iowan Old Style', Cambria, serif;
}
:root[data-app-font='mono'] {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
}

:root[data-app-width='narrow'] main { max-width: 36rem; }
:root[data-app-width='wide'] main { max-width: 64rem; }
@media (min-width: 720px) {
  :root[data-app-width='narrow'] main { max-width: 42rem; }
  :root[data-app-width='wide'] main { max-width: 72rem; }
}

:root[data-app-radius='sharp'] input[type='text'],
:root[data-app-radius='sharp'] input[type='search'],
:root[data-app-radius='sharp'] textarea,
:root[data-app-radius='sharp'] .primary,
:root[data-app-radius='sharp'] .ghost,
:root[data-app-radius='sharp'] .circle {
  border-radius: 0;
}
:root[data-app-radius='pill'] input[type='text'],
:root[data-app-radius='pill'] input[type='search'],
:root[data-app-radius='pill'] .primary,
:root[data-app-radius='pill'] .ghost {
  border-radius: 999px;
}
`;

/**
 * Per-app README written into every new app folder. The id is
 * interpolated so the brief reads naturally.
 */
export const README_TEMPLATE = (id: string): string => `# ${id}

Centraid app app. Files here are the source for the published app.

## Author handlers in JavaScript

Handlers are \`.js\` ES modules. There is no build step — the runtime loads
them directly. Type-check via JSDoc annotations:

\`\`\`js
/** @type {import('@centraid/openclaw-plugin').QueryHandler} */
export default async ({ input, ctx }) => { /* ... */ };
\`\`\`

For editor IntelliSense, run \`bun install\` once so the type package
resolves locally:

\`\`\`sh
bun install   # or: npm install
\`\`\`

## Layout

- \`index.html\`, \`app.css\`, \`app.jsx\` — static, served from \`/centraid/${id}/\`.
  \`app.jsx\` is a React component; the gateway transpiles it per-request
  (esbuild, \`jsx: 'automatic'\`) — no local build step. Import
  \`createRoot\`/hooks from \`./react-core.min.js\`, the same shared
  sibling-import mechanism as \`./kit.js\`.
- \`queries/<name>.js\` — pure function bodies invoked via
  \`window.centraid.read({ query: '<name>', input })\` → dispatched
  against the \`queries[]\` entry in \`app.json\`.
- \`actions/<name>.js\` — pure function bodies invoked via
  \`window.centraid.write({ action: '<name>', input })\` → dispatched
  against the \`actions[]\` entry in \`app.json\`.
- \`automations/<id>/\` — one folder per automation the app owns:
  \`automation.json\` (the manifest) + \`handler.js\` (fired by the host
  scheduler, no page open). See \`automations/README.md\`.
- \`app.json\` — the **app manifest** (issue #107). Lists every
  action/query along with its JSON Schema for \`input\`/\`output\`. The
  dispatcher validates input against these schemas before invoking the
  handler. Required top-level fields: \`manifestVersion: 1\`, \`id\`,
  \`name\`, \`version\`. Every new handler file needs a matching entry —
  the dispatcher refuses to invoke a file that isn't declared.

## Data

The app owns no database. All data lives in the owner's vault; handlers
reach it through \`ctx.vault\` (read/search/invoke). Declare the app's
data story in \`app.json\`: a \`vault\` block requesting canonical scopes
(the default lane), and/or an \`ext.tables\` block for extension tables
the gateway hosts inside the vault (the justified escape hatch). The
gateway applies ext-table DDL on publish — never run DDL from code.

## Phone-readiness

The mobile shell is a thin viewer — on the phone this blueprint IS the
UI. Keep the kit reference (\`kit.css\` is served by the runtime from one
shared canonical copy — reference it from \`index.html\`, never copy it
into the app folder), and keep the scaffold's responsive conventions
intact: \`viewport-fit=cover\` in the
viewport meta, \`env(safe-area-inset-*)\` body padding, the single 720px
breakpoint, ≥ 44px hit targets, and the \`prefers-reduced-motion\` guard.
Build on these; never strip them.

See \`@centraid/openclaw-plugin\` for the full handler-arg types.
`;

/**
 * README dropped into every new app's `automations/` folder so empty-
 * dir file viewers don't hide it and the agent has an in-folder pointer
 * to the manifest shape.
 */
export const AUTOMATIONS_README = `# automations/

Automations this app owns — scheduled jobs that run with no page open
and no user present. Each automation is its own folder:

\`\`\`
automations/<id>/automation.json   # the manifest
automations/<id>/handler.js        # the handler the scheduler fires
\`\`\`

\`<id>\` is a short stable slug (\`daily-digest\`, \`evening-reminder\`). An
app may own several automations — one folder each, distinct slugs. Reuse
a slug to revise it; pick a new slug to add another. The always-on
gateway owns an in-process cron scheduler and fires each automation's
handler on schedule while it is running.

## automation.json

\`\`\`json
{
  "name": "Evening reminder",
  "version": "0.1.0",
  "enabled": true,
  "prompt": "every evening at 8pm, remind me about unfinished habits",
  "triggers": [{ "kind": "cron", "expr": "0 20 * * *" }],
  "requires": { "model": "anthropic/claude-3-5-sonnet" },
  "history": { "keep": { "count": 100 } },
  "generated": { "by": "centraid-builder", "at": "<ISO-8601>" }
}
\`\`\`

- \`triggers\` is an array. A cron trigger is
  \`{ "kind": "cron", "expr": "<5-field UTC cron>" }\`; \`[]\` is a legal
  manual-fire-only automation. A webhook trigger is declared as
  \`{ "kind": "webhook", "pending": true }\` — the route id + secret are
  minted server-side, never hand-written.
- \`requires.mcps\` / \`requires.tools\` declare the host tools the handler
  calls via \`ctx.tool(name, args)\`. \`requires.model\` is the model
  \`ctx.agent({ prompt, json? })\` routes through. **Never set this to
  \`centraid-mock/*\`** — that would recurse into the runner.
- The runtime validates the manifest on every read; keep the shape exactly.

## handler.js

A plain \`.js\` ES module receiving \`{ ctx, log }\` only — no \`db\`, no
\`body\`, no \`window\`. The \`prompt\` is canonical: re-prompting the
builder regenerates the handler, so don't hand-edit it.

See \`@centraid/openclaw-plugin\`'s \`AutomationHandler\` type for the
full handler-arg shape.
`;
