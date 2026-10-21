package dev.centraid.shared

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.CommandStatus
import centraid.core.v1.TasksBoard
import centraid.core.v1.TasksCounts
import centraid.core.v1.TasksGroup
import centraid.core.v1.TasksGroupKind
import centraid.core.v1.TasksProject
import centraid.core.v1.TasksProjects
import centraid.core.v1.TasksSection
import centraid.core.v1.TasksView
import centraid.screen.v1.AgendaHomeEvent
import centraid.screen.v1.AgendaHomeState
import centraid.screen.v1.ImportSource
import dev.centraid.shared.AgendaHomeSpec.Companion.drive
import dev.centraid.shared.AgendaHomeSpec.Companion.view
import dev.centraid.shared.TasksSpec.Companion.ID
import dev.centraid.shared.TasksSpec.Companion.TODAY
import dev.centraid.shared.TasksSpec.Companion.board
import dev.centraid.shared.TasksSpec.Companion.task
import dev.centraid.shared.apps.agenda.AgendaHome
import dev.centraid.shared.apps.agenda.AgendaHomeMachine
import dev.centraid.shared.apps.agenda.AgendaInput
import dev.centraid.shared.apps.agenda.AgendaReads
import dev.centraid.shared.apps.agenda.TasksAnswers
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

/**
 * TO-DO, THE PLACE AGENDA TOOK FROM TASKS' HOME (#1128, R-1128-1): the Inbox's
 * tasks, then the projects by area, in one list.
 *
 * These are `TasksSpec`'s home assertions on their new host: the same quick
 * add, check-off and Undo, filing, new project, empties, band, denied gate and
 * re-read rules, driven through `AgendaHomeMachine` on `DESTINATION_TODO`.
 * Every fixture is a `tasks.*` answer as the core gives it. Monday 15 June 2026.
 */
class AgendaTodoSpec : StringSpec({

    val clock = DeviceClock.Reading(zone = "Europe/London", epochMillis = 1_781_516_520_000L)

    "To-do reads the Inbox board and the projects, in the device's zone — and no event" {
        val reads = AgendaReads.requests(openedTodo().state, clock).shouldNotBeNull()
        reads.size shouldBe 2
        reads[0].tasks_board.shouldNotBeNull().let {
            it.view shouldBe TasksView.TASKS_VIEW_INBOX
            it.tz shouldBe "Europe/London"
            it.limit shouldBe 100
        }
        reads[1].tasks_projects.shouldNotBeNull().tz shouldBe "Europe/London"
        reads.none { it.agenda_upcoming != null || it.agenda_day_context != null } shouldBe true
        AgendaReads.appId shouldBe "agenda"
    }

    "the Inbox, then the projects by area: named areas A to Z, then Projects for those in none" {
        val landed = todoOn(
            inboxBoard(task("a", "Idea")),
            TasksProjects(
                projects = listOf(
                    TasksProject(project_id = "p1", name = "Garden", area = "Home", open_count = 3),
                    TasksProject(project_id = "p2", name = "Taxes", open_count = 1),
                    TasksProject(project_id = "p3", name = "Launch", area = "Work", open_count = 0),
                ),
            ),
        )
        val data = landed.screen.data_.shouldNotBeNull()
        val todo = data.todo.shouldNotBeNull()
        todo.groups.single().title shouldBe "Inbox"
        todo.groups.single().rows.single().title shouldBe "Idea"
        todo.projects.map { it.title } shouldBe listOf("Home", "Work", "Projects")
        todo.projects[0].rows.single().let {
            it.title shouldBe "Garden"
            it.meta shouldBe "3 tasks"
            it.hue_key shouldNotBe ""
        }
        todo.count_label shouldBe "1 task · 3 projects"
        todo.new_project_label shouldBe "New project"
        todo.empty.shouldNotBeNull().headline shouldBe ""
        // TO-DO HAS NO DAY: no bar, no window.
        landed.screen.toolbar.shouldNotBeNull().shown shouldBe false
        landed.screen.destination shouldBe AgendaHomeState.Destination.DESTINATION_TODO
    }

    "the empty To-do says its own sentence, day one says one, and nothing open offers the reminders" {
        val empty = TasksCounts(open_ = 1, closed = 0)
        todoOn(inboxBoard().copy(counts = empty)).screen.data_!!.todo!!.empty!!.let {
            it.headline shouldBe "Nothing is waiting to be filed."
            it.action_label shouldBe "New project"
            // Work is open elsewhere: nothing to import over it.
            it.import_source shouldBe ImportSource.IMPORT_SOURCE_UNSPECIFIED
        }
        todoOn(inboxBoard().copy(counts = TasksCounts(open_ = 0, closed = 4))).screen.data_!!.todo!!.empty!!.import_source shouldBe
            ImportSource.IMPORT_SOURCE_REMINDERS
        val dayOne = todoOn(inboxBoard().copy(counts = TasksCounts()))
        dayOne.screen.data_!!.todo!!.empty!!.let {
            it.headline shouldBe "Add the first thing you must not forget."
            it.import_source shouldBe ImportSource.IMPORT_SOURCE_REMINDERS
        }
        // The action opens the new-project sheet.
        val acted = drive(
            todoOn(inboxBoard().copy(counts = empty)),
            view(AgendaHomeEvent(todo_empty_acted = AgendaHomeEvent.TodoEmptyActed())),
        ).state
        acted.screen.sheet shouldBe AgendaHomeState.Sheet.SHEET_NEW_PROJECT
        // A To-do that holds anything says no sentence at all.
        todoOn(inboxBoard(task("a", "Idea"))).screen.data_!!.todo!!.empty!!.headline shouldBe ""
    }

    "the band names To-do, the Plus adds a task there, and a title says nothing about a day" {
        val landed = todoOn(inboxBoard())
        landed.screen.band.map { it.key } shouldBe listOf("day", "schedule", "waiting", "todo", "more")
        landed.screen.band.single { it.key == "todo" }.let {
            it.label shouldBe "To-do"
            it.icon_key shouldBe "Todo"
        }
        landed.screen.band.filter { it.current }.map { it.key } shouldBe listOf("todo")
        landed.screen.add_label shouldBe "Add task"
        landed.screen.add_opens_quick_add shouldBe true
        landed.screen.quick_add.shouldNotBeNull().let {
            it.shown shouldBe true
            it.lands_label shouldBe "Add to Inbox"
            // THE HEADER'S PLUS (R-CHROME-1) is the quick add's door; the bar itself waits for it.
            it.add_label shouldBe "Add task"
            it.drawn shouldBe false
        }
        landed.screen.chrome.shouldNotBeNull().tasks.shouldNotBeNull().let {
            it.quick_add_placeholder shouldBe "Task name"
            it.file_verb shouldBe "Move to project"
            it.show_more shouldBe "Show more"
            it.new_project_title shouldBe "New project"
        }
        // OTHER PLACES: the Plus is the add sheet.
        val day = drive(landed, view(AgendaHomeEvent(band = AgendaHomeEvent.BandPicked(key = "day")))).state
        day.screen.add_label shouldBe "Add"
        day.screen.add_opens_quick_add shouldBe false
        day.screen.quick_add.shouldNotBeNull().shown shouldBe false
    }

    "the Plus opens the quick add; the keyboard leaving an empty bar puts it away, never typed words" {
        val landed = todoOn(inboxBoard())
        landed.screen.quick_add!!.drawn shouldBe false
        val opened = drive(landed, view(AgendaHomeEvent(quick_add_opened = AgendaHomeEvent.QuickAddOpened()))).state
        opened.screen.quick_add!!.let {
            it.drawn shouldBe true
            it.focused shouldBe true
        }
        drive(opened, view(AgendaHomeEvent(quick_add_closed = AgendaHomeEvent.QuickAddClosed()))).state.screen.quick_add!!.drawn shouldBe false

        val typed = drive(opened, view(AgendaHomeEvent(quick_add_changed = AgendaHomeEvent.QuickAddChanged(title = "Buy milk")))).state
        val kept = drive(typed, view(AgendaHomeEvent(quick_add_closed = AgendaHomeEvent.QuickAddClosed()))).state
        kept.screen.quick_add!!.let {
            it.drawn shouldBe true
            it.title shouldBe "Buy milk"
        }
        // AN ADD KEEPS IT OPEN for the next one.
        drive(typed, AgendaInput.Add(ID)).state.screen.quick_add!!.let {
            it.drawn shouldBe true
            it.title shouldBe ""
        }
        // NOTES' "SEND TO AGENDA" lands on To-do with the bar open and the words in it.
        val seeded = drive(
            AgendaHomeMachine.initial(),
            view(AgendaHomeEvent(opened = AgendaHomeEvent.Opened(quick_add_title = "Buy milk"))),
        ).state
        seeded.screen.destination shouldBe AgendaHomeState.Destination.DESTINATION_TODO
        drive(seeded, answerTodo(inboxBoard())).state.screen.quick_add!!.let {
            it.drawn shouldBe true
            it.focused shouldBe true
            it.title shouldBe "Buy milk"
        }
        // ANOTHER PLACE, OR SEARCH, puts it away.
        drive(opened, view(AgendaHomeEvent(band = AgendaHomeEvent.BandPicked(key = "schedule")))).state.screen.quick_add!!.drawn shouldBe false
        drive(opened, view(AgendaHomeEvent(search_opened = AgendaHomeEvent.SearchOpened()))).state.screen.quick_add!!.drawn shouldBe false
        // The Plus is To-do's alone.
        val day = drive(AgendaHomeMachine.initial(), view(AgendaHomeEvent(opened = AgendaHomeEvent.Opened()))).state
        drive(day, view(AgendaHomeEvent(quick_add_opened = AgendaHomeEvent.QuickAddOpened()))).state.screen.quick_add!!.drawn shouldBe false
    }

    "quick add: a bare title, the bridge's id, landing in the Inbox, drawn at once" {
        val landed = todoOn(inboxBoard())
        val typed = drive(landed, view(AgendaHomeEvent(quick_add_changed = AgendaHomeEvent.QuickAddChanged(title = " Buy milk ")))).state
        typed.screen.quick_add!!.can_submit shouldBe true
        // The proto event alone mints nothing: the bridge supplies the id.
        drive(typed, view(AgendaHomeEvent(quick_add_submitted = AgendaHomeEvent.QuickAddSubmitted()))).effects.shouldBeEmpty()

        val added = drive(typed, AgendaInput.Add(ID))
        val write = added.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "task.add"
        // TO-DO DATES NOTHING: the Inbox is for work with no day.
        write.inputJson shouldBe """{"id":"$ID","title":"Buy milk"}"""
        write.invokeKey shouldBe "task.add:$ID"
        added.state.screen.quick_add!!.title shouldBe ""
        val row = added.state.screen.data_!!.todo!!.groups.single { it.title == "Inbox" }.rows.single()
        row.task_id shouldBe ID
        row.pending shouldBe true
        row.can_check shouldBe false
        row.meta shouldBe "not saved yet"
        // A SECOND ADD with nothing typed — the title cleared at the first, and the bridge mints a
        // new id for every gesture — files no second task (#1089).
        drive(added.state, AgendaInput.Add("another-id")).effects.shouldBeEmpty()

        // COMMITTED: the status line says where it landed, and the next
        // answer — which carries the task — replaces the pending row.
        val committed = drive(added.state, settle(write.invokeKey, committed = true)).state
        committed.screen.status!!.sentence shouldBe "Added to Inbox"
        val reread = drive(committed, AgendaHomeMachine.rowsChanged("task", listOf(ID))!!).state
        val answered = drive(reread, answerTodo(inboxBoard(task(ID, "Buy milk")))).state
        answered.screen.data_!!.todo!!.groups.single().rows.single().pending shouldBe false
    }

    "quick add refused: the row is taken back and the core's sentence is the status line" {
        val landed = todoOn(inboxBoard())
        val typed = drive(landed, view(AgendaHomeEvent(quick_add_changed = AgendaHomeEvent.QuickAddChanged(title = "Idea")))).state
        val added = drive(typed, AgendaInput.Add(ID))
        (added.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldNotContain "due_at"
        added.state.screen.data_!!.todo!!.groups.single().title shouldBe "Inbox"
        val refused = drive(
            added.state,
            settle("task.add:$ID", committed = false, sentence = "The vault is read-only."),
        ).state
        refused.screen.data_!!.todo!!.groups.shouldBeEmpty()
        refused.screen.status!!.let {
            it.sentence shouldBe "The vault is read-only."
            it.refused shouldBe true
        }
    }

    "check-off hides the row, says Task done with Undo; Undo is a NEW command and the row comes back" {
        val landed = todoOn(inboxBoard(task("a", "Call Ana")))
        val checked = drive(landed, view(AgendaHomeEvent(task_checked = AgendaHomeEvent.TaskChecked(task_id = "a"))))
        val done = checked.effects.single() as ScreenEffect.SubmitWrite
        done.command shouldBe "task.complete"
        done.inputJson shouldBe """{"id":"a"}"""
        checked.state.screen.data_!!.todo!!.groups.shouldBeEmpty()
        checked.state.screen.status!!.let {
            it.sentence shouldBe "Task done"
            it.action_label shouldBe "Undo"
        }

        val undone = drive(checked.state, view(AgendaHomeEvent(status_acted = AgendaHomeEvent.StatusActed())))
        val back = undone.effects.single() as ScreenEffect.SubmitWrite
        back.command shouldBe "task.reopen"
        back.inputJson shouldBe """{"id":"a"}"""
        back.invokeKey shouldNotBe done.invokeKey
        undone.state.screen.data_!!.todo!!.groups.single().rows.single().task_id shouldBe "a"
        undone.state.screen.status.shouldBeNull()

        // Checking it off again is not a replay of the first.
        val again = drive(undone.state, view(AgendaHomeEvent(task_checked = AgendaHomeEvent.TaskChecked(task_id = "a"))))
        (again.effects.single() as ScreenEffect.SubmitWrite).invokeKey shouldNotBe done.invokeKey
    }

    "a repeating task offers no Undo, and names where its next one landed" {
        val daily = task("r", "Water plants", due = TODAY, days = 0, landsToday = true)
            .copy(repeats = true, recurrence_summary = "Daily", series_id = "s1")
        val landed = todoOn(inboxBoard(daily))
        landed.screen.data_!!.todo!!.groups.single().rows.single().meta shouldContain "Daily"
        val checked = drive(landed, view(AgendaHomeEvent(task_checked = AgendaHomeEvent.TaskChecked(task_id = "r"))))
        checked.state.screen.status!!.action_label shouldBe ""
        val key = (checked.effects.single() as ScreenEffect.SubmitWrite).invokeKey
        val committed = drive(checked.state, settle(key, committed = true)).state
        val reread = drive(committed, AgendaHomeMachine.rowsChanged("task", listOf("r"))!!).state
        val next = daily.copy(task_id = "r2", due_day = "2026-06-16", days_from_today = 1, lands_today = false)
        val board = inboxBoard().copy(
            groups = listOf(TasksGroup(kind = TasksGroupKind.TASKS_GROUP_KIND_INBOX, key = "inbox", tasks = listOf(next))),
        )
        drive(reread, answerTodo(board)).state.screen.status!!.sentence shouldBe "Task done · the next one is Tomorrow"
    }

    "filing: a sheet of Inbox, projects and sections; a project clears the section; Inbox loses the row" {
        val b = inboxBoard(task("a", "Seeds")).copy(
            projects = listOf(TasksProject(project_id = "p1", name = "Garden")),
            sections = listOf(TasksSection(section_id = "s1", project_id = "p1", name = "Beds")),
        )
        val landed = todoOn(b, TasksProjects(projects = b.projects, sections = b.sections))
        landed.screen.data_!!.todo!!.groups.single().rows.single().can_file shouldBe true
        val sheet = drive(landed, view(AgendaHomeEvent(file_requested = AgendaHomeEvent.FileRequested(task_id = "a")))).state
        sheet.screen.sheet shouldBe AgendaHomeState.Sheet.SHEET_FILE
        sheet.screen.file_choices.map { it.key } shouldBe listOf("inbox", "project:p1", "section:s1")
        sheet.screen.file_choices.first().selected shouldBe true
        sheet.screen.file_choices.last().indented shouldBe true

        val filed = drive(sheet, view(AgendaHomeEvent(file_chosen = AgendaHomeEvent.FileChosen(key = "project:p1"))))
        val write = filed.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "task.organize"
        write.inputJson shouldBe """{"id":"a","project_id":"p1","section_id":null,"position":0}"""
        filed.state.screen.sheet shouldBe AgendaHomeState.Sheet.SHEET_NONE
        filed.state.screen.data_!!.todo!!.groups.shouldBeEmpty()
        drive(filed.state, settle(write.invokeKey, committed = true)).state.screen.status!!.sentence shouldBe "Filed in Garden"

        val toSection = drive(sheet, view(AgendaHomeEvent(file_chosen = AgendaHomeEvent.FileChosen(key = "section:s1"))))
        (toSection.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe
            """{"id":"a","project_id":"p1","section_id":"s1","position":0}"""
        // A KEY THE SHEET NO LONGER HOLDS files nothing and shuts it.
        drive(sheet, view(AgendaHomeEvent(file_chosen = AgendaHomeEvent.FileChosen(key = "project:gone")))).let {
            it.effects.shouldBeEmpty()
            it.state.screen.sheet shouldBe AgendaHomeState.Sheet.SHEET_NONE
        }
    }

    "a new project is a save_project write from the sheet, reachable from To-do whatever it holds" {
        val landed = todoOn(inboxBoard(task("a", "Idea")))
        landed.screen.data_!!.todo!!.new_project_label shouldBe "New project"
        val sheet = drive(landed, view(AgendaHomeEvent(sheet_opened = AgendaHomeEvent.SheetOpened(sheet = AgendaHomeState.Sheet.SHEET_NEW_PROJECT)))).state
        sheet.screen.sheet shouldBe AgendaHomeState.Sheet.SHEET_NEW_PROJECT
        sheet.screen.new_project_can_submit shouldBe false
        val named = drive(sheet, view(AgendaHomeEvent(new_project_name = AgendaHomeEvent.NewProjectNameChanged(name = "Garden")))).state
        named.screen.new_project_can_submit shouldBe true
        val made = drive(named, view(AgendaHomeEvent(new_project_submitted = AgendaHomeEvent.NewProjectSubmitted())))
        (made.effects.single() as ScreenEffect.SubmitWrite).let {
            it.command shouldBe "container.create"
            it.inputJson shouldBe """{"kind":"project","title":"Garden"}"""
        }
        made.state.screen.sheet shouldBe AgendaHomeState.Sheet.SHEET_NONE
        drive(made.state, settle((made.effects.single() as ScreenEffect.SubmitWrite).invokeKey, committed = true)).state
            .screen.status!!.sentence shouldBe "Project created"
        // Closing the sheet drops the name.
        drive(named, view(AgendaHomeEvent(sheet_closed = AgendaHomeEvent.SheetClosed()))).state.screen.new_project_name shouldBe ""
    }

    "the window: a board that is not everything says so, and Show more widens it to the ceiling" {
        val landed = todoOn(inboxBoard(task("a", "Idea")).copy(truncated = true, window = 100))
        landed.screen.data_!!.todo!!.let {
            it.window_label shouldBe "100 tasks · more not shown"
            it.can_show_more shouldBe true
        }
        val more = drive(landed, view(AgendaHomeEvent(next_page = AgendaHomeEvent.NextPageRequested())))
        more.effects shouldBe listOf(ScreenEffect.ReadPage(AgendaHomeMachine.SCREEN_ID, null))
        AgendaReads.requests(more.state, clock)!![0].tasks_board!!.limit shouldBe 200
        var state = more.state
        repeat(5) {
            state = drive(state, answerTodo(inboxBoard().copy(truncated = true, window = 100)), view(AgendaHomeEvent(next_page = AgendaHomeEvent.NextPageRequested()))).state
        }
        AgendaReads.requests(state, clock)!![0].tasks_board!!.limit shouldBe 500
        drive(state, answerTodo(inboxBoard().copy(truncated = true))).state.screen.data_!!.todo!!.can_show_more shouldBe false
    }

    "More holds the calendars, the Tasks places, and what Agenda may read — and a Tasks place changes nothing here" {
        val landed = todoOn(inboxBoard())
        val more = drive(landed, view(AgendaHomeEvent(band = AgendaHomeEvent.BandPicked(key = "more")))).state
        more.screen.sheet shouldBe AgendaHomeState.Sheet.SHEET_MORE
        more.screen.more_rows.map { it.key } shouldBe listOf("anytime", "logbook", "reminders", "trash", "reads")
        more.screen.more_rows.first().section shouldBe "Tasks"
        more.screen.more_rows.map { it.icon_key }.take(4) shouldBe listOf("Layers", "Book", "Bell", "Trash")
        more.screen.more_rows.none { it.icon_key == "Search" || it.key == "all" || it.key == "catch_up" } shouldBe true
        more.screen.band.single { it.key == "more" }.current shouldBe true
        // An intent closes the sheet and changes nothing else.
        drive(more, view(AgendaHomeEvent(more_row = AgendaHomeEvent.MoreRowPicked(key = "logbook")))).let {
            it.effects.shouldBeEmpty()
            it.state.screen.sheet shouldBe AgendaHomeState.Sheet.SHEET_NONE
        }
        val reads = drive(more, view(AgendaHomeEvent(more_row = AgendaHomeEvent.MoreRowPicked(key = "reads")))).state
        reads.screen.sheet shouldBe AgendaHomeState.Sheet.SHEET_READS
        reads.screen.chrome!!.reads_facts.map { it.label } shouldBe listOf("Reads", "Writes", "Leaves this phone")
    }

    "another place reads its own window; coming back to To-do re-folds what is held" {
        val landed = todoOn(inboxBoard(task("a", "Idea")))
        val day = drive(landed, view(AgendaHomeEvent(band = AgendaHomeEvent.BandPicked(key = "day"))))
        day.state.screen.destination shouldBe AgendaHomeState.Destination.DESTINATION_DAY
        day.state.screen.loading.shouldNotBeNull()
        day.effects shouldBe listOf(ScreenEffect.ReadPage(AgendaHomeMachine.SCREEN_ID, null))
        // Back to the lit tab's own answers: held, so no read.
        val back = drive(todoOn(inboxBoard(task("a", "Idea"))), view(AgendaHomeEvent(band = AgendaHomeEvent.BandPicked(key = "todo"))))
        back.effects.shouldBeEmpty()
        back.state.screen.data_!!.todo!!.groups.single().rows.single().title shouldBe "Idea"
        // A change makes the held answers stale: they are read again after leaving.
        val stale = drive(landed, AgendaHomeMachine.rowsChanged("task", listOf("a"))!!).state
        val away = drive(drive(stale, answerTodo(inboxBoard(task("a", "Idea")))).state, view(AgendaHomeEvent(band = AgendaHomeEvent.BandPicked(key = "day")))).state
        away.screen.destination shouldBe AgendaHomeState.Destination.DESTINATION_DAY
    }

    "denied is the kit's gate: no band, no quick add, the receipt named" {
        val denied = drive(openedTodo().state, AgendaInput.Denied(AppQueryDenial(code = "rcp_8802"))).state
        denied.screen.denied.shouldNotBeNull().let {
            it.title shouldBe "Agenda cannot read this vault"
            it.receipt shouldBe "rcp_8802"
        }
        denied.screen.band.shouldBeEmpty()
        denied.screen.quick_add!!.shown shouldBe false
    }

    "a change re-reads over the rows; an answer that raced a newer read is dropped; a failed read is no empty list" {
        val landed = todoOn(inboxBoard(task("a", "Call Ana")))
        AgendaHomeMachine.rowsChanged("task", listOf("a")).shouldNotBeNull()
        AgendaHomeMachine.rowsChanged("container", listOf("p")).shouldNotBeNull()
        AgendaHomeMachine.rowsChanged("edge", listOf("t")).shouldNotBeNull()
        AgendaHomeMachine.rowsChanged("locker_item", listOf("x")).shouldBeNull()
        val reading = drive(landed, AgendaHomeMachine.rowsChanged("task", listOf("a"))!!)
        reading.effects shouldBe listOf(ScreenEffect.ReadPage(AgendaHomeMachine.SCREEN_ID, null))
        reading.state.screen.data_.shouldNotBeNull()
        val queued = drive(reading.state, AgendaHomeMachine.rowsChanged("container", listOf("p"))!!)
        queued.effects.shouldBeEmpty()
        val stale = drive(queued.state, answerTodo(inboxBoard()))
        stale.effects shouldBe listOf(ScreenEffect.ReadPage(AgendaHomeMachine.SCREEN_ID, null))
        stale.state.screen.data_!!.todo!!.groups.single().rows.single().task_id shouldBe "a"

        val failed = drive(openedTodo().state, AgendaReads.refused(Reads.refused("No vault is open on this device."))).state
        failed.screen.failure!!.sentence shouldBe "No vault is open on this device."
        failed.screen.data_.shouldBeNull()
        // HALF AN ANSWER IS NOT A WHOLE ONE: the Inbox without the projects.
        val short = drive(openedTodo().state, AgendaInput.Answered(null, null, null, TasksAnswers(inbox = inboxBoard()))).state
        short.screen.data_.shouldBeNull()
        short.screen.failure.shouldNotBeNull()
    }
}) {
    companion object {
        fun openedTodo() = AgendaHomeMachine.reduce(
            AgendaHomeMachine.initial(),
            view(
                AgendaHomeEvent(
                    opened = AgendaHomeEvent.Opened(destination = AgendaHomeState.Destination.DESTINATION_TODO),
                ),
            ),
        )

        fun answerTodo(inbox: TasksBoard, projects: TasksProjects = TasksProjects()): AgendaInput =
            AgendaInput.Answered(null, null, null, TasksAnswers(inbox = inbox, projects = projects))

        fun todoOn(inbox: TasksBoard, projects: TasksProjects = TasksProjects()): AgendaHome =
            drive(openedTodo().state, answerTodo(inbox, projects)).state

        fun inboxBoard(vararg tasks: centraid.core.v1.TasksTask): TasksBoard = board(
            TasksView.TASKS_VIEW_INBOX,
            *if (tasks.isEmpty()) {
                emptyArray()
            } else {
                arrayOf(TasksGroup(kind = TasksGroupKind.TASKS_GROUP_KIND_INBOX, key = "inbox", tasks = tasks.toList()))
            },
        ).copy(counts = TasksCounts(open_ = tasks.size))

        fun settle(key: String, committed: Boolean, sentence: String = ""): AgendaInput = AgendaInput.View(
            AgendaHomeEvent(
                write_settled = WriteLaw.settledOf(
                    if (committed) CommandStatus.COMMAND_STATUS_EXECUTED else CommandStatus.COMMAND_STATUS_FAILED,
                    sentence,
                    key,
                ),
            ),
        )
    }
}
