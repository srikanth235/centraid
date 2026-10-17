package dev.centraid.shared.kit

import dev.centraid.design.copy.PhotosCopy

/**
 * **A RECORDING'S LENGTH AND A FILE'S SIZE, SPELLED ONCE.**
 *
 * Each was restated in both shells (a tile's clock, the viewer transport's
 * clock, the facts panel's clock and size), and `centraid_vault::page::
 * format_byte_size` is a third statement of the size rule: a member comparing a
 * photograph's size here with a document's in the drive should not be handed
 * two numbers for one amount. Over primitives so SwiftUI reaches it through the
 * framework as `MediaFormat.shared.clock(seconds:)`.
 */
public object MediaFormat {
    /**
     * `1:04`, `12:07`, `1:02:03`, with an hours arm: a clock without one reads
     * a 61-minute recording as `61:40`, the drift #883 B5 found between two
     * copies that claimed to be twins. A negative length is nought.
     */
    public fun clock(seconds: Long): String {
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

    /**
     * [clock] for a player's position, which is a fraction of a second and, for
     * a stream that has not loaded, NaN or infinite. Truncated, never rounded:
     * a clock that reads `0:05` at 4.9 seconds is ahead of the picture.
     */
    public fun clockOf(seconds: Double): String =
        clock(if (seconds.isFinite() && seconds > 0.0) seconds.toLong() else 0L)

    /**
     * DECIMAL, not binary, and one decimal above a megabyte: the rungs
     * `centraid_vault::page::format_byte_size` uses, and pinned to its rounding.
     *
     * **HALF UP IN INTEGER ARITHMETIC.** A float formatted with `%.1f` rounds
     * half to even on an exact tie (1 250 000 bytes is `1.2 MB`) and lands
     * either side of a decimal tie by the binary error of the quotient
     * (1 150 000 bytes is `1.1 MB`), while the core says `1.3` and `1.2` for the
     * same two files. A kilobyte is truncated, where a tenth would say nothing a
     * member could act on, and **rounding can cross a rung**: 999 999 999 bytes
     * is `1000.0 MB` by arithmetic and `1.0 GB` to a reader.
     */
    public fun bytes(count: Long): String {
        val size = maxOf(0L, count)
        return when {
            size < KB -> if (size == 1L) {
                PhotosCopy.PHOTOS_BYTE_ONE
            } else {
                PhotosCopy.PHOTOS_BYTES_MANY.replace("{count}", "$size")
            }
            size < MB -> "${size / KB} KB"
            size < GB -> {
                val tenths = tenths(size, MB)
                if (tenths >= TENTHS_IN_A_GIGABYTE) "${said(tenths(size, GB))} GB" else "${said(tenths)} MB"
            }
            else -> "${said(tenths(size, GB))} GB"
        }
    }

    /** `count / unit` in tenths, rounded half up. `count % unit * 10` cannot overflow a Long. */
    private fun tenths(count: Long, unit: Long): Long =
        (count / unit) * 10L + ((count % unit) * 10L + unit / 2L) / unit

    private fun said(tenths: Long): String = "${tenths / 10L}.${tenths % 10L}"

    private const val SECONDS_PER_MINUTE: Long = 60L
    private const val SECONDS_PER_HOUR: Long = 3_600L
    private const val KB: Long = 1_000L
    private const val MB: Long = 1_000_000L
    private const val GB: Long = 1_000_000_000L

    /** 1000.0 MB, in tenths: the rung a rounded megabyte count crosses into gigabytes. */
    private const val TENTHS_IN_A_GIGABYTE: Long = 10_000L
}
