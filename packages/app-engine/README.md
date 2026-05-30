# @centraid/app-engine

Transport-agnostic engine for centraid apps. Owns the registry,
versioned uploads, sqlite-backed handler runner, and the full
`/centraid/*` URL surface exposed through `Runtime.handle(req, res)`.
Consumed by [`@centraid/gateway-runtime`](../gateway-runtime) (Electron
embed + standalone daemon) and [`@centraid/openclaw-plugin`](../openclaw-plugin)
(OpenClaw gateway shim).

## Concurrency

The standalone daemon (centraid#131) is the first deployment where
multiple HTTP clients write to the same gateway state. The engine
expects:

- **Per-app `data.sqlite`** opens with `PRAGMA journal_mode = WAL`,
  `PRAGMA foreign_keys = ON`, and `PRAGMA busy_timeout = 30000` on
  every connection ([handler-runner.ts](src/handler-runner.ts),
  [run-query.ts](src/run-query.ts), [sql-ops.ts](src/sql-ops.ts),
  [schema.ts](src/schema.ts), [table-rows.ts](src/table-rows.ts),
  [app-settings.ts](src/app-settings.ts)).
- **Identity / analytics DBs** ([gateway-db.ts](src/gateway-db.ts))
  use the same trio in their opener.
- **One writer at a time per file** — SQLite enforces this at the
  database layer; `busy_timeout` is what lets contending writers
  back off for up to 30s instead of failing immediately.
- **Change-bus emit-after-commit** ([change-bus.ts](src/change-bus.ts))
  fires from the per-handler `finish()` and from `run-query.ts` only
  after the implicit/explicit COMMIT, so subscribers never observe a
  change before it's durable.
- **Version uploads** serialize through
  [`makeAppUploadLocks`](src/upload-lock.ts) — two simultaneous
  `POST /centraid/_apps/<id>/upload` calls for the same app run
  sequentially. Different apps proceed in parallel.
- **`_registry.json` writes** go through a tmp + atomic `rename`
  ([registry.ts](src/registry.ts)) so a reader never sees a partial
  file even if the writer crashes mid-write.

Covered by [concurrent-writers.test.ts](src/concurrent-writers.test.ts):
50 parallel `writeOp` calls against the same file land deterministically;
a polling reader concurrent with N writers never observes SQLITE_BUSY.

## Build / test

```sh
bun run build
bun run test
bun run typecheck
```
