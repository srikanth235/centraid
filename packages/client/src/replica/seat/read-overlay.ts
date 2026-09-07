// THE PENDING ROW A SEAT READ MUST STILL SHOW (#996, R23–R25).
//
// A note saved on the phone is a queued intent and nothing else until the
// gateway answers and the log carries it back. Between those two moments the
// member must see their own note, or the app has silently swallowed a save —
// which is what the emulator gate found: the seat's read is raw SQL over the
// file, and the file is the GATEWAY's rows, so a write that has not made the
// round trip appears nowhere.
//
// The old store composed the outbox's optimistic effects into every read
// (`store-core.ts#overlay`). The seat has the same obligation and a better
// place to meet it: the outbox shares this file, so the overlay is read from
// `seat_outbox` in the same handle rather than reconciled across two stores.
//
// BOUNDED BY THE MUTATIONS, NOT THE TABLE — the same rule as the old store.
// Three pending edits cost three rows however large the library, because only
// the addressed row ids are touched.

import { OVERLAY_STATES } from "../intent-verdict.js";
import type { OptimisticMutation, ReplicaIntent } from "../types.js";
import type { SeatSqliteDriver } from "./driver.js";

/**
 * How a seat read is overlaid. The seat's file holds PHYSICAL tables and an
 * intent's optimistic rows are keyed by ENTITY, so the caller states the pair
 * — it is reading one table and knows which entity's rows it selected. There
 * is no entity→table map on the seat, deliberately: the file is the gateway's
 * schema and the seat does not keep a second copy of it (`SeatTableKeys`).
 */
export interface SeatReadOverlay {
  /** The entity whose pending mutations address these rows. */
  readonly entity: string;
  /** The column of the read's rows that carries the row id. */
  readonly rowIdColumn: string;
}

/**
 * The pending mutations this file holds for one entity, in the order they were
 * made. Only the OVERLAY states: a settled or refused intent is not something
 * the member is still waiting on, and drawing it over a read would show a
 * change that is not happening.
 */
export function seatPendingMutations(
  driver: SeatSqliteDriver,
  entity: string
): OptimisticMutation[] {
  const rows = driver.all<{ record_json: string }>(
    `SELECT record_json FROM seat_outbox
      WHERE state IN (${[...OVERLAY_STATES].map(() => "?").join(", ")})
      ORDER BY created_order`,
    [...OVERLAY_STATES]
  );
  return rows
    .flatMap((row) => (JSON.parse(row.record_json) as ReplicaIntent).optimistic)
    .filter((mutation) => mutation.entity === entity);
}

/**
 * Draw the pending mutations over the rows a read returned.
 *
 * An upsert of a row the read already has MERGES into it — a pending rename
 * must not blank every other column — and an upsert of one it does not have is
 * APPENDED, because a note that exists only in the outbox is exactly the row
 * the member is looking for. A delete removes it. Among the mutations, order
 * is the order the intents were made, so the last word wins, which is what the
 * member typed last.
 *
 * AN APPENDED ROW LANDS AT THE END, not in the read's sort order: it is not in
 * the file, so the SQL that produced this answer never saw it and re-sorting
 * here would mean re-implementing an arbitrary ORDER BY in JavaScript. It
 * takes its place when the echo arrives.
 */
export function overlaySeatRows(
  rows: readonly object[],
  mutations: readonly OptimisticMutation[],
  rowIdColumn: string
): object[] {
  if (mutations.length === 0) return [...rows];
  const byId = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  for (const row of rows) {
    const values = { ...(row as Record<string, unknown>) };
    const id = String(values[rowIdColumn]);
    if (!byId.has(id)) order.push(id);
    byId.set(id, values);
  }
  for (const mutation of mutations) {
    if (mutation.op === "delete") {
      byId.delete(mutation.rowId);
      continue;
    }
    const held = byId.get(mutation.rowId);
    if (!held) order.push(mutation.rowId);
    byId.set(mutation.rowId, {
      ...(held ?? { [rowIdColumn]: mutation.rowId }),
      ...mutation.values,
    });
  }
  return order.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
}
