package dev.centraid.shared.apps.agenda

import dev.centraid.core.CentraidCore
import dev.centraid.design.copy.AgendaCopy
import dev.centraid.shared.kit.PhoneImport
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.kit.time.civilDayOf
import dev.centraid.shared.kit.time.floorDiv
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.sync.phone.PhoneDevice
import dev.centraid.shared.sync.phone.PhoneFields
import dev.centraid.shared.sync.phone.PhoneIds
import dev.centraid.shared.sync.phone.PhoneOriginRef
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
 * @property phoneId the phone's most durable id for the event, kind-prefixed (`uid:` an iCal
 *   UID, `local:` a device-scoped id; R-1127-10). An occurrence of a [series] is followed by the
 *   series' id and ignores this one; an event with no valid id is skipped.
 * @property origin the calendar it was read in (its id, kind-prefixed), or empty for "this
 *   phone's calendars" (R-1127-9).
 * @property originLabel what the member calls that calendar ("Work (Google)"); empty shows the id.
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
    public val phoneId: String = "",
    public val origin: String = "",
    public val originLabel: String = "",
)

/**
 * A REPEATING SERIES AS THE PHONE HOLDS IT. Its times are the series' OWN
 * first occurrence, in the form of the occurrences' [PhoneEvent.start] and
 * [PhoneEvent.end] — never the first one in the window, which would move a
 * `COUNT` rule's last occurrence.
 *
 * @property id the phone's own id for the series, kind-prefixed (the series' iCal UID where the
 *   provider fills it: R-1127-10): what groups its occurrences and what the series is followed by.
 * @property rrule its RFC 5545 rule, without the `RRULE:` prefix.
 */
public data class PhoneSeries(
    public val id: String,
    public val rrule: String,
    public val start: String,
    public val end: String,
)

/**
 * CALENDAR → AGENDA, FOLLOWED (docs/decisions.md, "Onboarding without sample data",
 * R-ONBOARD-4; #1127; #1135).
 *
 * Agenda's day one offers the import (`AgendaHomeData.import_source`); the shell reads the
 * calendars once the OS has said yes and hands the events here. [run] sends each calendar's
 * records to the vault in ONE command, `follow.calendar`, and **the vault does the merge**: a
 * field the member never changed follows the phone, one they changed stands, an event the vault
 * does not know is matched by title and start to one of the member's own before one is added,
 * and one gone from a complete read goes to the trash if the member never edited it. The phone
 * sends records; it keeps no fingerprint and no link, and writes nothing else.
 *
 * **A REPEATING SERIES IS ONE RECORD**, its rule kept, so it goes on repeating past the window
 * and editing "all events" edits all of them. The phone shows only the occurrences in a window
 * and has no rule engine, so the record states what it SEES (`overrides`: the days it showed as
 * the rule has them, and the ones the member moved, over the window) and the vault, which
 * expands the rule, works out which days were skipped. **A rule the vault cannot expand** is
 * kept as the phone wrote it and the event is flagged, so it shows at its anchor rather than
 * vanishing; no occurrence-by-occurrence fallback is carried (R-1135-4-7).
 *
 * **The one loss**: an occurrence the member moved from inside the window to outside it is not
 * in the phone's answer at all, so it reads as cancelled and becomes a skip. The phone's read
 * cannot tell the two apart.
 */
public object CalendarImport {
    /** THE WINDOW READ: a week back, so the day-one Agenda has its recent past, and two months on. */
    public const val DAYS_BACK: Long = 7
    public const val DAYS_ON: Long = 62
    private const val DAY_MS: Long = 24L * 60 * 60 * 1000
    private const val DAY: Int = 10

    /** The window's first instant, epoch milliseconds, for a read made at [now]. */
    public fun windowStart(now: Long): Long = now - DAYS_BACK * DAY_MS

    /** The window's end, exclusive, for a read made at [now]. */
    public fun windowEnd(now: Long): Long = now + DAYS_ON * DAY_MS

    /** What one pass did. [addAccount] is the R-1127-8 condition: the phone returned no calendars at all. */
    public data class Outcome(
        public val added: Int,
        public val refused: Int,
        public val updated: Int = 0,
        public val trashed: Int = 0,
        public val addAccount: Boolean = false,
    )

    /**
     * A CALENDAR AS THE MEMBER KNOWS IT. The origin is `calendar:<id>` (R-1127-10), labelled
     * "{source}: {calendar}" ("iCloud: Home", "Gmail: Work"); a calendar named for its source, or a
     * source with no name, is just the one that says something.
     */
    public fun calendar(id: String, sourceTitle: String, calendarTitle: String): PhoneOriginRef {
        val source = PhoneFields.squash(sourceTitle)
        val title = PhoneFields.squash(calendarTitle)
        val label = when {
            source.isEmpty() && title.isEmpty() -> AgendaCopy.IMPORT_ORIGIN_THIS_PHONE
            source.isEmpty() -> title
            title.isEmpty() || title == source -> source
            else -> "$source: $title"
        }
        return PhoneOriginRef("calendar:$id", label)
    }

    /** The origin of an event that names none: this phone's own calendars. */
    public const val DEFAULT_ORIGIN: String = "local:this-phone"

    /** One series to import: its own event, its rule, and its occurrences in the window. */
    public data class Series(
        public val id: String,
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
                id = own.id,
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
        return Plan(series = series, singles = singles.mapNotNull(::tidy))
    }

    /** An event with its title and notes trimmed, or null when it has no title or no times. */
    private fun tidy(event: PhoneEvent): PhoneEvent? {
        val title = event.title.trim()
        if (title.isEmpty() || event.start.isEmpty() || event.end.isEmpty()) return null
        return event.copy(title = title, notes = event.notes.trim(), series = null, originalStart = "", moved = false)
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

    /**
     * THE KEY AN OCCURRENCE IS MATCHED ON: the series-local wall clock to the second, or the day
     * for an all-day series — the shape of the vault's `original_start` (`event.rs`).
     */
    internal fun key(start: String, allDay: Boolean): String = if (allDay) start.take(DAY) else start.take(19)

    /** The window the vault holds the phone's word against: a day's margin each side, as UTC instants. */
    internal fun observed(now: Long): Pair<String, String> = Pair(
        rfc3339FromEpochMillis((floorDiv(windowStart(now), DAY_MS) + 1) * DAY_MS),
        rfc3339FromEpochMillis((floorDiv(windowEnd(now), DAY_MS) - 1) * DAY_MS),
    )

    /** An event's zone — its own, else the device's — or null for an all-day one or none at all. */
    internal fun zoneOf(event: PhoneEvent, deviceTz: String): String? =
        if (event.allDay) null else event.tz.ifEmpty { deviceTz }.ifEmpty { null }

    /** ONE EVENT, as `follow.calendar` is told of it: an external id, and the fields the phone owns. */
    internal data class EventRecord(val phoneId: String, val origin: String, val fields: String)

    /**
     * WHAT ONE READ OF THE CALENDARS SENDS: the events, one record each, in the calendars they were
     * read in, and every calendar present (even one with no event in it).
     *
     * @property complete false for a read that may have missed events: the vault then trashes nothing.
     */
    internal data class CalendarBatch(
        val complete: Boolean,
        val origins: List<PhoneOriginRef>,
        val records: List<EventRecord>,
    )

    /**
     * A READ OF THE CALENDARS AS A BATCH. A repeating series is ONE record keyed by its id, and every
     * other event one record keyed by its own; an id that names no kind skips the event.
     */
    internal fun batch(
        events: List<PhoneEvent>,
        origins: List<PhoneOriginRef> = emptyList(),
        complete: Boolean = true,
        now: Long,
        deviceTz: String,
    ): CalendarBatch {
        val plan = plan(events)
        val records = linkedMapOf<String, EventRecord>()
        val labels = events.filter { it.originLabel.isNotEmpty() }.associate { it.origin.ifEmpty { DEFAULT_ORIGIN } to it.originLabel }
        fun keep(id: String, event: PhoneEvent, rrule: String, series: Series?) {
            if (!PhoneIds.isValid(id) || event.title.isEmpty() || event.start.isEmpty() || event.end.isEmpty()) return
            if (id !in records) {
                records[id] = EventRecord(id, event.origin.ifEmpty { DEFAULT_ORIGIN }, fields(event, rrule, series, now, deviceTz))
            }
        }
        for (event in plan.singles) keep(event.phoneId, event, "", null)
        for (series in plan.series) keep(series.id, series.event, series.rrule, series)
        val present = (origins + records.values.map { PhoneOriginRef(it.origin, "") }).distinctBy { it.id }.map { ref ->
            val label = ref.label.ifEmpty {
                labels[ref.id] ?: if (ref.id == DEFAULT_ORIGIN) AgendaCopy.IMPORT_ORIGIN_THIS_PHONE else ref.id
            }
            PhoneOriginRef(ref.id, label)
        }
        return CalendarBatch(complete, present, records.values.toList())
    }

    /**
     * THE FIELDS A PHONE OWNS OF AN EVENT, as JSON: its words, when it is (a wall clock and its zone,
     * which the vault resolves to the instant, or a floating time, or days), its rule, whether it
     * blocks its time, and for a series what the phone shows of its days.
     */
    internal fun fields(event: PhoneEvent, rrule: String, series: Series?, now: Long, deviceTz: String): String = buildString {
        append("{\"title\":").append(jsonString(event.title))
        append(",\"description\":").append(if (event.notes.isEmpty()) "null" else jsonString(event.notes))
        if (event.allDay) {
            append(",\"starts\":").append(jsonString(event.start.take(DAY)))
            append(",\"ends\":").append(jsonString(event.end.take(DAY)))
            append(",\"timing\":\"all-day\",\"zone\":null")
        } else {
            append(",\"starts\":").append(jsonString(event.start))
            append(",\"ends\":").append(jsonString(event.end))
            val zone = zoneOf(event, deviceTz)
            append(",\"timing\":").append(jsonString(if (zone == null) "floating" else "zoned"))
            append(",\"zone\":").append(if (zone == null) "null" else jsonString(zone))
        }
        append(",\"rule\":").append(if (rrule.isEmpty()) "null" else jsonString(rrule))
        append(",\"busy\":").append(!event.free)
        if (series != null) append(",\"overrides\":").append(overrides(series, now))
        append('}')
    }

    /**
     * WHAT THE PHONE SAYS OF A SERIES' DAYS, over the window it read: the days it showed as the rule
     * has them (`shown`, by the series-local wall clock) and each it moved (`moved`, with its own
     * times and words). A day the rule produces in the window that is neither is one the member
     * cancelled there; **the vault works that out**, because the phone has no rule engine.
     */
    internal fun overrides(series: Series, now: Long): String {
        val allDay = series.event.allDay
        val (from, to) = observed(now)
        fun keyOf(occurrence: PhoneEvent): String = key(occurrence.originalStart.ifEmpty { occurrence.start }, allDay)
        val shown = series.occurrences.filter { !it.moved }.map(::keyOf).distinct()
        val moved = series.occurrences.filter { it.moved }
        return buildString {
            append("{\"from\":").append(jsonString(from)).append(",\"to\":").append(jsonString(to))
            append(",\"shown\":[").append(shown.joinToString(",") { jsonString(it) }).append("]")
            append(",\"moved\":[")
            moved.forEachIndexed { index, day ->
                if (index > 0) append(',')
                append("{\"original_start\":").append(jsonString(keyOf(day)))
                append(",\"starts\":").append(jsonString(if (allDay) day.start.take(DAY) else day.start))
                append(",\"ends\":").append(jsonString(if (allDay) day.end.take(DAY) else day.end))
                append(",\"title\":").append(jsonString(day.title.trim()))
                append(",\"description\":").append(jsonString(day.notes.trim())).append('}')
            }
            append("]}")
        }
    }

    /** The `follow.calendar` input for one calendar: its records, and whether the read was complete. */
    internal fun input(origin: PhoneOriginRef, records: List<EventRecord>, complete: Boolean, device: String): String = buildString {
        append("{\"origin\":{\"ref\":").append(jsonString(origin.id))
        append(",\"label\":").append(jsonString(origin.label))
        append(",\"device_id\":").append(jsonString(device)).append("},\"records\":[")
        records.forEachIndexed { index, record ->
            if (index > 0) append(',')
            append("{\"external_id\":").append(jsonString(record.phoneId))
            // A phone id that means something on this phone only is kept under the phone (R-1127-10).
            append(",\"device_id\":").append(if (PhoneIds.isPortable(record.phoneId)) "null" else jsonString(device))
            append(",\"fields\":").append(record.fields).append('}')
        }
        append("],\"complete\":").append(complete).append('}')
    }

    /**
     * WRITE [events] INTO THE VAULT [core] HOLDS: one `follow.calendar` per calendar, read at [now].
     * [origins] lists every calendar present, so one with no event is still told (its events that
     * left are then trashed); [complete] is false when the read may be partial, and nothing is then
     * trashed. [device] is this install's [PhoneDevice] unless a caller names another.
     */
    public suspend fun run(
        core: CentraidCore,
        events: List<PhoneEvent>,
        deviceTz: String,
        now: Long,
        origins: List<PhoneOriginRef> = emptyList(),
        complete: Boolean = true,
        device: String? = null,
    ): Outcome {
        val batch = batch(events, origins, complete, now, deviceTz)
        val phone = device ?: PhoneDevice.id()
        var outcome = Outcome(added = 0, refused = 0, addAccount = complete && batch.records.isEmpty() && batch.origins.isEmpty())
        for (origin in batch.origins) {
            val records = batch.records.filter { it.origin == origin.id }
            val told = PhoneImport.executed(core, "follow.calendar", input(origin, records, batch.complete, phone))
            outcome = if (told == null) {
                outcome.copy(refused = outcome.refused + records.size)
            } else {
                outcome.copy(
                    added = outcome.added + count(told, "added") + count(told, "matched"),
                    refused = outcome.refused + count(told, "refused"),
                    updated = outcome.updated + count(told, "updated"),
                    trashed = outcome.trashed + count(told, "trashed"),
                )
            }
        }
        return outcome
    }

    /** A count of the command's output: `"added":3`. */
    private fun count(output: String, name: String): Int =
        Regex("\"$name\"\\s*:\\s*(\\d+)").find(output)?.groupValues?.get(1)?.toIntOrNull() ?: 0

    /** The one sentence the shell shows when an import ends. */
    public fun sentence(outcome: Outcome): String = when {
        outcome.addAccount -> AgendaCopy.IMPORT_CALENDAR_ADD_ACCOUNT
        outcome.added == 0 && outcome.refused == 0 -> AgendaCopy.IMPORT_CALENDAR_NONE
        outcome.added == 0 -> AgendaCopy.IMPORT_CALENDAR_FAILED
        outcome.added == 1 -> AgendaCopy.IMPORT_CALENDAR_ONE
        else -> AgendaCopy.IMPORT_CALENDAR_DONE.replace("{count}", outcome.added.toString())
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

    /**
     * One pass of the phone sync: [events] with every calendar in [origins], and whether the read
     * was [complete]. [onDone] is handed the typed outcome, so the shell can show the
     * add-your-account line (`addAccount`).
     */
    public fun sync(
        events: List<PhoneEvent>,
        origins: List<PhoneOriginRef>,
        complete: Boolean,
        deviceTz: String,
        now: Long,
        onDone: (CalendarImport.Outcome) -> Unit,
    ) {
        val core = session?.shelf?.core() ?: return onDone(CalendarImport.Outcome(added = 0, refused = 0))
        scope.launch { onDone(CalendarImport.run(core, events, deviceTz, now, origins, complete)) }
    }
}
