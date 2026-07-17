# Issue #436 — Protocol rethink: hosted-vs-local binary — home profile, provisioning, retire byo-s3, /v1/storage/* rename, five-metric contract + settings collapse

## Checklist

The issue carries no literal checkbox list; this checklist enumerates its numbered amendments plus the beta-critical path, as the work plan.

- [x] §1 home profile: discovery grows `profiles: ["home"]`; advertising `home` requires all seven member capabilities (`policy` decided REQUIRED); conformance kit asserts profile completeness
- [x] §2 retire byo-s3 as a peer connection kind in the client model; `S3BlobStore` survives as internal data-plane code
- [x] §3 Layer 0 provisioning specified in PROTOCOL.md as normative-for-GA, deferred; nobody builds it now
- [x] §4 `casAck` (and store-class knobs) off owner settings; the wire declaration stays and is defaulted
- [x] §5 wire routes renamed `/v1/backup/*` → `/v1/storage/*`, coordinated with the clawgnition side in the same window; the `backup` store class keeps its name
- [x] §6 five-metric derivations implemented once in `packages/client` (normative worst-clock-wins freshness, retention daily rung, structural privacy, aggregate cost, honest exit)
- [x] §6 prerequisite: GC-pins-snapshots invariant — blobs referenced by any retained snapshot are live GC roots, enforced at the real deletion path
- [x] §7 settings surface collapsed to the binary: one choice per vault (On this device / Hosted); store-class vocabulary deleted from the surface; BackupCard renders exactly the five metrics with the four clocks behind a diagnostics disclosure
- [x] Interop: full cross-repo conformance suite green (26/26) against the real clawgnition gateway over the renamed routes
## What changed

### §5 wire routes renamed `/v1/backup/*` → `/v1/storage/*`, coordinated with the clawgnition side in the same window; the `backup` store class keeps its name

Every wire route in `packages/backup/PROTOCOL.md` now reads `/v1/storage/...` (discovery, vaults lifecycle, credentials, usage, policy, inventory, events, snapshots, delete/undelete/purge); the protocol version string stays `centraid-storage-provider/1` and the `backup` store class, `u/{id}/backup/` prefixes, and `backup{}` discovery block are untouched. URL construction renamed in `packages/backup/src/remote-provider.ts` and `packages/backup/src/cas-grant.ts`; served routes renamed in `packages/backup/src/testing/fake-provider-server.ts`; doc-comment references updated in `packages/backup/src/provider.ts`, `packages/gateway/src/backup/storage-credentials.ts`, `packages/gateway/src/backup/storage-usage.ts`, and `packages/gateway/src/backup/storage-usage.test.ts` (which also served a real route). The clawgnition provider side was renamed in the same window in its own repo (landed there under clawgnition#132), so no released implementation ever serves the old paths. No back-compat aliases — pre-release, hard rename.

### §1 home profile: discovery grows `profiles: ["home"]`; advertising `home` requires all seven member capabilities (`policy` decided REQUIRED); conformance kit asserts profile completeness

PROTOCOL.md gains a normative Profiles subsection: `profiles` is optional/additive next to `capabilities`; a provider advertising `home` MUST offer `backup`, `cas`, `derived`, `usage`, `policy`, `inventory`, `audit`. `policy` is required because the client's five-metric freshness watchdog anchors staleness thresholds on the declared cadence. Types in `packages/backup/src/provider.ts` (`ProviderProfile`, `PROVIDER_PROFILES`, `HOME_PROFILE_CAPABILITIES`, `profiles?` on capabilities), re-exported via `packages/backup/src/index.ts`; the capabilities-sanity case in `packages/backup/src/conformance.ts` fails a `home` advertisement with a missing member; the fake provider advertises `profiles: ["home"]`. Capability flags remain the protocol-evolution seam, not a product menu.

### §3 Layer 0 provisioning specified in PROTOCOL.md as normative-for-GA, deferred; nobody builds it now

New "Layer 0 — provisioning" section with a prominent deferred-status callout (beta uses guided key entry): an RFC 8628 device-flow-shaped handshake under `/v1/storage/provision/*` — `POST /v1/storage/provision/sessions` (deviceCode/userCode/verificationUri), polled `POST /v1/storage/provision/token` with `authorization_pending`/`slow_down`/`expired_token`/`access_denied` envelope codes, provider-side interactive consent, key delivered once over the pairing channel, dashboard-owned revocation, conformance-testable against a scripted-approval fake. Spec text only; no code.

### §2 retire byo-s3 as a peer connection kind in the client model; `S3BlobStore` survives as internal data-plane code

`packages/gateway/src/backup/storage-connections.ts` now has a single `provider` kind — `ByoS3Row`, `CreateByoS3Input`, `resolveS3Credentials`, `kindOf`, `StorageConnectionUse`, the `uses` array, and `validateUses` are gone; at most ONE connection (the home connection) may exist (`already_exists`). `packages/gateway/src/backup/storage-credentials.ts` always takes the provider-grant path and gains `assertProviderHomeProfile` (create/Test verify the provider advertises `home`; typed `provider_not_home_profile` error). `packages/gateway/src/routes/storage-routes.ts` drops `uses` from create, always applies the recovery-kit gate, and folds home-profile status into the Test probe. `packages/gateway/src/backup/backup-backend.ts` keys the backup engine off the same single home connection as the CAS attach. `packages/gateway/src/backup/backup-cas-inventory.ts` loses the dead own-S3 listing path; `packages/gateway/src/serve/storage-quota-health.ts` and `packages/gateway/src/serve/build-gateway.ts` updated accordingly; `packages/vault/src/db.ts` narrows `BlobStoreSettings.connectionKind` to `'provider'`. Renderer DTOs collapsed in `packages/client/src/gateway-client-storage.ts` (plus `ProviderNotHomeProfileError`). Tests: `packages/gateway/src/routes/storage-routes.test.ts`, `packages/gateway/src/backup/storage-usage.test.ts`, `packages/gateway/src/serve/storage-quota-health.test.ts`, `packages/gateway/src/backup/backup-backend.test.ts`, `packages/gateway/src/backup/backup-service.test.ts`.

### §4 `casAck` (and store-class knobs) off owner settings; the wire declaration stays and is defaulted

`casAck` and `storageClass` removed from the owner-editable `POLICY_KEYS` in `packages/gateway/src/routes/backup-routes.ts`; the fields and the `receipt` default stay in `packages/vault/src/backup-policy.ts` for the wire declaration and engine. `packages/client/src/gateway-client-backup.ts` omits both from the patch DTO; the `BackupPolicyPanel` "Confirm an attachment" select and storage-class control are deleted. PROTOCOL.md's declared-policy section states `casAck` is machine-to-machine and MUST NOT surface as a user choice. Cadence fields stay owner-editable as advanced.

### §6 five-metric derivations implemented once in `packages/client` (normative worst-clock-wins freshness, retention daily rung, structural privacy, aggregate cost, honest exit)

New framework-free module `packages/client/src/storage-metrics.ts` (exported from `packages/client/src/index.ts`) with `deriveStorageMetrics`: freshness `T = min` of the four clocks (last acked WAL segment, outbox-drained watermark, last registered snapshot, last successful verification; any missing clock ⇒ unknown), green ≤1× / yellow >1× / red >2× declared cadence; recovery window = the retention ladder's daily rung; privacy = structural constant (sealed bytes, client-only key custody); cost = aggregate `bytesStored` across all store classes vs quota; exit = always-available export + `restoreCostClass` passthrough. 19 unit tests in `packages/client/src/storage-metrics.test.ts`. `packages/client/src/react/screens/backupMetrics.ts` maps gateway DTOs into a single derivation call; the gateway additively exposes `home` discovery (retention + restoreCostClass) on the backup status body via `homeDiscovery()` in `packages/gateway/src/backup/backup-service.ts` and `packages/gateway/src/routes/backup-routes.ts`.

### §6 prerequisite: GC-pins-snapshots invariant — blobs referenced by any retained snapshot are live GC roots, enforced at the real deletion path

The recon assumption "no remote CAS deletion exists" was false: the custody sweep (`packages/vault/src/blob/custody-reconcile.ts` via `packages/vault/src/gateway/gateway.ts` `sweepBlobs` and `packages/gateway/src/serve/vault-plane.ts` `runBlobSweep`) orphan-deletes remote CAS objects not in the live set — a blob referenced only by a retained snapshot was a genuine deletion candidate. New `packages/gateway/src/backup/snapshot-blob-roots.ts` (`snapshotReferencedBlobShas`) opens and authenticates every unpruned snapshot manifest (mirroring `pruneWalGenerations`'s keep-set; unreadable manifest throws — the root set never silently shrinks) and is threaded end-to-end: `ReconcileOptions.extraLiveRoots` in `packages/vault/src/blob/custody-types.ts` pins roots at the delete site; `packages/gateway/src/backup/backup-service.ts` attaches the supplier per backup-configured vault; on supplier failure the sweep fails safe (orphan-delete skipped). The shared CAS-diff primitive extracted to `packages/gateway/src/backup/backup-cas-diff.ts` treats snapshot-referenced blobs as live and reports their remote absence as CRITICAL `missing` (status error) in `packages/gateway/src/backup/backup-reconciliation.ts`; `packages/gateway/src/backup/backup-cas-reconciliation.ts` documents why the cas-only pass is structurally exempt (no provider ⇒ no manifests). Tests: `packages/gateway/src/backup/snapshot-blob-roots.test.ts`, `packages/gateway/src/backup/backup-reconciliation.test.ts`, `packages/gateway/src/serve/vault-plane-blob-sweep.test.ts`, `packages/vault/src/blob/blob.test.ts`.

### §7 settings surface collapsed to the binary: one choice per vault (On this device / Hosted); store-class vocabulary deleted from the surface; BackupCard renders exactly the five metrics with the four clocks behind a diagnostics disclosure

`packages/client/src/react/screens/SettingsStorageScreen.tsx` (+`packages/client/src/react/screens/SettingsStorageScreen.module.css`, `packages/client/src/react/screens/SettingsStorageScreen.test.tsx`) rewritten: guided "Connect your storage provider" form (beta guided key entry), Test/Disconnect, the recovery-kit blocking dialog preserved, per-vault segmented On this device / Hosted control; no kind toggle, no "Use for" checkboxes, no CAS-tier picker (749→565 lines, waiver shrunk). `packages/client/src/react/screens/BackupCard.tsx` (+`packages/client/src/react/screens/BackupCard.module.css`, `packages/client/src/react/screens/BackupCard.test.tsx`) rewritten around new `packages/client/src/react/screens/BackupHealthMetrics.tsx`: exactly the five readouts; the four clocks, Back-up/Verify triggers, and per-vault policy/inventory live inside a collapsed Diagnostics disclosure; Exit is an always-visible action with the metered-egress note. `packages/client/src/react/screens/BackupPolicyPanel.tsx` loses casAck/storageClass. `StorageCard` deleted (`packages/client/src/react/screens/StorageCard.tsx`, `packages/client/src/react/screens/StorageCard.module.css`, `packages/client/src/react/screens/StorageCard.test.tsx`); `packages/client/src/react/screens/BackupsScreen.tsx` (+`packages/client/src/react/screens/BackupsScreen.module.css`, `packages/client/src/react/screens/BackupsScreen.test.tsx`) and `packages/client/src/react/shell/routes/BackupsRoute.tsx` render the single BackupCard; bridges `packages/client/src/react/shell/routes/settingsStorageData.ts` and `packages/client/src/react/shell/routes/gatewayStorageData.ts` drop the vestigial byo-s3/`uses` synthesis; `packages/client/src/react/shell/routes/SettingsRoute.tsx` subtitle updated. Acceptance grep: no user-visible byo-s3/uses/casAck/storageClass/CAS strings on the final screens.

### Interop: full cross-repo conformance suite green (26/26) against the real clawgnition gateway over the renamed routes

`packages/backup/src/interop-clawgnition.test.ts` modernized for the provider's routed-key auth (signs in as the seeded operator and mints a key over `POST /v1/keys`; `bun run predev` — the repo is bun-managed, pnpm no longer runs there) and hardened (real-SQLite scenario-b fixture, timeouts). `packages/backup/src/wire-client.ts` gains protocol-correct 429/transient-5xx backpressure retry with jittered backoff. One kit over-assertion fixed in `packages/backup/src/conformance-observability.ts` (`policy` floor asserted `=== 30` where PROTOCOL.md makes 30 a lower bound; now `>= 30`). Enabling `profiles: ["home"]` turned on the previously-skipped policy/inventory/audit cases, which exposed real provider-side conformance bugs (millisecond timestamps, wrong events/inventory wire shapes, boolean `casAck` where the spec says `'receipt' | 'replicated'`) — all fixed on the clawgnition side in its repo.

## Out of scope

- Building Layer 0 provisioning (spec-only by decision; deferred to post-beta / pre-GA).
- Any inference/LLM surface (postponed by the issue).
- Multi-writer / device-direct provider access; unshipping `derived` or merging store classes.
- Package/internal symbol churn beyond the wire rename (`@centraid/backup` keeps its name).
- The clawgnition-side changes were committed in that repo under clawgnition#132 (by the session driving that issue). Two product decisions flagged for clawgnition#132: every production tier ships `backup_cas_ack_required=1` (require `'replicated'`), conflicting with centraid's `receipt` default; and the tier RPO floor is 60s vs the protocol floor of 30s.
- A dedicated full-data-export endpoint (the Exit action explains the always-available export path honestly; wire it to an endpoint when one lands).

## Decisions

- **`policy` REQUIRED for `home`** (the issue left it open): the five-metric freshness status derives from declared cadence, so a home provider without `policy` cannot support the watchdogs.
- **byo-s3 removed entirely**, not kept as an Advanced escape hatch (the issue allowed either): a power user can run a thin self-hosted provider shim later; keeping the hatch would have kept `StorageConnectionUse` alive.
- **Freshness cadence** = the slowest of the three policy cadences against `T = min(clocks)`, so an on-schedule fleet doesn't false-red on its oldest clock; `backup-health.ts` per-clock alarms remain the engine-side watchdog.
- **Outbox-drained watermark** has no stored timestamp; sourced honestly as `lastWalDrainAt` only when `pendingOffsite.count === 0`, else null (freshness reads unknown) rather than inventing gateway plumbing.
- **Unreadable retained manifest now fails the whole backup reconciliation pass** (status error) instead of a non-fatal note — you must not report orphans when reachability is unprovable; consistent with `pruneWalGenerations`.
- **Interop harness auth**: the provider retired flat seeded keys for routed keys mid-window; the suite now exercises the real dashboard mint flow instead of reviving the flat key. Dev-only predev relaxations on the provider side (target-count cap, `backup_cas_ack_required=0`) keep local runs repeatable without touching production defaults.

## Verification

```sh
bun run ci                          # format, oxlint, turbo lint, typecheck, lint:types, lint:css — all green
bunx turbo run test --concurrency=2 # 27/27 tasks green (client 934, gateway 702+2 skipped, vault 759, backup 277+26 skipped, blueprints 222, mobile 187, …)
cd packages/backup && bun run test:interop   # 26/26 against the real clawgnition gateway (wrangler dev), stable across 3 clean-state runs
```

- The full-parallel `bun run test` can flake under agent-load resource contention (miniflare/SQLITE_BUSY, tmpdir races); `--concurrency=2` is clean.
- Acceptance rule (§7): every control/readout on the storage surface maps to one of the five metrics — verified by the rewritten `SettingsStorageScreen.test.tsx` / `BackupCard.test.tsx` ("five-metric surface" describe: exactly-five render, diagnostics placement, casAck/storageClass absent).

## Audit

**Verdict: PASS**

- **§5 rename verified at the wire.** `packages/backup/PROTOCOL.md` carries 23 `/v1/storage` occurrences and **zero** `/v1/backup`; `remote-provider.ts` constructs every route under `/v1/storage/...` (provider, vaults, credentials, usage, policy, inventory, events, snapshots). The `backup` store class, `centraid-storage-provider/1` version string, and `u/{id}/backup/` prefixes are untouched, as claimed. Confirmed the clawgnition side genuinely serves the renamed paths (`apps/gateway/src/routes/backup-control.ts`, `backup-credentials.ts` mount `/v1/storage/vaults/:vaultId/{policy,inventory,events,credentials}`) — so the "no released implementation serves the old paths" claim holds.
- **§1 home profile realized.** `provider.ts` defines `ProviderProfile`, `PROVIDER_PROFILES`, `profiles?` on capabilities, and `HOME_PROFILE_CAPABILITIES` containing exactly the seven members incl. `policy` (matching the "policy decided REQUIRED" decision). `conformance.ts` asserts array-ness, known-profile membership, and `home ⇒ every member capability` with a per-member failure. The fake provider advertises `profiles: ['home']`. Faithful.
- **§4 casAck de-surfaced, verified by reading the array — not the prose.** `POLICY_KEYS` in `backup-routes.ts` now enumerates only the nine cadence/budget keys; `casAck` and `storageClass` are absent, and the adjacent comment documents why the wire field survives. Matches the claim that the declaration stays while the owner knob goes.
- **§6 prerequisite threaded to the real delete site.** `snapshot-blob-roots.ts` exports `snapshotReferencedBlobShas`; `custody-types.ts` adds `ReconcileOptions.extraLiveRoots`; and `custody-reconcile.ts:76` actually consults it (`if (options.extraLiveRoots?.has(sha)) continue;`) *before* the orphan-delete — i.e. the pin is enforced at the deletion path, not merely declared. This was the claim most worth refuting and it survives.
- **§6/§7 surfaces exist as described.** `storage-metrics.ts` derives all five metrics in one `deriveStorageMetrics` call (freshness / recoveryWindow / privacy / cost / exit), with the new `storage-metrics.test.ts`, `BackupHealthMetrics.tsx`, `backupMetrics.ts`, and `backup-cas-diff.ts` present; `StorageCard.{tsx,module.css,test.tsx}` are genuinely deleted (`D` in status), not merely unreferenced. The `conformance-observability.ts` over-assertion fix is real (`details.minimum >= 30`, not `=== 30`).
- **Checklist mirrors the issue faithfully.** The issue carries no literal checkboxes; the receipt's nine `- [x]` items map 1:1 onto its numbered amendments §1–§7 plus the §6 GC prerequisite and the cross-repo interop item, and each item's text is echoed in `## What changed`. Nothing in the issue's amendment set is silently dropped, and the deferred §3 is correctly checked as *specified* (spec-only) rather than built — consistent with the issue's own "nobody builds it now" status callout.
- **One non-material staleness, insufficient to refute.** `## What changed` §5 and `## Out of scope` describe the clawgnition-side changes as "uncommitted there"; they were in fact committed as `43438b2 feat: storage-first inversion and protocol amendments (#132)` at 18:19 today, after the receipt prose was written. The substantive claim (the rename landed and is served) is verified true and is *stronger* than stated, so this is stale commit-state metadata rather than an unsupported claim.
- **Unverified-by-design.** The `26/26` interop and full `turbo run test` results are replayable-command claims I did not re-execute (both require a live wrangler-dev clawgnition gateway); the `## Verification` block names the exact commands, which is what the rule asks of it.

## Steering

**Verdict: PASS**

- **Zero genuine human-steering events found.** The session has exactly one real typed human turn — the opening `/goal` command ("please work on the entire scope of …/issues/436, act as orchestrator and spawn opus subagents") at 2026-07-17T10:42:43Z. That is the initial goal message that *started* the work, not a mid-task redirect or correction, so per the directive it is not a steering event and no `## Accounting` → `### Steering` rows were added.
- **How the 101 `"type":"user"` entries were separated.** Parsed the transcript as JSON and kept only user entries carrying a real `text` content block, discarding `tool_result` blocks (the bulk of the 101). The remaining eight candidates all resolve to non-human sources: one `<local-command-stdout>` echo, one `isMeta: true` Stop-hook system reminder, and six `<task-notification>` envelopes reporting subagent completion (A1, A2, A3, B, C, interop) — all automated, none typed by the operator.
- **No interrupts.** `grep -c "Request interrupted by user"` returns 0, so there are no `type: interrupt` / tier `structural` rows to record either. Consistent with a clean orchestrator run that was never interrupted.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-ab218e68-6ea-1784293053-1 | claude-code | ab218e68-6ea2-411f-b516-cc6e1671666c | #436 | claude-fable-5 | 400 | 1124377 | 32268960 | 152055 | 1276832 | 53.9304 | 400 | 1124377 | 32268960 | 152055 | feat(backup): rename wire routes to /v1/storage, add home profile + provisioning |
| claude-code-ab218e68-6ea-1784293123-1 | claude-code | ab218e68-6ea2-411f-b516-cc6e1671666c | #436 | claude-fable-5 | 15 | 16478 | 2004358 | 3702 | 20195 | 2.3956 | 415 | 1140855 | 34273318 | 155757 | feat(backup): rename wire routes to /v1/storage, add home profile + provisioning |
| claude-code-ab218e68-6ea-1784293167-1 | claude-code | ab218e68-6ea2-411f-b516-cc6e1671666c | #436 | claude-fable-5 | 4 | 982 | 508261 | 283 | 1269 | 0.5347 | 419 | 1141837 | 34781579 | 156040 | x (#436) |
| claude-code-ab218e68-6ea-1784293224-1 | claude-code | ab218e68-6ea2-411f-b516-cc6e1671666c | #436 | claude-fable-5 | 8 | 8588 | 1021442 | 2725 | 11321 | 1.2651 | 427 | 1150425 | 35803021 | 158765 | feat(backup): rename wire routes to /v1/storage, add home profile + provisioning |
| claude-code-ab218e68-6ea-1784293270-1 | claude-code | ab218e68-6ea2-411f-b516-cc6e1671666c | #436 | claude-fable-5 | 4 | 1664 | 516314 | 1480 | 3148 | 0.6112 | 431 | 1152089 | 36319335 | 160245 | feat(gateway,vault): one home connection, home-profile gate, snapshot-pinned CAS |
| claude-code-ab218e68-6ea-1784293321-1 | claude-code | ab218e68-6ea2-411f-b516-cc6e1671666c | #436 | claude-fable-5 | 2 | 933 | 258989 | 699 | 1634 | 0.3056 | 433 | 1153022 | 36578324 | 160944 | feat(client): five-metric storage surface + hosted-vs-local settings binary (#43 |
| claude-code-ab218e68-6ea-1784293356-1 | claude-code | ab218e68-6ea2-411f-b516-cc6e1671666c | #436 | claude-fable-5 | 2 | 1056 | 259922 | 131 | 1189 | 0.2797 | 435 | 1154078 | 36838246 | 161075 | x (#436) |
| claude-code-ab218e68-6ea-1784293426-1 | claude-code | ab218e68-6ea2-411f-b516-cc6e1671666c | #436 | claude-fable-5 | 9 | 5885 | 1308382 | 4410 | 10304 | 1.6025 | 444 | 1159963 | 38146628 | 165485 | feat(client): five-metric storage surface + hosted-vs-local settings binary (#43 |
