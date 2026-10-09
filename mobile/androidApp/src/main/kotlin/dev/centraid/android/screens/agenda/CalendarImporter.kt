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
 * **INTO THE MEMBER'S VAULT, NEVER A PREVIEW'S**: `Shelf.memberCore`, and the
 * shell provides no import door while a preview is open at all. Agenda
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
): () -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val currentSession by rememberUpdatedState(session)
    val currentStatus by rememberUpdatedState(onStatus)
    // ONE IMPORT AT A TIME: a second tap while the first writes would propose
    // every event twice, and the second copy would land as a free duplicate.
    var running by remember { mutableStateOf(false) }

    fun run() {
        if (running) return
        val core = currentSession?.shelf?.memberCore()
        if (core == null) {
            currentStatus(AgendaCopy.IMPORT_CALENDAR_NO_VAULT, false)
            return
        }
        running = true
        currentStatus(AgendaCopy.IMPORT_CALENDAR_RUNNING, true)
        scope.launch {
            // OFF THE MAIN THREAD, both halves: the calendar is a content
            // provider query and each event is a core call.
            val sentence = withContext(Dispatchers.IO) {
                val events = runCatching { readEvents(context.contentResolver) }.getOrDefault(emptyList())
                CalendarImport.sentence(CalendarImport.run(core, events, TimeZone.getDefault().id))
            }
            running = false
            currentStatus(sentence, false)
        }
    }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) run() else currentStatus(AgendaCopy.IMPORT_CALENDAR_DENIED, false)
    }
    return remember(launcher) {
        {
            if (granted(context)) run() else launcher.launch(Manifest.permission.READ_CALENDAR)
        }
    }
}

private fun granted(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED

/** THE WINDOW READ: a week back, so the day-one Agenda has its recent past, and two months on. */
private const val DAYS_BACK: Long = 7
private const val DAYS_ON: Long = 62
private const val DAY_MS: Long = 24L * 60 * 60 * 1000

/**
 * THE PHONE'S CALENDAR, ONE [PhoneEvent] PER OCCURRENCE: `Instances` over the
 * window, so a recurring series arrives already expanded and each occurrence
 * is its own event. A cancelled occurrence ([CalendarContract.Events.STATUS_CANCELED])
 * is skipped — the member was told it is not happening.
 */
internal fun readEvents(resolver: ContentResolver, now: Long = System.currentTimeMillis()): List<PhoneEvent> {
    val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also {
        ContentUris.appendId(it, now - DAYS_BACK * DAY_MS)
        ContentUris.appendId(it, now + DAYS_ON * DAY_MS)
    }.build()
    val projection = arrayOf(
        CalendarContract.Instances.TITLE,
        CalendarContract.Instances.DESCRIPTION,
        CalendarContract.Instances.ALL_DAY,
        CalendarContract.Instances.BEGIN,
        CalendarContract.Instances.END,
        CalendarContract.Instances.EVENT_TIMEZONE,
        CalendarContract.Instances.AVAILABILITY,
    )
    // ONLY CALENDARS THE MEMBER WRITES TO, never a cancelled instance: a
    // subscribed holiday calendar is nobody's own events, and a contacts'
    // birthdays calendar would copy what Contacts → People brought in.
    val selection = "(${CalendarContract.Instances.STATUS} IS NULL OR " +
        "${CalendarContract.Instances.STATUS} != ${CalendarContract.Events.STATUS_CANCELED}) AND " +
        "${CalendarContract.Instances.CALENDAR_ACCESS_LEVEL} >= ${CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR}"
    val device = TimeZone.getDefault()
    val events = mutableListOf<PhoneEvent>()
    resolver.query(uri, projection, selection, null, "${CalendarContract.Instances.BEGIN} ASC")?.use { cursor ->
        while (cursor.moveToNext()) {
            val begin = cursor.getLong(3)
            val end = maxOf(begin, cursor.getLong(4))
            val free = !cursor.isNull(6) && cursor.getInt(6) == CalendarContract.Events.AVAILABILITY_FREE
            val title = cursor.getString(0).orEmpty()
            val notes = cursor.getString(1).orEmpty()
            events += if (cursor.getInt(2) == 1) {
                // ALL-DAY INSTANCES ARE UTC MIDNIGHTS in `CalendarContract`,
                // END exclusive: the first day is BEGIN's UTC date and the last
                // day, inclusive as `PhoneEvent` keeps it, is the millisecond
                // before END's.
                PhoneEvent(
                    title = title,
                    notes = notes,
                    allDay = true,
                    start = utcDay(begin),
                    end = utcDay(maxOf(begin, end - 1)),
                    free = free,
                )
            } else {
                // A TIMED INSTANCE IS A WALL CLOCK IN ITS OWN ZONE — the zone
                // the event was made in, the device's when the calendar names
                // none or one this runtime does not know.
                val zone = zoneOf(cursor.getString(5), device)
                PhoneEvent(
                    title = title,
                    notes = notes,
                    start = wallClock(begin, zone),
                    end = wallClock(end, zone),
                    tz = zone.id,
                    free = free,
                )
            }
        }
    }
    return events
}

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
