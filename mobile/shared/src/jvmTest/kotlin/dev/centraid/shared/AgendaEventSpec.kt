package dev.centraid.shared

import centraid.core.v1.AgendaAttendee
import centraid.core.v1.AgendaCalendar
import centraid.core.v1.AgendaEvent
import centraid.core.v1.AgendaEventDetail
import centraid.core.v1.AgendaReminder
import centraid.core.v1.AgendaUpcoming
import centraid.core.v1.AppQueryDenial
import centraid.core.v1.CommandStatus
import centraid.screen.v1.AgendaEventEvent
import centraid.screen.v1.AgendaEventState
import centraid.screen.v1.AgendaHomeEvent
import centraid.screen.v1.AgendaHomeState
import centraid.screen.v1.AgendaRowStatus
import centraid.screen.v1.AgendaScope
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.ReadFailureKind
import centraid.screen.v1.StatusChip
import centraid.screen.v1.WriteState
import dev.centraid.shared.apps.agenda.AgendaEventInput
import dev.centraid.shared.apps.agenda.AgendaEventMachine
import dev.centraid.shared.apps.agenda.AgendaEventReads
import dev.centraid.shared.apps.agenda.AgendaEventScreen
import dev.centraid.shared.apps.agenda.AgendaHomeMachine
import dev.centraid.shared.apps.agenda.AgendaInput
import dev.centraid.shared.apps.agenda.AgendaMarks
import dev.centraid.shared.apps.agenda.AgendaWrites
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * `agenda.event` (#1046 wave 4), from the typed `upcoming` answer to what a
 * view draws, and every write it makes — the inputs pinned against
 * `schedule.rs`'s schemas. Monday 15 June 2026, 09:42.
 */
class AgendaEventSpec : StringSpec({

    val clock = DeviceClock.Reading(zone = "Europe/London", epochMillis = 1_781_516_520_000L)

    "opening reads the occurrence by its key, and today's calendars, in the device's zone" {
        val opened = drive(AgendaEventMachine.initial(), open("e1", "e1:2026-06-15T08:00:00", "2026-06-15T08:00:00"))
        opened.effects shouldBe listOf(ScreenEffect.ReadPage(AgendaEventMachine.SCREEN_ID, null))
        opened.state.screen.loading.shouldNotBeNull()
        val reads = AgendaEventReads().requests(opened.state, clock).shouldNotBeNull()
        reads[0].agenda_event.shouldNotBeNull().let {
            it.event_id shouldBe "e1"
            it.instance_key shouldBe "e1:2026-06-15T08:00:00"
            it.original_start_local shouldBe "2026-06-15T08:00:00"
            it.tz shouldBe "Europe/London"
        }
        reads[1].agenda_upcoming.shouldNotBeNull().let {
            it.from shouldBe ""
            it.tz shouldBe "Europe/London"
        }
        // NO EVENT, NO READ.
        AgendaEventReads().requests(AgendaEventMachine.initial(), clock).shouldBeNull()
        AgendaEventReads().tables shouldBe AgendaEventMachine.TABLES
    }

    "the detail says every fact in words the machine chose" {
        val event = timed("e1", "Survey walk-through", "2026-06-15T08:15", "2026-06-15T09:30").copy(
            description = "  Bring the drawings.  ",
            conferencing_uri = "https://call.example/abc",
            reminders = listOf(AgendaReminder(minutes_before = 30)),
            attendees = listOf(you("needs-action"), guest("p-2", "Priya Raman", "accepted"), guest("p-3", "Tom", "")),
        )
        val data = landed(event).screen.data_.shouldNotBeNull()
        data.title shouldBe "Survey walk-through"
        data.date_label shouldBe "Monday 15 June"
        data.when_label shouldBe "08:15 – 09:30"
        data.calendar_name shouldBe "Personal"
        data.calendar_hue_key shouldBe "teal"
        data.facts.map { it.label to it.detail } shouldBe listOf(
            "Joining link" to "https://call.example/abc",
            "Reminder" to "30 minutes before",
            "Calendar" to "Personal",
        )
        data.notes shouldBe "Bring the drawings."
        data.call_uri shouldBe "https://call.example/abc"
        data.call_label shouldBe "Join call"
        landed(event).screen.chrome.shouldNotBeNull().back shouldBe "Agenda"
        // THE PLACE'S NAME, where the core answers one: after the rule, and spoken.
        val placed = landed(event.copy(location_name = "Studio 4")).screen.data_.shouldNotBeNull()
        placed.facts.first().let { (it.label to it.detail) shouldBe ("Where" to "Studio 4") }
        placed.accessibility_label shouldBe "Survey walk-through, Monday 15 June, 08:15 to 09:30, Studio 4"
        data.guest_heading shouldBe "3 guests · 2 awaiting"
        data.guests.map { it.name to it.reply_label } shouldBe listOf(
            "Sam · you" to "No answer yet",
            "Priya Raman" to "Going",
            "Tom" to "No answer yet",
        )
        data.guests.map { it.initial } shouldBe listOf("S", "P", "T")
        val rsvp = data.rsvp.shouldNotBeNull()
        rsvp.question shouldBe "Are you going?"
        rsvp.choices.map { it.label } shouldBe listOf("Going", "Maybe", "Not going")
        rsvp.choices.none { it.selected } shouldBe true
        rsvp.note shouldBe ""
        data.actions.map { it.key to it.label } shouldBe listOf("edit" to "Edit", "cancel" to "Cancel event")
        data.chip.shouldBeNull()
        data.is_past shouldBe true
        data.accessibility_label shouldBe "Survey walk-through, Monday 15 June, 08:15 to 09:30"
    }

    "all-day and multi-day occurrences say days, never a clock time; a series says it repeats" {
        val weekend = allDay("e2", "Weekend away", "2026-06-19", "2026-06-21")
        val data = landed(weekend, day = "2026-06-19").screen.data_.shouldNotBeNull()
        data.when_label shouldBe "All day"
        data.date_label shouldBe "Friday 19 June – Sunday 21 June"
        data.guest_heading shouldBe ""
        data.rsvp.shouldBeNull()

        val series = series("s1", "Stand-up", "2026-06-15T10:00", "2026-06-15T10:15")
        val seriesData = landed(series).screen.data_.shouldNotBeNull()
        seriesData.facts.first().let { (it.label to it.detail) shouldBe ("Repeats" to "Every weekday") }
        seriesData.actions.last().label shouldBe "Cancel…"
        seriesData.rsvp.shouldNotBeNull().note shouldBe "Your answer is for every occurrence."
        seriesData.is_past shouldBe false

        // An untitled event and one on no calendar still say something.
        val bare = timed("e3", "", "2026-06-15T12:00").copy(summary = null, calendar_id = null)
        landed(bare).screen.data_.shouldNotBeNull().let {
            it.title shouldBe "Untitled event"
            it.when_label shouldBe "12:00"
            it.calendar_name shouldBe "No calendar"
        }
    }

    "an occurrence the answer does not have is gone, not an error" {
        val state = answer(drive(AgendaEventMachine.initial(), open("missing")).state, upcoming(timed("e1", "A", "2026-06-15T08:00")))
        state.screen.data_.shouldBeNull()
        state.screen.gone.shouldNotBeNull().title shouldBe "This event is no longer on your calendar."
        state.screen.gone.shouldNotBeNull().action_label shouldBe "Back to Agenda"
    }

    "RSVP moves the chip at once, writes as the owner, and a refusal puts it back" {
        val event = timed("e1", "Review", "2026-06-15T14:00", "2026-06-15T15:00")
            .copy(attendees = listOf(guest("p-2", "Priya", "accepted"), you("needs-action")))
        val landed = landed(event)
        val sent = drive(landed, rsvp("accepted"))
        sent.effects shouldBe listOf(
            ScreenEffect.SubmitWrite(
                command = "schedule.respond_rsvp",
                inputJson = """{"event_id":"e1","party_id":"p-me","partstat":"accepted"}""",
                invokeKey = "schedule.respond_rsvp:e1:p-me:accepted",
            ),
        )
        val data = sent.state.screen.data_.shouldNotBeNull()
        data.rsvp.shouldNotBeNull().choices.single { it.selected }.partstat shouldBe "accepted"
        data.rsvp.shouldNotBeNull().choices.none { it.enabled } shouldBe true
        data.actions.none { it.enabled } shouldBe true
        data.chip.shouldNotBeNull().label shouldBe "pending"
        data.guests.single { it.is_you }.reply_label shouldBe "Going"

        // IN FLIGHT: a second answer waits.
        drive(sent.state, rsvp("declined")).effects.shouldBeEmpty()

        val refused = drive(
            sent.state,
            AgendaEventReads().settled(CommandStatus.COMMAND_STATUS_FAILED, "That event is cancelled.", "schedule.respond_rsvp:e1:p-me:accepted"),
        ).state
        refused.sentPartstat.shouldBeNull()
        refused.screen.write.shouldNotBeNull().phase shouldBe WriteState.Phase.PHASE_REFUSED
        refused.screen.write.shouldNotBeNull().failure.shouldNotBeNull().sentence shouldBe "That event is cancelled."
        refused.screen.data_.shouldNotBeNull().rsvp.shouldNotBeNull().choices.none { it.selected } shouldBe true

        // COMMITTED: the optimistic answer stands until the re-read has it.
        val committed = drive(sent.state, AgendaEventReads().settled(CommandStatus.COMMAND_STATUS_EXECUTED, "", "schedule.respond_rsvp:e1:p-me:accepted")).state
        committed.sentPartstat shouldBe "accepted"
        val reread = answer(
            drive(committed, rowsChanged("schedule_attendee")).state,
            upcoming(event.copy(attendees = listOf(guest("p-2", "Priya", "accepted"), you("accepted")))),
        )
        reread.sentPartstat.shouldBeNull()
        reread.screen.data_.shouldNotBeNull().rsvp.shouldNotBeNull().choices.single { it.selected }.partstat shouldBe "accepted"

        // The same answer again, or no invitation, writes nothing.
        drive(reread, rsvp("accepted")).effects.shouldBeEmpty()
        drive(landed(timed("e9", "Solo", "2026-06-15T14:00")), rsvp("accepted")).effects.shouldBeEmpty()
    }

    "cancelling a one-off asks first, writes cancel_event, and ends the screen" {
        val landed = landed(timed("e1", "Dentist", "2026-06-15T14:00", "2026-06-15T15:00"))
        val asked = drive(landed, action("cancel"))
        asked.effects.shouldBeEmpty()
        asked.state.screen.confirm.shouldNotBeNull().let {
            it.title shouldBe "Cancel this event?"
            it.confirm_label shouldBe "Cancel event"
            it.destructive shouldBe true
        }
        drive(asked.state, view(AgendaEventEvent(confirm_dismissed = AgendaEventEvent.ConfirmDismissed()))).state.screen.confirm.shouldBeNull()

        val sent = drive(asked.state, confirmed())
        sent.effects shouldBe listOf(
            ScreenEffect.SubmitWrite("schedule.cancel_event", """{"event_id":"e1"}""", "schedule.cancel_event:e1"),
        )
        sent.state.screen.confirm.shouldBeNull()
        sent.state.screen.data_.shouldNotBeNull().chip shouldBe StatusChip(label = "cancellation asked", tone = StatusChip.Tone.TONE_NET)
        val done = drive(sent.state, AgendaEventReads().settled(CommandStatus.COMMAND_STATUS_EXECUTED, "", "schedule.cancel_event:e1")).state
        done.screen.dismissed shouldBe true
    }

    "cancelling a series asks which occurrences, none pre-chosen, and each scope writes its command" {
        val landed = landed(series("s1", "Stand-up", "2026-06-15T10:00", "2026-06-15T10:15"))
        val sheet = drive(landed, action("cancel")).state
        sheet.screen.sheet shouldBe AgendaEventState.Sheet.SHEET_CANCEL_SCOPE
        sheet.screen.confirm.shouldBeNull()
        sheet.screen.cancel_scopes.map { it.label } shouldBe listOf("This occurrence", "This and the ones after", "The whole series")
        sheet.screen.cancel_scopes.none { it.selected } shouldBe true
        sheet.screen.cancel_armed shouldBe false
        // NOTHING PICKED, NOTHING WRITTEN.
        drive(sheet, confirmed()).effects.shouldBeEmpty()

        fun cancelWith(scope: AgendaScope): Step<AgendaEventScreen> {
            val picked = drive(sheet, view(AgendaEventEvent(scope = AgendaEventEvent.ScopePicked(scope = scope)))).state
            picked.screen.cancel_armed shouldBe true
            picked.screen.cancel_scopes.single { it.selected }.scope shouldBe scope
            return drive(picked, confirmed())
        }
        cancelWith(AgendaScope.AGENDA_SCOPE_OCCURRENCE).effects shouldBe listOf(
            ScreenEffect.SubmitWrite(
                "schedule.edit_event_occurrence",
                """{"event_id":"s1","original_start_local":"2026-06-15T10:00:00","scope":"occurrence","action":"skip"}""",
                "schedule.edit_event_occurrence:s1:2026-06-15T10:00:00:occurrence:skip",
            ),
        )
        cancelWith(AgendaScope.AGENDA_SCOPE_FUTURE).effects.single().let {
            (it as ScreenEffect.SubmitWrite).inputJson shouldBe
                """{"event_id":"s1","original_start_local":"2026-06-15T10:00:00","scope":"future","action":"skip"}"""
        }
        val whole = cancelWith(AgendaScope.AGENDA_SCOPE_SERIES)
        whole.effects shouldBe listOf(
            ScreenEffect.SubmitWrite("schedule.cancel_event", """{"event_id":"s1"}""", "schedule.cancel_event:s1"),
        )
        whole.state.screen.sheet shouldBe AgendaEventState.Sheet.SHEET_NONE

        // A skip committed is a cancellation too: the screen is done.
        val skipped = cancelWith(AgendaScope.AGENDA_SCOPE_OCCURRENCE)
        val key = (skipped.effects.single() as ScreenEffect.SubmitWrite).invokeKey
        drive(skipped.state, AgendaEventReads().settled(CommandStatus.COMMAND_STATUS_EXECUTED, "", key)).state.screen.dismissed shouldBe true

        // Closing the sheet forgets the pick.
        val closed = drive(sheet, view(AgendaEventEvent(sheet_closed = AgendaEventEvent.SheetClosed()))).state
        closed.screen.sheet shouldBe AgendaEventState.Sheet.SHEET_NONE
        closed.cancelScope.shouldBeNull()
    }

    "edit is an intent; the machine changes nothing on it" {
        val landed = landed(timed("e1", "A", "2026-06-15T08:00"))
        drive(landed, action("edit")) shouldBe Step(landed)
        NavStack().push(Destination.AgendaEvent("e1", "e1", null, TODAY)).current shouldBe
            Destination.AgendaEvent(eventId = "e1", instanceKey = "e1", day = TODAY)
        NavStack().push(Destination.AgendaEditor(day = TODAY)).current shouldBe Destination.AgendaEditor(null, "", null, TODAY)
    }

    "denied is the gate; a first read refused is a failure; a re-read refused keeps the event" {
        val opened = drive(AgendaEventMachine.initial(), open("e1")).state
        drive(opened, AgendaEventInput.Denied(AppQueryDenial())).state.screen.denied.shouldNotBeNull().title shouldBe
            "Agenda cannot read your calendar"
        val failure = ReadFailure(kind = ReadFailureKind.READ_FAILURE_KIND_REFUSED, sentence = "No.")
        drive(opened, refused(failure)).state.screen.failure shouldBe failure

        val landed = landed(timed("e1", "A", "2026-06-15T08:00"))
        val reread = drive(landed, rowsChanged("core_event"))
        reread.effects shouldBe listOf(ScreenEffect.ReadPage(AgendaEventMachine.SCREEN_ID, null))
        drive(reread.state, refused(failure)).state.screen.data_.shouldNotBeNull()
        AgendaEventMachine.rowsChanged("schedule_task", listOf("k")).shouldBeNull()
    }

    "a write refused after the screen was left comes back as the parked card" {
        val marks = AgendaMarks()
        val cancel = ScreenEffect.SubmitWrite("schedule.cancel_event", """{"event_id":"e1"}""", "schedule.cancel_event:e1")
        marks.submitted(cancel)
        AgendaMarks.cancelIds(marks.held.value) shouldBe listOf("e1")
        AgendaEventReads(marks).settled(CommandStatus.COMMAND_STATUS_FAILED, "That event is not here to change.", cancel.invokeKey)
        AgendaMarks.cancelIds(marks.held.value).shouldBeEmpty()

        val reopened = drive(landed(timed("e1", "Dentist", "2026-06-15T14:00")), AgendaEventInput.Held(marks.held.value)).state
        val card = reopened.screen.parked.shouldNotBeNull()
        card.title shouldBe "The cancellation did not go through"
        card.body shouldBe "That event is not here to change."
        card.retry_label shouldBe "Try again"

        // TRY AGAIN resubmits what was refused, under a new key.
        val retried = drive(reopened, view(AgendaEventEvent(parked_retried = AgendaEventEvent.ParkedRetried())))
        retried.effects shouldBe listOf(
            ScreenEffect.SubmitWrite("schedule.cancel_event", """{"event_id":"e1"}""", "schedule.cancel_event:e1:again"),
        )
        // DISMISS clears the session's refusal.
        marks.dismissed("e1")
        drive(reopened, AgendaEventInput.Held(marks.held.value)).state.screen.parked.shouldBeNull()
    }

    "the session's marks: an answer that outruns its write, and the home's chips" {
        val marks = AgendaMarks()
        val rsvp = ScreenEffect.SubmitWrite(AgendaWrites.RSVP, "{}", "schedule.respond_rsvp:e2:p-me:accepted")
        marks.settled(rsvp.invokeKey, committed = true, sentence = "")
        marks.submitted(rsvp)
        marks.held.value.shouldBeEmpty()

        marks.submitted(rsvp)
        marks.submitted(ScreenEffect.SubmitWrite(AgendaWrites.OCCURRENCE, """{"action":"skip"}""", "schedule.edit_event_occurrence:s1:x"))
        marks.submitted(ScreenEffect.SubmitWrite(AgendaWrites.PROPOSE, "{}", "schedule.propose_event:new:1"))
        AgendaMarks.pendingIds(marks.held.value) shouldBe listOf("e2")
        AgendaMarks.cancelIds(marks.held.value) shouldBe listOf("s1")

        // THE HOME DRAWS THEM, re-folding with no read.
        val home = AgendaHomeMachine.reduce(
            AgendaHomeMachine.reduce(AgendaHomeMachine.initial(), AgendaInput.View(AgendaHomeEvent(opened = AgendaHomeEvent.Opened()))).state,
            AgendaInput.Answered(
                upcoming(timed("e2", "Review", "2026-06-15T14:00"), series("s1", "Stand-up", "2026-06-15T10:00", "2026-06-15T10:15")),
                centraid.core.v1.AgendaDayContext(today = TODAY, now_local = NOW),
                null,
            ),
        ).state
        val marked = AgendaHomeMachine.reduce(home, AgendaInput.Marks(AgendaMarks.pendingIds(marks.held.value), AgendaMarks.cancelIds(marks.held.value)))
        marked.effects.shouldBeEmpty()
        val rows = marked.state.screen.data_.shouldNotBeNull().days.flatMap { d -> d.items.mapNotNull { it.event } }
        rows.single { it.event_id == "e2" }.status shouldBe AgendaRowStatus.AGENDA_ROW_STATUS_PENDING
        rows.single { it.event_id == "s1" }.status shouldBe AgendaRowStatus.AGENDA_ROW_STATUS_CANCEL_ASKED
        marked.state.screen.destination shouldBe AgendaHomeState.Destination.DESTINATION_DAY
    }
}) {
    companion object {
        const val TODAY: String = "2026-06-15"
        const val NOW: String = "2026-06-15T09:42"

        fun view(event: AgendaEventEvent): AgendaEventInput = AgendaEventInput.View(event)

        fun open(id: String, instance: String = id, original: String? = null, day: String = TODAY): AgendaEventInput =
            view(
                AgendaEventEvent(
                    opened = AgendaEventEvent.Opened(event_id = id, instance_key = instance, original_start_local = original, day = day),
                ),
            )

        fun rsvp(partstat: String): AgendaEventInput = view(AgendaEventEvent(rsvp = AgendaEventEvent.RsvpPicked(partstat = partstat)))

        fun action(key: String): AgendaEventInput = view(AgendaEventEvent(action = AgendaEventEvent.ActionPicked(key = key)))

        fun confirmed(): AgendaEventInput = view(AgendaEventEvent(confirmed = AgendaEventEvent.Confirmed()))

        fun rowsChanged(table: String): AgendaEventInput =
            view(AgendaEventEvent(rows_changed = AgendaEventEvent.RowsChanged(table = table)))

        fun refused(failure: ReadFailure): AgendaEventInput =
            view(AgendaEventEvent(refused = AgendaEventEvent.ReadRefused(failure = failure)))

        fun drive(state: AgendaEventScreen, vararg inputs: AgendaEventInput): Step<AgendaEventScreen> =
            inputs.fold(Step(state)) { step, input -> AgendaEventMachine.reduce(step.state, input) }

        /**
         * The two answers the detail reads: `agenda.event` for the state's
         * occurrence (found in [upcoming]'s rows, or absent), and `upcoming`
         * for the calendars.
         */
        fun answer(state: AgendaEventScreen, upcoming: AgendaUpcoming): AgendaEventScreen {
            val found = upcoming.events.firstOrNull {
                it.event_id == state.screen.event_id && it.instance_key == state.screen.instance_key
            }
            val detail = AgendaEventDetail(today = upcoming.today, now_local = upcoming.now_local, event = found)
            return drive(state, AgendaEventInput.Answered(upcoming.copy(events = emptyList()), detail)).state
        }

        /** Opened on [event]'s occurrence and answered with it. */
        fun landed(event: AgendaEvent, day: String = TODAY): AgendaEventScreen = answer(
            drive(AgendaEventMachine.initial(), open(event.event_id, event.instance_key, event.original_start_local, day)).state,
            upcoming(event),
        )

        fun upcoming(vararg events: AgendaEvent): AgendaUpcoming = AgendaUpcoming(
            events = events.toList(),
            calendars = listOf(
                AgendaCalendar(calendar_id = "cal-1", name = "Personal", color = "var(--c-teal)"),
                AgendaCalendar(calendar_id = "cal-2", name = "Work", color = "steelblue"),
            ),
            today = TODAY,
            now_local = NOW,
        )

        fun timed(id: String, summary: String, start: String, end: String? = null): AgendaEvent = AgendaEvent(
            event_id = id,
            instance_key = id,
            summary = summary,
            calendar_id = "cal-1",
            recurrence_semantics = "floating",
            local_start = start,
            local_end = end ?: "",
            local_days = listOf(start.take(10)),
        )

        fun series(id: String, summary: String, start: String, end: String): AgendaEvent =
            timed(id, summary, start, end).copy(
                instance_key = "$id:$start:00",
                original_start_local = "$start:00",
                rrule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
                recurrence_summary = "Every weekday",
                attendees = listOf(you("accepted")),
            )

        fun allDay(id: String, summary: String, first: String, last: String): AgendaEvent = AgendaEvent(
            event_id = id,
            instance_key = id,
            summary = summary,
            calendar_id = "cal-1",
            recurrence_semantics = "all-day",
            all_day = true,
            local_start = first,
            local_end = last,
            local_days = listOf(first, last),
        )

        fun you(partstat: String): AgendaAttendee =
            AgendaAttendee(party_id = "p-me", name = "Sam", partstat = partstat, is_you = true)

        fun guest(id: String, name: String, partstat: String): AgendaAttendee =
            AgendaAttendee(party_id = id, name = name, partstat = partstat)
    }
}
