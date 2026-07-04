// Owner memos (issue #274): one gesture, one mechanism. A free-text remark
// about an entity — "met at Ravi's wedding" on a person, "felt strong" on a
// run — is entity-scoped meaning, so it lives in knowledge.annotation keyed
// to the canonical entity (the mechanism's own stated example is "a note
// about a transaction"), never a per-domain prose column. "Everything I've
// written about Ravi" becomes one query. txn_split.memo deliberately stays a
// column: it describes the split row itself, not an independent entity.
//
// Not a command pack: these are the shared mechanism the domain packs
// (social, health, business) write through, exactly like flags.ts.

import type { HandlerCtx } from '../gateway/types.js';

/** The acting party: the caller's own party, else the vault owner (apps). */
function actorPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  return owner.owner_party_id;
}

/** Append a memo annotation on a canonical entity (create-time notes). */
export function annotate(ctx: HandlerCtx, targetType: string, targetId: string, body: string): void {
  const annotationId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO knowledge_annotation (annotation_id, author_party_id, target_type, target_id, selector_json, body_text, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(annotationId, actorPartyId(ctx), targetType, targetId, body, ctx.now);
  ctx.wrote('knowledge.annotation', annotationId);
}

/**
 * The running-memo surface semantic (a contact card's note field): the
 * actor keeps ONE memo per entity — setting replaces it, an empty body
 * clears it. Other authors' annotations on the same entity are untouched.
 */
export function replaceMemo(
  ctx: HandlerCtx,
  targetType: string,
  targetId: string,
  body: string,
): void {
  const author = actorPartyId(ctx);
  ctx.db
    .prepare(
      'DELETE FROM knowledge_annotation WHERE target_type = ? AND target_id = ? AND author_party_id = ?',
    )
    .run(targetType, targetId, author);
  if (body === '') return;
  annotate(ctx, targetType, targetId, body);
}
