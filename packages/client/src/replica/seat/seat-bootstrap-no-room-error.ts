/**
 * There is not room for the artifact, the file it expands to, and the file it
 * replaces — all three of which exist at once during a re-bootstrap.
 *
 * Thrown BEFORE the first byte. Discovering this at 80% would leave a phone
 * with a seat it cannot repair and no space to repair it in, which is the one
 * failure a local-first app must not have.
 */
export class SeatBootstrapNoRoomError extends Error {
  readonly code = "seat_bootstrap_no_room";
  constructor(
    readonly required: number,
    readonly free: number
  ) {
    super(
      `seat bootstrap: needs ${required} bytes for the artifact, the expanded file and the file it replaces; ${free} free`
    );
    this.name = "SeatBootstrapNoRoomError";
  }
}
