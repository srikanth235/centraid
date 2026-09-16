package dev.centraid.shared

import dev.centraid.shared.sync.TailResume
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

/**
 * A DEAD TAIL WHILE LOOKING REOPENS (#1025, R-SHELL-5).
 *
 * Live list item 4, gateway-restart half: the radio never moves, the stream
 * dies, and until this table there was no opener except Sync now or a
 * leave/return. Demonstrated red: the pre-fix shape returns false for the
 * looking + radio-still-up case, which is the restart.
 *
 * The backoff is the reopen of a stream that has ended, not a poll of a live
 * one. Leave, our own stop, and a radio-down are the three cancellations.
 */
class TailResumeSpec : StringSpec({

    "a dead tail while looking, radio still up, is reopened" {
        TailResume.shouldReconnect(
            looking = true,
            stopping = false,
            radioOnline = true,
        ) shouldBe true
    }

    "an unheard radio is treated as up, so a restart still reconnects" {
        // Null is "we have not heard yet", not "offline". Waiting for a
        // path event here would miss every restart on a phone that never
        // toggled airplane mode.
        TailResume.shouldReconnect(
            looking = true,
            stopping = false,
            radioOnline = null,
        ) shouldBe true
    }

    "our own stop does not reconnect" {
        TailResume.shouldReconnect(
            looking = true,
            stopping = true,
            radioOnline = true,
        ) shouldBe false
    }

    "a leave does not reconnect" {
        TailResume.shouldReconnect(
            looking = false,
            stopping = false,
            radioOnline = true,
        ) shouldBe false
    }

    "a radio-down waits for RadioResume, not this backoff" {
        TailResume.shouldReconnect(
            looking = true,
            stopping = false,
            radioOnline = false,
        ) shouldBe false
    }

    "backoff is 1s · 2^n, capped at 30s" {
        TailResume.backoffMs(0) shouldBe 1_000
        TailResume.backoffMs(1) shouldBe 2_000
        TailResume.backoffMs(2) shouldBe 4_000
        TailResume.backoffMs(4) shouldBe 16_000
        TailResume.backoffMs(5) shouldBe TailResume.CEILING_MS
        TailResume.backoffMs(9) shouldBe TailResume.CEILING_MS
        TailResume.backoffMs(-1) shouldBe 1_000
    }
})
