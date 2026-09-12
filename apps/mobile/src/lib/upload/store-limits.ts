// Memory and retention bounds for the durable upload queue. Their own module
// so the tail helpers in `store-retention.ts` can read them without importing
// the store that imports them back.

/** The most queue rows one read materializes: a memory bound, not a product
 *  limit. Whole-queue answers are a SQL aggregate or a walk over pages. */
export const PENDING_PAGE_LIMIT = 500;

/** The terminal tail a device screen may still need, and the floor the
 *  retention sweep never prunes below (#1014, P25). */
export const RECENT_PAGE_LIMIT = 2000;

/** How long a settled or dismissed row is kept once nothing waits on it. */
export const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
