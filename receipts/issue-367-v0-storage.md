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

- [ ] **Shared "storage connection" entity**: endpoint + region + credentials (sealed via the connection-sidecar pattern from #304 — never plaintext settings), referenced by BOTH backup config and CAS config. One credential form in the UI, two uses. *(blind spot #4: prevents the two-S3-configs confusion trap)*
- [ ] Add the missing `region` field to `blob_store` settings (`S3BlobStore` supports it; the settings shape doesn't carry it). *(blind spot: region)*
- [ ] Wire the `s3Credentials` resolver to sealed credential storage; for Clawgnition connections, the resolver requests a short-lived `cas` grant over the protocol.
- [ ] Encryption default-ON; force-ON for provider (non-BYO) connections. Provider-blindness is the product guarantee, not an option.
- [ ] Schedule the replication sweep properly in the gateway (backoff, per-vault status), surfaced via the blob-sweep health probe (#351 wave 4).
- [ ] **Gate the reconciliation sweep on the gateway instance lease**: never run orphan deletion while the lease is conflicted. One-line guard; full generation fencing for CAS deletes deferred to v2 (safe because local remains complete — worst case is re-replication, not loss). *(blind spot #6)*
- [ ] **Initial-sync UX**: a large existing vault (e.g. 200GB media) takes days on home upstream. Progress surface (per-vault replicated/backlog bytes), resumability (sweep is naturally resumable — verify), upload throttle setting. *(blind spot #2)*
- [ ] **Streaming/multipart upload for large blobs** — `S3BlobStore` currently buffers whole bodies in memory while blob custody supports 512MB streaming blobs; replicating one spikes gateway RAM by that much. Multipart upload, or at minimum a size cap + health warning as the v0 stopgap. *(blind spot #3)*
- [ ] **Endpoint change/rotation semantics, defined and documented**: changing a connection's endpoint/bucket resets custody replication state, re-replication starts fresh, the old bucket is left untouched for manual cleanup. *(blind spot #5)*
- [ ] **Recovery-kit nudge at enable time**: remote copies are DEK-sealed ciphertext — if the gateway machine dies with no recovery kit, "replicated" is unrecoverable. Surface the recovery-kit confirmation (from #351 wave 4) in the S3-enable flow, not only on the Backup card. *(blind spot #1)*
- [ ] Committed e2e rig against a real S3 API (moto server, per the POC harness): S3BlobStore round-trip, sweep, sealed-object verification (fetch raw object, assert ciphertext), reconciliation.

### D. Usage metrics + UI

- [ ] Gateway: poll the provider `usage` endpoint on a slow cadence with caching; expose via a `_gateway/storage` route alongside the backup routes. BYO-S3 fallback: local custody-derived estimates only.
- [ ] `storage-quota` health component: degraded ~80% of quota, error ~95% — mirrors the disk-watermark pattern.
- [ ] **Storage card** on the Gateway page (sibling of the Backup card): quota bar, per-store breakdown (backup vs CAS), replication backlog from custody counts, last reconcile, warning states. Show provider-reported usage AND locally-computed replicated bytes — drift between them is an integrity signal.
- [ ] Settings: storage-connection screen (endpoint/region/credentials/test-connection) shared by backup + CAS enablement flows.

### E. vault.db runway (the v2 insurance — keeps the deferral safe)

- [ ] `dbstat` per-table size breakdown in the diagnostics bundle — ship first; it decides whether the items below are needed per vault.
- [ ] Journal segment archival: journal rows past an active window (e.g. 90 days) sealed into content-addressed segments → blob CAS (which now replicates them remotely for free); local manifest row (id range, time range, hash) preserves audit-chain verifiability; archived rows deleted + pages reclaimed.
- [ ] FTS bounding policy: per-document index budget (full text for recent/pinned, truncated for old) + FTS5 `detail` tuning. Derived + rebuildable, so ship simple, tighten under pressure.
- [ ] Inline-body threshold: enforce ~64KB max on `data:` URI bodies and oversized JSON columns at write time (redirect to CAS refs); diagnostics scan surfaces pre-existing violations.

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

## Verification

```sh
npx turbo run typecheck test --filter=@centraid/backup --filter=@centraid/gateway
```

- Green on this branch (stacked on the wave-4 #351 commits): backup 116
  passed / 19 interop-gated skips, all 14 conformance cases pass against
  both providers; gateway typecheck + 432 tests green with the
  `backup-e2e.test.ts` alignment.

### Files

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
- `packages/backup/src/wire-client.ts`
- `packages/gateway/src/backup/backup-e2e.test.ts`

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
