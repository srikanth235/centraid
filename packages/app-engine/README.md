# @centraid/app-engine

Transport-agnostic engine for centraid apps. Owns the registry,
sqlite-backed handler runner, the three-tool dispatcher, the per-app
conversation ledger, and the full `/centraid/*` URL surface exposed
through `Runtime.handle(req, res)`. App code is served from the
gateway-owned git store via the host's `codeDirOverride` (issue #137).
Consumed by [`@centraid/gateway`](../gateway) (Electron
embed + standalone daemon).

## What it serves

`Runtime.handle` dispatches the `/centraid/*` surface ([router.ts](src/http/router.ts)):

- **Registry reads** — `GET /centraid/_apps`, `DELETE /centraid/_apps/<id>`.
  (Code publishing/versioning is the git-store surface in `@centraid/gateway`,
  not here.)
- **Cloud-panel state** — `GET …/logs`, `GET/PUT …/settings`
  ([cloud-routes.ts](src/http/cloud-routes.ts)). App DATA lives in the
  vault (issue #286 phase 2) — there is no per-app database to browse.
- **Declared-handler dispatcher** — `POST /centraid/<id>/actions/<action>`,
  `POST /centraid/<id>/queries/<query>`, `GET /centraid/<id>/_describe`
  ([dispatcher.ts](src/handlers/dispatcher.ts)): reads `app.json`, validates the
  `{ input? }` body with Ajv, runs the handler in the worker. Declared handlers
  ONLY — the `_sql` builtin died with the silo. (Issue #505 retired the old
  `/centraid/_tool/centraid_*` shim in favour of these app-scoped routes.)
- **Per-app** — `GET /centraid/<id>/` + `/<file>` (static, [security.ts](src/http/security.ts)
  allowlist), `GET /centraid/<id>/_changes` (SSE, [changes-sse.ts](src/http/changes-sse.ts)),
  `POST /centraid/<id>/_turn` (chat turn → SSE, [turn-routes.ts](src/http/turn-routes.ts)).
- **Stores the host mounts alongside** — `/_centraid-conversations/*`
  ([conversation-routes.ts](src/http/conversation-routes.ts)) and `/_centraid-user/*`.

## The conversation ledger

Each app owns a `runtime.sqlite` with the **conversation ⊃ turn ⊃ item**
model ([gateway-db.ts](src/stores/gateway-db.ts) `RUNTIME_MIGRATIONS`,
[conversation/schema.ts](src/conversation/schema.ts)):

- `conversations` — the durable thread; `kind ∈ {chat, build, automation}`
  lives here, not per-turn. Each automation has one long-lived conversation
  tagged with `automation_id`; compile and fire executions append turns.
- `turns` — one execution; carries the token/cost rollup written at finish.
- `items` — the ordered trace: `message_in` (ordinal 0, the inbound message),
  `step` (one model call, the token/cost grain), `tool`/`agent` (audit rows).
- `attachments` — inbound-file metadata; bytes are content-addressed on disk
  at `<appsDir>/<appId>/blobs/<hash>` ([blob-store.ts](src/data/blob-store.ts)),
  never in sqlite.
- `automation_state` — per-automation KV.

There is no `run`/`run_nodes` layer (renamed/reshaped in #190). A finished
turn write-throughs one `run_summary` row to the gateway analytics DB
([insights/](src/insights)) for the Insights screen.

## Concurrency

The standalone daemon (centraid#131) is the first deployment where
multiple HTTP clients write to the same gateway state. The engine
expects:

- **App data lives in the vault** (issue #286 phase 2) — there is no
  per-app database; handlers reach data through `ctx.vault` and the
  vault gateway owns the connection discipline.
- **Identity / analytics DBs** ([gateway-db.ts](src/stores/gateway-db.ts))
  use the same trio in their opener.
- **One writer at a time per file** — SQLite enforces this at the
  database layer; `busy_timeout` is what lets contending writers
  back off for up to 30s instead of failing immediately.
- **Change-bus emit-after-commit** ([change-bus.ts](src/changes/change-bus.ts))
  fires from the per-handler `finish()` and from `run-query.ts` only
  after the implicit/explicit COMMIT, so subscribers never observe a
  change before it's durable.
- **`_registry.json` writes** go through a tmp + atomic `rename`
  ([registry.ts](src/registry/registry.ts)) so a reader never sees a partial
  file even if the writer crashes mid-write.

## Build / test

```sh
bun run build
bun run test
bun run typecheck
```
