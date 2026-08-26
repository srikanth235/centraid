// Owner flags (#274): an owner judgment about an entity is entity-scoped
// meaning → one flags-scheme tag on the CANONICAL entity in the universal
// classification join, never a per-domain boolean column (a column discards
// who flagged, when, UNIQUE integrity). Shared mechanism, not a command pack;
// bootstraps like folders; "Favorite" rides along as a SKOS altLabel.

import type { DatabaseSync } from "node:sqlite";

import type { HandlerCtx } from "../gateway/types.js";

// An https URI, not a urn: flag SQL fragments interpolate into condition SQL,
// where `:flags` reads as a named parameter (#258 colon-literal trap); no
// parameter name can start with a slash.
export const FLAGS_SCHEME_URI = "https://centraid.dev/schemes/flags";

export const STARRED_NOTATION = "starred";

/** The acting party: the caller's own party, else the vault owner (apps). */
function actorPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string | null } | undefined;
  if (!owner?.owner_party_id) throw new Error("vault has no owner");
  return owner.owner_party_id;
}

/** What flagging needs OUTSIDE the command pipeline (#721): publishers hold a
 *  raw DatabaseSync, not a HandlerCtx. actorPartyId is a thunk so an ownerless
 *  vault can still CLEAR a flag (party resolved only where written). */
export interface FlagWriteDeps {
  vault: DatabaseSync;
  now: string;
  newId: () => string;
  wrote: (entityType: string, entityId: string) => void;
  actorPartyId: () => string;
}

/** The flags scheme, created on first use. */
function flagsSchemeIdTx(deps: FlagWriteDeps): string {
  const existing = deps.vault
    .prepare("SELECT scheme_id FROM core_concept_scheme WHERE uri = ?")
    .get(FLAGS_SCHEME_URI) as { scheme_id: string } | undefined;
  if (existing) return existing.scheme_id;
  const schemeId = deps.newId();
  deps.vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version)
       VALUES (?, ?, 'Flags', 'centraid', '1')`
    )
    .run(schemeId, FLAGS_SCHEME_URI);
  return schemeId;
}

/** The `starred` concept, created on first use. */
function starredConceptIdTx(deps: FlagWriteDeps): string {
  const schemeId = flagsSchemeIdTx(deps);
  const existing = deps.vault
    .prepare(
      "SELECT concept_id FROM core_concept WHERE scheme_id = ? AND notation = ?"
    )
    .get(schemeId, STARRED_NOTATION) as { concept_id: string } | undefined;
  if (existing) return existing.concept_id;
  const conceptId = deps.newId();
  deps.vault
    .prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition)
       VALUES (?, ?, ?, 'Starred', '["Favorite"]', NULL, 'Owner attention: one star across every surface')`
    )
    .run(conceptId, schemeId, STARRED_NOTATION);
  return conceptId;
}

/** Set/clear `starred`; delete-then-insert keeps it idempotent and refreshes
 *  who-starred-when on re-star. */
export function setStarredTx(
  deps: FlagWriteDeps,
  targetType: string,
  targetId: string,
  starred: boolean
): void {
  const conceptId = starredConceptIdTx(deps);
  deps.vault
    .prepare(
      "DELETE FROM core_tag WHERE target_type = ? AND target_id = ? AND concept_id = ?"
    )
    .run(targetType, targetId, conceptId);
  if (!starred) return;
  const tagId = deps.newId();
  deps.vault
    .prepare(
      `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_by_party_id, confidence, tagged_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`
    )
    .run(tagId, targetType, targetId, conceptId, deps.actorPartyId(), deps.now);
  deps.wrote("core.tag", tagId);
}

function flagDepsOf(ctx: HandlerCtx): FlagWriteDeps {
  return {
    vault: ctx.db,
    now: ctx.now,
    newId: () => ctx.newId(),
    wrote: (entityType, entityId) => {
      ctx.wrote(entityType, entityId);
    },
    actorPartyId: () => actorPartyId(ctx),
  };
}

/** `setStarredTx` for a command handler. */
export function setStarred(
  ctx: HandlerCtx,
  targetType: string,
  targetId: string,
  starred: boolean
): void {
  setStarredTx(flagDepsOf(ctx), targetType, targetId, starred);
}

/**
 * Condition fragment: a live starred tag exists on (targetType, targetIdSql).
 * targetIdSql is a SQL expression (named parameter or subquery), never caller
 * data.
 */
export function starredExistsSql(
  targetType: string,
  targetIdSql: string
): string {
  return `EXISTS(SELECT 1 FROM core_tag t
            JOIN core_concept c ON c.concept_id = t.concept_id
            JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
           WHERE t.target_type = '${targetType}' AND t.target_id = ${targetIdSql}
             AND s.uri = '${FLAGS_SCHEME_URI}' AND c.notation = '${STARRED_NOTATION}')`;
}
