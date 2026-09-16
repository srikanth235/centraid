package dev.centraid.shared

import dev.centraid.shared.platform.FakeNetworkStatus
import dev.centraid.shared.platform.NetworkStatus
import dev.centraid.shared.sync.RadioResume
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.shouldBe

/**
 * AIRPLANE MODE OFF REOPENS THE TAIL (#1025, R-SHELL-4).
 *
 * Live list item 4's second half: the header now goes OFFLINE when a pass
 * fails (R-SHELL-1), but nothing reopened the stream when the radio came
 * back. The member had to tap Sync now or leave and return. This table is
 * the airplane-mode journey, one assertion per edge, because a timer that
 * retried would be the poll D-1025-S7-40 deleted.
 *
 * Demonstrated red: the pre-fix shape (no listener, foreground and Sync now
 * the only openers) has no rising-edge act at all, so `RESUME` below is the
 * case that was missing.
 */
class RadioResumeSpec : StringSpec({

    "airplane mode on, while looking, is LOST" {
        RadioResume.act(looking = true, wasOnline = true, nowOnline = false) shouldBe
            RadioResume.Act.LOST
    }

    "airplane mode off, while looking, is RESUME" {
        RadioResume.act(looking = true, wasOnline = false, nowOnline = true) shouldBe
            RadioResume.Act.RESUME
    }

    "a first online reading is not a resume" {
        // The member just arrived; foreground() already opened the tail. A
        // monitor's first callback is "the path is satisfied", not "the radio
        // came back".
        RadioResume.act(looking = true, wasOnline = null, nowOnline = true) shouldBe
            RadioResume.Act.NONE
    }

    "a first offline reading while looking is LOST" {
        // Already in airplane mode when the session starts listening. The
        // header must not keep "synced" over a radio that has already said no.
        RadioResume.act(looking = true, wasOnline = null, nowOnline = false) shouldBe
            RadioResume.Act.LOST
    }

    "the same reading twice is NONE" {
        RadioResume.act(looking = true, wasOnline = true, nowOnline = true) shouldBe
            RadioResume.Act.NONE
        RadioResume.act(looking = true, wasOnline = false, nowOnline = false) shouldBe
            RadioResume.Act.NONE
    }

    "a radio change while the member is not looking is NONE" {
        // The tail is already closed (scenePhase / onPause). The next
        // foreground() is the opener; CONNECTIVITY does not start a tail
        // behind a backgrounded app (D-1025-S7-40, D-1025-S7-41).
        RadioResume.act(looking = false, wasOnline = false, nowOnline = true) shouldBe
            RadioResume.Act.NONE
        RadioResume.act(looking = false, wasOnline = true, nowOnline = false) shouldBe
            RadioResume.Act.NONE
    }

    "the JVM fake fires onChange from set, not from assigning reading" {
        val fake = FakeNetworkStatus()
        val heard = mutableListOf<Boolean>()
        fake.onChange { heard += it.online }
        fake.reading = NetworkStatus.Reading(online = false, metered = false, charging = false)
        heard.shouldBeEmpty()
        fake.set(NetworkStatus.Reading(online = false, metered = false, charging = false))
        heard shouldBe listOf(false)
    }
})
