package dev.centraid.android.notify

import android.content.Context
import android.util.Base64
import centraid.core.v1.ScheduleNotifications
import centraid.core.v1.PendingNotification

/**
 * WHAT THIS PHONE HAS PUT IN THE OS, AND WHETHER IT ASKED (#1173).
 *
 * The record is the last `ScheduleNotifications` that was performed, as its own proto bytes: the
 * items (every field), the categories (their buttons and words) and the channel's name. It is what a
 * diff runs against, what the alarm receiver reads to word a notification, and what a reboot re-arms
 * from. A dedicated preferences file, kept out of every backup: `android:allowBackup="false"` and both
 * rule files exclude the `sharedpref` domain (see the manifest), so it never moves to another phone.
 */
internal class NotifyStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** Whether the permission prompt was ever shown by this app for notifications. */
    fun asked(): Boolean = prefs.getBoolean(ASKED, false)

    fun markAsked() {
        prefs.edit().putBoolean(ASKED, true).commit()
    }

    fun load(): ScheduleNotifications = synchronized(recordLock) {
        runCatching {
            prefs.getString(RECORD, null)?.let { NotifyCache.decode(Base64.decode(it, Base64.NO_WRAP), prefs.getInt(VERSION, 0)) }
        }.getOrNull() ?: ScheduleNotifications()
    }

    fun save(record: ScheduleNotifications): Boolean = synchronized(recordLock) {
        prefs.edit()
            .putInt(VERSION, NotifyCache.VERSION)
            .putString(RECORD, Base64.encodeToString(ScheduleNotifications.ADAPTER.encode(record), Base64.NO_WRAP))
            .commit()
    }

    /** Remove only the exact timed item just posted, not a newer replacement with the same id. */
    fun deliveredTimed(item: PendingNotification): Boolean = synchronized(recordLock) {
        val current = load()
        val kept = current.all.filterNot { !it.immediate && it == item }
        if (kept.size == current.all.size) true else save(current.copy(all = kept))
    }

    fun seenImmediates(): Set<String> = prefs.getStringSet(SEEN, emptySet()).orEmpty().toSet()

    fun rememberImmediates(ids: Set<String>) {
        prefs.edit().putStringSet(SEEN, ids).commit()
    }

    private companion object {
        val recordLock: Any = Any()
        const val FILE: String = "centraid.notify"
        const val ASKED: String = "asked"
        const val VERSION: String = "record-version"
        const val SEEN: String = "immediates-seen"
        const val RECORD: String = "record"
    }
}
