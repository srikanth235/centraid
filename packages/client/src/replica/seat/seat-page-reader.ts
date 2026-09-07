/*
 * THE SHELL'S END OF A PAGED HANDLER (#996 wave 4).
 *
 * The seat holds the whole vault, so an app read is plain SQL over the file —
 * but the file is behind a worker, because the applier that shares it can run
 * for hundreds of thousands of rows and must not do that on the thread that
 * paints. So the shell's read is async, and this is the whole of that
 * difference: the statement is assembled by `pageStatement`, the same
 * function the in-process host uses, and the probe row is dropped and the
 * cursor derived here rather than in the worker.
 *
 * WHY THE WORKER RETURNS ROWS AND NOTHING ELSE. A second result shape across
 * the boundary is a second thing to keep in step, and the only extra fact a
 * page carries — "is there another one" — is derivable from the rows the worker
 * already sent. `query` stays the coarse, unopinionated seam
 * `worker-protocol.ts` describes.
 *
 * THE OVERLAY IS PART OF THE READ, NOT AN OPTION ON IT. A read that shows a
 * member a list of their own things passes it; a read that is measuring the
 * file — a count, a parity check — must not. Dropping it on a list is silent:
 * the rows come back, correct as far as the gateway knows, with the member's
 * own unsettled write missing (R23–R25).
 */

import { pageCursorOf, pageOf, pageStatement } from "@centraid/core/page";
import type { Page, PageQuery, PageRequest } from "@centraid/core/page";

import { countSeatPageWork } from "./paged-handler.js";
import type { SeatReadOverlay } from "./read-overlay.js";
import type { SeatWorkerQuery } from "./worker-protocol.js";

/**
 * The one method of the seat worker client this reader needs.
 *
 * Structural rather than the class itself: `SeatWorkerClient` is typed against
 * `MessageEvent` and `ErrorEvent`, which do not exist in a React Native
 * typecheck, and this module has no other reason to drag them in.
 */
export interface SeatQueryPort {
  query: <T extends object>(request: SeatWorkerQuery) => Promise<T[]>;
}

/** One page of a handler, read across the worker boundary. */
export async function seatWorkerPage<Row extends object>(
  port: SeatQueryPort,
  query: PageQuery<Row>,
  request: PageRequest,
  overlay?: SeatReadOverlay
): Promise<Page<Row>> {
  const statement = pageStatement(query, request);
  const rows = await port.query<Row>({
    sql: statement.sql,
    bind: statement.bind,
    ...(overlay ? { overlay } : {}),
  });
  countSeatPageWork(rows.length);
  return pageOf(rows, request, (row) =>
    pageCursorOf(row as Record<string, unknown>, query.order)
  );
}
