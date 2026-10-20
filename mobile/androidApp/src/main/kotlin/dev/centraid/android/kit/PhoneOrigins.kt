package dev.centraid.android.kit

import dev.centraid.shared.sync.phone.PhoneIds

/**
 * THE IDS AND ORIGINS THE ANDROID READERS HAND THE PHONE SYNC (R-1127-10, #1127).
 *
 * Pure string work, so a JVM test pins it: the readers in `ContactsImporter` and
 * `CalendarImporter` only choose which column feeds each argument.
 *
 * - **A contact** is `lookup:` plus its `LOOKUP_KEY`, the id `ContactsContract` documents as the
 *   one to keep across syncs; `CONTACT_ID` is a row number that aggregation may re-issue, so it
 *   is only the fallback (`local:`).
 * - **An event** is `uid:` plus its iCal UID (`uid2445`, the same on every device Google syncs
 *   to), else `local:` plus the event row id.
 * - **An account** origin is `account:<type>/<name>`, and a raw contact with no account is
 *   `account:local`.
 * - **A calendar** origin is `calendar:<type>/<name>/<key>`, the key being the sync adapter's
 *   `_sync_id` (the server's calendar id, so it survives a re-sync and a re-added account) and
 *   the calendar row id when the adapter writes none (a local calendar never re-syncs).
 *   `CAL_SYNC1` is not used: its meaning belongs to each adapter.
 */
internal object PhoneOrigins {
    const val LOCAL_ACCOUNT: String = "account:local"

    fun contactId(lookupKey: String?, contactRowId: Long): String =
        lookupKey?.trim()?.takeIf { it.isNotEmpty() }?.let(PhoneIds::lookup) ?: PhoneIds.local(contactRowId.toString())

    fun eventId(uid: String?, eventRowId: Long): String =
        uid?.trim()?.takeIf { it.isNotEmpty() }?.let(PhoneIds::uid) ?: PhoneIds.local(eventRowId.toString())

    fun accountId(type: String?, name: String?): String {
        val kind = type?.trim().orEmpty()
        val who = name?.trim().orEmpty()
        return if (kind.isEmpty() && who.isEmpty()) LOCAL_ACCOUNT else "account:$kind/$who"
    }

    fun calendarId(type: String?, name: String?, syncId: String?, rowId: Long): String {
        val key = syncId?.trim()?.takeIf { it.isNotEmpty() } ?: rowId.toString()
        return "calendar:${type?.trim().orEmpty()}/${name?.trim().orEmpty()}/$key"
    }

    /** "Google: ada@example.com": the provider as the system names it, then the account. */
    fun accountLabel(typeLabel: String, name: String?): String {
        val who = name?.trim().orEmpty()
        return when {
            typeLabel.isEmpty() -> who
            who.isEmpty() -> typeLabel
            else -> "$typeLabel: $who"
        }
    }

    /** "ada@example.com: Work": the account, then the calendar's own name. */
    fun calendarLabel(accountName: String?, displayName: String?): String {
        val account = accountName?.trim().orEmpty()
        val calendar = displayName?.trim().orEmpty()
        return when {
            account.isEmpty() -> calendar
            calendar.isEmpty() -> account
            else -> "$account: $calendar"
        }
    }
}
