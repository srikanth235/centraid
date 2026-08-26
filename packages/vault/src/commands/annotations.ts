// Owner memos (#274); txn_split.memo stays a column, not an annotation.

import type { HandlerCtx } from "../gateway/types.js";

function actorPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string | null } | undefined;
  if (!owner?.owner_party_id) throw new Error("vault has no owner");
  return owner.owner_party_id;
}

export function annotate(
  ctx: HandlerCtx,
  targetType: string,
  targetId: string,
  body: string
): void {
  const annotationId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO knowledge_annotation (annotation_id, author_party_id, target_type, target_id, selector_json, body_text, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`
    )
    .run(annotationId, actorPartyId(ctx), targetType, targetId, body, ctx.now);
  ctx.wrote("knowledge.annotation", annotationId);
}

/** One memo per actor per entity: set replaces, empty clears; others untouched. */
export function replaceMemo(
  ctx: HandlerCtx,
  targetType: string,
  targetId: string,
  body: string
): void {
  const author = actorPartyId(ctx);
  ctx.db
    .prepare(
      "DELETE FROM knowledge_annotation WHERE target_type = ? AND target_id = ? AND author_party_id = ?"
    )
    .run(targetType, targetId, author);
  if (body === "") return;
  annotate(ctx, targetType, targetId, body);
}
