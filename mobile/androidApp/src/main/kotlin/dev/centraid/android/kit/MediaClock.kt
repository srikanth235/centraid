package dev.centraid.android.kit

/**
 * A PLAYER'S TIME, as `m:ss` (and `h:mm:ss` past the hour): the one format a
 * photo tile's duration badge, the lightbox's scrubber and its spoken position
 * share, so a clip is the same length everywhere it is named. A length of a
 * stream the player has not loaded (NaN, infinite) is nought. Moved here with
 * the shared module's retirement (#1135); the byte formatter it sat beside is
 * the core's (`photos_bytes_many`), not a view's.
 */
object MediaClock {
    private const val SECONDS_PER_MINUTE: Long = 60L
    private const val SECONDS_PER_HOUR: Long = 3_600L

    /** `1:04`, `12:07`, `1:02:03`; a negative length is `0:00`. */
    fun clock(seconds: Long): String {
        val total = maxOf(0L, seconds)
        val hours = total / SECONDS_PER_HOUR
        val minutes = (total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE
        val rest = (total % SECONDS_PER_MINUTE).toString().padStart(2, '0')
        return if (hours > 0) {
            "$hours:" + minutes.toString().padStart(2, '0') + ":" + rest
        } else {
            "$minutes:$rest"
        }
    }

    /** A player's fractional seconds, truncated; a stream that has not loaded is nought. */
    fun clockOf(seconds: Double): String =
        clock(if (seconds.isFinite() && seconds > 0.0) seconds.toLong() else 0L)
}
