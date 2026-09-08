/**
 * The artifact behind the snapshot door is not the one this download started.
 *
 * Raised on a changed ETag, on a 200 answering a ranged request (which is
 * `If-Range` saying "different file"), and on a body that ends short of the
 * size the door declared. All three mean the same thing to the caller —
 * discard the staged prefix and start again — and none of them may be spliced
 * onto what is already staged.
 */
export class SeatSnapshotMovedError extends Error {
  readonly code = "seat_snapshot_moved";
  constructor(
    readonly expected: string,
    readonly actual: string | undefined
  ) {
    super(
      `seat bootstrap: the snapshot moved from ${expected} to ${actual ?? "unknown"} mid-download`
    );
    this.name = "SeatSnapshotMovedError";
  }
}
