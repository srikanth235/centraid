// WHAT A WRITE'S OPTIMISTIC ROWS MUST SAY (#996, W5).
//
// WHAT THIS REPLACED. A prepared write used to be validated against the SHAPE
// CATALOG: the caller's mutation named an entity, the shell resolved which of
// the app's shapes carried it, and that shape's declared schema said which
// columns existed and which was the primary key. There is no catalog on a seat
// — one vault, one file — so the checks that were the CATALOG's are gone and
// the ones that are the WRITE's remain:
//
//   an optimistic row must be about something, and
//   it must name the row it is about.
//
// THE COLUMN CHECK IS NOT REPLACED BY A LOOKUP AGAINST THE FILE, deliberately.
// A projection writes the row a member is about to see, and the GATEWAY is the
// authority on whether those columns exist: it refuses the intent if they do
// not, and the member is shown the refusal. Re-deriving a schema here from
// `pragma_table_info` would be a second opinion that can only ever disagree
// with the first, and the disagreement would be silent — the row drawn, the
// write refused, and nothing connecting the two.

import { ReplicaProtocolError } from "./errors.js";
import type { OptimisticMutation, ReplicaDependency } from "./types.js";

export type ReplicaWriteMutationInput =
  | (Omit<Extract<OptimisticMutation, { op: "upsert" }>, "shapeId"> & {
      shapeId?: string;
      purpose?: string;
    })
  | (Omit<Extract<OptimisticMutation, { op: "delete" }>, "shapeId"> & {
      shapeId?: string;
      purpose?: string;
    });

export interface PreparedReplicaWrite {
  optimistic: OptimisticMutation[];
  dependencies: ReplicaDependency[];
}

/**
 * Normalize and validate one app write, for either seat.
 *
 * `dependencies` is the set of ENTITIES this write touches, which is what a
 * screen subscribes on. It used to be every entity of every shape the app
 * owned — one task edited invalidated the whole app — because a shape was the
 * smallest thing the old plane could name. A seat names the entity.
 */
export function prepareReplicaWrite(
  optimistic: readonly ReplicaWriteMutationInput[] | undefined
): PreparedReplicaWrite {
  const normalized = (optimistic ?? []).map((mutation) => {
    const { purpose: _purpose, shapeId, ...rest } = mutation;
    return {
      ...rest,
      // A shape id a caller still states is carried through untouched: it is
      // the app's own name for its projection and the outbox stores it, but
      // nothing RESOLVES anything from it any more.
      ...(shapeId ? { shapeId } : {}),
    } as OptimisticMutation;
  });
  for (const mutation of normalized) validateOptimisticMutation(mutation);
  const entities = new Set(normalized.map((mutation) => mutation.entity));
  return {
    optimistic: normalized,
    dependencies: [...entities].map((entity) => ({ entity })),
  };
}

/**
 * The two things an optimistic row has to get right, whatever it is about.
 *
 * The row-id mismatch is the one worth catching here: the overlay draws BY ROW
 * ID, so a row whose own key column disagrees with it is drawn over rows it is
 * not about — and it stays there, because nothing the gateway ever sends can
 * reconcile a row id that was never real.
 */
export function validateOptimisticMutation(mutation: OptimisticMutation): void {
  if (!mutation.entity)
    throw new ReplicaProtocolError("Optimistic mutation names no entity");
  if (!mutation.rowId)
    throw new ReplicaProtocolError(
      `Optimistic mutation on ${mutation.entity} names no row`
    );
  if (mutation.op === "delete") return;
  // The entity's OWN key column — `schedule.task` → `task_id` — which is the
  // one a projection mints the row id into. Another table's foreign key is a
  // reference, not this row's identity, and must not be compared to it.
  const key = `${mutation.entity.split(".")[1] ?? ""}_id`;
  const stated = mutation.values[key];
  if (
    key !== "_id" &&
    typeof stated === "string" &&
    stated !== mutation.rowId
  ) {
    throw new ReplicaProtocolError(
      `Optimistic row id does not match ${mutation.entity}.${key}`
    );
  }
}
