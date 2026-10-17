# Photos derived data

What the vault holds for data derived from a member's photographs, and what in it is still live. **Nothing in v0 runs a model over a member's bytes.** The recognition plane that filled these tables — the enrichment worker, the `enrich.*` commands it wrote through and the automation engine's recipes — was deleted in [#1029](https://github.com/srikanth235/centraid/issues/1029), and `crates/vault/tests/commands.rs` asserts the command registry holds no `enrich.*`. The tables below stay in the schema, so a derivation that arrives later has a place to land, and no production path inserts into them. What still computes is the renditions, below.

## Derived rows are vault rows

Derived data lands in tables the ontology already has — `enrich_embedding` for vectors, `media_face_region` for detected faces, `core_content_derivative` for extracted text and renditions, machine tags under the `urn:centraid:vision`/`urn:centraid:doctype` concept schemes. The DDL is [`contracts/schema/vault-ddl.sql`](../../contracts/schema/vault-ddl.sql). The vector rows are keyed by **target + model**, and model identity carries its version:

| Table | Key | Example |
| --- | --- | --- |
| `enrich_embedding` | `UNIQUE(target_type, target_id, model)` | `('media.asset', '<asset>', 'clip-vit-b-32@1')` |
| `enrich_derivation` | `UNIQUE(target_type, target_id, variant, profile)` | `('media.asset', '<asset>', 'text', 'built-in')` |

**Derived rows are engine-keyed** ([#807](https://github.com/srikanth235/centraid/issues/807)). A provenance stamp names the **engine profile** that produced it, so one engine's result and another's for the same page coexist as two rows rather than overwriting each other. A stamp written without naming a profile belongs to `built-in` (the column's DEFAULT). `variant` and `profile` are deliberately not CHECKed, so a capability or profile shipped after the DDL is stampable without a rebuild.

The `model` column is a `"<name>@<version>"` id. An unparseable value is legal to store and simply never matches a version comparison. There is deliberately no separate `model_version` or content-hash column: `core_content_item.content_hash` already dedupes re-imported bytes onto the same content row.

Derived rows back up and erase like any vault row: a vault erase cascades through every derived row keyed to that vault's entities (`enrich_embedding` and `enrich_derivation` are composite foreign keys into `core_entity` with `ON DELETE CASCADE`). Derived data is not volatile cache, so cache-invalidation bugs cannot corrupt integrity.

The rest of the `enrich_*` family has no writer either: `enrich_request` (a priority queue of on-demand asks), `enrich_policy` and `enrich_policy_rule` (the owner's tier and scoped rules) and `enrich_target_failure` (a per-target failure count). Photos reads one of them: the `photos` row of `enrich_policy`, as a read-only mirror ([`crates/apps/photos/src/enrichment.rs`](../../crates/apps/photos/src/enrichment.rs)). No policy row reads as `off`, and a denied read is reported as denied rather than as `off`; Photos cannot set the tier.

## Derived data enriches, never gates

Derived rows are **advisory, never blocking.** A missing embedding does not prevent a photo from appearing, and an undetected face does not suppress a tile. This is enforced at the app layer, not the schema: the timeline renders every photograph, enriched or not, and a caption is matched with `LIKE` ([README](README.md#what-these-screens-cannot-answer-and-why)).

## Renditions come from the vault's commit path

The `thumb` and `preview` renditions are made by [`crates/media/src/renditions.rs`](../../crates/media/src/renditions.rs) on the vault's commit path and written as `core_content_derivative` rows; `media.derive_missing` is the bounded backfill sweep for a vault written before them. A file that does not decode produces no rendition and the grid falls back to the original. The whole contract — sizes, orientation, metadata stripping, the deferred video poster and HEIC decode — is in [Photos](README.md#derivatives).

## Memories projection

`media_memory` / `media_memory_member` hold three kinds — **on-this-day**, **trip**, and **similar** — with deterministic ids (`otd:<day_key>`, `trip:<first away day>`, `similar:<lowest asset_id>`) so a drop-and-rebuild is byte-stable. Photos reads the shelf as `photos.library.memories` on the first library page only ([`crates/apps/photos/src/queries.rs`](../../crates/apps/photos/src/queries.rs)). No command in `crates/` writes the projection.

The near-duplicate projection beside it is `media_asset_phash.cluster_id`. [`crates/media/src/duplicates.rs`](../../crates/media/src/duplicates.rs) is its pure fold: union-find over phash Hamming ≤ 6, the group's lowest `asset_id` as its cluster id, compare-then-write. Nothing in `crates/` calls it, so on a real vault the column is unwritten; the phash itself is written by `media.add_asset` when one arrives with the asset.

## Faces

**No Photos surface reads or writes these rows.** The face screens were removed on 2026-10-15 ([Q-1047-2](../decisions.md#open-questions-for-the-owner-1046-1047)) because nothing has written `media_face_region` since [#1029](https://github.com/srikanth235/centraid/issues/1029) deleted recognition; on-device detection is proposed separately. The tables and `media.forget_person` stay in the vault. The app crate's three face queries (`faces`, `face-queue`, `people`) went on 2026-10-16, with their `manifest.json` entries; `contracts/apps/photos` keeps v0's answers to them as frozen evidence that nothing reads.

`media.forget_person` ([`crates/vault/src/commands/media.rs`](../../crates/vault/src/commands/media.rs)) deletes the party's own regions and their clusters (embeddings and derivation stamps go with the region through the `core_entity` foreign keys), nulls `confirmed_by_party_id` where the party was the judge, and its postcondition fails the command if any face data naming the party survives. It is the one `media` command with `confirm: true`; see [Photos](README.md#the-apps-shape).

## Related

- [`contracts/schema/vault-ddl.sql`](../../contracts/schema/vault-ddl.sql) — DDL for `enrich_embedding`, `enrich_derivation`, `enrich_request`, `enrich_policy`, `enrich_policy_rule`, `media_memory`, `media_asset_phash`.
- [`crates/vault/src/commands/media.rs`](../../crates/vault/src/commands/media.rs) — `media.forget_person` and `media.derive_missing`.
- [`crates/media`](../../crates/media/README.md) — renditions, phash, duplicates, the model lock.
- [blueprint seats](../blueprint-seats.md) — seat contracts and per-app north stars.
