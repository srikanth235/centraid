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

import {
  decoratePendingMutation,
  pendingOverlayFacts,
  PENDING_OVERLAY_FIELDS,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import type {
  PendingOverlayFacts,
  PendingOverlaySidecar,
} from "@centraid/blueprints/apps/_shared/pending-overlay";

import { OVERLAY_STATES } from "../intent-verdict.js";
import type {
  IntentState,
  OptimisticMutation,
  ReplicaIntent,
} from "../types.js";
import type { SeatSqliteDriver } from "./driver.js";

/**
 * THE FACTS RIDE ON THE ROW, AND ONLY AS FAR AS THE SEAM (#996 wave 4b).
 *
 * A row a member is still waiting on needs two things to draw its badge: the
 * intent key, which is a column and survives every projection a handler makes
 * of it, and the read's FACTS — what is happening to that write — which are one
 * object per read and belong on the sidecar, not on a row.
 *
 * The sidecar is a SYMBOL, and a symbol does not survive `postMessage`. So the
 * seat carries the facts across the worker boundary as an ordinary field, and
 * the first thing on the other side lifts them off: `seat-page-reader.ts` for
 * the shell, the ctx for a handler. No handler ever sees this key, which is
 * why it is not the sidecar itself — a field a handler could spread into its
 * view model is a field that leaks onto JSON.
 */
export const SEAT_PENDING_FACTS = "__seatPendingFacts";

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
export interface SeatPendingOverlay {
  /** The rows to draw, each stamped with the intent that projected it. */
  readonly mutations: readonly OptimisticMutation[];
  /** What is happening to each of those intents, keyed by intent id. */
  readonly facts: PendingOverlaySidecar;
}

export function seatPendingOverlay(
  driver: SeatSqliteDriver,
  entity: string
): SeatPendingOverlay {
  const rows = driver.all<{
    intent_id: string;
    action: string;
    state: string;
    attempts: number;
    enqueued_at: string;
    record_json: string;
  }>(
    `SELECT intent_id, action, state, attempts, enqueued_at, record_json
       FROM seat_outbox
      WHERE state IN (${[...OVERLAY_STATES].map(() => "?").join(", ")})
      ORDER BY created_order`,
    [...OVERLAY_STATES]
  );
  const mutations: OptimisticMutation[] = [];
  const facts: Record<string, PendingOverlayFacts> = {};
  for (const row of rows) {
    const intent = {
      intentId: row.intent_id,
      state: row.state as IntentState,
      action: row.action,
      attempts: row.attempts,
      enqueuedAt: row.enqueued_at,
    };
    const answer = pendingOverlayFacts(intent);
    if (answer) facts[row.intent_id] = answer;
    for (const mutation of (JSON.parse(row.record_json) as ReplicaIntent)
      .optimistic) {
      if (mutation.entity !== entity) continue;
      // The row carries the intent that projected it — its ONE pending column
      // (#922 G3) — so a handler's own projection of it can still be traced
      // back to the write the member is waiting on.
      mutations.push(decoratePendingMutation(mutation, intent));
    }
  }
  return { mutations, facts };
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
  overlay: SeatPendingOverlay,
  rowIdColumn: string
): object[] {
  const { mutations, facts } = overlay;
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
    if (row === undefined) return [];
    // Only a row the member is waiting on carries the read's facts: the sidecar
    // is bounded by the outbox, and a canonical row has nothing to say.
    if (typeof row[PENDING_OVERLAY_FIELDS.key] === "string")
      row[SEAT_PENDING_FACTS] = facts;
    return [row];
  });
}
