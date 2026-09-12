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

/**
 * HOW OFTEN A FOREGROUNDED PHONE ASKS ANYWAY (#1014, R15/R22).
 *
 * The wake feed was the ONLY delivery trigger: when its request was cancelled
 * by the platform and never re-issued, a foregrounded phone sat 43 minutes
 * behind a gateway it could reach, and only a background→foreground transition
 * ever pulled. A feed is an optimisation — it makes delivery fast — and an
 * optimisation may not be the only path. This is the path that does not depend
 * on a socket surviving: while the app is foregrounded and believes it is
 * connected, it catches up on a clock.
 *
 * A minute is chosen against the cost: one catch-up over a level seat is one
 * conditional log-page request answering zero rows.
 */
export const REPLICA_PULL_INTERVAL_MS = 60_000;

/**
 * The gateway's SSE keep-alive period (`replica-routes.ts`,
 * `multiplex-replica-routes.ts` both default `heartbeatMs` to this). The feed
 * treats twice this with no byte at all as a dead socket and reconnects — a
 * TCP connection the platform has quietly stopped delivering on is
 * indistinguishable from a quiet vault except by the heartbeat that is missing.
 */
export const REPLICA_FEED_HEARTBEAT_MS = 15_000;
export const REPLICA_FEED_SILENCE_MS = 2 * REPLICA_FEED_HEARTBEAT_MS;
