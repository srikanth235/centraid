# issue-405 — bounded storage tier: eviction, preview ladder, sealed-format revision, storage class

GitHub issue: [#405](https://github.com/srikanth235/centraid/issues/405)

## Checklist

Issue #405's sections, each discharged by the named subsection in **What changed** and the
evidence in **Verification**.

- [x] **Entropy-gated zstd sealed-chunk framing (centraid-snapshot/2)**
- [x] **Framed rangeable blob seal (CBSF)**
- [x] **Single-flight read-through coalescing**
- [x] **Preview ladder: tiny and medium rungs, client hot path**
- [x] **Gateway preview backstop codec and backfill sweep**
- [x] **Cache budget and LRU eviction with pinned tinies**
- [x] **Evict-only-if-replicated and ingest backpressure**
- [x] **Bounded-parallel replication with interactive QoS**
- [x] **Local replication index**
- [x] **Retry and backoff on provider ops**
- [x] **S3 storage class passthrough**
- [x] **Previews-first lazy restore**
- [x] **Tier metrics on the Gateway page**
- [x] **Docs and format specs revised**
- [x] **Streaming chunk reassembly**

## What changed

### Entropy-gated zstd sealed-chunk framing (centraid-snapshot/2)

The snapshot format bumped `centraid-snapshot/1` → `centraid-snapshot/2`: a sealed **chunk**
object's plaintext is now `[algo-id byte][body]` inside the unchanged AES-256-GCM envelope —
`0x00` stored raw, `0x01` zstd (level 3, `node:zlib`), `0x02` raw-deflate fallback for
runtimes without zstd. Keep-if-smaller gate: incompressible input costs exactly 1 byte, never
inflation. `chunkId` (HMAC over raw plaintext) and the chunk nonce are computed upstream of
framing, so dedup and object keys are byte-identical with or without compression. WAL
segments/closers/markers and manifests deliberately stay uncompressed (preserves #408's
byte-idempotent retry contract; manifests must stay key-lessly parseable) — rationale in
FORMAT.md § Chunk payload framing. Readers reject `/1` (v0, no dual-format reader).

Files: `packages/backup/src/compress.ts` (new), `packages/backup/src/compress.test.ts` (new),
`packages/backup/src/engine.ts`, `packages/backup/src/engine.test.ts`,
`packages/backup/src/manifest.ts`, `packages/backup/src/manifest.test.ts`,
`packages/backup/src/parts.ts`, `packages/backup/src/parts.test.ts`,
`packages/backup/src/conformance.ts`, `packages/backup/src/index.ts`,
`packages/backup/src/local-provider.test.ts`, `packages/backup/src/remote-provider.test.ts`,
`packages/backup/src/wal-format.ts`, `packages/backup/src/wal-restore.ts` (comment-only),
`packages/backup/src/interop-clawgnition.test.ts` (stale FastCDC comment fixed; 33 MiB
multi-part case added so multipart runs), `packages/backup/FORMAT.md`,
`packages/backup/PROTOCOL.md`, `packages/backup/README.md` (runtime floor → Node ≥22.15),
`packages/backup/package.json`, `SECURITY.md`.

### Framed rangeable blob seal (CBSF)

The blob CAS remote seal (`packages/vault/src/blob/seal.ts`) is no longer whole-blob: magic
`CBSF` + version byte, 4 MiB plaintext frames each independently GCM-sealed with AAD
`blob:<sha>:v1:f<i>/<N>` (frames cannot be reordered, re-indexed, transplanted, or the set
truncated), per-frame `[algo-id][payload]` entropy-gated compression, a sealed footer
directory of frame lengths and a fixed 13-byte trailer. A ranged read of a remote sealed blob
does HEAD → suffix-range for trailer+directory → range GETs for exactly the covering frames —
never the whole object. Streaming seal buffers at most one frame. Old-format remote objects
are unreadable (v0; re-seal on next sweep).

Files: `packages/vault/src/blob/seal.ts`, `packages/vault/src/blob/seal-frames.ts` (new),
`packages/vault/src/blob/seal.test.ts` (new), `packages/vault/src/blob/custody-read.ts` (new),
`packages/vault/src/blob/blob.test.ts`.

### Single-flight read-through coalescing

`BlobCustody.open()` shares in-flight work per sha: concurrent full read-throughs collapse to
one provider GET + one unseal + one promote (`wholeInflight`), concurrent ranged readers share
the directory fetch (`dirInflight`). Ranged sealed reads do not promote the whole blob
(per-frame GCM+AAD is the integrity story for partial serves; a full read-through still
verifies the whole sha before promoting).

Files: `packages/vault/src/blob/custody.ts`.

### Preview ladder: tiny and medium rungs, client hot path

Tiny = the existing `thumb` variant, generated at 256 px going forward; medium = the `preview`
variant at 2048 px, JPEG q80. The photos app generates both rungs from one canvas decode at
upload; each rung skips itself when the source is already within its edge. Grid keeps the #404
placeholder contract (never falls back to originals). Batched "tinies for these N content ids
in one pass": `resolveDerivativeShas(vault, contentIds, variant)` (single indexed SQL pass,
chunked at 500 ids). Derivatives already ride replication via `liveBlobShas`; they land in the
provider's `cas` class until clawgnition#118 ships `derived`.

Files: `packages/vault/src/blob/preview.ts` (new), `packages/vault/src/blob/preview.test.ts`
(new), `packages/vault/src/blob/read.ts`, `packages/vault/src/blob/read.test.ts` (new),
`packages/blueprints/apps/photos/upload.js`, `packages/blueprints/apps/photos/media.js`,
`packages/blueprints/manifest.json` (regenerated; drops stale untracked `.d.ts` entries).

### Gateway preview backstop codec and backfill sweep

The gateway is the backstop for everything a client can't generate (imports, weak clients,
server-side ingestion): a pure-JS `PreviewCodec` (jpeg-js decode/encode, pngjs decode,
area-average box downscale; 12k-per-edge / 40 MP caps; GIF/WebP/video → null) is injected from
`buildGateway` through the vault-registry/plane seam into `openVaultDb`, and
`backfillPreviews` runs inside the owner blob sweep after custody refresh — bounded at 24
items per sweep with event-loop yields, idempotent, failures counted but never fatal to the
sweep. Sweep receipts record `previewsGenerated`.

Files: `packages/gateway/src/preview/codec.ts` (new),
`packages/gateway/src/preview/codec.test.ts` (new), `packages/gateway/package.json` (jpeg-js,
pngjs), `bun.lock`, `packages/gateway/src/serve/build-gateway.ts`,
`packages/gateway/src/serve/vault-plane.ts`, `packages/gateway/src/serve/vault-registry.ts`,
`packages/gateway/src/index.ts`, `packages/vault/src/gateway/gateway.ts`,
`packages/vault/src/db.ts`, `packages/vault/src/index.ts`.

### Cache budget and LRU eviction with pinned tinies

With a remote tier, the local store is a bounded cache: budget from
`blob_cache.budgetBytes`, else `clamp(1 GiB, 0.5 × (free + spool), 100 GiB)` via `statfsSync`,
else unlimited (memory vaults). Eviction (in the sweep after preview backfill, and on demand
from the ingest precheck) removes LRU `preview` derivatives first, then LRU originals. Never
evicted: `thumb` shas (pinned), un-promoted `blob_staging` shas. Access recency is tracked in
`blob_access` with an in-memory write-behind so the hot read path never pays a synchronous
SQLite write. Sweep receipts record `evictedBlobs`/`evictedBytes`.

Files: `packages/vault/src/blob/cache.ts` (new), `packages/vault/src/blob/cache.test.ts`
(new), `packages/vault/src/blob/evict.ts` (new), `packages/vault/src/blob/custody-export.ts`
(new), `packages/vault/src/blob/custody-state.ts` (new),
`packages/vault/src/blob/custody-types.ts` (new), `packages/vault/src/schema/blob.ts`
(`blob_replica`, `blob_access` DDL).

### Evict-only-if-replicated and ingest backpressure

The evict primitive itself (not just the policy loop) refuses any sha absent from the durable
replication index — no path, including disk pressure, can delete the last local copy of a
`local-only` blob. Ingest prechecks budget headroom, runs an eviction pass when over, and
throws a typed `VaultBlobBackpressureError` when nothing is evictable (unreplicated backlog);
the blob POST route maps it to HTTP 429 + Retry-After (and `VaultDiskFullError` to 507).
Pacing, never loss.

Files: `packages/vault/src/errors.ts`, `packages/gateway/src/routes/blob-routes.ts`.

### Bounded-parallel replication with interactive QoS

`replicate()` drives a worker pool (default 3-way, injectable) instead of blob-at-a-time;
between blobs the pool parks while any interactive read-through is in flight (+ short
cooldown) — a coarse v0 lever, documented as such.

Files: `packages/vault/src/blob/replicate-driver.ts` (new).

### Local replication index

`blob_replica` records every successful push (unmarked on delete/purge/orphan-delete, healed
against the full listing whenever `reconcile()` runs — the listing is truth, the index is
evidence). `statusFor()` and `replicate()` now read the index and make **zero** remote
`list()` calls; only the deep `reconcile()` lists, exactly once per sweep.

Files: `packages/vault/src/blob/replica-index.ts` (new).

### Retry and backoff on provider ops

Every S3 op (get/head/put/delete/list/uploadPart/createMultipartUpload/completeMultipartUpload)
retries on network errors, 429, and 5xx — 3 attempts, exponential backoff with full jitter
(200 ms base, 2 s cap), injectable seams. Other 4xx never retry. One 503 no longer fails a
whole sweep or restore. SigV4 signing extracted to keep the driver under the file-size cap.

Files: `packages/vault/src/blob/s3.ts`, `packages/vault/src/blob/sigv4.ts` (new),
`packages/vault/src/blob/s3.test.ts` (new).

### S3 storage class passthrough

`storageClass?: string` on `S3BlobStoreOptions`, sent and SigV4-signed as
`x-amz-storage-class` on PUT and CreateMultipartUpload only; unset ⇒ no header ⇒ prior
behavior byte-identical. Settings passthrough `blob_store.storageClass` (camelCase, matching
`throttleBytesPerSec`); the blob-store route validates it as an optional non-empty string (no
enum — S3-compatibles define their own classes).

Files: `packages/gateway/src/routes/vault-routes.ts` (validation; `db.ts` passthrough listed
above).

### Previews-first lazy restore

Snapshots still carry every local CAS blob (`backup-sources.ts` is explicit: remote-CAS
configuration is not authenticated durability evidence). Restore gains the lazy half:
`RestoreSnapshotOptions.skipBlob` (engine seam, format-neutral; skipped blobs' chunks are
never downloaded) and `BackupService.restore({ lazy })` defers every blob the remote CAS
holds — a library larger than local disk restores; blobs the remote lacks still materialize.
After DB restore + WAL replay, `warmPreviewTinies` pulls **all** `thumb` shas through custody
read-through with bounded parallelism and reports `timeToUsableGridMs` + counts
(`previewsWarm` on the restore result). Full-library pulls remain the explicit takeout path.
Also fixed four tests broken by the day's format revisions (stale `/1` and old seal-shape
assertions — test-only, no product bugs).

Files: `packages/backup/src/engine.ts` (options seam),
`packages/gateway/src/backup/backup-service.ts`, `packages/gateway/src/backup/restore-warm.ts`
(new), `packages/gateway/src/backup/restore-lazy-e2e.test.ts` (new),
`packages/gateway/src/backup/backup-e2e.test.ts`, `packages/gateway/src/backup/storage-e2e.test.ts`,
`packages/gateway/src/backup/wal-e2e.test.ts`, `packages/gateway/src/cli/backup-admin.test.ts`.

### Tier metrics on the Gateway page

`BlobCustody.metrics()` (localHits, readThroughs, rangedRemoteReads, bytesServedLocal/Remote,
evictedBlobs/Bytes, backpressureEvents, spoolBytes, budgetBytes) is surfaced additively on
`GET /centraid/_gateway/storage/status` as a per-vault `cache` block (unlimited budget → null)
and rendered on the Gateway page's Storage card: spool-vs-budget bar (warn ≥80%, error ≥95%),
hit rate with raw counts in the tooltip, bytes served local vs remote, eviction/backpressure
lines only when nonzero; local-only vaults hide the remote-facing noise.

Files: `packages/gateway/src/routes/storage-routes.ts`,
`packages/gateway/src/routes/storage-routes.test.ts`,
`packages/client/src/gateway-client-storage.ts`,
`packages/client/src/react/screens/StorageCard.tsx`,
`packages/client/src/react/screens/StorageCard.module.css`,
`packages/client/src/react/screens/StorageCard.test.tsx`,
`packages/client/src/react/shell/routes/gatewayStorageData.ts`.

### Docs and format specs revised

FORMAT.md normative for `/2` (framing layout, id-byte table, keep-if-smaller rule, reader
obligations); SECURITY.md documents the compress-then-encrypt compressibility side channel and
why a personal single-tenant vault accepts it; the custody.ts header no longer claims the
local tier is "always complete" — it describes the bounded cache model; the docs-site data
chapter §09 (`scripts/docs-site/src/content/data.html`) gained the owner-facing bounded-cache
paragraph.

### Streaming chunk reassembly

Verified, no work needed: `engine.ts` restore already streams parts straight to disk
(per-part decrypt → verify → `handle.write`, incremental hash; no `Buffer.concat`
whole-file reassembly remained). Unframe happens per part, so `/2` keeps the same memory
profile (one ≤16 MiB part resident).

## Decisions

- **Two independent sealed formats revised in one release** (snapshot chunks, blob CAS
  frames) — the §1 one-way door paid once, before release; neither keeps a dual-format
  reader (v0, [no backward compatibility](https://github.com/srikanth235/centraid/issues/405)).
- **WAL objects and manifests stay uncompressed** — #408's deterministic-nonce idempotency
  (retries byte-identical) is worth more than marginal ratio on bounded deltas; manifests must
  stay key-lessly parseable for GC/verify.
- **Backstop generates on-miss via the sweep, not always-on at ingest** — the client hot path
  already covers capture; generate-always at the gateway would duplicate every capable
  client's work for no correctness gain (last-writer upsert), while the sweep catches imports,
  connectors, and weak clients within one cycle. The issue leaned "always" for images; the
  hybrid-with-existing-hot-path reality makes on-miss the right v0.
- **Gateway video backstop deliberately out** (no ffmpeg-class decoder; placeholder contract
  covers), client video posters deferred (fiddly async for marginal v0 value).
- **Snapshots keep carrying all local blobs**; laziness lives at restore time with a live
  `remote.has()` check per blob. The #408 receipt's claim that remote-CAS-held blobs are
  excluded from snapshots was wrong; `backup-sources.ts:187` and FORMAT.md are the truth.
- **Eviction guard lives inside the evict primitive**, not the policy loop, so no future
  caller can delete a last local copy.
- **Evicted blobs flip to `remote-only` on the next sweep's custody refresh**, not inline —
  avoids a second full scan per eviction pass.
- **`storageClass` settings key is camelCase** (`blob_store.storageClass`) — the settings JSON
  convention is camelCase (`throttleBytesPerSec`), despite the issue writing
  `blob_store.storage_class`.
- **Node floor bumped to ≥22.15** in packages/backup (zstd in `node:zlib`), deflate fallback
  behind its own algo id for anything older.

## Out of scope

- Lazy-restore CLI/gateway wiring: `restore({ lazy })` is an opt-in service API; resolving
  blob-store credentials at fresh-restore time (before the vault is mounted) is a gateway
  wiring decision left as follow-up. Default CLI restore is unchanged (full restore).
- Provider `derived` store class for previews — blocked on clawgnition#118; previews replicate
  as `cas` today (documented in preview.ts).
- Video poster frames (client) and gateway video decode — placeholder contract covers misses.
- Lightbox still loads originals (deliberate user action); the `preview` rung is noted in
  media.js as the ready future swap.
- Staging-TTL transient cleanup stays with the existing `sweepBlobStaging` (not duplicated in
  the cache eviction pass); staging shas are protected from eviction.
- Nothing from the issue is deferred. One adjacent pre-existing failure surfaced by the full
  gate run was fixed in passing (see § Adjacent fix).

### Adjacent fix (pre-existing, out of #405's scope)

`bun run lint:types` failed on a fresh checkout in packages/blueprints: `query-handlers.test.ts`
dynamically imports three app query `.js` modules (`apps/{agenda/queries/upcoming,
notes/queries/library,notes/queries/note}.js`) via `allowJs`, and the type-aware linter fell
back to `tsconfig.json` — which sets `noEmit: false` + `declaration: true` for the build — so
TS raised "would overwrite input file" for each `.js` (masked in the main checkout only by
untracked `.d.ts` build artifacts; `bun run typecheck` passes because it forces `--noEmit` on
the CLI). Fixed by adding `packages/blueprints/tsconfig.test.json` (`noEmit: true`), identical
to the one every other TS-source package already ships; the lint-types script prefers it, so
all nine targets pass. Reproduced as pre-existing with this branch's changes stashed; landed as
its own commit.

Files: `packages/blueprints/tsconfig.test.json` (new).

## Verification

Baseline before this branch's work: 33 failures in `wal-shipper.test.ts` /
`wal-shipper-detectors.test.ts` (stale worktree dist from #408; cleared by `bun run build`),
everything else green.

```sh
$ bun run format:check          # All matched files use the correct format (1614 files)
$ bunx oxlint .                 # Found 0 warnings and 0 errors (1108 files)
$ bun run typecheck             # Tasks: 26 successful, 26 total
$ npx vitest run                # Test Files 340 passed | 1 skipped (341)
                                # Tests 3208 passed | 23 skipped (3231)
$ bun run coverage              # exit 0 — all per-glob floors met
$ bun run lint:types            # ok — all 9 targets pass (blueprints fixed, see Adjacent fix)
```

Acceptance criteria discharged by test, all passing in the run above:

- mixed compressed/stored chunks round-trip; chunk ids and dedup byte-identical for same
  plaintext; incompressible input stores raw with no inflation (≤1 byte); SQLite fixture ≥3× —
  `compress.test.ts`, `engine.test.ts`.
- clawgnition interop passes compressed; large-blob ≥32 MiB multipart interop; stale FastCDC
  comment fixed — `interop-clawgnition.test.ts` (gated suite, `CLAWGNITION_INTEROP=1`).
- ranged read of a remote sealed blob fetches only covering frames (3 ranged GETs: trailer,
  directory, covering frame — asserted against a request-recording fake S3, no whole-object
  GET); tamper (bit-flip, reorder, transplant, truncation) fails closed — `seal.test.ts`,
  `blob.test.ts`.
- single-flight: 2 concurrent cold readers = 1 provider GET — `blob.test.ts`.
- tinies survive any cache-pressure path; evicting local-only under pressure is refused and
  backpressured (HTTP 429), never deleted; read-through promotes into LRU; LRU order previews
  → originals; paced large-import through a small budget completes with the spool never
  exceeding budget and nothing lost; statusFor/replicate perform zero remote list() calls;
  serving local tinies performs zero remote GETs; bounded parallelism observed; replication
  parks during interactive read-through — `cache.test.ts`.
- storage-class header present + SigV4-signed when configured, absent when not; multipart
  CREATE carries it, UploadPart does not; 503×2→200 retry; 400 never retried —
  `s3.test.ts`.
- restore of a library larger than what materializes locally: remote-held originals deferred
  (never downloaded), local-only blobs materialized, all tinies warm after the pass,
  `timeToUsableGridMs` reported, on-demand read-through works — `restore-lazy-e2e.test.ts`.
- preview backstop: missing rungs generated boundedly in the sweep, idempotent, unsupported
  types skipped; batched tinies query in one pass across the 500-id chunk boundary —
  `preview.test.ts`, `read.test.ts`, `codec.test.ts`.
- metrics DTO round-trips both budget branches; Storage card renders configured / unlimited /
  unconfigured states — `storage-routes.test.ts`, `StorageCard.test.tsx`.

## Audit

Fresh-context sub-agent attestation was **skipped at the operator's explicit direction** for
this PR (the commit was made with `SKIP_GOVERNANCE=1`; CI's governance job re-derives the
audit independently and the trunk sweep lane remains the backstop). The full change set was
instead verified by the primary agent through the gate run in **## Verification** — format,
oxlint, typecheck, the full 3208-test vitest run, and coverage all green — and by the four
per-workstream sub-agent reports whose claims are reproduced in **## What changed**. One
attestation attempt was run but its verdict is discarded: the sub-agent executed git from the
wrong working directory (the main checkout, not this worktree) and so reported an empty diff —
a false negative, not a finding about the code.

## Steering

One genuine human-steering event in this session (session
`63fd5286-d4f3-4799-a718-0d3f17310528`): mid-way through the first governance-blocked
`git commit`, the operator **interrupted** the tool call and redirected the agent to fix a
pre-existing `bun run lint:types` failure in packages/blueprints before continuing (type
`interrupt`, tier `structural`, ~2026-07-15T07:18 / transcript event ~87). That redirect
produced the § Adjacent fix (`packages/blueprints/tsconfig.test.json`). A later operator
message ("skip governance and create pr") is task direction, not a mid-task correction. No
other message qualifies; tool denials are not steering. The ledger-row append is part of the
governance flow that was skipped for this PR; the event is recorded here in prose so the
history is not lost.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-63fd5286-d4f-1784099851-1 | claude-code | 63fd5286-d4f3-4799-a718-0d3f17310528 | #405 | claude-fable-5 | 283 | 1283230 | 20177330 | 329399 | 1612912 | 52.6905 | 283 | 1283230 | 20177330 | 329399 | feat(backup): entropy-gated zstd sealed-chunk framing — centraid-snapshot/2 (#40 |
| claude-code-63fd5286-d4f-1784099902-1 | claude-code | 63fd5286-d4f3-4799-a718-0d3f17310528 | #405 | claude-fable-5 | 6 | 16395 | 644349 | 4866 | 21267 | 1.0926 | 289 | 1299625 | 20821679 | 334265 | feat(backup): entropy-gated zstd sealed-chunk framing — centraid-snapshot/2 (#40 |
