# Photos derived-intelligence foundation (E1/E2/E3)

Settled **2026-08-07** (issue #721; faces, Memories, and the enrichment-service rewire settled under #724 on the same date). How enriched data lands in the vault, how the enrichment service is configured, and the structural decisions that keep derived rows serviceable and optional.

## Derived rows are vault rows

Enrichment outputs land in tables the ontology already has — `enrich_embedding` for vectors, `media_face_region` for detected faces, `core_content_derivative` for extracted text, machine tags under the `urn:centraid:vision`/`urn:centraid:doctype` concept schemes. The vector rows are keyed by **target + model**, and model identity carries its version:

| Table | Key | Example |
| --- | --- | --- |
| `enrich_embedding` | `UNIQUE(target_type, target_id, model)` | `('media.media_asset', '<asset>', 'clip-vit-b-32@1')` |

**Upgrade is backfill, never migration.** The `model` column is a `"<name>@<version>"` id ([`packages/vault/src/enrich/model-id.ts`](../packages/vault/src/enrich/model-id.ts) owns make/parse/compare — never compare the raw strings). A version bump re-derives rows whose parsed version is older, and old rows keep serving until the new ones land. There is deliberately no separate `model_version` column (SQLite `ADD COLUMN` cannot be written re-runnably against this schema's migration ladder — the reasoning lives in [`packages/vault/src/schema/enrich.ts`](../packages/vault/src/schema/enrich.ts)'s header), and no separate content-hash column: `core_content_item.sha256` already dedupes re-imported bytes onto the same content row, so derivation is content-stable for free.

Derived rows replicate, backup, and erase like any vault row. A phone that imports a Takeout gets the embeddings. A phone that syncs a vault inherits them. A vault erase cascades through every derived row keyed to that vault's entities. This decision trades disk for simplicity: derived data is not volatile cache, and cache-invalidation bugs cannot corrupt integrity.

## The enrichment queue and indexer

`enrich_request` is the durable on-demand priority queue (see [`packages/vault/src/schema/enrich.ts`](../packages/vault/src/schema/enrich.ts) for the DDL). Rows arrive three ways:

1. **search-miss** — a vault search returned nothing; what was wanted is recorded so enrichers drain it before the backlog.
2. **on-view** — an app opened an unenriched item.
3. **manual** — an owner explicitly asked (e.g. "detect faces now"). Scoped by `capability` (which enricher owns the consent) or `required_capability` (the device-lease lane); an untagged manual row is unrepresentable by CHECK.

**The queue is the database.** Rows are durable before any work begins and `drained_at` is the settle marker, so a crashed indexer resumes from `WHERE drained_at IS NULL` — restart-safety is structural, not a feature. The photo-embedding sweep ([`packages/gateway/src/enrich/embedding-sweep.ts`](../packages/gateway/src/enrich/embedding-sweep.ts)) additionally backfills from a `LEFT JOIN` of live assets against `enrich_embedding` for the current model, so it needs no cooperation from importers: anything the vault holds and has not embedded is work. Issue #724 generalized this pass into [`capability-sweep.ts`](../packages/gateway/src/enrich/capability-sweep.ts), shared by embeddings, OCR, faces, and transcripts alike — see [docs/enrichment-service.md](enrichment-service.md).

The sweep runs on the gateway's hourly sweep clock, after the blob sweep (fresh imports get their preview rungs first), in calm batches of 16, gated on the owner's `enrich_policy` photos tier being `gateway`. It embeds from the **thumbnail/preview derivative, never the original** — nobody needs a 48MP RAW to produce an embedding tensor. Embedding computation is issue #724's **enrichment service** — a single loopback-only HTTP seam configured via `CENTRAID_ENRICH_URL`, replacing the earlier spawned-embedder-process design (`CENTRAID_EMBEDDER_PATH`/`_MODEL`, now deleted). See [docs/enrichment-service.md](enrichment-service.md) for the wire contract, config, and the full capability table; [`packages/gateway/src/enrich/embedding-sweep.ts`](../packages/gateway/src/enrich/embedding-sweep.ts) is the photo-embedding spec that rides the shared [`capability-sweep.ts`](../packages/gateway/src/enrich/capability-sweep.ts).

**Honest unavailability.** When no enrichment service is configured (or nothing is indexed yet for the current model), `POST /centraid/_vault/enrich/semantic-search` returns `200 {status: "unavailable", reason}` — no fake vectors, no silent truncation. The mobile search surface treats that (and any network failure) as the semantic hit group simply being absent; every other search plane keeps working.

## sqlite-vec: two rules, from the first commit

The vault open path exposes a `loadExtensions` hook ([`packages/vault/src/db.ts`](../packages/vault/src/db.ts), following the `previewCodec` injection precedent — `packages/vault` itself stays dependency-light), and the gateway injects [`packages/gateway/src/enrich/sqlite-vec.ts`](../packages/gateway/src/enrich/sqlite-vec.ts). Two rules hold:

1. **Re-disable immediately after loading.** `enableLoadExtension(true)` → `loadExtension(...)` → `enableLoadExtension(false)`, with the revoke in a `finally` so even a half-load closes the door. The owner's `vault_sql` surface runs SQL against this same handle, and `load_extension()` must never be reachable from it.
2. **Loading is per-connection, in the open path.** `DatabaseProvider` handles may resolve to a _different_ connection across vault switches; a one-time boot-step load would silently yield a vec-less handle after a switch.

The load is feature-detected and never fails the vault open. Semantic search uses `vec_distance_cosine` directly over the existing `enrich_embedding.vector` BLOBs — no `vec0` virtual table, so the extension stays strictly additive — and falls back to the brute-force cosine scan (`scanEmbeddings`) when the extension is unavailable; a parity test asserts both rankers agree.

## Mobile op-sqlite vector support

The build flag rides the same `op-sqlite` config block as FTS5, and inherits its trap ([`apps/mobile/src/lib/replica/op-sqlite-build-config.test.ts`](../apps/mobile/src/lib/replica/op-sqlite-build-config.test.ts)): the iOS podspec walks up to the **root** `package.json` (bun hoists op-sqlite) while Android's gradle reads **`apps/mobile/package.json`** — so `"op-sqlite": { "fts5": true, "sqliteVec": true }` must be declared in **both** files or one platform silently ships without vector search. The extended test pins both.

Nothing on device _uses_ vec yet: `probeSqliteVec()` is exported but deliberately not called at replica open (a build compiled before the native rebuild must still open for every non-vector feature). Offline semantic ranking over replicated vectors remains open; device-side model inference itself is dead by decision (E6, below), so any future offline ranking would score vectors the gateway already computed, never derive new ones on the phone.

## The "derived data enriches, never gates" rule

Derived rows are **advisory, never blocking.** A missing embedding does not prevent a photo from appearing. An undetected face does not suppress a tile. OCR text failures degrade gracefully. This is enforced at the app layer, not the schema:

- Search falls back to captions (FTS5) when embeddings fail or are absent.
- Timeline renders all photos, enriched or not; enrichment unlocks search facets, not visibility.
- Face triage is optional; unreviewed regions are simply not grouped into households.

See [`apps/mobile/src/kit/replica/mount-plan.ts`](../apps/mobile/src/kit/replica/mount-plan.ts) for the phone-startup pattern: the replica mounts immediately from disk without waiting for embeddings to be available, because the canonical data (photos, captions) are already there. Enrichment is the read-plane optimization, not the baseline.

**Consent.** The owner's per-domain tier (`enrich_policy`: `off | device | gateway`) is the standing consent every sweep checks before it runs; manual asks are additionally scoped by `capability`/`required_capability` so one consent never becomes every enricher's cue (the CHECK constraints in `enrich_request` make the untagged shape unrepresentable).

## Memories v0 (issue #724 W7)

A third rebuildable projection beside the phash `cluster_id`, same mold exactly: `media_memory` / `media_memory_member` ([`packages/vault/src/schema/enrich.ts`](../packages/vault/src/schema/enrich.ts)), recomputed wholesale on the standing sweep ([`packages/vault/src/enrich/memories.ts`](../packages/vault/src/enrich/memories.ts)'s `rebuildMemories`, invoked from `gateway.ts`'s `sweep()` right after `recomputeDuplicateClusters`). No ML dependency and no dependence on any other #724 workstream — every input is a column the vault already had. Three kinds share the table: **on-this-day** (assets sharing a calendar month-day across distinct years, grouped year-agnostically so the sweep never reads a wall clock), **trip** (a maximal run of capture-local days whose modal place differs from the owner's home place), and **similar** (the union of `media_asset_phash.cluster_id` and `capture_group_id` groups). Deterministic, readable ids (`otd:<day_key>`, `trip:<first away day>`, `similar:<lowest asset_id>`) make a drop-and-rebuild byte-stable. Mobile reads the projection through the same replica path as every other Photos shelf (`apps/mobile/src/apps/photos/memories-model.ts` + `MemoriesView.tsx`), with the same "on-this-day with nothing behind it shows nothing" honesty rule the pre-existing Collections Memories shelf already had.

## E4 shipped; E6 is dead by decision

**E4 — faces.** Shipped in issue #724, on the reference enrichment service's permissively-licensed model pair (YuNet + SFace, both MIT/Apache-2.0 — see [docs/enrichment-service.md](enrichment-service.md#faces) and [`tools/enrichment-service/LICENSES.md`](../tools/enrichment-service/LICENSES.md)), clearing the licensing block this section used to record. Detection is consent-gated per [docs/enrichment-service.md](enrichment-service.md#faces) — a face asserts an identity, so it carries its own consent tag distinct from the domain-tier gate every other capability answers to. The delete cascade the [SECURITY.md](../SECURITY.md) threat model required before E4 could ship is `media.forget_person` ([`packages/vault/src/commands/media.ts`](../packages/vault/src/commands/media.ts)): its postcondition proves zero rows remain across face regions, face embeddings, derivation stamps, and cluster rows, proven by test across replica propagation and recovery export/import. The consent-gated naming UI ([`apps/mobile/src/apps/photos/EnrichmentConsent.tsx`](../apps/mobile/src/apps/photos/EnrichmentConsent.tsx)) now sits in front of a real pipeline.

**E6 — device-side indexing — dead by decision, not deferred.** Issue #724 settled this: enrichment stays **gateway-only**. The schema's placement-is-a-scheduling-policy design (any node holding the bytes and the model may write a derived row) is no longer being kept open for a future device-side writer; the front-loaded costs that would have justified one — model distribution through app stores, Core ML / NNAPI delegation, a second preprocessing implementation that must agree with the first or clusters drift — were judged not worth paying against a gateway that already holds every byte and can run the reference service on ordinary hardware. See [docs/decisions.md](decisions.md) for the settled #724 decision record.

## Related

- [`packages/vault/src/schema/enrich.ts`](../packages/vault/src/schema/enrich.ts) — DDL for `enrich_embedding`, `enrich_request`, `enrich_policy`, `media_asset_phash`.
- [`packages/gateway/src/enrich/service-client.ts`](../packages/gateway/src/enrich/service-client.ts) — the enrichment service client (config, wire contract, caps); replaces the deleted `CENTRAID_EMBEDDER_PATH` spawn design.
- [docs/enrichment-service.md](enrichment-service.md) — the canonical doc for the service, its capability table, and the reference implementation.
- [`packages/gateway/src/enrich/sqlite-vec.ts`](../packages/gateway/src/enrich/sqlite-vec.ts) — sqlite-vec extension lifecycle for semantic search.
- [`packages/automation/src/fire/enrich-gate.ts`](../packages/automation/src/fire/enrich-gate.ts) — tier ordering (off/device/gateway) and consent scopes.
- [`packages/vault/src/enrich/model-id.ts`](../packages/vault/src/enrich/model-id.ts) — the `<name>@<version>` model-identity convention.
- [`packages/vault/src/enrich/similarity.ts`](../packages/vault/src/enrich/similarity.ts) — the brute-force cosine fallback ranker.
- [`packages/vault/src/enrich/memories.ts`](../packages/vault/src/enrich/memories.ts) — Memories v0's rebuild sweep (on-this-day/trip/similar).
- [`packages/vault/src/enrich/derivation.ts`](../packages/vault/src/enrich/derivation.ts) — the `enrich_derivation` provenance stamp and supersession query.
- [`packages/vault/src/enrich/face-clusters.ts`](../packages/vault/src/enrich/face-clusters.ts) — party-anchored face matching and stranger grouping.
- [`packages/vault/src/commands/media.ts`](../packages/vault/src/commands/media.ts) — `media.forget_person`, the proven delete cascade.
- [`apps/mobile/src/apps/photos/memories-model.ts`](../apps/mobile/src/apps/photos/memories-model.ts) — the mobile read-side grouping and honest-empty-state rules.
- [docs/blueprint-seats.md](blueprint-seats.md) — seat contracts and per-app north stars.
