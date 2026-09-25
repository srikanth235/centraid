package dev.centraid.shared.shell

import centraid.core.v1.AgendaEvent
import centraid.core.v1.AgendaUpcoming
import centraid.core.v1.AgendaUpcomingRequest
import centraid.core.v1.AppQueryRequest
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.TileBody
import centraid.screen.v1.TileCount
import centraid.screen.v1.TileStatus
import dev.centraid.design.copy.AgendaCopy
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.kit.time.dayOfMonthOf
import dev.centraid.shared.kit.time.plusDays
import dev.centraid.shared.sync.rfc3339FromEpochMillis

/**
 * HOME'S AGENDA TILE, ON THE CORE'S `agenda.upcoming` (#1046).
 *
 * It read `core_event` through the page door: every row, cancelled and trashed
 * ones included, no series expanded, and `dtstart` printed as raw ISO. A
 * weekly run showed once, at its first week, for ever. Now it asks the one
 * recurrence engine (D-1020-S1) through the app-query arm and draws what that
 * answers — cancelled and trashed events are the query's to leave out, and it
 * does (`crates/apps/agenda`'s window statement; `tests/trash.rs`).
 *
 * ## Nothing here knows a zone
 *
 * The request states the device's zone and the answer comes back placed in
 * it: `local_start`, `local_end`, `local_days`, `today`, `now_local`. Every
 * comparison below is between those strings, which sort as the instants they
 * name, and the only arithmetic is civil — which weekday a `YYYY-MM-DD` is,
 * which day is seven after it (`sync/CivilDays.kt`).
 *
 * ## The window is fourteen days
 *
 * `from` is empty, which the core reads as the first instant of TODAY in the
 * zone. `to` is fourteen days of wall clock on, and that number is not a
 * taste: the after-line names a later day by its day of the month ("then
 * nothing until the 14th"), and a day of the month names exactly one day only
 * inside four weeks. Fourteen keeps it unambiguous with room to spare, and
 * keeps a launcher's read far inside the 120 days an open-ended `upcoming`
 * expands to.
 */
public object HomeAgendaTile {
    public const val APP_ID: String = "agenda"

    /** The read's reach, in days of wall clock from now. See the header. */
    public const val WINDOW_DAYS: Int = 14

    /** The count's reach: occurrences on today and the six days after it. */
    public const val COUNT_DAYS: Int = 7

    private const val MILLIS_PER_DAY: Long = 86_400_000

    /**
     * THE TABLES WHOSE CHANGES MOVE THIS TILE, and `HomeReads.TABLES` carries
     * them, so `HomeMachine.rowsChanged` re-reads on them.
     *
     * The event itself, its calendar edge, and a series' skipped or moved
     * occurrences — each changes which occurrence is next or what it is
     * called. Attendees, attachments and parties decorate a row the tile does
     * not draw, and a re-read of Home on every RSVP would be read load for a
     * launcher that looks the same afterwards.
     */
    public val TABLES: Set<String> =
        setOf("core_event", "schedule_event_ext", "schedule_recurrence_exception")

    /** The one query, in the device's zone, over the next [WINDOW_DAYS]. */
    public fun request(now: DeviceClock.Reading): AppQueryRequest = AppQueryRequest(
        agenda_upcoming = AgendaUpcomingRequest(
            from = "",
            to = rfc3339FromEpochMillis(now.epochMillis + WINDOW_DAYS * MILLIS_PER_DAY),
            tz = now.zone,
        ),
    )

    /**
     * The tile, out of one answer.
     *
     * **NOTHING UPCOMING IS `EMPTY`, not `UNKNOWN`.** The read landed and the
     * next fortnight holds nothing, which is a true answer — the tile falls to
     * first moves with its empty copy, as v0's did. A read that did not land
     * never reaches here; it is `TileRefused`.
     */
    public fun arrived(answer: AgendaUpcoming): HomeEvent {
        val today = answer.today
        val now = answer.now_local
        // IN START ORDER, as the core answers them: the first that has not
        // ended is next, whether it is later today or already under way.
        val live = answer.events.filter { it.local_start.isNotEmpty() && !it.endedBy(today, now) }
        val horizon = plusDays(today, COUNT_DAYS)
        val count = live.count { horizon == null || it.firstDay() < horizon }
        val next = live.firstOrNull() ?: return HomeEvent(
            tile = HomeEvent.TileArrived(
                app_id = APP_ID,
                status = TileStatus.TILE_STATUS_EMPTY,
                count = TileCount(value_ = 0),
                count_label = AgendaCopy.TILE_COUNT_LABEL,
            ),
        )
        // A SERIES IS ONE THING ON A LAUNCHER. Its next occurrence is the
        // headline, and "then Stand-up" under a stand-up says nothing — so the
        // after-line is the next occurrence of a DIFFERENT event.
        val after = live.drop(1).firstOrNull { it.event_id != next.event_id }
        return HomeEvent(
            tile = HomeEvent.TileArrived(
                app_id = APP_ID,
                status = TileStatus.TILE_STATUS_CONTENT,
                // EXACT, never capped: a window too full to answer is the
                // core's `READ_BOUND_REACHED`, which is a refusal and not a
                // short count.
                count = TileCount(value_ = count),
                count_label = AgendaCopy.TILE_COUNT_LABEL,
                body = TileBody(
                    agenda = TileBody.Agenda(
                        title = next.title(),
                        at = next.whenLine(today),
                        after = afterLine(next, after, today),
                    ),
                ),
            ),
        )
    }

    /**
     * HAS THIS OCCURRENCE ENDED, on the answer's own clock.
     *
     * All-day: its `local_end` is the LAST day, inclusive, so it runs through
     * today while that day is today or later. Timed: its `local_end` is
     * exclusive, so it has ended once now reaches it; one with no end is an
     * instant, over once now passes its start.
     */
    private fun AgendaEvent.endedBy(today: String, now: String): Boolean = when {
        all_day -> local_end.ifEmpty { local_start }.take(DAY) < today
        local_end.isEmpty() -> local_start < now
        else -> local_end <= now
    }

    /** The first day this occurrence occupies, in the request zone. */
    private fun AgendaEvent.firstDay(): String = local_days.firstOrNull() ?: local_start.take(DAY)

    private fun AgendaEvent.title(): String =
        summary?.takeIf { it.isNotBlank() } ?: AgendaCopy.UNTITLED

    /**
     * `08:15` today; `Wed 11 · 08:15` on another day; `Today · all day` and
     * `Wed 11 · all day` for a day and not a time — v0 drew a clock on an
     * all-day event, and a day has no 00:00 (#1046, a defect not carried).
     *
     * An occurrence that began before today and is still running is placed by
     * its START for a timed one — "Tue 10 · 22:00" is when it began — and as
     * today for an all-day one, which covers today whole.
     */
    private fun AgendaEvent.whenLine(today: String): String {
        val startDay = local_start.take(DAY)
        if (all_day) {
            val day = if (startDay <= today) AgendaCopy.TODAY else dated(startDay)
            return "$day$SEPARATOR${AgendaCopy.TILE_ALL_DAY}"
        }
        val clock = local_start.drop(DAY + 1).take(CLOCK)
        return if (startDay == today) clock else "${dated(startDay)}$SEPARATOR$clock"
    }

    /**
     * `then <title>` when the next different thing is on the headline's day;
     * `then nothing until the 14th` when a day or more is empty first; and
     * `nothing after it` when the window holds nothing more. Never blank: an
     * empty after-line reads as a render that failed (v0's `selectNextEvent`).
     */
    private fun afterLine(next: AgendaEvent, after: AgendaEvent?, today: String): String {
        if (after == null) return AgendaCopy.TILE_NOTHING_AFTER
        val headlineDay = maxOf(next.firstDay(), today)
        val afterDay = after.firstDay()
        if (afterDay <= headlineDay) return "${AgendaCopy.TILE_THEN} ${after.title()}"
        val dayOfMonth = dayOfMonthOf(afterDay)
            ?: return "${AgendaCopy.TILE_THEN} ${after.title()}"
        return "${AgendaCopy.TILE_NOTHING_UNTIL} ${ordinal(dayOfMonth)}"
    }

    /** `Wed 11`: the kit's words, one spelling for every app. */
    private fun dated(day: String): String = CivilWords.dated(day)

    /** `1st` … `31st`: the kit's. */
    internal fun ordinal(dayOfMonth: Int): String = CivilWords.ordinal(dayOfMonth)

    /** `YYYY-MM-DD`'s length, and where a `local_start`'s `T` sits. */
    private const val DAY: Int = 10

    /** `HH:MM`. */
    private const val CLOCK: Int = 5

    /** The handoff's separator between a day and a time: `Wed 11 · 08:15`. */
    private const val SEPARATOR: String = " · "
}
