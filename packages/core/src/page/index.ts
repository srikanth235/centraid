/*
 * THE PAGE, as one import (#996 wave 4).
 *
 * A barrel and nothing else. `window.ts` holds the shape and the probe;
 * `statement.ts` holds the statement-as-data and its assembler, which the seat,
 * the seat worker and the gateway's paged door all run (W4-D2). The two are
 * separate files because the statement imports the probe and a barrel that
 * imported both back would be a cycle.
 */

export { MAX_PAGE_ROWS, pageOf, probeLimit } from "./window.js";
export type { Page, PageCursor, PageRequest } from "./window.js";
export { pageCursorOf, pageStatement } from "./statement.js";
export type {
  PageBindValue,
  PageOrder,
  PageQuery,
  PageStatement,
} from "./statement.js";
