// Shared "never lose anything" store contract (P5, #630).
//
// A domain records its exact pre-mutation snapshot in the same transaction as
// the canonical write. Domain-owned undo commands validate and apply snapshots
// because only the domain knows its invariants; this module owns the common
// durable envelope, one-shot marking, and ten-second immediate undo window.

import type { DatabaseSync } from "node:sqlite";

import type { HandlerCtx } from "../gateway/types.js";

const DEFAULT_UNDO_WINDOW_MS = 10_000;

/**
 * Rows deleted by one `pruneExpiredEntityRevisions` pass (#659).
 * Bounded like every other retention pass so a vault that has never pruned
 * does not turn its first sweep into a multi-second stall.
 */
export const ENTITY_REVISION_PRUNE_CAP = 5_000;

export interface EntityRevision<T = unknown> {
  revisionId: string;
  entityType: string;
  entityId: string;
  operation: string;
  snapshot: T;
  recordedAt: string;
  undoUntil: string;
  undoneAt: string | null;
}

function actorPartyId(ctx: HandlerCtx): string | null {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string | null } | undefined;
  return owner?.owner_party_id ?? null;
}

/** Append a pre-mutation snapshot and return its stable undo/history id. */
export function recordEntityRevision(
  ctx: HandlerCtx,
  input: {
    entityType: string;
    entityId: string;
    operation: string;
    snapshot: unknown;
    undoWindowMs?: number;
  }
): { revisionId: string; undoUntil: string } {
  const revisionId = ctx.newId();
  const undoUntil = new Date(
    Date.parse(ctx.now) + (input.undoWindowMs ?? DEFAULT_UNDO_WINDOW_MS)
  ).toISOString();
  ctx.db
    .prepare(
      `INSERT INTO core_entity_revision
        (revision_id, entity_type, entity_id, operation, snapshot_json,
         recorded_at, undo_until, undone_at, actor_party_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    )
    .run(
      revisionId,
      input.entityType,
      input.entityId,
      input.operation,
      JSON.stringify(input.snapshot),
      ctx.now,
      undoUntil,
      actorPartyId(ctx)
    );
  ctx.wrote("core.entity_revision", revisionId);
  return { revisionId, undoUntil };
}

/** Load one unconsumed domain revision, defaulting to the newest. */
export function loadEntityRevision<T>(
  ctx: HandlerCtx,
  input: {
    entityType: string;
    entityId: string;
    revisionId?: string;
  }
): EntityRevision<T> {
  const row = ctx.db
    .prepare(
      `SELECT revision_id, entity_type, entity_id, operation, snapshot_json,
              recorded_at, undo_until, undone_at
         FROM core_entity_revision
        WHERE entity_type = ? AND entity_id = ?
          AND (? IS NULL OR revision_id = ?)
          AND undone_at IS NULL
          AND undo_until >= ?
        ORDER BY recorded_at DESC, revision_id DESC
        LIMIT 1`
    )
    .get(
      input.entityType,
      input.entityId,
      input.revisionId ?? null,
      input.revisionId ?? null,
      ctx.now
    ) as
    | {
        revision_id: string;
        entity_type: string;
        entity_id: string;
        operation: string;
        snapshot_json: string;
        recorded_at: string;
        undo_until: string;
        undone_at: string | null;
      }
    | undefined;
  if (!row) throw new Error("revision not found, expired, or already undone");
  return {
    revisionId: row.revision_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation,
    snapshot: JSON.parse(row.snapshot_json) as T,
    recordedAt: row.recorded_at,
    undoUntil: row.undo_until,
    undoneAt: row.undone_at,
  };
}

/** Mark a successfully applied revision one-shot in the same transaction. */
export function markEntityRevisionUndone(
  ctx: HandlerCtx,
  revisionId: string
): void {
  const changed = ctx.db
    .prepare(
      `UPDATE core_entity_revision
          SET undone_at = ?
        WHERE revision_id = ? AND undone_at IS NULL`
    )
    .run(ctx.now, revisionId);
  if (changed.changes !== 1)
    throw new Error("revision not found or already undone");
  ctx.wrote("core.entity_revision", revisionId);
}

export interface EntityRevisionPruneResult {
  /** Rows deleted on this pass. */
  deleted: number;
  /** `true` when the cap stopped the pass — run it again to keep draining. */
  capped: boolean;
}

/**
 * Drop revisions whose undo window has closed (#659).
 *
 * Every mutation in the P5 store contract writes a FULL-ROW JSON snapshot
 * here, and the only reader — `loadEntityRevision` — refuses anything with
 * `undo_until < now`. So past the ten-second window a snapshot is already
 * unreadable through the store's own API; retaining it forever grows the
 * vault (and every backup that ships it) with rows nothing can ever return.
 * Deleting exactly those rows is therefore invisible to callers: this is a
 * garbage collector, not a retention policy.
 *
 * Bounded per run (`limit`, default `ENTITY_REVISION_PRUNE_CAP`) and driven
 * by `core_entity_revision_undo_idx`, so the cost of one pass is the rows it
 * deletes rather than the size of the table. `capped` tells a sweep it has
 * more to drain.
 */
export function pruneExpiredEntityRevisions(
  vault: DatabaseSync,
  now: string,
  options: { limit?: number } = {}
): EntityRevisionPruneResult {
  const limit = options.limit ?? ENTITY_REVISION_PRUNE_CAP;
  if (limit <= 0) throw new Error("entity revision prune limit must be > 0");
  const info = vault
    .prepare(
      `DELETE FROM core_entity_revision
        WHERE revision_id IN (
          SELECT revision_id FROM core_entity_revision
           WHERE undo_until < ?
           ORDER BY undo_until
           LIMIT ?
        )`
    )
    .run(now, limit);
  const deleted = Number(info.changes);
  return { deleted, capped: deleted >= limit };
}
