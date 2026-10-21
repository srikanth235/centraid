package dev.centraid.shared

import dev.centraid.shared.apps.people.ContactsImport
import dev.centraid.shared.apps.people.PhoneContact
import dev.centraid.shared.sync.phone.PhoneOriginRef
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain

/**
 * THE CONTACTS FOLLOWER SENDS RECORDS AND THE VAULT MERGES (#1135): one `follow.contacts` per
 * account, and nothing else. The merge itself (a field the member changed stands, a contact gone
 * from a complete read, a vault restored onto a new phone) is `crates/vault/tests/people.rs`.
 */
class ContactsFollowSpec : StringSpec({
    val ada = PhoneContact("Ada", listOf("555 010 0142"), phoneId = "lookup:1", origin = "account:google", originLabel = "Google")
    val bo = PhoneContact("Bo", phoneId = "local:2", origin = "account:icloud", originLabel = "iCloud")

    "an account is one follow command, and the counts the vault answers are the pass's outcome" {
        val script = ScriptedCore()
        script.answers = { _, input ->
            if (input.contains("account:google")) "{\"added\":1,\"matched\":2,\"updated\":3,\"trashed\":1}" else "{\"added\":0}"
        }
        val outcome = ContactsImport.run(script.core(), listOf(ada, bo), complete = true, device = "device-a")
        script.commands.map { it.first } shouldContainExactly listOf("follow.contacts", "follow.contacts")
        script.commands[0].second shouldContain "\"ref\":\"account:google\""
        script.commands[0].second shouldContain "\"complete\":true"
        outcome.added shouldBe 3
        outcome.updated shouldBe 3
        outcome.trashed shouldBe 1
        outcome.refused shouldBe 0
    }

    "an account the vault refused is counted by its contacts, and the other accounts still go" {
        val script = ScriptedCore()
        script.refuses = { false }
        val refusing = ScriptedCore()
        var calls = 0
        refusing.refuses = { calls++ == 0 }
        val outcome = ContactsImport.run(refusing.core(), listOf(ada, bo), device = "device-a")
        refusing.commands.size shouldBe 2
        outcome.refused shouldBe 1
    }

    "an account with no contact in it is still told, so the people that left it are the vault's to settle" {
        val script = ScriptedCore()
        ContactsImport.run(script.core(), emptyList(), listOf(PhoneOriginRef("account:google", "Google")), device = "device-a")
        script.commands.single().second shouldContain "\"records\":[]"
    }

    "a read with no contacts and no accounts sends nothing and says to add an account" {
        val script = ScriptedCore()
        val outcome = ContactsImport.run(script.core(), emptyList(), device = "device-a")
        script.commands.size shouldBe 0
        outcome.addAccount shouldBe true
    }
})
