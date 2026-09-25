package dev.centraid.shared.apps.agenda

import centraid.core.v1.AgendaAttendee
import centraid.core.v1.AgendaEvent
import centraid.core.v1.AgendaEventDetail
import centraid.core.v1.AgendaUpcoming
import centraid.core.v1.AppQueryDenial
import centraid.screen.v1.AgendaAction
import centraid.screen.v1.AgendaEventChrome
import centraid.screen.v1.AgendaEventData
import centraid.screen.v1.AgendaEventEvent
import centraid.screen.v1.AgendaEventState
import centraid.screen.v1.AgendaFact
import centraid.screen.v1.AgendaGone
import centraid.screen.v1.AgendaGuestRow
import centraid.screen.v1.AgendaParkedCard
import centraid.screen.v1.AgendaRsvp
import centraid.screen.v1.AgendaRsvpChoice
import centraid.screen.v1.AgendaScope
import centraid.screen.v1.AgendaScopeChoice
import centraid.screen.v1.Confirm
import centraid.screen.v1.Loading
import centraid.screen.v1.SeatState
import centraid.screen.v1.StatusChip
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.AgendaCopy
import dev.centraid.shared.design.PartyHueWheel
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.kit.time.plusDays
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * WHAT THE DETAIL HOLDS BESIDE ITS SCREEN. [detail] is the raw `agenda.event`
 * answer and [answer] the `upcoming` one read for its calendars (the home's
 * reason: a local change re-folds without a read); [held] is the session's
 * [AgendaMarks] list; [sentPartstat] is the reply just sent, drawn before the
 * vault has it (optimistic); [cancelScope] the scope sheet's pick.
 * [reading]/[readQueued] keep one read in flight.
 */
public data class AgendaEventScreen(
    public val screen: AgendaEventState,
    public val answer: AgendaUpcoming? = null,
    public val detail: AgendaEventDetail? = null,
    public val held: List<AgendaMarks.Held> = emptyList(),
    public val sentPartstat: String? = null,
    public val cancelScope: AgendaScope? = null,
    public val reading: Boolean = false,
    public val readQueued: Boolean = false,
)

/** A view's event, the core's answer, or the session's held writes. */
public sealed interface AgendaEventInput {
    public data class View(public val event: AgendaEventEvent) : AgendaEventInput

    /** `agenda.event`'s answer, and `upcoming`'s for the calendars; null where not answered. */
    public data class Answered(
        public val upcoming: AgendaUpcoming?,
        public val detail: AgendaEventDetail?,
    ) : AgendaEventInput

    public data class Denied(public val denial: AppQueryDenial) : AgendaEventInput

    public data class Held(public val held: List<AgendaMarks.Held>) : AgendaEventInput
}

/**
 * ONE EVENT ON THE PHONE (#1046 wave 4): what it is, who is coming, the
 * member's reply, Edit, and Cancel.
 *
 * ## The occurrence is read by its key
 *
 * The read is `agenda.event` for the picked `event_id` and occurrence, so an
 * occurrence far from any window is found; `agenda.upcoming` over today only
 * rides beside it for the calendars' names and hues. An answer with no event
 * is [AgendaGone]: cancelled, moved or deleted since.
 *
 * ## Writes
 *
 * - **RSVP** (`schedule.respond_rsvp`) as the vault owner's own attendee row —
 *   `is_you`, never the first guest. The chip moves at once
 *   ([AgendaEventScreen.sentPartstat]); a refusal puts it back and says why.
 *   A reply is to the SERIES (`event_id`), and a series says so.
 * - **Cancel.** The phone is the vault's owner, so a cancellation EXECUTES —
 *   v0's "ask to cancel, held for the owner" is a sharing-era state (#1029).
 *   A one-off asks [Confirm] first; a series asks the scope sheet, which IS its
 *   confirm (the handoff's, no scope pre-chosen): this occurrence and this and
 *   the ones after are `edit_event_occurrence` skips, the whole series is
 *   `cancel_event`. A committed cancellation ends the screen ([dismissed]).
 *
 * A write this screen left behind and the vault refused comes back as the
 * parked card, from [AgendaMarks], with Try again and Dismiss.
 */
public object AgendaEventMachine : ScreenMachine<AgendaEventScreen, AgendaEventInput> {
    public const val SCREEN_ID: String = "agenda.event"

    /** The tables `agenda.event` and `agenda.upcoming` read for one event — its place's name too. */
    public val TABLES: Set<String> = setOf(
        "core_event",
        "schedule_event_ext",
        "schedule_attendee",
        "schedule_recurrence_exception",
        "schedule_calendar",
        "core_party",
        "core_place",
    )

    public const val ACTION_EDIT: String = "edit"
    public const val ACTION_CANCEL: String = "cancel"

    public const val ACCEPTED: String = "accepted"
    public const val TENTATIVE: String = "tentative"
    public const val DECLINED: String = "declined"

    private const val DAY: Int = 10

    override fun initial(): AgendaEventScreen = AgendaEventScreen(
        screen = AgendaEventState(
            loading = Loading(first_load = true),
            write = IDLE,
            sheet = AgendaEventState.Sheet.SHEET_NONE,
            chrome = CHROME,
        ),
    )

    override fun rowsChanged(table: String, keys: List<String>): AgendaEventInput? =
        if (table in TABLES) {
            AgendaEventInput.View(
                AgendaEventEvent(rows_changed = AgendaEventEvent.RowsChanged(table = table)),
            )
        } else {
            null
        }

    override fun seatChanged(seat: SeatState): AgendaEventInput =
        AgendaEventInput.View(AgendaEventEvent(seat_changed = AgendaEventEvent.SeatChanged(seat = seat)))

    override fun reduce(state: AgendaEventScreen, event: AgendaEventInput): Step<AgendaEventScreen> {
        val step = when (event) {
            is AgendaEventInput.View -> view(state, event.event)
            is AgendaEventInput.Answered -> answered(state, event.upcoming, event.detail)
            is AgendaEventInput.Denied -> if (state.readQueued) {
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
            is AgendaEventInput.Held -> Step(state.copy(held = event.held))
        }
        return Step(fold(step.state), step.effects)
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    private fun view(state: AgendaEventScreen, event: AgendaEventEvent): Step<AgendaEventScreen> {
        val screen = state.screen
        return when {
            event.opened != null -> {
                val o = event.opened
                read(
                    AgendaEventScreen(
                        screen = initial().screen.copy(
                            seat = screen.seat,
                            event_id = o.event_id,
                            instance_key = o.instance_key.ifEmpty { o.event_id },
                            original_start_local = o.original_start_local,
                            day = o.day,
                        ),
                        held = state.held,
                        // A READ STILL OUT is for the last event: queue behind it.
                        reading = state.reading,
                    ),
                )
            }

            event.refreshed != null || event.rows_changed != null -> read(state)

            // A FAILED RE-READ KEEPS THE EVENT ON SCREEN: only a first read
            // that failed has nothing else to show.
            event.refused != null -> if (state.readQueued) {
                reissue(state)
            } else if (state.detail != null && screen.data_ != null) {
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

            event.rsvp != null -> rsvp(state, event.rsvp.partstat)

            event.action != null -> when (event.action.key) {
                // AN INTENT: the shell opens the editor on this occurrence.
                ACTION_EDIT -> Step(state)
                ACTION_CANCEL -> askCancel(state)
                else -> Step(state)
            }

            event.scope != null -> {
                val scope = event.scope.scope
                if (screen.sheet != AgendaEventState.Sheet.SHEET_CANCEL_SCOPE ||
                    scope == AgendaScope.AGENDA_SCOPE_UNSPECIFIED
                ) {
                    Step(state)
                } else {
                    Step(state.copy(cancelScope = scope))
                }
            }

            event.sheet_closed != null -> Step(
                state.copy(cancelScope = null, screen = screen.copy(sheet = AgendaEventState.Sheet.SHEET_NONE)),
            )

            event.confirmed != null -> confirmed(state)

            event.confirm_dismissed != null -> Step(state.copy(screen = screen.copy(confirm = null)))

            event.write_settled != null -> settled(state, event.write_settled)

            event.parked_retried != null -> {
                val parked = parkedOf(state) ?: return Step(state)
                val sent = if (parked.kind == AgendaMarks.Kind.RSVP) partstatOf(parked.inputJson) else state.sentPartstat
                WriteLaw.submit(
                    LENS,
                    state.copy(sentPartstat = sent),
                    parked.command,
                    parked.inputJson,
                    "${parked.invokeKey}:again",
                )
            }

            // The bridge clears the session's store; its next list redraws.
            event.parked_dismissed != null -> Step(state)

            else -> Step(state)
        }
    }

    private fun rsvp(state: AgendaEventScreen, partstat: String): Step<AgendaEventScreen> {
        val event = eventOf(state) ?: return Step(state)
        val you = event.attendees.firstOrNull { it.is_you } ?: return Step(state)
        if (partstat !in ANSWERS || inFlight(state)) return Step(state)
        if ((state.sentPartstat ?: you.partstat) == partstat) return Step(state)
        return WriteLaw.submit(
            LENS,
            state.copy(sentPartstat = partstat),
            AgendaWrites.RSVP,
            AgendaWrites.rsvp(event.event_id, you.party_id, partstat),
            AgendaWrites.key(AgendaWrites.RSVP, event.event_id, you.party_id, partstat),
        )
    }

    private fun askCancel(state: AgendaEventScreen): Step<AgendaEventScreen> {
        val event = eventOf(state) ?: return Step(state)
        if (inFlight(state)) return Step(state)
        return if (isSeriesOccurrence(event)) {
            Step(
                state.copy(
                    cancelScope = null,
                    screen = state.screen.copy(sheet = AgendaEventState.Sheet.SHEET_CANCEL_SCOPE, confirm = null),
                ),
            )
        } else {
            Step(
                state.copy(
                    screen = state.screen.copy(
                        confirm = Confirm(
                            title = AgendaCopy.CONFIRM_CANCEL_TITLE,
                            body = AgendaCopy.CONFIRM_CANCEL_BODY,
                            confirm_label = AgendaCopy.CANCEL_EVENT,
                            destructive = true,
                        ),
                    ),
                ),
            )
        }
    }

    private fun confirmed(state: AgendaEventScreen): Step<AgendaEventScreen> {
        val event = eventOf(state) ?: return Step(state)
        val screen = state.screen
        if (screen.confirm != null) {
            return WriteLaw.submit(
                LENS,
                state.copy(screen = screen.copy(confirm = null)),
                AgendaWrites.CANCEL,
                AgendaWrites.cancel(event.event_id),
                AgendaWrites.key(AgendaWrites.CANCEL, event.event_id),
            )
        }
        if (screen.sheet != AgendaEventState.Sheet.SHEET_CANCEL_SCOPE) return Step(state)
        val scope = state.cancelScope ?: return Step(state)
        val closed = state.copy(cancelScope = null, screen = screen.copy(sheet = AgendaEventState.Sheet.SHEET_NONE))
        val occurrence = event.original_start_local ?: return Step(state)
        return when (scope) {
            AgendaScope.AGENDA_SCOPE_SERIES -> WriteLaw.submit(
                LENS,
                closed,
                AgendaWrites.CANCEL,
                AgendaWrites.cancel(event.event_id),
                AgendaWrites.key(AgendaWrites.CANCEL, event.event_id),
            )
            AgendaScope.AGENDA_SCOPE_OCCURRENCE, AgendaScope.AGENDA_SCOPE_FUTURE -> {
                val word = scopeWord(scope)
                WriteLaw.submit(
                    LENS,
                    closed,
                    AgendaWrites.OCCURRENCE,
                    AgendaWrites.skip(event.event_id, occurrence, word),
                    AgendaWrites.key(AgendaWrites.OCCURRENCE, event.event_id, occurrence, word, "skip"),
                )
            }
            else -> Step(state)
        }
    }

    private fun settled(
        state: AgendaEventScreen,
        answer: WriteSettled,
    ): Step<AgendaEventScreen> {
        val key = state.screen.write?.invoke_key ?: ""
        val kind = writeKind(state)
        val step = WriteLaw.settled(LENS, state, answer)
        if (answer.invoke_key != key) return step
        return when {
            // THE EVENT IS OFF THE CALENDAR: the screen is done.
            answer.committed && kind == AgendaMarks.Kind.CANCEL -> Step(step.state.copy(screen = step.state.screen.copy(dismissed = true)))
            // A REFUSED REPLY PUTS THE CHIP BACK; the refusal says why.
            !answer.committed && kind == AgendaMarks.Kind.RSVP -> Step(step.state.copy(sentPartstat = null))
            else -> step
        }
    }

    // ---------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------

    private fun read(state: AgendaEventScreen): Step<AgendaEventScreen> =
        if (state.reading) {
            Step(state.copy(readQueued = true))
        } else {
            reissue(state)
        }

    private fun reissue(state: AgendaEventScreen): Step<AgendaEventScreen> = Step(
        state.copy(reading = true, readQueued = false),
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    private fun answered(
        state: AgendaEventScreen,
        upcoming: AgendaUpcoming?,
        detail: AgendaEventDetail?,
    ): Step<AgendaEventScreen> {
        if (state.readQueued) return reissue(state)
        if (upcoming == null || detail == null) {
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
        val found = find(state.screen, detail)
        // THE REPLY ON RECORD CAUGHT UP: the optimistic one is no longer needed.
        val sent = state.sentPartstat?.takeUnless { sent ->
            found?.attendees?.any { it.is_you && it.partstat == sent } == true
        }
        return Step(state.copy(answer = upcoming, detail = detail, reading = false, sentPartstat = sent))
    }

    /** The answered event, when it is the series this screen is on. */
    private fun find(screen: AgendaEventState, detail: AgendaEventDetail): AgendaEvent? =
        detail.event?.takeIf { it.event_id == screen.event_id }

    private fun eventOf(state: AgendaEventScreen): AgendaEvent? =
        state.detail?.let { find(state.screen, it) }

    // ---------------------------------------------------------------------
    // The fold — every string a view draws
    // ---------------------------------------------------------------------

    private fun fold(state: AgendaEventScreen): AgendaEventScreen {
        val screen = state.screen
        val base = screen.copy(
            chrome = CHROME,
            write = screen.write ?: IDLE,
            parked = parkedOf(state)?.let(::parkedCard),
            cancel_scopes = if (screen.sheet == AgendaEventState.Sheet.SHEET_CANCEL_SCOPE) {
                scopes(state.cancelScope)
            } else {
                emptyList()
            },
            cancel_armed = screen.sheet == AgendaEventState.Sheet.SHEET_CANCEL_SCOPE && state.cancelScope != null,
        )
        val answer = state.answer
        val detail = state.detail
        if (answer == null || detail == null || screen.denied != null || (screen.failure != null && screen.data_ == null)) {
            return state.copy(screen = base)
        }
        val event = find(screen, detail)
        if (event == null) {
            return state.copy(
                screen = base.copy(
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
        return state.copy(
            screen = base.copy(
                loading = null,
                failure = null,
                gone = null,
                data_ = data(state, event, answer, detail),
            ),
        )
    }

    private fun data(
        state: AgendaEventScreen,
        event: AgendaEvent,
        answer: AgendaUpcoming,
        detail: AgendaEventDetail,
    ): AgendaEventData {
        val title = event.summary?.takeIf { it.isNotBlank() } ?: AgendaCopy.UNTITLED
        val calendar = answer.calendars.firstOrNull { it.calendar_id == event.calendar_id }
        val calendarName = when {
            event.calendar_id == null -> AgendaCopy.NO_CALENDAR
            else -> calendar?.name?.takeIf { it.isNotBlank() } ?: AgendaCopy.CALENDAR_UNNAMED
        }
        val dateLabel = dateLabel(event)
        val (when_, spoken) = whenOf(event)
        val busy = inFlight(state)
        val reminder = event.reminders.firstOrNull()?.minutes_before?.let { reminderLabel(it.toInt()) }
        val place = event.location_name?.trim()?.takeIf { it.isNotEmpty() }
        val callUri = event.conferencing_uri?.trim() ?: ""
        val facts = listOfNotNull(
            event.recurrence_summary?.takeIf { it.isNotBlank() }?.let { AgendaFact(label = AgendaCopy.FIELD_REPEAT, detail = it) },
            place?.let { AgendaFact(label = AgendaCopy.FIELD_PLACE, detail = it) },
            callUri.takeIf { it.isNotEmpty() }?.let { AgendaFact(label = AgendaCopy.FIELD_WHERE, detail = it) },
            reminder?.let { AgendaFact(label = AgendaCopy.FIELD_REMINDER, detail = it) },
            AgendaFact(label = AgendaCopy.FIELD_CALENDAR, detail = calendarName),
        )
        val youReply = { attendee: AgendaAttendee ->
            if (attendee.is_you) state.sentPartstat ?: attendee.partstat else attendee.partstat
        }
        val guests = event.attendees.map { attendee ->
            val reply = replyLabel(youReply(attendee))
            val name = attendee.name.ifBlank { AgendaCopy.CALENDAR_UNNAMED }
            val shown = if (attendee.is_you) "$name · ${AgendaCopy.GUEST_YOU}" else name
            AgendaGuestRow(
                party_id = attendee.party_id,
                name = shown,
                initial = name.firstOrNull { it.isLetterOrDigit() }?.uppercaseChar()?.toString() ?: "",
                reply_label = reply,
                hue_key = PartyHueWheel.identityHueKey(attendee.party_id),
                is_you = attendee.is_you,
                accessibility_label = "$shown, $reply",
            )
        }
        val awaiting = event.attendees.count { youReply(it).let { p -> p.isEmpty() || p == NEEDS_ACTION } }
        val guestHeading = if (event.attendees.isEmpty()) {
            ""
        } else {
            val n = event.attendees.size
            val head = "$n ${if (n == 1) AgendaCopy.META_GUEST else AgendaCopy.META_GUESTS}"
            if (awaiting == 0) head else "$head · $awaiting ${AgendaCopy.GUEST_AWAITING}"
        }
        val you = event.attendees.firstOrNull { it.is_you }
        val series = event.recurrence_summary != null
        val rsvp = you?.let {
            val current = state.sentPartstat ?: it.partstat
            AgendaRsvp(
                question = AgendaCopy.RSVP_QUESTION,
                choices = ANSWERS.map { partstat ->
                    AgendaRsvpChoice(
                        partstat = partstat,
                        label = replyLabel(partstat),
                        selected = current == partstat,
                        enabled = !busy,
                    )
                },
                note = if (series) AgendaCopy.RSVP_SERIES_NOTE else "",
            )
        }
        val ownCancel = busy && writeKind(state) == AgendaMarks.Kind.CANCEL
        val heldKinds = state.held
            .filter { it.eventId == event.event_id && it.phase == AgendaMarks.Phase.IN_FLIGHT }
            .map { it.kind }
        val chip = when {
            ownCancel || AgendaMarks.Kind.CANCEL in heldKinds ->
                StatusChip(label = AgendaCopy.STATUS_CANCEL_ASKED, tone = StatusChip.Tone.TONE_NET)
            busy || heldKinds.isNotEmpty() ->
                StatusChip(label = AgendaCopy.STATUS_PENDING, tone = StatusChip.Tone.TONE_NEUTRAL)
            else -> null
        }
        val cancelLabel = if (isSeriesOccurrence(event)) AgendaCopy.CANCEL_SERIES else AgendaCopy.CANCEL_EVENT
        return AgendaEventData(
            title = title,
            date_label = dateLabel,
            when_label = when_,
            calendar_name = calendarName,
            calendar_hue_key = AgendaFold.calendarHues(answer.calendars)(event.calendar_id),
            facts = facts,
            notes = event.description?.trim() ?: "",
            chip = chip,
            guest_heading = guestHeading,
            guests = guests,
            rsvp = rsvp,
            actions = listOf(
                AgendaAction(
                    key = ACTION_EDIT,
                    label = AgendaCopy.ACTION_EDIT,
                    enabled = !busy,
                    destructive = false,
                    accessibility_label = AgendaCopy.A11Y_EDIT,
                ),
                AgendaAction(
                    key = ACTION_CANCEL,
                    label = cancelLabel,
                    enabled = !busy,
                    destructive = true,
                    accessibility_label = AgendaCopy.A11Y_CANCEL,
                ),
            ),
            is_past = ended(event, detail.today, detail.now_local),
            accessibility_label = listOfNotNull(
                title,
                dateLabel,
                spoken,
                place,
                AgendaCopy.META_REPEATS.takeIf { series },
                chip?.label,
            ).joinToString(", "),
            call_uri = callUri,
            call_label = if (callUri.isEmpty()) "" else AgendaCopy.JOIN_CALL,
        )
    }

    /** "Wednesday 11 March", or a range when the occurrence spans days. */
    internal fun dateLabel(event: AgendaEvent): String {
        val start = event.local_start.take(DAY)
        if (start.length < DAY) return ""
        val end = lastDay(event)
        return if (end > start) "${AgendaFold.longDay(start)} – ${AgendaFold.longDay(end)}" else AgendaFold.longDay(start)
    }

    /** The last civil day an occurrence is on — a timed end at midnight is the day before. */
    private fun lastDay(event: AgendaEvent): String {
        val end = event.local_end
        if (end.isEmpty()) return event.local_start.take(DAY)
        if (event.all_day) return end.take(DAY)
        val day = end.take(DAY)
        return if (CivilWords.clock(end) == MIDNIGHT) plusDays(day, -1) ?: day else day
    }

    /** "08:15 – 09:45" and "08:15 to 09:45"; "All day". */
    private fun whenOf(event: AgendaEvent): Pair<String, String> {
        if (event.all_day) return AgendaCopy.ALL_DAY to AgendaCopy.ALL_DAY
        val from = CivilWords.clock(event.local_start)
        val to = CivilWords.clock(event.local_end)
        return if (to.isEmpty() || event.local_end == event.local_start) {
            from to from
        } else {
            "$from – $to" to "$from ${AgendaCopy.SPOKEN_TO} $to"
        }
    }

    private fun ended(event: AgendaEvent, today: String, now: String): Boolean = when {
        event.all_day -> event.local_end.ifEmpty { event.local_start }.take(DAY) < today
        event.local_end.isEmpty() -> event.local_start < now
        else -> event.local_end <= now
    }

    /** "30 minutes before" — the reminder leads v0 offered. */
    internal fun reminderLabel(minutes: Int): String = when (minutes) {
        0 -> AgendaCopy.REMINDER_AT_START
        60 -> AgendaCopy.REMINDER_HOUR
        1440 -> AgendaCopy.REMINDER_DAY
        else -> "$minutes ${AgendaCopy.REMINDER_MINUTES}"
    }

    /** A reply, in words. A partstat this seat does not know is unanswered. */
    internal fun replyLabel(partstat: String): String = when (partstat) {
        ACCEPTED -> AgendaCopy.RSVP_YES
        TENTATIVE -> AgendaCopy.RSVP_MAYBE
        DECLINED -> AgendaCopy.RSVP_NO
        else -> AgendaCopy.RSVP_AWAITING
    }

    /** The three scope rows, none filled until picked. */
    internal fun scopes(picked: AgendaScope?): List<AgendaScopeChoice> = listOf(
        AgendaScope.AGENDA_SCOPE_OCCURRENCE to AgendaCopy.SCOPE_OCCURRENCE,
        AgendaScope.AGENDA_SCOPE_FUTURE to AgendaCopy.SCOPE_FUTURE,
        AgendaScope.AGENDA_SCOPE_SERIES to AgendaCopy.SCOPE_SERIES,
    ).map { (scope, label) -> AgendaScopeChoice(scope = scope, label = label, selected = picked == scope, enabled = true) }

    private fun parkedCard(held: AgendaMarks.Held): AgendaParkedCard = AgendaParkedCard(
        title = when (held.kind) {
            AgendaMarks.Kind.CANCEL -> AgendaCopy.PARKED_CANCEL_TITLE
            AgendaMarks.Kind.RSVP -> AgendaCopy.PARKED_RSVP_TITLE
            else -> AgendaCopy.PARKED_EDIT_TITLE
        },
        body = held.sentence.ifEmpty { AgendaCopy.PARKED_BODY },
        retry_label = AgendaCopy.PARKED_RETRY,
        dismiss_label = AgendaCopy.PARKED_DISMISS,
    )

    /**
     * THE REFUSAL THIS SCREEN DID NOT SEE: a held write for this event the
     * vault refused, that is not the one [AgendaEventState.write] already
     * shows inline.
     */
    private fun parkedOf(state: AgendaEventScreen): AgendaMarks.Held? = state.held.lastOrNull {
        it.eventId == state.screen.event_id &&
            it.phase == AgendaMarks.Phase.REFUSED &&
            it.invokeKey != state.screen.write?.invoke_key
    }

    private fun partstatOf(input: String): String? =
        ANSWERS.firstOrNull { input.contains("\"partstat\":\"$it\"") }

    internal fun isSeriesOccurrence(event: AgendaEvent): Boolean =
        event.recurrence_summary != null && !event.original_start_local.isNullOrEmpty()

    internal fun scopeWord(scope: AgendaScope): String = when (scope) {
        AgendaScope.AGENDA_SCOPE_OCCURRENCE -> "occurrence"
        AgendaScope.AGENDA_SCOPE_FUTURE -> "future"
        else -> "series"
    }

    private fun inFlight(state: AgendaEventScreen): Boolean =
        state.screen.write?.phase == WriteState.Phase.PHASE_IN_FLIGHT

    private fun writeKind(state: AgendaEventScreen): AgendaMarks.Kind? {
        val key = state.screen.write?.invoke_key ?: return null
        return when {
            key.startsWith(AgendaWrites.CANCEL) -> AgendaMarks.Kind.CANCEL
            key.startsWith(AgendaWrites.OCCURRENCE) && key.contains(":skip") -> AgendaMarks.Kind.CANCEL
            key.startsWith(AgendaWrites.RSVP) -> AgendaMarks.Kind.RSVP
            else -> AgendaMarks.Kind.EDIT
        }
    }

    private val ANSWERS: List<String> = listOf(ACCEPTED, TENTATIVE, DECLINED)
    private const val NEEDS_ACTION: String = "needs-action"
    private const val MIDNIGHT: String = "00:00"

    private val IDLE: WriteState = WriteState(phase = WriteState.Phase.PHASE_IDLE)

    private val LENS: WriteLens<AgendaEventScreen> = object : WriteLens<AgendaEventScreen> {
        override fun write(state: AgendaEventScreen): WriteState = state.screen.write ?: IDLE

        override fun with(state: AgendaEventScreen, write: WriteState): AgendaEventScreen =
            state.copy(screen = state.screen.copy(write = write))
    }

    private val CHROME: AgendaEventChrome = AgendaEventChrome(
        title = AgendaCopy.EVENT_TITLE,
        back = AgendaCopy.APP_TITLE,
        loading = AgendaCopy.LOADING,
        retry = AgendaCopy.RETRY,
        scope_title = AgendaCopy.CANCEL_SCOPE_TITLE,
        scope_body = AgendaCopy.CANCEL_SCOPE_BODY,
        scope_commit = AgendaCopy.CANCEL_EVENT,
        scope_keep = AgendaCopy.KEEP_IT,
        confirm_keep = AgendaCopy.KEEP_IT,
    )
}
