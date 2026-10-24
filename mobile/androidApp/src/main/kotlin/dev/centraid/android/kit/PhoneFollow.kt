package dev.centraid.android.kit

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.CalendarContract
import android.provider.ContactsContract
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.centraid.android.screens.docs.AndroidFolderReader
import dev.centraid.shared.apps.docs.FilesFollow
import dev.centraid.shared.apps.health.HealthFollow
import dev.centraid.shared.apps.health.HealthReader
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.shell.PhoneFollowBridge
import dev.centraid.shared.shell.PhoneFollowQuestion
import dev.centraid.shared.sync.phone.PhoneSource

/**
 * ANDROID FOLLOWS THE PHONE (#1127): THE TRIGGERS, THE READERS AND THE QUESTION.
 *
 * - **Triggers.** The activity's `onStart` (the app came to the front) and a [ContentObserver] on
 *   the address book and on the events, registered from `onStart` to `onStop`, each say
 *   [requested]. The bridge coalesces a burst, runs one pass per source at a time, and does
 *   nothing for a source the member never imported.
 * - **The calendar and the contacts are Rust's (#1135).** Agenda's and People's screens hold
 *   their follows (`crates/screens/src/agenda/calendar.rs`, `.../people/contacts.rs`): each asks
 *   to watch its store with a `PhoneWatch` effect ([watchCalendar], [watchContacts]) and reads it
 *   with `CalendarRead` / `ContactsRead` (`ScreenEffects.kt`), **a pass never asking the OS**:
 *   only the member's Import tap does (R-ONBOARD-4). Here each is only the observer and the app
 *   coming forward, reported to that watch.
 * - **Reads.** Docs' folders are read by `AndroidFolderReader`, over
 *   the tree grants the member gave when they picked each folder; triggers for them are the app
 *   coming forward and the picker returning (`requested(PhoneSource.FILES)`), with no watcher.
 *   Health Connect is read by [health] (`HealthConnectReader`), over the types the member chose
 *   on Health's Connect page; its triggers are the app coming forward and Connect itself, with no
 *   watcher (#1129).
 * - **The question.** [question] holds the one the bridge is waiting on; [PhoneFollowSheet]
 *   draws it and [answer] sends the member's choice back.
 *
 * Held by the activity and built on the application context, so it keeps no activity alive.
 */
internal class AndroidPhoneFollow(context: Context, private val health: HealthReader) {
    private val context: Context = context.applicationContext
    private val bridge = PhoneFollowBridge()
    private val main = Handler(Looper.getMainLooper())
    private val contactsObserver = object : ContentObserver(main) {
        override fun onChange(selfChange: Boolean) {
            contactsChanged?.invoke()
        }
    }
    private val calendarObserver = object : ContentObserver(main) {
        override fun onChange(selfChange: Boolean) {
            calendarChanged?.invoke()
        }
    }

    /** What Rust's `PhoneWatch` on the calendar wants told when the store changes, or null. Main thread. */
    private var calendarChanged: (() -> Unit)? = null
    /** What Rust's `PhoneWatch` on the contacts wants told when the address book changes, or null. Main thread. */
    private var contactsChanged: (() -> Unit)? = null
    private var started = false
    private var attached = false

    /** The question the member is being asked, or null. Read by [PhoneFollowSheet]. */
    var question: PhoneFollowQuestion? by mutableStateOf(null)
        private set

    /** The foreground vault's session is open: followed from now on, and followed once at once. */
    fun attach(session: HomeSession) {
        val sources = listOf(
            FilesFollow(AndroidFolderReader(context)),
            HealthFollow(health),
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

    /** Rust's `PhoneWatch` on the contacts, as [watchCalendar] is on the calendar. Main thread. */
    fun watchContacts(changed: (() -> Unit)?) {
        contactsChanged = changed
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
        contactsChanged?.invoke()
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
        bridge.requested(PhoneSource.FILES)
        bridge.requested(PhoneSource.HEALTH)
    }
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
