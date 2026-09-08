/**
 * Mounts the BACKGROUND pass keeps current in one radio (#880, #996 wave 3).
 *
 * Not a local budget: the gateway caps a subscription at the same number, and
 * the phone attaches the same N — one wire agreement, not two. It is no longer
 * a READ cap: a seat opens one file, and the vault switcher offers every vault
 * the gateway granted. What it still bounds is how many of those files one
 * background pass keeps in step.
 */
export { MAX_REPLICA_FEED_MOUNTS as MAX_BACKGROUND_FEED_MOUNTS } from "@centraid/core/protocol";

/**
 * THE WINDOW A SCREEN'S WHOLE-ENTITY READ DECLARES (#922 E2).
 *
 * A screen that draws a whole entity declares the year-3 volume, so the page it
 * renders is the page the vault holds — and a library past it still says so on
 * the one status line, because a declared window that fills is still a
 * truncation.
 *
 * The reads that declared no window at all are gone (#996 wave 4b): they were
 * whole sets taking a 1,000-row default nobody chose, and each is a walk over
 * the seat now. What is left here is the window of the reads that were always
 * a window.
 */
export const MOBILE_ENTITY_READ_WINDOW = 5_000;
export const THUMBNAIL_SOURCE_BUDGET_BYTES = 128 * 1024 * 1024;

/**
 * Store-wide, not per source, and pins never evict from it (#883 C6).
 * Per-vault sub-budgets would refuse a download a member explicitly asked for.
 */
export const OFFLINE_CONTENT_BUDGET_BYTES = 256 * 1024 * 1024;
