// Enrichment spine publishers (#299). Invents no tables. Contract:
// ATTRIBUTED (author via `sync.stage_rows`; machine tags have confidence,
// no party — owner tags are the inverse); NEVER OVERWRITES THE OWNER
// (terminal: owner tag, answered face, owner annotation — no-op);
// RE-DERIVABLE (replace own prior output; wipe-and-rerun is always safe).

import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";
import { VISION_SCHEME_URI } from "../schema/enrich.js";
import { captionTarget } from "./caption-target.js";
import { conceptKey, ensureConcept, ensureScheme } from "./concept-writes.js";
import { contentItemPublisher } from "./content-item-publisher.js";
import { assertPayload } from "./payload-schemas.js";
import type { Publisher, PublishedWrite } from "./staging.js";

// ── knowledge.annotation (captions, summaries) ──────────────────────────

export interface AnnotationPayload {
  target_type: string;
  target_id: string;
  body: string;
  /** Injected by `sync.stage_rows`, never trusted from source. */
  author_party_id: string;
}

const annotationPublisher: Publisher = {
  entityType: "knowledge.annotation",
  probe(vault, payload) {
    // Read-only lookup — schema gate covers writes (#374); probe is a key lookup.
    const p = payload as unknown as AnnotationPayload;
    if (!p.author_party_id) return null;
    const target = captionTarget(vault, p.target_type, p.target_id);
    // One caption per (author, target) — replaceMemo.
    const existing = vault
      .prepare(
        `SELECT annotation_id FROM knowledge_annotation
          WHERE target_type = ? AND target_id = ? AND author_party_id = ?`
      )
      .get(target.targetType, target.targetId, p.author_party_id) as
      | { annotation_id: string }
      | undefined;
    return existing
      ? {
          entityId: existing.annotation_id,
          disposition: "update",
          note: "replaces prior caption",
        }
      : null;
  },
  create(vault, _owner, payload, now) {
    const p = assertPayload<AnnotationPayload>("AnnotationPayload", payload);
    const author = vault
      .prepare("SELECT party_id FROM core_party WHERE party_id = ?")
      .get(p.author_party_id ?? "") as { party_id: string } | undefined;
    if (!author) {
      throw new Error(
        "annotation has no author party — enrichment output must be attributed"
      );
    }
    const annotationId = uuidv7();
    const target = captionTarget(vault, p.target_type, p.target_id);
    vault
      .prepare(
        `INSERT INTO knowledge_annotation (annotation_id, author_party_id, target_type, target_id, selector_json, body_text, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(
        annotationId,
        p.author_party_id,
        target.targetType,
        target.targetId,
        p.body,
        now
      );
    return { entityId: annotationId, wrote: [] };
  },
  update(vault, entityId, payload) {
    const p = assertPayload<AnnotationPayload>("AnnotationPayload", payload);
    // Replaces only its own prior output; anyone else's annotation is terminal.
    vault
      .prepare(
        "UPDATE knowledge_annotation SET body_text = ? WHERE annotation_id = ? AND author_party_id = ?"
      )
      .run(p.body, entityId, p.author_party_id ?? "");
    return { wrote: [] };
  },
};

// ── core.tag (machine scene/doctype tags) ───────────────────────────────

export interface TagPayload {
  target_type: string;
  target_id: string;
  scheme_uri?: string;
  label: string;
  confidence: number;
  /**
   * THE EVIDENCE THIS CLAIM RESTS ON (#996, ruling R22). The
   * `enrich_derivation` row that produced it — which carries the profile, the
   * model and the payload — and the revision of the target it was made about.
   * Absent for a claim written before the enrichment run stamped one, which
   * reads as an unattributed machine tag, because that is what it is.
   */
  derivation_id?: string | null;
  input_revision_id?: string | null;
}

const tagPublisher: Publisher = {
  entityType: "core.tag",
  probe(vault, payload) {
    // Read-only lookup.
    const p = payload as unknown as TagPayload;
    const row = vault
      .prepare(
        `SELECT t.tag_id, t.tagged_by_party_id FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = ? AND t.target_id = ? AND s.uri = ?
            AND c.normalized_key = ?
            AND (t.tagged_by_party_id IS NOT NULL
                 OR COALESCE(t.derivation_id, '') = COALESCE(?, ''))
        ORDER BY CASE WHEN t.tagged_by_party_id IS NOT NULL THEN 0 ELSE 1 END
        LIMIT 1`
      )
      .get(
        p.target_type,
        p.target_id,
        p.scheme_uri ?? VISION_SCHEME_URI,
        conceptKey(p.label),
        // COMPETING CONFIDENCES ARE ROWS (#996, R22): this profile's own claim
        // is what a re-run refreshes. Another profile's claim about the same
        // concept is a different row, and finding it here would have made the
        // second engine overwrite the first — the collapse the table's old
        // `UNIQUE (target, concept)` enforced.
        p.derivation_id ?? null
      ) as { tag_id: string; tagged_by_party_id: string | null } | undefined;
    if (!row) return null;
    // Owner-asserted tag (has a party) is terminal; machine tag refreshes confidence.
    return row.tagged_by_party_id
      ? {
          entityId: row.tag_id,
          disposition: "skip",
          note: "owner-asserted tag is terminal",
        }
      : {
          entityId: row.tag_id,
          disposition: "update",
          note: "refreshes confidence",
        };
  },
  create(vault, _owner, payload, now) {
    const p = assertPayload<TagPayload>("TagPayload", payload);
    const uri = p.scheme_uri ?? VISION_SCHEME_URI;
    const schemeId = ensureScheme(vault, uri, "Machine tags");
    const conceptId = ensureConcept(vault, schemeId, p.label);
    const tagId = uuidv7();
    vault
      .prepare(
        `INSERT INTO core_tag
           (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
            confidence, derivation_id, input_revision_id, tagged_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`
      )
      .run(
        tagId,
        p.target_type,
        p.target_id,
        conceptId,
        p.confidence,
        p.derivation_id ?? null,
        p.input_revision_id ?? null,
        now
      );
    return { entityId: tagId, wrote: [] };
  },
  update(vault, entityId, payload, now) {
    const p = assertPayload<TagPayload>("TagPayload", payload);
    vault
      .prepare(
        `UPDATE core_tag
            SET confidence = ?,
                derivation_id = COALESCE(?, derivation_id),
                input_revision_id = COALESCE(?, input_revision_id),
                tagged_at = ?
          WHERE tag_id = ? AND tagged_by_party_id IS NULL`
      )
      .run(
        p.confidence,
        p.derivation_id ?? null,
        p.input_revision_id ?? null,
        now,
        entityId
      );
    return { wrote: [] };
  },
};

// ── media.face_region (face proposals) ──────────────────────────────────

export interface FaceRegionPayload {
  asset_id: string;
  bbox: Record<string, number>;
  party_id?: string;
  confidence: number;
}

const faceRegionPublisher: Publisher = {
  entityType: "media.face_region",
  // No domain-native key: idempotency is `<asset_id>:face:<n>` on the external-id map.
  probe() {
    return null;
  },
  create(vault, _owner, payload) {
    const p = assertPayload<FaceRegionPayload>("FaceRegionPayload", payload);
    const asset = vault
      .prepare("SELECT asset_id FROM media_asset WHERE asset_id = ?")
      .get(p.asset_id) as { asset_id: string } | undefined;
    if (!asset)
      throw new Error(`face region names unknown asset ${p.asset_id}`);
    const regionId = uuidv7();
    vault
      .prepare(
        `INSERT INTO media_face_region (region_id, asset_id, bbox_json, party_id, confidence, confirmed_by_party_id)
         VALUES (?, ?, ?, ?, ?, NULL)`
      )
      .run(
        regionId,
        p.asset_id,
        JSON.stringify(p.bbox),
        p.party_id ?? null,
        p.confidence
      );
    return { entityId: regionId, wrote: [] };
  },
  update(vault, entityId, payload) {
    const p = assertPayload<FaceRegionPayload>("FaceRegionPayload", payload);
    // Answered region is terminal (#712). Guard `review_state = 'proposed'`,
    // not `confirmed_by_party_id IS NULL`: a reject-as-DELETE would let the
    // next run re-propose forever. Every answer leaves a non-`proposed` row.
    vault
      .prepare(
        `UPDATE media_face_region SET bbox_json = ?, party_id = ?, confidence = ?
          WHERE region_id = ? AND review_state = 'proposed'`
      )
      .run(JSON.stringify(p.bbox), p.party_id ?? null, p.confidence, entityId);
    return { wrote: [] };
  },
};

// ── core.collection (trip/event album proposals) ────────────────────────

export interface CollectionPayload {
  name: string;
  members: { target_type: string; target_id: string }[];
}

const collectionPublisher: Publisher = {
  entityType: "core.collection",
  probe(vault, payload) {
    // Read-only lookup.
    const p = payload as unknown as CollectionPayload;
    const existing = vault
      .prepare("SELECT collection_id FROM core_collection WHERE name = ?")
      .get(p.name) as { collection_id: string } | undefined;
    return existing
      ? {
          entityId: existing.collection_id,
          disposition: "update",
          note: "tops up an existing album",
        }
      : null;
  },
  create(vault, owner, payload, now) {
    const p = assertPayload<CollectionPayload>("CollectionPayload", payload);
    const collectionId = uuidv7();
    vault
      .prepare(
        `INSERT INTO core_collection (collection_id, owner_party_id, name, cover_content_id, parent_collection_id, sort_order, created_at)
         VALUES (?, ?, ?, NULL, NULL, 0, ?)`
      )
      .run(collectionId, owner, p.name, now);
    const wrote = addEntries(vault, collectionId, p.members, now);
    return { entityId: collectionId, wrote };
  },
  update(vault, entityId, payload, now) {
    const p = assertPayload<CollectionPayload>("CollectionPayload", payload);
    // Top-up only — never remove; the owner may have curated since.
    return { wrote: addEntries(vault, entityId, p.members, now) };
  },
};

function addEntries(
  vault: DatabaseSync,
  collectionId: string,
  members: CollectionPayload["members"],
  now: string
): PublishedWrite[] {
  const wrote: PublishedWrite[] = [];
  const max = vault
    .prepare(
      "SELECT COALESCE(MAX(position), -1) AS p FROM core_collection_entry WHERE collection_id = ?"
    )
    .get(collectionId) as { p: number };
  let position = max.p + 1;
  for (const member of members) {
    const exists = vault
      .prepare(
        `SELECT 1 AS x FROM core_collection_entry
          WHERE collection_id = ? AND target_type = ? AND target_id = ?`
      )
      .get(collectionId, member.target_type, member.target_id);
    if (exists) continue;
    const entryId = uuidv7();
    vault
      .prepare(
        `INSERT INTO core_collection_entry (entry_id, collection_id, target_type, target_id, position, added_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        entryId,
        collectionId,
        member.target_type,
        member.target_id,
        position,
        now
      );
    position += 1;
    wrote.push({ type: "core.collection_entry", id: entryId });
  }
  return wrote;
}

export const ENRICH_PUBLISHERS: readonly Publisher[] = [
  annotationPublisher,
  tagPublisher,
  faceRegionPublisher,
  collectionPublisher,
  contentItemPublisher,
];
