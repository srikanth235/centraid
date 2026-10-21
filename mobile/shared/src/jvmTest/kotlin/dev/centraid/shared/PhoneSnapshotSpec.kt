package dev.centraid.shared

import dev.centraid.design.copy.AgendaCopy
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.shared.apps.agenda.CalendarImport
import dev.centraid.shared.apps.agenda.PhoneEvent
import dev.centraid.shared.apps.agenda.PhoneSeries
import dev.centraid.shared.apps.people.ContactsImport
import dev.centraid.shared.apps.people.PhoneContact
import dev.centraid.shared.sync.phone.PhoneOriginRef
import dev.centraid.shared.sync.phone.PhoneSource
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe

/**
 * What a shell's read becomes for `PhoneSync` (#1127, lane B): the first pass of the contacts and
 * calendar importers. Ids and origins are the shell's; folding a series, the add-your-account
 * line and a refused series' fallback are this.
 */
class PhoneSnapshotSpec : StringSpec({

    "a contact is a record keyed by its phone id, in its origin, with the points the vault is told" {
        val batch = ContactsImport.batch(
            contacts = listOf(
                PhoneContact("  Ada   Lovelace ", listOf("(555) 010-0142"), listOf("ADA@x.com"), "12-10", "lookup:0r1", "account:google", "Google: ada@x.com"),
                PhoneContact("Bo", phoneId = "local:7"),
            ),
        )
        batch.complete shouldBe true
        batch.records.map { it.phoneId } shouldContainExactly listOf("lookup:0r1", "local:7")
        batch.records.map { it.origin } shouldContainExactly listOf("account:google", ContactsImport.DEFAULT_ORIGIN)
        batch.origins shouldContainExactly listOf(
            PhoneOriginRef("account:google", "Google: ada@x.com"),
            PhoneOriginRef(ContactsImport.DEFAULT_ORIGIN, PeopleCopy.IMPORT_ORIGIN_THIS_PHONE),
        )
        batch.records.first().name shouldBe "Ada Lovelace"
        batch.records.first().birthday shouldBe "12-10"
    }

    "the vault is told one command per account: the records, the device and whether the read was complete" {
        val ada = PhoneContact("Ada", listOf("(555) 010-0142"), listOf("ada@x.com"), "12-10", "lookup:0r1", "account:google", "Google")
        val bo = PhoneContact("Bo", phoneId = "local:7", origin = "account:google")
        val batch = ContactsImport.batch(listOf(ada, bo), complete = false)
        val input = ContactsImport.input(batch.origins.single(), batch.records, batch.complete, "device-a")
        input shouldBe "{\"origin\":{\"ref\":\"account:google\",\"label\":\"Google\",\"device_id\":\"device-a\"},\"records\":[" +
            "{\"external_id\":\"lookup:0r1\",\"device_id\":null,\"fields\":{\"title\":\"Ada\",\"birthday\":\"12-10\",\"points\":" +
            "[{\"kind\":\"phone\",\"value\":\"(555) 010-0142\"},{\"kind\":\"email\",\"value\":\"ada@x.com\"}]}}," +
            "{\"external_id\":\"local:7\",\"device_id\":\"device-a\",\"fields\":{\"title\":\"Bo\",\"birthday\":null,\"points\":[]}}]," +
            "\"complete\":false}"
    }

    "a contact with no name or no valid id is no record, and a phone id is one record" {
        val batch = ContactsImport.batch(
            listOf(
                PhoneContact("  ", phoneId = "local:1"),
                PhoneContact("No id"),
                PhoneContact("Bare id", phoneId = "12"),
                PhoneContact("Ada", phoneId = "local:2"),
                PhoneContact("Ada again", phoneId = "local:2"),
                PhoneContact("Ada", phoneId = "local:3"),
            ),
        )
        batch.records.map { it.phoneId } shouldContainExactly listOf("local:2", "local:3")
    }

    "an account with no contact is still an origin, so the vault is told of it" {
        val batch = ContactsImport.batch(
            listOf(PhoneContact("Ada", phoneId = "local:1", origin = "account:icloud")),
            origins = listOf(PhoneOriginRef("account:google", "Google"), PhoneOriginRef("account:icloud", "iCloud")),
            complete = false,
        )
        batch.origins.map { it.id } shouldContainExactly listOf("account:google", "account:icloud")
        batch.complete shouldBe false
    }

    "a read with no contacts and no accounts says to add an account (R-1127-8)" {
        val none = ContactsImport.Outcome(added = 0, refused = 0, addAccount = true)
        ContactsImport.sentence(none) shouldBe PeopleCopy.IMPORT_CONTACTS_ADD_ACCOUNT
        // Both shells show it, so it names the phone's Settings and no one platform's path in it.
        PeopleCopy.IMPORT_CONTACTS_ADD_ACCOUNT.contains("Settings") shouldBe true
        PeopleCopy.IMPORT_CONTACTS_ADD_ACCOUNT.contains("→") shouldBe false
        ContactsImport.sentence(ContactsImport.Outcome(added = 3, refused = 0)) shouldBe "3 people imported"
        ContactsImport.sentence(ContactsImport.Outcome(added = 0, refused = 0)) shouldBe PeopleCopy.IMPORT_CONTACTS_NONE
    }

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
    val now = 1_792_000_000_000L

    "a repeating series is ONE record keyed by its id, and a single event one keyed by its own" {
        val snapshot = CalendarImport.snapshot(
            listOf(occurrence("2026-10-12T09:00:00"), occurrence("2026-10-19T09:00:00"), occurrence("2026-10-26T10:00:00", true, "2026-10-26T09:00:00"), lunch),
            now = now,
        )
        snapshot.source shouldBe PhoneSource.CALENDAR
        snapshot.records.map { it.phoneId } shouldContainExactly listOf("uid:lunch@google", "uid:standup@google")
        snapshot.origins shouldContainExactly listOf(PhoneOriginRef("calendar:work", "Work (Google)"))
        val series = snapshot.records.last()
        series.fields.canonical().contains("start=2026-10-05T09:00:00") shouldBe true
        series.fields.canonical().contains("rrule=FREQ=WEEKLY;BYDAY=MO") shouldBe true
        snapshot.records.first().matchKey shouldBe "lunch"
    }

    "an event with no valid id is skipped, and one id is one record" {
        val snapshot = CalendarImport.snapshot(
            listOf(lunch.copy(phoneId = ""), lunch.copy(phoneId = "12"), lunch, lunch.copy(title = "Lunch, again")),
            now = now,
        )
        snapshot.records.map { it.phoneId } shouldContainExactly listOf("uid:lunch@google")
    }

    "a series the vault refuses is followed as its occurrences, each keyed series-id@start" {
        val snapshot = CalendarImport.snapshot(
            listOf(occurrence("2026-10-12T09:00:00"), occurrence("2026-10-26T10:00:00", true, "2026-10-26T09:00:00")),
            now = now,
            expanded = setOf("uid:standup@google"),
        )
        snapshot.records.map { it.phoneId } shouldContainExactly listOf(
            "uid:standup@google@2026-10-12T09:00:00",
            "uid:standup@google@2026-10-26T09:00:00",
        )
    }

    "a pass that finds a series refused runs again with it expanded, and the next pass expands it from the links alone" {
        val store = FakeStore(PhoneSource.CALENDAR)
        store.refuse = { it.phoneId == "uid:standup@google" }
        val events = listOf(occurrence("2026-10-12T09:00:00"), occurrence("2026-10-19T09:00:00"), lunch)
        val first = CalendarImport.sync(store, events, emptyList(), complete = true, now = now)
        first.added shouldBe 3
        first.refused shouldBe 0
        store.links.values.map { it.phoneId }.sorted() shouldContainExactly listOf(
            "uid:lunch@google",
            "uid:standup@google@2026-10-12T09:00:00",
            "uid:standup@google@2026-10-19T09:00:00",
        )
        store.writes.clear()
        val again = CalendarImport.sync(store, events, emptyList(), complete = true, now = now)
        again.added shouldBe 0
        again.trashed shouldBe 0
        store.writes.none { it == "add" || it == "trash" } shouldBe true
    }

    "a read with no events and no calendars says to add an account (R-1127-8)" {
        CalendarImport.sentence(CalendarImport.Outcome(added = 0, refused = 0, addAccount = true)) shouldBe
            AgendaCopy.IMPORT_CALENDAR_ADD_ACCOUNT
        AgendaCopy.IMPORT_CALENDAR_ADD_ACCOUNT.contains("→") shouldBe false
        CalendarImport.sentence(CalendarImport.Outcome(added = 1, refused = 0)) shouldBe AgendaCopy.IMPORT_CALENDAR_ONE
        CalendarImport.sync(FakeStore(PhoneSource.CALENDAR), emptyList(), emptyList(), complete = true, now = now).addAccount shouldBe true
        CalendarImport.sync(
            FakeStore(PhoneSource.CALENDAR),
            emptyList(),
            listOf(PhoneOriginRef("calendar:work", "Work")),
            complete = true,
            now = now,
        ).addAccount shouldBe false
    }
})
