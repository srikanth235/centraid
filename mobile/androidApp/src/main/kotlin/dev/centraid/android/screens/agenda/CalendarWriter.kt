package dev.centraid.android.screens.agenda

import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import androidx.core.content.ContextCompat
import centraid.core.v1.CalendarWrite
import centraid.core.v1.CalendarWriteFields
import centraid.core.v1.CalendarWriteItem
import centraid.core.v1.CalendarWritten
import centraid.core.v1.CalendarWrittenItem
import dev.centraid.android.kit.PhoneOrigins
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * THE PHONE'S CALENDARS, WRITTEN FOR THE SCREEN RUNTIME: the platform half of two-way calendar sync.
 *
 * Rust asks with a `CalendarWrite` effect (`session/ShellEffects.kt` performs it) and this answers
 * with a [CalendarWritten] holding one item per item asked, in order. **It never asks for the
 * permission**: the core sends the effect only for a device whose last read was allowed, and an item
 * written while `WRITE_CALENDAR` is not granted answers `ok: false`. Which events to write, what a
 * series edit means and what the member is told are Rust's (`crates/screens/src/agenda/calendar_push.rs`);
 * nothing is decided here.
 *
 * - **A series edit** (`SPAN_SERIES`) updates the master event; the rule is rewritten only when the
 *   item states it.
 * - **One day of a series** (`SPAN_THIS`) is an exception row (`ORIGINAL_ID` and
 *   `ORIGINAL_INSTANCE_TIME`, written through `CONTENT_EXCEPTION_URI`); a cancelled day is the same
 *   row with `STATUS_CANCELED`. A row already written for that day is changed, never doubled.
 * - **A create** answers the new `Events._ID` in the id form the read uses (`PhoneOrigins.eventId`).
 * - **A delete** compares the phone's copy with what the core last saw and, when the member changed
 *   it since, deletes nothing and answers `ok: true, phone_kept: true`.
 * - `CalendarContract` has no address column, so an event's `url` is the last paragraph of its
 *   description ([CalendarLink]); the reader splits it out again, so a pass that only reads what it
 *   wrote changes nothing.
 */
internal fun performCalendarWrite(context: Context, write: CalendarWrite): CalendarWritten {
    val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED
    val resolver = context.contentResolver
    val items = write.items.map { item ->
        if (!granted) {
            refused(item, "calendar write access is off")
        } else {
            try {
                writeItem(resolver, item)
            } catch (why: SecurityException) {
                refused(item, why.message.orEmpty())
            } catch (why: IllegalArgumentException) {
                refused(item, why.message.orEmpty())
            } catch (why: IllegalStateException) {
                refused(item, why.message.orEmpty())
            }
        }
    }
    return CalendarWritten(items = items)
}

private fun refused(item: CalendarWriteItem, why: String) = CalendarWrittenItem(event_id = item.event_id, ok = false, error = why)

private fun writeItem(resolver: ContentResolver, item: CalendarWriteItem): CalendarWrittenItem = when (item.op) {
    CalendarWriteItem.Op.OP_CREATE -> create(resolver, item)
    CalendarWriteItem.Op.OP_UPDATE -> update(resolver, item)
    CalendarWriteItem.Op.OP_DELETE -> delete(resolver, item)
    else -> refused(item, "unknown operation")
}

// ---- create ------------------------------------------------------------------------------------

private fun create(resolver: ContentResolver, item: CalendarWriteItem): CalendarWrittenItem {
    val fields = item.fields ?: return refused(item, "nothing to write")
    val calendarId = findCalendar(resolver, item.calendar_key) ?: return refused(item, "calendar not found")
    val recurring = fields.rrule.isNotEmpty()
    val values = ContentValues().apply {
        put(CalendarContract.Events.CALENDAR_ID, calendarId)
        put(CalendarContract.Events.TITLE, fields.title)
        put(CalendarContract.Events.DESCRIPTION, CalendarLink.join(fields.notes, fields.url))
        put(CalendarContract.Events.AVAILABILITY, availability(fields.busy))
        putWhen(whenOf(fields), recurring)
        if (recurring) put(CalendarContract.Events.RRULE, fields.rrule)
        put(CalendarContract.Events.HAS_ALARM, if (fields.alerts.isEmpty()) 0 else 1)
    }
    val uri = resolver.insert(CalendarContract.Events.CONTENT_URI, values) ?: return refused(item, "the phone refused the event")
    val id = ContentUris.parseId(uri)
    writeAlerts(resolver, id, fields.alerts)
    return CalendarWrittenItem(event_id = item.event_id, ok = true, external_id = PhoneOrigins.eventId(uidOf(resolver, id), id))
}

// ---- update ------------------------------------------------------------------------------------

private fun update(resolver: ContentResolver, item: CalendarWriteItem): CalendarWrittenItem {
    val fields = item.fields ?: CalendarWriteFields()
    val id = findEvent(resolver, item.external_id) ?: return refused(item, "event not found")
    val current = readCurrent(resolver, id) ?: return refused(item, "event not found")
    val done = CalendarWrittenItem(event_id = item.event_id, ok = true, external_id = item.external_id)
    if (item.span == CalendarWriteItem.Span.SPAN_THIS) {
        updateDay(resolver, item, fields, id, current)
        return done
    }
    val values = ContentValues()
    if (fields.states_title) values.put(CalendarContract.Events.TITLE, fields.title)
    describe(fields, current.notes)?.let { values.put(CalendarContract.Events.DESCRIPTION, it) }
    if (fields.states_busy) values.put(CalendarContract.Events.AVAILABILITY, availability(fields.busy))
    if (fields.states_when || fields.states_rrule) {
        val moment = if (fields.states_when) whenOf(fields) else current.moment()
        val rule = if (fields.states_rrule) fields.rrule else current.rrule
        values.putWhen(moment, rule.isNotEmpty())
        if (rule.isEmpty()) values.putNull(CalendarContract.Events.RRULE) else values.put(CalendarContract.Events.RRULE, rule)
    }
    if (fields.states_alerts) values.put(CalendarContract.Events.HAS_ALARM, if (fields.alerts.isEmpty()) 0 else 1)
    if (values.size() > 0) resolver.update(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), values, null, null)
    if (fields.states_alerts) writeAlerts(resolver, id, fields.alerts)
    return done
}

/**
 * THE DESCRIPTION AN UPDATE WRITES: the notes and the link, each from [fields] where it states it and
 * from the phone's [stored] description where it does not. Null when it states neither.
 */
private fun describe(fields: CalendarWriteFields, stored: String): String? {
    if (!fields.states_notes && !fields.states_url) return null
    val (notes, url) = CalendarLink.split(stored)
    return CalendarLink.join(if (fields.states_notes) fields.notes else notes, if (fields.states_url) fields.url else url)
}

/** ONE DAY OF A SERIES: its exception row, found or made, changed or cancelled. */
private fun updateDay(resolver: ContentResolver, item: CalendarWriteItem, fields: CalendarWriteFields, masterId: Long, master: Current) {
    val zone = TimeZone.getTimeZone(master.zone)
    val original = instant(item.original_start, zone)
    val existing = findException(resolver, masterId, original)
    val values = ContentValues().apply { put(CalendarContract.Events.ORIGINAL_INSTANCE_TIME, original) }
    if (item.cancel) {
        values.put(CalendarContract.Events.STATUS, CalendarContract.Events.STATUS_CANCELED)
    } else {
        if (fields.states_title) values.put(CalendarContract.Events.TITLE, fields.title)
        describe(fields, master.notes)?.let { values.put(CalendarContract.Events.DESCRIPTION, it) }
        if (fields.states_busy) values.put(CalendarContract.Events.AVAILABILITY, availability(fields.busy))
        // AN EXCEPTION NEEDS ITS OWN TIMES: the moved ones, else the day's own at the series' length.
        val moment = if (fields.states_when) {
            whenOf(fields)
        } else {
            val length = master.moment().let { it.end - it.start }
            Moment(master.allDay, original, original + length, master.zone)
        }
        values.putWhen(moment, recurring = false)
        if (fields.states_alerts) values.put(CalendarContract.Events.HAS_ALARM, if (fields.alerts.isEmpty()) 0 else 1)
    }
    val dayId = if (existing != null) {
        resolver.update(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, existing), values, null, null)
        existing
    } else {
        val uri = resolver.insert(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_EXCEPTION_URI, masterId), values)
            ?: error("the phone refused the day")
        ContentUris.parseId(uri)
    }
    if (!item.cancel && fields.states_alerts) writeAlerts(resolver, dayId, fields.alerts)
}

// ---- delete ------------------------------------------------------------------------------------

private fun delete(resolver: ContentResolver, item: CalendarWriteItem): CalendarWrittenItem {
    val id = findEvent(resolver, item.external_id) ?: return CalendarWrittenItem(event_id = item.event_id, ok = true)
    val current = readCurrent(resolver, id) ?: return CalendarWrittenItem(event_id = item.event_id, ok = true)
    // THE MEMBER CHANGED IT ON THE PHONE SINCE THE CORE LAST SAW IT: leave it alone, and say so.
    val expected = item.expected
    if (expected != null && current.differsFrom(expected.title, expected.notes, expected.url, expected.start, expected.end)) {
        return CalendarWrittenItem(event_id = item.event_id, ok = true, phone_kept = true)
    }
    resolver.delete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), null, null)
    return CalendarWrittenItem(event_id = item.event_id, ok = true)
}

// ---- the phone's rows ----------------------------------------------------------------------------

/** One event row as the provider holds it. */
private class Current(
    val title: String,
    val notes: String,
    val allDay: Boolean,
    val start: Long,
    val end: Long?,
    val duration: String?,
    val rrule: String,
    val zone: String,
) {
    /** Its start and end, whether the row keeps an end or (a repeating one) a duration. */
    fun moment(): Moment {
        val last = end ?: (start + (durationMs(duration) ?: 0L))
        return Moment(allDay, start, maxOf(start, last), zone)
    }

    /** True when a stated field of the core's last read differs from this row; an empty one is not stated. */
    fun differsFrom(expectedTitle: String, expectedNotes: String, expectedUrl: String, expectedStart: String, expectedEnd: String): Boolean {
        val (phoneNotes, phoneUrl) = CalendarLink.split(notes)
        val tz = TimeZone.getTimeZone(zone)
        val moment = moment()
        val startText = if (allDay) utcDay(moment.start) else wallClock(moment.start, tz)
        val endText = if (allDay) utcDay(maxOf(moment.start, moment.end - DAY_MS)) else wallClock(moment.end, tz)
        return (expectedTitle.isNotEmpty() && expectedTitle != title) ||
            (expectedNotes.isNotEmpty() && expectedNotes != phoneNotes) ||
            (expectedUrl.isNotEmpty() && expectedUrl != phoneUrl) ||
            (expectedStart.isNotEmpty() && expectedStart != startText) ||
            (expectedEnd.isNotEmpty() && expectedEnd != endText)
    }
}

/** A start and an end in epoch milliseconds, and the zone its wall clock is in (`UTC` for all-day). */
private class Moment(val allDay: Boolean, val start: Long, val end: Long, val zone: String)

private fun readCurrent(resolver: ContentResolver, id: Long): Current? {
    val projection = arrayOf(
        CalendarContract.Events.TITLE,
        CalendarContract.Events.DESCRIPTION,
        CalendarContract.Events.ALL_DAY,
        CalendarContract.Events.DTSTART,
        CalendarContract.Events.DTEND,
        CalendarContract.Events.DURATION,
        CalendarContract.Events.RRULE,
        CalendarContract.Events.EVENT_TIMEZONE,
    )
    resolver.query(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), projection, null, null, null)?.use { cursor ->
        if (!cursor.moveToFirst()) return null
        val allDay = cursor.getInt(2) == 1
        return Current(
            title = cursor.getString(0).orEmpty(),
            notes = cursor.getString(1).orEmpty(),
            allDay = allDay,
            start = cursor.getLong(3),
            end = if (cursor.isNull(4)) null else cursor.getLong(4),
            duration = cursor.getString(5),
            rrule = cursor.getString(6).orEmpty(),
            zone = cursor.getString(7)?.takeIf { it.isNotEmpty() && it in TimeZone.getAvailableIDs() }
                ?: if (allDay) "UTC" else TimeZone.getDefault().id,
        )
    }
    return null
}

/** The calendar row a `PhoneCalendar.key` names, among the ones the member can write to. */
private fun findCalendar(resolver: ContentResolver, key: String): Long? {
    val projection = arrayOf(
        CalendarContract.Calendars._ID,
        CalendarContract.Calendars.ACCOUNT_TYPE,
        CalendarContract.Calendars.ACCOUNT_NAME,
        "_sync_id",
    )
    val selection = "${CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL} >= ${CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR}"
    resolver.query(CalendarContract.Calendars.CONTENT_URI, projection, selection, null, null)?.use { cursor ->
        while (cursor.moveToNext()) {
            val id = cursor.getLong(0)
            if (PhoneOrigins.calendarKey(cursor.getString(1), cursor.getString(2), cursor.getString(3), id) == key) return id
        }
    }
    return null
}

/** The event row an id of the read's forms (`local:<row>`, `uid:<uid>`, `lookup:<uid>`) names. */
private fun findEvent(resolver: ContentResolver, externalId: String): Long? {
    val kind = externalId.substringBefore(':')
    val value = externalId.substringAfter(':', "")
    if (value.isEmpty()) return null
    if (kind == "local") return value.toLongOrNull()
    for (column in listOf("uid2445", "_sync_id")) {
        val found = runCatching {
            resolver.query(
                CalendarContract.Events.CONTENT_URI,
                arrayOf(CalendarContract.Events._ID),
                "$column = ? AND ${CalendarContract.Events.DELETED} = 0",
                arrayOf(value),
                null,
            )?.use { if (it.moveToFirst()) it.getLong(0) else null }
        }.getOrNull()
        if (found != null) return found
    }
    return null
}

/** The exception row already written for one day of a series, if any. */
private fun findException(resolver: ContentResolver, masterId: Long, original: Long): Long? =
    resolver.query(
        CalendarContract.Events.CONTENT_URI,
        arrayOf(CalendarContract.Events._ID),
        "${CalendarContract.Events.ORIGINAL_ID} = ? AND ${CalendarContract.Events.ORIGINAL_INSTANCE_TIME} = ? AND ${CalendarContract.Events.DELETED} = 0",
        arrayOf(masterId.toString(), original.toString()),
        null,
    )?.use { if (it.moveToFirst()) it.getLong(0) else null }

/** The iCal UID of one event row (`uid2445` is named by column: the constant is newer than `minSdk`). */
private fun uidOf(resolver: ContentResolver, id: Long): String? = runCatching {
    resolver.query(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), arrayOf("uid2445"), null, null, null)
        ?.use { if (it.moveToFirst()) it.getString(0) else null }
}.getOrNull()

/** THE EVENT'S ALERTS BECOME EXACTLY [minutes] (empty clears them). */
private fun writeAlerts(resolver: ContentResolver, eventId: Long, minutes: List<Int>) {
    resolver.delete(CalendarContract.Reminders.CONTENT_URI, "${CalendarContract.Reminders.EVENT_ID} = ?", arrayOf(eventId.toString()))
    for (before in minutes.distinct()) {
        val values = ContentValues().apply {
            put(CalendarContract.Reminders.EVENT_ID, eventId)
            put(CalendarContract.Reminders.MINUTES, before)
            put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT)
        }
        resolver.insert(CalendarContract.Reminders.CONTENT_URI, values)
    }
}

// ---- times ---------------------------------------------------------------------------------------

private const val DAY_MS: Long = 24L * 60 * 60 * 1000

private fun availability(busy: Boolean): Int =
    if (busy) CalendarContract.Events.AVAILABILITY_BUSY else CalendarContract.Events.AVAILABILITY_FREE

/**
 * THE TIMES OF AN ITEM, as the provider keeps them: an all-day event is UTC midnights with an
 * exclusive end (the item's end is the last day, inclusive), a timed one a wall clock in its zone
 * (the device's for a floating one, which `CalendarContract` has no word for).
 */
private fun whenOf(fields: CalendarWriteFields): Moment =
    if (fields.all_day) {
        val start = instant(fields.start, UTC)
        Moment(true, start, maxOf(start, instant(fields.end, UTC)) + DAY_MS, "UTC")
    } else {
        val zone = fields.tz.takeIf { it.isNotEmpty() && it in TimeZone.getAvailableIDs() }?.let { TimeZone.getTimeZone(it) } ?: TimeZone.getDefault()
        val start = instant(fields.start, zone)
        Moment(false, start, maxOf(start, instant(fields.end, zone)), zone.id)
    }

/** A repeating event keeps a `DURATION` and no end; a single one an end and no duration. */
private fun ContentValues.putWhen(moment: Moment, recurring: Boolean) {
    put(CalendarContract.Events.DTSTART, moment.start)
    put(CalendarContract.Events.ALL_DAY, if (moment.allDay) 1 else 0)
    put(CalendarContract.Events.EVENT_TIMEZONE, moment.zone)
    if (recurring) {
        putNull(CalendarContract.Events.DTEND)
        // ALL-DAY DURATIONS ARE IN DAYS, a timed one's in seconds.
        put(
            CalendarContract.Events.DURATION,
            if (moment.allDay) "P${maxOf(1L, (moment.end - moment.start) / DAY_MS)}D" else "P${(moment.end - moment.start) / 1000}S",
        )
    } else {
        put(CalendarContract.Events.DTEND, moment.end)
        putNull(CalendarContract.Events.DURATION)
    }
}

private val UTC: TimeZone = TimeZone.getTimeZone("UTC")

/** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS`, read as a clock in [zone]. */
private fun instant(text: String, zone: TimeZone): Long {
    val pattern = if (text.length <= DATE_LENGTH) "yyyy-MM-dd" else "yyyy-MM-dd'T'HH:mm:ss"
    val format = SimpleDateFormat(pattern, Locale.US).apply {
        timeZone = if (text.length <= DATE_LENGTH) UTC else zone
        isLenient = false
    }
    return requireNotNull(format.parse(text)) { "the time cannot be read" }.time
}

private const val DATE_LENGTH: Int = 10
