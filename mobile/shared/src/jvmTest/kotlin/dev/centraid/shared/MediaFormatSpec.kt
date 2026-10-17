package dev.centraid.shared

import dev.centraid.shared.kit.MediaFormat
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

/**
 * A RECORDING'S LENGTH AND A FILE'S SIZE, said once for the tile, the player
 * and the facts panel.
 *
 * The byte table is `centraid_vault::page`'s own
 * (`a_byte_count_is_said_the_way_the_corpus_says_it`), row for row, plus the
 * ties a float formatter gets wrong: SwiftUI used to print these through
 * `%.1f`, which rounds an exact tie to even and a decimal tie by the binary
 * error of the quotient.
 */
class MediaFormatSpec : StringSpec({
    "a length reads m:ss, and h:mm:ss past the hour" {
        MediaFormat.clock(0L) shouldBe "0:00"
        MediaFormat.clock(4L) shouldBe "0:04"
        MediaFormat.clock(64L) shouldBe "1:04"
        MediaFormat.clock(727L) shouldBe "12:07"
        MediaFormat.clock(3_599L) shouldBe "59:59"
        MediaFormat.clock(3_600L) shouldBe "1:00:00"
        // A 61-minute recording is not `61:40`.
        MediaFormat.clock(3_700L) shouldBe "1:01:40"
        MediaFormat.clock(-5L) shouldBe "0:00"
    }

    "a player's fraction of a second is truncated, and a stream that has not loaded is nought" {
        MediaFormat.clockOf(4.9) shouldBe "0:04"
        MediaFormat.clockOf(3_700.2) shouldBe "1:01:40"
        MediaFormat.clockOf(Double.NaN) shouldBe "0:00"
        MediaFormat.clockOf(Double.POSITIVE_INFINITY) shouldBe "0:00"
        MediaFormat.clockOf(-1.0) shouldBe "0:00"
    }

    "a byte count is said at every rung and on both sides of each one" {
        listOf(
            0L to "0 bytes",
            1L to "1 byte",
            2L to "2 bytes",
            999L to "999 bytes",
            1_000L to "1 KB",
            880_000L to "880 KB",
            999_999L to "999 KB",
            1_000_000L to "1.0 MB",
            1_200_000L to "1.2 MB",
            1_999_999L to "2.0 MB",
            4_100_000L to "4.1 MB",
            999_999_999L to "1.0 GB",
            1_000_000_000L to "1.0 GB",
            84_200_000_000L to "84.2 GB",
        ).forEach { (count, said) -> MediaFormat.bytes(count) shouldBe said }
        MediaFormat.bytes(-1L) shouldBe "0 bytes"
    }

    "a tie goes up, as the core's formatter does it, not to even and not by binary error" {
        // 1.25 IS EXACT IN BINARY, so `%.1f` printed `1.2`; 1.15 IS NOT, and
        // printed `1.1`. The core says `1.3` and `1.2`.
        MediaFormat.bytes(1_250_000L) shouldBe "1.3 MB"
        MediaFormat.bytes(1_150_000L) shouldBe "1.2 MB"
        MediaFormat.bytes(2_250_000L) shouldBe "2.3 MB"
        MediaFormat.bytes(1_250_000_000L) shouldBe "1.3 GB"
        MediaFormat.bytes(1_050_000L) shouldBe "1.1 MB"
    }
})
