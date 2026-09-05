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
bun run --cwd packages/vault typecheck
bun run --cwd packages/vault test -- src/gateway/gateway.contract.test.ts src/gateway/read-batch.test.ts src/golden-vault.test.ts src/schema/ontology-doc.test.ts src/schema/migrate.test.ts
bun run --cwd packages/server test -- src/routes/push-wake-routes.test.ts src/routes/vault-routes.test.ts src/lifecycle/automation-anchor-scopes.test.ts src/serve/vault-plane-consent.test.ts src/serve/protocol-join-lane.test.ts src/serve/manifest-scope-denial.sweep.test.ts src/routes/replica-shape-parity.test.ts
bun run test:integration:mobile -- tests/integration-mobile/denied.integration.test.ts tests/integration-mobile/parked.integration.test.ts
```

## Audit

PASS — the reconciliation removes the obsolete edge/outbox dependency, restores the subscription-compatible placement route, and was independently checked against the PR's requested merge-and-green-build outcome.

## What changed (CI green, #928 restore)

- Restored #928 owner-direct `skipsAllowReceipt` on `read()` / `changes()`, confirmation parking when a first-party app names a `surface`, provenance-scope surface check, `callerName` surface-before-owner order, and confirm-after-revoke reason `standing answer no longer live`, while keeping #929 `onBehalfOfMember` parking.
- Added vault schema **rung 5** (`SHARE_AUTHORITY_ASK_DDL`) so `share_authority_request` / `share_authority_use` reach files frozen at `user_version` 2 (the #929 golden never re-runs rung 1).
- Synced `ontology-body.html` access-plane tables, machinery outbox (`item` only), and share ask/use tables to live schema.
- Re-froze `packages/vault/tests/golden/issue-929` at schema v5 after the ladder grew (DDL-equality after migrate); the freeze founds a current vault, it does not rewrite history.
- Restored People's `share.authority_use` / `share.authority_request` reads so Settings → Access can date answers and draw pending asks; re-pinned the people replica shape id.
- Restored `add-person`'s seat-minted `party_id` (#922 G2) so a mobile write made while the app is still trusted is not a schema denial.
- Pinned People reads (`share.authority_request` / `share.authority_use`), pending-parent child-write count 105, and ledger-opener `user_version` 5.
