// THE REVEAL LEG OF THE BOUNDARY (README-Locker §2, rows "Per item" and
// "Failures"), after the boundary moved (#996, ruling W6-D2).
//
// A REVEAL IS A GESTURE, NOT A MODE — and that survived the rewrite unchanged,
// which is the point of keeping this file rather than folding it away. What is
// gone is the PERMIT: a one-shot token minted by a gateway against a
// passphrase the app collected, spent on a privileged read that returned
// plaintext over the wire. With `K` on the seat, the shell unseals and the
// gateway never produces a secret at all, so the token had nothing left to
// buy.
//
// WHAT SURVIVES IS THE CLOCK. A value on screen still conceals itself after
// about thirty seconds, whether or not anyone looked, because the reason for
// that was never the permit's lifetime — it was the shoulder standing behind
// the member. That number was `LOCKER_ITEM_PERMIT_MS` on the gateway and is
// stated here now, on the seat that owns the screen it governs.
//
// This module performs no IO.

/** About thirty seconds — how long a revealed value stays on screen. */
export const REVEAL_LIFE_MS = 30_000;

/**
 * A SEALED ROW THAT HANGS OFF AN ITEM (#873) — a custom field's value, a
 * passkey's key material. The shell's door takes the row's own id, so the
 * sidecar is an ADDRESS the item pane resolves out of the detail it already
 * holds, never a value.
 *
 * A REVISION IS NOT ONE OF THESE (#916, D2). The password an item was rotated
 * away from rides a `core_entity_revision` snapshot, which no reveal opens and
 * only a confirmed `locker.export` unseals.
 */
export interface SidecarTarget {
  /** `locker.item_field` · `locker.item_passkey`. */
  entity: string;
  /** The SIDECAR row's own id — a field id, or the item id. */
  entityId: string;
  /** The one encrypted column being asked for. */
  column: string;
}

/** One ask: this field, of this item, once. */
export interface RevealRequest {
  itemId: string;
  field: string;
  /** Present when the value lives on a sidecar row rather than the item's own
   *  columns. The receipt is the item's either way. */
  sidecar?: SidecarTarget;
  /** The row's own word, for the pane's label — a custom field is named by its
   *  label, which no static table could hold. */
  label?: string;
}

/** Whole seconds a revealed value has been on screen. */
export function revealedForSeconds(
  revealedAt: number,
  now: number = Date.now()
): number {
  return Math.max(0, Math.floor((now - revealedAt) / 1000));
}

/** Whole seconds before a revealed value conceals itself. */
export function concealsInSeconds(
  revealedAt: number,
  now: number = Date.now()
): number {
  return Math.max(0, Math.ceil((revealedAt + REVEAL_LIFE_MS - now) / 1000));
}

/** Has a revealed value been on screen long enough to take itself off? */
export function isRevealExpired(
  revealedAt: number,
  now: number = Date.now()
): boolean {
  return concealsInSeconds(revealedAt, now) <= 0;
}
