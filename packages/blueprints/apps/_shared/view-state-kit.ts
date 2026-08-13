// What a view is ALLOWED to say about itself, given what has actually been read.
// Pure and DOM-free on purpose: every rule here is one an app got WRONG by
// expressing it inline in a render function, where it could not be read and
// could not be tested. Photos learned all three first; every app after it adopts
// them rather than re-learning them.
//
//  1. NOTHING IS EMPTY UNTIL A READ HAS LANDED (`showsEmptyState`). A
//     projection is `[]` before the first read resolves, so gating on a count
//     alone told a member with 6,214 photographs that they had none. "There is
//     nothing here" is a FACT, and a view may not assume one while still asking.
//
//  2. A SHELF IS NEVER SILENTLY SWAPPED FOR ANOTHER ONE. Every shelf is empty
//     ON ITS OWN TERMS; the one that cannot survive a read is a container that
//     no longer exists, and then the move is ANNOUNCED. Each app owns its own
//     `shelfAfterRead`: what "gone" means, and where the member lands, are the
//     app's own facts.
//
//  3. OFFLINE IS A STATE THE APP READS, NEVER ONE IT INVENTS
//     (`libraryReachability`).

/** The three things every app's empty-state input carries; each app extends it
 *  with the copy axes its own variants turn on. */
export interface EmptyStateGate {
  /**
   * A read has LANDED for this view. False covers both "the first read is still
   * in flight" and "every read so far failed": in neither case does the app
   * know whether the set is empty, so in neither case may it say so.
   */
  loaded: boolean;
  /** How many things this view is showing right now. */
  count: number;
  /** Something else already answers this view (a new-album input, a new-folder
   *  editor), so the shelf is not standing there with nothing in it. */
  suppressed?: boolean;
}

/** May the empty block be drawn at all? Rule 1, as one call — every app asks
 *  this before its copy tables, so a shelf cannot acquire a second way of
 *  deciding it is empty. */
export function showsEmptyState(gate: EmptyStateGate): boolean {
  return gate.loaded && !gate.suppressed && gate.count === 0;
}

/**
 * Is the member's library out of reach right now?
 *
 * AN INLINE APP CANNOT ASK THE SHELL. The frame contract (`InlineFrame`,
 * apps/inline-types.ts) carries the app bar, the status line and the band —
 * and nothing about reachability. The shell HAS the verdict (its heartbeat
 * monitor drives `StatusLine`'s own offline state), it simply does not pass it
 * down. So this reads the two things an app can honestly observe:
 *
 *  * `hostStatus` — a `data-gateway-status` knob on the app root, the same
 *    dataset channel the host already stamps `data-app-*` knobs onto. When the
 *    shell starts stamping it, this becomes the real signal at zero cost here;
 *    until then it is absent, which reads as "the host did not say".
 *  * `readFailed` — a read that actually came back failed. That is evidence,
 *    not a guess: the inline client tries the local replica and falls back to
 *    the gateway, so a failure means neither answered.
 *
 * `navigator.onLine` is deliberately NOT consulted. On the desktop the gateway
 * is a local child process, so a device with no network reaches it perfectly
 * well — treating that as an outage would put an untrue banner on screen, which
 * is the class of bug this file exists to close.
 */
export function libraryReachability(input: {
  hostStatus?: string | null;
  readFailed: boolean;
}): "reachable" | "unreachable" {
  if (input.hostStatus === "down") return "unreachable";
  if (input.hostStatus === "up") return "reachable";
  return input.readFailed ? "unreachable" : "reachable";
}
