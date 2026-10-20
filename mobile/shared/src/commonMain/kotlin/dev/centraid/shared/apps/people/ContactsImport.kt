package dev.centraid.shared.apps.people

import dev.centraid.core.CentraidCore
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.shared.sync.phone.GoneChoice
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneFields
import dev.centraid.shared.sync.phone.PhoneIds
import dev.centraid.shared.sync.phone.PhoneOriginRef
import dev.centraid.shared.sync.phone.PhoneRecord
import dev.centraid.shared.sync.phone.PhoneReport
import dev.centraid.shared.sync.phone.PhoneSnapshot
import dev.centraid.shared.sync.phone.PhoneSource
import dev.centraid.shared.sync.phone.PhoneStore
import dev.centraid.shared.sync.phone.PhoneSync
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlin.time.Clock
import dev.centraid.shared.sync.rfc3339FromEpochMillis

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

/**
 * CONTACTS → PEOPLE, THE FIRST PASS OF `PhoneSync` (docs/decisions.md, "Onboarding without sample
 * data"; #1127).
 *
 * Onboarding's goal is time to the member's own data, and the phone already holds the people they
 * keep up with. The shell reads the address book once the OS has said yes and hands the contacts
 * here; [sync] diffs them against what People holds through [PhoneSync] and writes each as the
 * member's own row (`people.add_person`, `people.save_contact_channel`, a birthday). A contact is
 * linked to the phone record it came from, so a later pass follows it: a changed number is
 * written, a person the member edited stops following (R-1127-2), a contact gone from the phone
 * goes to the trash (R-1127-3), and an account that left the phone is asked about (R-1127-9).
 *
 * A person that already exists with the contact's name is adopted rather than duplicated. A
 * refused contact is counted and the rest go on: one malformed address must not cost the member
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
        public val gone: List<OriginGone> = emptyList(),
    )

    /** The origin of a contact that names none: this phone's own address book. */
    public const val DEFAULT_ORIGIN: String = "local:this-phone"

    /** THE FIELDS A PHONE OWNS OF A PERSON: a name and its numbers and addresses. */
    internal fun fields(name: String, phones: List<String>, emails: List<String>): PhoneFields = PhoneFields.of {
        text("name", name)
        phones("phones", phones.map { it.take(VALUE_MAX) })
        emails("emails", emails.map { it.take(VALUE_MAX) })
    }

    internal fun matchKey(name: String): String = PhoneFields.squash(name).lowercase()

    internal fun tiebreak(phones: List<String>, emails: List<String>): Set<String> =
        phones.map(PhoneFields::phoneNumber).toSet() + emails.map { PhoneFields.squash(it).lowercase() }

    /**
     * A READ OF THE ADDRESS BOOK AS A SNAPSHOT. Named, trimmed and one per phone id; a contact
     * with no name or no id is not a record.
     *
     * @param origins every account or container present, even one with no contact in it.
     * @param complete false for a read that may have missed contacts (iOS limited access, a read
     *   that failed part-way): nothing is then trashed.
     */
    public fun snapshot(
        contacts: List<PhoneContact>,
        origins: List<PhoneOriginRef> = emptyList(),
        complete: Boolean = true,
        readAt: String,
    ): PhoneSnapshot {
        val seen = mutableSetOf<String>()
        val records = contacts.mapNotNull { contact ->
            val name = PhoneFields.squash(contact.name)
            if (name.isEmpty() || !PhoneIds.isValid(contact.phoneId) || !seen.add(contact.phoneId)) return@mapNotNull null
            val phones = contact.phones.map(String::trim).filter(String::isNotEmpty).distinct()
            val emails = contact.emails.map(String::trim).filter(String::isNotEmpty).distinctBy(String::lowercase)
            PhoneRecord(
                phoneId = contact.phoneId,
                origin = contact.origin.ifEmpty { DEFAULT_ORIGIN },
                fields = fields(name, phones, emails),
                matchKey = matchKey(name),
                tiebreak = tiebreak(phones, emails),
                attributes = ContactAttributes(name, phones, emails, contact.birthday.takeIf { MONTH_DAY.matches(it) }.orEmpty()),
            )
        }
        val labels = contacts.filter { it.originLabel.isNotEmpty() }.associate { it.origin.ifEmpty { DEFAULT_ORIGIN } to it.originLabel }
        val present = (origins + records.map { PhoneOriginRef(it.origin, "") }).distinctBy { it.id }
            .map { ref ->
                val label = ref.label.ifEmpty { labels[ref.id] ?: if (ref.id == DEFAULT_ORIGIN) PeopleCopy.IMPORT_ORIGIN_THIS_PHONE else ref.id }
                PhoneOriginRef(ref.id, label)
            }
        return PhoneSnapshot(PhoneSource.CONTACTS, complete, readAt, present, records)
    }

    /** ONE PASS over [store] with [snapshot]; the outcome the shell shows. */
    internal suspend fun sync(store: PhoneStore, snapshot: PhoneSnapshot): Outcome {
        val report = PhoneSync.run(store, snapshot)
        return outcome(report, snapshot)
    }

    /**
     * WRITE [contacts] INTO THE VAULT [core] HOLDS, as one pass of the phone sync (the one-tap
     * import). [complete] is false when the read may be partial; [origins] lists every account
     * present, so one with no contact is not mistaken for gone.
     */
    public suspend fun run(
        core: CentraidCore,
        contacts: List<PhoneContact>,
        origins: List<PhoneOriginRef> = emptyList(),
        complete: Boolean = true,
    ): Outcome = sync(ContactsStore(core), snapshot(contacts, origins, complete, readAt()))

    /** The member's answer to a held account (R-1127-9): [GoneChoice.KEEP] is the default. */
    public suspend fun resolveGone(core: CentraidCore, originId: String, choice: GoneChoice): Outcome {
        val report = PhoneSync.resolveGone(ContactsStore(core), originId, choice)
        return Outcome(added = 0, refused = report.refused.size, trashed = report.trashed)
    }

    private fun outcome(report: PhoneReport, snapshot: PhoneSnapshot): Outcome = Outcome(
        added = report.added,
        refused = report.refused.size,
        updated = report.updated,
        trashed = report.trashed,
        addAccount = snapshot.complete && snapshot.records.isEmpty() && snapshot.origins.isEmpty(),
        gone = report.gone,
    )

    /** The one sentence the shell shows when an import ends. */
    public fun sentence(outcome: Outcome): String = when {
        outcome.addAccount -> PeopleCopy.IMPORT_CONTACTS_ADD_ACCOUNT
        outcome.added == 0 && outcome.refused == 0 -> PeopleCopy.IMPORT_CONTACTS_NONE
        outcome.added == 0 -> PeopleCopy.IMPORT_CONTACTS_FAILED
        outcome.added == 1 -> PeopleCopy.IMPORT_CONTACTS_ONE
        else -> PeopleCopy.IMPORT_CONTACTS_DONE.replace("{count}", outcome.added.toString())
    }

    internal fun readAt(): String = rfc3339FromEpochMillis(Clock.System.now().toEpochMilliseconds())

    private val MONTH_DAY = Regex("^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$")

    /** `people.save_contact_channel`'s `value` ceiling. */
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
     * add-your-account line (`addAccount`) and ask about an account that left (`gone`).
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

    /** The member's answer to an account that left the phone. */
    public fun resolveGone(originId: String, keep: Boolean, onDone: (ContactsImport.Outcome) -> Unit) {
        val core = session?.shelf?.core() ?: return onDone(ContactsImport.Outcome(added = 0, refused = 0))
        scope.launch {
            onDone(ContactsImport.resolveGone(core, originId, if (keep) GoneChoice.KEEP else GoneChoice.TRASH))
        }
    }
}
