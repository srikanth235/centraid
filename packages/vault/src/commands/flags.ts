import type { DatabaseSync } from "node:sqlite";

import type { HandlerCtx } from "../gateway/types.js";

export const FLAGS_SCHEME_URI = "https://centraid.dev/schemes/flags";

export const STARRED_NOTATION = "starred";

function actorPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db
    .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
    .get() as { self_party_id: string | null } | undefined;
  if (!owner?.self_party_id) throw new Error("vault has no owner");
  return owner.self_party_id;
}

export interface FlagWriteDeps {
  vault: DatabaseSync;
  now: string;
  newId: () => string;
  wrote: (entityType: string, entityId: string) => void;
  actorPartyId: () => string;
}

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

export function setStarred(
  ctx: HandlerCtx,
  targetType: string,
  targetId: string,
  starred: boolean
): void {
  setStarredTx(flagDepsOf(ctx), targetType, targetId, starred);
}

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
