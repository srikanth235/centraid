/*
 * THE SEAT'S SEARCH (#996, ruling W5-D1).
 *
 * Search stays ON THE SEAT. Wave 2 kept the vault's FTS sync triggers in the
 * copied file and rebuilds the index after the bootstrap copy, so a seat's
 * `vault.db` already carries `fts_<table>` beside every text-bearing table —
 * the same shadow tables, built by the same DDL, tokenised the same way. There
 * is nothing to re-index and nothing to invent: the statement below is the one
 * the gateway runs, over the member's own file.
 *
 * ONE STATEMENT, ASSEMBLED HERE, FOR THE SAME THREE ENDS `statement.ts`
 * DESCRIBES. A seat that holds no file (R9) falls back through the gateway's
 * paged door exactly as every other page does — the refusal is
 * `OnlineOnlyError`, raised by the caller that has no seat, and the whole query
 * re-runs there rather than this one window being answered elsewhere.
 *
 * WHY THIS IS NOT `pageStatement` (recorded, W5-D1's one deviation).
 * `PageCursor.sortKey` is a STRING, and the keyset it builds is
 * `(sort, pk) < (?, ?)`. A ranked search sorts on FTS5's `rank`, which is a
 * negative REAL: SQLite compares a REAL column against a TEXT bind by storage
 * class — every REAL sorts below every TEXT — so a keyset over it would not
 * merely mis-order, it would return the same first page forever. Ranked FTS is
 * not a keyset walk in any dialect; the standard answer is a bounded top-N, and
 * that is exactly what `searchWire` has always answered
 * (`REPLICA_DEFAULT_SEARCH_ROWS` 100, ceiling 1,000). So a search page carries
 * a window and NO continuation cursor, and says so in its type rather than
 * handing back a `next` that cannot be honoured.
 *
 * THE PROJECTION IS THE BASE ROW. `ctx.vault.search` hands a handler rows it
 * reads columns off — `task_id`, `title`, `description` — so the shadow table's
 * indexed columns are not enough on their own and the statement joins back to
 * the base table on the id the two share. The seat holds only rows the member
 * may see (W4-D2), which is what makes `b.*` the honest equivalent of the
 * gateway's consent-filtered answer rather than a widening of it.
 */

import type { PageBindValue } from "@centraid/core/page";

import { OnlineOnlyError } from "../online-only-error.js";
import {
  REPLICA_DEFAULT_SEARCH_ROWS,
  REPLICA_MAX_SEARCH_ROWS,
  replicaFtsMatchExpression,
  replicaLocalSearchSpec,
  replicaSearchTables,
} from "../search.js";
import type { ReplicaRow, ReplicaRowEnvelope } from "../types.js";
import { countSeatPageWork } from "./paged-handler.js";
import type { SeatQueryPort } from "./seat-page-reader.js";

/** One ranked window of one entity. No cursor: see the note above. */
export interface SeatSearchResult<Row extends object> {
  rows: Row[];
}

export interface SeatSearchRequest {
  /** The logical entity, e.g. `schedule.task`. */
  entity: string;
  query: string;
  /** Clamped to `REPLICA_MAX_SEARCH_ROWS`; absent takes the default window. */
  limit?: number;
}

/**
 * The window this search will honour, clamped, never refused.
 *
 * The GATEWAY's clamp, arithmetic included (`vault/src/gateway/search.ts`):
 * `min(max(limit ?? 100, 1), 1000)`. Two clamps that merely agree about the
 * common case are two clamps, and the one that drifts drifts at the edge
 * nobody looks at.
 */
export function seatSearchWindow(limit?: number): number {
  return Math.min(
    Math.max(limit ?? REPLICA_DEFAULT_SEARCH_ROWS, 1),
    REPLICA_MAX_SEARCH_ROWS
  );
}

/**
 * The statement, as data — and it is the GATEWAY'S STATEMENT.
 *
 * Mirrored line for line from `packages/vault/src/gateway/search.ts`: the same
 * join, the same `_rank`/`_snippet` aliases the handler contract documents, the
 * same `ORDER BY rank, id` deterministic tiebreak, the same clamp. Parity that
 * rests on two statements happening to agree is parity until one of them is
 * edited; this one is the same statement with the door's own half removed.
 *
 * WHAT IS REMOVED, AND WHY IT IS NOT A WIDENING. The gateway ANDs in the
 * grant's row filter, the caller's own filters and the R17 field mask, because
 * it answers for a principal that may see part of a vault. A seat's file IS the
 * part this member may see — it was built by `buildSeatSnapshot` and is fed by
 * a log the gateway filtered — so there is nothing left here to filter against
 * (W4-D2, R12). A seat that held rows a member may not see would be a bug in
 * the snapshot, not something a WHERE clause here could repair.
 *
 * NO SOFT-DELETE PREDICATE, for the same reason the gateway has none: the
 * shadow table's own AFTER triggers keep a soft-deleted row out of the index.
 * Adding a guard on one plane only is how the two start disagreeing.
 */
export function seatSearchStatement(request: SeatSearchRequest): {
  sql: string;
  bind: PageBindValue[];
} {
  const spec = replicaLocalSearchSpec(request.entity);
  const { base, fts } = replicaSearchTables(request.entity);
  return {
    sql: `SELECT b.*, ${fts}.rank AS _rank,
              snippet(${fts}, -1, '⟦', '⟧', '…', 12) AS _snippet
         FROM ${fts} JOIN "${base}" b ON b."${spec.idColumn}" = ${fts}."${spec.idColumn}"
        WHERE ${fts} MATCH ?
        ORDER BY ${fts}.rank, b."${spec.idColumn}" LIMIT ?`,
    bind: [
      replicaFtsMatchExpression(request.query),
      seatSearchWindow(request.limit),
    ],
  };
}

/**
 * One ranked window, read across the seat worker's seam.
 *
 * No overlay. A queued write's own row is drawn over a LIST by the outbox
 * (R23–R25), but nothing has indexed it — the member's unsent note is not in
 * the shadow table and cannot be ranked against what is. `intents.ts` composes
 * the pending match separately (`replicaPendingSearchMatch`), which is where
 * that judgement has always lived.
 */
export async function seatWorkerSearch<Row extends object>(
  port: SeatQueryPort,
  request: SeatSearchRequest
): Promise<SeatSearchResult<Row>> {
  const statement = seatSearchStatement(request);
  const rows = await port.query<Row>(statement);
  countSeatPageWork(rows.length);
  return { rows };
}

/** The refusal a seat with no file raises, so the caller falls back (R9). */
export function seatSearchUnavailable(entity: string): OnlineOnlyError {
  return new OnlineOnlyError(
    `this seat holds no copy of the vault, so ${entity} cannot be searched locally`
  );
}

/**
 * A seat search, in the wire shape both sessions already answer.
 *
 * The envelope is what every caller reads — `row.values` — and it is built
 * here rather than by each seat so the two hosts cannot disagree about what a
 * search row is. Nothing is oversized and nothing is undisclosed: the seat
 * holds whole rows the member may see, which is precisely why the old
 * plane's two flags have nothing to say about one (W4-D2).
 */
export async function seatSearchEnvelopes(
  port: SeatQueryPort,
  request: SeatSearchRequest
): Promise<{ rows: ReplicaRowEnvelope[] }> {
  const spec = replicaLocalSearchSpec(request.entity);
  const { rows } = await seatWorkerSearch<ReplicaRow>(port, request);
  return {
    rows: rows.map((values) => ({
      rowId: String(values[spec.idColumn] ?? ""),
      values,
      oversizedFields: [],
      hasUnavailableFields: false,
    })),
  };
}
