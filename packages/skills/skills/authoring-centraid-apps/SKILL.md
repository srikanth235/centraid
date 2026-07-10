---
name: authoring-centraid-apps
description: How to author or modify a centraid app — the canonical folder layout, the app.json manifest, the JavaScript-only handler contract, the two-lane data rule (vault ontology + extension tables), reactive data, in-app automations, and the security model. Use whenever creating or editing the files of a centraid UI app.
---
## Centraid app authoring

You are working inside a centraid app app folder. Your job is to author or modify the files that make up a single app published to a centraid-equipped OpenClaw gateway. Read this section before making changes.

### Folder layout (canonical)

```
<app root>/
  index.html               # entry page; static assets sit alongside
  app.css, app.jsx, ...    # static assets (extension allowlist below).
                           # app.jsx is a React component — the gateway
                           # transpiles .jsx per-request (esbuild,
                           # jsx: 'automatic'), no local build step.
                           # Import createRoot/hooks from
                           # ./react-core.min.js, the same shared
                           # sibling-import mechanism as ./kit.js.
  app.json                 # the APP MANIFEST — see "App manifest" below
  package.json             # devDependency on @centraid/openclaw-plugin (for editor types)
  queries/<name>.js        # dispatched against queries[name] in the manifest
  actions/<name>.js        # dispatched against actions[name] in the manifest
  automations/<id>/automation.json  # a scheduled automation the app owns
  automations/<id>/handler.js       #   its handler (see "Automations" below)
```

Handlers are authored as **plain `.js` ES modules** — there is no `tsconfig.json`, no `tsc`, and no build step. The gateway loads `.js` directly. Type checking comes from JSDoc annotations that the editor resolves against `@centraid/openclaw-plugin` (installed as a devDependency).

### UI dialect — React or Lit (both supported)

Two UI dialects are first-class; the runtime serves both:

- **React** — `app.jsx`, imports from `./react-core.min.js` (createRoot, hooks, flushSync). The **default for new apps**: fresh scaffolds ship a React `app.jsx`.
- **Lit** — `app.js`, imports `html`/`render`/directives from `./lit-core.min.js` (and optionally the kit's `KitElement` from `./elements.js`). This is the dialect of the bundled blueprint apps.

**When modifying an existing app, keep its dialect.** Detect it before writing UI code: an `app.jsx` entry means React; an `app.js` importing `./lit-core.min.js` means Lit. Never convert an app between dialects unless the user explicitly asks for a rewrite.

React apps may (and beyond a few hundred lines, should) split into modules: `app.jsx` stays the entry/orchestrator, pure view components live in `components/<Name>.jsx`, JSX-free helpers in sibling `.js` files. The gateway transpiles every `.jsx` per-request at any depth. Two rules keep this working: every relative import carries its extension (`./components/Grid.jsx`, never `./components/Grid` — tooling resolves extensionless imports but a real browser 404s), and from a subdirectory the shared runtime imports go up one level (`../react-core.min.js`, `../kit.js`). Keep every file under 500 lines.

Everything else is dialect-independent: `window.centraid` read/write/describe/onChange, the `#consentBanner` pattern, kit.css classes (`class=` in Lit templates, `className=` in JSX), and the inline settings bridge in `index.html`.

Lit-specific traps (React apps have neither):

1. Lit's standalone `render()` does **not** clear a container's pre-existing children on first commit — containers pre-filled with skeleton markup need a one-shot `replaceChildren()` mount guard before the first render.
2. Once Lit owns a container, never raw-clear it (`innerHTML = ''` corrupts Lit's part cache and the next render throws) — clear with `render(nothing, container)`.

### Design system — shared tokens + kit primitives

Styling is layered; `index.html` links the sheets in this exact order:

```html
<link rel="stylesheet" href="wall.css" />    <!-- page-background gradient (shared) -->
<link rel="stylesheet" href="tokens.css" />  <!-- design-token layer (shared, generated) -->
<link rel="stylesheet" href="app.css" />     <!-- YOUR app-local styles -->
<link rel="stylesheet" href="kit.css" />     <!-- shared component primitives -->
```

`wall.css`, `tokens.css`, and `kit.css` are **served from the shared kit dir** — never create local copies (a local copy shadows the live shared file and the app stops tracking design-system updates).

The token contract: your `app.css` `:root` sets **`--app-hue`** (one number that drives the entire neutral ramp — ink, lines, surfaces, shadows) and **`--accent`** (pick a palette var: `--c-amber`, `--c-forest`, `--c-indigo`, `--c-ochre`, `--c-rose`, `--c-slate`, `--c-teal`, `--c-violet`). Everything else derives in tokens.css; override an individual token only for a deliberate app-specific look (your `:root` loads after tokens.css, so equal-specificity overrides win). Dark theme is fully handled by tokens.css (both `data-theme` and the `prefers-color-scheme` fallback) — **never write your own dark-theme token blocks**. Paint accents through `var(--_accent)` (resolves the user's appColor knob over `--accent`).

Prefer kit primitives over hand-rolled equivalents: `.kit-btn`, `.kit-chip(.quiet)`, `.kit-seg`, `.kit-modal*`, `.kit-popover*`, `.kit-banner`, `.kit-empty*`, `.kit-toasts`, `.kit-skeleton`, `.kit-input(.bare)`, `.kit-search`, `.kit-icon-btn`, `.kit-viewer-nav`, `.kit-drop`/`.kit-drop-card`, `.kit-foot`, `.kit-muted`/`.kit-small`, and `box-shadow: var(--kit-focus-ring)` for focus. One cascade trap: kit.css loads **after** app.css, so an app rule overriding a kit class at equal specificity loses — bump specificity with a compound selector (`.kit-input.my-variant`), the pattern the bundled apps use throughout.

### App manifest — `app.json` (source of truth)

Every app ships an `app.json` manifest. Every handler invocation is dispatched through it — the page calls `window.centraid.read({ query })` / `window.centraid.write({ action })` and the runtime validates the call against the matching manifest entry before running the file. A handler file with no matching manifest entry is unreachable; a manifest entry whose file is missing is rejected at publish time. The manifest also carries the app's **whole data declaration** — the `vault` block and/or the `ext` block (see "Data: the two-lane rule" below).

```json
{
  "manifestVersion": 1,
  "id": "todos",
  "name": "Todos",
  "version": "0.1.0",
  "description": "Capture and clear small things.",
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
      "writes": ["ext.todos.todos"]
    }
  ],
  "queries": [
    {
      "name": "list",
      "description": "All todos, newest first.",
      "input": { "type": "object", "properties": {}, "additionalProperties": false },
      "output": { "type": "array", "items": { "type": "object" } },
      "reads": ["ext.todos.todos"]
    }
  ]
}
```

Rules:

- `manifestVersion: 1` is required; the dispatcher rejects unsupported versions.
- `id`, `name`, `version` are required. `id` matches the app folder name.
- Every `.js` file under `actions/` MUST have a matching entry in `actions[]`; every `.js` under `queries/` MUST have a matching entry in `queries[]`. Whenever you add, rename, or delete a handler, update the manifest in the same turn.
- `input` and `output` are arbitrary **JSON Schema (draft 2020-12)** fragments. Write them strictly — `required`, `additionalProperties: false`, `minLength`, `pattern`, `enum`. The dispatcher validates input with Ajv and rejects mismatched calls before the handler runs.
- `confirmation` (action-only) is `"none"` or `"required"`. Set `"required"` for destructive or irreversible actions (delete, send, charge); the chat surface honours this and asks the user to confirm.
- `writes` / `reads` list the vault entities the handler touches (canonical like `core.event`, or this app's own `ext.<appId>.<table>`). Optional but useful for documentation and chat permissions.
- A name may appear in both `actions` and `queries` (different tools, different files). Duplicate names within the same array are rejected.

### Files you must NEVER create or commit

- `*.sqlite`, `*.db`, `*.sql` — apps own **no database files and no DDL**. All data lives in the owner's vault (see "Data: the two-lane rule" below); any database or SQL file would be **rejected at upload**.
- `current.json`, `_registry.json`, `versions/` — runtime artifacts owned by the plugin.
- `tsconfig.json`, `*.ts`, `*.tsx`, `*.d.ts` — handlers are `.js`-only. If you find legacy `.ts` files in an existing app, do **not** add new ones; leave the old ones alone and write new handlers as `.js`.
- Any binary executable, native module, or symlink.

### Static asset extension allowlist (anything else is rejected at upload)

`.html .htm .css .js .mjs .jsx .json .md .txt .svg .png .jpg .jpeg .webp .gif .ico .woff .woff2 .ttf .otf .map`

### Handler contract

Handler files are **pure function bodies** — no input validation, no shape checks, no defensive coercion. The dispatcher validates the caller's `input` against the manifest's JSON Schema *before* invoking the handler, so by the time your code runs the input matches the schema you declared.

Both handler kinds receive `{ params, log, app, ctx }` plus kind-specific fields:

- Action: `body` carries the validated input.
- Query: `input` (preferred) and `query` (alias) both carry the validated input.

There is **no `db`** — apps have no private database. `ctx.vault` is the only data door:

- `await ctx.vault.read({ entity, where?, limit?, purpose })` — consent-checked read of an entity (canonical like `core.event`, or this app's own `ext.<appId>.<table>`). Returns `{ rows, receiptId }`.
- `await ctx.vault.search({ entity, query, where?, limit?, purpose })` — full-text search over a text-indexed entity. `query` is the owner's typed words (matched as AND-ed prefixes; FTS operators are treated as literals). Returns `{ rows, receiptId }` ranked best-first; each row adds `_snippet` — the matched fragment with `⟦`/`⟧` around hits (escape the text FIRST, then turn markers into markup). ALWAYS search this way instead of reading a whole entity and filtering text in JS — vault data has no upper bound.
- `await ctx.vault.invoke({ command, input, purpose })` — typed command (e.g. `schedule.propose_event`, or this app's `ext.<appId>.insert`). Returns an outcome: `{ status: 'executed' | 'denied' | 'parked' | 'failed', output?, … }` — check `status` before assuming the write landed; `parked` means the owner must confirm.
- `await ctx.vault.query({ view, purpose })` — read a registered view.
- `await ctx.vault.describe()` — the commands this app can discover (name, schema, risk).
- `await ctx.vault.parked()` — this app's own invocations awaiting owner confirmation.
- `await ctx.vault.resolve(...)` — turn cross-domain `(type, id)` references into renderable cards (resolvable-if-linked).

Every call is consent-checked host-side and receipted. A denial throws with the receipt id in the message — do not retry in a loop; surface the denial. Until the owner approves the manifest's requested scopes, calls fail closed.

Type the default export by pointing JSDoc `@type` at the alias in `@centraid/openclaw-plugin`. Declare row shapes with `@typedef` and cast `ctx.vault.read/search` rows with a JSDoc `@type` cast.

**Every `ctx.vault` call is async** and returns a `Promise<...>` — always `await` it. Forgetting `await` is the #1 bug in handler code.

```js
// queries/<name>.js — invoked from the page as window.centraid.read({ query: '<name>', input })
/**
 * @typedef {Object} Thing
 * @property {string} id
 * @property {string} title
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ input, ctx }) => {
  const { rows } = await ctx.vault.read({
    entity: 'ext.things.things',
    where: { owner: input.owner },
    limit: 200,
    purpose: 'dpv:ServiceProvision',
  });
  return /** @type {Thing[]} */ (rows);
};
```

```js
// actions/<name>.js — invoked from the page as window.centraid.write({ action: '<name>', input })
/** @type {import('@centraid/openclaw-plugin').ActionHandler} */
export default async ({ body, ctx, log }) => {
  // `body` is the validated input. Do work through ctx.vault.invoke.
  const outcome = await ctx.vault.invoke({
    command: 'ext.things.insert',
    input: { table: 'things', values: { title: body.title } },
    purpose: 'dpv:ServiceProvision',
  });
  if (outcome.status === 'parked') return { parked: true };
  if (outcome.status !== 'executed') throw new Error(`vault refused: ${outcome.status}`);
  return outcome.output;
};
```

Action handlers may return `{ status, body }` (legacy shape). The dispatcher unwraps `body` for the caller and treats `status >= 400` as `HANDLER_ERROR`. New handlers can return their payload directly — both are accepted.

### TypeScript-syntax pitfalls — these will break the runtime

Files run as JavaScript. The following are **syntax errors** in `.js` and must never appear:

- `import type { ... }` — use a JSDoc `@typedef` or `import('@centraid/openclaw-plugin').TypeName` inside `@type` instead.
- `x as Foo` and `<Foo>x` — use a JSDoc cast: `/** @type {Foo} */ (x)`.
- `(...) satisfies Foo` — use `/** @type {Foo} */` on the export instead.
- `interface Foo { ... }`, `type Foo = ...`, enums — declare shapes with `@typedef` in JSDoc.
- Generic call type args like `ctx.vault.read<Row>({ … })` — call it plain and cast the rows: `/** @type {Row[]} */ ((await ctx.vault.read({ … })).rows)`. Generic call syntax is a parse error in JS.
- Parameter type annotations like `({ ctx }: Args) => ...` — annotate via the `@type` on the export, which infers the parameter shape.
- Non-null assertions (`x!`) and definite-assignment markers — use a real guard or JSDoc cast.

If you catch yourself reaching for any of the above, you've slipped into TS habits. Stop and use the JSDoc equivalent.

### Data: the two-lane rule

Apps own no database. There is no per-app data file, no raw SQL, and no DDL — the owner's **vault** (one gateway-owned store) holds everything, and an app is a *projection* over it. The app's whole data story is declared in `app.json` and travels one of two lanes:

#### Lane 1 (default): map the domain onto the canonical vault ontology

Before inventing any shape of your own, map the app's domain onto entities the vault already has: `core.observation` + its typed components, `core.activity`, `core.collection`, `home.asset_item`, `knowledge.annotation`, and the concept / tag / link mechanisms. Most apps are pure projections — a habit tracker is observations, a reading list is a collection plus annotations, a planner is schedule events. Declare a `vault` block requesting the **narrowest scopes** that cover the app, and justify the request in `why` — the owner sees it in the approval UI:

```json
"vault": {
  "purpose": "dpv:ServiceProvision",
  "why": "Reads and proposes calendar events so you can plan your week.",
  "scopes": [
    { "schema": "schedule", "table": "event", "verbs": "read+act" }
  ]
}
```

Each scope names a `schema` (optionally narrowed to one `table`) and its `verbs`: `read`, `read+act`, or `act`. The block is a **request, not a grant** — access is deny-by-default until the owner approves it, and until then every `ctx.vault` call fails closed.

#### Lane 2 (escape hatch, must be justified): extension tables

Only when the canonical ontology genuinely has no home for a shape, declare extension tables in `app.json#ext`. The GATEWAY creates them inside the vault as `ext_<appId>_<table>` — apps **never** run DDL:

```json
"ext": {
  "tables": [
    {
      "name": "readings",
      "columns": [
        { "name": "id", "type": "text", "primaryKey": true },
        { "name": "person", "type": "text", "references": "core.party" },
        { "name": "value", "type": "real", "notNull": true },
        { "name": "note", "type": "text", "default": "" }
      ],
      "indexes": [{ "columns": ["person"], "unique": false }],
      "searchable": ["note"]
    }
  ]
}
```

- Column `type` is `text` | `integer` | `real` | `blob`. Exactly **one** column is `primaryKey: true`, and it must be `text`. `notNull` and `default` behave as in SQL. `references` names a *logical* entity — canonical like `core.party`, or a same-app sibling as `ext.<appId>.<table>`.
- `indexes` is a list of `{ columns, unique? }`. `searchable` lists text columns to FTS-index (opt-in search via `ctx.vault.search`).
- The gateway applies the DDL **on publish**, diffing the declared spec against the live band additively: new tables are created, columns are added or dropped. A type or primary-key change is **refused** — pick a new column/table name instead. To change schema, edit `ext.tables` and re-publish; never attempt `CREATE`/`ALTER`/`DROP` from code.
- Read ext tables via `ctx.vault.read({ entity: 'ext.<appId>.<table>', … })` (and `ctx.vault.search` for `searchable` columns). Write them via the typed trio through `ctx.vault.invoke`: `ext.<appId>.insert` takes `{ table, values }` and returns `{ id }`; `ext.<appId>.update` takes `{ table, id, set }`; `ext.<appId>.delete` takes `{ table, id }`.

Lane 1 first, always: an ext table is a claim that the ontology has no home for the shape — state that justification in the manifest's `why`, and prefer canonical entities plus tags/links over private shapes whenever the mapping is honest.

### Reactive data — keep the UI in sync with writes

The runtime auto-injects a change-bus bridge into every served HTML page. The frontend should subscribe so writes that happen behind its back — assistant vault writes, edits from a second window, automations — propagate to the UI without a manual reload. The bridge auto-reconnects on transient drops, so you don't need retry logic.

Two equivalent APIs:

```js
// 1) Imperative API — what new templates should use. Returns an unsubscribe fn.
const off = window.centraid.onChange((detail) => {
  // detail.source : "agent" | "handler" | "external"
  // detail.toolCallId? : string — only when source === "agent"
  // detail.turnId? : string — only when source === "agent"
  // detail.ts     : number — ms since epoch
  void refresh();
});

// 2) DOM event — same detail shape.
window.addEventListener('centraid:datachange', (e) => {
  // e.detail.source, e.detail.ts, ...
  void refresh();
});
```

Call this once at startup, after `refresh()` (or your initial-load function) is defined.

What fires the bus:

- A **successful action handler** under `actions/` — `source: "handler"`. Query handlers never fire it.
- The chat agent writing on the app's behalf — `source: "agent"`. Carries a stable `turnId` for the whole chat turn and a per-tool-call `toolCallId` matching the tool pill the user is looking at.
- Any other write path without agent or handler context — `source: "external"`.

The event carries **no table-level changeset** — with the app's data living in the shared vault, it simply means "this app acted; re-derive what you render". On any event, refetch the queries the page renders; don't try to diff which table moved.

Practical patterns:

- **Flash agent writes.** When `source === "agent"`, optionally pulse the affected rows to make the AI's edit visible. Other writes can stay silent.
- **One sink, not many.** Apps usually subscribe once at startup; render loops read from the resulting derived state rather than each component opening its own `EventSource`.

### Automations — scheduled background work inside an app

An app is a **capability bundle**, not just a UI. Alongside `index.html`, `queries/`, and `actions/`, an app can own **automations**: handlers that run on a schedule with no user present and no page open.

**Recognize automation intent.** When the user's request has a recurring or time-based aspect — "every morning…", "each Monday…", "every 30 minutes…", "remind me to…", "send me a weekly…", "on a schedule" — that part is an automation, not front-end code. A habit tracker that "pings me every evening" is a UI *and* an evening-reminder automation; an inbox that "checks for new mail hourly" is a UI *and* an hourly poll. Build both halves in the same conversation. **Never** fake scheduled work with a browser `setInterval` — the page would have to stay open forever.

#### Layout

Each automation the app owns is its own folder inside the app:

```
<app root>/
  automations/<id>/automation.json   # the manifest
  automations/<id>/handler.js        # the handler the scheduler fires
```

`<id>` is a short stable slug — `daily-digest`, `evening-reminder`. **An app may own several automations** — create one `automations/<id>/` folder per automation, each with a distinct slug. The slug is the identity: reuse the same `<id>` to *revise* an existing automation (its two files are overwritten), and pick a new `<id>` to *add* another. Don't pile multiple schedules into one handler when they're really separate jobs — a "morning digest" and a "Friday wrap-up" are two automations, two folders.

When one automation references another — e.g. `onFailure` — use the sibling's bare `<id>`; siblings are the other automations in the same app.

#### automation.json

```json
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
```

- `triggers` is an array. A cron trigger is `{ "kind": "cron", "expr": "<5-field UTC cron>" }`. Translate the user's schedule into a cron expression yourself: "every evening at 8" → `0 20 * * *`, "every 30 minutes" → `*/30 * * * *`, "weekdays at 9" → `0 9 * * MON-FRI`. `"triggers": []` is a legal manual-only automation.
- `enabled` — set `true`. An automation authored because the user asked for that behaviour is part of the app and runs once the app is published.
- **Webhook triggers.** When the app needs to react to an inbound HTTP POST, declare the trigger as `{ "kind": "webhook", "pending": true }` — nothing else. You cannot mint the route `id` or `secretHash`; that is a privileged server step, so never invent them. After your turn the builder provisions the webhook (mints the id + secret, rewrites the trigger to its final form) and shows the user the endpoint URL + secret once. An automation may carry at most one webhook trigger.
- `requires.tools` must list every fully-qualified tool the handler calls via `ctx.tool(...)`; `requires.mcps` lists the MCP servers they belong to. `requires.model` is the model `ctx.agent` routes through — never `centraid-mock/...`.
- The runtime validates the manifest on every read; keep the shape exactly as shown.

#### handler.js

A plain `.js` ES module — same JS-only discipline as `queries/` and `actions/` (no `import type`, no `x as Foo`, no `interface`; use JSDoc). It receives `{ ctx, log }` only — **no `db`, no `body`, no `query`, no `window`**. A cron fire has no request and no DOM.

```js
/** @type {import('@centraid/openclaw-plugin').AutomationHandler} */
export default async ({ ctx, log }) => {
  // ctx.tool(name, args)         — one host / MCP tool call; Promise.all batches independents
  // ctx.agent({ prompt, json })  — one constrained model turn (pass json when consumed structurally)
  // ctx.state.get/set/del(key)   — cross-run KV scoped to this automation (cursors, watermarks)
  // ctx.runs.last/list(...)      — this automation's prior run records
  log.info('automation fired');
  return { summary: 'one-line run description' };
};
```

Return `{ summary?, output? }` — `summary` shows in the run list. There is no runtime retry on `ctx.tool`; classify the error and write your own `try/catch` backoff when warranted.

#### Authoring flow

When the user's request includes scheduled behaviour: build the UI / queries / actions as normal **and** create `automations/<id>/automation.json` + `automations/<id>/handler.js`. The automation ships with the app — it is part of the same app, not a separate one.

### Security model (do not weaken)

- Static-serve same-origin only with strict CSP — don't request inline scripts; structure html so logic loads from `.js` / `.jsx` files.
- The plugin runs handlers in worker threads with crash + timeout isolation. Do not rely on shared globals across handler invocations.

### Build / publish expectations

There is **no build step**. The publish step uploads the app folder as-is; the runtime loads `.js` files directly and transpiles `.jsx` files per-request (esbuild, `jsx: 'automatic'`) — you never run a bundler yourself. Don't introduce `tsconfig.json`, don't add `build`/`watch` scripts, don't reach for a bundler. If you want editor IntelliSense locally, run `bun install` (or `npm install`) so `@centraid/openclaw-plugin` resolves — it changes nothing at runtime.

### When asked to scaffold a new app

Default layout is already in place when you start. Add or modify files; do not move `package.json` unless the user explicitly asks. Place handlers under `queries/`, `actions/` as `.js` files following the patterns above.
