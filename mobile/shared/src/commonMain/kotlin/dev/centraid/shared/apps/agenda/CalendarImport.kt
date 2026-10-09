package dev.centraid.shared.apps.agenda

import centraid.core.v1.Envelope
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.PageRequest
import centraid.core.v1.Request
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.design.copy.AgendaCopy
import dev.centraid.shared.kit.PhoneImport
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * ONE EVENT AS THE PHONE'S OWN CALENDAR HOLDS IT, read by the shell (iOS
 * EventKit, Android `CalendarContract`) after the member tapped "Import
 * calendar" and the OS asked its own permission. A recurring series arrives
 * as its occurrences in the window, each one an event.
 *
 * @property title the event's title; one with none is skipped.
 * @property allDay an all-day event: [start] and [end] are `YYYY-MM-DD`, and
 *   [end] is the LAST day, inclusive (`event_time.rs`).
 * @property start a timed event's wall clock, `YYYY-MM-DDTHH:MM:SS`, in [tz].
 * @property end a timed event's end, exclusive, in [tz].
 * @property tz the event's IANA zone; empty is the device's.
 * @property free the calendar holds it as not blocking its time.
 */
public data class PhoneEvent(
    public val title: String,
    public val notes: String = "",
    public val allDay: Boolean = false,
    public val start: String,
    public val end: String,
    public val tz: String = "",
    public val free: Boolean = false,
)

/**
 * CALENDAR → AGENDA IN ONE TAP (docs/decisions.md, "Onboarding without sample
 * data", R-ONBOARD-4).
 *
 * Agenda's day one offers the import (`AgendaHomeData.import_source`); each
 * event becomes `schedule.propose_event` in the vault's first calendar — an
 * ordinary event of the member's, no mark — free or busy as the phone's
 * calendar holds it. **A busy event that would collide with one already
 * imported is kept, as free**, rather than dropped: Agenda refuses a busy
 * overlap the member types, but an import copies a calendar whose overlaps
 * already happened, and losing an event is worse than a second free one.
 * Duplicates within the read (one title at one start) are folded.
 */
public object CalendarImport {
    /** What the vault holds of [events], and the zone a timed one without its own falls back to. */
    public suspend fun run(core: CentraidCore, events: List<PhoneEvent>, deviceTz: String): PhoneImport.Outcome {
        val calendar = firstCalendar(core) ?: return PhoneImport.Outcome(added = 0, refused = events.size)
        var added = 0
        var refused = 0
        for (event in events(events)) {
            val input = input(event, calendar, deviceTz, free = event.free)
            val made = PhoneImport.write(core, AgendaWrites.PROPOSE, input) ||
                (!event.free && PhoneImport.write(core, AgendaWrites.PROPOSE, input(event, calendar, deviceTz, free = true)))
            if (made) added += 1 else refused += 1
        }
        return PhoneImport.Outcome(added = added, refused = refused)
    }

    /** The events a read makes: titled, trimmed, one per title and start. */
    public fun events(events: List<PhoneEvent>): List<PhoneEvent> {
        val seen = mutableSetOf<String>()
        return events.mapNotNull { event ->
            val title = event.title.trim()
            if (title.isEmpty() || event.start.isEmpty() || event.end.isEmpty()) return@mapNotNull null
            if (!seen.add("${title.lowercase()}|${event.start}")) return@mapNotNull null
            event.copy(title = title, notes = event.notes.trim())
        }
    }

    /** `schedule.propose_event`'s input for one event. */
    public fun input(event: PhoneEvent, calendarId: String, deviceTz: String, free: Boolean): String {
        val fields = mutableListOf(
            "\"summary\":${PhoneImport.quote(event.title)}",
            "\"calendar_id\":${PhoneImport.quote(calendarId)}",
            "\"dtstart\":${PhoneImport.quote(event.start)}",
            "\"dtend\":${PhoneImport.quote(event.end)}",
            "\"busy\":${PhoneImport.quote(if (free) "free" else "busy")}",
        )
        val zone = event.tz.ifEmpty { deviceTz }
        when {
            event.allDay -> fields += "\"recurrence_semantics\":\"all-day\""
            zone.isNotEmpty() -> fields += "\"tz\":${PhoneImport.quote(zone)}"
            else -> fields += "\"recurrence_semantics\":\"floating\""
        }
        if (event.notes.isNotEmpty()) fields += "\"description\":${PhoneImport.quote(event.notes)}"
        return fields.joinToString(",", prefix = "{", postfix = "}")
    }

    /** The one sentence the shell shows when an import ends. */
    public fun sentence(outcome: PhoneImport.Outcome): String = when {
        outcome.added == 0 && outcome.refused == 0 -> AgendaCopy.IMPORT_CALENDAR_NONE
        outcome.added == 0 -> AgendaCopy.IMPORT_CALENDAR_FAILED
        outcome.added == 1 -> AgendaCopy.IMPORT_CALENDAR_ONE
        else -> AgendaCopy.IMPORT_CALENDAR_DONE.replace("{count}", outcome.added.toString())
    }

    /** The vault's first calendar — `Vault::found` mints a private one — read through the page door. */
    private suspend fun firstCalendar(core: CentraidCore): String? {
        val query = PageQuery(
            name = "agenda.import.calendar",
            select = listOf("calendar_id"),
            from = "schedule_calendar",
            order = PageOrder(sort_column = "calendar_id", pk_column = "calendar_id"),
        )
        val answer = core.call(Envelope(request_id = 0, request = Request(page = PageRequest(query = query, limit = 1))))
        val row = (answer as? CoreOutcome.Answered)?.value?.response?.page?.rows?.firstOrNull() ?: return null
        return row.values.firstOrNull()?.text?.takeIf { it.isNotEmpty() }
    }
}

/**
 * WHAT SWIFTUI HOLDS FOR THE CALENDAR IMPORT: the shell reads the calendar and
 * hands the events here. Writes go to the member's foreground vault, never to a
 * preview's example.
 */
public class CalendarImportBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: HomeSession? = null

    public fun attach(session: HomeSession) {
        this.session = session
    }

    /** Import [events], timed ones without a zone in [deviceTz]; [onDone] is handed the sentence. */
    public fun run(events: List<PhoneEvent>, deviceTz: String, onDone: (String) -> Unit) {
        val core = session?.shelf?.memberCore() ?: return onDone(AgendaCopy.IMPORT_CALENDAR_NO_VAULT)
        scope.launch { onDone(CalendarImport.sentence(CalendarImport.run(core, events, deviceTz))) }
    }
}
