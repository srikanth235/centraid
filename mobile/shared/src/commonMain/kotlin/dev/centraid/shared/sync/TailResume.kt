package dev.centraid.shared.sync

/**
 * A DEAD TAIL WHILE THE MEMBER IS LOOKING IS REOPENED (#1025, R-SHELL-5).
 *
 * Gateway restart is the case [RadioResume] cannot see: the path stays
 * satisfied, the QUIC stream dies, and nothing in the OS fires. The three
 * occasions still do not grow a fourth, and this is not a poll — a live tail
 * still has no interval (D-1025-S7-40). What is scheduled is the reopen of a
 * stream that has already ended, so the foreground occasion can "stay open as
 * long as the OS allows".
 *
 * Cancelled when the member leaves, when the radio drops (wait for
 * [RadioResume] instead), and when the stop was ours (`stopTail`).
 */
internal object TailResume {
    /** Cap while the member is looking. The outbox's five-minute ceiling is for a background intent, not a header they are watching. */
    internal const val CEILING_MS: Long = 30_000

    internal fun shouldReconnect(
        looking: Boolean,
        stopping: Boolean,
        radioOnline: Boolean?,
    ): Boolean = looking && !stopping && radioOnline != false

    /**
     * `1s · 2^min(attempt, 5)`, capped at [CEILING_MS]. Deterministic, no
     * jitter: one device talking to one gateway, same reason as
     * `centraid_seat::chain::backoff_ms`.
     */
    internal fun backoffMs(attempt: Int): Long {
        val exponent = attempt.coerceAtLeast(0).coerceAtMost(5)
        return (1_000L shl exponent).coerceAtMost(CEILING_MS)
    }
}
