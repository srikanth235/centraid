package dev.centraid.android.screens.people

import android.Manifest
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
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.shared.apps.people.ContactsImport
import dev.centraid.shared.apps.people.PhoneContact
import dev.centraid.shared.shell.HomeSession
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
 * **INTO THE MEMBER'S VAULT, NEVER A PREVIEW'S**: `Shelf.memberCore`, and the
 * shell provides no importer while a preview is open at all. The People screen
 * re-reads by itself — every row lands through the change stream.
 *
 * [onStatus] is handed each sentence: [PeopleCopy.IMPORT_CONTACTS_RUNNING]
 * while it runs (`holds` true: it stays until the outcome replaces it), then
 * the outcome's one sentence.
 */
@Composable
public fun rememberContactsImport(
    session: HomeSession?,
    onStatus: (sentence: String, holds: Boolean) -> Unit,
): () -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val currentSession by rememberUpdatedState(session)
    val currentStatus by rememberUpdatedState(onStatus)
    // ONE IMPORT AT A TIME: a second tap while the first writes would add every
    // contact twice, and the day-one roster has nothing to fold them into.
    var running by remember { mutableStateOf(false) }

    fun run() {
        if (running) return
        val core = currentSession?.shelf?.memberCore()
        if (core == null) {
            currentStatus(PeopleCopy.IMPORT_CONTACTS_NO_VAULT, false)
            return
        }
        running = true
        currentStatus(PeopleCopy.IMPORT_CONTACTS_RUNNING, true)
        scope.launch {
            // OFF THE MAIN THREAD, both halves: the address book is a content
            // provider query and each row is a core call.
            val sentence = withContext(Dispatchers.IO) {
                val contacts = runCatching { readContacts(context.contentResolver) }.getOrDefault(emptyList())
                ContactsImport.sentence(ContactsImport.run(core, contacts))
            }
            running = false
            currentStatus(sentence, false)
        }
    }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) run() else currentStatus(PeopleCopy.IMPORT_CONTACTS_DENIED, false)
    }
    return remember(launcher) {
        {
            if (granted(context)) run() else launcher.launch(Manifest.permission.READ_CONTACTS)
        }
    }
}

private fun granted(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED

/**
 * THE ADDRESS BOOK, ONE [PhoneContact] PER CONTACT: one pass over the `Data`
 * table for the four kinds that matter — the name row (so a contact with no
 * number still arrives), phone numbers, email addresses and the birthday
 * event — grouped by contact in display-name order.
 */
internal fun readContacts(resolver: ContentResolver): List<PhoneContact> {
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
            val entry = gathered.getOrPut(id) { Gathered(cursor.getString(1).orEmpty()) }
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
    return gathered.values.map { PhoneContact(it.name, it.phones, it.emails, it.birthday) }
}

private class Gathered(val name: String) {
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
