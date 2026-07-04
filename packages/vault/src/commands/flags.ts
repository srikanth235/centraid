// Owner flags (issue #274): one judgment, one mechanism. An owner judgment
// about an entity — starred today, more flags later — is entity-scoped
// meaning, so it lives in the universal classification join: one flags-scheme
// tag on the CANONICAL entity, never a per-domain boolean column. A column
// silently discards what the tag keeps for free (who flagged, when, and
// UNIQUE(target,concept) integrity). The scheme bootstraps on first use
// exactly like the folders scheme; `starred` carries "Favorite" as a SKOS
// altLabel, resolving the star/favorite synonymy the app silos never did.
//
// Not a command pack: these are the shared mechanism the domain packs
// (documents, social, media) write through, the way knowledge.ts borrows
// releaseContentIfUnreferenced from media.ts.

import type { HandlerCtx } from '../gateway/types.js';

// An https URI, not a urn: one — flag SQL fragments interpolate into
// condition SQL, where `:flags` would read as a named parameter (the
// issue-258 colon-literal trap); `https://` survives because no parameter
// name can start with a slash.
export const FLAGS_SCHEME_URI = 'https://centraid.dev/schemes/flags';

export const STARRED_NOTATION = 'starred';

/** The acting party: the caller's own party, else the vault owner (apps). */
function actorPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  return owner.owner_party_id;
}

/** The flags scheme, created on first use. */
function flagsSchemeId(ctx: HandlerCtx): string {
  const existing = ctx.db
    .prepare('SELECT scheme_id FROM core_concept_scheme WHERE uri = ?')
    .get(FLAGS_SCHEME_URI) as { scheme_id: string } | undefined;
  if (existing) return existing.scheme_id;
  const schemeId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version)
       VALUES (?, ?, 'Flags', 'centraid', '1')`,
    )
    .run(schemeId, FLAGS_SCHEME_URI);
  return schemeId;
}

/** The `starred` concept, created on first use. */
export function starredConceptId(ctx: HandlerCtx): string {
  const schemeId = flagsSchemeId(ctx);
  const existing = ctx.db
    .prepare('SELECT concept_id FROM core_concept WHERE scheme_id = ? AND notation = ?')
    .get(schemeId, STARRED_NOTATION) as { concept_id: string } | undefined;
  if (existing) return existing.concept_id;
  const conceptId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition)
       VALUES (?, ?, ?, 'Starred', '["Favorite"]', NULL, 'Owner attention: one star across every surface')`,
    )
    .run(conceptId, schemeId, STARRED_NOTATION);
  return conceptId;
}

/**
 * Set or clear the starred flag on a canonical entity. Delete-then-insert:
 * idempotent, and re-starring refreshes who starred and when.
 */
export function setStarred(
  ctx: HandlerCtx,
  targetType: string,
  targetId: string,
  starred: boolean,
): void {
  const conceptId = starredConceptId(ctx);
  ctx.db
    .prepare('DELETE FROM core_tag WHERE target_type = ? AND target_id = ? AND concept_id = ?')
    .run(targetType, targetId, conceptId);
  if (!starred) return;
  const tagId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_by_party_id, confidence, tagged_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(tagId, targetType, targetId, conceptId, actorPartyId(ctx), ctx.now);
  ctx.wrote('core.tag', tagId);
}

/**
 * Condition fragment: a live starred tag exists on (targetType, targetIdSql).
 * targetIdSql is a SQL expression (a named parameter or subquery), never
 * caller data.
 */
export function starredExistsSql(targetType: string, targetIdSql: string): string {
  return `EXISTS(SELECT 1 FROM core_tag t
            JOIN core_concept c ON c.concept_id = t.concept_id
            JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
           WHERE t.target_type = '${targetType}' AND t.target_id = ${targetIdSql}
             AND s.uri = '${FLAGS_SCHEME_URI}' AND c.notation = '${STARRED_NOTATION}')`;
}
