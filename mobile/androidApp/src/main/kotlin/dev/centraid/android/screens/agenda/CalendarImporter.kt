package dev.centraid.android.screens.agenda

import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.provider.CalendarContract
import centraid.core.v1.CalendarSnapshot
import centraid.core.v1.PhoneCalendar
import centraid.core.v1.PhoneCalendarEvent
import centraid.core.v1.PhoneCalendarSeries
import dev.centraid.android.kit.PhoneOrigins
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * THE PHONE'S CALENDARS, READ FOR THE SCREEN RUNTIME (#1135; docs/decisions.md,
 * "Onboarding without sample data"): the platform half of Calendar → Agenda.
 *
 * Rust asks with a `CalendarRead` effect (`kit/ScreenEffects.kt` performs it and
 * has already settled the permission, which is asked only at the member's
 * Import tap, never by a following pass); this answers with a
 * [CalendarSnapshot] of what `CalendarContract` holds over the window, every
 * occurrence its own event. What to import, how a series folds back into one
 * record, how an event maps and what the member is told are Rust's
 * (`crates/screens/src/agenda/calendar.rs`); nothing is decided here.
 */
internal fun readCalendarSnapshot(context: Context, daysBack: Int, daysOn: Int, deviceId: String): CalendarSnapshot {
    val now = System.currentTimeMillis()
    val zone = TimeZone.getDefault().id
    // A query that throws is a read that may have missed events: `complete` false, so nothing is trashed.
    val read = runCatching { readEvents(context.contentResolver, now - daysBack * DAY_MS, now + daysOn * DAY_MS) }
        .getOrElse { CalendarsRead(emptyList(), emptyList(), complete = false) }
    return CalendarSnapshot(
        now_ms = now,
        device_zone = zone,
        complete = read.complete,
        calendars = read.calendars,
        events = read.events,
        device_id = deviceId,
    )
}

private const val DAY_MS: Long = 24L * 60 * 60 * 1000

/** What the phone's calendars held at one read: the events, and every writable calendar present. */
private class CalendarsRead(
    val events: List<PhoneCalendarEvent>,
    val calendars: List<PhoneCalendar>,
    /** False when the read may have missed events (a query that failed): nothing is then trashed (R-1127-3). */
    val complete: Boolean,
)

/** One calendar the member writes to: its origin and the name they know it by. */
private class CalendarRow(val key: String, val calendar: PhoneCalendar)

/** What an event row says about where it lives and what it is called on every device. */
private class EventMeta(val calendarId: Long, val uid: String?)

/**
 * THE PHONE'S CALENDAR, ONE [PhoneCalendarEvent] PER OCCURRENCE: `Instances` over
 * the window Rust asked for, so a recurring series arrives expanded. An
 * occurrence of a series also carries its [PhoneCalendarSeries] — the master
 * event's rule and its own first occurrence — and, for an exception event (one
 * the member moved: `ORIGINAL_ID` names its series), where the rule put it; Rust
 * folds them back into one series. A cancelled occurrence
 * ([CalendarContract.Events.STATUS_CANCELED], or an `EXDATE`) is not read, which is
 * how the importer knows to skip it.
 *
 * **EACH EVENT IS KEYED BY ITS iCal UID** (R-1127-10) where the provider fills it, else its row
 * id, and **belongs to its calendar**: every visible calendar the member writes to is an origin,
 * an empty one included. A calendar the member hides has no instances, so it reads as one that
 * left the phone, and the member is asked, with Keep the default.
 */
private fun readEvents(resolver: ContentResolver, windowStart: Long, windowEnd: Long): CalendarsRead {
    val calendars = readCalendars(resolver)
    val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also {
        ContentUris.appendId(it, windowStart)
        ContentUris.appendId(it, windowEnd)
    }.build()
    val projection = arrayOf(
        CalendarContract.Instances.TITLE,
        CalendarContract.Instances.DESCRIPTION,
        CalendarContract.Instances.ALL_DAY,
        CalendarContract.Instances.BEGIN,
        CalendarContract.Instances.END,
        CalendarContract.Instances.EVENT_TIMEZONE,
        CalendarContract.Instances.AVAILABILITY,
        CalendarContract.Instances.EVENT_ID,
        CalendarContract.Instances.RRULE,
        CalendarContract.Instances.ORIGINAL_ID,
        CalendarContract.Instances.ORIGINAL_INSTANCE_TIME,
        CalendarContract.Instances.EVENT_LOCATION,
    )
    // ONLY CALENDARS THE MEMBER WRITES TO, never a cancelled instance: a
    // subscribed holiday calendar is nobody's own events, and a contacts'
    // birthdays calendar would copy what Contacts → People brought in.
    val selection = "(${CalendarContract.Instances.STATUS} IS NULL OR " +
        "${CalendarContract.Instances.STATUS} != ${CalendarContract.Events.STATUS_CANCELED}) AND " +
        "${CalendarContract.Instances.CALENDAR_ACCESS_LEVEL} >= ${CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR}"
    val device = TimeZone.getDefault()
    val rows = mutableListOf<InstanceRow>()
    resolver.query(uri, projection, selection, null, "${CalendarContract.Instances.BEGIN} ASC")?.use { cursor ->
        while (cursor.moveToNext()) {
            val begin = cursor.getLong(3)
            rows += InstanceRow(
                title = cursor.getString(0).orEmpty(),
                notes = cursor.getString(1).orEmpty(),
                allDay = cursor.getInt(2) == 1,
                begin = begin,
                end = maxOf(begin, cursor.getLong(4)),
                zone = cursor.getString(5),
                free = !cursor.isNull(6) && cursor.getInt(6) == CalendarContract.Events.AVAILABILITY_FREE,
                eventId = cursor.getLong(7),
                rrule = cursor.getString(8).orEmpty(),
                originalId = if (cursor.isNull(9)) null else cursor.getLong(9),
                originalTime = if (cursor.isNull(10)) null else cursor.getLong(10),
                location = cursor.getString(11).orEmpty(),
            )
        }
    }
    val masterIds = rows.mapNotNull { row -> row.originalId ?: row.eventId.takeIf { row.rrule.isNotEmpty() } }.toSet()
    val metas = readEventMeta(resolver, masterIds + rows.map { it.eventId })
    val series = readSeries(resolver, masterIds, device, metas)
    val events = rows.mapNotNull { row ->
        // AN INSTANCE WHOSE CALENDAR IS NOT ONE OF THE MEMBER'S VISIBLE, WRITABLE ONES is not read.
        val meta = metas[row.eventId] ?: return@mapNotNull null
        val calendar = calendars[meta.calendarId] ?: return@mapNotNull null
        val masterId = row.originalId ?: row.eventId
        val own = series[masterId]
        val moved = own != null && row.originalId != null
        if (row.allDay) {
            // ALL-DAY INSTANCES ARE UTC MIDNIGHTS in `CalendarContract`, END
            // exclusive: the first day is BEGIN's UTC date and the last day,
            // inclusive as `PhoneCalendarEvent` keeps it, is the millisecond before END's.
            PhoneCalendarEvent(
                title = row.title,
                notes = row.notes,
                all_day = true,
                start = utcDay(row.begin),
                end = utcDay(maxOf(row.begin, row.end - 1)),
                free = row.free,
                series = own?.series,
                original_start = if (moved) row.originalTime?.let(::utcDay).orEmpty() else "",
                moved = moved,
                phone_id = PhoneOrigins.eventId(meta.uid, row.eventId),
                calendar_key = calendar.key,
                location = row.location,
            )
        } else {
            // A TIMED INSTANCE IS A WALL CLOCK IN ITS OWN ZONE — the zone the
            // event was made in, the device's when the calendar names none or
            // one this runtime does not know. Where the rule put a moved one
            // is read in the SERIES' zone, the one the vault keys it in.
            val zone = zoneOf(row.zone, device)
            PhoneCalendarEvent(
                title = row.title,
                notes = row.notes,
                start = wallClock(row.begin, zone),
                end = wallClock(row.end, zone),
                tz = zone.id,
                free = row.free,
                series = own?.series,
                original_start = if (moved && own != null) row.originalTime?.let { wallClock(it, own.zone) }.orEmpty() else "",
                moved = moved,
                phone_id = PhoneOrigins.eventId(meta.uid, row.eventId),
                calendar_key = calendar.key,
                location = row.location,
            )
        }
    }
    return CalendarsRead(events, calendars.values.map { it.calendar }.distinctBy { it.key }, complete = true)
}

/**
 * EVERY VISIBLE CALENDAR THE MEMBER WRITES TO, by row id: its key and its titles. Empty
 * calendars are in it, so one with no event is not mistaken for gone (R-1127-9).
 */
private fun readCalendars(resolver: ContentResolver): Map<Long, CalendarRow> {
    val projection = arrayOf(
        CalendarContract.Calendars._ID,
        CalendarContract.Calendars.ACCOUNT_TYPE,
        CalendarContract.Calendars.ACCOUNT_NAME,
        SYNC_ID,
        CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
        CalendarContract.Calendars.CALENDAR_COLOR,
    )
    val selection = "${CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL} >= ${CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR} AND " +
        "${CalendarContract.Calendars.VISIBLE} = 1"
    val found = linkedMapOf<Long, CalendarRow>()
    resolver.query(CalendarContract.Calendars.CONTENT_URI, projection, selection, null, "${CalendarContract.Calendars._ID} ASC")?.use { cursor ->
        while (cursor.moveToNext()) {
            val id = cursor.getLong(0)
            // THE PLATFORM'S OWN KEY, unprefixed: Rust makes the origin and its label.
            val key = PhoneOrigins.calendarKey(cursor.getString(1), cursor.getString(2), cursor.getString(3), id)
            found[id] = CalendarRow(
                key,
                PhoneCalendar(
                    key = key,
                    source_title = cursor.getString(2).orEmpty(),
                    title = cursor.getString(4).orEmpty(),
                    color = if (cursor.isNull(5)) "" else "#%06X".format(cursor.getInt(5) and 0xFFFFFF),
                ),
            )
        }
    }
    return found
}

/**
 * THE CALENDAR AND THE iCAL UID OF EACH EVENT IN [ids], from the `Events` table (an `Instances`
 * row is not promised to carry either). `uid2445` is asked by its column name, because the
 * constant is newer than `minSdk`; a provider without the column answers the calendars alone,
 * and its events are then keyed by row id.
 */
private fun readEventMeta(resolver: ContentResolver, ids: Collection<Long>): Map<Long, EventMeta> {
    val found = mutableMapOf<Long, EventMeta>()
    for (chunk in ids.distinct().chunked(META_CHUNK)) {
        val selection = "${CalendarContract.Events._ID} IN (${chunk.joinToString(",")})"
        val withUid = arrayOf(CalendarContract.Events._ID, CalendarContract.Events.CALENDAR_ID, UID_2445)
        val cursor = runCatching { resolver.query(CalendarContract.Events.CONTENT_URI, withUid, selection, null, null) }.getOrNull()
            ?: resolver.query(CalendarContract.Events.CONTENT_URI, arrayOf(CalendarContract.Events._ID, CalendarContract.Events.CALENDAR_ID), selection, null, null)
        cursor?.use {
            while (it.moveToNext()) {
                val uid = if (it.columnCount > 2) it.getString(2) else null
                found[it.getLong(0)] = EventMeta(it.getLong(1), uid)
            }
        }
    }
    return found
}

private const val SYNC_ID: String = "_sync_id"
private const val UID_2445: String = "uid2445"
private const val META_CHUNK: Int = 400

/** One `Instances` row, as read. */
private class InstanceRow(
    val title: String,
    val notes: String,
    val allDay: Boolean,
    val begin: Long,
    val end: Long,
    val zone: String?,
    val free: Boolean,
    val eventId: Long,
    val rrule: String,
    val originalId: Long?,
    val originalTime: Long?,
    val location: String,
)

/** A series' master, and the zone its wall clocks are read in. */
private class SeriesRow(val series: PhoneCalendarSeries, val zone: TimeZone)

/**
 * THE MASTER EVENTS OF [ids], each as a [PhoneCalendarSeries]: its rule, and its own
 * first occurrence — `DTSTART`, ending `DURATION` later (a repeating event
 * carries no `DTEND`). A master with no rule, or a duration that does not
 * parse, is left out, and its occurrences import one by one.
 */
private fun readSeries(resolver: ContentResolver, ids: Set<Long>, device: TimeZone, metas: Map<Long, EventMeta>): Map<Long, SeriesRow> {
    if (ids.isEmpty()) return emptyMap()
    val projection = arrayOf(
        CalendarContract.Events._ID,
        CalendarContract.Events.RRULE,
        CalendarContract.Events.DTSTART,
        CalendarContract.Events.DTEND,
        CalendarContract.Events.DURATION,
        CalendarContract.Events.EVENT_TIMEZONE,
        CalendarContract.Events.ALL_DAY,
    )
    val selection = "${CalendarContract.Events._ID} IN (${ids.joinToString(",")})"
    val found = mutableMapOf<Long, SeriesRow>()
    resolver.query(CalendarContract.Events.CONTENT_URI, projection, selection, null, null)?.use { cursor ->
        while (cursor.moveToNext()) {
            val rule = cursor.getString(1).orEmpty()
            if (rule.isEmpty() || cursor.isNull(2)) continue
            val start = cursor.getLong(2)
            val end = if (!cursor.isNull(3)) cursor.getLong(3) else durationMs(cursor.getString(4))?.let { start + it } ?: continue
            val id = cursor.getLong(0)
            val zone = zoneOf(cursor.getString(5), device)
            val seriesId = PhoneOrigins.eventId(metas[id]?.uid, id)
            val series = if (cursor.getInt(6) == 1) {
                PhoneCalendarSeries(id = seriesId, rrule = rule, start = utcDay(start), end = utcDay(maxOf(start, end - 1)))
            } else {
                PhoneCalendarSeries(id = seriesId, rrule = rule, start = wallClock(start, zone), end = wallClock(maxOf(start, end), zone))
            }
            found[id] = SeriesRow(series, zone)
        }
    }
    return found
}

/**
 * An RFC 5545 `DURATION` in milliseconds — `P1D`, `PT1H30M`, and the `P3600S`
 * Android's provider writes — or null when it does not parse.
 */
internal fun durationMs(value: String?): Long? {
    val match = DURATION.matchEntire(value?.trim().orEmpty()) ?: return null
    if (match.groupValues.drop(2).all { it.isEmpty() }) return null
    val (sign, weeks, days, hours, minutes, seconds) = match.destructured
    val total = (weeks.toLongOrNull() ?: 0) * 7 * DAY_SECONDS + (days.toLongOrNull() ?: 0) * DAY_SECONDS +
        (hours.toLongOrNull() ?: 0) * 3_600 + (minutes.toLongOrNull() ?: 0) * 60 + (seconds.toLongOrNull() ?: 0)
    return (if (sign == "-") -total else total) * 1_000
}

private val DURATION = Regex("^([+-]?)P(?:(\\d+)W)?(?:(\\d+)D)?T?(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+)S)?$")
private const val DAY_SECONDS: Long = 86_400

private fun zoneOf(id: String?, device: TimeZone): TimeZone =
    id?.takeIf { it.isNotEmpty() && it in KNOWN_ZONES }?.let { TimeZone.getTimeZone(it) } ?: device

private val KNOWN_ZONES: Set<String> by lazy { TimeZone.getAvailableIDs().toSet() }

/** `YYYY-MM-DD` of [millis] in UTC. */
internal fun utcDay(millis: Long): String = format("yyyy-MM-dd", TimeZone.getTimeZone("UTC"), millis)

/** `YYYY-MM-DDTHH:MM:SS` of [millis] as a clock in [zone] reads it. */
internal fun wallClock(millis: Long, zone: TimeZone): String = format("yyyy-MM-dd'T'HH:mm:ss", zone, millis)

// A FRESH FORMAT EACH CALL: `SimpleDateFormat` is not thread-safe, and
// `java.time` needs API 26 where `minSdk` is 24.
private fun format(pattern: String, zone: TimeZone, millis: Long): String =
    SimpleDateFormat(pattern, Locale.US).apply { timeZone = zone }.format(Date(millis))
