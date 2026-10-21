package dev.centraid.shared

import dev.centraid.shared.sync.phone.FollowGate
import dev.centraid.shared.sync.phone.FollowStep
import dev.centraid.shared.sync.phone.PhoneSource
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

/** `FollowGate`: when a following pass runs (#1127). Pure, so every case is a list of (time, call). */
class FollowGateSpec : StringSpec({
    val contacts = PhoneSource.CONTACTS
    val calendar = PhoneSource.CALENDAR

    "the first trigger arms a two-second timer, and the timer starts the pass" {
        val gate = FollowGate()
        gate.request(contacts, 0) shouldBe FollowStep.Arm(2_000)
        gate.fire(contacts, 2_000) shouldBe FollowStep.Start
    }

    "triggers within two seconds are one pass" {
        val gate = FollowGate()
        gate.request(contacts, 0) shouldBe FollowStep.Arm(2_000)
        gate.request(contacts, 500) shouldBe FollowStep.Nothing
        gate.request(contacts, 1_999) shouldBe FollowStep.Nothing
        gate.fire(contacts, 2_000) shouldBe FollowStep.Start
        gate.finish(contacts) shouldBe FollowStep.Nothing
    }

    "the wait runs from the FIRST trigger, so a store that never stops announcing still gets a pass" {
        val gate = FollowGate()
        gate.request(contacts, 0)
        for (at in 1..1_999 step 100) gate.request(contacts, at.toLong())
        gate.fire(contacts, 2_000) shouldBe FollowStep.Start
    }

    "a timer that fires early starts nothing, and the gate still waits" {
        val gate = FollowGate()
        gate.request(contacts, 0)
        gate.fire(contacts, 1_999) shouldBe FollowStep.Nothing
        gate.fire(contacts, 2_000) shouldBe FollowStep.Start
    }

    "a timer that fires with nothing armed starts nothing" {
        FollowGate().fire(contacts, 5_000) shouldBe FollowStep.Nothing
    }

    "only one pass runs per source at a time" {
        val gate = FollowGate()
        gate.request(contacts, 0)
        gate.fire(contacts, 2_000) shouldBe FollowStep.Start
        gate.fire(contacts, 2_001) shouldBe FollowStep.Nothing
    }

    "triggers during a pass queue exactly one more, which starts when the first ends" {
        val gate = FollowGate()
        gate.request(contacts, 0)
        gate.fire(contacts, 2_000) shouldBe FollowStep.Start
        repeat(5) { gate.request(contacts, 2_100L + it) shouldBe FollowStep.Nothing }
        gate.finish(contacts) shouldBe FollowStep.Start
        gate.finish(contacts) shouldBe FollowStep.Nothing
    }

    "a trigger after a pass ended arms a new timer" {
        val gate = FollowGate()
        gate.request(contacts, 0)
        gate.fire(contacts, 2_000)
        gate.finish(contacts) shouldBe FollowStep.Nothing
        gate.request(contacts, 9_000) shouldBe FollowStep.Arm(2_000)
        gate.fire(contacts, 11_000) shouldBe FollowStep.Start
    }

    "a trigger while the queued pass runs queues one more, not two" {
        val gate = FollowGate()
        gate.request(contacts, 0)
        gate.fire(contacts, 2_000)
        gate.request(contacts, 2_100)
        gate.finish(contacts) shouldBe FollowStep.Start
        gate.request(contacts, 2_200)
        gate.request(contacts, 2_300)
        gate.finish(contacts) shouldBe FollowStep.Start
        gate.finish(contacts) shouldBe FollowStep.Nothing
    }

    "sources do not hold each other up" {
        val gate = FollowGate()
        gate.request(contacts, 0)
        gate.fire(contacts, 2_000) shouldBe FollowStep.Start
        gate.request(calendar, 2_100) shouldBe FollowStep.Arm(2_000)
        gate.fire(calendar, 4_100) shouldBe FollowStep.Start
    }

    "a finish with no pass running starts nothing" {
        FollowGate().finish(contacts) shouldBe FollowStep.Nothing
    }
})
