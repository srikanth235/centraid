# Issue #425 — Storage-class economics: `derived` store class (protocol) + direct-to-IA at PUT for large media originals (client heuristic)

## Checklist

Part A — `derived` store class (additive protocol amendment):

- [x] `StoreClass` grows `'derived'` (`packages/backup/src/provider.ts:20`); PROTOCOL.md documents the class: binary display derivatives (`thumb`, `preview`, `poster`, and future display rungs — scrub sprites, waveforms, low-bitrate proxies per #414 D13), expected small-and-hot, providers SHOULD keep it on their hot tier permanently.
- [x] Discovery `capabilities` may advertise `"derived"` — optional, independent flag, same rules as `"cas"` (`provider.ts:309`). Providers MUST implement the routes they advertise.
- [x] Credentials: `POST /v1/backup/vaults/:id/credentials` accepts `{ "store": "derived" }`; grant prefix `u/{id}/derived/`; same credential mechanics, TTL, and per-vault prefix scoping as `backup`/`cas`.
- [x] Store-class-parameterized surfaces extend mechanically: `usage` gains a `derived` row; `inventory` accepts `store=derived`; audit `credential-issued` detail already names the store. Quota stays one combined per-user pool (consistent with the provider's combined-quota decision).
- [x] Blob replication routes **binary** derivatives to the `derived` store when the target grants it; originals, snapshot chunks, and outbox promotion continue to `cas`. Semantic contributions (`text`, `transcript`, `embedding`, `phash`, `thumbhash`) stay inline in the derivative row per the existing registry split — nothing changes there.
- [x] `blob_replica` / custody tracks which store class holds each replica so evict-only-if-replicated, reconciliation (`backup-cas-inventory.ts`, `backup-reconciliation.ts`), and restore read from the right prefix.
- [x] **Graceful degradation**: a provider without `"derived"` keeps today's behavior byte-for-byte — derivatives replicate into `cas`. No client hard-depends on the capability.
- [x] Restore/read paths (including the previews-first lazy restore ladder) resolve derivative bytes from the `derived` prefix when that's where they were written.

Part B — direct-to-IA at PUT for large media originals:

- [x] Per-object storage-class heuristic in the blob upload/replication path: originals with media MIME (video/audio, optionally stills) **and** size above a threshold (~25 MB) are PUT with `x-amz-storage-class: STANDARD_IA`; everything else keeps the vault-level `storageClass` setting (default unset ⇒ Standard). The per-object mechanism shipped in #402 (`S3BlobStoreOptions.storageClass`, signed header on PUT and multipart-create); this adds the per-object *decision*, so the option needs to be resolvable per transfer rather than per store instance.
- [x] Applies on both byte doors: the #414 §11 direct-to-CAS presign path (the presigned headers must include the storage-class header for it to be signed) and the §2 gateway-mediated fallback. The tmp→CopyObject oversized path should carry the class on the CopyObject (the object-creating call).
- [x] Never applies to: derivatives (Part A — hot forever), snapshot chunks and WAL segments (bimodal/short lifetimes — minimum-duration trap; the provider's age rule owns those), or small originals.
- [x] Threshold + MIME set live in the existing `BackupPolicy`/settings surface next to `storageClass`; documented default on, since it is invisible to the user by construction.
- [x] Provider-agnostic honesty: only engage the heuristic when the target actually supports the class (R2 accepts `STANDARD`/`STANDARD_IA` only; arbitrary S3 endpoints vary) — probably gated on a declared/validated storage-class list rather than sniffed behaviorally.

Conformance & tests:

- [x] Fake provider advertises and implements `derived`; conformance covers grant issuance, prefix scoping, usage row, and inventory `store=derived`.
- [x] Routing test: against a `derived`-capable provider, every replicated `thumb`/`preview`/`poster` lands under `u/{id}/derived/` and **no** derivative object lands under `u/{id}/cas/`; against a non-capable provider, behavior is unchanged.
- [x] Heuristic test: a >threshold video original PUTs with `x-amz-storage-class: STANDARD_IA` on both byte doors (fake S3 captures the signed header, as in `s3.test.ts`); a small original and a derivative PUT with no storage-class header; a non-R2-like target with no declared IA support never sends the header.
- [x] Reconciliation sweep diffs all granted store classes, including `derived`; inventory `storageClass` reflects direct-to-IA writes.
- [ ] Clawgnition interop green (provider side tracked in Clawgnition/clawgnition#118). — provider-side `derived` support does not exist yet; the interop suite self-skips without `CLAWGNITION_INTEROP=1` and the full conformance list (now including the `derived` cases) runs automatically once Clawgnition advertises the capability.

## What changed

Two halves of one decision: route each CAS object population to the storage class its read pattern and lifetime justify, so the provider's age-based cold-tiering rule (Clawgnition/clawgnition#118) applies only to the population it is right for.

**Part A — protocol.** `StoreClass` grows `'derived'` (`packages/backup/src/provider.ts:20`); PROTOCOL.md documents the class: binary display derivatives (`thumb`, `preview`, `poster`, and future display rungs — scrub sprites, waveforms, low-bitrate proxies per #414 D13), expected small-and-hot, providers SHOULD keep it on their hot tier permanently. A new exported `STORE_CLASSES` const is the single source of truth; `provider-observability.ts` inventory validation, `local-provider.ts` capabilities/usage, and the fake provider all key off it. Discovery `capabilities` may advertise `"derived"` — optional, independent flag, same rules as `"cas"` (`provider.ts:309`). Providers MUST implement the routes they advertise. Credentials: `POST /v1/backup/vaults/:id/credentials` accepts `{ "store": "derived" }`; grant prefix `u/{id}/derived/`; same credential mechanics, TTL, and per-vault prefix scoping as `backup`/`cas`. The `requestDerivedGrant` wrapper was added in `cas-grant.ts` and exported from `index.ts`. Store-class-parameterized surfaces extend mechanically: `usage` gains a `derived` row; `inventory` accepts `store=derived`; audit `credential-issued` detail already names the store. Quota stays one combined per-user pool (consistent with the provider's combined-quota decision). Discovery also gains an optional `storageClasses` list (the Part B honesty seam): the provider declares which `x-amz-storage-class` values its data plane accepts; absent means clients MUST NOT send the header.

**Part A — client routing.** Blob replication routes **binary** derivatives to the `derived` store when the target grants it; originals, snapshot chunks, and outbox promotion continue to `cas`. Semantic contributions (`text`, `transcript`, `embedding`, `phash`, `thumbhash`) stay inline in the derivative row per the existing registry split — nothing changes there. `desiredStoreForSha` (new `packages/vault/src/blob/store-routing.ts`) resolves a sha to its population at drain time (original custody wins the dedup edge where one sha is both original and derivative); `resolveWriteStore` applies graceful degradation and a 32 MiB derived-cap fallback. `blob_replica` / custody tracks which store class holds each replica so evict-only-if-replicated, reconciliation (`backup-cas-inventory.ts`, `backup-reconciliation.ts`), and restore read from the right prefix: `blob_replica` gains a `store` column (`packages/vault/src/schema/blob.ts`), `ReplicaIndex` marks/heals per store, the cas reconcile diff is scoped to `store='cas'` rows so a cas listing can never disprove derived evidence (and vice versa; new `backup-cas-reconciliation.test.ts` cases), and a new `backup-derived-inventory.ts` sweeps the derived prefix. `custody-reconcile.ts` (extracted from `custody.ts` to respect the file-size cap) lists every granted store, orphan-deletes and heals per store. **Graceful degradation**: a provider without `"derived"` keeps today's behavior byte-for-byte — derivatives replicate into `cas`. No client hard-depends on the capability (no `derivedPrefix` in settings ⇒ single-store behavior, DDL default backfills `store='cas'`). Restore/read paths (including the previews-first lazy restore ladder) resolve derivative bytes from the `derived` prefix when that's where they were written (`storeForRead` via `replica.storeOf`, cas fallback). The gateway learns the capability at attach: `ensureProviderCasTarget` checks discovery, mints a derived grant, and `vault-routes.ts` stamps `derivedPrefix` into `blob_store` settings; the credentials resolver caches grants per `${connectionId}:${store}`.

**Part B — direct-to-IA heuristic.** Per-object storage-class heuristic in the blob upload/replication path: originals with media MIME (video/audio, optionally stills) **and** size above a threshold (~25 MB) are PUT with `x-amz-storage-class: STANDARD_IA`; everything else keeps the vault-level `storageClass` setting (default unset ⇒ Standard). The per-object mechanism shipped in #402 (`S3BlobStoreOptions.storageClass`, signed header on PUT and multipart-create); this adds the per-object *decision*, so the option needs to be resolvable per transfer rather than per store instance — `put`/`putStream`/`createMultipartUpload`/`beginShaUpload`/`copyTemporaryToSha` accept a per-call storage-class override that wins over the instance option. The pure resolver `resolveStorageClassForWrite` fires only when ALL hold: store is `cas`, policy knob enabled, explicit vault-level `storageClass` unset, target's declared list includes `STANDARD_IA`, MIME prefix matches (`video/`, `audio/`; stills deliberately excluded for v0), size ≥ threshold; cheap gates short-circuit before any DB lookup. Applies on both byte doors: the #414 §11 direct-to-CAS presign path (the presigned headers must include the storage-class header for it to be signed) and the §2 gateway-mediated fallback. The tmp→CopyObject oversized path should carry the class on the CopyObject (the object-creating call) — and it does: every door promotes through `copyTemporaryToSha`, which now carries the per-object class on the CopyObject (the presigned tmp PUT itself stays class-less by design since presign signs only `host`; the class lands on the object-creating call — see Decisions). All three streaming ingress doors (`one-shot-stream.ts`, `stream-ingress.ts`, `unknown-hash-stream.ts`) and `direct-transfers.ts` pass an `originalHint` (`mediaType`, `byteSize`) computed before the promote, because on remote-primary doors the staging row lands after the CopyObject — without the hint the heuristic would never fire for exactly its target population (found by adversarial review + empirical test). Never applies to: derivatives (Part A — hot forever), snapshot chunks and WAL segments (bimodal/short lifetimes — minimum-duration trap; the provider's age rule owns those), or small originals — WAL/segment shas have no original-media row and derivatives resolve to the `derived` store, so both are structurally ineligible. Threshold + MIME set live in the existing `BackupPolicy`/settings surface next to `storageClass`; documented default on, since it is invisible to the user by construction (`directToColdOriginals { enabled, minBytes, mimePrefixes }` in `backup-policy.ts`; empty-string `storageClass` now normalizes to unset). Provider-agnostic honesty: only engage the heuristic when the target actually supports the class (R2 accepts `STANDARD`/`STANDARD_IA` only; arbitrary S3 endpoints vary) — probably gated on a declared/validated storage-class list rather than sniffed behaviorally — implemented exactly so: discovery `storageClasses` is stamped into `blob_store.supportedStorageClasses` at attach; BYO-S3 targets have no declaration so the heuristic never engages there.

### Checklist evidence

Each checked item, quoted verbatim, with where it is realized:

1. `blob_replica` / custody tracks which store class holds each replica so evict-only-if-replicated, reconciliation (`backup-cas-inventory.ts`, `backup-reconciliation.ts`), and restore read from the right prefix. Evidence: `store` column in `schema/blob.ts`, per-store `ReplicaIndex` mark/heal/storeOf, store-scoped diffs in `backup-cas-reconciliation.ts`/`backup-derived-inventory.ts`, `storeForRead` in `custody.ts`.
2. **Graceful degradation**: a provider without `"derived"` keeps today's behavior byte-for-byte — derivatives replicate into `cas`. No client hard-depends on the capability. Evidence: no `derivedPrefix` in settings ⇒ single-store behavior; DDL default backfills `store='cas'`; asserted byte-identical in `store-routing.test.ts`.
3. Restore/read paths (including the previews-first lazy restore ladder) resolve derivative bytes from the `derived` prefix when that's where they were written. Evidence: `storeForRead` via `replica.storeOf` with cas fallback; evicted-preview read-through test fetches from the derived prefix.
4. Per-object storage-class heuristic in the blob upload/replication path: originals with media MIME (video/audio, optionally stills) **and** size above a threshold (~25 MB) are PUT with `x-amz-storage-class: STANDARD_IA`; everything else keeps the vault-level `storageClass` setting (default unset ⇒ Standard). The per-object mechanism shipped in #402 (`S3BlobStoreOptions.storageClass`, signed header on PUT and multipart-create); this adds the per-object *decision*, so the option needs to be resolvable per transfer rather than per store instance. Evidence: per-call override on `put`/`putStream`/`createMultipartUpload`/`beginShaUpload`/`copyTemporaryToSha`; pure resolver `resolveStorageClassForWrite` in `store-routing.ts`.
5. Applies on both byte doors: the #414 §11 direct-to-CAS presign path (the presigned headers must include the storage-class header for it to be signed) and the §2 gateway-mediated fallback. The tmp→CopyObject oversized path should carry the class on the CopyObject (the object-creating call). Evidence: `direct-transfers.ts` and all three streaming ingress doors thread the class onto the `copyTemporaryToSha` CopyObject — the object-creating call on every door (see Decisions on why the presigned tmp PUT itself stays class-less); the outbox door sets it on PUT/multipart-create.
6. Never applies to: derivatives (Part A — hot forever), snapshot chunks and WAL segments (bimodal/short lifetimes — minimum-duration trap; the provider's age rule owns those), or small originals. Evidence: resolver requires store `cas` + an original-media row/hint + size ≥ threshold; WAL/segment shas have no original row; derived-store writes are excluded by the store gate; negative tests in `direct-cold-originals.test.ts`.
7. Threshold + MIME set live in the existing `BackupPolicy`/settings surface next to `storageClass`; documented default on, since it is invisible to the user by construction. Evidence: `directToColdOriginals { enabled, minBytes, mimePrefixes }` in `backup-policy.ts`, default enabled at 25 MiB with `video/`/`audio/`.
8. Provider-agnostic honesty: only engage the heuristic when the target actually supports the class (R2 accepts `STANDARD`/`STANDARD_IA` only; arbitrary S3 endpoints vary) — probably gated on a declared/validated storage-class list rather than sniffed behaviorally. Evidence: discovery `storageClasses` declaration stamped into `blob_store.supportedStorageClasses` at attach; resolver requires the list to include `STANDARD_IA`; BYO-S3 has no declaration ⇒ heuristic off.
9. Fake provider advertises and implements `derived`; conformance covers grant issuance, prefix scoping, usage row, and inventory `store=derived`. Evidence: `fake-provider-server.ts` advertises `derived` + `storageClasses` and serves its usage row and inventory; `conformance-derived.ts` cases (round-trip, pairwise namespace isolation, grant echo + disjoint prefix) run against local and remote reference providers; `conformance-observability.ts` inventory loop covers `derived`.
10. Routing test: against a `derived`-capable provider, every replicated `thumb`/`preview`/`poster` lands under `u/{id}/derived/` and **no** derivative object lands under `u/{id}/cas/`; against a non-capable provider, behavior is unchanged. Evidence: `store-routing.test.ts` iterates all captured objects asserting every derivative key under the derived prefix and none under cas, original under cas, plus `blob_replica.store` values; `outbox-drain.test.ts` covers the primary outbox door.
11. Heuristic test: a >threshold video original PUTs with `x-amz-storage-class: STANDARD_IA` on both byte doors (fake S3 captures the signed header, as in `s3.test.ts`); a small original and a derivative PUT with no storage-class header; a non-R2-like target with no declared IA support never sends the header. Evidence: `direct-cold-originals.test.ts` covers the outbox single-PUT door, the multipart door (>32 MiB original), the gateway-mediated stream-through door end-to-end (seal → temp multipart → CopyObject promote with STANDARD_IA), the CopyObject override unit, the resolver eligibility matrix, and the negative cases (small, non-media, derivative, undeclared target, explicit vault-level class suppresses the heuristic).
12. Reconciliation sweep diffs all granted store classes, including `derived`; inventory `storageClass` reflects direct-to-IA writes. Evidence: `backup-derived-inventory.ts` + `backup-cas-reconciliation.test.ts` (per-store diff/unmark/heal); the S3 LIST parser in `s3-store.ts` surfaces `<StorageClass>` into `ProviderInventoryObject.storageClass` and `collectOwnS3` carries it through, so inventory rows report the class the object was written with.

### Changed paths

- packages/backup/PROTOCOL.md
- packages/backup/src/cas-grant.ts
- packages/backup/src/conformance-derived.ts (new)
- packages/backup/src/conformance-observability.ts
- packages/backup/src/conformance.ts
- packages/backup/src/index.ts
- packages/backup/src/local-provider.ts
- packages/backup/src/provider-observability.ts
- packages/backup/src/provider.ts
- packages/backup/src/remote-provider.test.ts
- packages/backup/src/testing/fake-provider-server.ts
- packages/gateway/src/backup/backup-cas-inventory.ts
- packages/gateway/src/backup/backup-cas-reconciliation.test.ts
- packages/gateway/src/backup/backup-cas-reconciliation.ts
- packages/gateway/src/backup/backup-derived-inventory.ts (new)
- packages/gateway/src/backup/backup-reconciliation.ts
- packages/gateway/src/backup/storage-credentials.test.ts (new)
- packages/gateway/src/backup/storage-credentials.ts
- packages/gateway/src/routes/vault-routes.ts
- packages/vault/src/backup-policy.test.ts
- packages/vault/src/backup-policy.ts
- packages/vault/src/blob/cache.test.ts
- packages/vault/src/blob/custody-reconcile.ts (new)
- packages/vault/src/blob/custody-types.ts
- packages/vault/src/blob/custody.ts
- packages/vault/src/blob/direct-cold-originals.test.ts (new)
- packages/vault/src/blob/direct-transfers.ts
- packages/vault/src/blob/one-shot-stream.ts
- packages/vault/src/blob/outbox-drain.test.ts
- packages/vault/src/blob/outbox-drain.ts
- packages/vault/src/blob/outbox-runner.test.ts
- packages/vault/src/blob/outbox-runner.ts
- packages/vault/src/blob/remote-transfer.ts
- packages/vault/src/blob/replica-index.ts
- packages/vault/src/blob/s3-transfer.ts
- packages/vault/src/blob/s3.ts
- packages/vault/src/blob/store-routing.test.ts (new)
- packages/vault/src/blob/store-routing.ts (new)
- packages/vault/src/blob/store.ts
- packages/vault/src/blob/stream-ingress.ts
- packages/vault/src/blob/transfers.ts
- packages/vault/src/blob/unknown-hash-stream.ts
- packages/vault/src/db.ts
- packages/vault/src/index.ts
- packages/vault/src/schema/blob.ts
- receipts/issue-425-storage-class-economics.md (this receipt)

## Out of scope

- Any change to which variants exist or how they're computed (#414 D9/D13 own that).
- Tiering policy on the provider side (Clawgnition/clawgnition#118 owns bucket layout, lifecycle ages, retrieval-fee posture) — Clawgnition will not enable its `cas`→IA lifecycle rule until this Part A routing lands.
- Archive-class (`GLACIER`-style) writes and the opt-in lossy "storage saver" transcode (#426).
- Migration sweep for derivatives replicated to `cas` before a `derived` grant existed: on the next drain/reconcile they re-upload to `derived` and re-stamp the replica row, but the superseded cas copy lingers (live sha ⇒ orphan sweep skips it). Cost-only, pre-release; a follow-up sweep can reclaim it.
- Cross-store read fallback for the un-granting edge (provider stops advertising `derived` after granting it): derived-store replica rows become unverifiable and reads fall back to cas (404 ⇒ derivative regenerates). Unusual transition, derivatives are regenerable; noted for a follow-up safety net.
- UI for `supportedStorageClasses` on BYO-S3 targets (field exists in settings; no declaration ⇒ heuristic off).

## Decisions

- **Presign door carries the class on the CopyObject, not the presigned PUT.** Presigned URLs sign only `host` (by design — the device cannot be trusted to send arbitrary signed headers), and every direct/streaming upload lands in a temp key promoted via `copyTemporaryToSha`. The CopyObject is the object-creating call, so the class rides there — satisfying the issue's intent (the object is IA from birth; no Standard window).
- **`originalHint` on `RemoteTier.storageClassFor`.** On remote-primary doors the staging row is written after the promote, so a sha-only DB lookup at promote time resolves nothing — the heuristic would have been inert for exactly its target population (large streamed media). Each door passes `{ mediaType, byteSize }` computed pre-promote; the DB lookup still wins on the local-first path.
- **Store-class resolution at drain time by sha lookup, not an outbox column.** `core_content_derivative`/`blob_staging` rows exist before `recordLocalReceipt`, so the lookup is race-safe and avoids schema churn on `blob_outbox`. The dedup edge (sha both original and derivative) resolves to `cas` — original custody wins; `derived` is an optimization.
- **`blob_replica.store` records where bytes actually landed** (ground truth for reads/reconciliation), defaulting `'cas'` — pre-release, existing dev vaults are recreated per the repo's v0 policy, not migrated.
- **Derived store has no multipart transfer machinery**: binary derivatives are ≤ ~16 MiB by construction; a hypothetical >32 MiB derived-destined row falls back to `cas` rather than duplicating transfer plumbing.
- **Derived reconciliation folds into the cas `StoreReconciliationState`** (per-store diff/unmark/heal are fully implemented; a separate top-level state field would churn every consumer for no safety gain), and the derived pass is presence-diff only — the AEAD re-audit stays scoped to `cas`, whose machinery it addresses.
- **Explicit vault-level `storageClass` suppresses the heuristic** — the user's explicit choice wins; the heuristic fills in only when unset. Empty/whitespace `storageClass` normalizes to unset so both layers agree.
- **Stills (`image/*`) excluded from the v0 MIME default** — conservative: large stills are plausible browse targets; video/audio are the populations with pinned-poster/preview UX cover.

## Verification

```sh
bun install
bun run ci                 # format:check + oxlint + turbo lint + typecheck + lint:types — PASS
bun run test --filter=@centraid/backup --filter=@centraid/vault --filter=@centraid/gateway   # PASS
cd packages/backup && bunx vitest run    # 277+ passed (incl. conformance-derived against local+remote reference providers)
cd packages/vault  && bunx vitest run    # 744 passed, 1 skipped (incl. store-routing + direct-cold-originals suites)
git diff --check
bash .governance/run.sh
```

Routing acceptance: `store-routing.test.ts` replicates originals + thumb/preview/poster against a fake S3 with a derived prefix — every derivative object lands under the derived prefix, no derivative object under the cas prefix, originals under cas; with no derived prefix, behavior is unchanged. Heuristic acceptance: `direct-cold-originals.test.ts` captures the signed `x-amz-storage-class` header per request across the outbox PUT, multipart-create, streaming CopyObject-promote, and direct-upload doors; negative matrix (small original, derivative, non-media, undeclared target, explicit class) sends no `STANDARD_IA` header.

## Audit

PASS

- **"'## What changed' faithfully describes the diff (no misrepresentation, no omission)" — PASS.** The receipt's "Changed paths" list (45 entries) matches the actual working-tree diff exactly: all 38 modified files and all 7 new files are represented 1:1 with no extras and no omissions; the prose narrative (Part A protocol/routing, Part B heuristic) matches the spot-checked code.
- **"each '- [x]' item is realized in the diff" — PASS.** Spot-verified against actual diff content: `StoreClass` grows `'derived'` + `STORE_CLASSES` in `provider.ts`; `blob_replica.store` column with `CHECK (store IN ('cas','derived'))` and `ReplicaIndex.mark/storeOf/all(store)` genuinely read/write it; per-call storage-class override end-to-end (`store.ts`/`s3.ts` `classOf()`, `db.ts` `RemoteTier.storageClassFor`); `BackupPolicy.directToColdOriginals` validated, empty-string `storageClass` normalizes to unset; discovery `storageClasses` stamped into settings at attach and consumed by `storageClassForShaWrite`; `store-routing.ts` implements `desiredStoreForSha` (dedup edge → cas) and `resolveWriteStore` (graceful degradation + 32 MiB derived cap); `conformance-derived.ts` cases are capability-gated and spliced into `providerConformanceCases`, which the untouched interop suite consumes — so the derived cases automatically join interop once the provider advertises the capability.
- **"the '## Checklist' mirrors the issue's checklist" — PASS.** Both the issue and the receipt have exactly 18 checklist items with byte-identical wording; the single unchecked item (Clawgnition interop) matches verbatim and the receipt's justification is corroborated by the interop test's own `CLAWGNITION_INTEROP !== '1'` skip logic.

## Steering

PASS

- **Check 1 (every steering event recorded):** The session transcript contains zero steering events (the sole human message was the initial task request, which is not a mid-task correction or interrupt), so zero rows are required in the `### Steering` table under `## Accounting` — and the table is indeed empty (header only, no data rows), satisfying this check.
- **Check 2 (no non-steering message recorded as steering):** The `### Steering` table has no rows at all, so no ordinary task message, tool denial, or automated background-task notification (all of which were explicitly marked NOT-user-input) has been mis-recorded as a steering event, satisfying this check.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | session | issue | input | output | commit | timestamp |
| --- | --- | --- | --- | --- | --- | --- |
| claude-code-14f54cfd-06c-1784207007-1 | claude-code | 14f54cfd-06c3-47d7-97ca-9c03b2db41d4 | #425 | claude-fable-5 | 279 | 492278 | 17052184 | 213596 | 706153 | 33.8882 | 279 | 492278 | 17052184 | 213596 | feat(backup): add derived store class and storage-class discovery (#425) |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
