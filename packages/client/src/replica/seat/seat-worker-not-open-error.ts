/** The seat worker was asked to do something before `open`. */
export class SeatWorkerNotOpenError extends Error {
  readonly code = "seat_worker_not_open";
  constructor() {
    super("seat worker has not been opened");
    this.name = "SeatWorkerNotOpenError";
  }
}
