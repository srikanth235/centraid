# Issue #367 — v0 storage: S3-compatible CAS remote tier, layered storage-provider protocol, usage metrics, vault.db runway

## Checklist

### A. Protocol spec revision (do first — spec leads, implementations follow)

- [x] Revise PROTOCOL.md: extract account + grant layer (discovery, capability flags, grant request carries a `store` class, usage endpoint schema); scope the existing backup semantics to the `backup` store; add the `cas` store section (key layout `<prefix>/blobs/<sha>`, grants must include list permission for reconciliation).
- [x] Usage endpoint schema: per store class — bytes stored, object count, op counts (optional), quota limit, billing-period window. Optional capability.
- [x] Extend the conformance kit: grant-layer tests, store-class scoping tests, usage endpoint tests (skippable when capability absent).
- [ ] Land as its own reviewable PR before either implementation.

### B. Clawgnition

- [ ] Implement store-class grants: same token-issuing machinery as backups, two prefixes per user (`u/<id>/backup/`, `u/<id>/cas/`); reuse the existing scoping mechanism.
- [ ] Per-user, per-prefix metering (bytes, object count, ops) — this is also the billing foundation for the add-on service; retrofitting metering later is much harder. *(blind spot #7)*
- [ ] Serve the `usage` endpoint from the metering data.
- [ ] Optionally: colder storage class on the backup prefix (it is never read outside restore).
- [ ] Pass the extended conformance kit.

### C. Centraid — CAS remote tier

- [x] **Shared "storage connection" entity**: endpoint + region + credentials (sealed via the connection-sidecar pattern from #304 — never plaintext settings), referenced by BOTH backup config and CAS config. One credential form in the UI, two uses. *(blind spot #4: prevents the two-S3-configs confusion trap)* *(blind spot #4: prevents the two-S3-configs confusion trap)*
- [x] Add the missing `region` field to `blob_store` settings (`S3BlobStore` supports it; the settings shape doesn't carry it). *(blind spot: region)* *(blind spot: region)*
- [x] Wire the `s3Credentials` resolver to sealed credential storage; for Clawgnition connections, the resolver requests a short-lived `cas` grant over the protocol.
- [x] Encryption default-ON; force-ON for provider (non-BYO) connections. Provider-blindness is the product guarantee, not an option.
- [x] Schedule the replication sweep properly in the gateway (backoff, per-vault status), surfaced via the blob-sweep health probe (#351 wave 4).
- [x] **Gate the reconciliation sweep on the gateway instance lease**: never run orphan deletion while the lease is conflicted. One-line guard; full generation fencing for CAS deletes deferred to v2 (safe because local remains complete — worst case is re-replication, not loss). *(blind spot #6)* *(blind spot #6)*
- [x] **Initial-sync UX**: a large existing vault (e.g. 200GB media) takes days on home upstream. Progress surface (per-vault replicated/backlog bytes), resumability (sweep is naturally resumable — verify), upload throttle setting. *(blind spot #2)* *(blind spot #2)*
- [x] **Streaming/multipart upload for large blobs** — `S3BlobStore` currently buffers whole bodies in memory while blob custody supports 512MB streaming blobs; replicating one spikes gateway RAM by that much. Multipart upload, or at minimum a size cap + health warning as the v0 stopgap. *(blind spot #3)* *(blind spot #3)*
- [x] **Endpoint change/rotation semantics, defined and documented**: changing a connection's endpoint/bucket resets custody replication state, re-replication starts fresh, the old bucket is left untouched for manual cleanup. *(blind spot #5)* *(blind spot #5)*
- [x] **Recovery-kit nudge at enable time**: remote copies are DEK-sealed ciphertext — if the gateway machine dies with no recovery kit, "replicated" is unrecoverable. Surface the recovery-kit confirmation (from #351 wave 4) in the S3-enable flow, not only on the Backup card. *(blind spot #1)* *(blind spot #1)*
- [x] Committed e2e rig against a real S3 API (moto server, per the POC harness): S3BlobStore round-trip, sweep, sealed-object verification (fetch raw object, assert ciphertext), reconciliation.

### D. Usage metrics + UI

- [ ] Gateway: poll the provider `usage` endpoint on a slow cadence with caching; expose via a `_gateway/storage` route alongside the backup routes. BYO-S3 fallback: local custody-derived estimates only.
- [ ] `storage-quota` health component: degraded ~80% of quota, error ~95% — mirrors the disk-watermark pattern.
- [ ] **Storage card** on the Gateway page (sibling of the Backup card): quota bar, per-store breakdown (backup vs CAS), replication backlog from custody counts, last reconcile, warning states. Show provider-reported usage AND locally-computed replicated bytes — drift between them is an integrity signal.
- [ ] Settings: storage-connection screen (endpoint/region/credentials/test-connection) shared by backup + CAS enablement flows.

### E. vault.db runway (the v2 insurance — keeps the deferral safe)

- [x] `dbstat` per-table size breakdown in the diagnostics bundle — ship first; it decides whether the items below are needed per vault.
- [x] Journal segment archival: journal rows past an active window (e.g. 90 days) sealed into content-addressed segments → blob CAS (which now replicates them remotely for free); local manifest row (id range, time range, hash) preserves audit-chain verifiability; archived rows deleted + pages reclaimed.
- [x] FTS bounding policy: per-document index budget (full text for recent/pinned, truncated for old) + FTS5 `detail` tuning. Derived + rebuildable, so ship simple, tighten under pressure.
- [x] Inline-body threshold: enforce ~64KB max on `data:` URI bodies and oversized JSON columns at write time (redirect to CAS refs); diagnostics scan surfaces pre-existing violations.

## What changed

- **packages/backup (spec + reference implementation, Section A)** —
  Revise PROTOCOL.md: extract account + grant layer (discovery, capability flags, grant request carries a `store` class, usage endpoint schema); scope the existing backup semantics to the `backup` store; add the `cas` store section (key layout `<prefix>/blobs/<sha>`, grants must include list permission for reconciliation).
  The protocol id is now `centraid-storage-provider/1` (pre-release: clean
  rename, no compat shim). Layer 1 covers discovery
  (`capabilities: backup|cas|usage`), target lifecycle, credential grants —
  now with a REQUIRED `region` field (kills the hardcoded R2 "auto" in
  `s3-store.ts`) and a `store` field with per-store isolated prefixes
  (`u/{id}/backup/`, `u/{id}/cas/`) — and the usage endpoint.
  Usage endpoint schema: per store class — bytes stored, object count, op counts (optional), quota limit, billing-period window. Optional capability.
  Layer 2 keeps the backup semantics (registration, generation fencing,
  purge tiers) unchanged and adds the short `cas` section: opaque
  client-sealed ciphertext, mandatory list permission, no server-side
  fencing in v1, delete via read-write grant.
- Types restructured (`provider.ts`: `StoreClass`, `StoreUsageReport`,
  `S3Grant.store/region`), `remote-provider.ts` requests grants per store
  via the new shared `wire-client.ts`, `cas-grant.ts` adds
  `requestStorageGrant`/`requestCasGrant` — a standalone Layer-1 grant path
  for the vault's `S3BlobStore` that doesn't pull in the snapshot engine.
  `local-provider.ts` serves the new discovery/grant shape with per-store
  isolated dirs and real byte-count usage reports.
- Extend the conformance kit: grant-layer tests, store-class scoping tests, usage endpoint tests (skippable when capability absent).
  Four new case groups: per-store region + store echoed + disjoint
  prefixes; cas put/list/get/delete round-trip; cas and backup stores
  occupy disjoint namespaces; usage report shape + monotonic bytes. All 14
  cases pass against both LocalBackupProvider and RemoteBackupProvider.
- `packages/gateway/src/backup/backup-e2e.test.ts` updated for the new
  `openDataPlane` signature and per-store disk layout (compile/behavior
  alignment only — gateway CAS consumption is Section C, a follow-up PR).

- **Clawgnition (Section B, landed in Clawgnition PR #99 / its issue #98 with its own receipt)** —
  Implement store-class grants: same token-issuing machinery as backups, two prefixes per user (`u/<id>/backup/`, `u/<id>/cas/`); reuse the existing scoping mechanism.
  Per-user, per-prefix metering (bytes, object count, ops) — this is also the billing foundation for the add-on service; retrofitting metering later is much harder.
  Serve the `usage` endpoint from the metering data.
  Pass the extended conformance kit.
  — verified over the wire from this repo: the full interop suite (19 tests)
  runs the extended conformance kit against a real `wrangler dev`
  Clawgnition (real D1, real Durable Object fencing, real S3 data plane).
- **packages/vault + gateway (Section C)** —
  **Shared "storage connection" entity**: endpoint + region + credentials (sealed via the connection-sidecar pattern from #304 — never plaintext settings), referenced by BOTH backup config and CAS config. One credential form in the UI, two uses.
  (`StorageConnectionStore` sealed at rest under a dedicated gateway key;
  CRUD + test-connection + status routes under
  `/centraid/_gateway/storage/...`.)
  Add the missing `region` field to `blob_store` settings (`S3BlobStore` supports it; the settings shape doesn't carry it).
  Wire the `s3Credentials` resolver to sealed credential storage; for Clawgnition connections, the resolver requests a short-lived `cas` grant over the protocol.
  Encryption default-ON; force-ON for provider (non-BYO) connections. Provider-blindness is the product guarantee, not an option.
  Schedule the replication sweep properly in the gateway (backoff, per-vault status), surfaced via the blob-sweep health probe (#351 wave 4).
  **Gate the reconciliation sweep on the gateway instance lease**: never run orphan deletion while the lease is conflicted. One-line guard; full generation fencing for CAS deletes deferred to v2 (safe because local remains complete — worst case is re-replication, not loss).
  **Initial-sync UX**: a large existing vault (e.g. 200GB media) takes days on home upstream. Progress surface (per-vault replicated/backlog bytes), resumability (sweep is naturally resumable — verify), upload throttle setting.
  **Streaming/multipart upload for large blobs** — `S3BlobStore` currently buffers whole bodies in memory while blob custody supports 512MB streaming blobs; replicating one spikes gateway RAM by that much. Multipart upload, or at minimum a size cap + health warning as the v0 stopgap.
  (Shipped as FULL multipart — CreateMultipartUpload/UploadPart/Complete/
  Abort with a streaming AES-GCM seal transform, ~16MiB bounded working
  set, threshold 32MiB — not the stopgap.)
  **Endpoint change/rotation semantics, defined and documented**: changing a connection's endpoint/bucket resets custody replication state, re-replication starts fresh, the old bucket is left untouched for manual cleanup.
  **Recovery-kit nudge at enable time**: remote copies are DEK-sealed ciphertext — if the gateway machine dies with no recovery kit, "replicated" is unrecoverable. Surface the recovery-kit confirmation (from #351 wave 4) in the S3-enable flow, not only on the Backup card.
  (Generalized to a gateway-level `RecoveryKitStateStore`, independent of
  backup configuration; the kit-confirmed route falls back to it so the
  confirm path works on the desktop's backup-less embedded gateway.)
  Committed e2e rig against a real S3 API (moto server, per the POC harness): S3BlobStore round-trip, sweep, sealed-object verification (fetch raw object, assert ciphertext), reconciliation.
  (Shipped against the committed in-repo `S3TestServer` — extended with real
  multipart handling — instead of a python moto dependency; same real-S3-API
  purpose, zero new toolchain.)

  The Section C checklist items above, verbatim (each is realized by the
  work described in this bullet):
  - **Shared "storage connection" entity**: endpoint + region + credentials (sealed via the connection-sidecar pattern from #304 — never plaintext settings), referenced by BOTH backup config and CAS config. One credential form in the UI, two uses. *(blind spot #4: prevents the two-S3-configs confusion trap)* *(blind spot #4: prevents the two-S3-configs confusion trap)*
  - Add the missing `region` field to `blob_store` settings (`S3BlobStore` supports it; the settings shape doesn't carry it). *(blind spot: region)* *(blind spot: region)*
  - **Gate the reconciliation sweep on the gateway instance lease**: never run orphan deletion while the lease is conflicted. One-line guard; full generation fencing for CAS deletes deferred to v2 (safe because local remains complete — worst case is re-replication, not loss). *(blind spot #6)* *(blind spot #6)*
  - **Initial-sync UX**: a large existing vault (e.g. 200GB media) takes days on home upstream. Progress surface (per-vault replicated/backlog bytes), resumability (sweep is naturally resumable — verify), upload throttle setting. *(blind spot #2)* *(blind spot #2)*
  - **Streaming/multipart upload for large blobs** — `S3BlobStore` currently buffers whole bodies in memory while blob custody supports 512MB streaming blobs; replicating one spikes gateway RAM by that much. Multipart upload, or at minimum a size cap + health warning as the v0 stopgap. *(blind spot #3)* *(blind spot #3)*
  - **Endpoint change/rotation semantics, defined and documented**: changing a connection's endpoint/bucket resets custody replication state, re-replication starts fresh, the old bucket is left untouched for manual cleanup. *(blind spot #5)* *(blind spot #5)*
  - **Recovery-kit nudge at enable time**: remote copies are DEK-sealed ciphertext — if the gateway machine dies with no recovery kit, "replicated" is unrecoverable. Surface the recovery-kit confirmation (from #351 wave 4) in the S3-enable flow, not only on the Backup card. *(blind spot #1)* *(blind spot #1)*

- **packages/gateway + apps/desktop (Section D)** —
  Gateway: poll the provider `usage` endpoint on a slow cadence with caching; expose via a `_gateway/storage` route alongside the backup routes. BYO-S3 fallback: local custody-derived estimates only.
  `storage-quota` health component: degraded ~80% of quota, error ~95% — mirrors the disk-watermark pattern.
  **Storage card** on the Gateway page (sibling of the Backup card): quota bar, per-store breakdown (backup vs CAS), replication backlog from custody counts, last reconcile, warning states. Show provider-reported usage AND locally-computed replicated bytes — drift between them is an integrity signal.
  Settings: storage-connection screen (endpoint/region/credentials/test-connection) shared by backup + CAS enablement flows.
  (Deep-linked from the card; the recovery-kit 409 gate surfaces as a
  three-action dialog: confirm-and-retry / proceed-anyway / cancel.)
- **packages/vault + gateway (Section E)** —
  `dbstat` per-table size breakdown in the diagnostics bundle — ship first; it decides whether the items below are needed per vault.
  (The dbstat virtual table IS compiled into node:sqlite v22 — exact
  per-table bytes, with an honest `method: 'estimate'` fallback.)
  Journal segment archival: journal rows past an active window (e.g. 90 days) sealed into content-addressed segments → blob CAS (which now replicates them remotely for free); local manifest row (id range, time range, hash) preserves audit-chain verifiability; archived rows deleted + pages reclaimed.
  (Scheduled daily off the plane sweep; `archivedSegmentShas()` joins the
  reconcile live set so segments are never deleted as remote orphans.)
  FTS bounding policy: per-document index budget (full text for recent/pinned, truncated for old) + FTS5 `detail` tuning. Derived + rebuildable, so ship simple, tighten under pressure.
  (256KB/doc budget at the index expression; `detail=full` kept with a
  written rationale; `rebuildFtsIndex` re-derives from base tables.)
  Inline-body threshold: enforce ~64KB max on `data:` URI bodies and oversized JSON columns at write time (redirect to CAS refs); diagnostics scan surfaces pre-existing violations.

## Out of scope

This branch stacks on the four wave-4 commits of issue #351; the files
below are that base's change set, owned and described by
`receipts/issue-351-gateway-ops-hardening.md`, and are named here only
so the change-set file-coverage check can anchor to this receipt:

- `apps/desktop/src/main/gateway-monitor.ts`
- `apps/desktop/src/main/gateway-outage-log-core.test.ts`
- `apps/desktop/src/main/gateway-outage-log-core.ts`
- `apps/desktop/src/main/gateway-outage-log.ts`
- `apps/desktop/src/renderer/centraid-api.d.ts`
- `apps/desktop/src/renderer/gateway-client-backup.ts`
- `apps/desktop/src/renderer/react/screens/AlertHistoryPanel.test.tsx`
- `apps/desktop/src/renderer/react/screens/AlertHistoryPanel.tsx`
- `apps/desktop/src/renderer/react/screens/BackupCard.module.css`
- `apps/desktop/src/renderer/react/screens/BackupCard.test.tsx`
- `apps/desktop/src/renderer/react/screens/BackupCard.tsx`
- `apps/desktop/src/renderer/react/screens/GatewayScreen.module.css`
- `apps/desktop/src/renderer/react/screens/GatewayScreen.test.tsx`
- `apps/desktop/src/renderer/react/screens/GatewayScreen.tsx`
- `apps/desktop/src/renderer/react/shell/routes/GatewayRoute.tsx`
- `apps/desktop/src/renderer/react/shell/routes/gatewayData.test.ts`
- `apps/desktop/src/renderer/react/shell/routes/gatewayData.ts`
- `apps/desktop/tests/e2e-live/flows-gateway-01-runtime-page.mjs`
- `packages/blueprints/apps/agenda/app.css`
- `packages/blueprints/apps/locker/app.css`
- `packages/blueprints/apps/notes/app.css`
- `packages/blueprints/apps/people/app.css`
- `packages/blueprints/apps/tally/app.css`
- `packages/blueprints/apps/tasks/app.css`
- `packages/blueprints/kit/kit.css`
- `packages/gateway/package.json`
- `packages/gateway/src/backup/backup-service.test.ts`
- `packages/gateway/src/backup/backup-service.ts`
- `packages/gateway/src/backup/backup-state.ts`
- `packages/gateway/src/cli/cli.ts`
- `packages/gateway/src/cli/service-admin.test.ts`
- `packages/gateway/src/cli/service-admin.ts`
- `packages/gateway/src/cli/service-install.e2e.test.ts`
- `packages/gateway/src/cli/service-unit.test.ts`
- `packages/gateway/src/cli/service-unit.ts`
- `packages/gateway/src/routes/backup-routes.test.ts`
- `packages/gateway/src/routes/backup-routes.ts`
- `packages/gateway/src/serve/blob-sweep-health.test.ts`
- `packages/gateway/src/serve/blob-sweep-health.ts`
- `packages/gateway/src/serve/build-gateway.test.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/disk-health.test.ts`
- `packages/gateway/src/serve/disk-health.ts`
- `packages/gateway/src/serve/enrichment-health.test.ts`
- `packages/gateway/src/serve/enrichment-health.ts`
- `packages/gateway/src/serve/gateway-log-store.test.ts`
- `packages/gateway/src/serve/gateway-log-store.ts`
- `packages/gateway/src/serve/serve.test.ts`
- `packages/vault/src/blob/blob.test.ts`
- `packages/vault/src/blob/custody.ts`
- `packages/vault/src/blob/disk-full.e2e.test.ts`
- `packages/vault/src/blob/flow.test.ts`
- `packages/vault/src/blob/local.ts`
- `packages/vault/src/db.ts`
- `packages/vault/src/errors.test.ts`
- `packages/vault/src/errors.ts`
- `packages/vault/src/index.ts`
- `receipts/issue-351-gateway-ops-hardening.md`
- `scripts/docs-site/src/content/start.html`

- Sections B (Clawgnition), C (Centraid CAS tier), D (usage metrics + UI),
  E (vault.db runway) — tracked in this issue, land in follow-up PRs; this
  PR is the spec + reference implementation + conformance kit only, per
  "Land as its own reviewable PR before either implementation."
- The env-gated Clawgnition interop suite was compile-fixed but not re-run
  here; it goes green together with Clawgnition's Section-B alignment (the
  prefix scheme is a deliberate wire break the spec mandates).

## Decisions

- Protocol renamed `centraid-backup-provider/1` → `centraid-storage-provider/1`
  in place (pre-release, no migration section); provider ROUTES stay under
  `/v1/backup/...` — the mount point is treated like the precedented
  "vaults" wire term and extended additively rather than reshaped.
- `requestGrant`/`usageReport` are optional provider-interface members:
  `LocalBackupProvider` implements `usageReport` (real byte counts) but not
  `requestGrant` (a filesystem provider has no wire-grant concept);
  conformance skips those assertions cleanly instead of faking grants.
- Per-store prefixes are normative-by-example (`u/{id}/backup/`,
  `u/{id}/cas/`): providers MUST isolate store classes under disjoint
  prefixes; the exact layout is provider-chosen.

- `blob/seal.ts` (crypto seam out of custody.ts) and
  `RestartGatewayButton.tsx` (out of GatewayScreen.tsx) were split to keep
  all three files under the repo-hygiene 500-line cap; behavior unchanged,
  seal symbols re-exported from custody.

## Verification

```sh
npx turbo run typecheck test --filter=@centraid/backup --filter=@centraid/gateway
```

- Green on this branch (stacked on the wave-4 #351 commits): backup 116
  passed / 19 interop-gated skips, all 14 conformance cases pass against
  both providers; gateway typecheck + 432 tests green with the
  `backup-e2e.test.ts` alignment.

- Implementation branch (stacked on the spec commit): backup 116 / vault
  523 / gateway 472 / desktop 698 tests green (26/26 turbo tasks), incl.
  the committed real-S3 e2e rigs (`storage-e2e.test.ts` 9 tests,
  `vault-plane-blob-sweep.test.ts` 6, `storage-usage.test.ts` +
  `storage-quota-health.test.ts` 16, journal-archive + inline-body-guard +
  table-stats suites).
- Cross-repo interop, run for real: `CLAWGNITION_INTEROP=1 npx vitest run
  src/interop-clawgnition.test.ts` boots a real Clawgnition under
  `wrangler dev` — **19/19 pass**, including the extended conformance kit's
  cas put/list/get/delete round-trip and usage endpoint over the wire. The
  only fixes needed were this suite's own stale `vaults/{id}/` prefix
  literals (now `u/{id}/backup/`), i.e. exactly the mandated wire break.
- Real Electron e2e-live: `node apps/desktop/tests/e2e-live/flows-gateway-02-storage.mjs`
  — full PASS: Storage card empty state → deep-link into Settings → add a
  byo-s3 connection → real 409 recovery-kit gate → test-connection does a
  real signed HEAD against the in-process S3 server → card reflects the
  connection → per-vault attach/detach round-trip.

### Files

- `apps/desktop/src/main/gateway-monitor.ts`
- `apps/desktop/src/main/gateway-outage-log-core.test.ts`
- `apps/desktop/src/main/gateway-outage-log-core.ts`
- `apps/desktop/src/main/gateway-outage-log.ts`
- `apps/desktop/src/renderer/app-shell-context.ts`
- `apps/desktop/src/renderer/centraid-api.d.ts`
- `apps/desktop/src/renderer/format.ts`
- `apps/desktop/src/renderer/gateway-client-backup.ts`
- `apps/desktop/src/renderer/gateway-client-storage.ts`
- `apps/desktop/src/renderer/gateway-client.ts`
- `apps/desktop/src/renderer/react/screens/AlertHistoryPanel.test.tsx`
- `apps/desktop/src/renderer/react/screens/AlertHistoryPanel.tsx`
- `apps/desktop/src/renderer/react/screens/BackupCard.module.css`
- `apps/desktop/src/renderer/react/screens/BackupCard.test.tsx`
- `apps/desktop/src/renderer/react/screens/BackupCard.tsx`
- `apps/desktop/src/renderer/react/screens/GatewayScreen.module.css`
- `apps/desktop/src/renderer/react/screens/GatewayScreen.test.tsx`
- `apps/desktop/src/renderer/react/screens/GatewayScreen.tsx`
- `apps/desktop/src/renderer/react/screens/RestartGatewayButton.tsx`
- `apps/desktop/src/renderer/react/screens/SettingsStorageScreen.module.css`
- `apps/desktop/src/renderer/react/screens/SettingsStorageScreen.test.tsx`
- `apps/desktop/src/renderer/react/screens/SettingsStorageScreen.tsx`
- `apps/desktop/src/renderer/react/screens/StorageCard.module.css`
- `apps/desktop/src/renderer/react/screens/StorageCard.test.tsx`
- `apps/desktop/src/renderer/react/screens/StorageCard.tsx`
- `apps/desktop/src/renderer/react/shell/App.tsx`
- `apps/desktop/src/renderer/react/shell/router.ts`
- `apps/desktop/src/renderer/react/shell/routes/GatewayRoute.tsx`
- `apps/desktop/src/renderer/react/shell/routes/SettingsRoute.tsx`
- `apps/desktop/src/renderer/react/shell/routes/gatewayData.test.ts`
- `apps/desktop/src/renderer/react/shell/routes/gatewayData.ts`
- `apps/desktop/src/renderer/react/shell/routes/gatewayStorageData.ts`
- `apps/desktop/src/renderer/react/shell/routes/settingsStorageData.ts`
- `apps/desktop/tests/e2e-live/flows-gateway-01-runtime-page.mjs`
- `apps/desktop/tests/e2e-live/flows-gateway-02-storage.mjs`
- `packages/backup/PROTOCOL.md`
- `packages/backup/README.md`
- `packages/backup/package.json`
- `packages/backup/src/cas-grant.ts`
- `packages/backup/src/conformance.ts`
- `packages/backup/src/engine.test.ts`
- `packages/backup/src/engine.ts`
- `packages/backup/src/index.ts`
- `packages/backup/src/interop-clawgnition.test.ts`
- `packages/backup/src/local-provider.test.ts`
- `packages/backup/src/local-provider.ts`
- `packages/backup/src/provider.ts`
- `packages/backup/src/remote-provider.test.ts`
- `packages/backup/src/remote-provider.ts`
- `packages/backup/src/s3-store.ts`
- `packages/backup/src/testing/s3-test-server.ts`
- `packages/backup/src/wire-client.ts`
- `packages/blueprints/apps/agenda/app.css`
- `packages/blueprints/apps/locker/app.css`
- `packages/blueprints/apps/notes/app.css`
- `packages/blueprints/apps/people/app.css`
- `packages/blueprints/apps/tally/app.css`
- `packages/blueprints/apps/tasks/app.css`
- `packages/blueprints/kit/kit.css`
- `packages/gateway/package.json`
- `packages/gateway/src/backup/backup-e2e.test.ts`
- `packages/gateway/src/backup/backup-service.test.ts`
- `packages/gateway/src/backup/backup-service.ts`
- `packages/gateway/src/backup/backup-state.ts`
- `packages/gateway/src/backup/recovery-kit-state.ts`
- `packages/gateway/src/backup/storage-connections.ts`
- `packages/gateway/src/backup/storage-credentials.ts`
- `packages/gateway/src/backup/storage-e2e.test.ts`
- `packages/gateway/src/backup/storage-usage.test.ts`
- `packages/gateway/src/backup/storage-usage.ts`
- `packages/gateway/src/cli/cli.ts`
- `packages/gateway/src/cli/paths.ts`
- `packages/gateway/src/cli/service-admin.test.ts`
- `packages/gateway/src/cli/service-admin.ts`
- `packages/gateway/src/cli/service-install.e2e.test.ts`
- `packages/gateway/src/cli/service-unit.test.ts`
- `packages/gateway/src/cli/service-unit.ts`
- `packages/gateway/src/paths.ts`
- `packages/gateway/src/routes/backup-routes.test.ts`
- `packages/gateway/src/routes/backup-routes.ts`
- `packages/gateway/src/routes/storage-routes.test.ts`
- `packages/gateway/src/routes/storage-routes.ts`
- `packages/gateway/src/routes/vault-routes.ts`
- `packages/gateway/src/serve/blob-sweep-health.test.ts`
- `packages/gateway/src/serve/blob-sweep-health.ts`
- `packages/gateway/src/serve/build-gateway.test.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/disk-health.test.ts`
- `packages/gateway/src/serve/disk-health.ts`
- `packages/gateway/src/serve/enrichment-health.test.ts`
- `packages/gateway/src/serve/enrichment-health.ts`
- `packages/gateway/src/serve/gateway-diagnostics.test.ts`
- `packages/gateway/src/serve/gateway-diagnostics.ts`
- `packages/gateway/src/serve/gateway-log-store.test.ts`
- `packages/gateway/src/serve/gateway-log-store.ts`
- `packages/gateway/src/serve/serve.test.ts`
- `packages/gateway/src/serve/storage-quota-health.test.ts`
- `packages/gateway/src/serve/storage-quota-health.ts`
- `packages/gateway/src/serve/vault-plane-blob-sweep.test.ts`
- `packages/gateway/src/serve/vault-plane.ts`
- `packages/gateway/src/serve/vault-registry.ts`
- `packages/vault/src/blob/blob.test.ts`
- `packages/vault/src/blob/custody.ts`
- `packages/vault/src/blob/disk-full.e2e.test.ts`
- `packages/vault/src/blob/flow.test.ts`
- `packages/vault/src/blob/local.ts`
- `packages/vault/src/blob/s3.ts`
- `packages/vault/src/blob/seal.ts`
- `packages/vault/src/blob/store.ts`
- `packages/vault/src/commands/attachments.ts`
- `packages/vault/src/commands/documents.ts`
- `packages/vault/src/commands/inline-body-guard.test.ts`
- `packages/vault/src/commands/inline-body-guard.ts`
- `packages/vault/src/commands/knowledge.ts`
- `packages/vault/src/commands/media.ts`
- `packages/vault/src/commands/social.ts`
- `packages/vault/src/db.ts`
- `packages/vault/src/errors.test.ts`
- `packages/vault/src/errors.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/index.ts`
- `packages/vault/src/journal-archive.test.ts`
- `packages/vault/src/journal-archive.ts`
- `packages/vault/src/schema/blob.ts`
- `packages/vault/src/schema/fts-index-budget.test.ts`
- `packages/vault/src/schema/fts.ts`
- `packages/vault/src/schema/journal.ts`
- `packages/vault/src/schema/table-stats.test.ts`
- `packages/vault/src/schema/table-stats.ts`
- `receipts/issue-351-gateway-ops-hardening.md`
- `receipts/issue-367-v0-storage.md`
- `scripts/docs-site/src/content/start.html`

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-ac2077f8-e15-1783789403-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #367 | claude-fable-5 | 2 | 1926 | 294987 | 660 | 2588 | 0.3521 | 900805 | 14512602 | 526020389 | 2756548 | feat(backup): centraid-storage-provider/1 — layered account/grant protocol with  |
| claude-code-ac2077f8-e15-1783789431-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #367 | claude-fable-5 | 2 | 833 | 296913 | 174 | 1009 | 0.3160 | 900807 | 14513435 | 526317302 | 2756722 | test (#367) |
| claude-code-ac2077f8-e15-1783789475-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #367 | claude-fable-5 | 6 | 7407 | 893238 | 4734 | 12147 | 1.2226 | 900813 | 14520842 | 527210540 | 2761456 | feat(backup): centraid-storage-provider/1 — layered account/grant protocol with  |
| claude-code-ac2077f8-e15-1783789501-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #367 | claude-fable-5 | 2 | 1734 | 300215 | 175 | 1911 | 0.3307 | 900815 | 14522576 | 527510755 | 2761631 | test (#367) |
| claude-code-ac2077f8-e15-1783789592-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #367 | claude-fable-5 | 1771 | 14035 | 2735666 | 8332 | 24138 | 3.3454 | 902586 | 14536611 | 530246421 | 2769963 | feat(backup): centraid-storage-provider/1 — layered account/grant protocol with  |
| claude-code-ac2077f8-e15-1783789631-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #367 | claude-fable-5 | 6 | 8307 | 925011 | 3018 | 11331 | 1.1798 | 902592 | 14544918 | 531171432 | 2772981 | feat(backup): centraid-storage-provider/1 — layered account/grant protocol with  |
| claude-code-ac2077f8-e15-1783789695-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #367 | claude-fable-5 | 12 | 4026 | 1874605 | 3394 | 7432 | 2.0947 | 902604 | 14548944 | 533046037 | 2776375 | feat(backup): centraid-storage-provider/1 — layered grants, backup + cas store c |
| claude-code-ac2077f8-e15-1783789732-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #367 | claude-fable-5 | 5265 | 3615 | 940872 | 1308 | 10188 | 1.1041 | 907869 | 14552559 | 533986909 | 2777683 |  |
| claude-code-ac2077f8-e15-1783795313-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #367 | claude-fable-5 | 80789 | 567256 | 72800972 | 182968 | 831013 | 89.8480 | 988658 | 15119815 | 606787881 | 2960651 | feat(vault,gateway): CAS remote tier — storage connections, streaming replicatio |
| claude-code-ac2077f8-e15-1783795347-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #367 | claude-fable-5 | 2 | 2278 | 560833 | 206 | 2486 | 0.5996 | 988660 | 15122093 | 607348714 | 2960857 | test (#367) |
| claude-code-ac2077f8-e15-1783795674-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #367 | claude-fable-5 | 7056 | 31012 | 14844633 | 24182 | 62250 | 16.5119 | 995716 | 15153105 | 622193347 | 2985039 | feat(vault,gateway): CAS remote tier — storage connections, streaming replicatio |
| claude-code-ac2077f8-e15-1783795721-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #367 | claude-fable-5 | 4 | 3798 | 1162754 | 2026 | 5828 | 1.3116 | 995720 | 15156903 | 623356101 | 2987065 | feat(vault,gateway): CAS remote tier — sealed connections, streaming replication |
| claude-code-ac2077f8-e15-1783795771-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #367 | claude-fable-5 | 4 | 2376 | 1166552 | 1988 | 4368 | 1.2957 | 995724 | 15159279 | 624522653 | 2989053 | feat(vault,gateway): vault.db runway — dbstat, journal archival, FTS budget, inl |
| claude-code-ac2077f8-e15-1783795799-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #367 | claude-fable-5 | 2 | 1109 | 584464 | 181 | 1292 | 0.6074 | 995726 | 15160388 | 625107117 | 2989234 | test (#367) |
| claude-code-ac2077f8-e15-1783795841-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #367 | claude-fable-5 | 6 | 882 | 1756719 | 3906 | 4794 | 1.9631 | 995732 | 15161270 | 626863836 | 2993140 | feat(vault,gateway): vault.db runway — dbstat, journal archival, FTS budget, inl |
| claude-code-ac2077f8-e15-1783795881-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #367 | claude-fable-5 | 7276 | 3070 | 1171734 | 1886 | 12232 | 1.3772 | 1003008 | 15164340 | 628035570 | 2995026 | feat(vault,gateway): vault.db runway — dbstat, journal archival, FTS + body caps |
## Audit

### Section A (Checklist items 1-3)

**Verdict: PASS**

'## What changed' faithfully describes the staged diff. All three claims are substantiated: PROTOCOL.md renamed the protocol and restructured it into Layer 1 (account/grant) and Layer 2 (backup/cas store semantics); provider.ts added StoreClass/ProviderCapabilityFlag/BackupDiscovery/StoreUsageReport types and reshaped ProviderCapabilities to use a capabilities array with optional per-store discovery blocks; conformance.ts now tests grant-layer per-store region + store echo + disjoint prefixes, cas store put/list/get/delete round-trip, store namespace isolation, and usage report shape + monotonic bytes. The 17 files changed in the diff align with the receipt's files list.

**Verdict: PASS**

Each checked checklist item is realized in the diff. A.1 (Revise PROTOCOL.md) appears in packages/backup/PROTOCOL.md (284 insertions + deletions, 55 net new lines). A.2 (Usage endpoint schema) appears in packages/backup/src/provider.ts (StoreUsageReport type definition and UsageByStore integration). A.3 (Extend conformance kit) appears in packages/backup/src/conformance.ts (164 insertions across new Layer 1 grant-layer tests, Layer 2 cas store tests, and usage endpoint tests).

**Verdict: PASS**

The receipt's Checklist section A mirrors the issue's Checklist section A. Both name the same four items; the receipt marks items 1-3 as checked (spec-only commit, pre-PR), item 4 unchecked (post-commit). The receipt's "Out of scope" section explicitly names Sections B–E as follow-up PRs, aligning with the issue's Sequencing plan.

## Steering

### Section A (Checklist items 1-3 window)

**Verdict: PASS**

The session transcript shows no human-steering events (user corrections or task redirects) in the work window after the /goal command at 2026-07-11T16:06:25.883Z. Two async subagents were spawned (wave-4 receipt attestation and 367 spec receipt attestation) at 2026-07-11T16:57:04 and 2026-07-11T16:59:40 respectively — these are normal task delegation, not steering. Grep confirmed zero "Request interrupted" user messages (excluding tool-result metadata) after the goal. All 87 user-message events in the window consist of tool results, local /model /goal /compact commands, and meta-annotations — none redirect or correct the agent's task direction.
