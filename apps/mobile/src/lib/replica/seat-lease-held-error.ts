/**
 * ANOTHER LIVE OWNER HAS THIS SEAT OPEN (#1014, P1/C8).
 *
 * Its own module, with no expo import, for the reason every other refusal in
 * this directory has one: the background pass has to be able to RECOGNISE this
 * without dragging expo-file-system into a suite that only wants to check what
 * the pass decided.
 */
export class SeatLeaseHeldError extends Error {
  override readonly name = "SeatLeaseHeldError";
  readonly code = "seat_lease_held";
  constructor(readonly heldBy: string) {
    super(`seat is already open here, held by ${heldBy}`);
  }
}
