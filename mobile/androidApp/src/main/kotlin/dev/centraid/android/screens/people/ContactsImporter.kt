package dev.centraid.android.screens.people

import android.Manifest
import android.accounts.AccountManager
import android.content.ContentResolver
import android.content.Context
import android.content.pm.PackageManager
import android.provider.ContactsContract
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import dev.centraid.android.kit.PhoneOrigins
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.shared.apps.people.ContactsImport
import dev.centraid.shared.apps.people.PhoneContact
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.sync.phone.PhoneOriginRef
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * CONTACTS → PEOPLE, ANDROID'S HALF (docs/decisions.md, "Onboarding without
 * sample data"): the permission, the address book, and the hand-off to
 * [ContactsImport], which writes the rows.
 *
 * **THE PERMISSION IS ASKED AT THE TAP**, never at launch: People's day-one
 * empty state draws "Import contacts" (`EmptyState.import_source`), and the
 * system's dialog is the answer to that tap. A grant reads the address book; a
 * refusal — including the one the system returns at once after "don't ask
 * again" — is [PeopleCopy.IMPORT_CONTACTS_DENIED], which names Settings.
 *
 * **INTO THE MEMBER'S FOREGROUND VAULT** (`Shelf.core`). The People screen
 * re-reads by itself — every row lands through the change stream.
 *
 * [onStatus] is handed each sentence: [PeopleCopy.IMPORT_CONTACTS_RUNNING]
 * while it runs (`holds` true: it stays until the outcome replaces it), then
 * the outcome's one sentence. [onImported] is called on the main thread once an
 * import has written, so the follower takes the next pass (and asks about an account
 * that left the phone: R-1127-9).
 */
@Composable
public fun rememberContactsImport(
    session: HomeSession?,
    onStatus: (sentence: String, holds: Boolean) -> Unit,
    onImported: () -> Unit = {},
): (after: ((String?) -> Unit)?) -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val currentSession by rememberUpdatedState(session)
    val currentStatus by rememberUpdatedState(onStatus)
    val currentImported by rememberUpdatedState(onImported)
    // ONE IMPORT AT A TIME: a second tap while the first writes would add every
    // contact twice, and the day-one roster has nothing to fold them into.
    var running by remember { mutableStateOf(false) }
    // A MADE VAULT'S CHAIN waits on this import (R-ONBOARD-8): its outcome
    // goes to [after] instead of the banner, and a refusal is null.
    var pending by remember { mutableStateOf<((String?) -> Unit)?>(null) }

    fun finish(after: ((String?) -> Unit)?, sentence: String) {
        if (after != null) after(sentence) else currentStatus(sentence, false)
    }

    fun run(after: ((String?) -> Unit)?) {
        if (running) {
            after?.invoke(null)
            return
        }
        val core = currentSession?.shelf?.core()
        if (core == null) {
            finish(after, PeopleCopy.IMPORT_CONTACTS_NO_VAULT)
            return
        }
        running = true
        currentStatus(PeopleCopy.IMPORT_CONTACTS_RUNNING, true)
        scope.launch {
            // OFF THE MAIN THREAD, both halves: the address book is a content
            // provider query and each row is a core call.
            val sentence = withContext(Dispatchers.IO) {
                val read = readPhoneContacts(context)
                val outcome = ContactsImport.run(core, read.contacts, read.origins, read.complete)
                // THE FOLLOWER TAKES IT FROM HERE: a pass asks about an origin this one found gone (R-1127-9).
                withContext(Dispatchers.Main) { currentImported() }
                ContactsImport.sentence(outcome)
            }
            running = false
            finish(after, sentence)
        }
    }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val after = pending
        pending = null
        when {
            granted -> run(after)
            after != null -> after(null)
            else -> currentStatus(PeopleCopy.IMPORT_CONTACTS_DENIED, false)
        }
    }
    return remember(launcher) {
        { after ->
            if (granted(context)) {
                run(after)
            } else {
                pending = after
                launcher.launch(Manifest.permission.READ_CONTACTS)
            }
        }
    }
}

private fun granted(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED

/** What the address book held at one read: the contacts, and every account present. */
internal class AddressBookRead(
    val contacts: List<PhoneContact>,
    val origins: List<PhoneOriginRef>,
    /** False when the read may have missed contacts (no permission, a query that failed): nothing is then trashed (R-1127-3). */
    val complete: Boolean,
)

/**
 * THE ADDRESS BOOK AS ONE PASS READS IT, or an incomplete empty read when the permission is not
 * granted or a provider query throws. **It never asks the OS for anything**: only the member's
 * Import tap does (R-ONBOARD-4).
 */
internal fun readPhoneContacts(context: Context): AddressBookRead =
    if (!granted(context)) {
        AddressBookRead(emptyList(), emptyList(), complete = false)
    } else {
        runCatching { readContacts(context.contentResolver, accountTypeLabels(context)) }
            .getOrElse { AddressBookRead(emptyList(), emptyList(), complete = false) }
    }

/**
 * THE ADDRESS BOOK, ONE [PhoneContact] PER CONTACT: one pass over the `Data`
 * table for the four kinds that matter — the name row (so a contact with no
 * number still arrives), phone numbers, email addresses and the birthday
 * event — grouped by contact in display-name order.
 *
 * **EACH CONTACT IS KEYED BY ITS `LOOKUP_KEY`** (R-1127-10) and belongs to the account of its raw
 * contact with the lowest `_ID`, so a contact joined from two accounts stays in one origin.
 * Every account that holds a raw contact, or has a sync setting (`Settings`), is an origin, an
 * empty one included.
 */
internal fun readContacts(resolver: ContentResolver, typeLabels: Map<String, String> = emptyMap()): AddressBookRead {
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
            val origin = PhoneOrigins.accountKey(cursor.getString(1), cursor.getString(2))
            accounts.getOrPut(origin) { accountLabel(typeLabels, cursor.getString(1), cursor.getString(2)) }
            if (!cursor.isNull(0)) accountOfContact.getOrPut(cursor.getLong(0)) { origin }
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
                val origin = PhoneOrigins.accountKey(cursor.getString(0), cursor.getString(1))
                accounts.getOrPut(origin) { accountLabel(typeLabels, cursor.getString(0), cursor.getString(1)) }
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
            val origin = accountOfContact[id] ?: continue
            val entry = gathered.getOrPut(id) { Gathered(cursor.getString(1).orEmpty(), origin, cursor.getString(5)) }
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
    // THE SHARED HELPER MAKES THE ORIGIN, so both platforms key and label one the same way.
    val refs = accounts.mapValues { (key, label) -> ContactsImport.container(key, label) }
    val contacts = gathered.map { (id, entry) ->
        PhoneContact(
            name = entry.name,
            phones = entry.phones,
            emails = entry.emails,
            birthday = entry.birthday,
            phoneId = PhoneOrigins.contactId(entry.lookupKey, id),
            origin = refs[entry.origin]?.id.orEmpty(),
            originLabel = refs[entry.origin]?.label.orEmpty(),
        )
    }
    return AddressBookRead(contacts, refs.values.toList(), complete = true)
}

/** "Google: ada@example.com", or this phone's own contacts for a raw contact with no account. */
private fun accountLabel(typeLabels: Map<String, String>, type: String?, name: String?): String =
    if (type.isNullOrEmpty() && name.isNullOrEmpty()) {
        PeopleCopy.IMPORT_ORIGIN_THIS_PHONE
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

private class Gathered(val name: String, val origin: String, val lookupKey: String?) {
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
