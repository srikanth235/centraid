# @centraid/openclaw-plugin

OpenClaw plugin — a thin shim over `@centraid/gateway`. The whole store / runtime / route graph is built by `buildGateway()` (the same host-agnostic core the desktop embed and the standalone daemon mount); this package only adapts it to the OpenClaw host. It mounts the gateway's auth-bearing route prefixes and dispatches to **user-generated apps**. Each app is a folder of static assets + JS handlers; app **code** is backed by the gateway-owned git store, app **data** by the owner's vault (issue #286 phase 2 — apps are projections; there is no per-app database).

## Mounted routes

The plugin's `register()` mounts `gw.composedHandler` (the gateway route chain **minus** the bearer check — OpenClaw owns auth, so these routes are registered at `auth: 'gateway'`) on three prefixes:

| Prefix | Purpose |
| --- | --- |
| `/centraid` | App registry, per-app surface, the three-tool HTTP shim, the template catalog |
| `/_centraid-conversations` | Conversation (chat/build/automation) turn + transcript surface |
| `/_centraid-user` | Per-user store (prefs, identity) |

A fourth route, `/_centraid-hook`, is mounted separately at `auth: 'plugin'` (it verifies its own shared secret, not the gateway bearer) and fronts every automation that declares a `webhook` trigger.

### Registry & per-app surface (under `/centraid`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/centraid/_apps` | List registered apps |
| `DELETE` | `/centraid/_apps/<id>` | Deregister |
| `GET` | `/centraid/_apps/<id>/schema` | App schema (tables/views/indexes) |
| `GET` | `/centraid/_apps/<id>/data/<table>` | Read rows from one table |
| `POST` | `/centraid/_apps/<id>/query` | Run a query handler over HTTP |
| `GET` | `/centraid/_apps/<id>/logs` | Handler log tail |
| `GET` | `/centraid/<id>/` | Serves `index.html` from the live `main` code dir |
| `GET` | `/centraid/<id>/<file>` | Static asset (extension allowlist) |
| `GET` | `/centraid/<id>/_changes` | SSE stream of mutations (table-level invalidations) |
| `*` | `/centraid/<id>/_turn[/...]` | Per-app conversation surface (see below) |
| `GET` | `/centraid/_templates` | Resolved template-gallery metadata (bundle-or-cache) |
| `GET` | `/centraid/_turn/runner-status` | Gateway-wide runner preflight |

App ids starting with `_` are reserved (so `_apps`, `_turn`, `_templates`, `_tool` etc. can't collide).

App **creation, clone, and publish** do not live here — they go through the gateway's apps-store / lifecycle surface (`POST /centraid/_apps`, `POST /centraid/_apps/_clone`, plus the git-store session/files/publish routes). The tarball-upload + version-flip flow was retired with the move to the git store (issue #137); there is no `/upload`, `/versions`, or `/activate` route.

### Three-tool invocation surface (issue #107)

All handler invocations flow through three generic tools, available as an HTTP shim (the app UI's door to declared handlers; the matching OpenClaw *agent* tools died with the per-app silo — issue #286 phase 2):

| Tool | HTTP | Purpose |
| --- | --- | --- |
| `centraid_describe` | `POST /centraid/_tool/centraid_describe` | Return the app manifest (or a filtered slice). Body: `{ app?, action?, query? }` |
| `centraid_read` | `POST /centraid/_tool/centraid_read` | Invoke a query handler. Body: `{ app, query, input }` |
| `centraid_write` | `POST /centraid/_tool/centraid_write` | Invoke an action handler. Body: `{ app, action, input }` |

The dispatcher validates `input` against the JSON Schema declared in `app.json` (Ajv, draft 2020-12) before invoking the handler. Errors come back as MCP-shaped `isError: true` envelopes with a `{ code, message, path? }` payload; the HTTP shim maps `code` to a 4xx/5xx status.

### Conversation surface (host-agnostic)

The per-app conversation routes (`/centraid/<id>/_turn[/...]`, served from `@centraid/app-engine`) carry every turn — `kind ∈ {chat, build, automation}` — and are served identically on both gateway hosts. The plugin/host owns initiation but never the model loop:

- **OpenClaw** injects `makeOpenClawConversationRunner`, an in-process runner that drives `api.runtime.agent.runEmbeddedAgent`. Plugin-registered `centraid_*` tools dispatch server-side.
- **Desktop embedded local runtime** uses `@centraid/agent-runtime`'s conversation runner, which drives the codex app-server (subprocess) or the Claude Agent SDK (in-process). That agent reaches an app's data through the same three-tool surface.

Either way, every client — the desktop renderer, the mobile companion — sees one HTTP/SSE contract.

## App layout on disk

Post-#280 the **vault is the unit** — everything personal (app code, app data, the conversation ledger, run history) lives inside one vault directory. The plugin's `appsDir` config knob now just anchors the root one level up (`dbDir = dirname(appsDir)`); the plugin passes `buildGateway` a `vaultDir` and `prefsFile` under that root, and the gateway mounts the vault registry there:

```
<dbDir>/                       (one level up from the configured appsDir root)
  centraid-vault/              ← vault registry root: one subdirectory per vault
    <vaultId>/
      vault.db                 ← the ontology schemas (one ACID boundary)
      journal.db               ← audit stream + conversation ledger + run_summary view
      apps/                    ← per-app DATA
        <id>/
          logs.jsonl           ← handler logs, never moved on publish
          settings.json        ← per-app settings (knobs, automation toggles)
      code/                    ← app CODE git store: apps.git + worktrees/
      runner-sessions/         ← codex/claude thread state for in-app chat
  centraid-prefs.json          ← device prefs (runner choice, binPath, …)
```

App **code** is backed by the per-vault git store (issue #137), not a per-app `versions/` tree. The runtime serves handlers + static assets from the vault's live `main` worktree (`gw.codeAppsDir()`, a stable symlink repointed atomically on each publish). Publishing replaces the legacy tarball-upload + version-flip flow: a draft session stages files into the git store, and a publish commits them onto `main` and repoints the live symlink. There is no upload tarball, no `current.json`, no `versions/` dir. There is no `identity.sqlite` or central `analytics.sqlite`: the vault owner is the user, and the run rollup is the `run_summary` view inside each vault's `journal.db`.

## App folder layout

```
<appsDir>/<app_id>/
  index.html
  app.css, app.js, …       # static — see allowlist below
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

Optional workflow. You author `.ts`; the runtime only ever loads the compiled `.js` next to it. No experimental Node flags, no compiler in the gateway process.

One starter file ships in this package under `templates/`:

```sh
cp node_modules/@centraid/openclaw-plugin/templates/app-package.json <appsDir>/<id>/package.json
```

`app-package.json` wires the `@centraid/openclaw-plugin` dev dependency (for the exported handler types); add your own `tsconfig.json` with `"rootDir": "."` and `"outDir": "."` so `queries/foo.ts` builds to `queries/foo.js` in place, then run `tsc`. The runtime loads the emitted `.js`.

If you'd rather skip TypeScript entirely, write `.js` directly — the loader doesn't care which authoring path you took, and the bundled templates ship plain `.js`.

The handler-arg types are exported from `@centraid/openclaw-plugin`:

| Export | Use |
| --- | --- |
| `QueryHandler` | `satisfies QueryHandler` on a query default export |
| `ActionHandler` | `satisfies ActionHandler` on an action default export |
| `QueryHandlerArgs`, `ActionHandlerArgs` | Args type if you prefer explicit destructuring annotations |
| `ScopedVault`, `ScopedLog`, `AppRef` | Sub-surfaces of the args object |

`ctx.vault` is a proxy: each call round-trips to the plugin process which holds the vault credential — the worker never sees a key or file handle. `ctx.fetch` is a timeout-bound `fetch`. There is no `fs`, `child_process`, or `process.env` provided.

## Configuration (`configSchema`)

The plugin reads exactly one config key at `register()` time:

| Key | Default | Notes |
| --- | --- | --- |
| `appsDir` | `centraid` (resolved under `$OPENCLAW_STATE_DIR`, default `~/.openclaw`) | Anchors the gateway root. Absolute paths are used as-is; relative paths resolve under the OpenClaw state dir. Post-#280 per-app data no longer lives here directly — it lives inside a vault (see the on-disk layout above). |

The vault registry (`centraid-vault/`) and device prefs (`centraid-prefs.json`) live one level up from `appsDir` (`dbDir = dirname(appsDir)`). Each vault holds its own `vault.db` + `journal.db` + `apps/` (data) + `code/` (git store) — there are no gateway-root SQLite siblings.

## Trust & security model

**Trusted local code.** App handlers are authored by the same user running the gateway. Worker-thread isolation here gives crash isolation, timeouts, and a controlled API surface — **not** a security sandbox against hostile code. Hardening to that level (`isolated-vm`, child-process + permission flags) is a future swap-in.

Defense-in-depth that's already in place:

- Path-traversal guard on every static lookup (`path.resolve` + prefix check).
- Static-asset extension allowlist; reserved filenames (e.g. `data.sqlite`, `app.json`) and reserved directories (`queries`, `actions`) are never served.
- Per-response CSP `default-src 'self'`, `X-Content-Type-Options: nosniff`.
- Worker `resourceLimits` cap memory; configurable `timeoutMs` per handler.
- A body limit on every request that reads a body.

## Agent tools

The plugin registers three structured agent tools (`registerCentraidTools`) for any OpenClaw-side agent that needs to address a centraid app's declared surface. These are the **same three tools** the agent runtime and the `/centraid/_tool/<name>` HTTP shim expose — one tool family across every host:

| Tool                | Purpose                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `centraid_describe` | Return an app's manifest (or a filtered slice). With no `app`, lists every registered app.    |
| `centraid_read`     | Invoke a declared query (read-only), or the `_sql` escape hatch for a raw SELECT.             |
| `centraid_write`    | Invoke a declared action, or the `_sql` escape hatch for a raw write.                         |

`centraid_read`/`centraid_write` require an `app` parameter; `centraid_describe` may be called with no `app` to list every app. A `before_tool_call` hook enforces scope: the conversation client opens its session with `sessionKey = "centraid-conversation:<appId>"` (OpenClaw stores it as e.g. `agent:main:centraid-conversation:todos`), and the hook locates that substring to derive the calling app. A call that addresses a different `app` is blocked before `execute` runs; a call that omits `app` is back-filled with the session's app. Successful writes emit through `runtime.changeBus`, so any subscriber on `/centraid/<appId>/_changes` learns about the mutation.

The desktop's in-app conversations go through the same `/centraid/<id>/_turn` HTTP/SSE contract. The tools above back the in-gateway agent path; the desktop's local-runtime path drives codex / Claude via [@centraid/agent-runtime](../agent-runtime) and reaches the same three-tool surface.

## Building

```sh
bun install                          # at repo root
bun run --filter @centraid/openclaw-plugin build
```

SQLite is provided by Node's built-in `node:sqlite` (stable in Node ≥ 24; available behind `--experimental-sqlite` on 22.5 – 23.x). No native build step.
