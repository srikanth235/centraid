package dev.centraid.android.kit

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.CalendarContract
import android.provider.ContactsContract
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import dev.centraid.android.screens.docs.AndroidFolderReader
import dev.centraid.android.screens.people.readPhoneContacts
import dev.centraid.shared.apps.docs.FilesFollow
import dev.centraid.shared.apps.people.ContactsFollow
import dev.centraid.shared.apps.people.ContactsRead
import dev.centraid.shared.apps.people.ContactsReader
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.shell.PhoneFollowBridge
import dev.centraid.shared.shell.PhoneFollowQuestion
import dev.centraid.shared.sync.phone.PhoneSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * ANDROID FOLLOWS THE PHONE (#1127): THE TRIGGERS, THE READERS AND THE QUESTION.
 *
 * - **Triggers.** The activity's `onStart` (the app came to the front) and a [ContentObserver] on
 *   the address book and on the events, registered from `onStart` to `onStop`, each say
 *   [requested]. The bridge coalesces a burst, runs one pass per source at a time, and does
 *   nothing for a source the member never imported.
 * - **The calendar is Rust's (#1135).** Agenda's screen holds the calendar's follow
 *   (`crates/screens/src/agenda/calendar.rs`): it asks to watch the store with a `PhoneWatch`
 *   effect ([watchCalendar]) and reads it with `CalendarRead` (`ScreenEffects.kt`). Here the
 *   calendar is only the observer and the app coming forward, each reported to that watch.
 * - **Reads.** The [ContactsReader] below answers off the main thread, and
 *   **null when the permission is not already granted: a pass never asks the OS**, only the
 *   member's Import tap does (R-ONBOARD-4). Docs' folders are read by `AndroidFolderReader`, over
 *   the tree grants the member gave when they picked each folder; triggers for them are the app
 *   coming forward and the picker returning (`requested(PhoneSource.FILES)`), with no watcher.
 *   Health Connect is not followed here: Health's screen holds its follow
 *   (`crates/screens/src/health/follow.rs`) and reads the store with a `HealthRead` effect
 *   (`HealthConnectReader.kt`) (#1135).
 * - **The question.** [question] holds the one the bridge is waiting on; [PhoneFollowSheet]
 *   draws it and [answer] sends the member's choice back.
 *
 * Held by the activity and built on the application context, so it keeps no activity alive.
 */
internal class AndroidPhoneFollow(context: Context) {
    private val context: Context = context.applicationContext
    private val bridge = PhoneFollowBridge()
    private val io = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val main = Handler(Looper.getMainLooper())
    private val contactsObserver = observer(PhoneSource.CONTACTS)
    private val calendarObserver = object : ContentObserver(main) {
        override fun onChange(selfChange: Boolean) {
            calendarChanged?.invoke()
        }
    }

    /** What Rust's `PhoneWatch` on the calendar wants told when the store changes, or null. Main thread. */
    private var calendarChanged: (() -> Unit)? = null
    private var started = false
    private var attached = false

    /** The question the member is being asked, or null. Read by [PhoneFollowSheet]. */
    var question: PhoneFollowQuestion? by mutableStateOf(null)
        private set

    /** The foreground vault's session is open: followed from now on, and followed once at once. */
    fun attach(session: HomeSession) {
        val sources = listOf(
            ContactsFollow(contactsReader),
            FilesFollow(AndroidFolderReader(context)),
        )
        bridge.attach(session, sources) { question = it }
        attached = true
        if (started) requestAll()
    }

    /** The session was released: nothing is followed until the next [attach]. */
    fun detach() {
        attached = false
        question = null
    }

    /**
     * Rust's `PhoneWatch` on the calendar: [changed] is told each time the store changes and each
     * time the app comes forward, until a null [changed] stops it. Main thread.
     */
    fun watchCalendar(changed: (() -> Unit)?) {
        calendarChanged = changed
    }

    /** The activity started: watch the phone for as long as it is in view, and follow once. */
    fun start() {
        if (started) return
        started = true
        val resolver = context.contentResolver
        resolver.registerContentObserver(ContactsContract.Contacts.CONTENT_URI, true, contactsObserver)
        resolver.registerContentObserver(CalendarContract.Events.CONTENT_URI, true, calendarObserver)
        if (attached) requestAll()
        calendarChanged?.invoke()
    }

    /** The activity stopped: no observers while no one is looking. */
    fun stop() {
        if (!started) return
        started = false
        val resolver = context.contentResolver
        resolver.unregisterContentObserver(contactsObserver)
        resolver.unregisterContentObserver(calendarObserver)
    }

    /** A source changed, or one was just imported by hand: follow it soon. Main thread. */
    fun requested(source: PhoneSource) {
        if (attached) bridge.requested(source)
    }

    /** The member answered [asked]; [keep] false is Move to trash. */
    fun answer(asked: PhoneFollowQuestion, keep: Boolean) {
        question = null
        bridge.answer(asked, keep)
    }

    private fun requestAll() {
        bridge.requested(PhoneSource.CONTACTS)
        bridge.requested(PhoneSource.FILES)
    }

    private fun observer(source: PhoneSource): ContentObserver = object : ContentObserver(main) {
        override fun onChange(selfChange: Boolean) {
            requested(source)
        }
    }

    private val contactsReader = object : ContactsReader {
        override fun read(deliver: (ContactsRead?) -> Unit) {
            if (!granted(Manifest.permission.READ_CONTACTS)) return deliver(null)
            io.launch {
                val read = readPhoneContacts(context)
                deliver(ContactsRead(read.contacts, read.origins, read.complete))
            }
        }
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
}

/**
 * THE QUESTION AN ACCOUNT THAT LEFT THE PHONE LEAVES (R-1127-9), in the kit's
 * [ConfirmSheet] (DESIGN.md: a destructive confirm is never a dialog). The shared question chose
 * every word and built the confirm: Move to trash is its destructive verb, and **Keep, the
 * default**, is the sheet's cancel and what the grabber, the scrim and back mean.
 */
@Composable
internal fun PhoneFollowSheet(question: PhoneFollowQuestion, onAnswer: (keep: Boolean) -> Unit) {
    ConfirmSheet(
        confirm = question.confirm,
        cancelLabel = question.keepLabel,
        onConfirm = { onAnswer(false) },
        onDismiss = { onAnswer(true) },
    )
}
