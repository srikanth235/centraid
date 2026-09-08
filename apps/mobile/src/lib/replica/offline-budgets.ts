/** Not a local budget: the gateway caps a subscription here too (#880). */
export { MAX_MULTIPLEX_REPLICA_SCOPES as MAX_MOUNTED_NATIVE_SCOPES } from "@centraid/core/protocol";

export const MOBILE_REPLICA_BOOTSTRAP_WINDOW = 5_000;

/**
 * THE WINDOW A SCREEN'S WHOLE-ENTITY READ DECLARES (#922 E2).
 *
 * `acceptTruncation` says "the default window is fine"; the default is 1,000,
 * which at the year-3 roster of 5,000 people silently becomes a screen the
 * member counts. A screen that draws a whole entity declares the year-3 volume
 * instead, so the page it renders is the page the vault holds — and a library
 * past it still says so on the one status line, because a declared window that
 * fills is still a truncation.
 */
export const MOBILE_ENTITY_READ_WINDOW = 5_000;
export const THUMBNAIL_SOURCE_BUDGET_BYTES = 128 * 1024 * 1024;

/**
 * Store-wide, not per source, and pins never evict from it (#883 C6).
 * Per-vault sub-budgets would refuse a download a member explicitly asked for.
 */
export const OFFLINE_CONTENT_BUDGET_BYTES = 256 * 1024 * 1024;
