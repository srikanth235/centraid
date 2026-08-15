# @centraid/app-engine

Transport-agnostic runtime for Centraid apps. It owns the app registry, declared-handler execution, app-scoped HTTP routes, and the conversation ledger used by chat, workspace, and automation turns. [`@centraid/gateway`](../gateway) supplies paths, vault access, auth, and host services.

## Runtime surface

`Runtime.handle` dispatches the app-engine portion of `/centraid/*` ([router.ts](src/http/router.ts)):

- app registry and per-app settings/logs;
- declared `actions` and `queries`, validated with Ajv and executed in workers ([dispatcher.ts](src/handlers/dispatcher.ts));
- change notifications over SSE;
- app-scoped conversation turns over SSE; and
- conversation/user routes mounted alongside the app routes.

The old `/centraid/_tool/centraid_*` and `_sql` surfaces are gone, and so is UI-byte serving — #799 retired the served plane, so the engine serves an app's **data**, never its bytes. The git code store (cloned automation sources) belongs to the gateway; the bundled system apps are compiled into the client.

## Conversation ledger

The ledger is a mutable band in each vault's `journal.db`, not a per-app `runtime.sqlite` or a central analytics database. Its core model is **conversation ⊃ turn ⊃ item**:

- `conversations` — durable chat, build, or automation threads;
- `turns` — executions under a conversation; and
- `items` — ordered input, model-step, tool, and delegate trace rows.

The same file also carries attachments metadata, automation state, archival indexes, harness health, and the `run_summary` view used by Insights. App data lives in the vault plane; handlers reach it through injected `ctx.vault`/`ctx.db` capabilities rather than opening gateway-owned files.

## Invariants

- The gateway injects the active vault workspace; app-engine never discovers vaults or opens a vault on its own.
- Writes publish change notifications only after their SQLite transaction commits.
- The ledger band is ensured idempotently and does not own the vault package's `PRAGMA user_version` migration ladder.

## Build / test

```sh
bun run build
bun run test
bun run typecheck
```
