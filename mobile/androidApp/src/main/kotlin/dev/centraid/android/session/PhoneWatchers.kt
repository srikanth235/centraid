package dev.centraid.android.session

import android.content.Context
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.CalendarContract
import android.provider.ContactsContract
import centraid.core.v1.ImportSource

/**
 * THE WATCH ON A PHONE STORE (`PhoneWatch`, #1127, #1135): Agenda's calendar follow and People's
 * contacts follow ask to hear when the calendar or the address book changes, and each is told also
 * whenever the app comes forward. What is read and when is Rust's (`agenda/calendar.rs`,
 * `people/contacts.rs`); a pass never asks the OS for a grant.
 */
internal class PhoneWatchers(context: Context) {
    private val context: Context = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val watching = mutableMapOf<ImportSource, Pair<ContentObserver, () -> Unit>>()

    /** Whether this shell watches [source] at all. */
    fun watches(source: ImportSource): Boolean = uriOf(source) != null

    /** Tell [changed] each time [source] changes and each time the app comes forward, until [stop]. */
    @Synchronized
    fun watch(source: ImportSource, changed: () -> Unit) {
        val uri = uriOf(source) ?: return
        stop(source)
        val observer = object : ContentObserver(main) {
            override fun onChange(selfChange: Boolean) = changed()
        }
        runCatching { context.contentResolver.registerContentObserver(uri, true, observer) }
        watching[source] = observer to changed
    }

    @Synchronized
    fun stop(source: ImportSource) {
        val (observer, _) = watching.remove(source) ?: return
        runCatching { context.contentResolver.unregisterContentObserver(observer) }
    }

    /** The app came forward: every watch hears it. */
    @Synchronized
    fun foregrounded() {
        watching.values.forEach { (_, changed) -> changed() }
    }

    private fun uriOf(source: ImportSource): Uri? = when (source) {
        ImportSource.IMPORT_SOURCE_CALENDAR -> CalendarContract.Events.CONTENT_URI
        ImportSource.IMPORT_SOURCE_CONTACTS -> ContactsContract.Contacts.CONTENT_URI
        else -> null
    }
}
