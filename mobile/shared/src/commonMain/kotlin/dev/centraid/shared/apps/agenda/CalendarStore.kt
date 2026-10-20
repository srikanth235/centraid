package dev.centraid.shared.apps.agenda

import centraid.core.v1.AgendaUpcomingRequest
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.kit.PhoneImport
import dev.centraid.shared.kit.time.epochDayOf
import dev.centraid.shared.sync.phone.CorePhoneStore
import dev.centraid.shared.sync.phone.PhoneFields
import dev.centraid.shared.sync.phone.PhoneRecord
import dev.centraid.shared.sync.phone.PhoneScore
import dev.centraid.shared.sync.phone.PhoneSource
import dev.centraid.shared.sync.phone.VaultRow
import dev.centraid.shared.sync.rfc3339FromEpochMillis
import kotlin.math.abs

/** WHAT AN EVENT'S WRITER NEEDS THAT THE FINGERPRINT DOES NOT HOLD: the event as read, its rule, and its series. */
internal data class EventAttributes(
    val event: PhoneEvent,
    val rrule: String,
    val series: CalendarImport.Series?,
)

/** WHAT THE VAULT KEEPS OF AN EVENT THE ENGINE ASKS ABOUT, beside its fields: where it starts and whether it repeats. */
internal data class EventRow(val dtstart: String, val rrule: String)

/**
 * AGENDA'S SIDE OF A CALENDAR PASS: the events as the vault holds them, read through the page
 * door, and the three writes the engine asks, through the commands a screen uses.
 *
 * **Windowed.** The phone's read covers [CalendarImport.windowStart] to [CalendarImport.windowEnd]
 * around [now], so an event outside it is not an event that went. [coverage] says which rows the
 * read could have seen: a single event whose start falls inside the window, and a series the
 * vault itself still expands inside it. A deleted series expands nowhere on the phone but does
 * here, which is how it is told from one that merely ended.
 */
internal class CalendarStore(
    core: CentraidCore,
    private val calendarId: String,
    private val deviceTz: String,
    private val now: Long,
) : CorePhoneStore(core, PhoneSource.CALENDAR) {
    override suspend fun rows(): Map<String, VaultRow>? = read(eventId = null)

    override suspend fun row(entityId: String): VaultRow? = read(entityId)?.get(entityId)

    /** A series' exceptions (`scope` occurrence), by event: `key → what it does and where it is stored`. */
    private suspend fun exceptions(eventId: String?): Map<String, List<List<centraid.core.v1.Value>>>? {
        val rows = pageAll(
            name = "phone.agenda.exceptions",
            select = listOf("exception_id", "target_id", "original_start_local", "scope", "action", "override_json"),
            from = "schedule_recurrence_exception",
            key = "exception_id",
            where = if (eventId == null) "target_type = 'core.event'" else "target_type = 'core.event' AND target_id = ?",
            bind = listOfNotNull(eventId?.let { centraid.core.v1.Value(text = it) }),
        ) ?: return null
        return rows.groupBy { it.text(1) }
    }

    private suspend fun read(eventId: String?): Map<String, VaultRow>? {
        val held = exceptions(eventId) ?: return null
        val rows = pageAll(
            name = "phone.agenda.events",
            select = listOf(
                "event_id", "summary", "description", "dtstart", "dtend", "start_tz",
                "recurrence_semantics", "rrule", "deleted_at",
            ),
            from = "core_event",
            key = "event_id",
            where = if (eventId == null) null else "event_id = ?",
            bind = listOfNotNull(eventId?.let { centraid.core.v1.Value(text = it) }),
        ) ?: return null
        return rows.associate { row ->
            val id = row.text(0)
            id to VaultRow(
                entityId = id,
                fields = PhoneFields.of {
                    text("summary", row.text(1))
                    text("description", row.text(2))
                    exact("dtstart", row.text(3))
                    exact("dtend", row.text(4))
                    text("start_tz", row.text(5))
                    text("recurrence_semantics", row.text(6))
                    text("rrule", row.text(7))
                    // A SERIES' EXCEPTIONS ARE PART OF THE ROW: a member who skips or moves an
                    // occurrence here has edited the event, and it stops following the phone.
                    set("exceptions", held[id].orEmpty().map { it.drop(2).joinToString("|") { value -> value.text.orEmpty() } })
                },
                trashed = row.text(8).isNotEmpty(),
                matchKey = PhoneFields.squash(row.text(1)).lowercase(),
                tiebreak = setOf(row.text(3)),
                attributes = EventRow(dtstart = row.text(3), rrule = row.text(7)),
            )
        }
    }

    /**
     * AN EVENT AND A PHONE RECORD ARE THE SAME EVENT when they share a title and start within a
     * zone's reach. The vault keeps a zoned event as an instant and the phone reports a wall
     * clock, and no zone database is in common code, so the two starts are compared as wall
     * clocks and accepted within fourteen hours (the widest zone offset); the nearest wins.
     */
    override val score: PhoneScore = { record, row ->
        val phone = record.tiebreak.firstOrNull().orEmpty()
        val vault = (row.attributes as? EventRow)?.dtstart.orEmpty()
        distance(phone, vault)
    }

    override suspend fun coverage(): (VaultRow) -> Boolean {
        val (first, last) = CalendarImport.inner(now)
        val expanding = expandingSeries()
        return { row ->
            val event = row.attributes as? EventRow
            when {
                event == null -> false
                event.rrule.isNotEmpty() -> expanding?.contains(row.entityId) == true
                else -> event.dtstart.take(DAY) in first..last
            }
        }
    }

    /** The events the vault expands inside the window; null when the read failed, which covers no series. */
    private suspend fun expandingSeries(): Set<String>? {
        val query = AppQueryRequest(
            agenda_upcoming = AgendaUpcomingRequest(
                from = rfc3339FromEpochMillis(CalendarImport.windowStart(now)),
                to = rfc3339FromEpochMillis(CalendarImport.windowEnd(now)),
                tz = deviceTz,
            ),
        )
        val answer = core.call(Envelope(request_id = 0, request = Request(app_query = query)))
        val events = (answer as? CoreOutcome.Answered)?.value?.response?.app_query?.agenda_upcoming?.events ?: return null
        return events.map { it.event_id }.toSet()
    }

    override suspend fun add(record: PhoneRecord): String? {
        val attributes = record.attributes as? EventAttributes ?: return null
        val series = attributes.series
        if (series != null) return CalendarImport.writeSeries(core, series, calendarId, deviceTz, now)
        return CalendarImport.propose(core, attributes.event, calendarId, deviceTz, rrule = "")?.takeIf { it.isNotEmpty() }
    }

    /**
     * THE FIELDS THE PHONE NOW HOLDS, onto the event. Its exceptions (a skipped or moved
     * occurrence) are followed by [follow].
     */
    override suspend fun update(entityId: String, record: PhoneRecord): Boolean {
        val attributes = record.attributes as? EventAttributes ?: return false
        val event = attributes.event
        val current = row(entityId)?.attributes as? EventRow ?: return false
        val fields = mutableListOf(
            "\"event_id\":${PhoneImport.quote(entityId)}",
            "\"summary\":${PhoneImport.quote(event.title)}",
            "\"dtstart\":${PhoneImport.quote(event.start)}",
            "\"dtend\":${PhoneImport.quote(event.end)}",
        )
        fields += when (val zone = CalendarImport.zoneOf(event, deviceTz)) {
            null -> "\"recurrence_semantics\":${PhoneImport.quote(if (event.allDay) "all-day" else "floating")}"
            else -> "\"tz\":${PhoneImport.quote(zone)}"
        }
        fields += if (event.notes.isEmpty()) "\"clear_description\":true" else "\"description\":${PhoneImport.quote(event.notes)}"
        if (attributes.rrule.isNotEmpty()) {
            fields += "\"rrule\":${PhoneImport.quote(attributes.rrule)}"
        } else if (current.rrule.isNotEmpty()) {
            fields += "\"clear_rrule\":true"
        }
        return command(AgendaWrites.EDIT, fields.joinToString(",", prefix = "{", postfix = "}")) != null
    }

    /**
     * THE SERIES' EXCEPTIONS THE PHONE NOW HOLDS (gap 2 of #1127): a newly skipped occurrence is
     * skipped, a newly moved one overridden, and one the phone put back restored, through
     * `schedule.edit_event_occurrence`. False when the vault's expansion or its exceptions cannot
     * be read or a write is refused, so the pass tries again; it writes nothing on a read it
     * could not make.
     */
    override suspend fun follow(entityId: String, record: PhoneRecord): Boolean {
        val series = (record.attributes as? EventAttributes)?.series ?: return true
        val upcoming = CalendarImport.upcoming(core, entityId, deviceTz, now) ?: return false
        val held = exceptions(entityId) ?: return false
        val byKey = held[entityId].orEmpty().filter { it.text(3) == "occurrence" }.associate { row ->
            val local = row.text(2)
            CalendarImport.key(local, local.length == DAY) to CalendarImport.HeldException(row.text(4), local)
        }
        var clean = true
        for (edit in CalendarImport.followEdits(series, entityId, upcoming, byKey, now, deviceTz)) {
            if (!PhoneImport.write(core, AgendaWrites.OCCURRENCE, edit.input)) clean = false
        }
        return clean
    }

    override suspend fun trash(entityId: String): Boolean =
        command(DELETE, "{\"event_id\":${PhoneImport.quote(entityId)}}") != null

    private companion object {
        /** `schedule.delete_event` moves an event to the trash, restorable for its purge window (R-1127-3). */
        const val DELETE: String = "schedule.delete_event"
        const val DAY: Int = 10
        const val SLACK_MINUTES: Long = 14L * 60
        const val DAY_MINUTES: Long = 24L * 60

        /** Minutes between two wall clocks (`YYYY-MM-DD[THH:MM[:SS]][Z]`), as a score: nearer is higher; null past a zone's reach. */
        fun distance(phone: String, vault: String): Int? {
            if (phone.length < DAY || vault.length < DAY) return null
            val allDay = phone.length == DAY || vault.length == DAY
            val a = minutes(phone) ?: return null
            val b = minutes(vault) ?: return null
            val gap = abs(a - b)
            return when {
                allDay -> if (phone.take(DAY) == vault.take(DAY)) 0 else null
                gap <= SLACK_MINUTES -> -gap.toInt()
                else -> null
            }
        }

        fun minutes(clock: String): Long? {
            val day = epochDayOf(clock.take(DAY)) ?: return null
            val hour = clock.drop(DAY + 1).take(2).toLongOrNull() ?: 0L
            val minute = clock.drop(DAY + 4).take(2).toLongOrNull() ?: 0L
            return day * DAY_MINUTES + hour * 60 + minute
        }
    }
}
