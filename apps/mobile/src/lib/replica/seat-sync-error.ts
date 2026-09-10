// WHY A CATCH-UP DID NOT LAND, IN ONE LINE (#1011).
//
// The seat loop's failures are a small, closed set — a refused socket, a door
// that answered a status, a file that refused a page — and every one of them
// used to reach the member as the same sentence: nothing. `SeatSyncLoop`
// swallowed the error by design, the session reported a boolean, and the
// provider printed `pull did not land — blocked=false`, which names the one
// thing that was NOT the cause.
//
// This turns whatever was thrown into a sentence a member can act on and a
// maintainer can grep. It is deliberately not a taxonomy: a class nobody has
// seen yet still gets its own message through, rather than being flattened
// into "something went wrong".

/** A short, member-readable reason for a failed catch-up. */
export function describeSyncError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message === "" ? error.name : `${error.name}: ${message}`;
  }
  if (typeof error === "string" && error.trim() !== "") return error.trim();
  return "unknown error";
}

/**
 * The last catch-up failure, kept and said once.
 *
 * A member whose copy is empty is owed a reason, and a console line is not one
 * — it is gone by the time anybody looks. The sink holds the reason for
 * Diagnostics and the status line, and prints it for whoever is watching Metro.
 */
export class SeatSyncErrorSink {
  #last: unknown | undefined;

  /** Why the last catch-up did not land; `undefined` once one does. */
  get last(): unknown | undefined {
    return this.#last;
  }

  note(error: unknown): void {
    this.#last = error;
    console.error(
      `[centraid] replica: seat catch-up failed — ${describeSyncError(error)}`
    );
  }

  clear(): void {
    this.#last = undefined;
  }
}
