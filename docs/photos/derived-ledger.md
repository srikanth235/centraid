# Photos derived-intelligence foundation

How model-derived data lands in the vault and the structural decisions that keep derived rows serviceable and optional. The current execution boundary is the recognition handler described in [recognition automations](../recognition-automations.md).

## Derived rows are vault rows

Enrichment outputs land in tables the ontology already has — `enrich_embedding` for vectors, `media_face_region` for detected faces, `core_content_derivative` for extracted text and renditions, machine tags under the `urn:centraid:vision`/`urn:centraid:doctype` concept schemes. The DDL is [`contracts/schema/vault-ddl.sql`](../../contracts/schema/vault-ddl.sql). The vector rows are keyed by **target + model**, and model identity carries its version:

| Table | Key | Example |
| --- | --- | --- |
| `enrich_embedding` | `UNIQUE(target_type, target_id, model)` | `('media.asset', '<asset>', 'clip-vit-b-32@1')` |
| `enrich_derivation` | `UNIQUE(target_type, target_id, variant, profile)` | `('media.asset', '<asset>', 'text', 'built-in')` |

**Derived rows are engine-keyed** ([#807](https://github.com/srikanth235/centraid/issues/807)). A provenance stamp names the **engine profile** that produced it — the named bundle of capability + engine + parameters policy points at — so the built-in OCR result and an LLM profile's result for the same page coexist as two rows rather than overwriting each other. A stamp written without naming a profile belongs to `built-in` (the column's DEFAULT, and `BUILT_IN_PROFILE` in [`crates/vault/src/commands/enrich.rs`](../../crates/vault/src/commands/enrich.rs)), the bundled deterministic engines. `variant` and `profile` are deliberately not CHECKed, so a capability or profile shipped after the DDL is stampable without a rebuild.

**Upgrade is backfill, never migration.** The `model` column is a `"<name>@<version>"` id. A version bump re-derives rows whose parsed version is older, and old rows keep serving until the new ones land; an unparseable value is legal to store and simply never matches a backfill query. There is deliberately no separate `model_version` or content-hash column: `core_content_item.content_hash` already dedupes re-imported bytes onto the same content row.

Derived rows replicate, backup, and erase like any vault row. A device that syncs a vault inherits them, and a vault erase cascades through every derived row keyed to that vault's entities (`enrich_embedding` and `enrich_derivation` are composite foreign keys into `core_entity` with `ON DELETE CASCADE`). This decision trades disk for simplicity: derived data is not volatile cache, and cache-invalidation bugs cannot corrupt integrity.

## Renditions come from the gateway

The `thumb` and `preview` renditions are made by [`crates/media/src/renditions.rs`](../../crates/media/src/renditions.rs) on the gateway's commit path and written as `core_content_derivative` rows; `media.derive_missing` is the bounded backfill sweep for a vault written before them. A file that does not decode produces no rendition and the grid falls back to the original. The whole contract — sizes, orientation, metadata stripping, the deferred video poster and HEIC decode — is in [Photos](README.md#derivatives).

## The enrichment queue

`enrich_request` is the durable on-demand priority queue. Rows arrive three ways:

1. **search-miss** — a vault search returned nothing; what was wanted is recorded so enrichers drain it before the backlog.
2. **on-view** — an app opened an unenriched item.
3. **manual** — an owner explicitly asked (e.g. "detect faces now"). Scoped by `capability` (which enricher owns the consent) or `required_capability` (the device-lease lane); an untagged manual row is unrepresentable by CHECK.

A fourth reason, `projected`, is minted by the vault itself during share ingest and is not one a caller may give. `enrich.request_enrichment` is the one `enrich` command an app invokes (Photos' `request-enrichment` action), and it writes a **priority hint, never a gate**: a recipe with an empty queue still walks the library behind its cursor.

**The queue is the database.** Rows are durable before any work begins and `drained_at` is the settle marker (`enrich.mark_requests_drained`), so a crashed worker resumes from `WHERE drained_at IS NULL` — restart-safety is structural, not a feature. Recognition scheduling belongs to the automation engine ([`crates/automations`](../../crates/automations)): the recipe catalogue in [`crates/automations/src/handler/recipes.rs`](../../crates/automations/src/handler/recipes.rs) reads the thumbnail/preview derivative (never the original, with transcription the named exception), and persists typed results through the `enrich.*` and `media.*` commands.

## The "derived data enriches, never gates" rule

Derived rows are **advisory, never blocking.** A missing embedding does not prevent a photo from appearing. An undetected face does not suppress a tile. OCR text failures degrade gracefully. This is enforced at the app layer, not the schema:

- Search falls back to captions (FTS5) when embeddings are absent.
- Timeline renders all photos, enriched or not; enrichment unlocks search facets, not visibility.
- Face triage is optional; unreviewed regions are simply not grouped.

## Policy and consent

**The tier.** The owner's per-domain tier (`enrich_policy`: `off | device | gateway`, domains `photos` and `docs`) is the standing consent the automation fire gate ([`crates/automations/src/fire/enrich_gate.rs`](../../crates/automations/src/fire/enrich_gate.rs)) checks before model work. The column's CHECK also admits `local` and `model`, the pre-[#712](https://github.com/srikanth235/centraid/issues/712) names, as a read shim only. Photos reads the tier and cannot set it ([`crates/apps/photos/src/enrichment.rs`](../../crates/apps/photos/src/enrichment.rs)): no policy row reads as `off`, and a denied read is reported as denied rather than as `off`.

**The stores.** `enrich_policy_rule` is the scoped cascade's rule store (`vault | domain | collection | item` × capability) in the DDL. The owner's answer per capability × egress class (`on-device | gateway | provider`) × optional scope has one writer, the journalled `enrich.record_consent` command in [`crates/vault/src/commands/enrich.rs`](../../crates/vault/src/commands/enrich.rs) ([#883](https://github.com/srikanth235/centraid/issues/883)). `enrich.request_enrichment` does not re-key a `manual` ask into a consent answer; that half is named in the command's module comment as the automations lane's.

Faces runs ambiently, on media ingest, like every other bundled recognition recipe — on by default, and opting out is the recipe's own toggle or the vault's `enrich_policy` tier `off` ([current decisions](../decisions.md#recognition-automations-and-derived-data)). The capability-tagged `enrich_request` queue is the priority lane: a manual ask (Photos' People shelf writes one, capability `faces`) is drained ahead of the ambient pass, so it changes when a library is reached and never whether.

## Memories projection

`media_memory` / `media_memory_member` hold three kinds — **on-this-day**, **trip**, and **similar** — with deterministic ids (`otd:<day_key>`, `trip:<first away day>`, `similar:<lowest asset_id>`) so a drop-and-rebuild is byte-stable. Photos reads the shelf as `photos.library.memories` on the first library page only ([`crates/apps/photos/src/queries.rs`](../../crates/apps/photos/src/queries.rs)). No command in `crates/` writes the projection.

The near-duplicate projection beside it is [`crates/media/src/duplicates.rs`](../../crates/media/src/duplicates.rs): union-find over phash Hamming ≤ 6, the group's lowest `asset_id` as its cluster id, compare-then-write.

## Faces

Face vectors are stamped under their model id (`arcface@1`, with `yunet-arcface@1` the faces recipe's pin); `models.lock.json`'s parser and verify-then-fetch live in [`crates/media/src/models.rs`](../../crates/media/src/models.rs). Grouping is `enrich.rebuild_face_clusters`, whose thresholds are stricter for naming a stranger group than for a confirmation, and never compare faces of different widths.

`media.forget_person` ([`crates/vault/src/commands/media.rs`](../../crates/vault/src/commands/media.rs)) deletes the party's own regions and their clusters (embeddings and derivation stamps go with the region through the `core_entity` foreign keys), nulls `confirmed_by_party_id` where the party was the judge, and its postcondition fails the command if any face data naming the party survives. It is the one `media` command with `confirm: true`; see [Photos](README.md#the-apps-shape).

**Device-side indexing is not part of the current architecture.** Enrichment is gateway-only; devices consume replicated rows but do not run model inference. See [current decisions](../decisions.md#recognition-automations-and-derived-data) for the boundary.

## Related

- [`contracts/schema/vault-ddl.sql`](../../contracts/schema/vault-ddl.sql) — DDL for `enrich_embedding`, `enrich_derivation`, `enrich_request`, `enrich_policy`, `enrich_policy_rule`, `media_memory`, `media_asset_phash`.
- [`crates/vault/src/commands/enrich.rs`](../../crates/vault/src/commands/enrich.rs) — the `enrich.*` commands, vector encoding, and face grouping.
- [`crates/vault/src/commands/media.rs`](../../crates/vault/src/commands/media.rs) — `media.forget_person` and `media.derive_missing`.
- [`crates/automations/src/handler/recipes.rs`](../../crates/automations/src/handler/recipes.rs) — the recognition recipe catalogue.
- [`crates/automations/src/fire/enrich_gate.rs`](../../crates/automations/src/fire/enrich_gate.rs) — tier ordering and the lane gate.
- [`crates/media`](../../crates/media/README.md) — renditions, phash, duplicates, model pins.
- [recognition automations](../recognition-automations.md) — the model-execution and local-asset design.
- [blueprint seats](../blueprint-seats.md) — seat contracts and per-app north stars.
