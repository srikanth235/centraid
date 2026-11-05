package dev.centraid.android.screens.agenda

import android.content.ContentProviderOperation
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.provider.CalendarContract
import centraid.core.v1.CalendarMutation
import centraid.core.v1.CalendarReceipt
import centraid.core.v1.CalendarWrite
import centraid.core.v1.CalendarWritten
import dev.centraid.android.kit.PhoneOrigins
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset

/** Native serialization only; the core supplies every field that may change. */
internal fun calendarMillis(value: String, allDay: Boolean, zone: String, inclusiveEnd: Boolean = false): Long? = runCatching {
    if (allDay) {
        val day = LocalDate.parse(value).plusDays(if (inclusiveEnd) 1 else 0)
        day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
    } else {
        val local = LocalDateTime.parse(value)
        val resolved = if (zone.isEmpty()) ZoneId.systemDefault() else ZoneId.of(zone)
        val offsets = resolved.rules.getValidOffsets(local)
        require(offsets.isNotEmpty())
        local.toInstant(offsets.first()).toEpochMilli()
    }
}.getOrNull()

internal fun writeCalendar(context: Context, request: CalendarWrite): CalendarWritten {
    val resolver = context.contentResolver
    var applied = 0
    var conflicted = 0
    var refused = 0
    val receipts = mutableListOf<CalendarReceipt>()
    for (change in request.changes) {
        try {
            val old = change.expected
            val id = change.native_id.toLongOrNull()
            val occurrence = change.original_start.isNotEmpty()
            val inherited = occurrence && old?.native_series_id?.toLongOrNull() == id
            val calendar = calendarIdForKey(resolver, change.calendar_key)
            if (calendar == null) { refused++; continue }
            val providerRow = id?.let { readWriteRow(resolver, it) }
            val row = if (inherited && id != null && providerRow != null && old != null)
                occurrenceRow(resolver, id, providerRow, old) else providerRow
            if (old != null && (id == null || row == null || !matchesCalendarRow(resolver, id, row, change, calendar))) {
                conflicted++; continue
            }
            val targetId = if (inherited) null else id
            val operations = arrayListOf<ContentProviderOperation>()
            if (providerRow != null) {
                // Assert the row again inside the provider batch. A concurrent
                // source update cannot be overwritten between read and write.
                operations.add(ContentProviderOperation.newAssertQuery(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id))
                    .withValues(providerRow).withExpectedCount(1).build())
            }
            if (change.deleted && !occurrence) {
                if (id != null) operations.add(ContentProviderOperation.newDelete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id)).build())
                resolver.applyBatch(CalendarContract.AUTHORITY, operations)
                applied++
                continue
            }
            val desired = change.desired
            if (desired == null) { refused++; continue }
            val fields = change.fields
            val values = ContentValues()
            if (old == null || inherited) values.put(CalendarContract.Events.CALENDAR_ID, calendar)
            if (occurrence) {
                val series = old?.series
                val original = series?.let { calendarMillis(change.original_start, it.start.length == 10, it.tz) }
                val master = old?.native_series_id?.toLongOrNull()
                if (master == null || original == null) { refused++; continue }
                values.put(CalendarContract.Events.ORIGINAL_ID, master)
                values.put(CalendarContract.Events.ORIGINAL_INSTANCE_TIME, original)
                values.put(CalendarContract.Events.ORIGINAL_ALL_DAY, if (series.start.length == 10) 1 else 0)
                values.putNull(CalendarContract.Events.RRULE)
                values.put(CalendarContract.Events.STATUS, if (change.deleted) CalendarContract.Events.STATUS_CANCELED else CalendarContract.Events.STATUS_CONFIRMED)
                if (inherited) {
                    values.put(CalendarContract.Events.TITLE, desired.title)
                    values.put(CalendarContract.Events.DESCRIPTION, desired.notes)
                    values.put(CalendarContract.Events.CUSTOM_APP_URI, desired.url)
                    values.put(CalendarContract.Events.EVENT_LOCATION, desired.location)
                    values.put(CalendarContract.Events.AVAILABILITY, if (desired.free) CalendarContract.Events.AVAILABILITY_FREE else CalendarContract.Events.AVAILABILITY_BUSY)
                }
            }
            if ("title" in fields) values.put(CalendarContract.Events.TITLE, desired.title)
            if ("description" in fields) values.put(CalendarContract.Events.DESCRIPTION, desired.notes)
            if ("url" in fields) values.put(CalendarContract.Events.CUSTOM_APP_URI, desired.url)
            if ("location" in fields) values.put(CalendarContract.Events.EVENT_LOCATION, desired.location)
            if ("busy" in fields) values.put(CalendarContract.Events.AVAILABILITY, if (desired.free) CalendarContract.Events.AVAILABILITY_FREE else CalendarContract.Events.AVAILABILITY_BUSY)
            if (old == null || occurrence || fields.any { it in listOf("starts", "ends", "timing", "zone", "rule") }) {
                val start = calendarMillis(desired.start, desired.all_day, desired.tz)
                val end = calendarMillis(desired.end, desired.all_day, desired.tz, desired.all_day)
                if (start == null || end == null || end < start) { refused++; continue }
                values.put(CalendarContract.Events.DTSTART, start)
                values.put(CalendarContract.Events.ALL_DAY, if (desired.all_day) 1 else 0)
                values.put(CalendarContract.Events.EVENT_TIMEZONE, if (desired.all_day) "UTC" else desired.tz.ifEmpty { ZoneId.systemDefault().id })
                if (change.rule.isEmpty() || occurrence) {
                    values.put(CalendarContract.Events.DTEND, end)
                    values.putNull(CalendarContract.Events.DURATION)
                } else {
                    values.putNull(CalendarContract.Events.DTEND)
                    values.put(CalendarContract.Events.DURATION, "P${(end - start) / 1000}S")
                }
            }
            if ("rule" in fields && !occurrence) {
                if (change.rule.isEmpty()) values.putNull(CalendarContract.Events.RRULE) else values.put(CalendarContract.Events.RRULE, change.rule)
            }
            val eventOperation = operations.size
            operations.add(if (targetId == null) ContentProviderOperation.newInsert(CalendarContract.Events.CONTENT_URI).withValues(values).build()
                else ContentProviderOperation.newUpdate(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, targetId)).withValues(values).withExpectedCount(1).build())
            fun child(uri: android.net.Uri, childValues: ContentValues) {
                val builder = ContentProviderOperation.newInsert(uri).withValues(childValues)
                if (targetId == null) builder.withValueBackReference("event_id", eventOperation) else builder.withValue("event_id", targetId)
                operations.add(builder.build())
            }
            if ("reminders" in fields || inherited) {
                if (targetId != null) operations.add(ContentProviderOperation.newDelete(CalendarContract.Reminders.CONTENT_URI).withSelection("event_id = ?", arrayOf(targetId.toString())).build())
                for (minutes in desired.alarms_before_min.distinct()) child(CalendarContract.Reminders.CONTENT_URI, ContentValues().apply {
                    put(CalendarContract.Reminders.MINUTES, minutes)
                    put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT)
                })
            }
            if ("attendees" in fields || inherited) {
                if (targetId != null) operations.add(ContentProviderOperation.newDelete(CalendarContract.Attendees.CONTENT_URI).withSelection("event_id = ?", arrayOf(targetId.toString())).build())
                for (guest in desired.attendees) child(CalendarContract.Attendees.CONTENT_URI, ContentValues().apply {
                    put(CalendarContract.Attendees.ATTENDEE_EMAIL, guest.email)
                    put(CalendarContract.Attendees.ATTENDEE_NAME, guest.name)
                    put(CalendarContract.Attendees.ATTENDEE_RELATIONSHIP, CalendarContract.Attendees.RELATIONSHIP_ATTENDEE)
                    put(CalendarContract.Attendees.ATTENDEE_TYPE, CalendarContract.Attendees.TYPE_REQUIRED)
                    put(CalendarContract.Attendees.ATTENDEE_STATUS, when (guest.state) {
                        "accepted" -> CalendarContract.Attendees.ATTENDEE_STATUS_ACCEPTED
                        "declined" -> CalendarContract.Attendees.ATTENDEE_STATUS_DECLINED
                        "tentative" -> CalendarContract.Attendees.ATTENDEE_STATUS_TENTATIVE
                        else -> CalendarContract.Attendees.ATTENDEE_STATUS_NONE
                    })
                })
            }
            val results = resolver.applyBatch(CalendarContract.AUTHORITY, operations)
            val saved = targetId ?: results[eventOperation].uri?.let(ContentUris::parseId)
            if (saved == null) { refused++; continue }
            val uid = readWriteRow(resolver, saved)?.getAsString("uid2445")
            receipts.add(CalendarReceipt(entity_id = change.entity_id, phone_id = PhoneOrigins.eventId(uid, saved), fields = fields, original_start = change.original_start))
            applied++
        } catch (_: Exception) { refused++ }
    }
    return CalendarWritten(applied = applied, conflicted = conflicted, refused = refused, receipts = receipts)
}

private val WRITE_COLUMNS = arrayOf(CalendarContract.Events.TITLE, CalendarContract.Events.DESCRIPTION,
    CalendarContract.Events.DTSTART, CalendarContract.Events.DTEND, CalendarContract.Events.DURATION,
    CalendarContract.Events.ALL_DAY, CalendarContract.Events.EVENT_TIMEZONE, CalendarContract.Events.AVAILABILITY,
    CalendarContract.Events.RRULE, CalendarContract.Events.CALENDAR_ID, CalendarContract.Events.CUSTOM_APP_URI, CalendarContract.Events.EVENT_LOCATION, "uid2445")

private fun occurrenceRow(resolver: ContentResolver, id: Long, master: ContentValues, expected: centraid.core.v1.PhoneCalendarEvent): ContentValues? {
    val start = calendarMillis(expected.start, expected.all_day, expected.tz) ?: return null
    val builder = CalendarContract.Instances.CONTENT_URI.buildUpon()
    ContentUris.appendId(builder, start - 1)
    ContentUris.appendId(builder, start + 86_400_000)
    return resolver.query(builder.build(), arrayOf(CalendarContract.Instances.BEGIN, CalendarContract.Instances.END),
        "event_id = ? AND begin = ?", arrayOf(id.toString(), start.toString()), null)?.use { cursor ->
        if (!cursor.moveToFirst()) null else ContentValues(master).apply {
            put(CalendarContract.Events.DTSTART, cursor.getLong(0))
            put(CalendarContract.Events.DTEND, cursor.getLong(1))
        }
    }
}

private fun readWriteRow(resolver: ContentResolver, id: Long): ContentValues? {
    val uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id)
    val cursor = runCatching { resolver.query(uri, WRITE_COLUMNS, null, null, null) }.getOrNull()
        ?: resolver.query(uri, WRITE_COLUMNS.filter { it != "uid2445" }.toTypedArray(), null, null, null)
    return cursor?.use { cursor ->
        if (!cursor.moveToFirst()) null else ContentValues().apply {
            cursor.columnNames.forEachIndexed { index, column -> if (cursor.isNull(index)) putNull(column) else put(column, cursor.getString(index)) }
        }
    }
}

private fun matchesCalendarRow(resolver: ContentResolver, id: Long, row: ContentValues, change: CalendarMutation, calendar: Long): Boolean {
    val old = change.expected ?: return true
    if (row.getAsLong(CalendarContract.Events.CALENDAR_ID) != calendar) return false
    val fields = (if (change.deleted) listOf("title", "description", "url", "location", "starts", "ends", "timing", "zone", "busy", "rule", "reminders", "attendees") else change.fields)
        .filter { change.original_start.isEmpty() || it != "rule" }
    for (field in fields) when (field) {
        "title" -> if (row.getAsString(CalendarContract.Events.TITLE).orEmpty() != old.title) return false
        "description" -> if (row.getAsString(CalendarContract.Events.DESCRIPTION).orEmpty() != old.notes) return false
        "url" -> if (row.getAsString(CalendarContract.Events.CUSTOM_APP_URI).orEmpty() != old.url) return false
        "location" -> if (row.getAsString(CalendarContract.Events.EVENT_LOCATION).orEmpty() != old.location) return false
        "busy" -> if ((row.getAsInteger(CalendarContract.Events.AVAILABILITY) == CalendarContract.Events.AVAILABILITY_FREE) != old.free) return false
        "rule" -> if (row.getAsString(CalendarContract.Events.RRULE).orEmpty() != change.expected_rule) return false
        "starts", "ends", "timing", "zone" -> {
            val start = row.getAsLong(CalendarContract.Events.DTSTART)
            val end = row.getAsLong(CalendarContract.Events.DTEND) ?: durationMs(row.getAsString(CalendarContract.Events.DURATION))?.let { start + it }
            if ((row.getAsInteger(CalendarContract.Events.ALL_DAY) == 1) != old.all_day || start != calendarMillis(old.start, old.all_day, old.tz) || end != calendarMillis(old.end, old.all_day, old.tz, old.all_day)) return false
        }
        "reminders" -> if (readCalendarAlarms(resolver, setOf(id))[id].orEmpty().sorted() != old.alarms_before_min.distinct().sorted()) return false
        "attendees" -> if (readCalendarGuests(resolver, setOf(id))[id].orEmpty().sortedBy { it.email } != old.attendees.sortedBy { it.email }) return false
    }
    return true
}
