package dev.centraid.shared

import centraid.core.v1.AgendaSearch
import centraid.core.v1.TasksCatchUp
import centraid.core.v1.TasksSearch
import centraid.core.v1.TasksView
import centraid.screen.v1.AgendaEmpty
import centraid.screen.v1.AgendaHomeEvent
import centraid.screen.v1.AgendaHomeState
import centraid.screen.v1.TasksCheck
import dev.centraid.shared.AgendaHomeSpec.Companion.TODAY
import dev.centraid.shared.AgendaHomeSpec.Companion.allDay
import dev.centraid.shared.AgendaHomeSpec.Companion.context
import dev.centraid.shared.AgendaHomeSpec.Companion.drive
import dev.centraid.shared.AgendaHomeSpec.Companion.landed
import dev.centraid.shared.AgendaHomeSpec.Companion.quietTasks
import dev.centraid.shared.AgendaHomeSpec.Companion.searchOpened
import dev.centraid.shared.AgendaHomeSpec.Companion.step
import dev.centraid.shared.AgendaHomeSpec.Companion.term
import dev.centraid.shared.AgendaHomeSpec.Companion.timed
import dev.centraid.shared.AgendaHomeSpec.Companion.upcoming
import dev.centraid.shared.AgendaHomeSpec.Companion.view
import dev.centraid.shared.AgendaTodoSpec.Companion.settle
import dev.centraid.shared.TasksSpec.Companion.dayGroup
import dev.centraid.shared.TasksSpec.Companion.overdueGroup
import dev.centraid.shared.TasksSpec.Companion.task
import dev.centraid.shared.TasksSpec.Companion.todayGroup
import dev.centraid.shared.apps.agenda.AgendaHome
import dev.centraid.shared.apps.agenda.AgendaHomeMachine
import dev.centraid.shared.apps.agenda.AgendaInput
import dev.centraid.shared.apps.agenda.TasksAnswers
import dev.centraid.shared.screen.ScreenEffect
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * TASKS ON THEIR DAYS (#1128, R-1128-2..4): an open task due on a day is a row
 * of that day on Day and Schedule, checked off in place; Day on today draws the
 * Overdue group and the absence notice; a search finds tasks as well as events;
 * Waiting draws none. `TasksSpec`'s Today and Upcoming assertions, on their new
 * host. Monday 15 June 2026, 09:42.
 */
class AgendaDatedTasksSpec : StringSpec({

    val day = AgendaHomeState.Destination.DESTINATION_DAY
    val schedule = AgendaHomeState.Destination.DESTINATION_SCHEDULE
    val waiting = AgendaHomeState.Destination.DESTINATION_WAITING

    "a task due today is a row of today: untimed after the all-day rows, timed among the timed rows, the now line among what has not started" {
        val home = landed(
            day,
            upcoming(
                timed("early", "Run", "2026-06-15T07:00", "2026-06-15T08:00"),
                allDay("bank", "Bank holiday", TODAY),
                timed("now", "Call", "2026-06-15T09:30", "2026-06-15T10:00"),
            ),
            tasks = quietTasks(
                today = listOf(
                    todayGroup(
                        task("untimed", "Buy milk", due = TODAY, days = 0, landsToday = true),
                        task("rent", "Pay rent", due = TODAY, time = "09:00", days = 0, landsToday = true),
                        task("notes", "Send notes", due = TODAY, time = "11:00", days = 0, landsToday = true),
                    ),
                ),
            ),
        )
        val section = home.screen.data_.shouldNotBeNull().days.single()
        section.items.map { it.event?.title ?: it.task?.title ?: "NOW" } shouldBe
            listOf("Bank holiday", "Buy milk", "Run", "Pay rent", "Call", "NOW", "Send notes")
        // THE ONE ROW SHAPE: the box says what it does, and the head names the day, so a row says its time only.
        section.items.mapNotNull { it.task }.associate { it.task_id to it.due_label } shouldBe
            mapOf("untimed" to "", "rent" to "09:00", "notes" to "11:00")
        section.items.first { it.task?.task_id == "untimed" }.task.shouldNotBeNull().let {
            it.check shouldBe TasksCheck.TASKS_CHECK_OPEN
            it.check_label shouldBe "Mark Buy milk done"
            it.can_check shouldBe true
        }
        // The events' count is the events' alone.
        home.screen.data_.shouldNotBeNull().event_count shouldBe 3
    }

    "Schedule gives a day of only tasks its own section; a hidden calendar hides no task; later days come from the Upcoming board" {
        val home = landed(
            schedule,
            upcoming(timed("a", "Gym", "2026-06-16T18:00", calendar = "cal-1")),
            tasks = quietTasks(
                today = listOf(todayGroup(task("t", "Today thing", due = TODAY, days = 0, landsToday = true))),
                later = listOf(
                    dayGroup("2026-06-17", task("b", "Bins", due = "2026-06-17", days = 2)),
                    dayGroup("2026-06-30", task("c", "Invoice", due = "2026-06-30", days = 15)),
                ),
            ),
        )
        val data = home.screen.data_.shouldNotBeNull()
        data.days.map { it.day } shouldBe listOf("2026-06-15", "2026-06-16", "2026-06-17", "2026-06-30")
        data.days.map { it.items.mapNotNull { item -> item.task?.title } } shouldBe
            listOf(listOf("Today thing"), emptyList(), listOf("Bins"), listOf("Invoice"))
        // HIDING THE CALENDAR takes the event and leaves the tasks.
        val hidden = drive(home, view(AgendaHomeEvent(calendar_toggled = AgendaHomeEvent.CalendarToggled(calendar_id = "cal-1")))).state
        hidden.screen.data_.shouldNotBeNull().days.map { it.day } shouldBe listOf("2026-06-15", "2026-06-17", "2026-06-30")
        // WAITING DRAWS NO TASK, and makes no day of one.
        val waits = drive(home, view(AgendaHomeEvent(band = AgendaHomeEvent.BandPicked(key = "waiting"))))
        waits.effects.shouldBeEmpty()
        waits.state.screen.data_.shouldNotBeNull().days.shouldBeEmpty()
        // Back on Schedule the held boards draw again, with no read.
        val back = drive(waits.state, view(AgendaHomeEvent(band = AgendaHomeEvent.BandPicked(key = "schedule"))))
        back.effects.shouldBeEmpty()
        back.state.screen.data_.shouldNotBeNull().days.size shouldBe 4
    }

    "an empty Day counts its tasks: a day with only a task is not nothing" {
        val empty = landed(day)
        empty.screen.data_.shouldNotBeNull().empty shouldBe AgendaEmpty.AGENDA_EMPTY_NOTHING_ON_DAY
        val taskOnly = landed(
            day,
            tasks = quietTasks(today = listOf(todayGroup(task("t", "Buy milk", due = TODAY, days = 0, landsToday = true)))),
        )
        taskOnly.screen.data_.shouldNotBeNull().let {
            it.empty shouldBe AgendaEmpty.AGENDA_EMPTY_NONE
            it.days.single().items.mapNotNull { item -> item.task }.single().title shouldBe "Buy milk"
        }
    }

    "Day on today draws the Overdue group with its verb, and the notice an absence names — no other anchor does" {
        val tasks = quietTasks(
            today = listOf(
                overdueGroup(task("a", "Pay rent", due = "2026-06-13", days = -2, overdue = true)),
                todayGroup(task("b", "Call Ana", due = TODAY, time = "09:00", days = 0, landsToday = true)),
            ),
            catchUp = TasksCatchUp(today = TODAY, away_days = 16, overdue = 34, absent = true),
        )
        val home = landed(day, tasks = tasks)
        val data = home.screen.data_.shouldNotBeNull()
        data.overdue.shouldNotBeNull().let {
            it.title shouldBe "Overdue"
            it.verb_label shouldBe "Reschedule"
            it.verb_key shouldBe "catch_up"
            it.meta shouldBe "1"
            it.rows.single().let { row ->
                row.due_label shouldBe "2 days ago"
                row.overdue shouldBe true
            }
        }
        data.notice.shouldNotBeNull().let {
            it.sentence shouldBe "You were away 16 days · 34 tasks came due"
            it.verb_label shouldBe "Reschedule"
            it.verb_key shouldBe "catch_up"
        }
        // The overdue work is above the day and not in it: today's section holds today's task alone.
        data.days.single().items.mapNotNull { it.task }.map { it.task_id } shouldBe listOf("b")

        // ANOTHER ANCHOR: none of it. Tomorrow, read and answered.
        val tomorrow = drive(home, step(1)).state
        val answered = drive(
            tomorrow,
            AgendaInput.Answered(upcoming(), context(), null, tasks),
        ).state
        answered.screen.anchor_day shouldBe "2026-06-16"
        answered.screen.data_.shouldNotBeNull().let {
            it.overdue.shouldBeNull()
            it.notice.shouldBeNull()
        }
        // SCHEDULE draws neither either: the Overdue head is Day's.
        landed(schedule, tasks = tasks).screen.data_.shouldNotBeNull().let {
            it.overdue.shouldBeNull()
            it.notice.shouldBeNull()
        }
        // No absence, no notice.
        landed(day, tasks = quietTasks(today = tasks.today!!.groups, catchUp = TasksCatchUp(today = TODAY)))
            .screen.data_.shouldNotBeNull().notice.shouldBeNull()
    }

    "a past day draws the open tasks that came due on it, as rows of it" {
        val tasks = quietTasks(today = listOf(overdueGroup(task("a", "Pay rent", due = "2026-06-14", days = -1, overdue = true))))
        val yesterday = drive(landed(day, tasks = tasks), step(-1)).state
        val answered = drive(yesterday, AgendaInput.Answered(upcoming(), context(), null, tasks)).state
        answered.screen.anchor_day shouldBe "2026-06-14"
        val data = answered.screen.data_.shouldNotBeNull()
        // NO OVERDUE GROUP ON A PAST DAY: the work is in its own day.
        data.overdue.shouldBeNull()
        data.days.single().items.mapNotNull { it.task }.single().title shouldBe "Pay rent"
    }

    "a box checks a task off in place: it is gone at once, Task done and Undo say so, and Undo is a new command" {
        val home = landed(
            day,
            tasks = quietTasks(today = listOf(todayGroup(task("a", "Call Ana", due = TODAY, days = 0, landsToday = true)))),
        )
        val checked = drive(home, view(AgendaHomeEvent(task_checked = AgendaHomeEvent.TaskChecked(task_id = "a"))))
        val done = checked.effects.single() as ScreenEffect.SubmitWrite
        done.command shouldBe "schedule.set_task_status"
        done.inputJson shouldBe """{"task_id":"a","status":"completed"}"""
        // IN PLACE: re-folded without a read.
        checked.state.screen.data_.shouldNotBeNull().let {
            it.days.shouldBeEmpty()
            // GENUINELY EMPTY: the only task was just checked off, so the sentence is right here.
            it.empty shouldBe AgendaEmpty.AGENDA_EMPTY_NOTHING_ON_DAY
        }
        checked.state.screen.status.shouldNotBeNull().let {
            it.sentence shouldBe "Task done"
            it.action_label shouldBe "Undo"
        }
        val undone = drive(checked.state, view(AgendaHomeEvent(status_acted = AgendaHomeEvent.StatusActed())))
        (undone.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"task_id":"a","status":"needs-action"}"""
        undone.state.screen.data_.shouldNotBeNull().days.single().items.mapNotNull { it.task }.single().task_id shouldBe "a"
        undone.state.screen.status.shouldBeNull()

        // A REFUSED CHECK-OFF takes the row back, with the core's sentence.
        val refused = drive(
            checked.state,
            settle(done.invokeKey, committed = false, sentence = "The vault is read-only."),
        ).state
        refused.screen.data_.shouldNotBeNull().days.single().items.mapNotNull { it.task }.single().task_id shouldBe "a"
        refused.screen.status.shouldNotBeNull().refused shouldBe true
        // A task that is not on screen is not checked.
        drive(home, view(AgendaHomeEvent(task_checked = AgendaHomeEvent.TaskChecked(task_id = "gone")))).effects.shouldBeEmpty()
    }

    "Day says nothing is on it only when nothing is: Overdue work or the notice alone is something" {
        // OVERDUE ALONE: no event, no task row, and no "Nothing on this day." under the group.
        val owed = landed(
            day,
            tasks = quietTasks(today = listOf(overdueGroup(task("a", "Pay rent", due = "2026-06-13", days = -2, overdue = true)))),
        ).screen.data_.shouldNotBeNull()
        owed.days.shouldBeEmpty()
        owed.overdue.shouldNotBeNull()
        owed.empty shouldBe AgendaEmpty.AGENDA_EMPTY_NONE
        owed.empty_title shouldBe ""
        // THE ABSENCE NOTICE ALONE is the same.
        val away = landed(
            day,
            tasks = quietTasks(catchUp = TasksCatchUp(today = TODAY, away_days = 16, overdue = 34, absent = true)),
        ).screen.data_.shouldNotBeNull()
        away.days.shouldBeEmpty()
        away.notice.shouldNotBeNull()
        away.empty shouldBe AgendaEmpty.AGENDA_EMPTY_NONE
        // A DAY WITH NEITHER (or whose only task was just checked off, below) IS GENUINELY EMPTY.
        landed(day).screen.data_.shouldNotBeNull().empty shouldBe AgendaEmpty.AGENDA_EMPTY_NOTHING_ON_DAY
    }

    "an Overdue row is checked off in place too" {
        val home = landed(
            day,
            tasks = quietTasks(today = listOf(overdueGroup(task("a", "Pay rent", due = "2026-06-13", days = -2, overdue = true)))),
        )
        val checked = drive(home, view(AgendaHomeEvent(task_checked = AgendaHomeEvent.TaskChecked(task_id = "a"))))
        checked.effects.single().shouldNotBeNull()
        checked.state.screen.data_.shouldNotBeNull().overdue.shouldBeNull()
    }

    "search finds tasks as well as events: a group above the days, no-match only when both are empty" {
        val home = landed(schedule, upcoming(timed("a", "Stand-up", "2026-06-16T09:00")))
        val typed = drive(home, searchOpened(), term("dentist")).state
        val both = drive(
            typed,
            AgendaInput.Answered(
                upcoming = null,
                context = context(),
                search = AgendaSearch(events = listOf(timed("d", "Dentist", "2026-05-02T14:00"))),
                tasks = TasksAnswers(
                    search = TasksSearch(
                        today = TODAY,
                        tasks = listOf(task("t", "Book dentist", due = "2026-06-20", days = 5)),
                    ),
                ),
            ),
        ).state
        val data = both.screen.data_.shouldNotBeNull()
        data.task_hits.single().let {
            it.title shouldBe "Tasks"
            it.meta shouldBe "1"
            it.rows.single().title shouldBe "Book dentist"
        }
        data.days.map { it.day } shouldBe listOf("2026-05-02")
        // TASKS ALONE ARE AN ANSWER: no "nothing matches" over them.
        val tasksOnly = drive(
            typed,
            AgendaInput.Answered(
                null,
                context(),
                AgendaSearch(),
                TasksAnswers(search = TasksSearch(today = TODAY, tasks = listOf(task("t", "Book dentist")))),
            ),
        ).state
        tasksOnly.screen.data_.shouldNotBeNull().let {
            it.empty shouldBe AgendaEmpty.AGENDA_EMPTY_NONE
            it.days.shouldBeEmpty()
            it.task_hits.single().rows.size shouldBe 1
        }
        tasksOnly.screen.search_ask shouldBe ""
        // NEITHER: no-match, and Ask is offered.
        val none = drive(typed, AgendaInput.Answered(null, context(), AgendaSearch(), TasksAnswers(search = TasksSearch(today = TODAY)))).state
        none.screen.data_.shouldNotBeNull().let {
            it.empty shouldBe AgendaEmpty.AGENDA_EMPTY_NO_MATCH
            it.task_hits.shouldBeEmpty()
        }
        none.screen.search_ask shouldBe "Find dentist"
        // Closing search CLEARS the hits and re-folds the held days and boards without a read.
        val closed = drive(both, view(AgendaHomeEvent(search_closed = AgendaHomeEvent.SearchClosed())))
        closed.effects.shouldBeEmpty()
        closed.state.screen.data_.shouldNotBeNull().let {
            it.task_hits.shouldBeEmpty()
            it.days.map { section -> section.day } shouldBe listOf("2026-06-16")
        }
        // A task hit is checked off in place.
        val hitChecked = drive(both, view(AgendaHomeEvent(task_checked = AgendaHomeEvent.TaskChecked(task_id = "t"))))
        hitChecked.effects.single().shouldNotBeNull()
        hitChecked.state.screen.data_.shouldNotBeNull().task_hits.shouldBeEmpty()
    }

    "the words a tasks search corrected stand when the events were not (#1097)" {
        val typed = drive(landed(day), searchOpened(), term("dentst")).state
        val corrected = drive(
            typed,
            AgendaInput.Answered(
                null,
                context(),
                AgendaSearch(),
                TasksAnswers(search = TasksSearch(today = TODAY, tasks = listOf(task("t", "Book dentist")), corrected = "dentist")),
            ),
        ).state
        corrected.screen.search_corrected shouldBe "dentist"
        // A new term clears them.
        drive(corrected, term("dent")).state.screen.search_corrected shouldBe ""
    }

    "a Day without its boards is a short answer, not an empty day" {
        val opened = drive(AgendaHomeMachine.initial(), view(AgendaHomeEvent(opened = AgendaHomeEvent.Opened()))).state
        val short = drive(opened, AgendaInput.Answered(upcoming(), context(), null)).state
        short.screen.data_.shouldBeNull()
        short.screen.failure.shouldNotBeNull()
    }

    "a change clears the held boards: coming back to Schedule from Waiting reads again" {
        val home = landed(schedule)
        val onWaiting = drive(home, view(AgendaHomeEvent(band = AgendaHomeEvent.BandPicked(key = "waiting")))).state
        val changed = drive(onWaiting, AgendaHomeMachine.rowsChanged("schedule_task", listOf("a"))!!).state
        val answered = drive(changed, AgendaInput.Answered(upcoming(), context(), null)).state
        answered.screen.destination shouldBe waiting
        val back = drive(answered, view(AgendaHomeEvent(band = AgendaHomeEvent.BandPicked(key = "schedule"))))
        back.effects shouldBe listOf(ScreenEffect.ReadPage(AgendaHomeMachine.SCREEN_ID, null))
        back.state.screen.loading.shouldNotBeNull()
    }
})
