package dev.centraid.shared

import centraid.core.v1.AgendaEvent
import dev.centraid.shared.apps.agenda.CalendarImport
import dev.centraid.shared.apps.agenda.CalendarImport.HeldException
import dev.centraid.shared.apps.agenda.CalendarStore
import dev.centraid.shared.apps.agenda.PhoneEvent
import dev.centraid.shared.apps.agenda.PhoneSeries
import dev.centraid.shared.apps.people.ContactsImport
import dev.centraid.shared.apps.people.ContactsStore
import dev.centraid.shared.apps.people.PhoneContact
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import kotlin.time.Instant

/**
 * THE TWO STORES' HALVES OF GAPS 1 AND 2 (#1127, lane C), run for real over a scripted vault: a
 * followed contact's BIRTHDAY is added, moved and removed, and a followed series' SKIPPED and
 * MOVED occurrences are followed, restored included.
 */
class PhoneStoresSpec : StringSpec({
    val readAt = "2026-10-20T10:00:00.000Z"

    // -----------------------------------------------------------------------------------------
    // Gap 1: the birthday
    // -----------------------------------------------------------------------------------------

    fun record(birthday: String) = ContactsImport.snapshot(
        listOf(PhoneContact("Ada", birthday = birthday, phoneId = "local:1")),
        readAt = readAt,
    ).records.single()

    fun birthdayScript(vararg dates: Pair<String, String>) = ScriptedCore().also { script ->
        script.pages = { name, _ ->
            when (name) {
                "phone.people.birthday" -> dates.map { listOf(it.first, it.second) }
                else -> emptyList()
            }
        }
    }

    fun birthdayCommands(script: ScriptedCore) = script.commands.filter { it.first.endsWith("important_date") }

    "the birthday is a phone-owned field: the same name with another birthday is another fingerprint" {
        record("08-14").fields.digest() shouldBe record("08-14").fields.digest()
        (record("08-14").fields.digest() == record("09-01").fields.digest()) shouldBe false
        (record("08-14").fields.digest() == record("").fields.digest()) shouldBe false
        record("08-14").fields.canonical() shouldContain "birthday=08-14"
        // Not a day of the year: no birthday at all.
        record("2000-08-14").fields.canonical() shouldNotContain "birthday"
    }

    "a person's birthday is read into the vault row, so a member's own birthday edit reads as an edit" {
        val script = ScriptedCore()
        script.pages = { name, _ ->
            when (name) {
                "phone.people.profiles" -> listOf(listOf("pr1", "p1", ""))
                "phone.people.names" -> listOf(listOf("p1", "Ada"))
                "phone.people.birthdays" -> listOf(listOf("d1", "p1", "08-14"))
                else -> emptyList()
            }
        }
        val rows = ContactsStore(script.core(), "device-a").rows()!!
        rows.getValue("p1").fields shouldBe record("08-14").fields
    }

    "a birthday that arrived on the phone is added" {
        val script = birthdayScript()
        ContactsStore(script.core(), "device-a").update("p1", record("08-14")) shouldBe true
        birthdayCommands(script).map { it.first } shouldContainExactly listOf("people.add_important_date")
        birthdayCommands(script).single().second shouldContain "\"month_day\":\"08-14\""
        birthdayCommands(script).single().second shouldContain "\"party_id\":\"p1\""
    }

    "a birthday that moved on the phone is edited in place" {
        val script = birthdayScript("d1" to "08-14")
        ContactsStore(script.core(), "device-a").update("p1", record("09-01")) shouldBe true
        birthdayCommands(script) shouldContainExactly listOf("people.edit_important_date" to "{\"date_id\":\"d1\",\"month_day\":\"09-01\"}")
    }

    "a birthday that went from the phone is deleted, every row of it" {
        val script = birthdayScript("d1" to "08-14", "d2" to "08-14")
        ContactsStore(script.core(), "device-a").update("p1", record("")) shouldBe true
        birthdayCommands(script).map { it.second } shouldContainExactly listOf("{\"date_id\":\"d1\"}", "{\"date_id\":\"d2\"}")
    }

    "a birthday the vault already has changes nothing" {
        val script = birthdayScript("d1" to "08-14")
        ContactsStore(script.core(), "device-a").update("p1", record("08-14")) shouldBe true
        birthdayCommands(script).shouldBeEmpty()
        val none = birthdayScript()
        ContactsStore(none.core(), "device-a").update("p1", record("")) shouldBe true
        birthdayCommands(none).shouldBeEmpty()
    }

    "a refused birthday write is a refused update, so the pass tries again" {
        val script = birthdayScript("d1" to "08-14")
        script.refuses = { it == "people.edit_important_date" }
        ContactsStore(script.core(), "device-a").update("p1", record("09-01")) shouldBe false
    }

    // -----------------------------------------------------------------------------------------
    // Gap 2: the series' exceptions
    // -----------------------------------------------------------------------------------------

    // A Monday standup, 09:00 UTC; the spec reads at Tuesday 2026-10-20 12:00 UTC.
    val now = Instant.parse("2026-10-20T12:00:00Z").toEpochMilliseconds()
    val weekly = PhoneSeries("uid:standup@google", "FREQ=WEEKLY;BYDAY=MO", "2026-10-05T09:00:00", "2026-10-05T09:30:00")

    fun occurrence(day: String, moved: Boolean = false, start: String = "${day}T09:00:00", end: String = "${day}T09:30:00") = PhoneEvent(
        title = "Standup", start = start, end = end, tz = "UTC", series = weekly,
        originalStart = if (moved) "${day}T09:00:00" else "", moved = moved,
        phoneId = "local:ek-$day", origin = "calendar:work", originLabel = "Work",
    )

    fun series(vararg events: PhoneEvent) = CalendarImport.plan(events.toList()).series.single()

    fun snapshotOf(vararg events: PhoneEvent) = CalendarImport.snapshot(events.toList(), now = now).records.single()

    /** The vault's own expansion of the series: each occurrence's key and its stored spelling. */
    fun expands(vararg days: String) = days.associate { "${it}T09:00:00" to "${it}T09:00:00" }

    fun inputs(edits: List<CalendarImport.OccurrenceEdit>) = edits.map { it.input }

    "an occurrence the phone no longer shows is skipped, and one it still shows is left" {
        val edits = CalendarImport.followEdits(
            series(occurrence("2026-10-19"), occurrence("2026-11-02")),
            "ev1",
            expands("2026-10-19", "2026-10-26", "2026-11-02"),
            held = emptyMap(),
            now = now,
            deviceTz = "UTC",
        )
        inputs(edits).single() shouldBe
            "{\"event_id\":\"ev1\",\"original_start_local\":\"2026-10-26T09:00:00\",\"scope\":\"occurrence\",\"action\":\"skip\"}"
    }

    "an occurrence the phone moved is overridden with its own times, keyed where the rule put it" {
        val edits = CalendarImport.followEdits(
            series(occurrence("2026-10-19"), occurrence("2026-10-26", moved = true, start = "2026-10-26T10:00:00", end = "2026-10-26T10:30:00"), occurrence("2026-11-02")),
            "ev1",
            expands("2026-10-19", "2026-10-26", "2026-11-02"),
            held = emptyMap(),
            now = now,
            deviceTz = "UTC",
        )
        val override = inputs(edits).single()
        override shouldContain "\"original_start_local\":\"2026-10-26T09:00:00\""
        override shouldContain "\"action\":\"override\""
        override shouldContain "\"dtstart\":\"2026-10-26T10:00:00\""
        override shouldContain "\"dtend\":\"2026-10-26T10:30:00\""
    }

    "an exception the phone removed is restored: a skip it put back, and an override it moved back" {
        val held = mapOf(
            "2026-10-26T09:00:00" to HeldException("skip", "2026-10-26T09:00:00"),
            "2026-11-02T09:00:00" to HeldException("override", "2026-11-02T09:00:00"),
        )
        val edits = CalendarImport.followEdits(
            series(occurrence("2026-10-19"), occurrence("2026-10-26"), occurrence("2026-11-02")),
            "ev1",
            // The skipped one is not in the vault's expansion; the moved one is, at its moved time.
            expands("2026-10-19", "2026-11-02"),
            held,
            now,
            "UTC",
        )
        inputs(edits) shouldContainExactly listOf(
            "{\"event_id\":\"ev1\",\"original_start_local\":\"2026-10-26T09:00:00\",\"scope\":\"occurrence\",\"action\":\"restore\"}",
            "{\"event_id\":\"ev1\",\"original_start_local\":\"2026-11-02T09:00:00\",\"scope\":\"occurrence\",\"action\":\"restore\"}",
        )
    }

    "nothing to follow is nothing written: a held exception the phone still agrees with, and one outside the window" {
        val held = mapOf(
            // Still skipped: the phone still does not show it.
            "2026-10-26T09:00:00" to HeldException("skip", "2026-10-26T09:00:00"),
            // Long past the window: the read could not have seen it.
            "2025-01-06T09:00:00" to HeldException("skip", "2025-01-06T09:00:00"),
        )
        CalendarImport.followEdits(
            series(occurrence("2026-10-19"), occurrence("2026-11-02")),
            "ev1",
            expands("2026-10-19", "2026-11-02"),
            held,
            now,
            "UTC",
        ).shouldBeEmpty()
    }

    "a moved occurrence with a held exception is overridden again, never restored" {
        val moved = occurrence("2026-10-26", moved = true, start = "2026-10-26T11:00:00", end = "2026-10-26T11:30:00")
        val edits = CalendarImport.followEdits(
            series(occurrence("2026-10-19"), moved),
            "ev1",
            expands("2026-10-19", "2026-10-26"),
            mapOf("2026-10-26T09:00:00" to HeldException("override", "2026-10-26T09:00:00")),
            now,
            "UTC",
        )
        edits.map { it.input.contains("\"action\":\"override\"") } shouldContainExactly listOf(true)
    }

    "the series' satellite changes when an occurrence is cancelled, moved or put back, and not otherwise" {
        val all = arrayOf(occurrence("2026-10-19"), occurrence("2026-10-26"), occurrence("2026-11-02"))
        val whole = snapshotOf(*all).satellite.digest()
        snapshotOf(*all).satellite.digest() shouldBe whole
        // Cancelled on the phone: it is no longer shown.
        (snapshotOf(all[0], all[2]).satellite.digest() == whole) shouldBe false
        // Moved on the phone.
        val moved = occurrence("2026-10-26", moved = true, start = "2026-10-26T10:00:00", end = "2026-10-26T10:30:00")
        (snapshotOf(all[0], moved, all[2]).satellite.digest() == whole) shouldBe false
        // Put back where it was: the digest is the first one again, which is what makes the restore follow.
        snapshotOf(all[0], all[1], all[2]).satellite.digest() shouldBe whole
        // The satellite is not part of the row's own fields.
        snapshotOf(all[0], moved, all[2]).fields shouldBe snapshotOf(*all).fields
    }

    "a single event has no satellite" {
        val lunch = PhoneEvent("Lunch", start = "2026-10-21T12:00:00", end = "2026-10-21T13:00:00", tz = "UTC", phoneId = "uid:lunch")
        snapshotOf(lunch).satellite.isEmpty() shouldBe true
    }

    fun calendarScript(held: List<List<String>> = emptyList(), upcoming: List<AgendaEvent>? = emptyList()) = ScriptedCore().also { script ->
        script.pages = { name, _ -> if (name == "phone.agenda.exceptions") held else emptyList() }
        script.upcoming = upcoming
    }

    fun vaultOccurrence(day: String) = AgendaEvent(event_id = "ev1", dtstart = "${day}T09:00:00.000Z", original_start_local = "${day}T09:00:00")

    "the store writes the exceptions through schedule.edit_event_occurrence, one command each" {
        val script = calendarScript(
            held = listOf(listOf("x1", "ev1", "2026-11-02T09:00:00", "occurrence", "skip", "")),
            upcoming = listOf(vaultOccurrence("2026-10-19"), vaultOccurrence("2026-10-26")),
        )
        val followed = snapshotOf(occurrence("2026-10-19"), occurrence("2026-11-02"))
        CalendarStore(script.core(), "cal", "UTC", now, "device-a").follow("ev1", followed) shouldBe true
        script.commands.map { it.first }.distinct() shouldContainExactly listOf("schedule.edit_event_occurrence")
        script.commands.map { c -> listOf("skip", "restore").first { c.second.contains("\"action\":\"$it\"") } } shouldContainExactly
            listOf("skip", "restore")
    }

    "a vault read that fails writes nothing, and a refused write is a refused follow" {
        val unread = calendarScript(upcoming = null)
        CalendarStore(unread.core(), "cal", "UTC", now, "device-a")
            .follow("ev1", snapshotOf(occurrence("2026-10-19"))) shouldBe false
        unread.commands.shouldBeEmpty()

        val refusing = calendarScript(upcoming = listOf(vaultOccurrence("2026-10-19"), vaultOccurrence("2026-10-26")))
        refusing.refuses = { true }
        CalendarStore(refusing.core(), "cal", "UTC", now, "device-a")
            .follow("ev1", snapshotOf(occurrence("2026-10-19"))) shouldBe false
    }

    "an event that is not a series has nothing to follow" {
        val script = calendarScript()
        val lunch = PhoneEvent("Lunch", start = "2026-10-21T12:00:00", end = "2026-10-21T13:00:00", tz = "UTC", phoneId = "uid:lunch")
        CalendarStore(script.core(), "cal", "UTC", now, "device-a").follow("ev1", snapshotOf(lunch)) shouldBe true
        script.commands.shouldBeEmpty()
    }
})
