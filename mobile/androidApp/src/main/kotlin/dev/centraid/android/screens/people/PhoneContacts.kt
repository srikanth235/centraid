package dev.centraid.android.screens.people

import android.Manifest
import android.accounts.AccountManager
import android.content.ContentResolver
import android.content.Context
import android.content.pm.PackageManager
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import centraid.core.v1.ContactsSnapshot
import centraid.core.v1.PhoneContact
import centraid.core.v1.PhoneContactContainer
import dev.centraid.android.kit.PhoneOrigins

/**
 * THE PHONE'S ADDRESS BOOK, READ FOR THE SCREEN RUNTIME (#1135; docs/decisions.md,
 * "Onboarding without sample data"): the platform half of Contacts → People.
 *
 * Rust asks with a `ContactsRead` effect (`kit/ScreenEffects.kt` performs it and has
 * already settled the permission, which is asked only at the member's Import tap, never
 * by a following pass); this answers with a [ContactsSnapshot]. What to import, how a
 * contact squashes into a person, what each account is called and what the member is told
 * are Rust's (`crates/screens/src/people/contacts.rs`); nothing is decided here.
 */
internal fun readContactsSnapshot(context: Context, deviceId: String): ContactsSnapshot {
    val read = if (!granted(context)) {
        AddressBookRead(emptyList(), emptyList(), complete = false)
    } else {
        // A query that throws is a read that may have missed contacts: `complete` false, so nothing is trashed.
        runCatching { readContacts(context.contentResolver, accountTypeLabels(context)) }
            .getOrElse { AddressBookRead(emptyList(), emptyList(), complete = false) }
    }
    return ContactsSnapshot(
        complete = read.complete,
        device_id = deviceId,
        containers = read.containers,
        contacts = read.contacts,
    )
}

internal fun granted(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED

/** What the address book held at one read: the contacts, and every account present. */
private class AddressBookRead(
    val contacts: List<PhoneContact>,
    val containers: List<PhoneContactContainer>,
    /** False when the read may have missed contacts (no permission, a query that failed): nothing is then trashed (R-1127-3). */
    val complete: Boolean,
)

/**
 * THE ADDRESS BOOK, ONE [PhoneContact] PER CONTACT: one pass over the `Data`
 * table for the four kinds that matter — the name row (so a contact with no
 * number still arrives), phone numbers, email addresses and the birthday
 * event — grouped by contact in display-name order.
 *
 * **EACH CONTACT IS KEYED BY ITS `LOOKUP_KEY`** (R-1127-10) and belongs to the account of its raw
 * contact with the lowest `_ID`, so a contact joined from two accounts stays in one container.
 * Every account that holds a raw contact, or has a sync setting (`Settings`), is a container, an
 * empty one included; a raw contact with no account is this phone's own (an empty key and name).
 */
private fun readContacts(resolver: ContentResolver, typeLabels: Map<String, String>): AddressBookRead {
    // RAW CONTACTS FIRST: which account each contact is in. A throw here is the caller's incomplete read.
    val accounts = linkedMapOf<String, String>()
    val accountOfContact = HashMap<Long, String>()
    resolver.query(
        ContactsContract.RawContacts.CONTENT_URI,
        arrayOf(
            ContactsContract.RawContacts.CONTACT_ID,
            ContactsContract.RawContacts.ACCOUNT_TYPE,
            ContactsContract.RawContacts.ACCOUNT_NAME,
        ),
        "${ContactsContract.RawContacts.DELETED} = 0",
        null,
        "${ContactsContract.RawContacts._ID} ASC",
    )?.use { cursor ->
        while (cursor.moveToNext()) {
            val key = PhoneOrigins.accountKey(cursor.getString(1), cursor.getString(2))
            accounts.getOrPut(key) { accountLabel(typeLabels, cursor.getString(1), cursor.getString(2)) }
            if (!cursor.isNull(0)) accountOfContact.getOrPut(cursor.getLong(0)) { key }
        }
    }
    // AN ACCOUNT WITH NO CONTACT STILL SYNCS CONTACTS: its Settings row says so. A failure here
    // costs only the empty accounts, which no link can point at.
    runCatching {
        resolver.query(
            ContactsContract.Settings.CONTENT_URI,
            arrayOf(ContactsContract.Settings.ACCOUNT_TYPE, ContactsContract.Settings.ACCOUNT_NAME),
            null,
            null,
            null,
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                if (cursor.isNull(0) && cursor.isNull(1)) continue
                val key = PhoneOrigins.accountKey(cursor.getString(0), cursor.getString(1))
                accounts.getOrPut(key) { accountLabel(typeLabels, cursor.getString(0), cursor.getString(1)) }
            }
        }
    }
    val kinds = arrayOf(
        ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE,
        ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE,
        ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE,
        ContactsContract.CommonDataKinds.Event.CONTENT_ITEM_TYPE,
    )
    val projection = arrayOf(
        ContactsContract.Data.CONTACT_ID,
        ContactsContract.Data.DISPLAY_NAME,
        ContactsContract.Data.MIMETYPE,
        ContactsContract.Data.DATA1,
        ContactsContract.Data.DATA2,
        ContactsContract.Data.LOOKUP_KEY,
    )
    val selection = "${ContactsContract.Data.MIMETYPE} IN (${kinds.joinToString(",") { "?" }})"
    val gathered = LinkedHashMap<Long, Gathered>()
    resolver.query(
        ContactsContract.Data.CONTENT_URI,
        projection,
        selection,
        kinds,
        "${ContactsContract.Data.DISPLAY_NAME} COLLATE NOCASE ASC",
    )?.use { cursor ->
        while (cursor.moveToNext()) {
            val id = cursor.getLong(0)
            // A CONTACT WHOSE RAW CONTACTS ARE ALL DELETED is not on the phone any more.
            val container = accountOfContact[id] ?: continue
            val entry = gathered.getOrPut(id) { Gathered(cursor.getString(1).orEmpty(), container, cursor.getString(5)) }
            val value = cursor.getString(3).orEmpty()
            when (cursor.getString(2)) {
                ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE -> entry.phones += value
                ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE -> entry.emails += value
                ContactsContract.CommonDataKinds.Event.CONTENT_ITEM_TYPE ->
                    if (!cursor.isNull(4) &&
                        cursor.getInt(4) == ContactsContract.CommonDataKinds.Event.TYPE_BIRTHDAY &&
                        entry.birthday.isEmpty()
                    ) {
                        entry.birthday = monthDay(value)
                    }
                else -> Unit
            }
        }
    }
    val contacts = gathered.map { (id, entry) ->
        PhoneContact(
            name = entry.name,
            phones = entry.phones,
            emails = entry.emails,
            birthday = entry.birthday,
            phone_id = PhoneOrigins.contactId(entry.lookupKey, id),
            container_key = entry.container,
        )
    }
    val containers = accounts.map { (key, label) -> PhoneContactContainer(key = key, name = label) }
    return AddressBookRead(contacts, containers, complete = true)
}

/** "Google: ada@example.com"; empty for a raw contact with no account, which is this phone's own. */
private fun accountLabel(typeLabels: Map<String, String>, type: String?, name: String?): String =
    if (type.isNullOrEmpty() && name.isNullOrEmpty()) {
        ""
    } else {
        PhoneOrigins.accountLabel((type?.let { typeLabels[it] }).orEmpty().ifEmpty { type.orEmpty() }, name)
    }

/**
 * THE SYSTEM'S NAME FOR EACH ACCOUNT TYPE ("Google" for `com.google`), from the authenticators
 * installed: the label Settings shows. Needs no permission; a type it cannot name stays as the
 * type's own string.
 */
private fun accountTypeLabels(context: Context): Map<String, String> = runCatching {
    val packages = context.packageManager
    AccountManager.get(context).authenticatorTypes.mapNotNull { description ->
        val label = packages.getText(description.packageName, description.labelId, null)?.toString().orEmpty()
        if (label.isEmpty()) null else description.type to label
    }.toMap()
}.getOrDefault(emptyMap())

private class Gathered(val name: String, val container: String, val lookupKey: String?) {
    val phones = mutableListOf<String>()
    val emails = mutableListOf<String>()
    var birthday = ""
}

/**
 * A BIRTHDAY AS PEOPLE KEEPS IT: `MM-DD`. The address book writes
 * `YYYY-MM-DD` when the year is known and `--MM-DD` when it is not; anything
 * else is dropped rather than guessed at.
 */
internal fun monthDay(raw: String): String =
    BIRTHDAY.find(raw.trim())?.let { "${it.groupValues[1]}-${it.groupValues[2]}" }.orEmpty()

private val BIRTHDAY = Regex("^(?:\\d{4}-|--)(\\d{2})-(\\d{2})")
