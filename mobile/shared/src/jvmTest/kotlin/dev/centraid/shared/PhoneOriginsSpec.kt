package dev.centraid.shared

import dev.centraid.shared.apps.agenda.CalendarImport
import dev.centraid.shared.apps.people.ContactsImport
import dev.centraid.shared.apps.people.PhoneContact
import dev.centraid.shared.sync.phone.PhoneOriginRef
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe

/** What a shell's reading of containers and calendars becomes (R-1127-10): origins named, one record per person. */
class PhoneOriginsSpec : StringSpec({

    "a contact container is an origin named for the account the OS shows" {
        ContactsImport.container("ABC-123", "iCloud") shouldBe PhoneOriginRef("container:ABC-123", "iCloud")
        ContactsImport.container("L-1", "  Gmail  ") shouldBe PhoneOriginRef("container:L-1", "Gmail")
        ContactsImport.container("L-2", "").label shouldBe "This phone's contacts"
    }

    "a calendar is an origin labelled source and calendar, saying each only once" {
        CalendarImport.calendar("C1", "iCloud", "Home") shouldBe PhoneOriginRef("calendar:C1", "iCloud: Home")
        CalendarImport.calendar("C2", "Gmail", "Work").label shouldBe "Gmail: Work"
        CalendarImport.calendar("C3", "Birthdays", "Birthdays").label shouldBe "Birthdays"
        CalendarImport.calendar("C4", "", "Family").label shouldBe "Family"
        CalendarImport.calendar("C5", "iCloud", "").label shouldBe "iCloud"
        CalendarImport.calendar("C6", "", "").label shouldBe "This phone's calendars"
    }

    "a unified contact in two containers is ONE record, kept under the lowest origin id, whatever order they were read in" {
        val icloud = ContactsImport.container("B-icloud", "iCloud")
        val gmail = ContactsImport.container("A-gmail", "Gmail")
        fun read(origin: PhoneOriginRef) = PhoneContact("Ada", phoneId = "local:U1", origin = origin.id, originLabel = origin.label)
        val one = ContactsImport.batch(listOf(read(icloud), read(gmail)), listOf(icloud, gmail))
        val two = ContactsImport.batch(listOf(read(gmail), read(icloud)), listOf(icloud, gmail))
        one.records.map { it.origin } shouldContainExactly listOf("container:A-gmail")
        two.records.map { it.origin } shouldContainExactly listOf("container:A-gmail")
        // Both containers are origins present, the one that lost the contact too.
        one.origins.map { it.id }.sorted() shouldContainExactly listOf("container:A-gmail", "container:B-icloud")
    }

    "a contact that names no origin counts as this phone's, and loses to a named container only by its id" {
        val named = PhoneContact("Bo", phoneId = "local:U2", origin = "container:Z", originLabel = "Z")
        val bare = PhoneContact("Bo", phoneId = "local:U2")
        // "container:Z" < "local:this-phone".
        ContactsImport.batch(listOf(bare, named)).records.single().origin shouldBe "container:Z"
        ContactsImport.batch(listOf(named, bare)).records.single().origin shouldBe "container:Z"
    }

    "different people are not merged, and a phone id that is no id is skipped as before" {
        val snapshot = ContactsImport.batch(
            listOf(
                PhoneContact("Ada", phoneId = "local:U1", origin = "container:A"),
                PhoneContact("Bo", phoneId = "local:U2", origin = "container:B"),
                PhoneContact("Nobody", phoneId = "12"),
            )
        )
        snapshot.records.map { it.phoneId } shouldContainExactly listOf("local:U1", "local:U2")
    }
})
