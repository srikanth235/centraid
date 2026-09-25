package dev.centraid.shared.apps.agenda

import centraid.core.v1.AgendaEvent
import centraid.core.v1.AgendaParties
import centraid.core.v1.AgendaUpcoming
import centraid.core.v1.AppQueryDenial
import centraid.screen.v1.AgendaChoice
import centraid.screen.v1.AgendaDraft
import centraid.screen.v1.AgendaEditorChrome
import centraid.screen.v1.AgendaEditorData
import centraid.screen.v1.AgendaEditorEvent
import centraid.screen.v1.AgendaEditorState
import centraid.screen.v1.AgendaGone
import centraid.screen.v1.AgendaScope
import centraid.screen.v1.AgendaScopeChoice
import centraid.screen.v1.Confirm
import centraid.screen.v1.Loading
import centraid.screen.v1.SeatState
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.AgendaCopy
import dev.centraid.shared.design.PartyHueWheel
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.kit.time.civilDayOf
import dev.centraid.shared.kit.time.dayOfMonthOf
import dev.centraid.shared.kit.time.epochDayOf
import dev.centraid.shared.kit.time.floorDiv
import dev.centraid.shared.kit.time.plusDays
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * WHAT THE EDITOR HOLDS BESIDE ITS SCREEN: the raw answers, the values as
 * loaded ([baseline] — what "changed" is measured against), the member's
 * [draft], the save scope picked, a save [attempt] count for the key, and
 * the device [zone] the last read was asked in — the zone a timed save's
 * wall clock is in.
 */
public data class AgendaEditorScreen(
    public val screen: AgendaEditorState,
    public val upcoming: AgendaUpcoming? = null,
    public val zone: String = "",
    public val parties: AgendaParties? = null,
    public val baseline: AgendaDraft? = null,
    public val draft: AgendaDraft? = null,
    public val scope: AgendaScope? = null,
    public val attempt: Int = 0,
    public val reading: Boolean = false,
    public val readQueued: Boolean = false,
)

public sealed interface AgendaEditorInput {
    public data class View(public val event: AgendaEditorEvent) : AgendaEditorInput

    /** [zone] is the device zone the read was asked in ([AgendaEditorReads]). */
    public data class Answered(
        public val upcoming: AgendaUpcoming?,
        public val parties: AgendaParties?,
        public val zone: String = "",
    ) : AgendaEditorInput

    public data class Denied(public val denial: AppQueryDenial) : AgendaEditorInput
}

/**
 * MAKE AN EVENT, OR CHANGE ONE (#1046 wave 5).
 *
 * ## Save is explicit
 *
 * Not autosave (#1015 D3's exception, ruled for this screen): a start time
 * typed half-way and saved is a wrong date on a calendar other people read,
 * which is worse than a lost draft. So Save is a button, armed only when the
 * draft is whole — a title, a calendar, an end after its start — and leaving
 * with changes asks ([AgendaEditorState.Asking.ASKING_DISCARD]).
 *
 * ## Which command
 *
 * - CREATE: `schedule.propose_event`.
 * - EDIT of a one-off, or of a series with "the whole series":
 *   `schedule.edit_event`, with the CHANGED fields only, clears spelt as the
 *   schema's `clear_*` flags.
 * - EDIT of one occurrence, or it and the ones after:
 *   `schedule.edit_event_occurrence`, `action: "override"`, keyed on the
 *   occurrence's `original_start_local`. A new repeat rule cannot ride it —
 *   the schema has no `rrule` — so a rule change is the whole series' alone,
 *   and moving the whole series' time is offered only from its first
 *   occurrence (moving the anchor from a later one would drop every
 *   occurrence before it).
 * - Skip: `edit_event_occurrence`, `action: "skip"`, scope `occurrence`.
 *
 * ## Time is civil, and the core resolves it
 *
 * A timed event is written as the wall clock the member picked —
 * `YYYY-MM-DDTHH:MM:00` — with `tz`, the device's zone the read was asked in:
 * the core turns the pair into an instant (`commands/event_time.rs`), because
 * `commonMain` computes no offset (`sync/Instants.kt`), and a clock the zone
 * skips is refused with the core's sentence. Only while no zone is known yet
 * does a save fall back to FLOATING, the wall clock alone. An all-day event is
 * its civil days, the end INCLUSIVE (`agenda.proto`).
 */
public object AgendaEditorMachine : ScreenMachine<AgendaEditorScreen, AgendaEditorInput> {
    public const val SCREEN_ID: String = "agenda.editor"

    public val TABLES: Set<String> = AgendaEventMachine.TABLES

    public const val REPEAT_NONE: String = "none"
    public const val REPEAT_DAILY: String = "daily"
    public const val REPEAT_WEEKLY: String = "weekly"
    public const val REPEAT_BIWEEKLY: String = "biweekly"
    public const val REPEAT_MONTHLY: String = "monthly"
    public const val REPEAT_YEARLY: String = "yearly"
    public const val REPEAT_CUSTOM: String = "custom"

    public const val REMINDER_NONE: String = "none"

    /** The rule each preset writes. The member reads the label, never these. */
    public val RULES: Map<String, String> = mapOf(
        REPEAT_DAILY to "FREQ=DAILY",
        REPEAT_WEEKLY to "FREQ=WEEKLY",
        REPEAT_BIWEEKLY to "FREQ=WEEKLY;INTERVAL=2",
        REPEAT_MONTHLY to "FREQ=MONTHLY",
        REPEAT_YEARLY to "FREQ=YEARLY",
    )

    /** v0's reminder leads, in minutes. */
    public val REMINDERS: List<Int> = listOf(0, 10, 30, 60, 1440)

    private const val DAY: Int = 10
    private const val MINUTES_PER_DAY: Long = 1440
    private const val HOUR: Long = 60
    private const val DEFAULT_START: String = "09:00"
    private const val DEFAULT_END: String = "10:00"

    override fun initial(): AgendaEditorScreen = AgendaEditorScreen(
        screen = AgendaEditorState(
            mode = AgendaEditorState.Mode.MODE_CREATE,
            loading = Loading(first_load = true),
            write = IDLE,
            sheet = AgendaEditorState.Sheet.SHEET_NONE,
            asking = AgendaEditorState.Asking.ASKING_NONE,
            chrome = CHROME,
        ),
    )

    override fun rowsChanged(table: String, keys: List<String>): AgendaEditorInput? =
        if (table in TABLES) {
            AgendaEditorInput.View(AgendaEditorEvent(rows_changed = AgendaEditorEvent.RowsChanged(table = table)))
        } else {
            null
        }

    override fun seatChanged(seat: SeatState): AgendaEditorInput =
        AgendaEditorInput.View(AgendaEditorEvent(seat_changed = AgendaEditorEvent.SeatChanged(seat = seat)))

    override fun reduce(state: AgendaEditorScreen, event: AgendaEditorInput): Step<AgendaEditorScreen> {
        val step = when (event) {
            is AgendaEditorInput.View -> view(state, event.event)
            is AgendaEditorInput.Answered -> answered(state, event)
            is AgendaEditorInput.Denied -> if (state.readQueued) {
                reissue(state)
            } else {
                Step(
                    state.copy(
                        reading = false,
                        screen = state.screen.copy(
                            loading = null,
                            failure = null,
                            data_ = null,
                            gone = null,
                            denied = AgendaFold.denied(event.denial),
                        ),
                    ),
                )
            }
        }
        return Step(fold(step.state), step.effects)
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    private fun view(state: AgendaEditorScreen, event: AgendaEditorEvent): Step<AgendaEditorScreen> {
        val screen = state.screen
        return when {
            event.opened != null -> {
                val o = event.opened
                val mode = o.mode.takeUnless { it == AgendaEditorState.Mode.MODE_UNSPECIFIED }
                    ?: if (o.event_id.isEmpty()) AgendaEditorState.Mode.MODE_CREATE else AgendaEditorState.Mode.MODE_EDIT
                read(
                    AgendaEditorScreen(
                        screen = initial().screen.copy(
                            seat = screen.seat,
                            mode = mode,
                            event_id = o.event_id,
                            instance_key = o.instance_key.ifEmpty { o.event_id },
                            original_start_local = o.original_start_local,
                            day = o.day,
                        ),
                        reading = state.reading,
                    ),
                )
            }

            // A RE-READ KEEPS THE DRAFT: a change elsewhere never overwrites
            // what the member is typing (the kit's autosave rule, kept here).
            event.refreshed != null || event.rows_changed != null -> read(state)

            event.refused != null -> if (state.readQueued) {
                reissue(state)
            } else if (state.draft != null) {
                Step(state.copy(reading = false))
            } else {
                Step(
                    state.copy(
                        reading = false,
                        screen = screen.copy(loading = null, data_ = null, gone = null, failure = event.refused.failure),
                    ),
                )
            }

            event.seat_changed != null -> Step(state.copy(screen = screen.copy(seat = event.seat_changed.seat)))

            event.title != null -> edit(state) { it.copy(title = event.title.text) }
            event.notes != null -> edit(state) { it.copy(notes = event.notes.text) }
            event.link != null -> edit(state) { it.copy(link = event.link.text) }
            event.all_day != null -> edit(state) { allDay(it, event.all_day.on) }
            event.start != null -> edit(state) { moveStart(it, event.start.day, event.start.time) ?: it }
            event.end != null -> edit(state) { setEnd(it, event.end.day, event.end.time) ?: it }

            event.calendar != null -> {
                val id = event.calendar.calendar_id
                if (state.upcoming?.calendars?.none { it.calendar_id == id } != false) {
                    Step(state)
                } else {
                    edit(closeSheet(state)) { it.copy(calendar_id = id) }
                }
            }

            event.guest != null -> {
                val id = event.guest.party_id
                if (guestChoices(state).none { it.first == id }) {
                    Step(state)
                } else {
                    edit(state) { d ->
                        d.copy(guest_ids = if (id in d.guest_ids) d.guest_ids - id else d.guest_ids + id)
                    }
                }
            }

            event.repeat != null -> {
                val key = event.repeat.key
                val allowed = repeatKeys(state)
                if (key !in allowed) Step(state) else edit(closeSheet(state)) { it.copy(repeat_key = key) }
            }

            event.reminder != null -> {
                val key = event.reminder.key
                if (key !in reminderKeys(state)) Step(state) else edit(closeSheet(state)) { it.copy(reminder_key = key) }
            }

            event.sheet_opened != null -> {
                val sheet = event.sheet_opened.sheet
                if (sheet == AgendaEditorState.Sheet.SHEET_UNSPECIFIED ||
                    sheet == AgendaEditorState.Sheet.SHEET_SCOPE ||
                    state.draft == null
                ) {
                    Step(state)
                } else {
                    Step(state.copy(screen = screen.copy(sheet = sheet)))
                }
            }

            event.sheet_closed != null -> Step(closeSheet(state))

            event.save != null -> save(state)

            event.scope != null -> {
                val scope = event.scope.scope
                val enabled = scopes(state).firstOrNull { it.scope == scope }?.enabled == true
                if (screen.sheet != AgendaEditorState.Sheet.SHEET_SCOPE || !enabled) {
                    Step(state)
                } else {
                    Step(state.copy(scope = scope))
                }
            }

            event.skip != null -> {
                val target = eventOf(state)
                if (target == null || !isSeriesOccurrence(state, target) || busy(state)) {
                    Step(state)
                } else {
                    Step(
                        state.copy(
                            screen = screen.copy(
                                asking = AgendaEditorState.Asking.ASKING_SKIP,
                                confirm = Confirm(
                                    title = AgendaCopy.CONFIRM_SKIP_TITLE,
                                    body = AgendaCopy.CONFIRM_SKIP_BODY,
                                    confirm_label = AgendaCopy.CONFIRM_SKIP,
                                    destructive = true,
                                ),
                            ),
                        ),
                    )
                }
            }

            event.leave != null ->
                if (dirty(state) && screen.write?.phase != WriteState.Phase.PHASE_COMMITTED) {
                    Step(
                        state.copy(
                            screen = screen.copy(
                                asking = AgendaEditorState.Asking.ASKING_DISCARD,
                                confirm = Confirm(
                                    title = if (screen.mode == AgendaEditorState.Mode.MODE_CREATE) {
                                        AgendaCopy.CONFIRM_DISCARD_NEW_TITLE
                                    } else {
                                        AgendaCopy.CONFIRM_DISCARD_TITLE
                                    },
                                    body = AgendaCopy.CONFIRM_DISCARD_BODY,
                                    confirm_label = AgendaCopy.QUICK_DISCARD,
                                    destructive = true,
                                ),
                            ),
                        ),
                    )
                } else {
                    Step(state.copy(screen = screen.copy(dismissed = true)))
                }

            event.confirmed != null -> when (screen.asking) {
                AgendaEditorState.Asking.ASKING_DISCARD -> Step(
                    state.copy(screen = screen.copy(dismissed = true, confirm = null, asking = AgendaEditorState.Asking.ASKING_NONE)),
                )
                AgendaEditorState.Asking.ASKING_SKIP -> skip(
                    state.copy(screen = screen.copy(confirm = null, asking = AgendaEditorState.Asking.ASKING_NONE)),
                )
                else -> Step(state)
            }

            event.confirm_dismissed != null -> Step(
                state.copy(screen = screen.copy(confirm = null, asking = AgendaEditorState.Asking.ASKING_NONE)),
            )

            event.write_settled != null -> {
                val step = WriteLaw.settled(LENS, state, event.write_settled)
                val write = step.state.screen.write
                if (event.write_settled.invoke_key == write?.invoke_key && event.write_settled.committed) {
                    // SAVED: the editor is done, and the re-read shows the rest.
                    Step(step.state.copy(screen = step.state.screen.copy(dismissed = true)))
                } else {
                    step
                }
            }

            else -> Step(state)
        }
    }

    private fun edit(state: AgendaEditorScreen, change: (AgendaDraft) -> AgendaDraft): Step<AgendaEditorScreen> {
        val draft = state.draft ?: return Step(state)
        if (busy(state)) return Step(state)
        return Step(state.copy(draft = change(draft)))
    }

    private fun closeSheet(state: AgendaEditorScreen): AgendaEditorScreen =
        state.copy(scope = null, screen = state.screen.copy(sheet = AgendaEditorState.Sheet.SHEET_NONE))

    // ---------------------------------------------------------------------
    // Civil time — the only arithmetic the editor does, on strings it was given
    // ---------------------------------------------------------------------

    /** Minutes since 1970-01-01T00:00 on the wall clock, or null for a malformed pair. */
    internal fun minutesOf(day: String, time: String): Long? {
        val epochDay = epochDayOf(day) ?: return null
        val clock = clockMinutes(time) ?: return null
        return epochDay * MINUTES_PER_DAY + clock
    }

    private fun clockMinutes(time: String): Long? {
        if (time.length != 5 || time[2] != ':') return null
        val hours = time.substring(0, 2).toLongOrNull() ?: return null
        val minutes = time.substring(3, 5).toLongOrNull() ?: return null
        if (hours !in 0..23 || minutes !in 0..59) return null
        return hours * HOUR + minutes
    }

    internal fun fromMinutes(minutes: Long): Pair<String, String> {
        val day = civilDayOf(floorDiv(minutes, MINUTES_PER_DAY))
        val clock = minutes - floorDiv(minutes, MINUTES_PER_DAY) * MINUTES_PER_DAY
        return day to "${(clock / HOUR).toString().padStart(2, '0')}:${(clock % HOUR).toString().padStart(2, '0')}"
    }

    /**
     * ALL-DAY ON keeps the days and makes the end no earlier than the start;
     * OFF gives a timed event its times back, or an hour at 09:00.
     */
    private fun allDay(draft: AgendaDraft, on: Boolean): AgendaDraft {
        if (on) {
            return draft.copy(all_day = true, end_day = maxOf(draft.end_day, draft.start_day))
        }
        val timed = draft.copy(
            all_day = false,
            start_time = draft.start_time.ifEmpty { DEFAULT_START },
            end_time = draft.end_time.ifEmpty { DEFAULT_END },
        )
        val start = minutesOf(timed.start_day, timed.start_time) ?: return timed
        val end = minutesOf(timed.end_day, timed.end_time)
        return if (end == null || end <= start) {
            val (day, time) = fromMinutes(start + HOUR)
            timed.copy(end_day = day, end_time = time)
        } else {
            timed
        }
    }

    /**
     * A NEW START MOVES THE END WITH IT, keeping the length: a meeting moved
     * to the afternoon is still an hour long, and an end left behind would be
     * an event that ends before it starts.
     */
    private fun moveStart(draft: AgendaDraft, day: String, time: String): AgendaDraft? {
        if (epochDayOf(day) == null) return null
        if (draft.all_day) {
            val shift = (epochDayOf(day) ?: return null) - (epochDayOf(draft.start_day) ?: return null)
            val end = plusDays(draft.end_day, shift.toInt()) ?: day
            return draft.copy(
                start_day = day,
                start_time = time.takeIf { clockMinutes(it) != null } ?: draft.start_time,
                end_day = end,
            )
        }
        val newTime = time.takeIf { clockMinutes(it) != null } ?: draft.start_time
        val before = minutesOf(draft.start_day, draft.start_time)
        val after = minutesOf(day, newTime) ?: return null
        val end = minutesOf(draft.end_day, draft.end_time)
        val moved = if (before != null && end != null) fromMinutes(end + (after - before)) else fromMinutes(after + HOUR)
        return draft.copy(start_day = day, start_time = newTime, end_day = moved.first, end_time = moved.second)
    }

    private fun setEnd(draft: AgendaDraft, day: String, time: String): AgendaDraft? {
        if (epochDayOf(day) == null) return null
        return draft.copy(end_day = day, end_time = time.takeIf { clockMinutes(it) != null } ?: draft.end_time)
    }

    /** The draft's range is an event's: an end after the start, or an all-day end no earlier. */
    internal fun rangeIsWhole(draft: AgendaDraft): Boolean {
        if (draft.all_day) {
            return epochDayOf(draft.start_day) != null && epochDayOf(draft.end_day) != null &&
                draft.end_day >= draft.start_day
        }
        val start = minutesOf(draft.start_day, draft.start_time) ?: return false
        val end = minutesOf(draft.end_day, draft.end_time) ?: return false
        return end > start
    }

    // ---------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------

    private fun read(state: AgendaEditorScreen): Step<AgendaEditorScreen> =
        if (state.reading) Step(state.copy(readQueued = true)) else reissue(state)

    private fun reissue(state: AgendaEditorScreen): Step<AgendaEditorScreen> = Step(
        state.copy(reading = true, readQueued = false),
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    private fun answered(state: AgendaEditorScreen, answer: AgendaEditorInput.Answered): Step<AgendaEditorScreen> {
        if (state.readQueued) return reissue(state)
        val upcoming = answer.upcoming
        val parties = answer.parties
        if (upcoming == null || parties == null) {
            return Step(
                state.copy(
                    reading = false,
                    screen = state.screen.copy(
                        loading = null,
                        data_ = null,
                        gone = null,
                        failure = Reads.refused(AgendaCopy.READ_INCOMPLETE),
                    ),
                ),
            )
        }
        val held = state.copy(
            upcoming = upcoming,
            parties = parties,
            reading = false,
            zone = answer.zone.ifEmpty { state.zone },
        )
        if (state.draft != null) return Step(held)
        val baseline = when (state.screen.mode) {
            AgendaEditorState.Mode.MODE_EDIT -> eventOf(held)?.let(::draftOf) ?: return Step(held)
            else -> newDraft(state.screen.day, upcoming)
        }
        return Step(held.copy(baseline = baseline, draft = baseline))
    }

    private fun eventOf(state: AgendaEditorScreen): AgendaEvent? = state.upcoming?.events?.firstOrNull {
        it.instance_key == state.screen.instance_key && it.event_id == state.screen.event_id
    }

    /** The values an occurrence has, as the editor binds them. */
    internal fun draftOf(event: AgendaEvent): AgendaDraft {
        val startDay = event.local_start.take(DAY)
        val startTime = CivilWords.clock(event.local_start).ifEmpty { DEFAULT_START }
        val (endDay, endTime) = when {
            event.all_day -> event.local_end.ifEmpty { event.local_start }.take(DAY) to DEFAULT_END
            event.local_end.isEmpty() ->
                minutesOf(startDay, startTime)?.let { fromMinutes(it + HOUR) } ?: (startDay to DEFAULT_END)
            else -> event.local_end.take(DAY) to CivilWords.clock(event.local_end)
        }
        return AgendaDraft(
            title = event.summary ?: "",
            notes = event.description ?: "",
            all_day = event.all_day,
            start_day = startDay,
            start_time = startTime,
            end_day = endDay,
            end_time = endTime,
            calendar_id = event.calendar_id ?: "",
            guest_ids = event.attendees.filter { !it.is_you }.map { it.party_id },
            repeat_key = repeatKeyOf(event.rrule),
            reminder_key = event.reminders.firstOrNull()?.minutes_before?.toString() ?: REMINDER_NONE,
            link = event.conferencing_uri ?: "",
        )
    }

    /**
     * A NEW EVENT'S DEFAULTS: on [day] (the home's anchor), or the core's
     * today; the next half hour after now on today, else 09:00; an hour
     * long; on the first calendar.
     */
    internal fun newDraft(day: String, upcoming: AgendaUpcoming): AgendaDraft {
        val on = day.ifEmpty { upcoming.today }
        val start = if (on == upcoming.today) {
            val now = CivilWords.clock(upcoming.now_local).let(::clockMinutes)
            val base = minutesOf(on, DEFAULT_START)
            if (now == null || base == null) {
                base
            } else {
                (epochDayOf(on) ?: 0) * MINUTES_PER_DAY + (now / HALF_HOUR + 1) * HALF_HOUR
            }
        } else {
            minutesOf(on, DEFAULT_START)
        }
        val (startDay, startTime) = start?.let(::fromMinutes) ?: (on to DEFAULT_START)
        val (endDay, endTime) = start?.let { fromMinutes(it + HOUR) } ?: (on to DEFAULT_END)
        return AgendaDraft(
            start_day = startDay,
            start_time = startTime,
            end_day = endDay,
            end_time = endTime,
            calendar_id = upcoming.calendars.firstOrNull()?.calendar_id ?: "",
            repeat_key = REPEAT_NONE,
            reminder_key = REMINDER_NONE,
        )
    }

    private const val HALF_HOUR: Long = 30

    /** A stored rule, as a preset key — or CUSTOM, kept as it is. */
    internal fun repeatKeyOf(rrule: String?): String {
        if (rrule.isNullOrBlank()) return REPEAT_NONE
        val parts = rrule.uppercase().split(';').filter { it.isNotBlank() }.toSet()
        return RULES.entries.firstOrNull { (_, rule) -> rule.split(';').toSet() == parts }?.key ?: REPEAT_CUSTOM
    }

    // ---------------------------------------------------------------------
    // Saving
    // ---------------------------------------------------------------------

    private fun save(state: AgendaEditorScreen): Step<AgendaEditorScreen> {
        if (!canSave(state)) return Step(state)
        if (state.screen.mode == AgendaEditorState.Mode.MODE_CREATE) return submit(state, propose(state))
        val event = eventOf(state) ?: return Step(state)
        if (!isSeriesOccurrence(state, event)) {
            return submit(state, editEvent(state, event))
        }
        if (state.screen.sheet != AgendaEditorState.Sheet.SHEET_SCOPE) {
            // WHICH OCCURRENCES — asked, never assumed.
            return Step(state.copy(scope = null, screen = state.screen.copy(sheet = AgendaEditorState.Sheet.SHEET_SCOPE)))
        }
        val scope = state.scope ?: return Step(state)
        val closed = closeSheet(state)
        return when (scope) {
            AgendaScope.AGENDA_SCOPE_SERIES -> submit(closed, editEvent(state, event))
            AgendaScope.AGENDA_SCOPE_OCCURRENCE, AgendaScope.AGENDA_SCOPE_FUTURE ->
                submit(closed, override(state, event, AgendaEventMachine.scopeWord(scope)))
            else -> Step(state)
        }
    }

    private fun skip(state: AgendaEditorScreen): Step<AgendaEditorScreen> {
        val event = eventOf(state) ?: return Step(state)
        val occurrence = event.original_start_local ?: return Step(state)
        return WriteLaw.submit(
            LENS,
            state,
            AgendaWrites.OCCURRENCE,
            AgendaWrites.skip(event.event_id, occurrence, "occurrence"),
            AgendaWrites.key(AgendaWrites.OCCURRENCE, event.event_id, occurrence, "occurrence", "skip"),
        )
    }

    /** A command and its input; the key is minted in [submit]. */
    internal data class Write(val command: String, val subject: String, val input: String)

    private fun submit(state: AgendaEditorScreen, write: Write): Step<AgendaEditorScreen> {
        val attempt = state.attempt + 1
        return WriteLaw.submit(
            LENS,
            state.copy(attempt = attempt),
            write.command,
            write.input,
            AgendaWrites.key(write.command, write.subject, write.input.hashCode().toUInt().toString(HEX), "try=$attempt"),
        )
    }

    private const val HEX: Int = 16

    /**
     * A draft's times, as the command takes them: all-day civil days with
     * their semantics; a timed wall clock with the device's [zone] (`tz`),
     * which the core resolves — or, with no zone known, floating.
     */
    internal fun times(json: AgendaWrites.Json, draft: AgendaDraft, zone: String): AgendaWrites.Json = when {
        draft.all_day ->
            json.str("dtstart", draft.start_day).str("dtend", draft.end_day).str("recurrence_semantics", ALL_DAY)
        zone.isNotEmpty() ->
            json.str("dtstart", "${draft.start_day}T${draft.start_time}:00")
                .str("dtend", "${draft.end_day}T${draft.end_time}:00")
                .str("tz", zone)
        else ->
            json.str("dtstart", "${draft.start_day}T${draft.start_time}:00")
                .str("dtend", "${draft.end_day}T${draft.end_time}:00")
                .str("recurrence_semantics", FLOATING)
    }

    internal fun propose(state: AgendaEditorScreen): Write {
        val draft = state.draft!!
        val json = AgendaWrites.Json()
            .str("summary", draft.title.trim())
        if (draft.notes.isNotBlank()) json.str("description", draft.notes.trim())
        times(json, draft, state.zone).str("calendar_id", draft.calendar_id)
        if (draft.guest_ids.isNotEmpty()) json.strings("attendee_party_ids", draft.guest_ids)
        RULES[draft.repeat_key]?.let { json.str("rrule", it) }
        if (draft.link.isNotBlank()) json.str("conferencing_uri", draft.link.trim())
        reminderOf(draft)?.let { json.reminders("reminders", it) }
        return Write(AgendaWrites.PROPOSE, AgendaWrites.NEW_SUBJECT, json.build())
    }

    /** `schedule.edit_event`: the changed fields, clears as `clear_*`. */
    internal fun editEvent(state: AgendaEditorScreen, event: AgendaEvent): Write {
        val draft = state.draft!!
        val base = state.baseline!!
        val json = AgendaWrites.Json().str("event_id", event.event_id)
        if (draft.title.trim() != base.title.trim()) json.str("summary", draft.title.trim())
        if (draft.notes.trim() != base.notes.trim()) {
            if (draft.notes.isBlank()) json.bool("clear_description", true) else json.str("description", draft.notes.trim())
        }
        if (timesChanged(draft, base)) times(json, draft, state.zone)
        if (draft.repeat_key != base.repeat_key) {
            val rule = RULES[draft.repeat_key]
            if (rule == null) json.bool("clear_rrule", true) else json.str("rrule", rule)
        }
        if (draft.calendar_id != base.calendar_id && draft.calendar_id.isNotEmpty()) {
            json.str("calendar_id", draft.calendar_id)
        }
        if (draft.link.trim() != base.link.trim()) {
            if (draft.link.isBlank()) json.bool("clear_conferencing", true) else json.str("conferencing_uri", draft.link.trim())
        }
        if (draft.reminder_key != base.reminder_key) json.reminders("reminders", reminderOf(draft))
        if (draft.guest_ids.toSet() != base.guest_ids.toSet()) json.strings("attendee_party_ids", guestsToSend(event, draft))
        return Write(AgendaWrites.EDIT, event.event_id, json.build())
    }

    /** `schedule.edit_event_occurrence`, `override`: the changed fields its schema takes. */
    internal fun override(state: AgendaEditorScreen, event: AgendaEvent, scope: String): Write {
        val draft = state.draft!!
        val base = state.baseline!!
        val json = AgendaWrites.Json()
            .str("event_id", event.event_id)
            .str("original_start_local", event.original_start_local ?: "")
            .str("scope", scope)
            .str("action", "override")
        if (timesChanged(draft, base)) times(json, draft, state.zone)
        if (draft.title.trim() != base.title.trim()) json.str("summary", draft.title.trim())
        if (draft.notes.trim() != base.notes.trim()) json.str("description", draft.notes.trim())
        if (draft.calendar_id != base.calendar_id && draft.calendar_id.isNotEmpty()) {
            json.str("calendar_id", draft.calendar_id)
        }
        if (draft.reminder_key != base.reminder_key) json.reminders("reminders", reminderOf(draft))
        if (draft.link.trim() != base.link.trim()) json.str("conferencing_uri", draft.link.trim())
        if (draft.guest_ids.toSet() != base.guest_ids.toSet()) json.strings("attendee_party_ids", guestsToSend(event, draft))
        return Write(AgendaWrites.OCCURRENCE, event.event_id, json.build())
    }

    /** THE OWNER STAYS ON THEIR OWN INVITATION: replacing the list never drops `is_you`. */
    private fun guestsToSend(event: AgendaEvent, draft: AgendaDraft): List<String> =
        event.attendees.filter { it.is_you }.map { it.party_id } + draft.guest_ids

    private fun reminderOf(draft: AgendaDraft): Int? = draft.reminder_key.toIntOrNull()

    private fun timesChanged(draft: AgendaDraft, base: AgendaDraft): Boolean =
        draft.all_day != base.all_day ||
            draft.start_day != base.start_day ||
            draft.end_day != base.end_day ||
            (!draft.all_day && (draft.start_time != base.start_time || draft.end_time != base.end_time))

    // ---------------------------------------------------------------------
    // The fold
    // ---------------------------------------------------------------------

    private fun dirty(state: AgendaEditorScreen): Boolean {
        val draft = state.draft ?: return false
        val base = state.baseline ?: return false
        return draft.title.trim() != base.title.trim() ||
            draft.notes.trim() != base.notes.trim() ||
            timesChanged(draft, base) ||
            draft.calendar_id != base.calendar_id ||
            draft.guest_ids.toSet() != base.guest_ids.toSet() ||
            draft.repeat_key != base.repeat_key ||
            draft.reminder_key != base.reminder_key ||
            draft.link.trim() != base.link.trim()
    }

    private fun busy(state: AgendaEditorScreen): Boolean =
        state.screen.write?.phase == WriteState.Phase.PHASE_IN_FLIGHT

    /** Why Save is not armed, or empty. */
    internal fun blocked(state: AgendaEditorScreen): String {
        val draft = state.draft ?: return ""
        return when {
            draft.title.isBlank() -> AgendaCopy.BLOCK_TITLE
            draft.calendar_id.isEmpty() && state.screen.mode == AgendaEditorState.Mode.MODE_CREATE ->
                AgendaCopy.BLOCK_CALENDAR
            !rangeIsWhole(draft) -> AgendaCopy.BLOCK_RANGE
            else -> ""
        }
    }

    private fun canSave(state: AgendaEditorScreen): Boolean =
        state.draft != null &&
            !busy(state) &&
            blocked(state).isEmpty() &&
            (state.screen.mode == AgendaEditorState.Mode.MODE_CREATE || dirty(state))

    private fun isSeriesOccurrence(state: AgendaEditorScreen, event: AgendaEvent): Boolean =
        state.screen.mode == AgendaEditorState.Mode.MODE_EDIT && AgendaEventMachine.isSeriesOccurrence(event)

    /**
     * THE SAVE SCOPES, and which this change can reach. A new rule is the
     * series' alone; moving the whole series' time is offered only from its
     * first occurrence.
     */
    internal fun scopes(state: AgendaEditorScreen): List<AgendaScopeChoice> {
        val draft = state.draft ?: return emptyList()
        val base = state.baseline ?: return emptyList()
        val event = eventOf(state) ?: return emptyList()
        val ruleChanged = draft.repeat_key != base.repeat_key
        val movesSeries = timesChanged(draft, base) && event.is_recurrence_instance
        return AgendaEventMachine.scopes(state.scope).map { choice ->
            when (choice.scope) {
                AgendaScope.AGENDA_SCOPE_SERIES ->
                    if (movesSeries) choice.copy(enabled = false, selected = false, note = AgendaCopy.SCOPE_MOVE_NOTE) else choice
                else ->
                    if (ruleChanged) choice.copy(enabled = false, selected = false, note = AgendaCopy.SCOPE_RULE_NOTE) else choice
            }
        }
    }

    private fun guestChoices(state: AgendaEditorScreen): List<Pair<String, String>> {
        val parties = state.parties?.parties.orEmpty().filter { !it.is_you }.map { it.party_id to it.name }
        val known = parties.map { it.first }.toSet()
        // A GUEST NOBODY LISTS (a party the picker leaves out) stays choosable.
        val invited = eventOf(state)?.attendees.orEmpty()
            .filter { !it.is_you && it.party_id !in known }
            .map { it.party_id to it.name }
        return parties + invited
    }

    private fun repeatKeys(state: AgendaEditorScreen): List<String> =
        listOf(REPEAT_NONE) + RULES.keys + listOfNotNull(REPEAT_CUSTOM.takeIf { state.baseline?.repeat_key == REPEAT_CUSTOM })

    private fun reminderKeys(state: AgendaEditorScreen): List<String> {
        val stored = state.baseline?.reminder_key?.toIntOrNull()
        val minutes = (REMINDERS + listOfNotNull(stored)).distinct().sorted()
        return listOf(REMINDER_NONE) + minutes.map { it.toString() }
    }

    private fun repeatLabel(key: String, day: String, state: AgendaEditorScreen): String {
        val weekday = AgendaFold.longDay(day).substringBefore(' ')
        val dayMonth = AgendaFold.longDay(day).substringAfter(' ')
        return when (key) {
            REPEAT_DAILY -> AgendaCopy.REPEAT_DAILY
            REPEAT_WEEKLY -> "${AgendaCopy.REPEAT_WEEKLY} $weekday"
            REPEAT_BIWEEKLY -> "${AgendaCopy.REPEAT_BIWEEKLY} $weekday"
            REPEAT_MONTHLY -> "${AgendaCopy.REPEAT_MONTHLY} ${CivilWords.ordinal(dayOfMonthOf(day) ?: 1)}"
            REPEAT_YEARLY -> "${AgendaCopy.REPEAT_YEARLY} $dayMonth"
            REPEAT_CUSTOM -> eventOf(state)?.recurrence_summary ?: AgendaCopy.FIELD_REPEAT
            else -> AgendaCopy.REPEAT_NEVER
        }
    }

    private fun fold(state: AgendaEditorScreen): AgendaEditorScreen {
        val screen = state.screen.copy(chrome = CHROME, write = state.screen.write ?: IDLE)
        val upcoming = state.upcoming
        val draft = state.draft
        if (screen.denied != null || (screen.failure != null && draft == null)) return state.copy(screen = screen)
        if (upcoming == null) return state.copy(screen = screen)
        if (draft == null) {
            // EDIT, and the occurrence is not in the answer.
            return state.copy(
                screen = screen.copy(
                    loading = null,
                    failure = null,
                    data_ = null,
                    gone = AgendaGone(
                        title = AgendaCopy.GONE_TITLE,
                        body = AgendaCopy.GONE_BODY,
                        action_label = AgendaCopy.GONE_ACTION,
                    ),
                ),
            )
        }
        val hues = AgendaFold.calendarHues(upcoming.calendars)
        val calendar = upcoming.calendars.firstOrNull { it.calendar_id == draft.calendar_id }
        val calendarName = calendar?.name?.takeIf { it.isNotBlank() }
            ?: if (draft.calendar_id.isEmpty()) AgendaCopy.NO_CALENDAR else AgendaCopy.CALENDAR_UNNAMED
        val guests = guestChoices(state)
        val chosen = guests.filter { it.first in draft.guest_ids }.map { it.second }
        val event = eventOf(state)
        val series = event != null && isSeriesOccurrence(state, event)
        val repeats = repeatKeys(state).map { key ->
            val label = repeatLabel(key, draft.start_day, state)
            AgendaChoice(key = key, label = label, selected = key == draft.repeat_key, accessibility_label = label)
        }
        val reminders = reminderKeys(state).map { key ->
            val label = key.toIntOrNull()?.let(AgendaEventMachine::reminderLabel) ?: AgendaCopy.REMINDER_NONE
            AgendaChoice(key = key, label = label, selected = key == draft.reminder_key, accessibility_label = label)
        }
        val blocked = blocked(state)
        val scopes = if (screen.sheet == AgendaEditorState.Sheet.SHEET_SCOPE) scopes(state) else emptyList()
        val data = AgendaEditorData(
            draft = draft,
            heading = if (screen.mode == AgendaEditorState.Mode.MODE_CREATE) AgendaCopy.NEW_EVENT else AgendaCopy.EDITOR_EDIT,
            start_label = dayTime(draft.start_day, draft.start_time, draft.all_day),
            end_label = dayTime(draft.end_day, draft.end_time, draft.all_day),
            start_day_label = AgendaFold.longDay(draft.start_day),
            start_time_label = if (draft.all_day) "" else draft.start_time,
            end_day_label = AgendaFold.longDay(draft.end_day),
            end_time_label = if (draft.all_day) "" else draft.end_time,
            calendar_label = calendarName,
            calendar_hue_key = hues(draft.calendar_id.ifEmpty { null }),
            calendars = upcoming.calendars.map { c ->
                val name = c.name?.takeIf { it.isNotBlank() } ?: AgendaCopy.CALENDAR_UNNAMED
                AgendaChoice(
                    key = c.calendar_id,
                    label = name,
                    selected = c.calendar_id == draft.calendar_id,
                    hue_key = hues(c.calendar_id),
                    accessibility_label = name,
                )
            },
            guests_label = if (chosen.isEmpty()) AgendaCopy.GUESTS_NONE else chosen.joinToString(", "),
            guests = guests.map { (id, name) ->
                AgendaChoice(
                    key = id,
                    label = name,
                    selected = id in draft.guest_ids,
                    hue_key = PartyHueWheel.identityHueKey(id),
                    accessibility_label = name,
                )
            },
            repeat_label = repeats.firstOrNull { it.selected }?.label ?: AgendaCopy.REPEAT_NEVER,
            repeats = repeats,
            repeat_enabled = true,
            repeat_note = if (series) AgendaCopy.REPEAT_SERIES_NOTE else "",
            reminder_label = reminders.firstOrNull { it.selected }?.label ?: AgendaCopy.REMINDER_NONE,
            reminders = reminders,
            scopes = scopes,
            dirty = dirty(state),
            can_save = canSave(state),
            blocked_reason = blocked,
            show_skip = series,
            skip_label = if (series) AgendaCopy.SCOPE_SKIP else "",
            foot_note = if (screen.mode == AgendaEditorState.Mode.MODE_CREATE) AgendaCopy.FOOT_NEW else "",
            scope_armed = scopes.any { it.selected && it.enabled },
        )
        return state.copy(screen = screen.copy(loading = null, failure = null, gone = null, data_ = data))
    }

    /** "Wednesday 11 March · 08:15", or the day alone all-day. */
    private fun dayTime(day: String, time: String, allDay: Boolean): String =
        if (allDay) AgendaFold.longDay(day) else "${AgendaFold.longDay(day)} · $time"

    private const val ALL_DAY: String = "all-day"
    private const val FLOATING: String = "floating"

    private val IDLE: WriteState = WriteState(phase = WriteState.Phase.PHASE_IDLE)

    private val LENS: WriteLens<AgendaEditorScreen> = object : WriteLens<AgendaEditorScreen> {
        override fun write(state: AgendaEditorScreen): WriteState = state.screen.write ?: IDLE

        override fun with(state: AgendaEditorScreen, write: WriteState): AgendaEditorScreen =
            state.copy(screen = state.screen.copy(write = write))
    }

    private val CHROME: AgendaEditorChrome = AgendaEditorChrome(
        title_placeholder = AgendaCopy.PLACEHOLDER_TITLE,
        notes_placeholder = AgendaCopy.PLACEHOLDER_NOTES,
        link_placeholder = AgendaCopy.PLACEHOLDER_LINK,
        field_title = AgendaCopy.FIELD_SUMMARY,
        field_all_day = AgendaCopy.FIELD_ALL_DAY,
        field_starts = AgendaCopy.FIELD_STARTS,
        field_ends = AgendaCopy.FIELD_ENDS,
        field_calendar = AgendaCopy.FIELD_CALENDAR,
        field_guests = AgendaCopy.FIELD_GUESTS,
        field_repeat = AgendaCopy.FIELD_REPEAT,
        field_reminder = AgendaCopy.FIELD_REMINDER,
        field_link = AgendaCopy.FIELD_WHERE,
        field_notes = AgendaCopy.FIELD_NOTES,
        save = AgendaCopy.SAVE,
        close = AgendaCopy.CLOSE,
        done = AgendaCopy.DONE,
        keep_editing = AgendaCopy.KEEP_EDITING,
        loading = AgendaCopy.LOADING,
        retry = AgendaCopy.RETRY,
        scope_title = AgendaCopy.SCOPE_TITLE,
        scope_question = AgendaCopy.SCOPE_QUESTION,
        pick_date = AgendaCopy.PICK_DATE,
        pick_time = AgendaCopy.PICK_TIME,
    )
}
