package dev.centraid.android.screens.agenda

import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import dev.centraid.design.copy.AgendaCopy
import dev.centraid.shared.apps.agenda.CalendarImport
import dev.centraid.shared.apps.agenda.PhoneEvent
import dev.centraid.shared.apps.agenda.PhoneSeries
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * CALENDAR → AGENDA, ANDROID'S HALF (docs/decisions.md, "Onboarding without
 * sample data"): the permission, the phone's calendar, and the hand-off to
 * [CalendarImport], which writes the events.
 *
 * **THE PERMISSION IS ASKED AT THE TAP**, never at launch: Agenda's day one
 * draws "Import calendar" (`AgendaHomeData.import_source`), and the system's
 * dialog is the answer to that tap. A grant reads the calendar; a refusal —
 * including the one the system returns at once after "don't ask again" — is
 * [AgendaCopy.IMPORT_CALENDAR_DENIED], which names Settings.
 *
 * **INTO THE MEMBER'S FOREGROUND VAULT** (`Shelf.core`). Agenda
 * re-reads by itself — every event lands through the change stream.
 *
 * [onStatus] is handed each sentence: [AgendaCopy.IMPORT_CALENDAR_RUNNING]
 * while it runs (`holds` true: it stays until the outcome replaces it), then
 * the outcome's one sentence.
 */
@Composable
public fun rememberCalendarImport(
    session: HomeSession?,
    onStatus: (sentence: String, holds: Boolean) -> Unit,
): (after: ((String?) -> Unit)?) -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val currentSession by rememberUpdatedState(session)
    val currentStatus by rememberUpdatedState(onStatus)
    // ONE IMPORT AT A TIME: a second tap while the first writes would propose
    // every event twice, and the second copy would land as a free duplicate.
    var running by remember { mutableStateOf(false) }
    // A MADE VAULT'S CHAIN waits on this import (R-ONBOARD-8): its outcome
    // goes to [after] instead of the banner, and a refusal is null.
    var pending by remember { mutableStateOf<((String?) -> Unit)?>(null) }

    fun finish(after: ((String?) -> Unit)?, sentence: String) {
        if (after != null) after(sentence) else currentStatus(sentence, false)
    }

    fun run(after: ((String?) -> Unit)?) {
        if (running) {
            after?.invoke(null)
            return
        }
        val core = currentSession?.shelf?.core()
        if (core == null) {
            finish(after, AgendaCopy.IMPORT_CALENDAR_NO_VAULT)
            return
        }
        running = true
        currentStatus(AgendaCopy.IMPORT_CALENDAR_RUNNING, true)
        scope.launch {
            // OFF THE MAIN THREAD, both halves: the calendar is a content
            // provider query and each event is a core call.
            val sentence = withContext(Dispatchers.IO) {
                val now = System.currentTimeMillis()
                val events = runCatching { readEvents(context.contentResolver, now) }.getOrDefault(emptyList())
                CalendarImport.sentence(CalendarImport.run(core, events, TimeZone.getDefault().id, now))
            }
            running = false
            finish(after, sentence)
        }
    }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val after = pending
        pending = null
        when {
            granted -> run(after)
            after != null -> after(null)
            else -> currentStatus(AgendaCopy.IMPORT_CALENDAR_DENIED, false)
        }
    }
    return remember(launcher) {
        { after ->
            if (granted(context)) {
                run(after)
            } else {
                pending = after
                launcher.launch(Manifest.permission.READ_CALENDAR)
            }
        }
    }
}

private fun granted(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED

/**
 * THE PHONE'S CALENDAR, ONE [PhoneEvent] PER OCCURRENCE: `Instances` over
 * [CalendarImport]'s window, so a recurring series arrives expanded. An
 * occurrence of a series also carries its [PhoneSeries] — the master event's
 * rule and its own first occurrence — and, for an exception event (one the
 * member moved: `ORIGINAL_ID` names its series), where the rule put it; the
 * shared importer folds them back into one series. A cancelled occurrence
 * ([CalendarContract.Events.STATUS_CANCELED], or an `EXDATE`) is not read, which is
 * how the importer knows to skip it.
 */
internal fun readEvents(resolver: ContentResolver, now: Long): List<PhoneEvent> {
    val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also {
        ContentUris.appendId(it, CalendarImport.windowStart(now))
        ContentUris.appendId(it, CalendarImport.windowEnd(now))
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
            )
        }
    }
    val masterIds = rows.mapNotNull { row -> row.originalId ?: row.eventId.takeIf { row.rrule.isNotEmpty() } }.toSet()
    val series = readSeries(resolver, masterIds, device)
    return rows.map { row ->
        val masterId = row.originalId ?: row.eventId
        val own = series[masterId]
        val moved = own != null && row.originalId != null
        if (row.allDay) {
            // ALL-DAY INSTANCES ARE UTC MIDNIGHTS in `CalendarContract`, END
            // exclusive: the first day is BEGIN's UTC date and the last day,
            // inclusive as `PhoneEvent` keeps it, is the millisecond before END's.
            PhoneEvent(
                title = row.title,
                notes = row.notes,
                allDay = true,
                start = utcDay(row.begin),
                end = utcDay(maxOf(row.begin, row.end - 1)),
                free = row.free,
                series = own?.series,
                originalStart = if (moved) row.originalTime?.let(::utcDay).orEmpty() else "",
                moved = moved,
            )
        } else {
            // A TIMED INSTANCE IS A WALL CLOCK IN ITS OWN ZONE — the zone the
            // event was made in, the device's when the calendar names none or
            // one this runtime does not know. Where the rule put a moved one
            // is read in the SERIES' zone, the one the vault keys it in.
            val zone = zoneOf(row.zone, device)
            PhoneEvent(
                title = row.title,
                notes = row.notes,
                start = wallClock(row.begin, zone),
                end = wallClock(row.end, zone),
                tz = zone.id,
                free = row.free,
                series = own?.series,
                originalStart = if (moved && own != null) row.originalTime?.let { wallClock(it, own.zone) }.orEmpty() else "",
                moved = moved,
            )
        }
    }
}

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
)

/** A series' master, and the zone its wall clocks are read in. */
private class SeriesRow(val series: PhoneSeries, val zone: TimeZone)

/**
 * THE MASTER EVENTS OF [ids], each as a [PhoneSeries]: its rule, and its own
 * first occurrence — `DTSTART`, ending `DURATION` later (a repeating event
 * carries no `DTEND`). A master with no rule, or a duration that does not
 * parse, is left out, and its occurrences import one by one.
 */
private fun readSeries(resolver: ContentResolver, ids: Set<Long>, device: TimeZone): Map<Long, SeriesRow> {
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
            val series = if (cursor.getInt(6) == 1) {
                PhoneSeries(id = id.toString(), rrule = rule, start = utcDay(start), end = utcDay(maxOf(start, end - 1)))
            } else {
                PhoneSeries(id = id.toString(), rrule = rule, start = wallClock(start, zone), end = wallClock(maxOf(start, end), zone))
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
