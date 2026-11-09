package dev.centraid.android.notify

import android.content.Context
import android.util.Base64
import centraid.core.v1.ScheduleNotifications

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

    fun load(): ScheduleNotifications = runCatching {
        prefs.getString(RECORD, null)?.let { ScheduleNotifications.ADAPTER.decode(Base64.decode(it, Base64.NO_WRAP)) }
    }.getOrNull() ?: ScheduleNotifications()

    fun save(record: ScheduleNotifications) {
        prefs.edit().putString(RECORD, Base64.encodeToString(ScheduleNotifications.ADAPTER.encode(record), Base64.NO_WRAP)).commit()
    }

    private companion object {
        const val FILE: String = "centraid.notify"
        const val ASKED: String = "asked"
        const val RECORD: String = "record"
    }
}
