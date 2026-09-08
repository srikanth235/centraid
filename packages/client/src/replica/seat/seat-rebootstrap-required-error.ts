/**
 * The log door's 409 (#996, R5).
 *
 * The gateway cannot serve this seat's cursor — it is below the retention
 * floor, ahead of the watermark, or from another epoch — and the answer is
 * always the same: get the file again. Its own class rather than a status
 * check at each call site, because the ONE thing a caller must not do with it
 * is retry the same request.
 */
export class SeatRebootstrapRequiredError extends Error {
  readonly code = "seat_rebootstrap_required";
  constructor(readonly reason: string) {
    super(`the gateway cannot serve this seat's cursor: ${reason}`);
    this.name = "SeatRebootstrapRequiredError";
  }
}
