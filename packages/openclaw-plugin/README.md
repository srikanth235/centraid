# @centraid/openclaw-plugin

OpenClaw plugin that mounts a single `/centraid` prefix on the gateway and dispatches to **user-generated apps**. Each app is a folder of static assets + a sqlite database + JS handlers.

## URL surface

### Registry & uploads

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/centraid/_apps` | List registered apps |
| `POST` | `/centraid/_apps` | Register a path-mode app: `{ id, path }` |
| `DELETE` | `/centraid/_apps/<id>` | Deregister |
| `POST` | `/centraid/_apps/<id>/upload` | Upload tar.gz of an uploaded-mode app — auto-registers + activates |
| `GET` | `/centraid/_apps/<id>/versions` | List versions with active flag |
| `POST` | `/centraid/_apps/<id>/activate` | Atomic version flip: `{ versionId }` |
| `DELETE` | `/centraid/_apps/<id>/versions/<versionId>` | Prune a single non-active version |

### Per-app surface (works for both modes)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/centraid/<id>/` | Serves `index.html` from the active code dir |
| `GET` | `/centraid/<id>/<file>` | Static asset (extension allowlist) |
| `GET` | `/centraid/<id>/_changes` | SSE stream of mutations (table-level invalidations) |
| `POST` | `/centraid/<id>/_chat` | Send a chat turn → SSE stream of normalized events |
| `GET` | `/centraid/<id>/_chat/windows` | List per-window chat metadata |
| `GET` | `/centraid/<id>/_chat/windows/<wid>/history` | Replay one window's transcript |
| `DELETE` | `/centraid/<id>/_chat/windows/<wid>` | Clear one window |

App ids starting with `_` are reserved (so `_apps`, `_chat` etc. can't collide).

### Three-tool invocation surface (issue #107)

All handler invocations flow through three generic tools, available both as OpenClaw agent tools and as an HTTP shim:

| Tool | HTTP | Purpose |
| --- | --- | --- |
| `centraid_describe` | `POST /centraid/_tool/centraid_describe` | Return the app manifest (or a filtered slice). Body: `{ app?, action?, query? }` |
| `centraid_read` | `POST /centraid/_tool/centraid_read` | Invoke a query handler. Body: `{ app, query, input }` |
| `centraid_write` | `POST /centraid/_tool/centraid_write` | Invoke an action handler. Body: `{ app, action, input }` |

The dispatcher validates `input` against the JSON Schema declared in `app.json` (Ajv, draft 2020-12) before invoking the handler. Errors come back as MCP-shaped `isError: true` envelopes with a `{ code, message, path? }` payload; the HTTP shim maps `code` to a 4xx/5xx status (`UNKNOWN_APP`/`UNKNOWN_ACTION`/`UNKNOWN_QUERY` → 404, `WRONG_KIND`/`INVALID_INPUT` → 400, `NO_ACTIVE_VERSION` → 503, `INVALID_MANIFEST`/`HANDLER_ERROR` → 500).

### Chat surface (host-agnostic)

The `_chat` routes live in `@centraid/runtime-core` and are served identically on both gateway hosts. The plugin/host owns initiation but never the model loop:

- **OpenClaw** injects an in-process `ChatRunner` that calls `api.runtime.agent.runEmbeddedAgent`. Plugin-registered tools (`centraid_sql_*`) dispatch server-side.
- **Desktop embedded local runtime** uses `@centraid/agent-runtime`'s `makeChatRunner`, which drives codex app-server (subprocess) or the Claude Agent SDK (in-process). The agent shells out to the bundled `centraid` CLI for SQL access.

Either way, the harness client at `@centraid/chat-harness` sees one HTTP/SSE contract.

Per-window transcripts live at `<appsDir>/<id>/_chat/w<windowId>.jsonl`; a sibling `index.json` records mode + adapter session id so the next turn can resume.

## App modes

An app is one of two modes, decided at registration:

- **`uploaded`** — registered + content delivered via `POST /centraid/_apps/<id>/upload`. Code is **versioned**; data is persistent across versions.

  ```
  <appsDir>/<id>/
    data.sqlite                   ← persistent, never moved
    current.json                  ← { activeVersion, history } (atomic pointer)
    versions/
      v_<UTC ts>_<sha[:6]>/       ← immutable, code-only
      v_…/
  ```

- **`path`** — registered with `{ id, path: "/external/folder" }`. The plugin reads code, data, and handlers directly from that folder. No versioning, no upload.

The same per-app URL surface works for both — the plugin transparently resolves the active code dir.

## Upload flow

```sh
# In the app folder you want to publish:
tar czf - --exclude data.sqlite --exclude current.json --exclude versions . | \
  curl -X POST --data-binary @- \
       -H "Content-Type: application/gzip" \
       https://gw/centraid/_apps/my-app/upload
```

- First upload to a new id auto-registers it as `mode: "uploaded"`.
- Each upload becomes an immutable version dir; `current.json#activeVersion` flips atomically once extraction succeeds.
- Re-uploading identical content (same sha256) collapses to a single version dir; history records the latest timestamp.
- After upload, retention pruning keeps the most recent N versions (default 5; `versionRetention` in plugin config; minimum 2).
- The active version is always retained regardless of N.

### Rolling back

```sh
curl https://gw/centraid/_apps/my-app/versions
curl -X POST -d '{"versionId":"v_2026-05-08T14-30-00-000Z_a1b2c3"}' \
     -H "Content-Type: application/json" \
     https://gw/centraid/_apps/my-app/activate
```

`activate` is just a write to `current.json`; no extraction, no downtime, instant.

### What's accepted in the tarball

- **Allowed**: `.html .htm .css .js .mjs .ts .json .md .txt .svg .png .jpg .jpeg .webp .gif .ico .woff .woff2 .ttf .otf .map`
- **Refused** (returns 400): `data.sqlite` (it's not part of versioned code — it persists alongside versions), `_registry.json`, `current.json`, anything outside the extension allowlist, symlinks, hardlinks, devices, paths that escape the archive root.
- Caps: 50 MiB total, 5 MiB per file, 5 000 entries max.

## App folder layout

```
<appsDir>/<app_id>/
  index.html
  app.css, app.js, …       # static — see allowlist below
  data.sqlite              # never served as a static file
  queries/<name>.js        # dispatched by centraid_read against queries[name]
  actions/<name>.js        # dispatched by centraid_write against actions[name]
  app.json                 # the app manifest (manifestVersion, actions[], queries[], …)
```

Static extension allowlist: `.html .htm .css .js .mjs .json .svg .png .jpg .jpeg .webp .gif .ico .woff .woff2 .ttf .otf .map`.

## Handler contract

Both handler kinds use the **same** `{ db, log, app, ctx }` surface; only the kind-specific fields differ.

The plugin **loads `.js` files only** at runtime. You can author in TypeScript (recommended — see below) and ship the compiled `.js` next to it.

All `db.*` calls are async. Always `await` — forgetting it is the #1 handler bug.

```ts
// queries/list-pending.ts
import type { QueryHandler } from "@centraid/openclaw-plugin";
export default (async ({ query, db }) => {
  return await db
    .prepare("SELECT * FROM issues WHERE state = ?")
    .all(query.state ?? "open");
}) satisfies QueryHandler;
```

```ts
// actions/rebuild.ts
import type { ActionHandler } from "@centraid/openclaw-plugin";
export default (async ({ body, db, log }) => {
  log.info(`rebuild requested with ${JSON.stringify(body)}`);
  return { status: 200, body: { ok: true } };
}) satisfies ActionHandler;
```

## Authoring apps in TypeScript

Recommended workflow. You author `.ts`; the plugin loads the compiled `.js` next to it. No experimental Node flags, no compiler in the gateway process.

Two starter files ship in this package under `templates/`:

```sh
cp node_modules/@centraid/openclaw-plugin/templates/app-tsconfig.json   <appsDir>/<id>/tsconfig.json
cp node_modules/@centraid/openclaw-plugin/templates/app-package.json    <appsDir>/<id>/package.json
cd <appsDir>/<id>
bun install      # or npm / pnpm
bun run build    # tsc → emits .js next to each .ts
```

The shipped `tsconfig.json` uses `"rootDir": "."` and `"outDir": "."`, so `queries/foo.ts` builds to `queries/foo.js` in place. The plugin then loads the `.js`. Use `bun run watch` during development.

If you'd rather skip TypeScript entirely, drop the `.ts` files and write `.js` directly — the loader doesn't care which authoring path you took.

The handler-arg types are exported from `@centraid/openclaw-plugin`:

| Export | Use |
| --- | --- |
| `QueryHandler` | `satisfies QueryHandler` on a query default export |
| `ActionHandler` | `satisfies ActionHandler` on an action default export |
| `QueryHandlerArgs`, `ActionHandlerArgs` | Args type if you prefer explicit destructuring annotations |
| `ScopedDb`, `ScopedLog`, `AppRef` | Sub-surfaces of the args object |

`db` is a proxy: each call round-trips to the plugin process which owns the `data.sqlite` connection — the worker never sees a path to another app's database. `ctx.fetch` is a timeout-bound `fetch`. There is no `fs`, `child_process`, or `process.env` provided.

## Configuration (`configSchema`)

| Key | Default | Notes |
| --- | --- | --- |
| `appsDir` | `centraid` (resolved under `$OPENCLAW_STATE_DIR`, default `~/.openclaw`) | Where app folders live. Absolute paths are used as-is. |
| `versionRetention` | `5` | Max versions kept per uploaded app (active always retained; min 2) |

The registry persists at `<appsDir>/_registry.json`.

## Trust & security model

**Trusted local code.** App handlers are authored by the same user running the gateway. Worker-thread isolation here gives crash isolation, timeouts, and a controlled API surface — **not** a security sandbox against hostile code. Hardening to that level (`isolated-vm`, child-process + permission flags) is a future swap-in.

Defense-in-depth that's already in place:

- Path-traversal guard on every static lookup (`path.resolve` + prefix check).
- Static-asset extension allowlist; reserved filenames (`data.sqlite`, `_registry.json`, `app.json`) and reserved directories (`queries`, `actions`) are never served.
- Per-response CSP `default-src 'self'`, `X-Content-Type-Options: nosniff`.
- Worker `resourceLimits` cap memory; configurable `timeoutMs` per handler (default 10s query / 30s action).
- 1 MiB body limit on every request that reads a body.

## Agent tools

The plugin also registers three agent tools used by any OpenClaw-side agent that needs to read or mutate a centraid app's data:

| Tool                    | Purpose                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `centraid_sql_describe` | Returns `{tables, views, indexes}` for the calling app's `data.sqlite`.                                                  |
| `centraid_sql_read`     | Runs one read-only SELECT against the calling app's `data.sqlite`. Multi-statement is rejected.                          |
| `centraid_sql_write`    | Runs one INSERT/UPDATE/DELETE/REPLACE against the calling app's `data.sqlite`. DDL and PRAGMA are refused.               |

All three take `appId` as a parameter. A `before_tool_call` hook on the plugin enforces that `appId` matches the calling session's app — the chat client opens its session as `centraid-chat:<appId>:w<windowId>`, and the hook parses that key. Cross-app reads/writes (and any disallowed statement shape) are refused at the gateway before `execute` runs. Successful writes also emit through `runtime.changeBus`, so any subscriber on `/centraid/<appId>/_changes` learns about the mutation.

The desktop app's in-app chat goes through the same `_chat` HTTP/SSE contract (see [@centraid/chat-harness](../chat-harness)). The openclaw-registered tools above are used by the in-gateway agent path; the desktop's local-runtime path drives codex / Claude via [@centraid/agent-runtime](../agent-runtime) and reaches the SQL surface through the bundled `centraid` CLI.

### Enabling the tools in `~/.openclaw/openclaw.json`

Plugin-registered tools don't belong to any built-in tool profile. The cleanest way to expose them without widening the global profile is `tools.alsoAllow`, which is additive on top of the active profile:

```json
{
  "tools": {
    "profile": "coding",
    "alsoAllow": ["centraid_sql_describe", "centraid_sql_read", "centraid_sql_write"]
  }
}
```

A small helper script is shipped to patch the user's config idempotently:

```sh
node packages/openclaw-plugin/scripts/setup-tools.mjs
```

It reads `~/.openclaw/openclaw.json`, merges the three tool ids into `tools.alsoAllow`, and writes the file back atomically. Safe to re-run.

## Building

```sh
bun install                          # at repo root
bun run --filter @centraid/openclaw-plugin build
```

SQLite is provided by Node's built-in `node:sqlite` (stable in Node ≥ 24; available behind `--experimental-sqlite` on 22.5 – 23.x). No native build step.
