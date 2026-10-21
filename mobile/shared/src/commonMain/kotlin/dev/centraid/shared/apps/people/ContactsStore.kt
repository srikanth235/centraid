package dev.centraid.shared.apps.people

import centraid.core.v1.Value
import dev.centraid.core.CentraidCore
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.shared.sync.phone.CorePhoneStore
import dev.centraid.shared.sync.phone.PhoneFields
import dev.centraid.shared.sync.phone.PhoneRecord
import dev.centraid.shared.sync.phone.PhoneSource
import dev.centraid.shared.sync.phone.VaultRow
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/**
 * WHAT A CONTACT'S WRITER NEEDS BESIDE THE FINGERPRINT'S FIELDS: the contact as the address book
 * spells it (the vault keeps a number as typed). The birthday is a phone-owned field, and
 * is followed: written on add, moved or removed on update.
 */
internal data class ContactAttributes(
    val name: String,
    val phones: List<String>,
    val emails: List<String>,
    val birthday: String,
)

/**
 * PEOPLE'S SIDE OF A CONTACTS PASS: the rows a person is made of, read through the page door, and
 * the three writes the engine asks, through the same commands a screen uses. A person followed
 * from the phone is an ordinary person (R-ONBOARD-4); only the link says where it came from.
 */
internal class ContactsStore(
    core: CentraidCore,
    device: String,
    private val mintId: () -> String = ::newId,
) : CorePhoneStore(core, PhoneSource.CONTACTS, device) {
    override suspend fun rows(): Map<String, VaultRow>? = read(partyId = null)

    override suspend fun row(entityId: String): VaultRow? = read(entityId)?.get(entityId)

    /** The people with a profile (a person People lists), their phone and email channels, and their trash state. */
    private suspend fun read(partyId: String?): Map<String, VaultRow>? {
        val only = partyId?.let { Value(text = it) }
        val filter = if (only == null) null else "party_id = ?"
        val binds = listOfNotNull(only)
        val profiles = pageAll("phone.people.profiles", listOf("profile_id", "party_id", "deleted_at"), "people_profile", "profile_id", filter, binds)
            ?: return null
        val names = pageAll("phone.people.names", listOf("party_id", "display_name"), "core_party", "party_id", filter, binds)
            ?: return null
        val channels = pageAll(
            "phone.people.channels",
            listOf("channel_id", "party_id", "kind", "value"),
            "social_contact_channel",
            "channel_id",
            listOfNotNull(filter, "kind IN ('phone', 'email')").joinToString(" AND "),
            binds,
        ) ?: return null
        val dates = pageAll(
            "phone.people.birthdays",
            listOf("date_id", "party_id", "month_day"),
            "people_important_date",
            "date_id",
            listOfNotNull(filter, "lower(label) LIKE '%birthday%' AND deleted_at IS NULL").joinToString(" AND "),
            binds,
        ) ?: return null
        val birthdayOf = dates.groupBy({ it.text(1) }, { it.text(2) }).mapValues { it.value.first() }
        val nameOf = names.associate { it.text(0) to it.text(1) }
        val phones = channels.filter { it.text(2) == "phone" }.groupBy({ it.text(1) }, { it.text(3) })
        val emails = channels.filter { it.text(2) == "email" }.groupBy({ it.text(1) }, { it.text(3) })
        return profiles.associate { profile ->
            val id = profile.text(1)
            val name = nameOf[id].orEmpty()
            val row = VaultRow(
                entityId = id,
                fields = ContactsImport.fields(name, phones[id].orEmpty(), emails[id].orEmpty(), birthdayOf[id].orEmpty()),
                trashed = profile.text(2).isNotEmpty(),
                matchKey = ContactsImport.matchKey(name),
                tiebreak = ContactsImport.tiebreak(phones[id].orEmpty(), emails[id].orEmpty()),
            )
            id to row
        }
    }

    override suspend fun add(record: PhoneRecord): String? {
        val person = record.attributes as? ContactAttributes ?: return null
        val partyId = mintId()
        val made = command(
            "people.add_person",
            "{\"party_id\":${q(partyId)},\"display_name\":${q(person.name)},\"cadence_days\":0}",
        ) != null
        if (!made) return null
        person.phones.forEach { saveChannel(partyId, "phone", it) }
        person.emails.forEach { saveChannel(partyId, "email", it) }
        if (person.birthday.isNotEmpty()) {
            command(
                "people.add_important_date",
                "{\"party_id\":${q(partyId)},\"label\":${q(PeopleCopy.IMPORT_BIRTHDAY)},\"month_day\":${q(person.birthday)}}",
            )
        }
        return partyId
    }

    /**
     * THE NAME, THE CHANNELS AND THE BIRTHDAY THE PHONE NOW HOLDS. A channel the phone no longer
     * lists is deleted; one it adds is saved; the rest are left alone. A birthday that moved is
     * edited, one that went is deleted, one that arrived is added.
     */
    override suspend fun update(entityId: String, record: PhoneRecord): Boolean {
        val person = record.attributes as? ContactAttributes ?: return false
        val named = command("people.edit_person", "{\"party_id\":${q(entityId)},\"display_name\":${q(person.name)}}") != null
        val current = pageAll(
            "phone.people.current",
            listOf("channel_id", "kind", "value"),
            "social_contact_channel",
            "channel_id",
            "party_id = ? AND kind IN ('phone', 'email')",
            listOf(Value(text = entityId)),
        ) ?: return false
        val wanted = person.phones.map { "phone" to PhoneFields.phoneNumber(it) } +
            person.emails.map { "email" to PhoneFields.squash(it).lowercase() }
        val present = mutableSetOf<Pair<String, String>>()
        var clean = named
        for (channel in current) {
            val key = channel.text(1) to normalize(channel.text(1), channel.text(2))
            if (key in wanted) {
                present += key
            } else if (command("people.delete_contact_channel", "{\"channel_id\":${q(channel.text(0))}}") == null) {
                clean = false
            }
        }
        for (phone in person.phones.filter { ("phone" to PhoneFields.phoneNumber(it)) !in present }) {
            clean = saveChannel(entityId, "phone", phone) && clean
        }
        for (email in person.emails.filter { ("email" to PhoneFields.squash(it).lowercase()) !in present }) {
            clean = saveChannel(entityId, "email", email) && clean
        }
        return followBirthday(entityId, person.birthday) && clean
    }

    /** The person's birthday made `birthday` (`MM-DD`, or empty for none). */
    private suspend fun followBirthday(partyId: String, birthday: String): Boolean {
        val dates = pageAll(
            "phone.people.birthday",
            listOf("date_id", "month_day"),
            "people_important_date",
            "date_id",
            "party_id = ? AND lower(label) LIKE '%birthday%' AND deleted_at IS NULL",
            listOf(Value(text = partyId)),
        ) ?: return false
        if (birthday.isEmpty()) {
            return dates.all { command("people.delete_important_date", "{\"date_id\":${q(it.text(0))}}") != null }
        }
        val first = dates.firstOrNull()
            ?: return command(
                "people.add_important_date",
                "{\"party_id\":${q(partyId)},\"label\":${q(PeopleCopy.IMPORT_BIRTHDAY)},\"month_day\":${q(birthday)}}",
            ) != null
        // The command keeps every other birthday row of the party in step with the one it edits.
        if (dates.all { it.text(1) == birthday }) return true
        return command("people.edit_important_date", "{\"date_id\":${q(first.text(0))},\"month_day\":${q(birthday)}}") != null
    }

    override suspend fun trash(entityId: String): Boolean =
        command("people.trash_person", "{\"party_id\":${q(entityId)}}") != null

    private suspend fun saveChannel(partyId: String, kind: String, value: String): Boolean = command(
        "people.save_contact_channel",
        "{\"party_id\":${q(partyId)},\"kind\":${q(kind)},\"value\":${q(value.take(ContactsImport.VALUE_MAX))}}",
    ) != null

    private fun normalize(kind: String, value: String): String =
        if (kind == "phone") PhoneFields.phoneNumber(value) else PhoneFields.squash(value).lowercase()

    private companion object {
        @OptIn(ExperimentalUuidApi::class)
        fun newId(): String = Uuid.random().toString()
    }
}
