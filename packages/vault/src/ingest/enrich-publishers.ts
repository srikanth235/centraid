// Publishers for the enrichment spine (issue #299 §4): how model-derived
// candidates become vault rows. Enrichment invents no tables — captions land
// as knowledge.annotation, scene tags as core.tag under the machine schemes,
// face proposals as media.face_region, trip albums as core.collection, and
// filing/rename proposals as core.content_item updates.
//
// The derived-data contract (issue #299 §1) is enforced here, structurally:
//   - ATTRIBUTED: an annotation names its author party (the enricher's
//     enrolled agent party, injected server-side by `sync.stage_rows`);
//     machine tags carry confidence and no `tagged_by_party_id` — an owner
//     tag is the exact inverse (party, no confidence).
//   - NEVER OVERWRITES THE OWNER: an owner-asserted tag on the same concept,
//     a confirmed face region, an owner's own annotation — all terminal;
//     the publisher no-ops rather than replace.
//   - RE-DERIVABLE: updates replace the enricher's own prior output in
//     place; wiping derived rows and re-running is always safe.

import type { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '../ids.js';
import { DOCUMENT_TARGET_TYPE, FOLDER_SCHEME_URI } from '../commands/documents.js';
import { VISION_SCHEME_URI } from '../schema/enrich.js';
import { assertPayload } from './payload-schemas.js';
import type { Publisher, PublishedWrite } from './staging.js';

/** Resolve a scheme by uri, creating it when absent (machine schemes). */
function ensureScheme(vault: DatabaseSync, uri: string, title: string): string {
  const existing = vault
    .prepare('SELECT scheme_id FROM core_concept_scheme WHERE uri = ?')
    .get(uri) as { scheme_id: string } | undefined;
  if (existing) return existing.scheme_id;
  const schemeId = uuidv7();
  vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version)
       VALUES (?, ?, ?, 'centraid', '1')`,
    )
    .run(schemeId, uri, title);
  return schemeId;
}

/** Resolve a concept by notation within a scheme, creating it when absent. */
function ensureConcept(
  vault: DatabaseSync,
  schemeId: string,
  notation: string,
  label: string,
): string {
  const existing = vault
    .prepare('SELECT concept_id FROM core_concept WHERE scheme_id = ? AND notation = ?')
    .get(schemeId, notation) as { concept_id: string } | undefined;
  if (existing) return existing.concept_id;
  const conceptId = uuidv7();
  vault
    .prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
    )
    .run(conceptId, schemeId, notation, label);
  return conceptId;
}

/** Lowercase-slug notation for a machine tag label. */
export function tagNotation(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'untitled'
  );
}

// ── knowledge.annotation (captions, summaries) ──────────────────────────

export interface AnnotationPayload {
  target_type: string;
  target_id: string;
  body: string;
  /** The enricher's agent party — injected by `sync.stage_rows`, never trusted from source data. */
  author_party_id: string;
}

const annotationPublisher: Publisher = {
  entityType: 'knowledge.annotation',
  probe(vault, payload) {
    // Read-only lookup — the runtime schema gate covers WRITE paths
    // (create/update, issue #374 Tier 3); probe never touches SQLite with
    // payload-derived values beyond a domain-native key lookup.
    const p = payload as unknown as AnnotationPayload;
    if (!p.author_party_id) return null;
    // One running caption per (author, target) — the replaceMemo semantic.
    const existing = vault
      .prepare(
        `SELECT annotation_id FROM knowledge_annotation
          WHERE target_type = ? AND target_id = ? AND author_party_id = ?`,
      )
      .get(p.target_type, p.target_id, p.author_party_id) as { annotation_id: string } | undefined;
    return existing
      ? { entityId: existing.annotation_id, disposition: 'update', note: 'replaces prior caption' }
      : null;
  },
  create(vault, _owner, payload, now) {
    const p = assertPayload<AnnotationPayload>('AnnotationPayload', payload);
    const author = vault
      .prepare('SELECT party_id FROM core_party WHERE party_id = ?')
      .get(p.author_party_id ?? '') as { party_id: string } | undefined;
    if (!author) {
      throw new Error('annotation has no author party — enrichment output must be attributed');
    }
    const annotationId = uuidv7();
    vault
      .prepare(
        `INSERT INTO knowledge_annotation (annotation_id, author_party_id, target_type, target_id, selector_json, body_text, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(annotationId, p.author_party_id, p.target_type, p.target_id, p.body, now);
    return { entityId: annotationId, wrote: [] };
  },
  update(vault, entityId, payload) {
    const p = assertPayload<AnnotationPayload>('AnnotationPayload', payload);
    // The enricher replaces only its OWN prior output — anyone else's
    // annotation on the same target (the owner's memo) is terminal.
    vault
      .prepare(
        'UPDATE knowledge_annotation SET body_text = ? WHERE annotation_id = ? AND author_party_id = ?',
      )
      .run(p.body, entityId, p.author_party_id ?? '');
    return { wrote: [] };
  },
};

// ── core.tag (machine scene/doctype tags) ───────────────────────────────

export interface TagPayload {
  target_type: string;
  target_id: string;
  /** Scheme uri — defaults to the vision scheme. */
  scheme_uri?: string;
  label: string;
  confidence: number;
}

const tagPublisher: Publisher = {
  entityType: 'core.tag',
  probe(vault, payload) {
    // Read-only lookup — see AnnotationPayload.probe's comment above.
    const p = payload as unknown as TagPayload;
    const row = vault
      .prepare(
        `SELECT t.tag_id, t.tagged_by_party_id FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = ? AND t.target_id = ? AND s.uri = ? AND c.notation = ?`,
      )
      .get(p.target_type, p.target_id, p.scheme_uri ?? VISION_SCHEME_URI, tagNotation(p.label)) as
      | { tag_id: string; tagged_by_party_id: string | null }
      | undefined;
    if (!row) return null;
    // An owner-asserted tag (carries a party) is terminal; a machine tag
    // updates its confidence in place.
    return row.tagged_by_party_id
      ? { entityId: row.tag_id, disposition: 'skip', note: 'owner-asserted tag is terminal' }
      : { entityId: row.tag_id, disposition: 'update', note: 'refreshes confidence' };
  },
  create(vault, _owner, payload, now) {
    const p = assertPayload<TagPayload>('TagPayload', payload);
    const uri = p.scheme_uri ?? VISION_SCHEME_URI;
    const schemeId = ensureScheme(vault, uri, 'Machine tags');
    const conceptId = ensureConcept(vault, schemeId, tagNotation(p.label), p.label);
    const tagId = uuidv7();
    vault
      .prepare(
        `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_by_party_id, confidence, tagged_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(tagId, p.target_type, p.target_id, conceptId, p.confidence, now);
    return { entityId: tagId, wrote: [] };
  },
  update(vault, entityId, payload, now) {
    const p = assertPayload<TagPayload>('TagPayload', payload);
    vault
      .prepare(
        `UPDATE core_tag SET confidence = ?, tagged_at = ?
          WHERE tag_id = ? AND tagged_by_party_id IS NULL`,
      )
      .run(p.confidence, now, entityId);
    return { wrote: [] };
  },
};

// ── media.face_region (face proposals) ──────────────────────────────────

export interface FaceRegionPayload {
  asset_id: string;
  /** Normalised 0..1 box: { x, y, w, h }. */
  bbox: Record<string, number>;
  /** Candidate person from the People match, when the model offered one. */
  party_id?: string;
  confidence: number;
}

const faceRegionPublisher: Publisher = {
  entityType: 'media.face_region',
  // No domain-native key: idempotency rides the external-id map — enrichers
  // key regions as `<asset_id>:face:<n>` so a re-run diffs, never duplicates.
  probe() {
    return null;
  },
  create(vault, _owner, payload) {
    const p = assertPayload<FaceRegionPayload>('FaceRegionPayload', payload);
    const asset = vault
      .prepare('SELECT asset_id FROM media_media_asset WHERE asset_id = ?')
      .get(p.asset_id) as { asset_id: string } | undefined;
    if (!asset) throw new Error(`face region names unknown asset ${p.asset_id}`);
    const regionId = uuidv7();
    vault
      .prepare(
        `INSERT INTO media_face_region (region_id, asset_id, bbox_json, party_id, confidence, confirmed_by_party_id)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(regionId, p.asset_id, JSON.stringify(p.bbox), p.party_id ?? null, p.confidence);
    return { entityId: regionId, wrote: [] };
  },
  update(vault, entityId, payload) {
    const p = assertPayload<FaceRegionPayload>('FaceRegionPayload', payload);
    // A confirmed region is the owner's word — the proposal never touches it.
    vault
      .prepare(
        `UPDATE media_face_region SET bbox_json = ?, party_id = ?, confidence = ?
          WHERE region_id = ? AND confirmed_by_party_id IS NULL`,
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
  entityType: 'core.collection',
  probe(vault, payload) {
    // Read-only lookup — see AnnotationPayload.probe's comment above.
    const p = payload as unknown as CollectionPayload;
    const existing = vault
      .prepare('SELECT collection_id FROM core_collection WHERE name = ?')
      .get(p.name) as { collection_id: string } | undefined;
    return existing
      ? {
          entityId: existing.collection_id,
          disposition: 'update',
          note: 'tops up an existing album',
        }
      : null;
  },
  create(vault, owner, payload, now) {
    const p = assertPayload<CollectionPayload>('CollectionPayload', payload);
    const collectionId = uuidv7();
    vault
      .prepare(
        `INSERT INTO core_collection (collection_id, owner_party_id, name, cover_content_id, parent_collection_id, sort_order, created_at)
         VALUES (?, ?, ?, NULL, NULL, 0, ?)`,
      )
      .run(collectionId, owner, p.name, now);
    const wrote = addEntries(vault, collectionId, p.members, now);
    return { entityId: collectionId, wrote };
  },
  update(vault, entityId, payload, now) {
    const p = assertPayload<CollectionPayload>('CollectionPayload', payload);
    // Top-up only: the proposal adds what is missing and never removes —
    // the owner may have curated the album since.
    return { wrote: addEntries(vault, entityId, p.members, now) };
  },
};

function addEntries(
  vault: DatabaseSync,
  collectionId: string,
  members: CollectionPayload['members'],
  now: string,
): PublishedWrite[] {
  const wrote: PublishedWrite[] = [];
  const max = vault
    .prepare(
      'SELECT COALESCE(MAX(position), -1) AS p FROM core_collection_entry WHERE collection_id = ?',
    )
    .get(collectionId) as { p: number };
  let position = max.p + 1;
  for (const member of members) {
    const exists = vault
      .prepare(
        `SELECT 1 AS x FROM core_collection_entry
          WHERE collection_id = ? AND target_type = ? AND target_id = ?`,
      )
      .get(collectionId, member.target_type, member.target_id);
    if (exists) continue;
    const entryId = uuidv7();
    vault
      .prepare(
        `INSERT INTO core_collection_entry (entry_id, collection_id, target_type, target_id, position, added_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(entryId, collectionId, member.target_type, member.target_id, position, now);
    position += 1;
    wrote.push({ type: 'core.collection_entry', id: entryId });
  }
  return wrote;
}

// ── core.content_item (filing / rename proposals) ───────────────────────

export interface FilingPayload {
  content_id: string;
  /** Proposed human-readable title, when the current one is a scan artifact. */
  title?: string;
  /** Proposed folder label — an existing folder matches by label, else a new one is created. */
  folder?: string;
}

const filingPublisher: Publisher = {
  entityType: 'core.content_item',
  probe(vault, payload) {
    // Read-only lookup — see AnnotationPayload.probe's comment above.
    const p = payload as unknown as FilingPayload;
    const existing = vault
      .prepare(
        'SELECT content_id FROM core_content_item WHERE content_id = ? AND deleted_at IS NULL',
      )
      .get(p.content_id ?? '') as { content_id: string } | undefined;
    if (!existing) return null;
    return { entityId: existing.content_id, disposition: 'update', note: 'filing proposal' };
  },
  create() {
    // Filing never mints documents — a proposal for a missing content item
    // fails per-row, honestly.
    throw new Error('core.content_item stages as filing updates only, never creates');
  },
  update(vault, entityId, payload, now) {
    const p = assertPayload<FilingPayload>('FilingPayload', payload);
    const wrote: PublishedWrite[] = [];
    // A wrapped content item's display title and folder tag live on its
    // core_document (issue #352) — the content item is the HEAD revision,
    // not the document's identity. Only the exact current head resolves;
    // filing never mints a document (create() above still throws), so a
    // proposal against a superseded revision or a still-unwrapped content
    // item falls back to tagging/renaming the content item directly.
    const doc = vault
      .prepare('SELECT document_id FROM core_document WHERE current_content_id = ?')
      .get(entityId) as { document_id: string } | undefined;
    const targetType = doc ? DOCUMENT_TARGET_TYPE : 'core.content_item';
    const targetId = doc ? doc.document_id : entityId;
    if (p.title) {
      vault
        .prepare(
          doc
            ? 'UPDATE core_document SET title = ? WHERE document_id = ?'
            : 'UPDATE core_content_item SET title = ? WHERE content_id = ?',
        )
        .run(p.title, targetId);
    }
    if (p.folder) {
      const schemeId = ensureScheme(vault, FOLDER_SCHEME_URI, 'Folders');
      const byLabel = vault
        .prepare(
          `SELECT concept_id FROM core_concept WHERE scheme_id = ? AND lower(pref_label) = lower(?)`,
        )
        .get(schemeId, p.folder) as { concept_id: string } | undefined;
      const conceptId =
        byLabel?.concept_id ?? ensureConcept(vault, schemeId, tagNotation(p.folder), p.folder);
      vault
        .prepare(
          `DELETE FROM core_tag
            WHERE target_type = ? AND target_id = ?
              AND concept_id IN (SELECT c.concept_id FROM core_concept c WHERE c.scheme_id = ?)`,
        )
        .run(targetType, targetId, schemeId);
      const tagId = uuidv7();
      vault
        .prepare(
          `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_by_party_id, confidence, tagged_at)
           VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .run(tagId, targetType, targetId, conceptId, now);
      wrote.push({ type: 'core.tag', id: tagId });
    }
    return { wrote };
  },
};

export const ENRICH_PUBLISHERS: readonly Publisher[] = [
  annotationPublisher,
  tagPublisher,
  faceRegionPublisher,
  collectionPublisher,
  filingPublisher,
];
