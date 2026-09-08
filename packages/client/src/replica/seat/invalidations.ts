// WHAT A SEAT TELLS A SCREEN TO RE-READ (#996, R8 and W5).
//
// WHAT THIS REPLACES. The coordinator derived invalidations from the shaped
// store's apply result: a delta named the SHAPES it touched, and every screen
// filtered on shape ids it had to hold a catalog to know. A seat has no shapes.
// What it has is the applier's change notice — the TABLES a batch wrote — which
// is both narrower and truer: it is what actually moved in the file.
//
// SO THE UNIT IS THE ENTITY, and `shapeId` is simply absent. A screen that
// asked "did `schedule.task` change" gets the same answer it always did; a
// screen that filtered on a shape id was filtering on a name for the app's
// slice of one, and there is one slice now.
//
// A TABLE THE VAULT DOES NOT OWN NAMES NO ENTITY. The seat's own bookkeeping
// moves on every applied page — `seat_state`'s cursor most of all — and a
// notice that turned that into an invalidation would re-run every read on the
// screen on every page of a bootstrap. `vaultEntityOfTable` drops them.

import type { ReplicaInvalidation } from "../types.js";
import { vaultEntityOfTable } from "../vault-tables.js";
import type { SeatChangeNotice } from "./applier.js";

/** Every entity a batch touched, as invalidations. Empty is a valid answer. */
export function seatChangeInvalidations(
  notice: SeatChangeNotice
): ReplicaInvalidation[] {
  const seen = new Set<string>();
  const invalidations: ReplicaInvalidation[] = [];
  for (const table of notice.tables) {
    const entity = vaultEntityOfTable(table);
    if (!entity || seen.has(entity)) continue;
    seen.add(entity);
    invalidations.push({ entity, source: "canonical" });
  }
  return invalidations;
}

/**
 * The one invalidation that means "everything you were reading is gone".
 *
 * A purge, a re-bootstrap, a vault switch: the plane every read stands on is
 * replaced, so it is not a list of entities — a screen cannot be told which of
 * its rows survived, because the answer is none of them until the new file
 * lands. Every consumer already special-cases `source === "purge"`.
 */
export function seatPurgeInvalidation(): ReplicaInvalidation[] {
  return [{ entity: "*", source: "purge" }];
}
