# Photos derived-intelligence foundation

How model-derived data lands in the vault and the structural decisions that keep derived rows serviceable and optional. The current execution boundary is the self-contained recognition handler described in [recognition automations](../recognition-automations.md).

## Derived rows are vault rows

Enrichment outputs land in tables the ontology already has — `enrich_embedding` for vectors, `media_face_region` for detected faces, `core_content_derivative` for extracted text, machine tags under the `urn:centraid:vision`/`urn:centraid:doctype` concept schemes. The vector rows are keyed by **target + model**, and model identity carries its version:

| Table | Key | Example |
| --- | --- | --- |
| `enrich_embedding` | `UNIQUE(target_type, target_id, model)` | `('media.asset', '<asset>', 'clip-vit-b-32@1')` |
| `enrich_derivation` | `UNIQUE(target_type, target_id, variant, profile)` | `('media.asset', '<asset>', 'text', 'built-in')` |

**Derived rows are engine-keyed** ([#807](https://github.com/srikanth235/centraid/issues/807)). A provenance stamp names the **engine profile** that produced it — the named bundle of capability + engine + parameters policy points at — so the built-in OCR result and an LLM profile's result for the same page coexist as two rows rather than overwriting each other. A stamp written without naming a profile belongs to `built-in`, the bundled deterministic engines. Consumers never pick a row by hand: [`preferredDerivation`](../../packages/vault/src/enrich/derivation.ts) is the one resolution helper (preferred profile → `built-in` → any, deterministically), and `stampedModel` answers through it.

**Upgrade is backfill, never migration.** The `model` column is a `"<name>@<version>"` id ([`packages/vault/src/enrich/model-id.ts`](../../packages/vault/src/enrich/model-id.ts) owns make/parse/compare — never compare the raw strings). A version bump re-derives rows whose parsed version is older, and old rows keep serving until the new ones land. There is deliberately no separate `model_version` or content-hash column: the schema ladder owns migration boundaries and `core_content_item.sha256` already dedupes re-imported bytes onto the same content row.

Derived rows replicate, backup, and erase like any vault row. A phone that imports a Takeout gets the embeddings. A phone that syncs a vault inherits them. A vault erase cascades through every derived row keyed to that vault's entities. This decision trades disk for simplicity: derived data is not volatile cache, and cache-invalidation bugs cannot corrupt integrity.

## The enrichment queue and indexer

`enrich_request` is the durable on-demand priority queue (see [`packages/vault/src/schema/enrich.ts`](../../packages/vault/src/schema/enrich.ts) for the DDL). Rows arrive three ways:

1. **search-miss** — a vault search returned nothing; what was wanted is recorded so enrichers drain it before the backlog.
2. **on-view** — an app opened an unenriched item.
3. **manual** — an owner explicitly asked (e.g. "detect faces now"). Scoped by `capability` (which enricher owns the consent) or `required_capability` (the device-lease lane); an untagged manual row is unrepresentable by CHECK.

**The queue is the database.** Rows are durable before any work begins and `drained_at` is the settle marker, so a crashed worker resumes from `WHERE drained_at IS NULL` — restart-safety is structural, not a feature. Recognition scheduling belongs to the automation engine (#731): the `embed-image`, `embed-text`, `photo-ocr`, `transcript`, and `faces` templates run bounded batches of 16, stage typed vault commands, and advance template cursor watermarks. There is no gateway-private capability-sweep engine or generic supersession selector. On first enable, compatible `enrich_derivation` stamps seed the cursor; a model/prompt revision re-arms only affected rows.

The automation fire gate checks the owner's `enrich_policy` tier before model work. Image automation reads the **thumbnail/preview derivative, never the original** — nobody needs a 48MP RAW to produce an embedding tensor. Each bundled handler reads it through `ctx.vault.content`, runs its own implementation with local model assets when needed, and persists typed results through `ctx.vault.invoke`. There is no enrichment service, reserved fetch, `ctx.infer`, or `ctx.enrich`. See [recognition automations](../recognition-automations.md).

**Honest unavailability.** When local embedding assets are unavailable (or nothing is indexed yet for the current model), `POST /centraid/_vault/enrich/semantic-search` returns `200 {status: "unavailable", reason}` — no fake vectors, no silent truncation. The mobile search surface treats that (and any network failure) as the semantic hit group simply being absent; every other search plane keeps working.

## sqlite-vec: two rules

The vault open path exposes a `loadExtensions` hook ([`packages/vault/src/db.ts`](../../packages/vault/src/db.ts), following the `previewCodec` injection precedent — `packages/vault` itself stays dependency-light), and the gateway injects [`packages/server/src/enrich/sqlite-vec.ts`](../../packages/server/src/enrich/sqlite-vec.ts). Two rules hold:

1. **Re-disable immediately after loading.** `enableLoadExtension(true)` → `loadExtension(...)` → `enableLoadExtension(false)`, with the revoke in a `finally` so even a half-load closes the door. The owner's `vault_sql` surface runs SQL against this same handle, and `load_extension()` must never be reachable from it.
2. **Loading is per-connection, in the open path.** `DatabaseProvider` handles may resolve to a _different_ connection across vault switches; a one-time boot-step load would silently yield a vec-less handle after a switch.

The load is feature-detected and never fails the vault open. Semantic search uses `vec_distance_cosine` directly over the existing `enrich_embedding.vector` BLOBs — no `vec0` virtual table, so the extension stays strictly additive — and falls back to the brute-force cosine scan (`scanEmbeddings`) when the extension is unavailable; a parity test asserts both rankers agree.

## Mobile op-sqlite vector support

The build flag rides the same `op-sqlite` config block as FTS5, and inherits its trap ([`apps/mobile/src/lib/replica/op-sqlite-build-config.test.ts`](../../apps/mobile/src/lib/replica/op-sqlite-build-config.test.ts)): the iOS podspec walks up to the **root** `package.json` (bun hoists op-sqlite) while Android's gradle reads **`apps/mobile/package.json`** — so `"op-sqlite": { "fts5": true, "sqliteVec": true }` must be declared in **both** files or one platform silently ships without vector search. The extended test pins both.

Nothing on device _uses_ vec yet: `probeSqliteVec()` is exported but deliberately not called at replica open (a build compiled before the native rebuild must still open for every non-vector feature). Offline semantic ranking over replicated vectors remains open; device-side model inference itself is dead by decision (E6, below), so any future offline ranking would score vectors the gateway already computed, never derive new ones on the phone.

## The "derived data enriches, never gates" rule

Derived rows are **advisory, never blocking.** A missing embedding does not prevent a photo from appearing. An undetected face does not suppress a tile. OCR text failures degrade gracefully. This is enforced at the app layer, not the schema:

- Search falls back to captions (FTS5) when embeddings fail or are absent.
- Timeline renders all photos, enriched or not; enrichment unlocks search facets, not visibility.
- Face triage is optional; unreviewed regions are simply not grouped into households.

See [`apps/mobile/src/kit/replica/mount-plan.ts`](../../apps/mobile/src/kit/replica/mount-plan.ts) for the phone-startup pattern: the replica mounts immediately from disk without waiting for embeddings to be available, because the canonical data (photos, captions) are already there. Enrichment is the read-plane optimization, not the baseline.

**The policy and consent stores.** Two vault tables carry the generic system's decisions ahead of the surfaces that edit them ([#807](https://github.com/srikanth235/centraid/issues/807)): `enrich_policy_rule` is the scoped cascade's rule store (`vault | domain | collection | item` × capability, each of enabled / engine profile / trigger nullable and meaning inherit — [`packages/vault/src/enrich/policy-rules.ts`](../../packages/vault/src/enrich/policy-rules.ts)), and the owner's answer per capability × egress class (`on-device | gateway | provider`) × optional scope, with its journal receipt, is a `harness`-principal row of the one authority table ([`packages/vault/src/enrich/egress-consent.ts`](../../packages/vault/src/enrich/egress-consent.ts)) — the egress class is the principal, the scope the subject, the capability the verb ([#883](https://github.com/srikanth235/centraid/issues/883)). Both are storage: `decideEnrichmentGate` remains the one gate, and the `enrich_policy` tier below stays the standing consent it reads. The egress answers have exactly one writer — the journalled `enrich.record_consent` command ([`packages/vault/src/commands/enrich.ts`](../../packages/vault/src/commands/enrich.ts), also re-keyed from a `manual` `enrich.request_enrichment`); the gateway only reads it, walking the fired scope chain most-specific-first ([`packages/server/src/enrich/egress-consent-lookup.ts`](../../packages/server/src/enrich/egress-consent-lookup.ts)). The owner surfaces are `GET`/`POST /centraid/_vault/enrich/consent`, rendered back in Privacy's enrichment egress answers.

**Consent.** The owner's per-domain tier (`enrich_policy`: `off | device | gateway`) is the standing consent `runFire` checks before an automation runs — it is the recorded answer for the `on-device` and `gateway` egress classes, so a vault with no recorded egress answers runs exactly what it always ran. Rows DO exist for those two classes — the phone's capture-time OCR latch records its answer as `ocr` × `on-device` — and the gate deliberately does not read them: that latch is per-device by law ([#712](https://github.com/srikanth235/centraid/issues/712) C3), so enforcing one phone's “not now” vault-wide would bind an answer the other devices never gave. The row is the record Privacy reads back; the answer is enforced where it was given. Only `provider` egress needs its own granted row, evaluated independently of the cascade at the same gate: a rule that pins a provider-backed engine is refused until the member has answered that question for that capability, and a declined answer stands until they answer again. manual asks are additionally scoped by `capability`/`required_capability` so one consent never becomes every enricher's cue (the CHECK constraints in `enrich_request` make the untagged shape unrepresentable). Faces reads only its open capability-tagged queue or a prior stamp that proves past consent; it never scans the ambient library.

## Memories projection

A third rebuildable projection beside the phash `cluster_id`, same mold exactly: `media_memory` / `media_memory_member` ([`packages/vault/src/schema/enrich.ts`](../../packages/vault/src/schema/enrich.ts)), maintained on the standing sweep ([`packages/vault/src/enrich/memories.ts`](../../packages/vault/src/enrich/memories.ts)'s `rebuildMemories`, invoked from `gateway.ts`'s `sweep()` right after `recomputeDuplicateClusters`). Each pass fingerprints its ordered source rows and persisted projection. An identical pass performs no projection writes; after process restart it derives once and compares logical rows before writing. Persisted rows participate in the fingerprint, so deleting or corrupting the rebuildable projection invalidates the memo and the next pass repairs it. No ML dependency; every input is a column the vault already had. Three kinds share the table: **on-this-day**, **trip**, and **similar**. Deterministic ids (`otd:<day_key>`, `trip:<first away day>`, `similar:<lowest asset_id>`) make a drop-and-rebuild byte-stable. Mobile reads the projection through the same replica path as every other Photos shelf (`apps/mobile/src/apps/photos/memories-model.ts` + `MemoriesView.tsx`).

## Faces and device-side indexing

**Faces** use the permissively licensed YuNet + SFace pair (MIT/Apache-2.0; see [recognition automations](../recognition-automations.md#scheduling-consent-and-provenance) and [`packages/model-runtime/LICENSES.md`](../../packages/model-runtime/LICENSES.md)). Detection is consent-gated, and `media.forget_person` ([`packages/vault/src/commands/media.ts`](../../packages/vault/src/commands/media.ts)) proves the delete cascade across face regions, embeddings, derivation stamps, and cluster rows through replica propagation and recovery export/import. The naming UI ([`apps/mobile/src/apps/photos/EnrichmentConsent.tsx`](../../apps/mobile/src/apps/photos/EnrichmentConsent.tsx)) sits in front of the pipeline.

**Device-side indexing is not part of the current architecture.** Enrichment is gateway-only; offline clients consume replicated vectors but do not run model inference. See [current decisions](../decisions.md#recognition-automations-and-derived-data) for the boundary.

## Related

- [`packages/vault/src/schema/enrich.ts`](../../packages/vault/src/schema/enrich.ts) — DDL for `enrich_embedding`, `enrich_request`, `enrich_policy`, `media_asset_phash`.
- [`packages/blueprints/automations`](../../packages/blueprints/automations) — recognition handlers.
- [recognition automations](../recognition-automations.md) — the model-execution and local-asset design.
- [`packages/server/src/enrich/sqlite-vec.ts`](../../packages/server/src/enrich/sqlite-vec.ts) — sqlite-vec extension lifecycle for semantic search.
- [`packages/server/src/automation/fire/enrich-gate.ts`](../../packages/server/src/automation/fire/enrich-gate.ts) — tier ordering and consent scopes.
- [`packages/vault/src/enrich/model-id.ts`](../../packages/vault/src/enrich/model-id.ts) — the `<name>@<version>` model-identity convention.
- [`packages/vault/src/enrich/similarity.ts`](../../packages/vault/src/enrich/similarity.ts) — the brute-force cosine fallback ranker.
- [`packages/vault/src/enrich/memories.ts`](../../packages/vault/src/enrich/memories.ts) — Memories v0's rebuild sweep.
- [`packages/vault/src/enrich/derivation.ts`](../../packages/vault/src/enrich/derivation.ts) — the `enrich_derivation` provenance stamp and preferred-result resolution.
- [`packages/server/src/enrich/capability-registry.ts`](../../packages/server/src/enrich/capability-registry.ts) — the nine capability contracts and their versioned output schemas.
- [`packages/vault/src/enrich/face-clusters.ts`](../../packages/vault/src/enrich/face-clusters.ts) — party-anchored face matching and stranger grouping.
- [`packages/vault/src/commands/media.ts`](../../packages/vault/src/commands/media.ts) — `media.forget_person`, the delete cascade.
- [`apps/mobile/src/apps/photos/memories-model.ts`](../../apps/mobile/src/apps/photos/memories-model.ts) — mobile grouping and honest-empty-state rules.
- [blueprint seats](../blueprint-seats.md) — seat contracts and per-app north stars.
