/** Why a log page cannot be applied to this file, and what to do about it. */
export type SeatDriftReason = "epoch" | "schema-epoch" | "vault";

/**
 * The page belongs to a file this one is not.
 *
 * NOT A RETRYABLE ERROR. Every reason here means the seat's copy and the
 * gateway's have parted company in a way no further page can close, so the
 * recovery is always the same and is stated on the error rather than inferred
 * by each caller: throw the file away and bootstrap again.
 */
export class SeatDriftError extends Error {
  readonly code = "seat_drift";
  readonly recovery = "rebootstrap" as const;
  constructor(
    readonly reason: SeatDriftReason,
    message: string
  ) {
    super(message);
    this.name = "SeatDriftError";
  }
}
