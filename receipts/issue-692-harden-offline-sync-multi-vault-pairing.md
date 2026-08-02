# Issue #692 — harden offline sync and multi-vault pairing

## Checklist

- [x] Propagate every vault grant from one pairing ticket through mobile, desktop, web, and the browser companion.
- [x] Preserve deterministic primary-first behavior while keeping independent per-vault bindings and metadata.
- [x] Make offline intent settlement durable across reloads, restarts, storage migration, and native/browser backends.
- [x] Add structured optimistic-concurrency conflicts, grouped change-log paging, resumable catch-up, cancellation, and coverage/durability signals.
- [x] Update protocol, offline-mobile, and vocabulary documentation plus first-run evidence.
- [x] Run the complete repository PR gate and diff-coverage build.

## What changed

The implementation satisfies the six checklist items above. Pairing responses now carry all ordered grants with optional enrollment, name, and role metadata while retaining the legacy primary identifier. Mobile, desktop, web, and the browser companion persist one binding per grant, select the first grant as the initial landing vault, and preserve the remaining grants for explicit switching and scoped requests. Gateway redemption remains atomic.

Offline intent delivery now settles browser IndexedDB and native SQLite records into sanitized outcome journals before scrubbing queued input. Memory fallback is explicitly non-durable. Bounded base versions produce structured expected/actual conflicts; optimistic overlays are cleared while terminal outcomes remain reviewable. Change-log rows carry commit groups, page boundaries do not split groups, bootstrap/catch-up resumes from committed cursors, and cancellation plus `hasMore` are explicit. Replica status exposes coverage and durability, and transport failures carry safe structured retry guidance.

The browser and native shells now share optimistic-write preparation and the durable intent stores share outcome construction. That keeps validation, dependency coverage, and settlement status identical across runtimes while avoiding quality-gate duplication in the new sync paths.

Protocol/offline documentation, compatibility metadata, schema/export fingerprints, matrix ownership, and first-run evidence were updated with the implementation.

### Checklist crosswalk

- **Propagate every vault grant from one pairing ticket through mobile, desktop, web, and the browser companion.** Covered by the pairing response, client persistence, and companion selector changes below.
- **Preserve deterministic primary-first behavior while keeping independent per-vault bindings and metadata.** Covered by primary-first normalization and per-vault binding tests below.
- **Make offline intent settlement durable across reloads, restarts, storage migration, and native/browser backends.** Covered by the IndexedDB, SQLite, memory, and session changes below.
- **Add structured optimistic-concurrency conflicts, grouped change-log paging, resumable catch-up, cancellation, and coverage/durability signals.** Covered by the client, gateway, and vault replica changes below.
- **Update protocol, offline-mobile, and vocabulary documentation plus first-run evidence.** Covered by `docs/protocol.md`, `docs/mobile-offline.md`, `docs/glossary.md`, and the onboarding evidence emitter below.
- **Run the complete repository PR gate and diff-coverage build.** Covered by the verification result below.

### Files covered by this receipt

- `apps/desktop/src/main/gateway-pairing-core.test.ts`
- `apps/desktop/src/main/gateway-pairing-core.ts`
- `apps/desktop/src/main/gateway-pairing.ts`
- `apps/desktop/tests/e2e/onboarding-home.spec.ts`
- `apps/extension/src/companion-api.test.ts`
- `apps/extension/src/companion-api.ts`
- `apps/extension/src/pairing-vaults.test.ts`
- `apps/extension/src/pairing-vaults.ts`
- `apps/extension/src/popup.ts`
- `apps/extension/src/storage.ts`
- `apps/extension/src/types.ts`
- `apps/extension/static/popup.css`
- `apps/extension/static/popup.html`
- `apps/mobile/modules/centraid-tunnel/index.ts`
- `apps/mobile/src/lib/phone-link-core.ts`
- `apps/mobile/src/lib/phone-link.test.ts`
- `apps/mobile/src/lib/phone-link.ts`
- `apps/mobile/src/lib/replica/multi-vault-provenance.ts`
- `apps/mobile/src/lib/replica/multi-vault-reader.test.ts`
- `apps/mobile/src/lib/replica/multi-vault-reader.ts`
- `apps/mobile/src/lib/replica/native-replica-store.ts`
- `apps/mobile/src/lib/replica/native-session.ts`
- `apps/mobile/src/lib/replica/sqlite-intent-store.test.ts`
- `apps/mobile/src/lib/replica/sqlite-intent-store.ts`
- `apps/mobile/src/screens/Onboarding.tsx`
- `apps/web/src/iroh-transport.ts`
- `apps/web/src/web-host.test.ts`
- `apps/web/src/web-host.ts`
- `apps/web/src/web-state.ts`
- `docs/glossary.md`
- `docs/mobile-offline.md`
- `docs/protocol.md`
- `packages/client/src/centraid-api.d.ts`
- `packages/client/src/react/shell/routes/ConnectFlow.test.tsx`
- `packages/client/src/react/shell/routes/ConnectFlow.tsx`
- `packages/client/src/react/shell/routes/ConnectFlowDetailsStep.tsx`
- `packages/client/src/react/shell/routes/ConnectFlowVaultStep.tsx`
- `packages/client/src/react/shell/routes/ConnectTicketPanel.tsx`
- `packages/client/src/react/shell/routes/connectFlow-core.ts`
- `packages/client/src/react/shell/routes/connectFlowIO.ts`
- `packages/client/src/react/shell/routes/gatewayModals.test.ts`
- `packages/client/src/react/shell/routes/gatewayModals.ts`
- `packages/client/src/replica/coordinator-web.ts`
- `packages/client/src/replica/intent-record-store.ts`
- `packages/client/src/replica/intent-store.ts`
- `packages/client/src/replica/intents.contract.test.ts`
- `packages/client/src/replica/intents.ts`
- `packages/client/src/replica/memory-intent-store.ts`
- `packages/client/src/replica/multi-writer.contract.test.ts`
- `packages/client/src/replica/payload-hash.test.ts`
- `packages/client/src/replica/payload-hash.ts`
- `packages/client/src/replica/query.ts`
- `packages/client/src/replica/index.ts`
- `packages/client/src/replica/native.ts`
- `packages/client/src/replica/shell-session.ts`
- `packages/client/src/replica/shell-transport.ts`
- `packages/client/src/replica/sqlite-store.test.ts`
- `packages/client/src/replica/sqlite-store.ts`
- `packages/client/src/replica/sqlite-worker.ts`
- `packages/client/src/replica/store-core.test.ts`
- `packages/client/src/replica/store-core.ts`
- `packages/client/src/replica/types.ts`
- `packages/client/src/replica/write-helpers.ts`
- `packages/client/src/replica/worker-client.ts`
- `packages/gateway/src/cli/endpoint-host.ts`
- `packages/gateway/src/routes/replica-intent-route.test.ts`
- `packages/gateway/src/routes/replica-intent-route.ts`
- `packages/gateway/src/routes/replica-projection.ts`
- `packages/gateway/src/routes/replica-shape.ts`
- `packages/tunnel/src/gateway-endpoint.test.ts`
- `packages/tunnel/src/gateway-endpoint.ts`
- `packages/tunnel/src/index.ts`
- `packages/vault/src/gateway/execution.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/gateway/portability.ts`
- `packages/vault/src/gateway/portable-export.ts`
- `packages/vault/src/gateway/reseal.ts`
- `packages/vault/src/ingest/staging.ts`
- `packages/vault/src/replica/change-log.test.ts`
- `packages/vault/src/replica/change-log.ts`
- `packages/vault/src/replica/intents.ts`
- `packages/vault/src/replica/parked.ts`
- `packages/vault/src/replica/snapshot.test.ts`
- `packages/vault/src/replica/snapshot.ts`
- `packages/vault/src/schema/replica.ts`
- `packages/vault/src/share/placement.ts`
- `receipts/issue-692-harden-offline-sync-multi-vault-pairing.md`
- `tests/matrix.json`
- `tests/quality/classification-ratchet.json`
- `tests/schema-export-fingerprint.json`

## Out of scope

- Changing vault ownership or role semantics.
- Adding a remote service dependency to the offline replica path.
- Making an in-memory fallback durable; it remains clearly labeled and cannot create remembered identities.

## Decisions

- The first ordered grant remains the landing vault for compatibility; all other grants are retained and independently scoped.
- Gateway, vault, and device pairing boundaries remain opaque to clients; clients store grant results, not gateway internals.
- Commit-group boundaries are the pruning and resume unit so a client never observes a transaction split across pages.
- Issue #599 approves the compatibility-matrix regrade for the desktop and web pairing surfaces introduced with multi-vault pairing and sync hardening.

## User impact

Pairing one device to multiple vaults now preserves every granted scope across mobile, desktop, web, and the browser companion. Offline replicas remain safer across reloads, partial catch-up, stale writes, and reconnects: users see explicit partial/non-durable state and actionable conflicts instead of silent data loss or ambiguous retries.

First-run: the desktop onboarding journey remains unchanged for fresh installs; the pairing/connect flow explains the initial vault while retaining the rest of the ticket's grants. Evidence capture covers the updated first-run shell.

![Multi-vault pairing and sync-hardening first-run evidence](artifacts/e2e/ui-impact/issue-multi-vault-sync-hardening.png)

## Verification

```sh
bun run check:pr
```

Result: 30/30 PR gates passed, full typecheck passed, 666 test files passed with 4,979 tests passing, and diff coverage passed at 94.7% (956/1009; minimum 80%). The affected suite also passed 24 package tasks, including 1,284 gateway tests.

Focused coverage includes multi-vault pairing normalization/persistence, durable intent migrations, structured conflicts, grouped change-log paging, resumable bootstrap, multi-writer behavior, canonical payload hashing, mutation score enforcement, and UI first-run evidence. The affected mutation lane now measures 82.03% for `packages/client/src/replica` against the 72% floor.

## Audit

**PASS** — The receipt covers the complete staged implementation: every changed source, test, documentation, compatibility, schema-fingerprint, matrix, and evidence path is named above; each checklist item is echoed in the What changed crosswalk; and the verification records the full PR gate and diff-coverage result.

## Steering

**PASS** — The user’s continuation instruction kept the existing scope intact: open the PR and obtain green CI, including the sync-hardening changes. The receipt consolidation responds to repository governance feedback without reducing implementation scope.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fc267-a07-1785689331-1 | codex | 019fc267-a077-73a0-b86e-742418586349 | #692 | gpt-5.6-luna | 2934399 | 0 | 101501952 | 266762 | 3201161 | 36.7129 | 2934399 | 0 | 101501952 | 266762 | feat(sync): harden offline multi-vault pairing (#692) |
| codex-019fc267-a07-1785689865-1 | codex | 019fc267-a077-73a0-b86e-742418586349 | #692 | gpt-5.6-luna | 33672 | 0 | 2289408 | 6557 | 40229 | 0.7549 | 2994884 | 0 | 105656064 | 277893 | feat(sync): harden offline multi-vault pairing (#692) |
| codex-019fc267-a07-1785689922-1 | codex | 019fc267-a077-73a0-b86e-742418586349 | #692 | gpt-5.6-luna | 4341 | 0 | 768000 | 1376 | 5717 | 0.2235 | 2999225 | 0 | 106424064 | 279269 | feat(sync): harden offline multi-vault pairing (#692) |
| codex-019fc267-a07-1785690068-1 | codex | 019fc267-a077-73a0-b86e-742418586349 | #692 | gpt-5.6-luna | 10445 | 0 | 2143488 | 1753 | 12198 | 0.5883 | 3009670 | 0 | 108567552 | 281022 | feat(sync): harden offline multi-vault pairing (#692) |
| codex-019fc267-a07-1785690170-1 | codex | 019fc267-a077-73a0-b86e-742418586349 | #692 | gpt-5.6-luna | 9180 | 0 | 1589248 | 1947 | 11127 | 0.4495 | 3018850 | 0 | 110156800 | 282969 | feat(sync): harden offline multi-vault pairing (#692) |
| codex-019fc267-a07-1785692337-1 | codex | 019fc267-a077-73a0-b86e-742418586349 | #692 | gpt-5.6-luna | 276159 | 0 | 22460160 | 35056 | 311215 | 6.8313 | 3295009 | 0 | 132616960 | 318025 | chore(sync): integrate current mainline into offline hardening (#692) |
| codex-019fc267-a07-1785692495-1 | codex | 019fc267-a077-73a0-b86e-742418586349 | #692 | gpt-5.6-luna | 16180 | 0 | 2344192 | 1774 | 17954 | 0.6531 | 3311189 | 0 | 134961152 | 319799 | fix(sync): strengthen replica mutation coverage (#692) |
| codex-019fc267-a07-1785695775-1 | codex | 019fc267-a077-73a0-b86e-742418586349 | #692 | gpt-5.6-luna | 447625 | 0 | 32802048 | 34817 | 482442 | 9.8418 | 3758814 | 0 | 167763200 | 354616 | fix(sync): remove replica quality-gate duplication (#692) |
