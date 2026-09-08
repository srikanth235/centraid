// A REVISION IS AN OCCURRENCE, NOT A CONTENT ID (#996, ruling R20(a)).
//
// Version lineage used to be a `revises` `core.link` between content items
// (NEW -> OLD), asserted wherever a wrapper repointed its canonical body. That
// made the CONTENT id the version id, so identity was taken from a value:
// two documents with identical bytes shared one history, A→B→A→B could not be
// expressed (the second A→B edge already existed and the live-edge index
// refused it), a restore could bring back a revision belonging to another
// object, and [#916]'s ONT-revisions ruling — "`core_entity_revision` is the
// only history table" — was enforced on storage and violated by five readers.
//
// An occurrence is its own immutable row in `core_entity_revision`: it names
// the content that BECAME current at that moment and the occurrence before it,
// and the wrapper points at the newest. Bytes stay deduped and shared;
// histories do not. A restore is a NEW occurrence even when its bytes already
// exist, which is exactly what "history is never rewritten" always meant.

import type { HandlerCtx } from "../gateway/types.js";

/**
 * A restore named a content item that is not in this object's own history
 * (#996, R20(a)). Typed, because "no such version" and "that version belongs
 * to something else" are different answers and only one of them is a bug in
 * the caller — while a version was a content id, the second was not even
 * detectable.
 */
export class ForeignRevisionError extends Error {
  constructor(
    readonly entityId: string,
    readonly contentId: string
  ) {
    super(
      `content ${contentId} is not a revision of ${entityId} — a revision belongs to one object`
    );
    this.name = "ForeignRevisionError";
  }
}

/** The wrappers that keep a body history: their table and their pointer. */
const WRAPPERS: Readonly<Record<string, { table: string; pk: string }>> = {
  "core.document": { table: "core_document", pk: "document_id" },
  "knowledge.note": { table: "knowledge_note", pk: "note_id" },
};

/** A body-history wrapper's current occurrence, or null before its first. */
export function currentRevisionOf(
  ctx: HandlerCtx,
  entityType: string,
  entityId: string
): string | null {
  const wrapper = WRAPPERS[entityType];
  if (!wrapper) throw new Error(`${entityType} keeps no body history`);
  const row = ctx.db
    .prepare(
      `SELECT current_revision_id FROM ${wrapper.table} WHERE ${wrapper.pk} = ?`
    )
    .get(entityId) as { current_revision_id: string | null } | undefined;
  return row?.current_revision_id ?? null;
}

/**
 * Record that `contentId` became the wrapper's current body, and return the
 * occurrence id the caller writes into `current_revision_id`.
 *
 * The caller repoints the wrapper itself — this only records the occurrence —
 * so a no-op edit (dedup lands back on the same content id) skips the call
 * rather than recording a revision that revised nothing.
 *
 * `snapshot_json` keeps the pre-mutation pointer, which is what every other
 * row of this table carries and what undo reads.
 */
export function recordBodyRevision(
  ctx: HandlerCtx,
  input: {
    entityType: string;
    entityId: string;
    contentId: string;
    previousContentId: string | null;
  }
): string {
  if (!WRAPPERS[input.entityType])
    throw new Error(`${input.entityType} keeps no body history`);
  const revisionId = ctx.newId();
  const parent = currentRevisionOf(ctx, input.entityType, input.entityId);
  ctx.db
    .prepare(
      `INSERT INTO core_entity_revision
         (revision_id, entity_type, entity_id, operation, snapshot_json,
          recorded_at, undo_until, undone_at, actor_party_id, invocation_id,
          content_id, parent_revision_id)
       VALUES (?, ?, ?, 'revise', ?, ?, ?, NULL, NULL, NULL, ?, ?)`
    )
    .run(
      revisionId,
      input.entityType,
      input.entityId,
      JSON.stringify({ previous_content_id: input.previousContentId }),
      ctx.now,
      ctx.now,
      input.contentId,
      parent
    );
  ctx.wrote("core.entity_revision", revisionId);
  return revisionId;
}

/**
 * Occurrences of one wrapper, newest first, walked from its current pointer.
 *
 * The walk is over `parent_revision_id`, never over content: a chain that
 * revisits the same bytes (A→B→A→B) is four distinct occurrences and reads as
 * four, which is the whole reason the graph stopped being keyed by content.
 * The step cap is the same defence the link walk needed and costs nothing.
 */
export function revisionChainOf(
  ctx: HandlerCtx,
  entityType: string,
  entityId: string
): { revisionId: string; contentId: string; recordedAt: string }[] {
  const chain: { revisionId: string; contentId: string; recordedAt: string }[] =
    [];
  const seen = new Set<string>();
  const read = ctx.db.prepare(
    `SELECT revision_id, content_id, recorded_at, parent_revision_id
       FROM core_entity_revision WHERE revision_id = ?`
  );
  let at = currentRevisionOf(ctx, entityType, entityId);
  for (let step = 0; at !== null && step < 500; step += 1) {
    if (seen.has(at)) break;
    seen.add(at);
    const row = read.get(at) as
      | {
          revision_id: string;
          content_id: string | null;
          recorded_at: string;
          parent_revision_id: string | null;
        }
      | undefined;
    if (!row || row.content_id === null) break;
    chain.push({
      revisionId: row.revision_id,
      contentId: row.content_id,
      recordedAt: row.recorded_at,
    });
    at = row.parent_revision_id;
  }
  return chain;
}
