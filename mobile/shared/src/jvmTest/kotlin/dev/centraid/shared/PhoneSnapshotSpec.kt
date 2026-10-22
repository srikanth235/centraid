package dev.centraid.shared

import dev.centraid.design.copy.PeopleCopy
import dev.centraid.shared.apps.people.ContactsImport
import dev.centraid.shared.apps.people.PhoneContact
import dev.centraid.shared.sync.phone.PhoneOriginRef
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe

/**
 * What a shell's read of the address book becomes for the vault (#1127, lane B). Ids and origins
 * are the shell's; the add-your-account line is this. The calendar's is `CalendarFollowSpec`.
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
})
