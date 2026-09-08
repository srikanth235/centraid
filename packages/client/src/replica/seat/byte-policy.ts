// WHICH BYTES A SEAT KEEPS (#996, ruling R7).
//
// The vault's ROWS are not negotiable: every seat holds `vault.db` whole, and
// the ~2 KB inline thumb per media item is a row in a 1:1 side table, so it
// arrives with everything else and no policy governs it. That is the whole
// point of the WhatsApp inline-thumbnail pattern — a gallery scrolls, a face
// appears, a name resolves, all offline, with no file fetched.
//
// WHAT IS NEGOTIABLE IS THE FILES. Previews and originals are content-
// addressed blobs, they are three orders of magnitude bigger than the rows,
// and a phone cannot hold a decade of them. So each seat declares a policy and
// this module answers one question per blob: hold it, cache it, or fetch it
// when someone actually looks.
//
// TWO THINGS OVERRIDE THE POLICY, AND BOTH ARE PROMISES ALREADY MADE:
//
//   - A PIN. "Keep offline" is a member's explicit instruction, and a cache
//     that evicts what someone asked it to keep is not a cache, it is a
//     surprise.
//   - A CAPTURE A PENDING INTENT NEEDS (R25). An attachment-dependent intent
//     names the hashes it requires, and the gateway executes it only once
//     those bytes are uploaded and verified. Evicting them would make the
//     member's own queued work unsendable — from THIS seat, with no other copy
//     anywhere. The LRU cannot touch them, and that is not a heuristic.

/** What a blob is, for policy. `thumb` is a row and is here to be refused. */
export type SeatBlobKind = "thumb" | "preview" | "original";

/**
 * Per-seat byte policy (R7).
 *
 * - `everything` — desktop. Disk is cheap and the machine is not carried.
 * - `captured-and-cache` — the phone: what this device captured, kept; the
 *   rest an LRU cache with pins.
 * - `on-demand` — the PWA. It is a cache of the vault and says so (R15);
 *   holding originals in OPFS is what makes Safari's ceiling a wall.
 */
export type SeatBytePolicyName =
  | "everything"
  | "captured-and-cache"
  | "on-demand";

/** What the seat does with a blob it does not already have. */
export type SeatByteVerdict =
  /** Fetch and keep; never evicted by the LRU. */
  | "hold"
  /** Fetch and keep while it fits; evictable. */
  | "cache"
  /** Do not fetch; get it when someone opens it. */
  | "on-demand";

export interface SeatByteRequest {
  readonly kind: SeatBlobKind;
  /** This seat took the photo / made the recording. */
  readonly capturedHere?: boolean;
  /** The member said "keep offline". */
  readonly pinned?: boolean;
  /** A queued intent names this hash as a prerequisite (R25). */
  readonly referencedByPendingIntent?: boolean;
}

export class SeatThumbIsARowError extends Error {
  readonly code = "seat_thumb_is_a_row";
  constructor() {
    super(
      "a thumb is a replicated row, not a policy decision: every seat holds it"
    );
    this.name = "SeatThumbIsARowError";
  }
}

/**
 * What this seat does about one blob.
 *
 * Throws for `thumb` rather than answering "hold": a caller asking the byte
 * policy about a thumb has confused a row with a file, and answering politely
 * would let that confusion reach a screen that then waits on a fetch which
 * never needed to happen.
 */
export function seatByteVerdict(
  policy: SeatBytePolicyName,
  request: SeatByteRequest
): SeatByteVerdict {
  if (request.kind === "thumb") throw new SeatThumbIsARowError();
  // The two overrides, before the policy. Order matters only in that neither
  // is a preference — both are promises this seat has already made.
  if (request.referencedByPendingIntent === true) return "hold";
  if (request.pinned === true) return "hold";
  switch (policy) {
    case "everything":
      return "hold";
    case "captured-and-cache":
      // What this device captured is the one copy that may not exist anywhere
      // else yet, so it is held rather than cached.
      if (request.capturedHere === true) return "hold";
      return request.kind === "preview" ? "cache" : "on-demand";
    case "on-demand":
      return "on-demand";
  }
}

/**
 * May the LRU evict this blob to make room?
 *
 * The inverse of the two overrides, stated as its own function because the
 * eviction path and the fetch path are written by different callers and must
 * not each re-derive the rule.
 */
export function seatByteEvictable(request: SeatByteRequest): boolean {
  if (request.kind === "thumb") throw new SeatThumbIsARowError();
  return (
    request.referencedByPendingIntent !== true &&
    request.pinned !== true &&
    request.capturedHere !== true
  );
}
