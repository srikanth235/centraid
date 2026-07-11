// Version lineage (issue #352): a `revises` core.link between content items
// (NEW content item -> OLD content item), asserted wherever a wrapper
// repoints its canonical body — core.edit_document,
// core.replace_document_content, core.restore_document_version, and
// knowledge.edit_note (heals the notes/docs divergence: both wrappers now
// keep the same provenance trail). History is never rewritten (rule R3):
// restoring an old version asserts a NEW link forward, it never touches the
// old ones — the chain only ever grows.

import type { HandlerCtx } from '../gateway/types.js';
import { RELATIONS_SCHEME_URI } from './links.js';

export const REVISES_RELATION = 'revises';

/** The relations scheme, created on first use (mirrors links.ts's seed). */
function relationsSchemeId(ctx: HandlerCtx): string {
  const existing = ctx.db
    .prepare('SELECT scheme_id FROM core_concept_scheme WHERE uri = ?')
    .get(RELATIONS_SCHEME_URI) as { scheme_id: string } | undefined;
  if (existing) return existing.scheme_id;
  const schemeId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version)
       VALUES (?, ?, 'Link relation types', 'duaility', '1')`,
    )
    .run(schemeId, RELATIONS_SCHEME_URI);
  return schemeId;
}

/** The `revises` relation concept, created on first use. */
export function revisesConceptId(ctx: HandlerCtx): string {
  const schemeId = relationsSchemeId(ctx);
  const existing = ctx.db
    .prepare('SELECT concept_id FROM core_concept WHERE scheme_id = ? AND notation = ?')
    .get(schemeId, REVISES_RELATION) as { concept_id: string } | undefined;
  if (existing) return existing.concept_id;
  const conceptId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition)
       VALUES (?, ?, ?, 'Revises', NULL, NULL, 'A newer content item supersedes an older one — version lineage over canonical bodies')`,
    )
    .run(conceptId, schemeId, REVISES_RELATION);
  return conceptId;
}

/**
 * Record NEW content item -> OLD content item as a live `revises` link.
 * Callers repoint the wrapper's *_content_id column themselves — this only
 * asserts the history edge, so a no-op edit (dedup lands back on the same
 * content id) can skip the call entirely rather than link an id to itself.
 */
export function recordRevision(
  ctx: HandlerCtx,
  newContentId: string,
  oldContentId: string,
): string {
  const relationConceptId = revisesConceptId(ctx);
  const assertedBy =
    ctx.identity.kind === 'app' ? 'app' : ctx.identity.kind === 'agent' ? 'agent' : 'owner';
  const linkId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_link
         (link_id, from_type, from_id, to_type, to_id, relation_concept_id, valid_from, valid_to, asserted_by, provenance_id)
       VALUES (?, 'core.content_item', ?, 'core.content_item', ?, ?, ?, NULL, ?, NULL)`,
    )
    .run(linkId, newContentId, oldContentId, relationConceptId, ctx.now, assertedBy);
  ctx.wrote('core.link', linkId);
  return linkId;
}
