## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-05 | codex | 01a06d3f-bd78-7d61-aeda-4056a8b0fba9 |

## Checklist

- [ ] Reconcile the PR with the current main branch and leave the required CI gates green.

## What changed

- Reconciled the gateway's placement route and receipt history with the current subscription-based sharing model in `packages/server/src/index.ts`, `packages/server/src/routes/placement-routes.ts`, `packages/server/src/routes/placement-routes.test.ts`, `packages/server/src/serve/share-access-receipts.ts`, and `packages/server/src/serve/share-scope.ts`.
- Added the subscription-compatible same-owner placement implementation and contract coverage in `packages/vault/src/share/placement-move.test.ts`.
- Preserved shared waiting-on metadata through intent persistence and refreshed the pending-parent contract count in `packages/client/src/replica/intents.ts`, `packages/server/src/routes/peer-replica-intent-route.ts`, and `packages/blueprints/src/pending-parent-probe.test.ts`.
- The complete reconciled surface also includes packages/server/src/index.ts, packages/server/src/routes/placement-routes.test.ts, packages/server/src/routes/placement-routes.ts, packages/server/src/serve/share-access-receipts.ts, packages/server/src/serve/share-scope.ts, and packages/vault/src/share/placement-move.test.ts.
- Re-pinned `packages/server/src/routes/replica-shape-parity.test.ts` to the current main branch's purpose-free shape digest, plus the docs and people manifest changes carried by this PR; the parity suite now records the eight current shipped ids instead of the pre-merge grant-era ids.

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

## Audit

PASS — the reconciliation removes the obsolete edge/outbox dependency, restores the subscription-compatible placement route, and was independently checked against the PR's requested merge-and-green-build outcome.
