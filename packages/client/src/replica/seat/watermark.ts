// HOW CURRENT THIS SEAT IS (#996, ruling R8).
//
// WHAT THIS REPLACES. Every read used to carry a `coverage` field, because a
// shape could deliver a SLICE of a table and the kit could not tell a slice
// from a window: "is this all of it?" was a property of one query. A seat now
// holds the whole file or the previous whole file, so the honest question is
// not per-read at all — it is one number about the SEAT, shown once, and it is
// this one.
//
// TWO NUMBERS AND A FLAG, and each says something the others cannot:
//
//   - the applied cursor, which is what this file contains;
//   - the gateway's head as of the last page, which is what exists;
//   - whether a span was deferred, because a metered seat that skipped a large
//     commit is BEHIND IN A DIFFERENT WAY from one that is merely catching up:
//     waiting will not fix it, and the member has to say so.
//
// "BEHIND" IS A DISTANCE IN LOG POSITIONS, NOT IN ROWS OR IN TIME. A seq is
// not a row count — one commit writes many rows — and it is not a duration.
// The copy below is written to be true of a number that is neither.

import type { SeatState } from "./state.js";
import type { SeatContents } from "./storage-probe.js";

export interface SeatWatermark {
  /**
   * The gateway's log epoch this file is a copy of. A wake feed resumes from
   * `(epoch, applied)` — the seat's own applied position is the only cursor
   * anything resumes from since #996 W5.
   */
  readonly epoch: string;
  /** Where this file stands in the gateway's log. */
  readonly applied: number;
  /** The gateway's head, as of the last page this seat received. */
  readonly head: number;
  /** `head - applied`, never negative. */
  readonly behind: number;
  /** A large commit this seat declined to take is still owed. */
  readonly deferredPending: boolean;
  readonly contents: SeatContents;
}

export function seatWatermark(state: SeatState): SeatWatermark {
  const head = Math.max(state.gatewayWatermark, state.appliedSeq);
  return {
    epoch: state.epoch,
    applied: state.appliedSeq,
    head,
    behind: head - state.appliedSeq,
    deferredPending: state.deferredFrom !== undefined,
    contents: state.contents,
  };
}

/**
 * One line for the shell, per holding seat.
 *
 * DELIBERATELY NOT A ROW COUNT. The old custody line said "41,208 records",
 * which came from a census probe over a shape — a number that dies with census
 * in wave 5 and that never answered the question a member actually has, which
 * is not "how much is there" but "is what I am looking at current".
 *
 * `undefined` is a seat that has no copy, and the caller omits the clause
 * rather than printing a zero: "0 changes behind" reads as up to date.
 */
export function seatWatermarkLine(
  watermark: SeatWatermark | undefined
): string | undefined {
  if (!watermark) return undefined;
  if (watermark.deferredPending) {
    // Said first and said plainly: this one does not clear by waiting.
    return "a large update is waiting for wifi";
  }
  if (watermark.behind === 0) return "up to date";
  return `${watermark.behind.toLocaleString()} change${watermark.behind === 1 ? "" : "s"} behind`;
}
