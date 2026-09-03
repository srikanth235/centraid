import type { DatabaseSync } from "node:sqlite";

import { enforceRevisionRetention } from "../gateway/revision-capture.js";
import type { HandlerCtx } from "../gateway/types.js";

const DEFAULT_UNDO_WINDOW_MS = 10_000;

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
    .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
    .get() as { self_party_id: string | null } | undefined;
  return owner?.self_party_id ?? null;
}

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
         recorded_at, undo_until, undone_at, actor_party_id, invocation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
    )
    .run(
      revisionId,
      input.entityType,
      input.entityId,
      input.operation,
      JSON.stringify(input.snapshot),
      ctx.now,
      undoUntil,
      actorPartyId(ctx),
      ctx.invocationId
    );
  ctx.wrote("core.entity_revision", revisionId);
  enforceRevisionRetention(ctx.db, input.entityType, input.entityId);
  return { revisionId, undoUntil };
}

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
  deleted: number;
  capped: boolean;
}

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
