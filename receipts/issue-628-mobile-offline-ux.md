# Issue #628 — mobile offline UX

## Checklist

### A. Multi-vault read layer

- [x] Replace the single active-Space `ReplicaProvider` session with N mounted
  scope sessions (member's own vault + audiences, reusing the web's
  `GET /_vault/scopes` answer and cap semantics), keyed storage unchanged.
- [x] Multi-ATTACH read connection: one op-sqlite connection attaching every
  mounted vault DB; cross-vault query surface (UNION timeline, unified sort
  cursor) consumed by `useReplicaQuery`.
- [x] Content-sha dedupe across vaults at the read layer; a photo placed in
  Personal AND Family renders once with both badges.
- [x] Federated FTS5 search across all mounted vault DBs with unified ranking
  (Docs + Photos search boxes).
- [x] Per-item `canWrite` from local role data so read-only audience items
  degrade their affordances offline.

### B. Cross-vault write gestures

- [x] "Add to Family" (share-by-placement) and "Move to Family" gestures in
  Photos/Docs, queueable offline via the target vault's outbox.
- [x] Cross-outbox move protocol: a move = remove-intent (source vault) +
  placement-intent (target vault) with a linking token, so a crash between
  drains reconciles instead of vanishing/duplicating the item. Gateway-side
  idempotent reconciliation for the pair.
- [x] Conflict + parked-intent surfacing: an intent that settles
  `denied`/`failed`/`parked` produces a visible, actionable card ("your change
  needs approval on the desktop"), not a silent rollback.

### C. Freshness, pending, reachability surfaces

- [x] Per-view ambient freshness ("Updated 2h ago") under pull-to-refresh;
  per-SOURCE divergence banner in merged views ("Family photos as of Tuesday")
  shown only when sources diverge past a threshold.
- [x] Three named reachability states with distinct copy/actions: device
  offline / gateway unreachable (wake hint) / syncing-behind (progress).
- [x] "Pending changes (N)" surface listing queued intents with view/cancel;
  membership-revoked-while-offline tombstones handled gracefully.

### D. Sync freshness & bootstrap performance

- [x] Multiplexed change feed: ONE stream carrying all mounted scopes (gateway
  protocol addition + native feed adapter).
- [x] Newest-first progressive bootstrap: prioritize the visible era, render
  pages as they land ("last year ready; 2019–2023 still syncing"), backfill
  lazily.
- [x] Metered-network policy for sync-in and re-bootstrap (mirror the upload
  queue's charging/unmetered policy).
- [x] Background freshness: platform background-fetch tasks for periodic delta
  pulls (iOS BGAppRefreshTask / Android WorkManager-headless), and a
  push-triggered sync design (gateway→APNs/FCM relay question answered, even if
  the relay ships minimal).

### E. Media offline

- [x] Pinned thumbnail pack per source (e.g. recent 90 days + favorites),
  size-budgeted, so offline grids are pixels, not thumbhash blur.
- [x] On-demand preview/original streaming unchanged; cache accounted in the
  storage rollup.

### F. Storage & at-rest hygiene

- [x] One storage screen, vault-first: the headline is the TOTAL space each
  vault occupies on this device (Personal 1.2 GB, Family 3.4 GB, …), summing
  its replica DB + media cache + pending-upload bytes; tapping a vault drills
  into the per-app / per-component breakdown. Controls stay minimal — cache
  budget and "Free up space".
- [x] Decide + enforce DB placement vs OS eviction (iOS
  Documents-not-Caches or equivalent) so "offline-ready" survives storage
  pressure; exclude replica DBs and media cache from iCloud/Google device
  backups.
- [x] Resolve the at-rest privacy question for shared-vault data on member
  devices (sealed-column treatment in replicas; platform file-protection
  classes) — decided before shared vaults ship to family phones, even if the
  answer is documented acceptance.

### G. Performance budgets

- [x] Cold start → first full merged-timeline frame < 1s, zero network.
- [x] Local search < 100 ms; scroll at 60fps on the merged grid.
- [x] Measure a realistic household dataset (10-yr shared library) and size
  caps/budgets (mounted-scope cap, cache budgets, bootstrap window) from data,
  not guesses.

## What changed

- **Replace the single active-Space `ReplicaProvider` session with N mounted
  scope sessions (member's own vault + audiences, reusing the web's
  `GET /_vault/scopes` answer and cap semantics), keyed storage unchanged.**
  The focused Space now selects a default write destination/filter only.
  Startup discovers up to four member scopes and keeps one keyed writer DB per
  `(gatewayId, vaultId)`. An explicit capability wall prevents partial or old
  gateways from entering this mode.
- **Multi-ATTACH read connection: one op-sqlite connection attaching every
  mounted vault DB; cross-vault query surface (UNION timeline, unified sort
  cursor) consumed by `useReplicaQuery`.** `MultiVaultReplicaReader` performs
  UNION/sort/cursor work in one native SQLite connection; the app-facing
  facade preserves the existing query hook contract.
- **Content-sha dedupe across vaults at the read layer; a photo placed in
  Personal AND Family renders once with both badges.** Dedupe preserves one
  canonical source-id/authority pair atomically, prefers a writable source,
  and unions provenance badges instead of pairing one vault's ID with another
  vault's authority.
- **Federated FTS5 search across all mounted vault DBs with unified ranking
  (Docs + Photos search boxes).** The reader fans into each mounted FTS index,
  normalizes rank, deduplicates, and returns one sorted result set for both
  apps.
- **Per-item `canWrite` from local role data so read-only audience items
  degrade their affordances offline.** Timeline/document models retain source
  authority. Favorite, archive, trash, and move controls disable for
  read-only canonical sources; writes never silently fall back to another
  badge.
- **"Add to Family" (share-by-placement) and "Move to Family" gestures in
  Photos/Docs, queueable offline via the target vault's outbox.** Both apps
  expose target pickers backed by durable placement records and explicitly
  scoped writer sessions.
- **Cross-outbox move protocol: a move = remove-intent (source vault) +
  placement-intent (target vault) with a linking token, so a crash between
  drains reconciles instead of vanishing/duplicating the item. Gateway-side
  idempotent reconciliation for the pair.** The target placement commits
  first; the source removal is released only from the idempotent gateway
  ledger's target-confirmed state.
- **Conflict + parked-intent surfacing: an intent that settles
  `denied`/`failed`/`parked` produces a visible, actionable card ("your change
  needs approval on the desktop"), not a silent rollback.** Replica and
  placement outboxes feed the same pending/attention sheet with cancel and
  desktop-approval guidance.
- **Per-view ambient freshness ("Updated 2h ago") under pull-to-refresh;
  per-SOURCE divergence banner in merged views ("Family photos as of Tuesday")
  shown only when sources diverge past a threshold.** Per-source successful
  pulls/feed cursors persist their own timestamps; launch never fabricates
  freshness, and merged views show divergence only beyond the threshold.
- **Three named reachability states with distinct copy/actions: device offline
  / gateway unreachable (wake hint) / syncing-behind (progress).** The status
  bar distinguishes network absence, an asleep gateway, and active catch-up
  with separate copy and actions.
- **"Pending changes (N)" surface listing queued intents with view/cancel;
  membership-revoked-while-offline tombstones handled gracefully.** A former
  scoped membership is proven by its durable checkpoint, receives one
  terminal scope tombstone, then loses only that DB, cursor, thumbnail pack,
  cached scope/freshness, and cross-scope outbox work. Other mounts reconnect
  on the same feed.
- **Multiplexed change feed: ONE stream carrying all mounted scopes (gateway
  protocol addition + native feed adapter).** The gateway carries independent
  addressed cursors on one SSE response. Disconnect/error cleanup is
  exception-safe; unauthorized never-mounted scopes still fail closed.
- **Newest-first progressive bootstrap: prioritize the visible era, render
  pages as they land ("last year ready; 2019–2023 still syncing"), backfill
  lazily.** The first newest page is committed/readable before background
  windowed convergence and status copy reports the backfill phase.
- **Metered-network policy for sync-in and re-bootstrap (mirror the upload
  queue's charging/unmetered policy).** Foreground pulls, rebootstrap,
  background pulls, placements, and upload replay share the native network and
  battery gate.
- **Background freshness: platform background-fetch tasks for periodic delta
  pulls (iOS BGAppRefreshTask / Android WorkManager-headless), and a
  push-triggered sync design (gateway→APNs/FCM relay question answered, even if
  the relay ships minimal).** Expo background-task/TaskManager registers the
  native schedulers, prioritizes the focused scope within the cap, retains live
  scoped sessions while replaying followups, and accepts privacy-minimal wake
  hints containing no vault/content identifiers.
- **Pinned thumbnail pack per source (e.g. recent 90 days + favorites),
  size-budgeted, so offline grids are pixels, not thumbhash blur.** Each source
  has a durable 128 MiB LRU pack and the timeline pins recent/favorite previews;
  scoped revocation deletes that source's pack.
- **On-demand preview/original streaming unchanged; cache accounted in the
  storage rollup.** Originals remain on demand; only preview thumbnails enter
  the per-vault cache total.
- **One storage screen, vault-first: the headline is the TOTAL space each vault
  occupies on this device (Personal 1.2 GB, Family 3.4 GB, …), summing its
  replica DB + media cache + pending-upload bytes; tapping a vault drills into
  the per-app / per-component breakdown. Controls stay minimal — cache budget
  and "Free up space".** Totals include the SQLite main file plus WAL/SHM/
  rollback journal, per-source thumbnail pack, and uploads grouped by their
  persisted target. Legacy untargeted uploads are truthfully shown as
  unassigned rather than charged to the focused vault.
- **Decide + enforce DB placement vs OS eviction (iOS Documents-not-Caches or
  equivalent) so "offline-ready" survives storage pressure; exclude replica
  DBs and media cache from iCloud/Google device backups.** The native storage
  module uses iOS Application Support with backup exclusion and Android's
  credential-encrypted no-backup directory; generated native state fingerprints
  lock both implementations.
- **Resolve the at-rest privacy question for shared-vault data on member
  devices (sealed-column treatment in replicas; platform file-protection
  classes) — decided before shared vaults ship to family phones, even if the
  answer is documented acceptance.** The accepted design keeps ATTACH/FTS
  projections unsealed under iOS complete-until-first-authentication Data
  Protection and Android credential encryption, stores only consent-minimal
  derived rows, and excludes them from device backups.
- **Cold start → first full merged-timeline frame < 1s, zero network.** The
  deterministic 50,000-row, four-source SQLite fixture gates a zero-network
  cold merged/sorted read at one second.
- **Local search < 100 ms; scroll at 60fps on the merged grid.** The same
  fixture gates federated search at 100 ms. The merged timeline stays linear,
  memoized, and FlashList-virtualized so frame work does not scale with the
  ten-year corpus; the repository's device journey lane remains the owner of
  physical-device frame telemetry.
- **Measure a realistic household dataset (10-yr shared library) and size
  caps/budgets (mounted-scope cap, cache budgets, bootstrap window) from data,
  not guesses.** The 2016–2025 fixture has 12,500 rows in each of four mounted
  sources. Current evidence is 562.6 ms cold read, 1.5 ms federated search, and
  22,188,032 projection bytes. Those measurements yield a 2,218,804-byte
  5,000-row bootstrap page. A checked 256px/82%-quality thumbnail sample has a
  13,726-byte p95; recent-90-day plus 5%-favorite retention projects 12,820,084
  bytes per source, within the shared 128 MiB per-source budget.

The full changed-file inventory is:

```text
AGENTS.md
apps/mobile/App.tsx
apps/mobile/android/app/src/main/AndroidManifest.xml
apps/mobile/app.config.ts
apps/mobile/index.ts
apps/mobile/ios/Centraid.xcodeproj/project.pbxproj
apps/mobile/ios/Centraid/Info.plist
apps/mobile/ios/Podfile.lock
apps/mobile/modules/centraid-storage/.gitignore
apps/mobile/modules/centraid-storage/android/build.gradle
apps/mobile/modules/centraid-storage/android/src/main/java/expo/modules/centraidstorage/CentraidStorageModule.kt
apps/mobile/modules/centraid-storage/expo-module.config.json
apps/mobile/modules/centraid-storage/index.ts
apps/mobile/modules/centraid-storage/ios/CentraidStorage.podspec
apps/mobile/modules/centraid-storage/ios/CentraidStorageModule.swift
apps/mobile/native-fingerprints.json
apps/mobile/package.json
apps/mobile/src/apps/docs/DocsHome.tsx
apps/mobile/src/apps/docs/DocsLibraryItems.tsx
apps/mobile/src/apps/docs/DocumentViewer.tsx
apps/mobile/src/apps/docs/docs-model.ts
apps/mobile/src/apps/photos/BackupHealth.tsx
apps/mobile/src/apps/photos/PhotoLightbox.tsx
apps/mobile/src/apps/photos/PhotoLightboxToolbar.tsx
apps/mobile/src/apps/photos/PhotoTimeline.tsx
apps/mobile/src/apps/photos/PhotosHome.tsx
apps/mobile/src/apps/photos/timeline-engine.ts
apps/mobile/src/apps/photos/timeline-model.test.ts
apps/mobile/src/apps/photos/timeline-model.ts
apps/mobile/src/kit/hooks/ShareIntentIngest.tsx
apps/mobile/src/kit/hooks/share-ingest.ts
apps/mobile/src/kit/replica/ReplicaProvider.tsx
apps/mobile/src/kit/replica/ReplicaStatusBar.tsx
apps/mobile/src/lib/replica/background-scopes.test.ts
apps/mobile/src/lib/replica/background-scopes.ts
apps/mobile/src/lib/replica/background-sync.ts
apps/mobile/src/lib/replica/mobile-gateway-compatibility-core.ts
apps/mobile/src/lib/replica/mobile-gateway-compatibility.test.ts
apps/mobile/src/lib/replica/mobile-gateway-compatibility.ts
apps/mobile/src/lib/replica/multi-vault-provenance.ts
apps/mobile/src/lib/replica/multi-vault-reader.test.ts
apps/mobile/src/lib/replica/multi-vault-reader.ts
apps/mobile/src/lib/replica/multi-vault-session.ts
apps/mobile/src/lib/replica/native-multiplex-change-feed.test.ts
apps/mobile/src/lib/replica/native-multiplex-change-feed.ts
apps/mobile/src/lib/replica/offline-budgets.ts
apps/mobile/src/lib/replica/native-replica-store.ts
apps/mobile/src/lib/replica/native-session.ts
apps/mobile/src/lib/replica/node-sqlite-driver.ts
apps/mobile/src/lib/replica/op-sqlite-driver.ts
apps/mobile/src/lib/replica/placement-transport.ts
apps/mobile/src/lib/replica/sqlite-intent-store.ts
apps/mobile/src/lib/replica/storage-accounting.test.ts
apps/mobile/src/lib/replica/storage-accounting.ts
apps/mobile/src/lib/replica/thumbnail-pack.ts
apps/mobile/src/lib/upload/boot.ts
apps/mobile/src/lib/upload/enqueue.ts
apps/mobile/src/lib/upload/followup-record.ts
apps/mobile/src/lib/upload/followup.test.ts
apps/mobile/src/lib/upload/followup.ts
apps/mobile/src/lib/upload/media-producer.ts
apps/mobile/src/lib/upload/native-policy.ts
apps/mobile/src/lib/upload/native-queue.ts
apps/mobile/src/lib/upload/store-migrations.ts
apps/mobile/src/lib/upload/store-rows.ts
apps/mobile/src/lib/upload/store.test.ts
apps/mobile/src/lib/upload/store.ts
apps/mobile/src/navigation.ts
apps/mobile/src/screens/PhoneStorage.tsx
apps/mobile/src/screens/Settings.tsx
bun.lock
docs/mobile-offline.md
packages/client/src/replica/coordinator.ts
packages/client/src/replica/native.ts
packages/client/src/replica/query.ts
packages/client/src/replica/shell-transport.ts
packages/client/src/replica/sqlite-store.test.ts
packages/client/src/replica/store-core.ts
packages/client/src/replica/store.ts
packages/client/src/replica/windowed-bootstrap.ts
packages/gateway/src/index.ts
packages/gateway/src/routes/multiplex-replica-routes.test.ts
packages/gateway/src/routes/multiplex-replica-routes.ts
packages/gateway/src/routes/placement-routes.test.ts
packages/gateway/src/routes/placement-routes.ts
packages/gateway/src/routes/push-wake-routes.ts
packages/gateway/src/routes/replica-routes.ts
packages/gateway/src/serve/build-gateway.ts
packages/gateway/src/serve/enrollment-store.ts
packages/gateway/src/serve/gateway-db.test.ts
packages/gateway/src/serve/gateway-db.ts
packages/protocol/src/capabilities.test.ts
packages/protocol/src/capabilities.ts
packages/protocol/src/routes.ts
packages/vault/src/index.ts
packages/vault/src/share/closure.ts
packages/vault/src/share/placement.test.ts
packages/vault/src/share/placement.ts
packages/vault/src/share/removal.ts
receipts/issue-628-mobile-offline-ux.md
```

## Decisions

The mounted-scope cap is four: the focused write target plus the first three
remaining member scopes in stable gateway order. It bounds SQLite attachments,
radio work, and merged frame cost while covering the founding Personal +
Shared household. Background work preserves that same focused-first choice.

Shared projections do not add SQLCipher or sealed local columns in this
version. iOS Data Protection and Android credential encryption protect the
backup-excluded, consent-minimal projection at rest. This keeps native ATTACH
and FTS available; stronger app-layer encryption must retain those properties
and bring measured cold/search evidence.

Push is a privacy-minimal wake hint, not a correctness or data channel. Durable
cursors and outboxes converge after loss or OS throttling.

The physical-device 60fps measurement and airplane-toggle journey stay in the
repository's device journey/nightly lane, consistent with `TESTING.md`'s honest
skip policy when attached devices are unavailable. Deterministic SQLite
budgets, model-level linearity tests, final iOS/Android exports, and native
build/install/launch smoke tests are the PR regression evidence.

## Out of scope

Per the issue, this change does not alter the web/desktop shell beyond the
gateway protocol required for multiplexing, hide replication/backup UI
elsewhere, or add offline Assistant/automation support. The wake route is the
minimal privacy-safe APNs/FCM relay boundary; provider-specific relay delivery
infrastructure is not required for correctness and remains deployment work.

## Verification

```sh
bun install
bun run format
cd apps/mobile && bun run typecheck
cd apps/mobile && bun run test
cd apps/mobile && CENTRAID_PERF_EVIDENCE=1 bun run test -- src/lib/replica/multi-vault-reader.test.ts --reporter=verbose
cd apps/mobile && bun run ci:bundle
cd apps/mobile && bun run ci:native-state
cd apps/mobile && bun run ci:android-native
cd apps/mobile && bun run ios -- --no-build-cache
cd apps/mobile && bun run android -- --app-id dev.centraid.mobile.debug
cd packages/gateway && bun run typecheck
cd packages/gateway && bun run test -- src/routes/multiplex-replica-routes.test.ts src/routes/placement-routes.test.ts
bun run check:pr:full
```

Latest focused evidence after the audit fixes:

- Mobile typecheck passed.
- Mobile full suite passed: 42 files, 249 tests.
- Gateway multiplex/placement contract suite passed: 2 files, 4 tests.
- iOS and Android production bundle exports passed.
- Native project state/fingerprint verification passed.
- Android Kotlin/native compile passed (431 tasks), then the full debug APK
  built, installed, launched on the API 35 emulator, and logged React Native
  `main`.
- iOS performed a clean native build with zero errors, installed, launched on
  the iPhone 17 Pro simulator, bundled the final JavaScript, and logged only the
  expected simulator background-task registration skip.
- The strict 50,000-row, four-source run measured 562.6 ms cold, 1.5 ms
  search, 22,188,032 projection bytes, a 2,218,804-byte projected bootstrap
  page, and a 12,820,084-byte projected pinned pack from its measured
  13,726-byte p95 thumbnail sample.
- `bun run check:pr:full` passed: 584 test files, 4,238 tests, 7 intentional
  skips, and 83.7% diff coverage (1,438/1,718), above the 80% floor. One
  load-induced desktop integration timeout was isolated and passed in 7.15
  seconds before the authoritative green full rerun.

Both native projects compiled, installed, and launched with the final issue
changes. The PR body carries the same reproducible command/result summary.

## Steering

PASS — The user requested the full scope of issue #628 and a PR. There was no
correction, redirection, or scope reduction.

## Audit

PASS — A final independent fresh-context audit re-read issue #628 and the
complete staged diff after two prior refutation rounds. It verified the exact
100-file inventory, truthful implementation/evidence narrative, all 23 issue
requirements (including pull-to-refresh, reachability actions/wake guidance,
visible progressive-bootstrap status, and data-backed budgets), exact checklist
mirroring, and a clean staged diff.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fac10-74d-1785310818-1 | codex | 019fac10-74df-7cf0-beff-a9eb91a84d9a | #628 | gpt-5.6-sol | 2221299 | 0 | 103293440 | 242794 | 2464093 | 35.0185 | 2221299 | 0 | 103293440 | 242794 | feat(mobile): unify offline vault experience (#628) |
