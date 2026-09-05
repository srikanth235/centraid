## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-05 | codex | 01a06d3f-bd78-7d61-aeda-4056a8b0fba9 |

## What changed

- Reconciled the gateway's placement route and receipt history with the current subscription-based sharing model in `packages/server/src/index.ts`, `packages/server/src/routes/placement-routes.ts`, `packages/server/src/routes/placement-routes.test.ts`, `packages/server/src/serve/share-access-receipts.ts`, and `packages/server/src/serve/share-scope.ts`.
- Added the subscription-compatible same-owner placement implementation and contract coverage in `packages/vault/src/share/placement-move.test.ts`.

## Out of scope

The subscription model and unrelated application surfaces were not changed.

## Decisions

Obsolete edge rows, effect-outbox code, and peer-sweep draining were removed because the current model makes same-owner placement synchronous and retains only placement history plus subscription lineage.

## Verification

```text
bun run typecheck
bun run check:reachability
bun run lint:vault-sql
bun run lint:product
```
