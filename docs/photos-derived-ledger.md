# Photos derived-intelligence foundation (E1/E2/E3)

Settled **2026-08-07** (issue #721). How enriched data lands in the vault, how the embedder is configured, and the structural decisions that keep derived rows serviceable and optional.

## Derived rows are vault rows

Enrichment outputs land in tables the ontology already has — `enrich_embedding` for vectors, `media_face_region` for detected faces, `core_content_derivative` for extracted text, machine tags under the `urn:centraid:vision`/`urn:centraid:doctype` concept schemes. The vector rows are keyed by **target + model**, and model identity carries its version:

| Table | Key | Example |
| --- | --- | --- |
| `enrich_embedding` | `UNIQUE(target_type, target_id, model)` | `('media.media_asset', '<asset>', 'mobileclip-b@1')` |

**Upgrade is backfill, never migration.** The `model` column is a `"<name>@<version>"` id ([`packages/vault/src/enrich/model-id.ts`](../packages/vault/src/enrich/model-id.ts) owns make/parse/compare — never compare the raw strings). A version bump re-derives rows whose parsed version is older, and old rows keep serving until the new ones land. There is deliberately no separate `model_version` column (SQLite `ADD COLUMN` cannot be written re-runnably against this schema's migration ladder — the reasoning lives in [`packages/vault/src/schema/enrich.ts`](../packages/vault/src/schema/enrich.ts)'s header), and no separate content-hash column: `core_content_item.sha256` already dedupes re-imported bytes onto the same content row, so derivation is content-stable for free.

Derived rows replicate, backup, and erase like any vault row. A phone that imports a Takeout gets the embeddings. A phone that syncs a vault inherits them. A vault erase cascades through every derived row keyed to that vault's entities. This decision trades disk for simplicity: derived data is not volatile cache, and cache-invalidation bugs cannot corrupt integrity.

## The enrichment queue and indexer

`enrich_request` is the durable on-demand priority queue (see [`packages/vault/src/schema/enrich.ts`](../packages/vault/src/schema/enrich.ts) for the DDL). Rows arrive three ways:

1. **search-miss** — a vault search returned nothing; what was wanted is recorded so enrichers drain it before the backlog.
2. **on-view** — an app opened an unenriched item.
3. **manual** — an owner explicitly asked (e.g. "detect faces now"). Scoped by `capability` (which enricher owns the consent) or `required_capability` (the device-lease lane); an untagged manual row is unrepresentable by CHECK.

**The queue is the database.** Rows are durable before any work begins and `drained_at` is the settle marker, so a crashed indexer resumes from `WHERE drained_at IS NULL` — restart-safety is structural, not a feature. The photo-embedding sweep ([`packages/gateway/src/enrich/photo-embeddings.ts`](../packages/gateway/src/enrich/photo-embeddings.ts)) additionally backfills from a `LEFT JOIN` of live assets against `enrich_embedding` for the current model, so it needs no cooperation from importers: anything the vault holds and has not embedded is work.

The sweep runs on the gateway's hourly sweep clock, after the blob sweep (fresh imports get their preview rungs first), in calm batches of 16, gated on the owner's `enrich_policy` photos tier being `gateway`. It embeds from the **thumbnail/preview derivative, never the original** — nobody needs a 48MP RAW to produce an embedding tensor. Embedding computation is an **external embedder command**, opt-in via `CENTRAID_EMBEDDER_PATH` ([`packages/gateway/src/enrich/embedder.ts`](../packages/gateway/src/enrich/embedder.ts)) — the same posture as the Tesseract OCR path: shell-free spawn, hard timeouts, output caps, and bytes never leave the member's gateway. `CENTRAID_EMBEDDER_MODEL` names the versioned model id.

**Honest unavailability.** When no embedder is configured (or nothing is indexed yet for the current model), `POST /centraid/_vault/enrich/semantic-search` returns `200 {status: "unavailable", reason}` — no fake vectors, no silent truncation. The mobile search surface treats that (and any network failure) as the semantic hit group simply being absent; every other search plane keeps working.

## sqlite-vec: two rules, from the first commit

The vault open path exposes a `loadExtensions` hook ([`packages/vault/src/db.ts`](../packages/vault/src/db.ts), following the `previewCodec` injection precedent — `packages/vault` itself stays dependency-light), and the gateway injects [`packages/gateway/src/enrich/sqlite-vec.ts`](../packages/gateway/src/enrich/sqlite-vec.ts). Two rules hold:

1. **Re-disable immediately after loading.** `enableLoadExtension(true)` → `loadExtension(...)` → `enableLoadExtension(false)`, with the revoke in a `finally` so even a half-load closes the door. The owner's `vault_sql` surface runs SQL against this same handle, and `load_extension()` must never be reachable from it.
2. **Loading is per-connection, in the open path.** `DatabaseProvider` handles may resolve to a _different_ connection across vault switches; a one-time boot-step load would silently yield a vec-less handle after a switch.

The load is feature-detected and never fails the vault open. Semantic search uses `vec_distance_cosine` directly over the existing `enrich_embedding.vector` BLOBs — no `vec0` virtual table, so the extension stays strictly additive — and falls back to the brute-force cosine scan (`scanEmbeddings`) when the extension is unavailable; a parity test asserts both rankers agree.

## Mobile op-sqlite vector support

The build flag rides the same `op-sqlite` config block as FTS5, and inherits its trap ([`apps/mobile/src/lib/replica/op-sqlite-build-config.test.ts`](../apps/mobile/src/lib/replica/op-sqlite-build-config.test.ts)): the iOS podspec walks up to the **root** `package.json` (bun hoists op-sqlite) while Android's gradle reads **`apps/mobile/package.json`** — so `"op-sqlite": { "fts5": true, "sqliteVec": true }` must be declared in **both** files or one platform silently ships without vector search. The extended test pins both.

Nothing on device _uses_ vec yet: `probeSqliteVec()` is exported but deliberately not called at replica open (a build compiled before the native rebuild must still open for every non-vector feature). Offline semantic ranking over replicated vectors — and any device-side indexing — is E6, next version.

## The "derived data enriches, never gates" rule

Derived rows are **advisory, never blocking.** A missing embedding does not prevent a photo from appearing. An undetected face does not suppress a tile. OCR text failures degrade gracefully. This is enforced at the app layer, not the schema:

- Search falls back to captions (FTS5) when embeddings fail or are absent.
- Timeline renders all photos, enriched or not; enrichment unlocks search facets, not visibility.
- Face triage is optional; unreviewed regions are simply not grouped into households.

See [`apps/mobile/src/kit/replica/mount-plan.ts`](../apps/mobile/src/kit/replica/mount-plan.ts) for the phone-startup pattern: the replica mounts immediately from disk without waiting for embeddings to be available, because the canonical data (photos, captions) are already there. Enrichment is the read-plane optimization, not the baseline.

**Consent.** The owner's per-domain tier (`enrich_policy`: `off | device | gateway`) is the standing consent every sweep checks before it runs; manual asks are additionally scoped by `capability`/`required_capability` so one consent never becomes every enricher's cue (the CHECK constraints in `enrich_request` make the untagged shape unrepresentable).

## Deferred decisions (E4/E6)

**E4 — faces.** Blocked on model licensing before it can even be scheduled: YOLOv5-derived detectors inherit AGPL and many insightface checkpoints are non-commercial — weights carry their own licence independent of the code that runs them, and a permissively-licensed detector/embedder pair has to be cleared first. Face data is also the most sensitive derived class in the product: a "delete this person" gesture must provably cascade through every `media_face_region` keyed to that identity and every replica holding copies, and the [SECURITY.md](../SECURITY.md) threat model records that E4 does not ship before that cascade is implemented and tested. The consent-gated naming UI already exists ([`apps/mobile/src/apps/photos/EnrichmentConsent.tsx`](../apps/mobile/src/apps/photos/EnrichmentConsent.tsx)); E4 is the pipeline that finally puts faces behind it.

**E6 — Device-side indexing.** Explicitly next-version, deferred rather than rejected. The schema keeps the decision open: **any node holding the bytes and the model may write a derived row; first writer wins; everyone else replicates and skips the work** — which makes placement a scheduling policy, not an architecture. What the phone would eventually win is the capture path (index what the camera just took, on the idle NPU, while charging); what the gateway keeps regardless is completeness — it is the only node guaranteed to hold every byte, and a partial replica ([docs/mobile-offline.md](mobile-offline.md)) cannot index what it does not have. The front-loaded costs that defer it: model distribution through app stores, Core ML / NNAPI delegation, and a second preprocessing implementation that must agree with the first or clusters drift.

## Related

- [`packages/vault/src/schema/enrich.ts`](../packages/vault/src/schema/enrich.ts) — DDL for `enrich_embedding`, `enrich_request`, `enrich_policy`, `media_asset_phash`.
- [`packages/gateway/src/enrich/embedder.ts`](../packages/gateway/src/enrich/embedder.ts) — external embedder command contract; resolves via `CENTRAID_EMBEDDER_PATH`.
- [`packages/gateway/src/enrich/sqlite-vec.ts`](../packages/gateway/src/enrich/sqlite-vec.ts) — sqlite-vec extension lifecycle for semantic search.
- [`packages/automation/src/fire/enrich-gate.ts`](../packages/automation/src/fire/enrich-gate.ts) — tier ordering (off/device/gateway) and consent scopes.
- [`packages/vault/src/enrich/model-id.ts`](../packages/vault/src/enrich/model-id.ts) — the `<name>@<version>` model-identity convention.
- [`packages/vault/src/enrich/similarity.ts`](../packages/vault/src/enrich/similarity.ts) — the brute-force cosine fallback ranker.
- [docs/blueprint-seats.md](blueprint-seats.md) — seat contracts and per-app north stars.
