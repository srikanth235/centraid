import type { DatabaseSync } from "node:sqlite";

export const RETENTION_ROW_CAP = 5_000;

export const RETENTION_DEFAULT_KEEP_DAYS = 90;

export type RetentionTable =
  | "sync_connection_run"
  | "enrich_request"
  | "outbox_item";

export interface RetentionTableResult {
  deleted: number;
  capped: boolean;
}

export type RetentionSweepResult = Record<RetentionTable, RetentionTableResult>;

export interface RetentionSweepOptions {
  now: string;
  keepDays?: number;
  limit?: number;
}

const POLICIES: Record<
  RetentionTable,
  { idColumn: string; eligibleSql: string }
> = {
  sync_connection_run: {
    idColumn: "run_id",
    eligibleSql: `SELECT r.run_id AS id FROM sync_connection_run r
                   WHERE r.status <> 'running'
                     AND r.finished_at IS NOT NULL
                     AND r.finished_at < :cutoff
                     AND r.run_id <> (
                       SELECT n.run_id FROM sync_connection_run n
                        WHERE n.connection_id = r.connection_id
                        ORDER BY n.started_at DESC, n.run_id DESC LIMIT 1
                     )
                   ORDER BY r.finished_at
                   LIMIT :limit`,
  },
  enrich_request: {
    idColumn: "request_id",
    eligibleSql: `SELECT request_id AS id FROM enrich_request
                   WHERE drained_at IS NOT NULL AND drained_at < :cutoff
                   ORDER BY drained_at
                   LIMIT :limit`,
  },
  outbox_item: {
    idColumn: "item_id",
    eligibleSql: `SELECT item_id AS id FROM outbox_item
                   WHERE status IN ('sent','discarded')
                     AND decided_at IS NOT NULL AND decided_at < :cutoff
                   ORDER BY decided_at
                   LIMIT :limit`,
  },
};

function isoDaysBefore(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

function pruneTable(
  vault: DatabaseSync,
  table: RetentionTable,
  cutoff: string,
  limit: number
): RetentionTableResult {
  const policy = POLICIES[table];
  const info = vault
    .prepare(
      `DELETE FROM ${table}
        WHERE ${policy.idColumn} IN (${policy.eligibleSql})`
    )
    .run({ cutoff, limit });
  const deleted = Number(info.changes);
  return { deleted, capped: deleted >= limit };
}

export function sweepBoundedRetention(
  vault: DatabaseSync,
  options: RetentionSweepOptions
): RetentionSweepResult {
  const keepDays = options.keepDays ?? RETENTION_DEFAULT_KEEP_DAYS;
  if (keepDays < 0) throw new Error("retention keepDays must not be negative");
  const limit = options.limit ?? RETENTION_ROW_CAP;
  if (limit <= 0) throw new Error("retention limit must be > 0");
  const cutoff = isoDaysBefore(options.now, keepDays);
  return {
    sync_connection_run: pruneTable(
      vault,
      "sync_connection_run",
      cutoff,
      limit
    ),
    enrich_request: pruneTable(vault, "enrich_request", cutoff, limit),
    outbox_item: pruneTable(vault, "outbox_item", cutoff, limit),
  };
}
