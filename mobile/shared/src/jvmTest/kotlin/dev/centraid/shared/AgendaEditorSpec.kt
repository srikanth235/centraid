package dev.centraid.shared

import centraid.core.v1.AgendaAttendee
import centraid.core.v1.AgendaEvent
import centraid.core.v1.AgendaParties
import centraid.core.v1.AgendaParty
import centraid.core.v1.AgendaReminder
import centraid.core.v1.AgendaUpcoming
import centraid.core.v1.AppQueryDenial
import centraid.core.v1.CommandStatus
import centraid.screen.v1.AgendaEditorEvent
import centraid.screen.v1.AgendaEditorState
import centraid.screen.v1.AgendaScope
import centraid.screen.v1.WriteState
import dev.centraid.shared.AgendaEventSpec.Companion.TODAY
import dev.centraid.shared.AgendaEventSpec.Companion.series
import dev.centraid.shared.AgendaEventSpec.Companion.timed
import dev.centraid.shared.AgendaEventSpec.Companion.upcoming
import dev.centraid.shared.apps.agenda.AgendaEditorInput
import dev.centraid.shared.apps.agenda.AgendaEditorMachine
import dev.centraid.shared.apps.agenda.AgendaEditorReads
import dev.centraid.shared.apps.agenda.AgendaEditorScreen
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldStartWith

/**
 * `agenda.editor` (#1046 wave 5): defaults, validation, the day math, the
 * explicit save and which command each save is — every input pinned against
 * `schedule.rs`'s `additionalProperties: false` schemas — dirty leave, scope
 * and skip. Monday 15 June 2026, 09:42.
 */
class AgendaEditorSpec : StringSpec({

    val clock = DeviceClock.Reading(zone = "Europe/London", epochMillis = 1_781_516_520_000L)

    "a new event reads today and the people, and starts at the next half hour for an hour" {
        val opened = drive(AgendaEditorMachine.initial(), openNew(""))
        opened.effects shouldBe listOf(ScreenEffect.ReadPage(AgendaEditorMachine.SCREEN_ID, null))
        val asker = AgendaEditorReads()
        val reads = asker.requests(opened.state, clock).shouldNotBeNull()
        reads.map { (it.agenda_upcoming != null) to (it.agenda_parties != null) } shouldBe listOf(true to false, false to true)
        reads[0].agenda_upcoming.shouldNotBeNull().from shouldBe ""
        // The zone the read was asked in comes back with its answer, for a timed save.
        (asker.arrived(emptyList()) as AgendaEditorInput.Answered).zone shouldBe "Europe/London"

        val state = answered(opened.state)
        val data = state.screen.data_.shouldNotBeNull()
        data.heading shouldBe "New event"
        data.draft.shouldNotBeNull().let {
            it.start_day shouldBe TODAY
            it.start_time shouldBe "10:00"
            it.end_time shouldBe "11:00"
            it.calendar_id shouldBe "cal-1"
            it.repeat_key shouldBe "none"
            it.reminder_key shouldBe "none"
        }
        data.start_label shouldBe "Monday 15 June · 10:00"
        // THE DAY AND THE TIME APART, for two pickers; their words are the machine's.
        data.start_day_label shouldBe "Monday 15 June"
        data.start_time_label shouldBe "10:00"
        data.end_time_label shouldBe "11:00"
        state.screen.chrome.shouldNotBeNull().pick_date shouldBe "Pick a date"
        state.screen.chrome.shouldNotBeNull().pick_time shouldBe "Pick a time"
        data.calendar_label shouldBe "Personal"
        data.guests_label shouldBe "Nobody else"
        // THE OWNER IS NOT A GUEST OF THEIR OWN EVENT.
        data.guests.map { it.label } shouldBe listOf("Priya Raman", "Tom")
        data.foot_note shouldBe "A new event starts tentative."
        data.can_save shouldBe false
        data.blocked_reason shouldBe "Add a title to save."
        // Another day starts at 09:00.
        answered(drive(AgendaEditorMachine.initial(), openNew("2026-06-17")).state)
            .screen.data_.shouldNotBeNull().draft.shouldNotBeNull().start_time shouldBe "09:00"
        // Nothing typed: leaving is done, not a question.
        drive(state, leave()).state.screen.dismissed shouldBe true
    }

    "save proposes exactly the schema's fields, and a commit ends the editor" {
        val typed = drive(
            answered(drive(AgendaEditorMachine.initial(), openNew("")).state),
            edit(AgendaEditorEvent(title = AgendaEditorEvent.TitleChanged(text = "  Dentist "))),
            edit(AgendaEditorEvent(guest = AgendaEditorEvent.GuestToggled(party_id = "p-2"))),
            edit(AgendaEditorEvent(repeat = AgendaEditorEvent.RepeatPicked(key = "weekly"))),
            edit(AgendaEditorEvent(reminder = AgendaEditorEvent.ReminderPicked(key = "30"))),
        ).state
        val data = typed.screen.data_.shouldNotBeNull()
        data.can_save shouldBe true
        data.guests_label shouldBe "Priya Raman"
        data.repeat_label shouldBe "Every week on Monday"
        data.repeats.map { it.label } shouldBe listOf(
            "Does not repeat", "Every day", "Every week on Monday", "Every other week on Monday",
            "Every month on the 15th", "Every year on 15 June",
        )
        data.reminder_label shouldBe "30 minutes before"
        val saved = drive(typed, save())
        val write = saved.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "schedule.propose_event"
        // THE MEMBER'S WALL CLOCK AND THE DEVICE'S ZONE: the core resolves the instant.
        write.inputJson shouldBe """{"summary":"Dentist","dtstart":"2026-06-15T10:00:00","dtend":"2026-06-15T11:00:00",""" +
            """"tz":"Europe/London","calendar_id":"cal-1","attendee_party_ids":["p-2"],"rrule":"FREQ=WEEKLY",""" +
            """"reminders":[{"minutes_before":30}]}"""
        // With no zone known yet, the wall clock alone: floating.
        val zoneless = drive(typed.copy(zone = ""), save()).effects.single() as ScreenEffect.SubmitWrite
        zoneless.inputJson shouldContain """"recurrence_semantics":"floating""""
        write.invokeKey shouldStartWith "schedule.propose_event:new:"
        saved.state.screen.data_.shouldNotBeNull().can_save shouldBe false
        // A DOUBLE TAP IS ONE WRITE.
        drive(saved.state, save()).effects.shouldBeEmpty()

        val refused = drive(saved.state, AgendaEditorReads().settled(CommandStatus.COMMAND_STATUS_FAILED, "This time conflicts with another event on your calendar.", write.invokeKey)).state
        refused.screen.dismissed shouldBe false
        refused.screen.write.shouldNotBeNull().failure.shouldNotBeNull().sentence shouldBe
            "This time conflicts with another event on your calendar."
        refused.screen.data_.shouldNotBeNull().draft.shouldNotBeNull().title shouldBe "  Dentist "
        drive(saved.state, AgendaEditorReads().settled(CommandStatus.COMMAND_STATUS_EXECUTED, "", write.invokeKey)).state.screen.dismissed shouldBe true
    }

    "the day math: a start moves the end with it, all-day is days, and an inverted range cannot save" {
        val titled = drive(
            answered(drive(AgendaEditorMachine.initial(), openNew("")).state),
            edit(AgendaEditorEvent(title = AgendaEditorEvent.TitleChanged(text = "Flight"))),
        ).state
        val moved = drive(titled, edit(AgendaEditorEvent(start = AgendaEditorEvent.StartChanged(day = TODAY, time = "23:30")))).state
        moved.draft.shouldNotBeNull().let {
            it.end_day shouldBe "2026-06-16"
            it.end_time shouldBe "00:30"
        }
        val inverted = drive(moved, edit(AgendaEditorEvent(end = AgendaEditorEvent.EndChanged(day = TODAY, time = "22:00")))).state
        inverted.screen.data_.shouldNotBeNull().let {
            it.can_save shouldBe false
            it.blocked_reason shouldBe "An event must end after it starts."
        }
        drive(inverted, save()).effects.shouldBeEmpty()

        val allDay = drive(inverted, edit(AgendaEditorEvent(all_day = AgendaEditorEvent.AllDayToggled(on = true)))).state
        allDay.draft.shouldNotBeNull().let {
            it.all_day shouldBe true
            it.end_day shouldBe TODAY
        }
        allDay.screen.data_.shouldNotBeNull().start_label shouldBe "Monday 15 June"
        allDay.screen.data_.shouldNotBeNull().start_time_label shouldBe ""
        val write = drive(allDay, save()).effects.single() as ScreenEffect.SubmitWrite
        write.inputJson shouldBe """{"summary":"Flight","dtstart":"2026-06-15","dtend":"2026-06-15",""" +
            """"recurrence_semantics":"all-day","calendar_id":"cal-1"}"""
        // An all-day start moves its end by the same days.
        drive(allDay, edit(AgendaEditorEvent(start = AgendaEditorEvent.StartChanged(day = "2026-06-18", time = ""))))
            .state.draft.shouldNotBeNull().end_day shouldBe "2026-06-18"
        // OFF AGAIN: timed, and whole.
        val timedAgain = drive(allDay, edit(AgendaEditorEvent(all_day = AgendaEditorEvent.AllDayToggled(on = false)))).state
        timedAgain.screen.data_.shouldNotBeNull().can_save shouldBe true
        // A malformed pick is ignored.
        drive(titled, edit(AgendaEditorEvent(start = AgendaEditorEvent.StartChanged(day = "June", time = "9")))).state.draft shouldBe titled.draft
    }

    "editing a one-off sends only what changed, clears as clear_*, and keeps the owner on the guest list" {
        val event = timed("e1", "Review", "2026-06-15T14:00", "2026-06-15T15:00").copy(
            description = "Old notes",
            conferencing_uri = "https://call.example/x",
            reminders = listOf(AgendaReminder(minutes_before = 45)),
            attendees = listOf(AgendaEventSpec.you("accepted"), AgendaAttendee(party_id = "p-2", name = "Priya Raman", partstat = "")),
        )
        val loaded = answered(drive(AgendaEditorMachine.initial(), openEdit(event)).state, event)
        val data = loaded.screen.data_.shouldNotBeNull()
        data.heading shouldBe "Edit event"
        data.draft.shouldNotBeNull().guest_ids shouldBe listOf("p-2")
        data.reminders.map { it.label } shouldBe listOf(
            "No reminder", "At the start", "10 minutes before", "30 minutes before", "45 minutes before",
            "1 hour before", "1 day before",
        )
        data.reminder_label shouldBe "45 minutes before"
        data.can_save shouldBe false
        data.blocked_reason shouldBe ""
        data.show_skip shouldBe false
        data.foot_note shouldBe ""

        val changed = drive(
            loaded,
            edit(AgendaEditorEvent(title = AgendaEditorEvent.TitleChanged(text = "Design review"))),
            edit(AgendaEditorEvent(notes = AgendaEditorEvent.NotesChanged(text = "  "))),
            edit(AgendaEditorEvent(link = AgendaEditorEvent.LinkChanged(text = ""))),
            edit(AgendaEditorEvent(guest = AgendaEditorEvent.GuestToggled(party_id = "p-3"))),
        ).state
        changed.screen.data_.shouldNotBeNull().dirty shouldBe true
        val write = drive(changed, save()).effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "schedule.edit_event"
        write.inputJson shouldBe """{"event_id":"e1","summary":"Design review","clear_description":true,""" +
            """"clear_conferencing":true,"attendee_party_ids":["p-me","p-2","p-3"]}"""

        // A new time is the wall clock with the zone it was picked in.
        val retimed = drive(loaded, edit(AgendaEditorEvent(start = AgendaEditorEvent.StartChanged(day = TODAY, time = "16:00")))).state
        (drive(retimed, save()).effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe
            """{"event_id":"e1","dtstart":"2026-06-15T16:00:00","dtend":"2026-06-15T17:00:00","tz":"Europe/London"}"""
    }

    "leaving with changes asks, and only Discard leaves" {
        val loaded = answered(drive(AgendaEditorMachine.initial(), openNew("")).state)
        val typed = drive(loaded, edit(AgendaEditorEvent(title = AgendaEditorEvent.TitleChanged(text = "Lunch")))).state
        val asked = drive(typed, leave()).state
        asked.screen.dismissed shouldBe false
        asked.screen.asking shouldBe AgendaEditorState.Asking.ASKING_DISCARD
        asked.screen.confirm.shouldNotBeNull().let {
            it.title shouldBe "Discard this event?"
            it.body shouldBe "Nothing has been saved."
            it.confirm_label shouldBe "Discard"
        }
        val kept = drive(asked, edit(AgendaEditorEvent(confirm_dismissed = AgendaEditorEvent.ConfirmDismissed()))).state
        kept.screen.confirm.shouldBeNull()
        kept.screen.data_.shouldNotBeNull().draft.shouldNotBeNull().title shouldBe "Lunch"
        drive(asked, edit(AgendaEditorEvent(confirmed = AgendaEditorEvent.Confirmed()))).state.screen.dismissed shouldBe true
    }

    "a series occurrence asks which occurrences, and each scope writes its command" {
        val occurrence = series("s1", "Stand-up", "2026-06-16T10:00", "2026-06-16T10:15").copy(is_recurrence_instance = true)
        val loaded = answered(drive(AgendaEditorMachine.initial(), openEdit(occurrence, "2026-06-16")).state, occurrence)
        loaded.screen.data_.shouldNotBeNull().let {
            it.show_skip shouldBe true
            it.skip_label shouldBe "Skip this occurrence"
            it.repeat_label shouldBe "Every weekday"
            it.repeat_note shouldBe "A repeat rule belongs to the whole series."
        }
        val renamed = drive(loaded, edit(AgendaEditorEvent(title = AgendaEditorEvent.TitleChanged(text = "Daily sync")))).state
        val sheet = drive(renamed, save())
        sheet.effects.shouldBeEmpty()
        sheet.state.screen.sheet shouldBe AgendaEditorState.Sheet.SHEET_SCOPE
        sheet.state.screen.data_.shouldNotBeNull().scopes.none { it.selected } shouldBe true
        sheet.state.screen.data_.shouldNotBeNull().scope_armed shouldBe false
        drive(sheet.state, save()).effects.shouldBeEmpty()

        val one = drive(sheet.state, scope(AgendaScope.AGENDA_SCOPE_OCCURRENCE)).state
        one.screen.data_.shouldNotBeNull().scope_armed shouldBe true
        val write = drive(one, save()).effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "schedule.edit_event_occurrence"
        write.inputJson shouldBe """{"event_id":"s1","original_start_local":"2026-06-16T10:00:00","scope":"occurrence",""" +
            """"action":"override","summary":"Daily sync"}"""
        (drive(drive(sheet.state, scope(AgendaScope.AGENDA_SCOPE_SERIES)).state, save()).effects.single() as ScreenEffect.SubmitWrite)
            .let {
                it.command shouldBe "schedule.edit_event"
                it.inputJson shouldBe """{"event_id":"s1","summary":"Daily sync"}"""
            }

        // A NEW RULE is the whole series' alone.
        val newRule = drive(loaded, edit(AgendaEditorEvent(repeat = AgendaEditorEvent.RepeatPicked(key = "daily"))), save()).state
        newRule.screen.data_.shouldNotBeNull().scopes.map { it.scope to it.enabled } shouldBe listOf(
            AgendaScope.AGENDA_SCOPE_OCCURRENCE to false,
            AgendaScope.AGENDA_SCOPE_FUTURE to false,
            AgendaScope.AGENDA_SCOPE_SERIES to true,
        )
        drive(newRule, scope(AgendaScope.AGENDA_SCOPE_OCCURRENCE)).state.scope.shouldBeNull()
        // MOVING THE SERIES from a later occurrence is not offered.
        val moved = drive(loaded, edit(AgendaEditorEvent(start = AgendaEditorEvent.StartChanged(day = "2026-06-16", time = "11:00"))), save()).state
        moved.screen.data_.shouldNotBeNull().scopes.single { it.scope == AgendaScope.AGENDA_SCOPE_SERIES }.let {
            it.enabled shouldBe false
            it.note shouldBe "To move every occurrence, edit the first one."
        }
    }

    "skip asks, then writes the occurrence skip" {
        val occurrence = series("s1", "Stand-up", "2026-06-16T10:00", "2026-06-16T10:15")
        val loaded = answered(drive(AgendaEditorMachine.initial(), openEdit(occurrence, "2026-06-16")).state, occurrence)
        val asked = drive(loaded, edit(AgendaEditorEvent(skip = AgendaEditorEvent.SkipTapped()))).state
        asked.screen.asking shouldBe AgendaEditorState.Asking.ASKING_SKIP
        asked.screen.confirm.shouldNotBeNull().title shouldBe "Skip this occurrence?"
        val sent = drive(asked, edit(AgendaEditorEvent(confirmed = AgendaEditorEvent.Confirmed())))
        sent.effects shouldBe listOf(
            ScreenEffect.SubmitWrite(
                "schedule.edit_event_occurrence",
                """{"event_id":"s1","original_start_local":"2026-06-16T10:00:00","scope":"occurrence","action":"skip"}""",
                "schedule.edit_event_occurrence:s1:2026-06-16T10:00:00:occurrence:skip",
            ),
        )
        sent.state.screen.write.shouldNotBeNull().phase shouldBe WriteState.Phase.PHASE_IN_FLIGHT
        // A one-off has no skip.
        val oneOff = timed("e1", "A", "2026-06-15T14:00", "2026-06-15T15:00")
        drive(answered(drive(AgendaEditorMachine.initial(), openEdit(oneOff)).state, oneOff), edit(AgendaEditorEvent(skip = AgendaEditorEvent.SkipTapped())))
            .state.screen.confirm.shouldBeNull()
    }

    "a change elsewhere re-reads and never overwrites the draft; a rule it cannot name stays as it is" {
        val custom = series("s1", "Stand-up", "2026-06-15T10:00", "2026-06-15T10:15")
        val loaded = answered(drive(AgendaEditorMachine.initial(), openEdit(custom)).state, custom)
        loaded.draft.shouldNotBeNull().repeat_key shouldBe "custom"
        loaded.screen.data_.shouldNotBeNull().repeats.last().label shouldBe "Every weekday"
        val typed = drive(loaded, edit(AgendaEditorEvent(title = AgendaEditorEvent.TitleChanged(text = "Mine")))).state
        val reread = drive(typed, edit(AgendaEditorEvent(rows_changed = AgendaEditorEvent.RowsChanged(table = "core_event"))))
        reread.effects shouldBe listOf(ScreenEffect.ReadPage(AgendaEditorMachine.SCREEN_ID, null))
        answered(reread.state, custom.copy(summary = "Theirs")).draft.shouldNotBeNull().title shouldBe "Mine"
        AgendaEditorMachine.rowsChanged("schedule_task", listOf("k")).shouldBeNull()
        AgendaEditorMachine.repeatKeyOf("freq=weekly;interval=2") shouldBe "biweekly"
    }

    "denied is the gate; an edit whose occurrence is gone says so" {
        val opened = drive(AgendaEditorMachine.initial(), openNew("")).state
        drive(opened, AgendaEditorInput.Denied(AppQueryDenial())).state.screen.denied.shouldNotBeNull()
        val gone = answered(drive(AgendaEditorMachine.initial(), openEdit(timed("x", "X", "2026-06-15T08:00"))).state)
        gone.screen.gone.shouldNotBeNull().title shouldBe "This event is no longer on your calendar."
        // AN EDIT WITH NO DAY does not read.
        AgendaEditorReads().requests(
            drive(AgendaEditorMachine.initial(), edit(AgendaEditorEvent(opened = AgendaEditorEvent.Opened(mode = AgendaEditorState.Mode.MODE_EDIT, event_id = "e1")))).state,
            clock,
        ).shouldBeNull()
    }
}) {
    companion object {
        fun edit(event: AgendaEditorEvent): AgendaEditorInput = AgendaEditorInput.View(event)

        fun openNew(day: String): AgendaEditorInput =
            edit(AgendaEditorEvent(opened = AgendaEditorEvent.Opened(mode = AgendaEditorState.Mode.MODE_CREATE, day = day)))

        fun openEdit(event: AgendaEvent, day: String = TODAY): AgendaEditorInput = edit(
            AgendaEditorEvent(
                opened = AgendaEditorEvent.Opened(
                    mode = AgendaEditorState.Mode.MODE_EDIT,
                    event_id = event.event_id,
                    instance_key = event.instance_key,
                    original_start_local = event.original_start_local,
                    day = day,
                ),
            ),
        )

        fun save(): AgendaEditorInput = edit(AgendaEditorEvent(save = AgendaEditorEvent.SaveTapped()))

        fun leave(): AgendaEditorInput = edit(AgendaEditorEvent(leave = AgendaEditorEvent.LeaveRequested()))

        fun scope(scope: AgendaScope): AgendaEditorInput = edit(AgendaEditorEvent(scope = AgendaEditorEvent.ScopePicked(scope = scope)))

        fun drive(state: AgendaEditorScreen, vararg inputs: AgendaEditorInput): Step<AgendaEditorScreen> =
            inputs.fold(Step(state)) { step, input -> AgendaEditorMachine.reduce(step.state, input) }

        val PARTIES: AgendaParties = AgendaParties(
            parties = listOf(
                AgendaParty(party_id = "p-me", name = "Sam", is_you = true),
                AgendaParty(party_id = "p-2", name = "Priya Raman"),
                AgendaParty(party_id = "p-3", name = "Tom"),
            ),
            me = "p-me",
        )

        fun answered(state: AgendaEditorScreen, vararg events: AgendaEvent): AgendaEditorScreen =
            drive(state, AgendaEditorInput.Answered(upcoming(*events), PARTIES, zone = "Europe/London")).state
    }
}
