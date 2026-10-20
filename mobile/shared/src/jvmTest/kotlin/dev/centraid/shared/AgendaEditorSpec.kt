package dev.centraid.shared

import centraid.core.v1.AgendaAttendee
import centraid.core.v1.AgendaEvent
import centraid.core.v1.AgendaEventDetail
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
import dev.centraid.shared.apps.agenda.AgendaAddKind
import dev.centraid.shared.apps.agenda.AgendaEditorBridge
import dev.centraid.shared.apps.agenda.AgendaEditorInput
import dev.centraid.shared.apps.agenda.AgendaEditorMachine
import dev.centraid.shared.apps.agenda.AgendaEditorReads
import dev.centraid.shared.apps.agenda.AgendaEditorScreen
import dev.centraid.shared.apps.agenda.AgendaMarks
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.platform.FakeSecureStore
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldStartWith
import kotlinx.coroutines.test.runTest

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
        // NOTHING TOUCHED, NOTHING SAID: why Save is not armed waits for a
        // change or a Save pressed (#1047).
        data.blocked_reason shouldBe ""
        drive(state, save()).state.screen.data_.shouldNotBeNull().blocked_reason shouldBe "Add a title to save."
        drive(state, edit(AgendaEditorEvent(notes = AgendaEditorEvent.NotesChanged(text = "Bring the form"))))
            .state.screen.data_.shouldNotBeNull().blocked_reason shouldBe "Add a title to save."
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

    "a Save after the commit files nothing more: a committed event ends its sitting (#1089)" {
        // The core keeps no replay ledger (R-1088-12): a second `propose_event` is a second event.
        val typed = drive(
            answered(drive(AgendaEditorMachine.initial(), openNew("")).state),
            edit(AgendaEditorEvent(title = AgendaEditorEvent.TitleChanged(text = "Dentist"))),
        ).state
        val saved = drive(typed, save())
        val write = saved.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "schedule.propose_event"
        val committed = drive(
            saved.state,
            AgendaEditorReads().settled(CommandStatus.COMMAND_STATUS_EXECUTED, "", write.invokeKey),
        ).state
        committed.screen.dismissed shouldBe true
        // The shell leaves on `dismissed`; until it has, Save is not armed and a tap is nothing.
        drive(committed, save()).effects.shouldBeEmpty()
        committed.screen.data_.shouldNotBeNull().can_save shouldBe false

        // A REFUSED save is not a committed one: the words stay and Save tries again.
        val refused = drive(
            saved.state,
            AgendaEditorReads().settled(CommandStatus.COMMAND_STATUS_FAILED, "Not now.", write.invokeKey),
        ).state
        refused.screen.dismissed shouldBe false
        refused.screen.data_.shouldNotBeNull().can_save shouldBe true
        (drive(refused, save()).effects.single() as ScreenEffect.SubmitWrite).command shouldBe "schedule.propose_event"
    }

    "an edit that committed ends its sitting too: the same Save again sends nothing (#1089)" {
        val event = timed("e1", "Review", "2026-06-15T14:00", "2026-06-15T15:00")
        val loaded = answered(drive(AgendaEditorMachine.initial(), openEdit(event)).state, event)
        val changed = drive(loaded, edit(AgendaEditorEvent(title = AgendaEditorEvent.TitleChanged(text = "Design review")))).state
        val saved = drive(changed, save())
        val write = saved.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "schedule.edit_event"
        val committed = drive(
            saved.state,
            AgendaEditorReads().settled(CommandStatus.COMMAND_STATUS_EXECUTED, "", write.invokeKey),
        ).state
        committed.screen.dismissed shouldBe true
        drive(committed, save()).effects.shouldBeEmpty()
        committed.screen.data_.shouldNotBeNull().can_save shouldBe false
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

    "the add sheet has an Event | Task switch; an edit has none (#1128)" {
        val created = answered(drive(AgendaEditorMachine.initial(), openNew("")).state)
        val data = created.screen.data_.shouldNotBeNull()
        data.kinds.map { Triple(it.kind, it.label, it.selected) } shouldBe listOf(
            Triple(AgendaEditorState.Kind.KIND_EVENT, "Event", true),
            Triple(AgendaEditorState.Kind.KIND_TASK, "Task", false),
        )
        created.screen.kind shouldBe AgendaEditorState.Kind.KIND_EVENT
        created.screen.chrome.shouldNotBeNull().kind_label shouldBe "What to add"
        data.show_event_fields shouldBe true
        data.start_field_label shouldBe "Starts"

        // AN EDIT IS AN EVENT and says nothing of kinds; a stray pick changes nothing.
        val event = timed("e1", "Dentist", "2026-06-15T14:00", "2026-06-15T15:00")
        val edited = answered(drive(AgendaEditorMachine.initial(), openEdit(event)).state, event)
        edited.screen.data_.shouldNotBeNull().kinds.shouldBeEmpty()
        drive(edited, pickKind(AgendaEditorState.Kind.KIND_TASK)).state.screen.kind shouldBe AgendaEditorState.Kind.KIND_EVENT
        // ... even when an Opened names a task.
        val named = drive(AgendaEditorMachine.initial(), openNew("", AgendaEditorState.Kind.KIND_TASK, AgendaEditorState.Mode.MODE_EDIT)).state
        named.screen.kind shouldBe AgendaEditorState.Kind.KIND_EVENT
    }

    "a sheet opened on Task is a title and a due day, All day until a time is wanted" {
        val state = answered(drive(AgendaEditorMachine.initial(), openNew("2026-06-17", AgendaEditorState.Kind.KIND_TASK)).state)
        val data = state.screen.data_.shouldNotBeNull()
        state.screen.kind shouldBe AgendaEditorState.Kind.KIND_TASK
        data.kinds.single { it.selected }.label shouldBe "Task"
        data.heading shouldBe "New task"
        data.show_event_fields shouldBe false
        data.start_field_label shouldBe "Due"
        data.foot_note shouldBe ""
        // THE DUE DEFAULTS TO THE DAY THE SHEET OPENED ON, a bare date.
        data.draft.shouldNotBeNull().let {
            it.start_day shouldBe "2026-06-17"
            it.all_day shouldBe true
        }
        data.start_day_label shouldBe "Wednesday 17 June"
        data.start_time_label shouldBe ""
        data.can_save shouldBe false
        // Nothing typed: leaving is done, not a question.
        drive(state, leave()).state.screen.dismissed shouldBe true
        // A task needs a title, and nothing else (no calendar, no range).
        drive(state, saveTask("id-1")).state.screen.data_.shouldNotBeNull().blocked_reason shouldBe "Add a title to save."
        val noCalendars = drive(
            drive(AgendaEditorMachine.initial(), openNew("", AgendaEditorState.Kind.KIND_TASK)).state,
            AgendaEditorInput.Answered(upcoming().copy(calendars = emptyList()), PARTIES, zone = "Europe/London"),
            edit(AgendaEditorEvent(title = AgendaEditorEvent.TitleChanged(text = "Call Mum"))),
        ).state
        noCalendars.screen.data_.shouldNotBeNull().can_save shouldBe true
        // THE EVENT FIELDS ARE NOT A TASK'S: their events change nothing.
        val typed = drive(state, edit(AgendaEditorEvent(title = AgendaEditorEvent.TitleChanged(text = "Call Mum")))).state
        for (stray in listOf(
            AgendaEditorEvent(guest = AgendaEditorEvent.GuestToggled(party_id = "p-2")),
            AgendaEditorEvent(repeat = AgendaEditorEvent.RepeatPicked(key = "weekly")),
            AgendaEditorEvent(reminder = AgendaEditorEvent.ReminderPicked(key = "30")),
            AgendaEditorEvent(calendar = AgendaEditorEvent.CalendarPicked(calendar_id = "cal-1")),
            AgendaEditorEvent(end = AgendaEditorEvent.EndChanged(day = "2026-06-18", time = "10:00")),
            AgendaEditorEvent(notes = AgendaEditorEvent.NotesChanged(text = "x")),
            AgendaEditorEvent(link = AgendaEditorEvent.LinkChanged(text = "https://x.example")),
            AgendaEditorEvent(sheet_opened = AgendaEditorEvent.SheetOpened(sheet = AgendaEditorState.Sheet.SHEET_CALENDAR)),
        )) {
            drive(typed, edit(stray)).state shouldBe typed
        }
        // A Save without the bridge's id writes nothing: a machine mints no ids.
        drive(typed, save()).effects.shouldBeEmpty()
    }

    "switching kinds keeps the title and the day, and is never a change to discard" {
        val event = answered(drive(AgendaEditorMachine.initial(), openNew("2026-06-17")).state)
        val toTask = drive(event, pickKind(AgendaEditorState.Kind.KIND_TASK)).state
        toTask.screen.kind shouldBe AgendaEditorState.Kind.KIND_TASK
        toTask.screen.data_.shouldNotBeNull().let {
            it.kinds.single { k -> k.selected }.label shouldBe "Task"
            it.heading shouldBe "New task"
            it.draft.shouldNotBeNull().all_day shouldBe true
            it.draft.shouldNotBeNull().start_day shouldBe "2026-06-17"
            it.dirty shouldBe false
        }
        // THE SWITCH ALONE LEAVES FREELY.
        drive(toTask, leave()).state.screen.dismissed shouldBe true
        // Typed on one kind, kept on the other; the picked day goes with it.
        val typed = drive(
            toTask,
            edit(AgendaEditorEvent(title = AgendaEditorEvent.TitleChanged(text = "Plan the trip"))),
            edit(AgendaEditorEvent(start = AgendaEditorEvent.StartChanged(day = "2026-06-19", time = "09:00"))),
            pickKind(AgendaEditorState.Kind.KIND_EVENT),
        ).state
        typed.screen.kind shouldBe AgendaEditorState.Kind.KIND_EVENT
        typed.screen.data_.shouldNotBeNull().let {
            it.heading shouldBe "New event"
            it.show_event_fields shouldBe true
            it.foot_note shouldBe "A new event starts tentative."
            it.draft.shouldNotBeNull().let { d ->
                d.title shouldBe "Plan the trip"
                d.start_day shouldBe "2026-06-19"
                d.all_day shouldBe false
                d.end_time shouldBe "10:00"
            }
        }
        // ... and a typed title asks first, in the kind's words.
        drive(typed, leave()).state.screen.confirm.shouldNotBeNull().title shouldBe "Discard this event?"
        drive(typed, pickKind(AgendaEditorState.Kind.KIND_TASK), leave()).state.screen.confirm.shouldNotBeNull().title shouldBe
            "Discard this task?"
        // A kind picked before the answer arrives shapes the draft that arrives.
        val early = drive(drive(AgendaEditorMachine.initial(), openNew("")).state, pickKind(AgendaEditorState.Kind.KIND_TASK)).state
        answered(early).screen.data_.shouldNotBeNull().draft.shouldNotBeNull().all_day shouldBe true
    }

    "a task saves as schedule.add_task with a bare day, or a floating time; a commit ends the sitting" {
        val typed = drive(
            answered(drive(AgendaEditorMachine.initial(), openNew("2026-06-17", AgendaEditorState.Kind.KIND_TASK)).state),
            edit(AgendaEditorEvent(title = AgendaEditorEvent.TitleChanged(text = "  Renew passport "))),
        ).state
        typed.screen.data_.shouldNotBeNull().can_save shouldBe true
        val saved = drive(typed, saveTask("11111111-1111-4111-8111-111111111111"))
        val write = saved.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "schedule.add_task"
        // THE BRIDGE'S ID, THE TRIMMED TITLE, THE BARE DAY: nothing else (`additionalProperties: false`).
        write.inputJson shouldBe """{"task_id":"11111111-1111-4111-8111-111111111111","title":"Renew passport","due_at":"2026-06-17"}"""
        write.invokeKey shouldBe "schedule.add_task:11111111-1111-4111-8111-111111111111:try=1"
        saved.state.screen.write.shouldNotBeNull().phase shouldBe WriteState.Phase.PHASE_IN_FLIGHT
        saved.state.screen.data_.shouldNotBeNull().can_save shouldBe false
        // A DOUBLE TAP IS ONE WRITE, and the kind cannot be switched under it.
        drive(saved.state, saveTask("22222222-2222-4222-8222-222222222222")).effects.shouldBeEmpty()
        drive(saved.state, pickKind(AgendaEditorState.Kind.KIND_EVENT)).state.screen.kind shouldBe AgendaEditorState.Kind.KIND_TASK

        // REFUSED: the sheet stays with the core's sentence, and a retry is the SAME id (the vault refuses a second copy).
        val refused = drive(
            saved.state,
            AgendaEditorReads().settled(CommandStatus.COMMAND_STATUS_FAILED, "That task could not be added.", write.invokeKey),
        ).state
        refused.screen.dismissed shouldBe false
        refused.screen.write.shouldNotBeNull().failure.shouldNotBeNull().sentence shouldBe "That task could not be added."
        refused.screen.data_.shouldNotBeNull().draft.shouldNotBeNull().title shouldBe "  Renew passport "
        val retried = drive(refused, saveTask("33333333-3333-4333-8333-333333333333"))
        val again = retried.effects.single() as ScreenEffect.SubmitWrite
        again.inputJson shouldBe write.inputJson
        again.invokeKey shouldBe "schedule.add_task:11111111-1111-4111-8111-111111111111:try=2"

        // COMMITTED: the sitting ends, and a Save before the shell has gone files nothing more (#1089, R-1088-12).
        val committed = drive(saved.state, AgendaEditorReads().settled(CommandStatus.COMMAND_STATUS_EXECUTED, "", write.invokeKey)).state
        committed.screen.dismissed shouldBe true
        drive(committed, saveTask("44444444-4444-4444-8444-444444444444")).effects.shouldBeEmpty()
        drive(committed, pickKind(AgendaEditorState.Kind.KIND_EVENT)).state.screen.kind shouldBe AgendaEditorState.Kind.KIND_TASK

        // A TIME turns All day off: the due is the floating wall clock the command reads.
        val timed = drive(
            typed,
            edit(AgendaEditorEvent(all_day = AgendaEditorEvent.AllDayToggled(on = false))),
            edit(AgendaEditorEvent(start = AgendaEditorEvent.StartChanged(day = "2026-06-17", time = "14:30"))),
        ).state
        timed.screen.data_.shouldNotBeNull().start_time_label shouldBe "14:30"
        (drive(timed, saveTask("55555555-5555-4555-8555-555555555555")).effects.single() as ScreenEffect.SubmitWrite)
            .inputJson shouldContain """"due_at":"2026-06-17T14:30""""
        // A task write is not an event write: the session's marks hold nothing for it.
        AgendaMarks.heldOf(write).shouldBeNull()
    }

    "the bridge fills in the remembered kind on a create and mints an id for a task's Save" {
        val bare = AgendaEditorEvent(opened = AgendaEditorEvent.Opened(mode = AgendaEditorState.Mode.MODE_CREATE, day = "2026-06-17"))
        AgendaEditorBridge.opensCreateUnkinded(bare) shouldBe true
        val filled = AgendaEditorBridge.editorInput(bare, AgendaEditorState.Kind.KIND_EVENT, AgendaEditorState.Kind.KIND_TASK) { "id" }
        (filled as AgendaEditorInput.View).event.opened.shouldNotBeNull().let {
            it.kind shouldBe AgendaEditorState.Kind.KIND_TASK
            it.day shouldBe "2026-06-17"
        }
        // A route that names a kind keeps it; an edit never asks the memory.
        val named = bare.copy(opened = bare.opened!!.copy(kind = AgendaEditorState.Kind.KIND_EVENT))
        AgendaEditorBridge.opensCreateUnkinded(named) shouldBe false
        AgendaEditorBridge.opensCreateUnkinded(
            AgendaEditorEvent(opened = AgendaEditorEvent.Opened(mode = AgendaEditorState.Mode.MODE_EDIT, event_id = "e1")),
        ) shouldBe false
        // Save: a task carries a fresh id; an event's Save goes through as it was.
        val save = AgendaEditorEvent(save = AgendaEditorEvent.SaveTapped())
        AgendaEditorBridge.editorInput(save, AgendaEditorState.Kind.KIND_TASK, AgendaEditorState.Kind.KIND_EVENT) { "minted" } shouldBe
            AgendaEditorInput.SaveTask("minted")
        AgendaEditorBridge.editorInput(save, AgendaEditorState.Kind.KIND_EVENT, AgendaEditorState.Kind.KIND_TASK) { "minted" } shouldBe
            AgendaEditorInput.View(save)
    }

    "the device remembers the kind of the last add: an event is absence, an unknown word is an event (#1128)" {
        runTest {
            val store = FakeSecureStore()
            AgendaAddKind.read(store) shouldBe AgendaEditorState.Kind.KIND_EVENT
            AgendaAddKind.write(store, AgendaEditorState.Kind.KIND_TASK)
            AgendaAddKind.read(store) shouldBe AgendaEditorState.Kind.KIND_TASK
            AgendaAddKind.write(store, AgendaEditorState.Kind.KIND_EVENT)
            store.read(AgendaAddKind.KEY) shouldBe null
            AgendaAddKind.read(store) shouldBe AgendaEditorState.Kind.KIND_EVENT
            store.write(AgendaAddKind.KEY, "habit")
            AgendaAddKind.read(store) shouldBe AgendaEditorState.Kind.KIND_EVENT
        }
    }

    "denied is the gate; an edit whose occurrence is gone says so" {
        val opened = drive(AgendaEditorMachine.initial(), openNew("")).state
        drive(opened, AgendaEditorInput.Denied(AppQueryDenial())).state.screen.denied.shouldNotBeNull()
        val gone = answered(drive(AgendaEditorMachine.initial(), openEdit(timed("x", "X", "2026-06-15T08:00"))).state)
        gone.screen.gone.shouldNotBeNull().title shouldBe "This event was removed."
        // AN EDIT WITH NO EVENT does not read.
        AgendaEditorReads().requests(
            drive(AgendaEditorMachine.initial(), edit(AgendaEditorEvent(opened = AgendaEditorEvent.Opened(mode = AgendaEditorState.Mode.MODE_EDIT)))).state,
            clock,
        ).shouldBeNull()
        // THE BY-ID ANSWER WINS: absent there is gone, whatever the window lists.
        val event = timed("x", "X", "2026-06-15T08:00")
        drive(
            drive(AgendaEditorMachine.initial(), openEdit(event)).state,
            AgendaEditorInput.Answered(upcoming(event), PARTIES, "Europe/London", AgendaEventDetail()),
        ).state.screen.gone.shouldNotBeNull()
    }

    "a repeating event opened from a search hit edits the series, read by its id (#1047)" {
        // A SEARCH HIT IS THE SERIES: its instance key is its event id, which
        // no padded window lists — the window has `<id>:<clock>` occurrences.
        val occurrence = series("s1", "Stand-up", "2026-06-15T09:00", "2026-06-15T09:15")
        val hit = occurrence.copy(instance_key = "s1", original_start_local = null)
        val opened = drive(AgendaEditorMachine.initial(), openEdit(hit, day = "")).state
        val reads = AgendaEditorReads().requests(opened, clock).shouldNotBeNull()
        reads.first().agenda_event.shouldNotBeNull().let {
            it.event_id shouldBe "s1"
            it.instance_key shouldBe "s1"
            it.original_start_local shouldBe ""
            it.tz shouldBe "Europe/London"
        }
        reads.map { it.agenda_upcoming != null } shouldBe listOf(false, true, false)

        val loaded = drive(
            opened,
            AgendaEditorInput.Answered(upcoming(occurrence), PARTIES, "Europe/London", AgendaEventDetail(event = hit)),
        ).state
        loaded.screen.gone.shouldBeNull()
        val data = loaded.screen.data_.shouldNotBeNull()
        data.draft.shouldNotBeNull().title shouldBe "Stand-up"
        // THE SERIES ROW: no occurrence to skip, and a save edits the series.
        data.show_skip shouldBe false
        val saved = drive(loaded, edit(AgendaEditorEvent(title = AgendaEditorEvent.TitleChanged(text = "Daily"))), save())
        (saved.effects.single() as ScreenEffect.SubmitWrite).command shouldBe "schedule.edit_event"
    }
}) {
    companion object {
        fun edit(event: AgendaEditorEvent): AgendaEditorInput = AgendaEditorInput.View(event)

        fun openNew(
            day: String,
            kind: AgendaEditorState.Kind = AgendaEditorState.Kind.KIND_UNSPECIFIED,
            mode: AgendaEditorState.Mode = AgendaEditorState.Mode.MODE_CREATE,
        ): AgendaEditorInput =
            edit(AgendaEditorEvent(opened = AgendaEditorEvent.Opened(mode = mode, day = day, kind = kind)))

        fun pickKind(kind: AgendaEditorState.Kind): AgendaEditorInput =
            edit(AgendaEditorEvent(kind_picked = AgendaEditorEvent.KindPicked(kind = kind)))

        fun saveTask(id: String): AgendaEditorInput = AgendaEditorInput.SaveTask(id)

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
