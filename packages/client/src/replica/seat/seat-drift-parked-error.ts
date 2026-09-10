// WHEN RE-BOOTSTRAPPING STOPS BEING A REPAIR (#1014, C14).
//
// A `SeatDriftError` means "throw the file away and bootstrap again", and the
// loop bounds that to one attempt per sync. Nothing bounded the SYNCS. The
// phone's retry timer re-enters `sync()` on a five-minute cap forever, so a
// drift the gateway cannot resolve — a snapshot that keeps arriving for the
// wrong vault, an epoch the door will not move off — became one full artifact
// download every five minutes on a cellular connection, with no user-visible
// cause. R25 recorded it at ~6 s: 560 lines of gateway log, 135 KB a pass.
//
// So consecutive drift re-bootstraps are counted, and the third one parks the
// mount instead of trying a fourth. PARKED, NOT FAILED: nothing is wiped, the
// file and its outbox stay exactly where they are, and the member is told
// what the seat could not resolve — which is the one thing the silent retry
// loop never did.

import type { SeatDriftError } from "./seat-drift-error.js";

/** How many drift re-bootstraps in a row before the mount parks. */
export const MAX_CONSECUTIVE_DRIFT_REBOOTSTRAPS = 3;

export class SeatDriftParkedError extends Error {
  readonly code = "seat_drift_parked";
  /** Terminal for the loop: a retry on the same schedule cannot help. */
  readonly recovery = "park" as const;

  constructor(
    readonly drift: SeatDriftError,
    readonly attempts: number
  ) {
    super(
      `seat: ${attempts} re-bootstraps in a row could not resolve ` +
        `${drift.reason} drift — ${drift.message}`
    );
    this.name = "SeatDriftParkedError";
  }
}

/**
 * Errors a catch-up must NOT swallow (#1014, C13 and C14).
 *
 * `SeatSyncLoop.sync()` treats a failure as an outage by design — a seat that
 * could not reach the gateway is a seat with a slightly older copy, which is
 * the normal state of the thing. These two are not that. Out of room and a
 * parked drift both fail identically on every retry, and the host has a state
 * to show for each; swallowing them made `native-session.ts`'s storage-full
 * park unreachable code and the drift loop unbounded.
 */
export function isSeatTerminalError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { recovery?: unknown }).recovery === "park"
  );
}
