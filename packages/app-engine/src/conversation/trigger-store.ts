import type { DatabaseProvider } from '../stores/gateway-db.js';

export interface AutomationTriggerCursor {
  automationId: string;
  triggerIndex: number;
  sourceKind: string;
  positionJson?: string;
  /** Engine-owned write-ahead fire receipt; never handed to a source reader. */
  pendingJson?: string;
  windowFrom?: number;
  windowTo?: number;
  skipped: number;
  gapReason?: string;
  updatedAt: number;
}

export interface PutAutomationTriggerCursor {
  automationId: string;
  triggerIndex: number;
  sourceKind: string;
  positionJson?: string;
  pendingJson?: string;
  windowFrom?: number;
  windowTo?: number;
  skipped?: number;
  gapReason?: string;
  updatedAt: number;
}

export interface TriggerIngressRecord {
  id: number;
  source: 'webhook' | 'poll';
  sourceKey: string;
  deliveryId: string;
  receivedAt: number;
  payloadJson?: string;
  payloadRef?: string;
  expiresAt: number;
}

export interface AppendTriggerIngress {
  source: 'webhook' | 'poll';
  sourceKey: string;
  deliveryId: string;
  receivedAt: number;
  payloadJson?: string;
  payloadRef?: string;
  expiresAt: number;
}

export interface TriggerIngressBounds {
  count: number;
  latestId?: number;
}

/** One declared `(automation, trigger index)` slot whose cursor must survive. */
export interface CursorRetentionKey {
  automationId: string;
  triggerIndex: number;
}

/** Deliveries retention removed, per source, so the reader can account for them. */
export interface TriggerIngressGap {
  sourceKey: string;
  pruned: number;
  /** Highest ingress id retention removed — a cursor at or below it lost data. */
  throughId: number;
}

export interface PruneIngressResult {
  deleted: number;
  gaps: TriggerIngressGap[];
}

interface CursorRow {
  automation_id: string;
  trigger_index: number;
  source_kind: string;
  position_json: string | null;
  pending_json: string | null;
  window_from: number | null;
  window_to: number | null;
  skipped: number;
  gap_reason: string | null;
  updated_at: number;
}

interface IngressRow {
  id: number;
  source: 'webhook' | 'poll';
  source_key: string;
  delivery_id: string;
  received_at: number;
  payload_json: string | null;
  payload_ref: string | null;
  expires_at: number;
}

function mapCursor(row: CursorRow): AutomationTriggerCursor {
  return {
    automationId: row.automation_id,
    triggerIndex: row.trigger_index,
    sourceKind: row.source_kind,
    ...(row.position_json !== null ? { positionJson: row.position_json } : {}),
    ...(row.pending_json !== null ? { pendingJson: row.pending_json } : {}),
    ...(row.window_from !== null ? { windowFrom: row.window_from } : {}),
    ...(row.window_to !== null ? { windowTo: row.window_to } : {}),
    skipped: row.skipped,
    ...(row.gap_reason !== null ? { gapReason: row.gap_reason } : {}),
    updatedAt: row.updated_at,
  };
}

function mapIngress(row: IngressRow): TriggerIngressRecord {
  return {
    id: row.id,
    source: row.source,
    sourceKey: row.source_key,
    deliveryId: row.delivery_id,
    receivedAt: row.received_at,
    ...(row.payload_json !== null ? { payloadJson: row.payload_json } : {}),
    ...(row.payload_ref !== null ? { payloadRef: row.payload_ref } : {}),
    expiresAt: row.expires_at,
  };
}

/** Durable cursor + authenticated ingress access for the automation engine. */
export class AutomationTriggerStore {
  constructor(private readonly dbProvider: DatabaseProvider) {}

  getCursor(automationId: string, triggerIndex: number): AutomationTriggerCursor | undefined {
    const row = this.dbProvider()
      .prepare(
        `SELECT automation_id, trigger_index, source_kind, position_json, pending_json,
                window_from, window_to, skipped, gap_reason, updated_at
           FROM automation_trigger_cursor
          WHERE automation_id = ? AND trigger_index = ?`,
      )
      .get(automationId, triggerIndex) as unknown as CursorRow | undefined;
    return row ? mapCursor(row) : undefined;
  }

  putCursor(input: PutAutomationTriggerCursor): void {
    this.dbProvider()
      .prepare(
        `INSERT INTO automation_trigger_cursor
           (automation_id, trigger_index, source_kind, position_json, pending_json,
            window_from, window_to, skipped, gap_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(automation_id, trigger_index) DO UPDATE SET
           source_kind = excluded.source_kind,
           position_json = excluded.position_json,
           pending_json = excluded.pending_json,
           window_from = excluded.window_from,
           window_to = excluded.window_to,
           skipped = excluded.skipped,
           gap_reason = excluded.gap_reason,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.automationId,
        input.triggerIndex,
        input.sourceKind,
        input.positionJson ?? null,
        input.pendingJson ?? null,
        input.windowFrom ?? null,
        input.windowTo ?? null,
        input.skipped ?? 0,
        input.gapReason ?? null,
        input.updatedAt,
      );
  }

  /**
   * Drop cursors for trigger slots the desired set no longer declares.
   *
   * Retention is per `(automation, trigger index)`: shrinking an automation's
   * trigger list from three to one must not leave positions at index 1–2 that
   * a later same-kind trigger would resurrect. An EMPTY retention set is a
   * no-op, not a wipe — a transient empty listing (a git-store worktree swap,
   * or every automation disabled) must never destroy the watermarks that make
   * re-enabling lossless.
   */
  deleteCursorsNotIn(retained: readonly CursorRetentionKey[]): number {
    if (retained.length === 0) return 0;
    const placeholders = retained.map(() => '(?, ?)').join(',');
    return Number(
      this.dbProvider()
        .prepare(
          `DELETE FROM automation_trigger_cursor
            WHERE (automation_id, trigger_index) NOT IN (VALUES ${placeholders})`,
        )
        .run(...retained.flatMap((entry) => [entry.automationId, entry.triggerIndex])).changes,
    );
  }

  /**
   * Durably record one delivery, deduplicating on
   * `(source, source_key, delivery_id)`. The insert and the id lookup share one
   * transaction: a concurrent `pruneIngress` on another connection must not be
   * able to delete the row between them and make a stored delivery look
   * rejected.
   */
  appendIngress(input: AppendTriggerIngress): { inserted: boolean; id: number } {
    const db = this.dbProvider();
    // SAVEPOINT (not BEGIN) so this nests safely inside a caller's transaction
    // — journal.db is one connection shared with the conversation store.
    db.prepare('SAVEPOINT append_ingress').run();
    try {
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO trigger_ingress
             (source, source_key, delivery_id, received_at, payload_json, payload_ref, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.source,
          input.sourceKey,
          input.deliveryId,
          input.receivedAt,
          input.payloadJson ?? null,
          input.payloadRef ?? null,
          input.expiresAt,
        );
      const row = db
        .prepare(
          `SELECT id FROM trigger_ingress
            WHERE source = ? AND source_key = ? AND delivery_id = ?`,
        )
        .get(input.source, input.sourceKey, input.deliveryId) as unknown as
        | { id: number }
        | undefined;
      if (!row) {
        throw new Error(
          `trigger ingress ${input.source}/${input.sourceKey}/${input.deliveryId} vanished inside its own transaction`,
        );
      }
      const appended = { inserted: Number(result.changes) > 0, id: Number(row.id) };
      db.prepare('RELEASE append_ingress').run();
      return appended;
    } catch (error) {
      db.prepare('ROLLBACK TO append_ingress').run();
      throw error;
    }
  }

  listIngressAfter(sourceKey: string, afterId: number, limit: number): TriggerIngressRecord[] {
    return (
      this.dbProvider()
        .prepare(
          `SELECT id, source, source_key, delivery_id, received_at,
                  payload_json, payload_ref, expires_at
             FROM trigger_ingress
            WHERE source_key = ? AND id > ?
            ORDER BY id ASC
            LIMIT ?`,
        )
        .all(sourceKey, afterId, limit) as unknown as IngressRow[]
    ).map(mapIngress);
  }

  ingressBoundsAfter(sourceKey: string, afterId: number): TriggerIngressBounds {
    const row = this.dbProvider()
      .prepare(
        `SELECT COUNT(*) AS count, MAX(id) AS latest_id
           FROM trigger_ingress
          WHERE source_key = ? AND id > ?`,
      )
      .get(sourceKey, afterId) as unknown as { count: number; latest_id: number | null };
    return {
      count: Number(row.count),
      ...(row.latest_id !== null ? { latestId: Number(row.latest_id) } : {}),
    };
  }

  /**
   * Drop deliveries past their retention TTL and REPORT what that cost.
   *
   * An automation stalled longer than the TTL loses those deliveries; every
   * other gap in this design is accounted for, so this one is too. The store
   * cannot map a `source_key` onto the automation cursor that reads it (the
   * position encoding belongs to the reader), so the loss is returned per
   * source and the reader folds it into its `skipped` / `gapReason`.
   */
  pruneIngress(now: number): PruneIngressResult {
    const db = this.dbProvider();
    // One savepoint: the reported gap must describe exactly the rows deleted.
    db.prepare('SAVEPOINT prune_ingress').run();
    try {
      const gaps = (
        db
          .prepare(
            `SELECT source_key, COUNT(*) AS pruned, MAX(id) AS through_id
               FROM trigger_ingress
              WHERE expires_at <= ?
              GROUP BY source_key`,
          )
          .all(now) as unknown as {
          source_key: string;
          pruned: number;
          through_id: number;
        }[]
      ).map((row) => ({
        sourceKey: row.source_key,
        pruned: Number(row.pruned),
        throughId: Number(row.through_id),
      }));
      const deleted = Number(
        db.prepare('DELETE FROM trigger_ingress WHERE expires_at <= ?').run(now).changes,
      );
      db.prepare('RELEASE prune_ingress').run();
      return { deleted, gaps };
    } catch (error) {
      db.prepare('ROLLBACK TO prune_ingress').run();
      throw error;
    }
  }
}
