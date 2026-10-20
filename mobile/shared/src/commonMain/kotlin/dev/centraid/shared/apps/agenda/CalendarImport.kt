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
import dev.centraid.shared.sync.phone.GoneChoice
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneFields
import dev.centraid.shared.sync.phone.PhoneIds
import dev.centraid.shared.sync.phone.PhoneOriginRef
import dev.centraid.shared.sync.phone.PhoneRecord
import dev.centraid.shared.sync.phone.PhoneSnapshot
import dev.centraid.shared.sync.phone.PhoneSource
import dev.centraid.shared.sync.phone.PhoneStore
import dev.centraid.shared.sync.phone.PhoneSync
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
        public val gone: List<OriginGone> = emptyList(),
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

    /**
     * What the vault holds of [events] — read at [now], over [windowStart] to
     * [windowEnd] — and the zone a timed one without its own falls back to. This is one pass of
     * the phone sync (#1127): the first one brings the calendar in, later ones follow it.
     * [origins] lists every calendar present, so one with no event in the window is not mistaken
     * for gone; [complete] is false when the read may be partial, and nothing is then trashed.
     */
    public suspend fun run(
        core: CentraidCore,
        events: List<PhoneEvent>,
        deviceTz: String,
        now: Long,
        origins: List<PhoneOriginRef> = emptyList(),
        complete: Boolean = true,
    ): Outcome {
        val calendar = firstCalendar(core) ?: return Outcome(added = 0, refused = events.size)
        return sync(CalendarStore(core, calendar, deviceTz, now), events, origins, complete, now)
    }

    /**
     * The member's answer to a calendar that left the phone (R-1127-9); [GoneChoice.KEEP] is the
     * default. [seenBefore] is the question's own, for a calendar that only lost most of its events.
     */
    public suspend fun resolveGone(
        core: CentraidCore,
        originId: String,
        choice: GoneChoice,
        deviceTz: String,
        now: Long,
        seenBefore: String? = null,
    ): Outcome {
        val report = PhoneSync.resolveGone(CalendarStore(core, "", deviceTz, now), originId, choice, seenBefore)
        return Outcome(added = 0, refused = report.refused.size, trashed = report.trashed)
    }

    /**
     * ONE PASS over [store]. **A series the vault refuses** (a rule it will not expand) is
     * followed as its occurrences in the window, each its own event keyed `<series id>@<start>`:
     * the first pass finds it out (the add is refused), writes nothing for it, and runs again with
     * the series expanded; later passes expand it from the links alone.
     */
    internal suspend fun sync(store: PhoneStore, events: List<PhoneEvent>, origins: List<PhoneOriginRef>, complete: Boolean, now: Long): Outcome {
        val links = store.links() ?: return Outcome(added = 0, refused = 0)
        val series = plan(events).series
        val expanded = series.map { it.id }.filter { id ->
            links.none { it.phoneId == id } && links.any { it.phoneId.startsWith("$id@") }
        }.toSet()
        val first = snapshot(events, origins, complete, now, expanded)
        val one = PhoneSync.run(store, first)
        val retry = series.map { it.id }.filter { it in one.refused && it !in expanded }.toSet()
        val two = if (retry.isEmpty()) null else PhoneSync.run(store, snapshot(events, origins, complete, now, expanded + retry))
        val refused = one.refused.filterNot { it in retry } + two?.refused.orEmpty()
        return Outcome(
            added = one.added + one.adopted + (two?.let { it.added + it.adopted } ?: 0),
            refused = refused.size,
            updated = one.updated + one.followed + (two?.let { it.updated + it.followed } ?: 0),
            trashed = one.trashed + (two?.trashed ?: 0),
            addAccount = first.complete && first.records.isEmpty() && first.origins.isEmpty(),
            gone = one.gone,
        )
    }

    /**
     * A READ OF THE CALENDAR AS A SNAPSHOT. A repeating series is ONE record keyed by its id, and
     * every other event one record keyed by its own; an id that names no kind skips the event.
     * [expanded] are the series followed as their occurrences instead (see [sync]).
     */
    public fun snapshot(
        events: List<PhoneEvent>,
        origins: List<PhoneOriginRef> = emptyList(),
        complete: Boolean = true,
        now: Long,
        expanded: Set<String> = emptySet(),
    ): PhoneSnapshot {
        val plan = plan(events)
        val records = linkedMapOf<String, PhoneRecord>()
        val labels = events.filter { it.originLabel.isNotEmpty() }.associate { it.origin.ifEmpty { DEFAULT_ORIGIN } to it.originLabel }
        fun keep(id: String, event: PhoneEvent, rrule: String, series: Series?) {
            if (!PhoneIds.isValid(id) || event.title.isEmpty() || event.start.isEmpty() || event.end.isEmpty()) return
            if (id !in records) records[id] = record(id, event, rrule, series, now)
        }
        for (event in plan.singles) keep(event.phoneId, event, "", null)
        for (series in plan.series) {
            if (series.id !in expanded) {
                keep(series.id, series.event, series.rrule, series)
                continue
            }
            for (occurrence in series.occurrences) {
                // KEYED ON WHERE THE RULE PUT IT, so a moved occurrence keeps its link when it moves again.
                val id = "${series.id}@${key(occurrence.originalStart.ifEmpty { occurrence.start }, occurrence.allDay)}"
                tidy(occurrence)?.let { keep(id, it, "", null) }
            }
        }
        val present = (origins + records.values.map { PhoneOriginRef(it.origin, "") }).distinctBy { it.id }.map { ref ->
            val label = ref.label.ifEmpty {
                labels[ref.id] ?: if (ref.id == DEFAULT_ORIGIN) AgendaCopy.IMPORT_ORIGIN_THIS_PHONE else ref.id
            }
            PhoneOriginRef(ref.id, label)
        }
        return PhoneSnapshot(PhoneSource.CALENDAR, complete, rfc3339FromEpochMillis(now), present, records.values.toList())
    }

    /** THE FIELDS A PHONE OWNS OF AN EVENT. `free` is written when the event is added and not followed. */
    private fun record(id: String, event: PhoneEvent, rrule: String, series: Series?, now: Long): PhoneRecord = PhoneRecord(
        phoneId = id,
        origin = event.origin.ifEmpty { DEFAULT_ORIGIN },
        fields = PhoneFields.of {
            text("title", event.title)
            text("notes", event.notes)
            text("all_day", if (event.allDay) "1" else "0")
            exact("start", event.start)
            exact("end", event.end)
            text("tz", event.tz)
            text("rrule", rrule)
        },
        matchKey = PhoneFields.squash(event.title).lowercase(),
        tiebreak = setOf(event.start),
        satellite = series?.let { satellite(it, now) } ?: PhoneFields.EMPTY,
        attributes = EventAttributes(event, rrule, series),
    )

    /**
     * WHAT THE PHONE SAYS OF A SERIES' OCCURRENCES, as a digest to compare pass to pass (gap 2 of
     * #1127): the occurrences it shows inside the window, unmoved, by the key the rule put them at,
     * and each moved one with its own times and words. A key the vault expands that is missing from
     * this was cancelled on the phone; one that was missing and is back was restored. The window
     * moves a day at a time, so the digest does, and a pass that finds it changed reconciles.
     */
    private fun satellite(series: Series, now: Long): PhoneFields {
        val allDay = series.event.allDay
        val (first, last) = inner(now)
        fun keyOf(occurrence: PhoneEvent): String = key(occurrence.originalStart.ifEmpty { occurrence.start }, allDay)
        return PhoneFields.of {
            set("shown", series.occurrences.filter { !it.moved }.map(::keyOf).filter { it.take(DAY) in first..last })
            set(
                "moved",
                series.occurrences.filter { it.moved }.map {
                    listOf(keyOf(it), it.start, it.end, it.title.trim(), it.notes.trim()).joinToString("|")
                },
            )
        }
    }

    /**
     * WRITE ONE SERIES AND ITS EXCEPTIONS: the event with its rule, then a skip for an occurrence
     * the phone cancelled, an override for one it moved, and a one-off for one the vault's reading
     * of the rule lacks. The new `event_id`, or null when the vault refused the series (the rule
     * is one it will not expand: the caller follows its occurrences instead).
     */
    internal suspend fun writeSeries(core: CentraidCore, series: Series, calendar: String, deviceTz: String, now: Long): String? {
        val eventId = propose(core, series.event, calendar, deviceTz, series.rrule)
        if (eventId.isNullOrEmpty()) return null
        // AN UNREAD EXPANSION WRITES NOTHING MORE: without it every
        // occurrence would look like a stray and land twice.
        val upcoming = upcoming(core, eventId, deviceTz, now) ?: return eventId
        for (edit in reconcile(series, eventId, upcoming, now, deviceTz)) {
            if (PhoneImport.write(core, AgendaWrites.OCCURRENCE, edit.input)) continue
            // A REFUSED SKIP leaves that occurrence as the rule has it; a
            // refused override keeps the moved occurrence as its own event.
            edit.fallback?.let { single(core, it, calendar, deviceTz) }
        }
        for (event in strays(series, upcoming, now)) single(core, event, calendar, deviceTz)
        return eventId
    }

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

    /** An exception the vault holds on a series: what it does, and the key it is stored under (`original_start_local`). */
    internal data class HeldException(val action: String, val local: String)

    /**
     * THE EXCEPTIONS A FOLLOWED SERIES NEEDS NOW (gap 2 of #1127): [reconcile]'s skips for an
     * occurrence the phone no longer shows and overrides for ones it moved, and **a restore** for
     * an occurrence the phone shows as the rule has it that the vault still holds an exception on
     * (the phone un-cancelled it or put it back). Only inside the window, as [reconcile] is. An
     * occurrence that is not a skip or a move on either side is untouched, and a stray (one the
     * phone shows and the vault's reading of the rule lacks) is not written again: it was written
     * when the series was added.
     */
    internal fun followEdits(
        series: Series,
        eventId: String,
        upcoming: Map<String, String>,
        held: Map<String, HeldException>,
        now: Long,
        deviceTz: String,
    ): List<OccurrenceEdit> {
        val allDay = series.event.allDay
        val (first, last) = inner(now)
        val edits = reconcile(series, eventId, upcoming, now, deviceTz).toMutableList()
        val moved = series.occurrences.filter { it.moved }.map { key(it.originalStart.ifEmpty { it.start }, allDay) }.toSet()
        for (occurrence in series.occurrences.filter { !it.moved }) {
            val key = key(occurrence.originalStart.ifEmpty { occurrence.start }, allDay)
            if (key in moved || key.take(DAY) < first || key.take(DAY) > last) continue
            val exception = held[key] ?: continue
            edits += OccurrenceEdit(occurrence(eventId, exception.local, "restore"), fallback = null)
        }
        return edits
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
    internal fun inner(now: Long): Pair<String, String> = Pair(
        civilDayOf(floorDiv(windowStart(now), DAY_MS) + 1),
        civilDayOf(floorDiv(windowEnd(now), DAY_MS) - 1),
    )

    /** An event's zone — its own, else the device's — or null for an all-day one or none at all. */
    internal fun zoneOf(event: PhoneEvent, deviceTz: String): String? =
        if (event.allDay) null else event.tz.ifEmpty { deviceTz }.ifEmpty { null }

    /** One event on its own: busy as the phone holds it, else kept free. */
    internal suspend fun single(core: CentraidCore, event: PhoneEvent, calendar: String, deviceTz: String): Boolean =
        propose(core, event, calendar, deviceTz, rrule = "") != null

    /** Propose [event], busy then free; the new `event_id`, or null when the vault refused both. */
    internal suspend fun propose(core: CentraidCore, event: PhoneEvent, calendar: String, deviceTz: String, rrule: String): String? {
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
    internal suspend fun upcoming(core: CentraidCore, eventId: String, deviceTz: String, now: Long): Map<String, String>? {
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
    public fun sentence(outcome: Outcome): String = when {
        outcome.addAccount -> AgendaCopy.IMPORT_CALENDAR_ADD_ACCOUNT
        outcome.added == 0 && outcome.refused == 0 -> AgendaCopy.IMPORT_CALENDAR_NONE
        outcome.added == 0 -> AgendaCopy.IMPORT_CALENDAR_FAILED
        outcome.added == 1 -> AgendaCopy.IMPORT_CALENDAR_ONE
        else -> AgendaCopy.IMPORT_CALENDAR_DONE.replace("{count}", outcome.added.toString())
    }

    private val EVENT_ID = Regex("\"event_id\"\\s*:\\s*\"([^\"]+)\"")

    /** The vault's first calendar — `Vault::found` mints a private one — read through the page door. */
    internal suspend fun firstCalendar(core: CentraidCore): String? {
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

    /**
     * One pass of the phone sync: [events] with every calendar in [origins], and whether the read
     * was [complete]. [onDone] is handed the typed outcome, so the shell can show the
     * add-your-account line (`addAccount`) and ask about a calendar that left (`gone`).
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

    /** The member's answer to a calendar that left the phone. */
    public fun resolveGone(originId: String, keep: Boolean, deviceTz: String, now: Long, onDone: (CalendarImport.Outcome) -> Unit) {
        val core = session?.shelf?.core() ?: return onDone(CalendarImport.Outcome(added = 0, refused = 0))
        scope.launch {
            onDone(CalendarImport.resolveGone(core, originId, if (keep) GoneChoice.KEEP else GoneChoice.TRASH, deviceTz, now))
        }
    }
}
