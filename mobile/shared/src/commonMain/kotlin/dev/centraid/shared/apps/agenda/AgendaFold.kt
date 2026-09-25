package dev.centraid.shared.apps.agenda

import centraid.core.v1.AgendaCalendar
import centraid.core.v1.AgendaEvent
import centraid.core.v1.AppQueryDenial
import centraid.screen.v1.AgendaCalendarChoice
import centraid.screen.v1.AgendaDaySection
import centraid.screen.v1.AgendaEmpty
import centraid.screen.v1.AgendaEventRow
import centraid.screen.v1.AgendaHomeData
import centraid.screen.v1.AgendaHomeState
import centraid.screen.v1.AgendaLanding
import centraid.screen.v1.AgendaNowLine
import centraid.screen.v1.AgendaRowItem
import centraid.screen.v1.AgendaRowStatus
import centraid.screen.v1.Denied
import dev.centraid.design.copy.AgendaCopy
import dev.centraid.shared.design.PartyHueWheel
import dev.centraid.shared.kit.time.dayOfMonthOf
import dev.centraid.shared.kit.time.isoWeekdayOf
import dev.centraid.shared.kit.time.plusDays
import centraid.screen.v1.AgendaDueTask as DueTitle

/**
 * THE CORE'S ANSWERS, AS THE LIST A VIEW DRAWS (#1046).
 *
 * Pure, and over strings the core already placed in the device's zone
 * (`agenda.proto`'s header): every comparison is between `YYYY-MM-DD` and
 * `YYYY-MM-DDTHH:MM` strings, which sort as the instants they name, and the
 * only arithmetic is civil ([plusDays], [isoWeekdayOf]). Weekday and month
 * names are copy.
 *
 * ## Which days
 *
 * - **Day**: the anchor, alone.
 * - **Schedule**: every day from the anchor for [AgendaHomeMachine.LIST_DAYS]
 *   that has an event, a birthday or something due. Days before the anchor are
 *   not drawn.
 * - **Waiting**: the days of Schedule's window that hold an occurrence waiting
 *   on your reply, and only those occurrences.
 * - **A search term**: the days the hits fall on, wherever they are — a search
 *   finds, and a hit last month is still the answer. Waiting still filters.
 *
 * A run over several days is a row on each; the upcoming answer is padded a
 * day either side (`AgendaReads`), and `local_days` is what keeps a row to the
 * days it is on.
 */
internal object AgendaFold {
    /**
     * THE GATE, as the kit draws it on every screen (law 1's fourth shape):
     * Agenda's two sentences, and the refusal's code as the receipt.
     */
    fun denied(denial: AppQueryDenial?): Denied = Denied(
        title = AgendaCopy.DENIED_TITLE,
        body = AgendaCopy.DENIED_BODY,
        receipt = denial?.code ?: "",
    )

    fun fold(screen: AgendaHomeState, answers: AgendaAnswers): AgendaHomeData {
        val upcoming = answers.upcoming
        val context = answers.context
        val today = context.today.ifEmpty { upcoming.today }
        val now = context.now_local.ifEmpty { upcoming.now_local }
        val anchor = screen.anchor_day.ifEmpty { today }
        val term = AgendaHomeMachine.activeTerm(screen)
        val search = answers.search.takeIf { term != null }
        val waitingOnly = screen.destination == AgendaHomeState.Destination.DESTINATION_WAITING
        val span = AgendaHomeMachine.spanOf(screen.destination)
        val window = generateSequence(anchor) { day -> plusDays(day, 1) }.take(span).toList()
        val inWindow = window.toSet()

        val hidden = screen.hidden_calendar_ids.toSet()
        val shown = { event: AgendaEvent -> event.calendar_id == null || event.calendar_id !in hidden }
        val hues = calendarHues(answers)

        val source = search?.events ?: upcoming.events
        val visible = source.filter(shown).filter { !waitingOnly || waitsOnYou(it) }

        // EVERY DAY A ROW IS ON, in the window unless it is a search hit.
        val byDay = LinkedHashMap<String, MutableList<AgendaEvent>>()
        visible.forEach { event ->
            daysOf(event)
                .filter { search != null || it in inWindow }
                .forEach { day -> byDay.getOrPut(day) { mutableListOf() } += event }
        }

        // DAY CONTEXT DECORATES; it never makes a Waiting day or a search day.
        val birthdays = context.birthdays.groupBy { monthDay(it.month, it.day) }
        val due = context.due.associateBy { it.day }
        val decorated = if (search == null && !waitingOnly) {
            window.filter { day -> birthdays[day.drop(MONTH_DAY_FROM)] != null || due[day] != null }
        } else {
            emptyList()
        }
        val days = (byDay.keys + decorated).distinct().sorted()

        var shownMonth = anchor.take(MONTH)
        val sections = days.map { day ->
            val names = birthdays[day.drop(MONTH_DAY_FROM)]?.map { it.name }.orEmpty()
            val dueDay = due[day]
            val dueCount = dueDay?.count ?: 0
            val dueOpen = dueCount > 0 && day in screen.due_open_days
            val month = day.take(MONTH)
            val monthHeading = if (month != shownMonth) monthYear(day) else null
            shownMonth = month
            AgendaDaySection(
                day = day,
                day_number = dayOfMonthOf(day)?.toString() ?: "",
                weekday_short = weekdayShort(day),
                heading = if (day == today) AgendaCopy.TODAY else shortDay(day),
                is_today = day == today,
                is_past = day < today,
                month_heading = monthHeading,
                ribbon = when (names.size) {
                    0 -> null
                    1 -> names.single()
                    else -> "${names.size} ${AgendaCopy.RIBBON_BIRTHDAYS}"
                },
                ribbon_names = names,
                due_count = dueCount,
                due = dueDay?.tasks?.map { DueTitle(task_id = it.task_id, title = it.title) }.orEmpty(),
                due_label = when {
                    dueCount == 0 -> ""
                    dueOpen -> AgendaCopy.SHELF_HIDE
                    else -> "$dueCount ${AgendaCopy.SHELF_DUE}"
                },
                due_open = dueOpen,
                items = items(day, byDay[day].orEmpty(), today, now, screen, hues),
            )
        }

        val drawn = sections.flatMap { section -> section.items.mapNotNull { it.event?.instance_key } }
            .toSet()
        val waitingCount = upcoming.events
            .filter(shown)
            .filter { event -> waitsOnYou(event) && daysOf(event).any { it in inWindow } }
            .map { it.instance_key }
            .toSet()
            .size
        val landing = (sections.firstOrNull { it.is_today } ?: sections.firstOrNull { !it.is_past })
            ?.let { section ->
                AgendaLanding(
                    day = section.day,
                    now_line = section.items.any { it.now_line != null },
                )
            }
            ?: AgendaLanding()

        val empty = when {
            sections.isNotEmpty() -> AgendaEmpty.AGENDA_EMPTY_NONE
            term != null -> AgendaEmpty.AGENDA_EMPTY_NO_MATCH
            waitingOnly -> AgendaEmpty.AGENDA_EMPTY_NOTHING_WAITING
            screen.destination == AgendaHomeState.Destination.DESTINATION_SCHEDULE &&
                hidden.isEmpty() &&
                upcoming.events.isEmpty() -> AgendaEmpty.AGENDA_EMPTY_DAY_ONE
            else -> AgendaEmpty.AGENDA_EMPTY_NOTHING_ON_DAY
        }
        val (emptyTitle, emptyBody, emptyAction) = when (empty) {
            AgendaEmpty.AGENDA_EMPTY_DAY_ONE -> Triple(
                AgendaCopy.EMPTY_DAY_ONE_TITLE,
                AgendaCopy.EMPTY_DAY_ONE_BODY,
                AgendaCopy.NEW_EVENT,
            )
            AgendaEmpty.AGENDA_EMPTY_NO_MATCH ->
                Triple(AgendaCopy.EMPTY_NO_MATCH, AgendaCopy.EMPTY_NO_MATCH_BODY, "")
            AgendaEmpty.AGENDA_EMPTY_NOTHING_WAITING -> Triple(AgendaCopy.EMPTY_WAITING, "", "")
            AgendaEmpty.AGENDA_EMPTY_NOTHING_ON_DAY -> Triple(
                if (span == 1) AgendaCopy.EMPTY_DAY else AgendaCopy.EMPTY_DAYS,
                "",
                "",
            )
            else -> Triple("", "", "")
        }

        return AgendaHomeData(
            today = today,
            now_local = now,
            days = sections,
            empty = empty,
            empty_title = emptyTitle,
            empty_body = emptyBody,
            empty_action = emptyAction,
            calendars = upcoming.calendars.map { calendar ->
                val isHidden = calendar.calendar_id in hidden
                AgendaCalendarChoice(
                    calendar_id = calendar.calendar_id,
                    name = calendar.name?.takeIf { it.isNotBlank() } ?: AgendaCopy.CALENDAR_UNNAMED,
                    hue_key = hues(calendar.calendar_id),
                    hidden = isHidden,
                    state_label = if (isHidden) {
                        AgendaCopy.CALENDAR_HIDDEN
                    } else {
                        AgendaCopy.CALENDAR_SHOWN
                    },
                )
            },
            waiting_count = waitingCount,
            event_count = drawn.size,
            event_count_label = "${drawn.size} ${
                if (drawn.size == 1) AgendaCopy.EVENT_ONE else AgendaCopy.EVENT_MANY
            }",
            landing = landing,
        )
    }

    /**
     * One day's rows: all-day first, then what runs in from a day before,
     * then by start — and on today, the now line before the first row that
     * has not started (v0's placement: a list has no time axis, so "between
     * the last row under way and the next" is where now is).
     */
    private fun items(
        day: String,
        events: List<AgendaEvent>,
        today: String,
        now: String,
        screen: AgendaHomeState,
        hues: (String?) -> String,
    ): List<AgendaRowItem> {
        val ordered = events.sortedBy { event ->
            when {
                event.all_day -> "0"
                startDay(event) < day -> "1"
                else -> "2" + event.local_start
            }
        }
        val rows = ordered.map { AgendaRowItem(event = row(day, it, today, now, screen, hues)) }
        if (day != today) return rows
        val at = ordered.indexOfFirst { event ->
            !event.all_day && startDay(event) == day && event.local_start > now
        }.let { if (it < 0) ordered.size else it }
        val clock = clockOf(now)
        val line = AgendaRowItem(
            now_line = AgendaNowLine(
                label = clock,
                accessibility_label = "${AgendaCopy.NOW}, $clock",
            ),
        )
        return rows.take(at) + line + rows.drop(at)
    }

    private fun row(
        day: String,
        event: AgendaEvent,
        today: String,
        now: String,
        screen: AgendaHomeState,
        hues: (String?) -> String,
    ): AgendaEventRow {
        val title = event.summary?.takeIf { it.isNotBlank() } ?: AgendaCopy.UNTITLED
        val (timeLabel, spoken) = timeOf(event, day)
        val meta = metaOf(event)
        val status = when {
            event.event_id in screen.cancel_asked_event_ids -> AgendaRowStatus.AGENDA_ROW_STATUS_CANCEL_ASKED
            event.event_id in screen.pending_event_ids -> AgendaRowStatus.AGENDA_ROW_STATUS_PENDING
            waitsOnYou(event) -> AgendaRowStatus.AGENDA_ROW_STATUS_NEEDS_REPLY
            else -> AgendaRowStatus.AGENDA_ROW_STATUS_NONE
        }
        val statusLabel = when (status) {
            AgendaRowStatus.AGENDA_ROW_STATUS_CANCEL_ASKED -> AgendaCopy.STATUS_CANCEL_ASKED
            AgendaRowStatus.AGENDA_ROW_STATUS_PENDING -> AgendaCopy.STATUS_PENDING
            AgendaRowStatus.AGENDA_ROW_STATUS_NEEDS_REPLY -> AgendaCopy.STATUS_NEEDS_REPLY
            else -> ""
        }
        return AgendaEventRow(
            event_id = event.event_id,
            instance_key = event.instance_key,
            original_start_local = event.original_start_local,
            row_key = "$day|${event.instance_key}",
            title = title,
            time_label = timeLabel,
            meta = meta.joinToString(META_SEPARATOR),
            calendar_hue_key = hues(event.calendar_id),
            status = status,
            status_label = statusLabel,
            accessibility_label = (listOf(title, spoken) + meta + statusLabel)
                .filter { it.isNotEmpty() }
                .joinToString(", "),
            is_past = day < today || ended(event, today, now),
        )
    }

    /**
     * What a row says for its time on [day], and how it is spoken.
     *
     * An all-day row is "All day" — a day has no 00:00 (#1046, a v0 defect
     * not carried). A timed run's end is EXCLUSIVE, so one ending at the next
     * local midnight still ends on [day].
     */
    private fun timeOf(event: AgendaEvent, day: String): Pair<String, String> {
        if (event.all_day) return AgendaCopy.ALL_DAY to AgendaCopy.ALL_DAY
        val start = clockOf(event.local_start)
        val startsHere = startDay(event) >= day
        val end = event.local_end
        val endDay = end.take(DAY)
        val endClock = clockOf(end)
        val endsHere = end.isEmpty() ||
            endDay <= day ||
            (endDay == plusDays(day, 1) && endClock == MIDNIGHT)
        return when {
            startsHere && (end.isEmpty() || end == event.local_start) -> start to start
            startsHere && endsHere ->
                "$start – $endClock" to "$start ${AgendaCopy.SPOKEN_TO} $endClock"
            startsHere -> "${AgendaCopy.FROM} $start".let { it to it }
            endsHere -> "${AgendaCopy.UNTIL} $endClock".let { it to it }
            else -> AgendaCopy.CONTINUES to AgendaCopy.CONTINUES
        }
    }

    /**
     * "repeats · 2 guests · call". "repeats" on EVERY occurrence of a series —
     * `recurrence_summary` is present on all of them, where v0 read
     * `is_recurrence_instance` and left the anchor unmarked (#1046). A guest is
     * anyone on the event but you.
     */
    private fun metaOf(event: AgendaEvent): List<String> {
        val guests = event.attendees.count { !it.is_you }
        return listOfNotNull(
            AgendaCopy.META_REPEATS.takeIf { event.recurrence_summary != null },
            guests.takeIf { it > 0 }?.let {
                "$it ${if (it == 1) AgendaCopy.META_GUEST else AgendaCopy.META_GUESTS}"
            },
            AgendaCopy.META_CALL.takeIf { !event.conferencing_uri.isNullOrBlank() },
        )
    }

    /**
     * WAITING ON YOU: you are a guest (`is_you`, the vault's own owner, never
     * a guess) and have not answered — no reply, or `needs-action` — on an
     * event that is not cancelled.
     */
    fun waitsOnYou(event: AgendaEvent): Boolean =
        event.status != CANCELLED &&
            event.attendees.any { it.is_you && (it.partstat.isEmpty() || it.partstat == NEEDS_ACTION) }

    /** HAS IT ENDED, on the answer's clock — `HomeAgendaTile`'s rule. */
    private fun ended(event: AgendaEvent, today: String, now: String): Boolean = when {
        event.all_day -> event.local_end.ifEmpty { event.local_start }.take(DAY) < today
        event.local_end.isEmpty() -> event.local_start < now
        else -> event.local_end <= now
    }

    private fun daysOf(event: AgendaEvent): List<String> =
        event.local_days.ifEmpty { listOfNotNull(event.local_start.take(DAY).takeIf { it.length == DAY }) }

    private fun startDay(event: AgendaEvent): String = event.local_start.take(DAY)

    /**
     * THE 2PX RULE'S HUE. A calendar that stores `var(--c-<hue>)` gets that
     * hue; one that stores nothing, or a colour the wheel cannot name (the demo
     * vault's `steelblue`), gets its id's own — a rule has to be some colour,
     * and the id's is stable across renames. An event on no calendar is
     * [NO_CALENDAR_HUE].
     */
    private fun calendarHues(answers: AgendaAnswers): (String?) -> String =
        calendarHues(answers.upcoming.calendars)

    /** [calendarHues] over a calendar list — the detail's and the editor's too. */
    fun calendarHues(calendars: List<AgendaCalendar>): (String?) -> String {
        val stored = calendars.associate { it.calendar_id to it.color }
        return { id ->
            if (id == null) {
                NO_CALENDAR_HUE
            } else {
                PartyHueWheel.partyHueKey(id, stored[id]) ?: PartyHueWheel.identityHueKey(id)
            }
        }
    }

    /** `Wed 11 March`. */
    private fun shortDay(day: String): String =
        "${weekdayShort(day)} ${dayOfMonthOf(day) ?: ""} ${monthName(day)}"

    /** `Wednesday 11 March`. */
    fun longDay(day: String): String {
        val weekday = isoWeekdayOf(day)?.let { WEEKDAYS_FULL[it - 1] } ?: return day
        return "$weekday ${dayOfMonthOf(day)} ${monthName(day)}"
    }

    /** `March 2026`. */
    fun monthYear(day: String): String = "${monthName(day)} ${day.take(YEAR)}"

    private fun weekdayShort(day: String): String =
        isoWeekdayOf(day)?.let { WEEKDAYS_SHORT[it - 1] } ?: ""

    private fun monthName(day: String): String =
        day.substring(YEAR + 1, MONTH).toIntOrNull()?.let { MONTHS.getOrNull(it - 1) } ?: ""

    /** `MM-DD`, a birthday's recurring key. */
    private fun monthDay(month: Int, day: Int): String =
        month.toString().padStart(2, '0') + "-" + day.toString().padStart(2, '0')

    /** `HH:MM` out of `YYYY-MM-DDTHH:MM`, or empty. */
    private fun clockOf(local: String): String =
        if (local.length >= DAY + 1 + CLOCK) local.substring(DAY + 1, DAY + 1 + CLOCK) else ""

    private val WEEKDAYS_SHORT: List<String> = listOf(
        AgendaCopy.WEEKDAY_MON,
        AgendaCopy.WEEKDAY_TUE,
        AgendaCopy.WEEKDAY_WED,
        AgendaCopy.WEEKDAY_THU,
        AgendaCopy.WEEKDAY_FRI,
        AgendaCopy.WEEKDAY_SAT,
        AgendaCopy.WEEKDAY_SUN,
    )

    private val WEEKDAYS_FULL: List<String> = listOf(
        AgendaCopy.WEEKDAY_FULL_MON,
        AgendaCopy.WEEKDAY_FULL_TUE,
        AgendaCopy.WEEKDAY_FULL_WED,
        AgendaCopy.WEEKDAY_FULL_THU,
        AgendaCopy.WEEKDAY_FULL_FRI,
        AgendaCopy.WEEKDAY_FULL_SAT,
        AgendaCopy.WEEKDAY_FULL_SUN,
    )

    private val MONTHS: List<String> = listOf(
        AgendaCopy.MONTH_01,
        AgendaCopy.MONTH_02,
        AgendaCopy.MONTH_03,
        AgendaCopy.MONTH_04,
        AgendaCopy.MONTH_05,
        AgendaCopy.MONTH_06,
        AgendaCopy.MONTH_07,
        AgendaCopy.MONTH_08,
        AgendaCopy.MONTH_09,
        AgendaCopy.MONTH_10,
        AgendaCopy.MONTH_11,
        AgendaCopy.MONTH_12,
    )

    /** A party hue for an event on no calendar: neutral, and never a brand. */
    private const val NO_CALENDAR_HUE: String = "slate"

    private const val CANCELLED: String = "cancelled"
    private const val NEEDS_ACTION: String = "needs-action"
    private const val MIDNIGHT: String = "00:00"
    private const val META_SEPARATOR: String = " · "

    /** `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, `HH:MM`; `MM-DD` starts after `YYYY-`. */
    private const val YEAR: Int = 4
    private const val MONTH: Int = 7
    private const val DAY: Int = 10
    private const val CLOCK: Int = 5
    private const val MONTH_DAY_FROM: Int = 5
}
