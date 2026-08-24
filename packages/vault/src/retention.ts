// Bounded retention for the vault's silent growers (#659).
//
// Three tables append a row per event forever and have no reader past a few
// days. None of them is a fact the owner authored, and none is custody
// evidence — the durable audit trail is the journal, which has its own
// archival engine (journal-archive.ts):
//
//   - `sync_connection_run` — one row per connector sync, every sync, since
//     the connection was made. The UI shows the last run; a two-year-old
//     "ok, 3 staged" row is read by nothing.
//   - `enrich_request` — the on-demand enrichment queue (schema/enrich.ts).
//     A DRAINED request is a finished job; the enrichment it produced lives
//     in the target row, not here.
//   - `outbox_item` — the external-write consent surface (schema/outbox.ts).
//     A `sent` or `discarded` item is decided; the artifact it became is a
//     social_message (published_message_id) or nothing.
//
// The invariant every policy below obeys: **only terminal rows, and never the
// newest evidence a surface still shows.** An in-flight sync (`running`), an
// undrained or leased enrichment request, and a `pending` / `approved` /
// `failed` outbox item are all live obligations — a retention pass that ate
// one would silently drop work the owner is waiting on, so each policy's
// predicate names its terminal states explicitly rather than filtering by age
// alone. `sync_connection_run` additionally pins the newest run per
// connection whatever its age, so "last synced" never blanks on a connector
// the owner has not used in a year.
//
// Every pass is capped (`limit`) and driven off an existing index, so its
// cost is the rows it deletes rather than the size of the table, and a vault
// that has never pruned drains over several sweeps instead of stalling one.

import type { DatabaseSync } from "node:sqlite";

/** Rows one table may shed per pass. */
export const RETENTION_ROW_CAP = 5_000;

/** Terminal rows older than this many days are eligible. */
export const RETENTION_DEFAULT_KEEP_DAYS = 90;

export type RetentionTable =
  | "sync_connection_run"
  | "enrich_request"
  | "outbox_item";

export interface RetentionTableResult {
  deleted: number;
  /** `true` when the cap stopped the pass — run it again to keep draining. */
  capped: boolean;
}

export type RetentionSweepResult = Record<RetentionTable, RetentionTableResult>;

export interface RetentionSweepOptions {
  /** ISO instant the cutoff is measured back from. */
  now: string;
  /** Terminal-row grace window. Default `RETENTION_DEFAULT_KEEP_DAYS`. */
  keepDays?: number;
  /** Rows a single table may delete this pass. Default `RETENTION_ROW_CAP`. */
  limit?: number;
}

/**
 * One policy per table: the id column, and the SELECT that names ONLY
 * terminal rows past the cutoff. Kept as a table (not a switch) so a new
 * grower is a row here and its predicate is reviewable beside its peers.
 */
const POLICIES: Record<
  RetentionTable,
  { idColumn: string; eligibleSql: string }
> = {
  // Terminal = the run finished. The newest run per connection is pinned
  // whatever its age: it is what "last synced" reads.
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
  // Terminal = drained. An open request (drained_at IS NULL) is queued work,
  // leased or not, and is never eligible.
  enrich_request: {
    idColumn: "request_id",
    eligibleSql: `SELECT request_id AS id FROM enrich_request
                   WHERE drained_at IS NOT NULL AND drained_at < :cutoff
                   ORDER BY drained_at
                   LIMIT :limit`,
  },
  // Terminal = the owner decided AND the executor is done with it. `pending`
  // and `approved` are undrained obligations; `failed` stays for the owner to
  // see and retry.
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

/**
 * Shed terminal rows from every silent grower, capped per table. Safe to run
 * on any cadence: a pass with nothing eligible reads three indexes and writes
 * nothing.
 */
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
