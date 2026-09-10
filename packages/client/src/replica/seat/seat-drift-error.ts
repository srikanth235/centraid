/**
 * Why a log page cannot be applied to this file, and what to do about it.
 *
 * `wrong-vault` is the BOOTSTRAP's refusal, not the applier's (#1014, C16):
 * the artifact behind the snapshot door is a copy of another vault. It is
 * kept apart from `vault` — a page that arrived for another vault — because
 * the two say different things about what to do next. A page for the wrong
 * vault is drift a re-bootstrap closes; an ARTIFACT for the wrong vault is a
 * mis-addressed door, and re-bootstrapping against it is the ~6 s loop R25
 * recorded. Only the first is worth retrying.
 */
export type SeatDriftReason =
  | "epoch"
  | "schema-epoch"
  | "vault"
  | "wrong-vault";

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
