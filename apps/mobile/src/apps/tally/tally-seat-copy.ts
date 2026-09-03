export const CUSTODIAN_SEAT_NOTE =
  "This act belongs to the desktop, beside the gateway · this phone has no door to it.";

export const EXPORT_WHERE_ROW = "Where";
export const EXPORT_WHAT_ROW = "What travels";
export const EXPORT_GROUP_ROW = "Group";

export const RECEIPT_CAPTURE_ROW = "Capture";
export const RECEIPT_SCAN_VERB = "Photograph a receipt";
export const RECEIPT_SCAN_NOTE =
  "The scanner is the frame's · it reviews the lines, then Tally allocates them.";
export const RECEIPT_REALLOCATE_NOTE =
  "The amount never changes · a re-allocation is a revision, with the undo window on the expense.";

export const WINDOW_NO_TOTAL = "this is a window on the ledger, not all of it";

export function windowFootNoTotal(shown: number): string {
  return `${shown} shown · ${WINDOW_NO_TOTAL}`;
}

export const WAITING_OWN_SCOPE =
  "Your own writes, from this device · a contribution from another member is answered in Approvals.";

export function waitingCount(total: number): string {
  return `${total} ${total === 1 ? "contribution" : "contributions"}`;
}

export const SHARE_GROUP_VERB = "Share group";
export const SHARE_GROUP_META =
  "each member you are linked with gets it in their own vault";
export const SHARE_GROUP_OFFLINE =
  "Sharing needs a gateway connection · it cannot be queued";
