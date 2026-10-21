package dev.centraid.shared.shell

import centraid.core.v1.AgendaEvent
import centraid.core.v1.AgendaUpcoming
import centraid.core.v1.AgendaUpcomingRequest
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.TasksBoard
import centraid.core.v1.TasksBoardRequest
import centraid.core.v1.TasksGroupKind
import centraid.core.v1.TasksView
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
 * It read `event` through the page door: every row, cancelled and trashed
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
 * ## Today's due tasks ride the same tile (#1128, R-1128-8)
 *
 * Tasks folded into Agenda, so the tile that names the next event also says how
 * much is due: one more app query, `tasks.board` over TODAY, answers the open
 * tasks overdue or due today, and [arrived] puts their count and the first
 * title on the body. The two reads are SEPARATE calls: a tasks read that is
 * denied or fails leaves the tile as it was (no due line), never a refused
 * Agenda. OVERDUE COUNTS AS DUE: a tile that said "0 due" over two tasks a week
 * late would lie by omission, and the Overdue group is Today's first.
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

    /**
     * The board window the due read asks for: the page Today itself reads, so
     * the tile and Today agree (the manifest clamps it to 20..500).
     */
    public const val DUE_WINDOW: Int = 100

    private const val MILLIS_PER_DAY: Long = 86_400_000

    /**
     * THE TABLES WHOSE CHANGES MOVE THIS TILE, and `HomeReads.TABLES` carries
     * them, so `HomeMachine.rowsChanged` re-reads on them.
     *
     * The event itself (`entity` carries its title and the trash), its row, and a
     * series' skipped or moved occurrences — each changes which occurrence is next or
     * what it is called. Guests and attachments are `edge`s and decorate a row the tile
     * does not draw, and a re-read of Home on every RSVP would be read load for a
     * launcher that looks the same afterwards. `task` moves the due line (#1128).
     */
    public val TABLES: Set<String> = setOf("entity", "event", "occurrence", "task")

    /** The one query, in the device's zone, over the next [WINDOW_DAYS]. */
    public fun request(now: DeviceClock.Reading): AppQueryRequest = AppQueryRequest(
        agenda_upcoming = AgendaUpcomingRequest(
            from = "",
            to = rfc3339FromEpochMillis(now.epochMillis + WINDOW_DAYS * MILLIS_PER_DAY),
            tz = now.zone,
        ),
    )

    /** The due read: the open tasks overdue or due today, in the device's zone (#1128). */
    public fun dueRequest(now: DeviceClock.Reading): AppQueryRequest = AppQueryRequest(
        tasks_board = TasksBoardRequest(tz = now.zone, limit = DUE_WINDOW, view = TasksView.TASKS_VIEW_TODAY),
    )

    /**
     * The tile, out of one answer and, when that read landed, the due board.
     *
     * **NOTHING UPCOMING AND NOTHING DUE IS `EMPTY`, not `UNKNOWN`.** The read
     * landed and the next fortnight holds nothing, which is a true answer — the
     * tile falls to first moves with its empty copy, as v0's did. A read that
     * did not land never reaches here; it is `TileRefused`. A [due] that did
     * not land is null and adds nothing: the tile never claims a count it did
     * not read.
     */
    public fun arrived(answer: AgendaUpcoming, due: TasksBoard? = null): HomeEvent {
        val today = answer.today
        val now = answer.now_local
        // IN START ORDER, as the core answers them: the first that has not
        // ended is next, whether it is later today or already under way.
        val live = answer.events.filter { it.local_start.isNotEmpty() && !it.endedBy(today, now) }
        val horizon = plusDays(today, COUNT_DAYS)
        val owed = Due.of(due)
        // THE COUNT IS WHAT THE TILE DRAWS (#1128): events in the next
        // COUNT_DAYS plus the tasks due, because "0" over a "1 due" line
        // contradicted itself. Its noun is "on your plate", which holds both.
        val count = live.count { horizon == null || it.firstDay() < horizon } + owed.count
        val next = live.firstOrNull() ?: return HomeEvent(
            tile = HomeEvent.TileArrived(
                app_id = APP_ID,
                status = if (owed.count == 0) TileStatus.TILE_STATUS_EMPTY else TileStatus.TILE_STATUS_CONTENT,
                count = TileCount(value_ = owed.count),
                count_label = HomeReads.countNoun(owed.count, false, AgendaCopy.TILE_COUNT_ONE, AgendaCopy.TILE_COUNT_MANY),
                // Tasks alone: the headline says there is no event, and the due line is the tile.
                body = if (owed.count == 0) null else TileBody(agenda = owed.on(TileBody.Agenda(title = AgendaCopy.TILE_NO_EVENTS))),
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
                count_label = HomeReads.countNoun(count, false, AgendaCopy.TILE_COUNT_ONE, AgendaCopy.TILE_COUNT_MANY),
                body = TileBody(
                    agenda = owed.on(
                        TileBody.Agenda(
                            title = next.title(),
                            at = next.whenLine(today),
                            after = afterLine(next, after, today),
                        ),
                    ),
                ),
            ),
        )
    }

    /**
     * WHAT IS DUE (#1128): overdue and due-today open tasks, counted off the
     * board's own counts (roots only, as Today counts them), headed by the first
     * title of the first group that holds one — Overdue before Today.
     */
    private class Due(val count: Int, val title: String) {
        fun on(body: TileBody.Agenda): TileBody.Agenda = if (count == 0) {
            body
        } else {
            body.copy(due_count = count, due_label = AgendaCopy.TILE_DUE.replace("{n}", count.toString()), due_title = title)
        }

        companion object {
            fun of(board: TasksBoard?): Due {
                val counts = board?.counts ?: return Due(0, "")
                val count = counts.overdue + counts.today
                val first = board.groups
                    .filter { it.kind == TasksGroupKind.TASKS_GROUP_KIND_OVERDUE || it.kind == TasksGroupKind.TASKS_GROUP_KIND_TODAY }
                    .sortedBy { if (it.kind == TasksGroupKind.TASKS_GROUP_KIND_OVERDUE) 0 else 1 }
                    .firstNotNullOfOrNull { group -> group.tasks.firstOrNull() }
                return Due(count, first?.title.orEmpty())
            }
        }
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
