package dev.centraid.shared.apps.people

import dev.centraid.core.CentraidCore
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.shared.kit.PhoneImport
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.sync.phone.PhoneDevice
import dev.centraid.shared.sync.phone.PhoneFields
import dev.centraid.shared.sync.phone.PhoneIds
import dev.centraid.shared.sync.phone.PhoneOriginRef
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

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
 * @property phoneId the phone's most durable id for the contact, with its kind as a prefix
 *   (`lookup:` Android's `LOOKUP_KEY`, `local:` a device-scoped id): R-1127-10. A contact with
 *   none is skipped, because nothing could find it again.
 * @property origin the account or container the contact was read in (its id, kind-prefixed), or
 *   empty for "this phone" (R-1127-9).
 * @property originLabel what the member calls that account ("Google: ada@example.com"); empty
 *   shows the id.
 */
public data class PhoneContact(
    public val name: String,
    public val phones: List<String> = emptyList(),
    public val emails: List<String> = emptyList(),
    public val birthday: String = "",
    public val phoneId: String = "",
    public val origin: String = "",
    public val originLabel: String = "",
)

/** ONE CONTACT, as the vault's `follow.contacts` is told of it. */
internal data class ContactRecord(
    val phoneId: String,
    val origin: String,
    val name: String,
    val phones: List<String>,
    val emails: List<String>,
    val birthday: String,
)

/**
 * WHAT ONE READ OF THE ADDRESS BOOK SENDS: the contacts, one record each, in the accounts they
 * were read in, and every account present (even one with no contact in it).
 *
 * @property complete false for a read that may have missed contacts (iOS limited access, a read
 *   that failed part-way): the vault then trashes nothing.
 */
internal data class ContactsBatch(
    val complete: Boolean,
    val origins: List<PhoneOriginRef>,
    val records: List<ContactRecord>,
)

/**
 * CONTACTS → PEOPLE, FOLLOWED (docs/decisions.md, "Onboarding without sample data"; #1127;
 * #1135).
 *
 * Onboarding's goal is time to the member's own data, and the phone already holds the people they
 * keep up with. The shell reads the address book once the OS has said yes and hands the contacts
 * here; [run] sends each account's records to the vault in ONE command, `follow.contacts`, and
 * **the vault does the merge**: a field the member never changed follows the phone, one they
 * changed stands, a contact the vault does not know is matched by name to a person of the
 * member's own before one is added, and one gone from a complete read goes to the trash if the
 * member never edited it. The phone sends records; it keeps no fingerprint and no link, and
 * writes nothing else.
 *
 * A refused account is counted and the rest go on: one malformed address must not cost the member
 * the other hundred people.
 */
public object ContactsImport {
    /** What one pass did. [addAccount] is the R-1127-8 condition: the phone returned no contacts at all. */
    public data class Outcome(
        public val added: Int,
        public val refused: Int,
        public val updated: Int = 0,
        public val trashed: Int = 0,
        public val addAccount: Boolean = false,
    )

    /** The origin of a contact that names none: this phone's own address book. */
    public const val DEFAULT_ORIGIN: String = "local:this-phone"

    /**
     * A READ OF THE ADDRESS BOOK AS A BATCH. Named, trimmed and one per phone id; a contact with no
     * name or no id is not a record.
     */
    internal fun batch(
        contacts: List<PhoneContact>,
        origins: List<PhoneOriginRef> = emptyList(),
        complete: Boolean = true,
    ): ContactsBatch {
        val seen = mutableSetOf<String>()
        val records = oneEach(contacts).mapNotNull { contact ->
            val name = PhoneFields.squash(contact.name)
            if (name.isEmpty() || !PhoneIds.isValid(contact.phoneId) || !seen.add(contact.phoneId)) return@mapNotNull null
            ContactRecord(
                phoneId = contact.phoneId,
                origin = contact.origin.ifEmpty { DEFAULT_ORIGIN },
                name = name,
                phones = contact.phones.map(String::trim).filter(String::isNotEmpty).distinct(),
                emails = contact.emails.map(String::trim).filter(String::isNotEmpty).distinctBy(String::lowercase),
                birthday = contact.birthday.takeIf { MONTH_DAY.matches(it) }.orEmpty(),
            )
        }
        val labels = contacts.filter { it.originLabel.isNotEmpty() }.associate { it.origin.ifEmpty { DEFAULT_ORIGIN } to it.originLabel }
        val present = (origins + records.map { PhoneOriginRef(it.origin, "") }).distinctBy { it.id }
            .map { ref ->
                val label = ref.label.ifEmpty { labels[ref.id] ?: if (ref.id == DEFAULT_ORIGIN) PeopleCopy.IMPORT_ORIGIN_THIS_PHONE else ref.id }
                PhoneOriginRef(ref.id, label)
            }
        return ContactsBatch(complete, present, records)
    }

    /**
     * ONE CONTACT, ONE ORIGIN. A shell that reads per container (iOS reads each `CNContainer`)
     * meets a unified contact once for every container it is in; it is one person, so one record,
     * and the origin it is kept under must not depend on the order the containers were read in,
     * or a person would hop between accounts from one pass to the next. **The lowest origin id
     * wins** (compared as text), and a contact that names none counts as [DEFAULT_ORIGIN].
     */
    internal fun oneEach(contacts: List<PhoneContact>): List<PhoneContact> {
        val chosen = linkedMapOf<String, PhoneContact>()
        for (contact in contacts) {
            val held = chosen[contact.phoneId]
            if (held == null || contact.origin.ifEmpty { DEFAULT_ORIGIN } < held.origin.ifEmpty { DEFAULT_ORIGIN }) {
                chosen[contact.phoneId] = contact
            }
        }
        // A phone id that is no id keeps every row (the batch skips them), so nothing is merged by accident.
        return contacts.filter { !PhoneIds.isValid(it.phoneId) } + chosen.values
    }

    /**
     * A CONTAINER AS THE MEMBER KNOWS IT. The origin is `container:<id>` (R-1127-10); its label is
     * the name the OS shows ("iCloud", "Gmail"), and a container with no name is the phone's own
     * ("This phone's contacts").
     */
    public fun container(id: String, name: String): PhoneOriginRef =
        PhoneOriginRef("container:$id", PhoneFields.squash(name).ifEmpty { PeopleCopy.IMPORT_ORIGIN_THIS_PHONE })

    /** The `follow.contacts` input for one account: its records, and whether the read was complete. */
    internal fun input(origin: PhoneOriginRef, records: List<ContactRecord>, complete: Boolean, device: String): String = buildString {
        append("{\"origin\":{\"ref\":").append(jsonString(origin.id))
        append(",\"label\":").append(jsonString(origin.label))
        append(",\"device_id\":").append(jsonString(device)).append("},\"records\":[")
        records.forEachIndexed { index, record ->
            if (index > 0) append(',')
            append("{\"external_id\":").append(jsonString(record.phoneId))
            // A phone id that means something on this phone only is kept under the phone (R-1127-10).
            append(",\"device_id\":").append(if (PhoneIds.isPortable(record.phoneId)) "null" else jsonString(device))
            append(",\"fields\":{\"title\":").append(jsonString(record.name))
            append(",\"birthday\":").append(if (record.birthday.isEmpty()) "null" else jsonString(record.birthday))
            append(",\"points\":[")
            val points = record.phones.map { "phone" to it } + record.emails.map { "email" to it }
            points.forEachIndexed { at, (kind, value) ->
                if (at > 0) append(',')
                append("{\"kind\":").append(jsonString(kind)).append(",\"value\":").append(jsonString(value.take(VALUE_MAX))).append('}')
            }
            append("]}}")
        }
        append("],\"complete\":").append(complete).append('}')
    }

    /**
     * WRITE [contacts] INTO THE VAULT [core] HOLDS: one `follow.contacts` per account. [complete] is
     * false when the read may be partial; [origins] lists every account present, so one with no
     * contact is still told (its people that left are then trashed). [device] is this install's
     * [PhoneDevice] unless a caller names another.
     */
    public suspend fun run(
        core: CentraidCore,
        contacts: List<PhoneContact>,
        origins: List<PhoneOriginRef> = emptyList(),
        complete: Boolean = true,
        device: String? = null,
    ): Outcome {
        val batch = batch(contacts, origins, complete)
        val phone = device ?: PhoneDevice.id()
        var outcome = Outcome(added = 0, refused = 0, addAccount = complete && batch.records.isEmpty() && batch.origins.isEmpty())
        for (origin in batch.origins) {
            val records = batch.records.filter { it.origin == origin.id }
            val told = PhoneImport.executed(core, "follow.contacts", input(origin, records, batch.complete, phone))
            outcome = if (told == null) {
                outcome.copy(refused = outcome.refused + records.size)
            } else {
                outcome.copy(
                    added = outcome.added + count(told, "added") + count(told, "matched"),
                    updated = outcome.updated + count(told, "updated"),
                    trashed = outcome.trashed + count(told, "trashed"),
                )
            }
        }
        return outcome
    }

    /** A count of the command's output: `"added":3`. */
    private fun count(output: String, name: String): Int =
        Regex("\"$name\"\\s*:\\s*(\\d+)").find(output)?.groupValues?.get(1)?.toIntOrNull() ?: 0

    /** The one sentence the shell shows when an import ends. */
    public fun sentence(outcome: Outcome): String = when {
        outcome.addAccount -> PeopleCopy.IMPORT_CONTACTS_ADD_ACCOUNT
        outcome.added == 0 && outcome.refused == 0 -> PeopleCopy.IMPORT_CONTACTS_NONE
        outcome.added == 0 -> PeopleCopy.IMPORT_CONTACTS_FAILED
        outcome.added == 1 -> PeopleCopy.IMPORT_CONTACTS_ONE
        else -> PeopleCopy.IMPORT_CONTACTS_DONE.replace("{count}", outcome.added.toString())
    }

    private val MONTH_DAY = Regex("^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$")

    /** `person.save_contact_point`'s `value` ceiling. */
    internal const val VALUE_MAX: Int = 500
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

    /**
     * One pass of the phone sync: [contacts] with every [origins] present, and whether the read
     * was [complete]. [onDone] is handed the typed outcome, so the shell can show the
     * add-your-account line (`addAccount`).
     */
    public fun sync(
        contacts: List<PhoneContact>,
        origins: List<PhoneOriginRef>,
        complete: Boolean,
        onDone: (ContactsImport.Outcome) -> Unit,
    ) {
        val core = session?.shelf?.core() ?: return onDone(ContactsImport.Outcome(added = 0, refused = 0))
        scope.launch { onDone(ContactsImport.run(core, contacts, origins, complete)) }
    }
}
