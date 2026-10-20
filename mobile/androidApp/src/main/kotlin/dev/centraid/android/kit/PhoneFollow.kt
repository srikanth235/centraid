package dev.centraid.android.kit

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.CalendarContract
import android.provider.ContactsContract
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import dev.centraid.android.screens.agenda.readPhoneEvents
import dev.centraid.android.screens.people.readPhoneContacts
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.shared.shell.CalendarRead
import dev.centraid.shared.shell.ContactsRead
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.shell.PhoneFollowBridge
import dev.centraid.shared.shell.PhoneFollowQuestion
import dev.centraid.shared.shell.PhoneFollowShell
import dev.centraid.shared.sync.phone.PhoneSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.TimeZone

/**
 * ANDROID FOLLOWS THE PHONE (#1127): THE TRIGGERS AND THE SHELL'S HALF OF `PhoneFollowBridge`.
 *
 * - **Triggers.** The activity's `onStart` (the app came to the front) and a [ContentObserver] on
 *   the address book and on the events, registered from `onStart` to `onStop`, each say
 *   [requested]. The bridge coalesces a burst, runs one pass per source at a time, and does
 *   nothing for a source the member never imported.
 * - **Reads.** A pass asks [readContacts] / [readCalendar], answered off the main thread, and
 *   **null when the permission is not already granted: a pass never asks the OS**, only the
 *   member's Import tap does (R-ONBOARD-4).
 * - **The question.** [ask] holds the one question the bridge is waiting on; [PhoneFollowDialog]
 *   draws it and [answer] sends the member's choice back.
 *
 * Held by the activity and built on the application context, so it keeps no activity alive.
 */
internal class AndroidPhoneFollow(context: Context) : PhoneFollowShell {
    private val context: Context = context.applicationContext
    private val bridge = PhoneFollowBridge()
    private val io = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val main = Handler(Looper.getMainLooper())
    private val contactsObserver = observer(PhoneSource.CONTACTS)
    private val calendarObserver = observer(PhoneSource.CALENDAR)
    private var started = false
    private var attached = false

    /** The question the member is being asked, or null. Read by [PhoneFollowDialog]. */
    var question: PhoneFollowQuestion? by mutableStateOf(null)
        private set

    /** The foreground vault's session is open: followed from now on, and followed once at once. */
    fun attach(session: HomeSession) {
        bridge.attach(session, this)
        attached = true
        if (started) requestAll()
    }

    /** The session was released: nothing is followed until the next [attach]. */
    fun detach() {
        attached = false
        question = null
    }

    /** The activity started: watch the phone for as long as it is in view, and follow once. */
    fun start() {
        if (started) return
        started = true
        val resolver = context.contentResolver
        resolver.registerContentObserver(ContactsContract.Contacts.CONTENT_URI, true, contactsObserver)
        resolver.registerContentObserver(CalendarContract.Events.CONTENT_URI, true, calendarObserver)
        if (attached) requestAll()
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
        bridge.requested(PhoneSource.CALENDAR)
    }

    private fun observer(source: PhoneSource): ContentObserver = object : ContentObserver(main) {
        override fun onChange(selfChange: Boolean) {
            requested(source)
        }
    }

    override fun readContacts(done: (ContactsRead?) -> Unit) {
        if (!granted(Manifest.permission.READ_CONTACTS)) return done(null)
        io.launch {
            val read = readPhoneContacts(context)
            done(ContactsRead(read.contacts, read.origins, read.complete))
        }
    }

    override fun readCalendar(done: (CalendarRead?) -> Unit) {
        if (!granted(Manifest.permission.READ_CALENDAR)) return done(null)
        io.launch {
            val now = System.currentTimeMillis()
            val read = readPhoneEvents(context, now)
            done(CalendarRead(read.events, read.origins, read.complete, TimeZone.getDefault().id, now))
        }
    }

    override fun ask(question: PhoneFollowQuestion) {
        this.question = question
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
}

/**
 * THE QUESTION AN ACCOUNT OR CALENDAR THAT LEFT THE PHONE LEAVES (R-1127-9). **Keep is the
 * default**: the confirm button, and what dismissing the dialog means. Every word is the
 * question's own, from the shared copy.
 */
@Composable
internal fun PhoneFollowDialog(question: PhoneFollowQuestion, onAnswer: (keep: Boolean) -> Unit) {
    AlertDialog(
        onDismissRequest = { onAnswer(true) },
        containerColor = centraidColor("bg"),
        title = { Text(question.title, style = centraidType("smallStrong"), color = centraidColor("text")) },
        text = { Text(question.body, style = centraidType("body"), color = centraidColor("textSoft")) },
        confirmButton = { KitLink(label = question.keepLabel, onClick = { onAnswer(true) }) },
        dismissButton = { KitLink(label = question.trashLabel, onClick = { onAnswer(false) }) },
    )
}
