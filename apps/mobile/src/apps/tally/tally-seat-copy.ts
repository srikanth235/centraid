// THE SENTENCES THAT ARE TRUE ON A PHONE AND NOWHERE ELSE.
//
// Everything a seat SHARES is imported from `apps/tally/view-copy.ts` and
// `compose-copy.ts` — the §6 table lives there once and this file never
// respells a line of it, not the currency note, not the due occurrence, not
// the export foot. What is here is the handful of facts that are only facts on
// the origin seat, and one honest variant of a shared sentence:
//
//   1. EXPORT'S DOOR IS ON THE DESKTOP. `custodian` in SURFACES.md's seat
//      column. A greyed control would teach that Export is broken; the row
//      says where the act happens instead (docs/blueprint-seats.md).
//   2. RECEIPT CAPTURE IS THIS SEAT'S. `RECEIPT_LEDE_ORIGIN` already says the
//      photograph was taken at the table; what the phone adds is the VERB, and
//      where in the frame it lives, which no other seat has.
//   3. THE WINDOW WITH NO DENOMINATOR. §6's window sentence carries a total;
//      the queries this seat reads return a bounded list and no count of what
//      lies behind it, so the honest variant says what is shown and that the
//      window is a window rather than inventing the denominator.
//   4. WHAT WAITING CAN AND CANNOT DO FROM HERE.
//
// Pure: no `react-native` import, so `tally-view-model.test.ts` asserts these
// strings directly.

/** The custodian sentence. Export is `custodian` in SURFACES.md's seat column:
 *  its door is beside the gateway, and this phone has none. */
export const CUSTODIAN_SEAT_NOTE =
  "This act belongs to the desktop, beside the gateway · this phone has no door to it.";

export const EXPORT_WHERE_ROW = "Where";
export const EXPORT_WHAT_ROW = "What travels";
export const EXPORT_GROUP_ROW = "Group";

// ─── The receipt, which this seat owns ──────────────────────────────────────

export const RECEIPT_CAPTURE_ROW = "Capture";
/** The verb only this seat can offer, and it opens the frame's own scanner —
 *  the camera and the OCR pass are the shell's, not this app's. */
export const RECEIPT_SCAN_VERB = "Photograph a receipt";
export const RECEIPT_SCAN_NOTE =
  "The scanner is the frame's · it reviews the lines, then Tally allocates them.";
/** A re-allocation answers *who had what*, never *what did it cost*. */
export const RECEIPT_REALLOCATE_NOTE =
  "The amount never changes · a re-allocation is a revision, with the undo window on the expense.";

// ─── The window's honest foot ───────────────────────────────────────────────

/**
 * What the ledger's foot says when the payload carries no denominator.
 *
 * §6's window sentence is `60 of 194 · this is a window on the ledger, not all
 * of it`, and `view-copy.windowEnd` renders exactly that — but only where a
 * TOTAL is known. `queries/activity.ts`, `group.ts` and `friend.ts` return a
 * bounded list and no count of what lies behind it, so the denominator would be
 * a claim nobody checked. The §6 wording comes back the day a query serves a
 * total, with no edit here.
 */
export const WINDOW_NO_TOTAL = "this is a window on the ledger, not all of it";

export function windowFootNoTotal(shown: number): string {
  return `${shown} shown · ${WINDOW_NO_TOTAL}`;
}

// ─── Waiting, and the door this seat does not have ──────────────────────────

/**
 * WHY THERE IS NO APPROVE OR DECLINE HERE.
 *
 * The gateway grew a per-intent decide door with the #872 backend
 * (`core/protocol/routes.ts` `commonsIntentDecidePath`), but no mobile
 * transport reaches it and nothing on this device reads another member's
 * commons intents: `session.pendingChanges()` answers with THIS phone's own
 * outbox and nothing else. So Waiting draws the rows it can honestly account
 * for — the member's own writes — and hands a steward-only act over to the
 * shell's own Approvals inbox rather than drawing a button with nothing behind
 * it. `contrib-model.ts` already refuses to invent an Accept for exactly this
 * reason, and its `approvals` verb IS the hand-over.
 */
export const WAITING_OWN_SCOPE =
  "Your own writes, from this device · a contribution from another member is answered in Approvals.";

export function waitingCount(total: number): string {
  return `${total} ${total === 1 ? "contribution" : "contributions"}`;
}

// ─── Sharing a group, the one act that never queues ─────────────────────────

/**
 * WHY THIS VERB IS WITHHELD OFFLINE.
 *
 * Every other act here records offline, having an optimistic projection
 * (`tally-writes.ts`). Sharing has none — it is a commons compilation on the
 * gateway, and `MultiVaultReplicaSession.share` rejects while disconnected by
 * design — so the row draws the SENTENCE instead of the verb, Due next's own
 * shape. A refusal from a REACHABLE gateway is the other answer and keeps the
 * vault's words, posted verbatim, never paraphrased into this one.
 */
export const SHARE_GROUP_VERB = "Share group";
export const SHARE_GROUP_META =
  "each member you are linked with gets it in their own vault";
export const SHARE_GROUP_OFFLINE =
  "Sharing needs a gateway connection · it cannot be queued";
