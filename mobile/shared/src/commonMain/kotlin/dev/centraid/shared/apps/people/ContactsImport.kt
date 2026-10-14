package dev.centraid.shared.apps.people

import dev.centraid.core.CentraidCore
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.shared.kit.PhoneImport
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/**
 * ONE CONTACT AS THE PHONE'S OWN ADDRESS BOOK HOLDS IT, read by the shell
 * (iOS `CNContactStore`, Android `ContactsContract`) after the member tapped
 * "Import contacts" and the OS asked its own permission.
 *
 * @property name the contact's display name; a contact with none is skipped.
 * @property phones its phone numbers, as the address book spells them.
 * @property emails its email addresses.
 * @property birthday `MM-DD`, or empty: the year is not asked for, because a
 *   People important date is a day of the year.
 */
public data class PhoneContact(
    public val name: String,
    public val phones: List<String> = emptyList(),
    public val emails: List<String> = emptyList(),
    public val birthday: String = "",
)

/**
 * CONTACTS → PEOPLE IN ONE TAP (docs/decisions.md, "Onboarding without sample
 * data").
 *
 * Onboarding's goal is time to the member's own data, and the phone already
 * holds the people they keep up with. People's day-one empty state offers the
 * import (`EmptyState.import_source`), the shell reads the address book once
 * the OS has said yes, and this writes each contact through the command plane
 * as the member's own rows: `people.add_person` with a phone-minted id, then
 * `people.save_contact_channel` per number and address, then
 * `people.add_important_date` for a birthday. Nothing is marked as imported —
 * they are the member's people, edited and deleted like any other.
 *
 * **Offered on day one**, when the roster is empty, so there is nothing to
 * merge into; duplicates WITHIN the address book (the same name twice, a
 * number listed twice) are folded here. A refused contact is counted and the
 * rest go on: one malformed address must not cost the member the other
 * hundred people.
 */
public object ContactsImport {
    /** What one import did. */
    public data class Outcome(
        public val added: Int,
        public val refused: Int,
    )

    /** THE PEOPLE AN ADDRESS BOOK MAKES: named, trimmed, and one per name. */
    public fun people(contacts: List<PhoneContact>): List<PhoneContact> {
        val seen = mutableSetOf<String>()
        return contacts.mapNotNull { contact ->
            val name = contact.name.trim()
            if (name.isEmpty() || !seen.add(name.lowercase())) return@mapNotNull null
            PhoneContact(
                name = name,
                phones = contact.phones.map(String::trim).filter(String::isNotEmpty).distinct(),
                emails = contact.emails.map(String::trim).filter(String::isNotEmpty).distinctBy(String::lowercase),
                birthday = contact.birthday.takeIf { MONTH_DAY.matches(it) }.orEmpty(),
            )
        }
    }

    /**
     * WRITE [contacts] INTO THE VAULT [core] HOLDS. A person whose
     * `add_person` was refused is counted as refused and none of its channels
     * are tried; a refused channel or birthday leaves the person in.
     */
    @OptIn(ExperimentalUuidApi::class)
    public suspend fun run(
        core: CentraidCore,
        contacts: List<PhoneContact>,
        mintId: () -> String = { Uuid.random().toString() },
    ): Outcome {
        var added = 0
        var refused = 0
        for (person in people(contacts)) {
            val partyId = mintId()
            val made = write(
                core,
                "people.add_person",
                "{\"party_id\":${quote(partyId)},\"display_name\":${quote(person.name)},\"cadence_days\":0}",
            )
            if (!made) {
                refused += 1
                continue
            }
            added += 1
            person.phones.forEach { phone ->
                write(core, "people.save_contact_channel", channel(partyId, "phone", phone))
            }
            person.emails.forEach { email ->
                write(core, "people.save_contact_channel", channel(partyId, "email", email))
            }
            if (person.birthday.isNotEmpty()) {
                write(
                    core,
                    "people.add_important_date",
                    "{\"party_id\":${quote(partyId)},\"label\":${quote(PeopleCopy.IMPORT_BIRTHDAY)}," +
                        "\"month_day\":${quote(person.birthday)}}",
                )
            }
        }
        return Outcome(added = added, refused = refused)
    }

    /** The one sentence the shell shows when an import ends. */
    public fun sentence(outcome: Outcome): String = when {
        outcome.added == 0 && outcome.refused == 0 -> PeopleCopy.IMPORT_CONTACTS_NONE
        outcome.added == 0 -> PeopleCopy.IMPORT_CONTACTS_FAILED
        outcome.added == 1 -> PeopleCopy.IMPORT_CONTACTS_ONE
        else -> PeopleCopy.IMPORT_CONTACTS_DONE.replace("{count}", outcome.added.toString())
    }

    private fun channel(partyId: String, kind: String, value: String): String =
        "{\"party_id\":${quote(partyId)},\"kind\":${quote(kind)},\"value\":${quote(value.take(VALUE_MAX))}}"

    private suspend fun write(core: CentraidCore, command: String, input: String): Boolean =
        PhoneImport.write(core, command, input)

    private fun quote(value: String): String = PhoneImport.quote(value)

    private val MONTH_DAY = Regex("^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$")

    /** `people.save_contact_channel`'s `value` ceiling. */
    private const val VALUE_MAX: Int = 500
}

/**
 * WHAT SWIFTUI HOLDS FOR THE IMPORT: the shell reads the address book and
 * hands the contacts here; Android calls [ContactsImport] from its own scope.
 * Writes go to the member's foreground vault.
 */
public class ContactsImportBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: HomeSession? = null

    public fun attach(session: HomeSession) {
        this.session = session
    }

    /** Import [contacts]; [onDone] is handed the sentence to show. */
    public fun run(contacts: List<PhoneContact>, onDone: (String) -> Unit) {
        val core = session?.shelf?.core() ?: return onDone(PeopleCopy.IMPORT_CONTACTS_NO_VAULT)
        scope.launch { onDone(ContactsImport.sentence(ContactsImport.run(core, contacts))) }
    }
}
