package dev.centraid.shared.apps.agenda

import centraid.core.v1.AgendaUpcomingRequest
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.Envelope
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.PageRequest
import centraid.core.v1.Request
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.design.copy.AgendaCopy
import dev.centraid.shared.kit.PhoneImport
import dev.centraid.shared.kit.time.civilDayOf
import dev.centraid.shared.kit.time.floorDiv
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.sync.rfc3339FromEpochMillis
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * ONE EVENT AS THE PHONE'S OWN CALENDAR HOLDS IT, read by the shell (iOS
 * EventKit, Android `CalendarContract`) after the member tapped "Import
 * calendar" and the OS asked its own permission. **Every occurrence in the
 * window is one [PhoneEvent]**; an occurrence of a repeating series also
 * carries its [series], and the importer folds those back into ONE repeating
 * event.
 *
 * @property title the event's title; one with none is skipped.
 * @property allDay an all-day event: [start] and [end] are `YYYY-MM-DD`, and
 *   [end] is the LAST day, inclusive (`event_time.rs`).
 * @property start a timed event's wall clock, `YYYY-MM-DDTHH:MM:SS`, in [tz].
 * @property end a timed event's end, exclusive, in [tz].
 * @property tz the event's IANA zone; empty is the device's.
 * @property free the calendar holds it as not blocking its time.
 * @property series the repeating series this occurrence belongs to, or null.
 * @property originalStart where the series' rule puts this occurrence, in the
 *   form of [start] — not where it is now when the member moved it. Empty is
 *   [start].
 * @property moved the member changed this one occurrence (iOS `isDetached`,
 *   an Android exception event): its own times and title are an override.
 */
public data class PhoneEvent(
    public val title: String,
    public val notes: String = "",
    public val allDay: Boolean = false,
    public val start: String,
    public val end: String,
    public val tz: String = "",
    public val free: Boolean = false,
    public val series: PhoneSeries? = null,
    public val originalStart: String = "",
    public val moved: Boolean = false,
)

/**
 * A REPEATING SERIES AS THE PHONE HOLDS IT. Its times are the series' OWN
 * first occurrence, in the form of the occurrences' [PhoneEvent.start] and
 * [PhoneEvent.end] — never the first one in the window, which would move a
 * `COUNT` rule's last occurrence.
 *
 * @property id the phone's own id for the series: what groups its occurrences.
 * @property rrule its RFC 5545 rule, without the `RRULE:` prefix.
 */
public data class PhoneSeries(
    public val id: String,
    public val rrule: String,
    public val start: String,
    public val end: String,
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
 *
 * **A REPEATING SERIES STAYS ONE SERIES**, its rule kept, so it goes on
 * repeating past the window and editing "all events" edits all of them. The
 * vault's own expansion is then held against what the phone shows in the
 * window: an occurrence the vault expands and the phone does not show was
 * cancelled there, and becomes a skip; one the member moved becomes an
 * override (`schedule.edit_event_occurrence`); one the phone shows and the
 * vault does not expand is written on its own, so nothing is lost where the
 * two readings of a rule differ. **A rule the vault refuses** — `BYSETPOS`,
 * a `BYDAY` list or a `BYMONTHDAY` list, for instance (`rrule.rs` holds the
 * whole list) — falls back to the occurrences in the window, each its own
 * event: a refused rule kept would expand to nothing, and a reworded one
 * would repeat on the wrong days. What the vault takes of a monthly rule
 * (#1119, R-1119-1) is ONE positional `BYDAY` (`2MO`, `-1FR`; first to fourth
 * or last) or ONE `BYMONTHDAY` (`1`..`31` or `-1`), with RFC 5545's meaning —
 * a month without that day has no occurrence — so [rule] keeps both.
 *
 * **The one loss**: an occurrence the member moved from inside the window to
 * outside it is not in the phone's answer at all, so it reads as cancelled
 * and becomes a skip. The phone's read cannot tell the two apart.
 */
public object CalendarImport {
    /** THE WINDOW READ: a week back, so the day-one Agenda has its recent past, and two months on. */
    public const val DAYS_BACK: Long = 7
    public const val DAYS_ON: Long = 62
    private const val DAY_MS: Long = 24L * 60 * 60 * 1000

    /** The window's first instant, epoch milliseconds, for a read made at [now]. */
    public fun windowStart(now: Long): Long = now - DAYS_BACK * DAY_MS

    /** The window's end, exclusive, for a read made at [now]. */
    public fun windowEnd(now: Long): Long = now + DAYS_ON * DAY_MS

    /**
     * What the vault holds of [events] — read at [now], over [windowStart] to
     * [windowEnd] — and the zone a timed one without its own falls back to.
     */
    public suspend fun run(core: CentraidCore, events: List<PhoneEvent>, deviceTz: String, now: Long): PhoneImport.Outcome {
        val calendar = firstCalendar(core) ?: return PhoneImport.Outcome(added = 0, refused = events.size)
        val plan = plan(events)
        var added = 0
        var refused = 0
        val tally = { made: Boolean -> if (made) added += 1 else refused += 1 }
        for (event in plan.singles) tally(single(core, event, calendar, deviceTz))
        for (series in plan.series) {
            val eventId = propose(core, series.event, calendar, deviceTz, series.rrule)
            if (eventId == null) {
                for (event in events(series.occurrences)) tally(single(core, event, calendar, deviceTz))
                continue
            }
            added += 1
            // AN UNREAD EXPANSION WRITES NOTHING MORE: without it every
            // occurrence would look like a stray and land twice.
            val upcoming = upcoming(core, eventId, deviceTz, now) ?: continue
            for (edit in reconcile(series, eventId, upcoming, now, deviceTz)) {
                if (PhoneImport.write(core, AgendaWrites.OCCURRENCE, edit.input)) continue
                // A REFUSED SKIP leaves that occurrence as the rule has it; a
                // refused override keeps the moved occurrence as its own event.
                val fallback = edit.fallback
                if (fallback == null) refused += 1 else tally(single(core, fallback, calendar, deviceTz))
            }
            for (event in strays(series, upcoming, now)) tally(single(core, event, calendar, deviceTz))
        }
        return PhoneImport.Outcome(added = added, refused = refused)
    }

    /** One series to import: its own event, its rule, and its occurrences in the window. */
    public data class Series(
        public val event: PhoneEvent,
        public val rrule: String,
        public val occurrences: List<PhoneEvent>,
    )

    /** What a read becomes: the series it holds, and every other event once. */
    public data class Plan(
        public val series: List<Series>,
        public val singles: List<PhoneEvent>,
    )

    /**
     * FOLD A READ. Occurrences sharing a series id become one [Series], whose
     * own event takes its title, notes and availability from an occurrence the
     * member did not move; everything else is [events].
     */
    public fun plan(events: List<PhoneEvent>): Plan {
        val grouped = linkedMapOf<String, MutableList<PhoneEvent>>()
        val singles = mutableListOf<PhoneEvent>()
        for (event in events) {
            val series = event.series
            val rule = series?.let { rule(it.rrule, it.start) }.orEmpty()
            if (series == null || rule.isEmpty() || series.start.isEmpty() || series.end.isEmpty()) {
                singles += event
            } else {
                grouped.getOrPut(series.id) { mutableListOf() } += event
            }
        }
        val series = grouped.values.mapNotNull { occurrences ->
            val pattern = occurrences.firstOrNull { !it.moved } ?: occurrences.first()
            val own = pattern.series ?: return@mapNotNull null
            val title = pattern.title.trim()
            if (title.isEmpty()) return@mapNotNull null
            Series(
                event = pattern.copy(
                    title = title,
                    notes = pattern.notes.trim(),
                    start = own.start,
                    end = own.end,
                    series = null,
                    originalStart = "",
                    moved = false,
                ),
                rrule = rule(own.rrule, own.start),
                occurrences = occurrences,
            )
        }
        return Plan(series = series, singles = events(singles))
    }

    /** The events a read makes: titled, trimmed, one per title and start. */
    public fun events(events: List<PhoneEvent>): List<PhoneEvent> {
        val seen = mutableSetOf<String>()
        return events.mapNotNull { event ->
            val title = event.title.trim()
            if (title.isEmpty() || event.start.isEmpty() || event.end.isEmpty()) return@mapNotNull null
            if (!seen.add("${title.lowercase()}|${event.start}")) return@mapNotNull null
            event.copy(title = title, notes = event.notes.trim(), series = null, originalStart = "", moved = false)
        }
    }

    /**
     * THE RULE AS THE VAULT TAKES IT, or empty for none. The `RRULE:` prefix
     * goes, and a part that only restates the anchor goes with it — a yearly
     * rule's `BYMONTHDAY` on the first occurrence's own day and its `BYMONTH`
     * on its own month, a `WKST` that moves no day — because EventKit and
     * Google write those out and the vault, which steps from the anchor,
     * refuses them. **A monthly rule's `BYMONTHDAY` and positional `BYDAY`
     * stay** (#1119): the vault expands them, and dropping a `BYMONTHDAY=31`
     * would turn "the 31st" into "the last day" in the short months. Any
     * other part stays too, and a rule the vault cannot honour is refused
     * there.
     */
    public fun rule(rrule: String, start: String): String {
        val text = rrule.trim().removePrefix("RRULE:").trim().trimEnd(';')
        if (text.isEmpty() || start.length < 10) return ""
        val parts = text.split(';').filter { it.isNotBlank() }.map { it.trim() }
        val freq = parts.firstOrNull { it.startsWith("FREQ=") }?.removePrefix("FREQ=") ?: return ""
        val day = start.substring(8, 10).trimStart('0')
        val month = start.substring(5, 7).trimStart('0')
        // `WKST` only moves a WEEKLY rule's `BYDAY` days when it steps more
        // than one week; anywhere else it changes nothing, and iOS writes it
        // on every rule of a Monday-first phone.
        val interval = parts.firstOrNull { it.startsWith("INTERVAL=") }?.removePrefix("INTERVAL=")?.toIntOrNull() ?: 1
        val weekStartMatters = freq == "WEEKLY" && interval > 1 && parts.any { it.startsWith("BYDAY=") }
        return parts.filterNot { part ->
            freq == "YEARLY" && part == "BYMONTHDAY=$day" ||
                freq == "YEARLY" && part == "BYMONTH=$month" ||
                !weekStartMatters && part.startsWith("WKST=")
        }.joinToString(";")
    }

    /** `schedule.propose_event`'s input for one event, repeating by [rrule] when it is not empty. */
    public fun input(event: PhoneEvent, calendarId: String, deviceTz: String, free: Boolean, rrule: String = ""): String {
        val fields = mutableListOf(
            "\"summary\":${PhoneImport.quote(event.title)}",
            "\"calendar_id\":${PhoneImport.quote(calendarId)}",
            "\"dtstart\":${PhoneImport.quote(event.start)}",
            "\"dtend\":${PhoneImport.quote(event.end)}",
            "\"busy\":${PhoneImport.quote(if (free) "free" else "busy")}",
        )
        fields += when (val zone = zoneOf(event, deviceTz)) {
            null -> "\"recurrence_semantics\":${PhoneImport.quote(if (event.allDay) "all-day" else "floating")}"
            else -> "\"tz\":${PhoneImport.quote(zone)}"
        }
        if (event.notes.isNotEmpty()) fields += "\"description\":${PhoneImport.quote(event.notes)}"
        if (rrule.isNotEmpty()) fields += "\"rrule\":${PhoneImport.quote(rrule)}"
        return fields.joinToString(",", prefix = "{", postfix = "}")
    }

    /**
     * THE EXCEPTIONS A SERIES NEEDS, as `schedule.edit_event_occurrence`
     * inputs, from the vault's own expansion ([upcoming]: the series' rows of
     * `agenda.upcoming`, `original_start_local` to the row) held against the
     * phone's occurrences:
     *
     * - **A skip** for an occurrence the vault expands and the phone does not
     *   show — the member cancelled it there. Only inside the window with a
     *   day's margin each side: the two ends are where a phone's "overlaps the
     *   window" and the vault's "starts in it" disagree, and a skip written on
     *   that disagreement would delete a real occurrence.
     * - **An override** for an occurrence the member moved, keyed on where
     *   the rule put it, carrying its own times and, where they differ from
     *   the series', its title and notes.
     */
    public fun reconcile(
        series: Series,
        eventId: String,
        upcoming: Map<String, String>,
        now: Long,
        deviceTz: String,
    ): List<OccurrenceEdit> {
        val allDay = series.event.allDay
        val shown = series.occurrences.map { key(it.originalStart.ifEmpty { it.start }, allDay) }.toSet()
        val (first, last) = inner(now)
        val writes = mutableListOf<OccurrenceEdit>()
        for ((key, local) in upcoming) {
            if (key in shown || key.take(10) < first || key.take(10) > last) continue
            writes += OccurrenceEdit(occurrence(eventId, local, "skip"), fallback = null)
        }
        for (moved in series.occurrences.filter { it.moved }) {
            // KEYED ON THE VAULT'S OWN SPELLING when the window holds the
            // original; otherwise — moved in from past the window — on the
            // phone's, which the vault checks against the series itself.
            val original = key(moved.originalStart.ifEmpty { moved.start }, allDay)
            val local = upcoming[original] ?: original
            val fields = mutableListOf(
                "\"dtstart\":${PhoneImport.quote(moved.start)}",
                "\"dtend\":${PhoneImport.quote(moved.end)}",
            )
            // THE ZONE THE SERIES WAS PROPOSED IN: an occurrence with none of
            // its own is the device's, as the series was, never a bare clock
            // the vault would read as UTC.
            fields += when (val zone = zoneOf(moved, deviceTz)) {
                null -> "\"recurrence_semantics\":${PhoneImport.quote(if (moved.allDay) "all-day" else "floating")}"
                else -> "\"tz\":${PhoneImport.quote(zone)}"
            }
            val title = moved.title.trim()
            if (title.isNotEmpty() && title != series.event.title) fields += "\"summary\":${PhoneImport.quote(title)}"
            val notes = moved.notes.trim()
            if (notes != series.event.notes) fields += "\"description\":${PhoneImport.quote(notes)}"
            writes += OccurrenceEdit(occurrence(eventId, local, "override", fields), fallback = events(listOf(moved)).firstOrNull())
        }
        return writes
    }

    /**
     * ONE `schedule.edit_event_occurrence` INPUT, and what to write instead
     * when the vault refuses it: nothing for a skip, the moved occurrence as
     * its own event for an override.
     */
    public data class OccurrenceEdit(
        public val input: String,
        public val fallback: PhoneEvent?,
    )

    /**
     * THE OCCURRENCES THE SERIES DOES NOT CARRY: one the phone shows inside
     * the window whose original start the vault's expansion lacks — the two
     * readings of the rule differ there — written as an event of its own, so
     * the member's calendar loses nothing. A moved occurrence is never one:
     * [reconcile] overrides it, and writes it on its own only if refused.
     */
    public fun strays(series: Series, upcoming: Map<String, String>, now: Long): List<PhoneEvent> {
        val allDay = series.event.allDay
        val (first, last) = inner(now)
        return events(
            series.occurrences.filter { occurrence ->
                val key = key(occurrence.originalStart.ifEmpty { occurrence.start }, allDay)
                !occurrence.moved && key !in upcoming && key.take(10) >= first && key.take(10) <= last
            },
        )
    }

    private fun occurrence(eventId: String, local: String, action: String, fields: List<String> = emptyList()): String =
        (
            listOf(
                "\"event_id\":${PhoneImport.quote(eventId)}",
                "\"original_start_local\":${PhoneImport.quote(local)}",
                "\"scope\":\"occurrence\"",
                "\"action\":${PhoneImport.quote(action)}",
            ) + fields
            ).joinToString(",", prefix = "{", postfix = "}")

    /**
     * THE KEY AN OCCURRENCE IS MATCHED ON: the series-local wall clock to the
     * second, or the day for an all-day series — the shape of the vault's
     * `original_start_local` (`expansion.rs`).
     */
    internal fun key(start: String, allDay: Boolean): String = if (allDay) start.take(10) else start.take(19)

    /** The window's days with a day's margin each side, `YYYY-MM-DD`, inclusive. */
    private fun inner(now: Long): Pair<String, String> = Pair(
        civilDayOf(floorDiv(windowStart(now), DAY_MS) + 1),
        civilDayOf(floorDiv(windowEnd(now), DAY_MS) - 1),
    )

    /** An event's zone — its own, else the device's — or null for an all-day one or none at all. */
    private fun zoneOf(event: PhoneEvent, deviceTz: String): String? =
        if (event.allDay) null else event.tz.ifEmpty { deviceTz }.ifEmpty { null }

    /** One event on its own: busy as the phone holds it, else kept free. */
    private suspend fun single(core: CentraidCore, event: PhoneEvent, calendar: String, deviceTz: String): Boolean =
        propose(core, event, calendar, deviceTz, rrule = "") != null

    /** Propose [event], busy then free; the new `event_id`, or null when the vault refused both. */
    private suspend fun propose(core: CentraidCore, event: PhoneEvent, calendar: String, deviceTz: String, rrule: String): String? {
        val output = PhoneImport.executed(core, AgendaWrites.PROPOSE, input(event, calendar, deviceTz, free = event.free, rrule = rrule))
            ?: if (event.free) null else PhoneImport.executed(core, AgendaWrites.PROPOSE, input(event, calendar, deviceTz, free = true, rrule = rrule))
        return output?.let { EVENT_ID.find(it)?.groupValues?.getOrNull(1).orEmpty() }
    }

    /**
     * The series' occurrences as the vault expands them over the window, by
     * key, each to its exact `original_start_local`; null when the read fails
     * — the expansion cap, a refusal, an unparsed `event_id` — which writes no
     * exception and no stray rather than a wrong one.
     */
    private suspend fun upcoming(core: CentraidCore, eventId: String, deviceTz: String, now: Long): Map<String, String>? {
        if (eventId.isEmpty()) return null
        val query = AppQueryRequest(
            agenda_upcoming = AgendaUpcomingRequest(
                from = rfc3339FromEpochMillis(windowStart(now)),
                to = rfc3339FromEpochMillis(windowEnd(now)),
                tz = deviceTz,
            ),
        )
        val answer = core.call(Envelope(request_id = 0, request = Request(app_query = query)))
        val events = (answer as? CoreOutcome.Answered)?.value?.response?.app_query?.agenda_upcoming?.events ?: return null
        return events.filter { it.event_id == eventId }
            .mapNotNull { it.original_start_local?.takeIf(String::isNotEmpty) }
            .associateBy { local -> key(local, local.length == 10) }
    }

    /** The one sentence the shell shows when an import ends. */
    public fun sentence(outcome: PhoneImport.Outcome): String = when {
        outcome.added == 0 && outcome.refused == 0 -> AgendaCopy.IMPORT_CALENDAR_NONE
        outcome.added == 0 -> AgendaCopy.IMPORT_CALENDAR_FAILED
        outcome.added == 1 -> AgendaCopy.IMPORT_CALENDAR_ONE
        else -> AgendaCopy.IMPORT_CALENDAR_DONE.replace("{count}", outcome.added.toString())
    }

    private val EVENT_ID = Regex("\"event_id\"\\s*:\\s*\"([^\"]+)\"")

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
 * hands the events here. Writes go to the member's foreground vault.
 */
public class CalendarImportBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: HomeSession? = null

    public fun attach(session: HomeSession) {
        this.session = session
    }

    /**
     * Import [events], read at [now] (epoch milliseconds), timed ones without
     * a zone in [deviceTz]; [onDone] is handed the sentence.
     */
    public fun run(events: List<PhoneEvent>, deviceTz: String, now: Long, onDone: (String) -> Unit) {
        val core = session?.shelf?.core() ?: return onDone(AgendaCopy.IMPORT_CALENDAR_NO_VAULT)
        scope.launch { onDone(CalendarImport.sentence(CalendarImport.run(core, events, deviceTz, now))) }
    }
}
