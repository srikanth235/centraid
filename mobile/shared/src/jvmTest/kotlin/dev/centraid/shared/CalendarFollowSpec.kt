package dev.centraid.shared

import dev.centraid.design.copy.AgendaCopy
import dev.centraid.shared.apps.agenda.CalendarImport
import dev.centraid.shared.apps.agenda.PhoneEvent
import dev.centraid.shared.apps.agenda.PhoneSeries
import dev.centraid.shared.sync.phone.PhoneOriginRef
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

/**
 * THE CALENDAR FOLLOWER SENDS RECORDS AND THE VAULT MERGES (#1135): one `follow.calendar` per
 * calendar, and nothing else. The merge itself (a field the member changed stands, a series' skipped
 * and moved days, an event gone from a complete read, a vault restored onto a new phone) is
 * `crates/vault/tests/agenda.rs`; what the phone says of a series' days is what it SEES, because it
 * has no rule engine and the vault has.
 */
class CalendarFollowSpec : StringSpec({
    val now = 1_792_000_000_000L
    val weekly = PhoneSeries("uid:standup@google", "FREQ=WEEKLY;BYDAY=MO", "2026-10-05T09:00:00", "2026-10-05T09:30:00")
    fun occurrence(start: String, moved: Boolean = false, original: String = "") = PhoneEvent(
        title = "Standup", start = start, end = start.take(11) + "09:30:00", tz = "America/Los_Angeles",
        series = weekly, originalStart = original, moved = moved, phoneId = "local:ek-${start.take(10)}",
        origin = "calendar:work", originLabel = "Work (Google)",
    )
    val lunch = PhoneEvent(
        title = " Lunch ", start = "2026-10-21T12:00:00", end = "2026-10-21T13:00:00", tz = "UTC",
        phoneId = "uid:lunch@google", origin = "calendar:work", originLabel = "Work (Google)",
    )
    fun batch(vararg events: PhoneEvent) = CalendarImport.batch(events.toList(), now = now, deviceTz = "Europe/Paris")

    "an event is a record keyed by its own id, with the wall clock and the zone the vault resolves" {
        val batch = batch(lunch, lunch.copy(phoneId = "local:ek-2", title = "Gym", free = true, tz = ""))
        batch.records.map { it.phoneId } shouldContainExactly listOf("uid:lunch@google", "local:ek-2")
        batch.origins shouldContainExactly listOf(PhoneOriginRef("calendar:work", "Work (Google)"))
        val first = batch.records.first().fields
        first shouldContain "\"title\":\"Lunch\""
        first shouldContain "\"starts\":\"2026-10-21T12:00:00\""
        first shouldContain "\"timing\":\"zoned\",\"zone\":\"UTC\""
        first shouldContain "\"busy\":true"
        first shouldNotContain "overrides"
        // A free event does not block its time, and one with no zone of its own is the device's.
        val second = batch.records.last().fields
        second shouldContain "\"busy\":false"
        second shouldContain "\"zone\":\"Europe/Paris\""
    }

    "an all-day event is its days, and with no zone known a timed one is floating" {
        val day = lunch.copy(allDay = true, start = "2026-10-21", end = "2026-10-22")
        batch(day).records.single().fields shouldContain "\"starts\":\"2026-10-21\",\"ends\":\"2026-10-22\",\"timing\":\"all-day\",\"zone\":null"
        val floating = CalendarImport.batch(listOf(lunch.copy(tz = "")), now = now, deviceTz = "")
        floating.records.single().fields shouldContain "\"timing\":\"floating\",\"zone\":null"
    }

    "a repeating series is ONE record keyed by its id, and states the days it shows and the ones it moved" {
        val batch = batch(
            occurrence("2026-10-12T09:00:00"),
            occurrence("2026-10-19T09:00:00"),
            occurrence("2026-10-26T10:00:00", true, "2026-10-26T09:00:00"),
            lunch,
        )
        batch.records.map { it.phoneId } shouldContainExactly listOf("uid:lunch@google", "uid:standup@google")
        val series = batch.records.last().fields
        series shouldContain "\"starts\":\"2026-10-05T09:00:00\""
        series shouldContain "\"rule\":\"FREQ=WEEKLY;BYDAY=MO\""
        series shouldContain "\"shown\":[\"2026-10-12T09:00:00\",\"2026-10-19T09:00:00\"]"
        series shouldContain "\"moved\":[{\"original_start\":\"2026-10-26T09:00:00\",\"starts\":\"2026-10-26T10:00:00\""
        series shouldContain "\"from\":\""
    }

    "an event with no valid id or no title is skipped, and one id is one record" {
        val batch = batch(lunch.copy(phoneId = ""), lunch.copy(phoneId = "12"), lunch.copy(title = " "), lunch, lunch.copy(title = "Lunch, again"))
        batch.records.map { it.phoneId } shouldContainExactly listOf("uid:lunch@google")
    }

    "a calendar is one follow command, and the counts the vault answers are the pass's outcome" {
        val script = ScriptedCore()
        script.answers = { _, _ -> "{\"added\":1,\"matched\":2,\"updated\":3,\"trashed\":1,\"refused\":1}" }
        val other = lunch.copy(phoneId = "uid:b", origin = "calendar:home", originLabel = "Home")
        val outcome = CalendarImport.run(script.core(), listOf(lunch, other), "UTC", now, complete = true, device = "device-a")
        script.commands.map { it.first } shouldContainExactly listOf("follow.calendar", "follow.calendar")
        script.commands[0].second shouldContain "\"ref\":\"calendar:work\""
        script.commands[0].second shouldContain "\"complete\":true"
        outcome.added shouldBe 6
        outcome.updated shouldBe 6
        outcome.trashed shouldBe 2
        outcome.refused shouldBe 2
    }

    "a calendar the vault refused is counted by its events, and the others still go" {
        val refusing = ScriptedCore()
        var calls = 0
        refusing.refuses = { calls++ == 0 }
        val other = lunch.copy(phoneId = "uid:b", origin = "calendar:home", originLabel = "Home")
        val outcome = CalendarImport.run(refusing.core(), listOf(lunch, other), "UTC", now, device = "device-a")
        refusing.commands.size shouldBe 2
        outcome.refused shouldBe 1
    }

    "a read with no events and no calendars sends nothing and says to add an account" {
        val script = ScriptedCore()
        val outcome = CalendarImport.run(script.core(), emptyList(), "UTC", now, device = "device-a")
        script.commands.size shouldBe 0
        outcome.addAccount shouldBe true
        CalendarImport.sentence(outcome) shouldBe AgendaCopy.IMPORT_CALENDAR_ADD_ACCOUNT
        // A calendar with nothing in it is still told, so what left it is the vault's to settle.
        CalendarImport.run(script.core(), emptyList(), "UTC", now, listOf(PhoneOriginRef("calendar:work", "Work")), device = "device-a").addAccount shouldBe false
        script.commands.single().second shouldContain "\"records\":[]"
    }
})
