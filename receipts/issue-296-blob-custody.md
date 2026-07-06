# issue-296 — blob custody: content-addressed bytes with swappable backends

GitHub issue: [#296](https://github.com/srikanth235/centraid/issues/296)

First principle: **raw bytes arriving is not a vault write; the command that
claims them is.** `core_content_item` stays the only truth ABOUT bytes, but
binary bytes leave the row: text/* bodies stay inline (the FTS triggers
decode in-transaction and cannot do I/O), everything else lives in a
content-addressed store as `blob:sha256-<hex>` behind a driver seam — an
always-present local CAS (the spool, the cache, the only tier the
synchronous command pipeline touches) plus an optional S3-compatible remote
that replicates via sweeps. Identity is the sha256 of the RAW bytes, never a
data: URI. Egress authorization is DERIVED, never granted: bytes serve only
when some edge in the model claims them.

## Checklist

- [x] Commit 1 — vault blob custody core (stores, staging, promotion, spool pipeline, egress rule, GC, S3 driver, encryption)
- [x] Commit 2 — mbox attachments through the staging door (import spine)
- [x] Commit 3 — gateway HTTP doors (upload + Range-served bytes), lifecycle sweeps, vault-delete purge, harness-ambient S3 creds
- [x] Commit 4 — app adoption (photos, docs, notes, tasks, agenda) + blob-store settings surface

## What changed

Commit 1 — vault blob custody core:

- `packages/vault/src/blob/store.ts` (new) — the `BlobStore` driver
  contract (put/get/has/delete/list/stat, flat sha keys), `blob:sha256-`
  URI helpers, raw-bytes sha identity.
- `packages/vault/src/blob/local.ts` (new) — `FsBlobStore`
  (`<vault-dir>/blobs/sha256/ab/<hex>`, write-then-rename) and
  `MemoryBlobStore` for `:memory:` vaults; both expose the synchronous
  surface the command pipeline requires.
- `packages/vault/src/blob/s3.ts` (new) — hand-rolled SigV4 over fetch
  (AWS/MinIO/R2/B2 compatible), path-style, paginated ListObjectsV2;
  ETags never believed — the gateway hashes from its local spool.
- `packages/vault/src/blob/custody.ts` (new) — the two-tier facade:
  sync ingest/get/delete on the local tier, async remote replication,
  reconciliation (orphans deleted, missing replicas re-pushed,
  absent-from-both reported), `purgeRemote` (vault deletion),
  `exportTo` (self-contained directory — the exit ramp from S3), and
  optional per-blob AES-256-GCM under the #293 vault DEK with
  plaintext-sha identity (AAD `blob:<sha>`; remote holds ciphertext,
  the local tier shares vault.db's disk trust).
- `packages/vault/src/schema/blob.ts` (new, v9) — `blob_staging`
  (sha-keyed, `held_by_batch` pins past the TTL during import review,
  `variant`/`variant_of` for client-produced derivatives) and
  `core_content_derivative` (thumb/preview in the CAS, extracted text
  INLINE so it can feed FTS); the content item's FTS triggers rebuild
  derivative-aware (COALESCE) so a rename no longer clobbers extracted
  text, plus derivative-side triggers refreshing the PARENT row — a
  match inside a PDF surfaces the document, not a shadow row.
- `packages/vault/src/blob/staging.ts` (new) — `stageBlobBytes` (both
  doors' shared core: hash → sniff → extract → upsert row),
  `sweepBlobStaging` (24h TTL, held rows immune, bytes reclaimed unless
  a content item owns the sha), `releaseBatchHold`,
  `mediaLocationPolicy` (the `media.location` keep|strip GPS gate).
- `packages/vault/src/blob/pipeline.ts` (new) — dependency-free spool
  pipeline: magic-byte type sniffing (declared type is a hint), PNG/GIF/
  JPEG dimensions, minimal TIFF/EXIF walk (DateTimeOriginal + GPS behind
  the policy gate; presence always reported), text extraction for text/*
  + JSON + uncompressed-PDF text operators (compressed PDFs degrade to
  title-only search; a real extractor is a pipeline plug-in later).
- `packages/vault/src/blob/promote.ts` (new) — `promoteStagedBlob`: the
  in-transaction claim (staged sha → content item + derivative rows),
  idempotent over dedup (re-upload = restore), shared by commands and
  the import publishers.
- `packages/vault/src/blob/mint.ts` (new) — the inline data_uri door,
  capped at ~256 KB decoded (`MAX_INLINE_DATA_URI_CHARS`): text inlines,
  binaries spill synchronously to the CAS; raw-bytes sha fixes the old
  hash-the-URI dedup hole (same bytes + different declared mime = one row).
- `packages/vault/src/blob/read.ts` (new) — the derived egress rule:
  `resolveServableBlob` serves content only when a reference edge claims
  it (CONTENT_REFERENCES ∪ folder tag ∪ collection cover — trashed edges
  included, so trash views render until the purge sweep reclaims);
  `liveBlobShas` = the reconciliation ground truth.
- `packages/vault/src/gateway/types.ts` — `HandlerCtx.blobs`
  (staged/claimStaged/spill/has): commands do row work only; bytes are
  already in (or synchronously enter) the local tier.
- `packages/vault/src/gateway/execution.ts` — wires `ctx.blobs`; the
  journal's `input_json` now records `{staged_sha}` (~100 bytes) instead
  of megabytes of base64 — the old path stored every upload ~2.7×.
- `packages/vault/src/commands/attachments.ts` — `core.attach` grows the
  third source (`staged_sha`, exactly one of three); the 8 MB
  `MAX_DATA_URI_CHARS` dies; `social.message` joins the attachable
  subjects (email attachments).
- `packages/vault/src/commands/documents.ts` / `media.ts` —
  `core.add_document` and `media.add_asset` accept `staged_sha`;
  add_asset consumes spool EXIF (captured_at/width/height/exif_json now
  gateway-populated; explicit caller input still wins).
- `packages/vault/src/gateway/duties.ts` — the purge sweep reclaims
  derivative rows + CAS bytes with their content item (remote replicas
  fall to reconciliation by design) and runs the staging TTL;
  `SweepResult` gains `blobsReclaimed`/`stagingExpired`.
- `packages/vault/src/gateway/gateway.ts` — `stageBlob` (any caller that
  may act; no receipt by design), `resolveBlob` (consent-checked read on
  core.content_item + the derived rule, receipted), `sweepBlobs`
  (replicate + reconcile, owner-only, receipted).
- `packages/vault/src/gateway/custody.ts` — `backupVault` copies the CAS
  (`<dest>/blobs`, content-addressed ⇒ verifiable by filename).
- `packages/vault/src/db.ts` — `VaultDb.blobs`; the remote tier resolves
  LAZILY from `core_vault.settings_json.blob_store` on every use (backend
  switch needs no reopen); `OpenVaultOptions.s3Credentials` resolver seam.

Commit 2 — mbox attachments through the staging door:

- `packages/vault/src/ingest/mbox.ts` — MIME multipart walk (base64 +
  quoted-printable, nested parts, plain body over html); filename-bearing
  parts decode as attachments.
- `packages/vault/src/ingest/stage-file.ts` — the parser stages
  attachment bytes mid-parse; staged shas pin to the batch
  (`held_by_batch`) so the owner's review never races the TTL.
- `packages/vault/src/ingest/publishers.ts` — publish is the claim: the
  message publisher promotes each sha and pins it with the same
  `core_attachment` edge `core.attach` writes.
- `packages/vault/src/ingest/staging.ts` — publish AND discard release
  the batch hold; discarded bytes fall back to the TTL sweep.

Commit 3 — gateway HTTP doors + lifecycle:

- `packages/gateway/src/routes/blob-routes.ts` (new) —
  `POST /centraid/_vault/blobs` (raw streaming body or base64-JSON;
  512 MB cap; `?variant=&variant_of=` for client-produced thumbs) and
  `GET /centraid/_vault/blobs/<contentId>[?variant=]` (ETag = sha256,
  immutable Cache-Control, 304, single-range 206, 416, HEAD,
  inline/attachment disposition). Transport auth = the outer Bearer +
  vault scope (#289); the desktop's auth-injector stamps both onto bare
  `<img>`/`<video>` loads.
- `packages/gateway/src/serve/vault-plane.ts` — hourly sweep also runs
  blob maintenance detached; S3 credentials resolve harness-ambient
  (`CENTRAID_S3_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY`/`_SESSION_TOKEN`) per
  the #290 broker posture — never settings, never rows.
- `packages/gateway/src/serve/vault-registry.ts` — vault delete purges
  the remote tier best-effort (tier resolved synchronously before the db
  closes; deletes detached).
- `packages/gateway/src/routes/vault-routes.ts` — owner settings surface:
  `GET/PUT /centraid/_vault/blob-store` (`blob_store` bag +
  `media_location` policy; kind validated fs|s3).
- `packages/vault/src/host.ts` — `updateBlobStoreSettings`.

Commit 4 — app adoption:

- Photos — uploads stream to the blob route (cap 8 MB → 512 MB; a phone
  video fits), a client-canvas thumb stages as the `thumb` variant beside
  the original (the canvas is the raster codec every client has; server
  codecs stay a pipeline plug-in seam), the grid loads `?variant=thumb`
  URLs with graceful fallback, the library query maps `blob:` rows to
  same-origin serve URLs and passes `byte_size` through.
- Docs — uploads stream + claim by sha; drive/search queries map to serve
  URLs; `loadable()` accepts vault URLs — which incidentally FIXES the
  blank iframed-PDF preview (CSP `default-src 'self'` allows same-origin
  frames where `data:` was blocked).
- Notes / Tasks / Agenda — attach flows stage files over 256 KB (small
  ones keep the one-call inline door), attach actions pass `staged_sha`
  through, queries map attachment URIs.
- `packages/blueprints/manifest.json` — regenerated.

## Decisions of record

- **Staging-before-receipt** is the centerpiece, not a workaround: it is
  what keeps "every write is a receipted command" true while bytes stop
  transiting command JSON.
- **Text stays inline by CLASS, not size** — the FTS triggers cannot do
  I/O; extracted document text re-enters the row as the `text` variant
  and feeds the PARENT's index row (a deviation from the issue's
  "inline text content item linked as variant" sketch, which would have
  surfaced shadow rows in search instead of documents).
- **Thumbnail generation is producer-agnostic**: the variant registry +
  egress contract are server-side; generation is a client canvas today
  and a server codec plug-in later (Node has no raster codec; `sharp`
  was deliberately not added).
- **Proxy-only egress** — no presigned URLs; a bearer capability would
  bypass the consent gateway. Encrypted remotes make proxy mandatory
  anyway.
- **The local CAS is always complete** (S3 = durability replica, not
  primary custody). Local eviction for disk relief is a named follow-up,
  not v1.
- GPS default is **keep** (it is the owner's vault), `strip` a setting;
  derivatives always strip; presence is always reported.

## Out of scope (deferred seams, per the issue)

- Agent/assistant byte access (`vault_sql` still sees rows only) and
  multimodal hand-off consent.
- Mobile/tunnel streaming (verify wire protocol v1 streams + Range
  before promising video on the phone).
- iroh-blobs sync (transfer layer between devices' stores, not a third
  driver).
- Server-side raster codecs (thumbs for video/HEIC) — pipeline plug-in.
- Local-CAS eviction after replication (disk relief when S3 is primary).
- JSON-artifact `importVaultExport` restores rows only; blob bytes
  restore via the backup directory copy (the backup is the byte half).

## Verification

- `packages/vault`: 315 tests green (`npx vitest run`), typecheck clean —
  includes new suites `src/blob/blob.test.ts` (stores, pipeline, EXIF/GPS
  gate, custody replication/reconcile/encryption, S3 driver against an
  in-process fake S3 with SigV4 assertions), `src/blob/flow.test.ts`
  (stage→claim, raw-bytes dedup, inline spill + cap refusal, FTS text
  variant surviving rename, egress rule incl. trash, thumb variants,
  purge/TTL sweeps, settings), `src/ingest/mbox-attachments.test.ts`
  (MIME parse, hold, publish-claims, discard-releases).
- `packages/gateway`: 167 tests green — includes
  `src/routes/blob-routes.test.ts` (raw + JSON upload doors, ETag/304/
  Range/416/HEAD/download, variants, 404 shapes).
- `packages/app-engine` 224, `packages/automation` 144,
  `packages/blueprints` 95 (manifest regen: no template drift) green.
- Full monorepo battery: 133 files, 1127 passed + 1 skipped; repo-wide
  `typecheck` (turbo) green.
