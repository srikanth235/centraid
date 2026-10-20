package dev.centraid.shared

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.CommandStatus
import centraid.core.v1.TasksBoard
import centraid.core.v1.TasksCatchUp
import centraid.core.v1.TasksCounts
import centraid.core.v1.TasksGroup
import centraid.core.v1.TasksGroupKind
import centraid.core.v1.TasksProject
import centraid.core.v1.TasksProjects
import centraid.core.v1.TasksSearch
import centraid.core.v1.TasksSection
import centraid.core.v1.TasksTag
import centraid.core.v1.TasksTask
import centraid.core.v1.TasksTaskDetail
import centraid.core.v1.TasksView
import centraid.screen.v1.Autosave
import centraid.screen.v1.TasksCatchUpEvent
import centraid.screen.v1.TasksCheck
import centraid.screen.v1.TasksDetailEvent
import centraid.screen.v1.TasksDetailState
import centraid.screen.v1.TasksListEvent
import centraid.screen.v1.TasksListState
import centraid.screen.v1.TasksProjectEvent
import centraid.screen.v1.TrashListData
import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.TrashRow
import dev.centraid.design.copy.SharedCopy
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.apps.tasks.TasksCatchUpInput
import dev.centraid.shared.apps.tasks.TasksCatchUpMachine
import dev.centraid.shared.apps.tasks.TasksCatchUpPage
import dev.centraid.shared.apps.tasks.TasksCatchUpReads
import dev.centraid.shared.apps.tasks.TasksDetail
import dev.centraid.shared.apps.tasks.TasksDetailInput
import dev.centraid.shared.apps.tasks.TasksDetailMachine
import dev.centraid.shared.apps.tasks.TasksDetailReads
import dev.centraid.shared.apps.tasks.TasksList
import dev.centraid.shared.apps.tasks.TasksListInput
import dev.centraid.shared.apps.tasks.TasksListMachine
import dev.centraid.shared.apps.tasks.TasksListReads
import dev.centraid.shared.apps.tasks.TasksProjectInput
import dev.centraid.shared.apps.tasks.TasksProjectMachine
import dev.centraid.shared.apps.tasks.TasksProjectPage
import dev.centraid.shared.apps.tasks.TasksProjectReads
import dev.centraid.shared.apps.tasks.TasksTrashMachine
import dev.centraid.shared.kit.AutosaveLaw
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import dev.centraid.shared.kit.tasks.TasksRows

/**
 * TASKS ON THE PHONE (#1029 port): from the core's typed answers to what a
 * view draws, and from a member's gesture to the write it makes.
 *
 * Every fixture is a `tasks.*` answer as the core gives it — civil strings
 * already in the device's zone, groups already made — so what is pinned here
 * is the shared half: which queries, what the rows say, which command with
 * which input, and what a local change does without a read. Monday 15 June
 * 2026.
 */
class TasksSpec : StringSpec({

    val clock = DeviceClock.Reading(zone = "Europe/London", epochMillis = 1_781_516_520_000L)

    // -----------------------------------------------------------------
    // Rows
    // -----------------------------------------------------------------

    "a project's hue is a colour role like People's and Agenda's — cTeal, never the wheel's word (#1047)" {
        val rows = TasksRows
        rows.hueOf("p1", TasksProject(project_id = "p1", color = "var(--c-teal)")) shouldBe "cTeal"
        // No stored hue: the id's own, still a role.
        val own = rows.hueOf("p1", TasksProject(project_id = "p1"))
        own shouldBe dev.centraid.shared.design.PartyHueWheel.role(dev.centraid.shared.design.PartyHueWheel.identityHueKey("p1"))
        own.startsWith("c") shouldBe true
        rows.hueOf("p1", null).startsWith("c") shouldBe true
    }

    // -----------------------------------------------------------------
    // tasks.list
    // -----------------------------------------------------------------

    "the list reads its view; the Logbook's box REOPENS, and a done row is drawn there only" {
        TasksListReads.requests(openList(TasksListState.View.VIEW_LOGBOOK).state, clock)!!.single().tasks_board!!.view shouldBe TasksView.TASKS_VIEW_LOGBOOK
        TasksListReads.requests(openList(TasksListState.View.VIEW_ANYTIME).state, clock)!!.single().tasks_board!!.view shouldBe TasksView.TASKS_VIEW_ANYTIME
        val done = task("d", "Filed taxes").copy(status = "completed", completed_day = "2026-06-14")
        val released = task("w", "Old idea").copy(status = "cancelled", completed_day = "2026-06-10")
        val logbook = listOn(
            TasksListState.View.VIEW_LOGBOOK,
            board(
                TasksView.TASKS_VIEW_LOGBOOK,
                TasksGroup(kind = TasksGroupKind.TASKS_GROUP_KIND_DONE, key = "done", tasks = listOf(done)),
                TasksGroup(kind = TasksGroupKind.TASKS_GROUP_KIND_WONT_DO, key = "wont", tasks = listOf(released)),
            ),
        )
        logbook.screen.title shouldBe "Logbook"
        val data = logbook.screen.data_.shouldNotBeNull()
        data.groups.map { it.title } shouldBe listOf("Done", "Won't do")
        data.groups[0].rows.single().let {
            it.check shouldBe TasksCheck.TASKS_CHECK_DONE
            it.check_label shouldBe "Reopen Filed taxes"
            it.meta shouldBe "Yesterday"
            it.can_file shouldBe false
        }
        data.groups[1].rows.single().check shouldBe TasksCheck.TASKS_CHECK_WONT_DO
        val reopened = TasksListMachine.reduce(logbook, TasksListInput.View(TasksListEvent(row_checked = TasksListEvent.RowChecked(task_id = "d"))))
        (reopened.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"task_id":"d","status":"needs-action"}"""
        reopened.state.screen.status!!.sentence shouldBe "Task reopened"
        reopened.state.screen.data_!!.groups.map { it.title } shouldBe listOf("Won't do")
    }

    "Reminders: a moment when the core supplies one, else 'on the day' — never an invented 09:00" {
        val timed = task("a", "Call", due = "2026-06-16", time = "09:00", days = 1).copy(remind_before_min = 30, remind_at_local = "2026-06-16T08:30")
        val dated = task("b", "Bins", due = "2026-06-17", days = 2).copy(remind_before_min = 0)
        val list = listOn(TasksListState.View.VIEW_REMINDERS, board(TasksView.TASKS_VIEW_REMINDERS, TasksGroup(kind = TasksGroupKind.TASKS_GROUP_KIND_REMINDERS, key = "r", tasks = listOf(timed, dated))))
        val rows = list.screen.data_!!.groups.single().rows
        rows[0].meta shouldContain "reminder Tomorrow 08:30"
        rows[1].meta shouldContain "reminder on the day"
        rows[1].meta shouldNotContain "09:00"
    }

    "each list view says its own empty sentence; a window that is not everything says so" {
        listOn(TasksListState.View.VIEW_ANYTIME, board(TasksView.TASKS_VIEW_ANYTIME)).screen.data_!!.empty!!.headline shouldBe "Nothing undated is open."
        listOn(TasksListState.View.VIEW_ALL, board(TasksView.TASKS_VIEW_ALL)).screen.data_!!.empty!!.headline shouldBe "Nothing is open."
        listOn(TasksListState.View.VIEW_LOGBOOK, board(TasksView.TASKS_VIEW_LOGBOOK)).screen.data_!!.empty!!.headline shouldBe "Nothing is done yet."
        listOn(TasksListState.View.VIEW_REMINDERS, board(TasksView.TASKS_VIEW_REMINDERS)).screen.data_!!.empty!!.headline shouldBe "No open task has a reminder."
        val windowed = listOn(TasksListState.View.VIEW_ALL, board(TasksView.TASKS_VIEW_ALL, TasksGroup(kind = TasksGroupKind.TASKS_GROUP_KIND_UNDATED, key = "u", tasks = listOf(task("a", "Idea")))).copy(truncated = true, window = 100))
        windowed.screen.data_!!.let {
            it.window_label shouldBe "100 tasks · more not shown"
            it.can_show_more shouldBe true
        }
        val wider = TasksListMachine.reduce(windowed, TasksListInput.View(TasksListEvent(next_page = TasksListEvent.NextPageRequested())))
        TasksListReads.requests(wider.state, clock)!!.single().tasks_board!!.limit shouldBe 200
    }

    "a row's meta line: project, repeats, missed, effort, tags, family, age" {
        val behind = task("a", "Rent", due = "2026-06-19", days = 4).copy(
            project_id = "p1",
            repeats = true,
            recurrence_summary = "Monthly",
            missed = 2,
            effort_min = 25,
            tags = listOf(TasksTag(tag_id = "t", concept_id = "c", label = "home")),
            children = listOf(task("c1", "Transfer"), task("c2", "Receipt").copy(status = "completed")),
            done_children = 1,
            priority = 3,
        )
        // 23:30 UTC on 31 October is 1 November in the member's zone: the core's day names the month.
        val old = task("b", "Paint shed").copy(age_days = 200, created_at = "2025-10-31T23:30:00.000Z", created_local_day = "2025-11-01")
        val b = board(TasksView.TASKS_VIEW_ALL, TasksGroup(kind = TasksGroupKind.TASKS_GROUP_KIND_DATED, key = "d", tasks = listOf(behind)), TasksGroup(kind = TasksGroupKind.TASKS_GROUP_KIND_UNDATED, key = "u", tasks = listOf(old)))
            .copy(projects = listOf(TasksProject(project_id = "p1", name = "Home admin")))
        val rows = listOn(TasksListState.View.VIEW_ALL, b).screen.data_!!.groups.flatMap { it.rows }
        rows[0].meta shouldBe "Home admin · Monthly · missed 2 · next is Fri 19 June · ~25 min · #home · 1 of 2"
        rows[0].priority_label shouldBe "Now"
        rows[0].children.map { it.subtask } shouldBe listOf(true, true)
        rows[1].meta shouldBe "sitting since November"
        // NO LOCAL DAY ANSWERED: the month is not guessed from a UTC instant.
        TasksRows.meta(old.copy(created_local_day = ""), TasksRows.Context(today = "2026-06-15")) shouldBe ""
    }

    // -----------------------------------------------------------------
    // tasks.project
    // -----------------------------------------------------------------

    "a project: its unsectioned work, then every section — an empty one too — each with Add task" {
        val reads = TasksProjectReads.requests(openProject().state, clock)!!.single().tasks_board.shouldNotBeNull()
        reads.view shouldBe TasksView.TASKS_VIEW_PROJECT
        reads.project_id shouldBe "p1"
        TasksProjectReads.requests(TasksProjectMachine.initial(), clock).shouldBeNull()

        val page = projectOn(
            board(
                TasksView.TASKS_VIEW_PROJECT,
                TasksGroup(kind = TasksGroupKind.TASKS_GROUP_KIND_UNSECTIONED, key = "u", tasks = listOf(task("a", "Order seeds", project = "p1"))),
                TasksGroup(kind = TasksGroupKind.TASKS_GROUP_KIND_SECTION, key = "s1", section_id = "s1", tasks = emptyList()),
            ).copy(
                projects = listOf(TasksProject(project_id = "p1", name = "Garden")),
                sections = listOf(TasksSection(section_id = "s1", project_id = "p1", name = "Beds")),
            ),
        )
        page.screen.title shouldBe "Garden"
        val data = page.screen.data_.shouldNotBeNull()
        data.found shouldBe true
        data.groups.map { it.title } shouldBe listOf("No section", "Beds")
        data.groups.map { it.verb_key } shouldBe listOf("add:", "add:s1")
        data.groups[1].rows.shouldBeEmpty()
        // Inside the project, a row does not name the project again.
        data.groups[0].rows.single().meta shouldBe ""
        data.add_section_label shouldBe "Add section"

        // POINT THE QUICK ADD AT BEDS: add_task, then organize into it.
        val pointed = TasksProjectMachine.reduce(page, TasksProjectInput.View(TasksProjectEvent(group_verb = TasksProjectEvent.GroupVerb(key = "add:s1")))).state
        pointed.screen.quick_add!!.lands_label shouldBe "Add to Garden · Beds"
        // A PUSHED PAGE HAS NO PLUS: its bar is always drawn.
        pointed.screen.quick_add!!.drawn shouldBe true
        val typed = TasksProjectMachine.reduce(pointed, TasksProjectInput.View(TasksProjectEvent(quick_add_changed = TasksProjectEvent.QuickAddChanged(title = "Tulips")))).state
        val added = TasksProjectMachine.reduce(typed, TasksProjectInput.Add(ID))
        val add = added.effects.single() as ScreenEffect.SubmitWrite
        add.inputJson shouldBe """{"task_id":"$ID","title":"Tulips"}"""
        added.state.screen.data_!!.groups[1].rows.single().pending shouldBe true
        val filed = TasksProjectMachine.reduce(added.state, TasksProjectInput.View(TasksProjectEvent(write_settled = WriteLaw.settledOf(CommandStatus.COMMAND_STATUS_EXECUTED, "", add.invokeKey))))
        (filed.effects.single() as ScreenEffect.SubmitWrite).let {
            it.command shouldBe "schedule.organize_task"
            it.inputJson shouldBe """{"task_id":"$ID","project_id":"p1","section_id":"s1","sort_order":0}"""
        }

        val sheet = TasksProjectMachine.reduce(page, TasksProjectInput.View(TasksProjectEvent(add_section = TasksProjectEvent.AddSectionRequested()))).state
        val named = TasksProjectMachine.reduce(sheet, TasksProjectInput.View(TasksProjectEvent(section_name = TasksProjectEvent.SectionNameChanged(name = "Pots")))).state
        val made = TasksProjectMachine.reduce(named, TasksProjectInput.View(TasksProjectEvent(section_submitted = TasksProjectEvent.SectionSubmitted())))
        (made.effects.single() as ScreenEffect.SubmitWrite).let {
            it.command shouldBe "schedule.save_section"
            it.inputJson shouldBe """{"project_id":"p1","name":"Pots"}"""
        }
    }

    "a project the answer does not name is gone" {
        projectOn(board(TasksView.TASKS_VIEW_PROJECT)).screen.data_!!.let {
            it.found shouldBe false
            it.empty!!.headline shouldBe "This project is gone."
        }
    }

    // -----------------------------------------------------------------
    // tasks.detail
    // -----------------------------------------------------------------

    "the detail reads the task and the projects; fields are computed, Repeats is the core's sentence" {
        val reads = TasksDetailReads.requests(openDetail().state, clock)!!
        reads[0].tasks_task!!.task_id shouldBe "a"
        reads[1].tasks_projects.shouldNotBeNull()

        val detail = detailOn(task("a", "Rent", due = "2026-06-19", time = "09:00", days = 4).copy(repeats = true, recurrence_summary = "Every month on the 19th", recurrence_anchor = "completion", remind_before_min = 30, remind_at_local = "2026-06-19T08:30", rrule = "FREQ=MONTHLY"))
        val data = detail.screen.data_.shouldNotBeNull()
        data.draft!!.title shouldBe "Rent"
        val fields = data.fields.associateBy { it.key }
        fields.keys.toList() shouldBe listOf("when", "time", "reminder", "repeats", "anchor", "priority", "effort", "project", "tags")
        fields.getValue("when").value_ shouldBe "Fri 19 June"
        fields.getValue("when").pick_date shouldBe true
        // THE PICKERS OPEN ON THE DUE DAY AND TIME, in the machine's words.
        fields.getValue("when").day shouldBe "2026-06-19"
        fields.getValue("when").pick_label shouldBe TasksCopy.PICK_DATE
        fields.getValue("time").time shouldBe "09:00"
        fields.getValue("time").pick_label shouldBe TasksCopy.PICK_TIME
        fields.getValue("time").value_ shouldBe "09:00"
        fields.getValue("reminder").value_ shouldBe "Fri 19 June 08:30"
        fields.getValue("repeats").value_ shouldBe "Every month on the 19th"
        // The stored rule rides for the picker and selects its preset.
        fields.getValue("repeats").raw shouldBe "FREQ=MONTHLY"
        fields.getValue("repeats").choices.single { it.selected }.key shouldBe "monthly"
        fields.getValue("anchor").choices.single { it.selected }.key shouldBe "completion"
        fields.getValue("priority").value_ shouldBe "None"
        // SIGNAGE, NOT AN ESSAY (DESIGN.md, Copy; #1047): "None" is on the row,
        // so no note explains that priority is optional; the placeholder is a noun.
        fields.getValue("priority").note shouldBe ""
        data.title_placeholder shouldBe "Task name"
        fields.getValue("project").value_ shouldBe "Inbox"
        fields.getValue("tags").value_ shouldBe "—"

        // A one-off repeats "Never" (v0 drew "—"); a date-only reminder is "On the day".
        val oneOff = detailOn(task("b", "Bins", due = "2026-06-17", days = 2).copy(remind_before_min = 0))
        val f = oneOff.screen.data_!!.fields.associateBy { it.key }
        f.getValue("repeats").value_ shouldBe "Never"
        f.getValue("reminder").value_ shouldBe "On the day"
        f.keys.contains("anchor") shouldBe false
        f.getValue("repeats").raw shouldBe ""
        // Undated, a picker opens on the core's today.
        detailOn(task("d", "Someday")).screen.data_!!.fields.single { it.key == "when" }.day shouldBe TODAY
        // Undated: a reminder needs a due.
        detailOn(task("c", "Idea")).screen.data_!!.fields.single { it.key == "reminder" }.let {
            it.enabled shouldBe false
            it.note shouldBe "A reminder needs a due date."
        }
    }

    "title and notes AUTOSAVE: an edit schedules, the tick saves only what changed, leaving flushes" {
        val detail = detailOn(task("a", "Rent", due = "2026-06-19", days = 4).copy(description = "Standing order"))
        val typed = TasksDetailMachine.reduce(detail, TasksDetailInput.View(TasksDetailEvent(title = TasksDetailEvent.TitleChanged(title = "Rent, June"))))
        typed.effects shouldBe listOf(ScreenEffect.Schedule(TasksDetailMachine.SCREEN_ID, AutosaveLaw.tokenOf(1), AutosaveLaw.DEBOUNCE_MS))
        typed.state.screen.autosave!!.phase shouldBe Autosave.Phase.PHASE_DIRTY
        val saved = TasksDetailMachine.reduce(typed.state, TasksDetailInput.View(TasksDetailEvent(tick = TasksDetailEvent.Tick(token = AutosaveLaw.tokenOf(1)))))
        val write = saved.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "schedule.edit_task"
        write.inputJson shouldBe """{"task_id":"a","title":"Rent, June"}"""
        write.invokeKey shouldBe "schedule.edit_task:a:seq=1"

        // CLOSE = DONE: the notes typed and not yet ticked are saved on leave.
        val notes = TasksDetailMachine.reduce(detail, TasksDetailInput.View(TasksDetailEvent(notes = TasksDetailEvent.NotesChanged(notes = "")))).state
        val left = TasksDetailMachine.reduce(notes, TasksDetailMachine.left())
        (left.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"task_id":"a","clear_description":true}"""
        TasksDetailMachine.ticked("save:9") shouldBe TasksDetailInput.View(TasksDetailEvent(tick = TasksDetailEvent.Tick(token = "save:9")))

        // An emptied title is kept on screen and not sent.
        val blank = TasksDetailMachine.reduce(detail, TasksDetailInput.View(TasksDetailEvent(title = TasksDetailEvent.TitleChanged(title = " ")))).state
        val refused = TasksDetailMachine.reduce(blank, TasksDetailMachine.left())
        refused.effects.shouldBeEmpty()
        refused.state.screen.autosave!!.failure!!.sentence shouldBe "A task needs a name."
    }

    "a vault change never overwrites typing — the fields refresh around the words" {
        val detail = detailOn(task("a", "Rent", due = "2026-06-19", days = 4))
        val typed = TasksDetailMachine.reduce(detail, TasksDetailInput.View(TasksDetailEvent(title = TasksDetailEvent.TitleChanged(title = "Rent!")))).state
        TasksDetailMachine.reduce(typed, TasksDetailInput.View(TasksDetailEvent(rows_changed = TasksDetailEvent.RowsChanged(table = "schedule_task", ids = listOf("a"))))).let {
            it.effects.shouldBeEmpty()
            it.state.screen.autosave!!.remote_changed shouldBe true
        }
        val moved = TasksDetailMachine.reduce(typed, TasksDetailInput.Answered(TasksTaskDetail(today = TODAY, task = task("a", "Rent", due = "2026-06-19", days = 4).copy(priority = 2)), TasksProjects())).state
        moved.screen.data_!!.draft!!.title shouldBe "Rent!"
        moved.screen.data_.fields.single { it.key == "priority" }.value_ shouldBe "Next"
    }

    "every other field is one write when it is chosen — the day keeps its time; a choice made again is a new command" {
        val detail = detailOn(task("a", "Call", due = "2026-06-19", time = "09:00", days = 4))
        val tomorrow = TasksDetailMachine.reduce(detail, choice("when", "tomorrow"))
        val w = tomorrow.effects.single() as ScreenEffect.SubmitWrite
        w.command shouldBe "schedule.edit_task"
        w.inputJson shouldBe """{"task_id":"a","due_at":"2026-06-16T09:00"}"""
        tomorrow.state.screen.write!!.phase shouldBe centraid.screen.v1.WriteState.Phase.PHASE_IN_FLIGHT
        // This weekend from a Monday is Saturday; next week is the Monday after.
        TasksDetailMachine.dayFor("weekend", TODAY) shouldBe "2026-06-20"
        TasksDetailMachine.dayFor("next_week", TODAY) shouldBe "2026-06-22"
        TasksDetailMachine.dayFor("weekend", "2026-06-21") shouldBe "2026-06-21"

        (TasksDetailMachine.reduce(detail, choice("when", "none")).effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"task_id":"a","clear_due":true}"""
        (TasksDetailMachine.reduce(detail, choice("time", "none")).effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"task_id":"a","due_at":"2026-06-19"}"""
        (TasksDetailMachine.reduce(detail, TasksDetailInput.View(TasksDetailEvent(time_picked = TasksDetailEvent.TimePicked(time = "18:30")))).effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"task_id":"a","due_at":"2026-06-19T18:30"}"""
        (TasksDetailMachine.reduce(detail, choice("reminder", "30")).effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"task_id":"a","remind_before_min":30}"""
        (TasksDetailMachine.reduce(detail, choice("repeats", "weekly")).effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"task_id":"a","rrule":"FREQ=WEEKLY"}"""
        val now = TasksDetailMachine.reduce(detail, choice("priority", "3"))
        (now.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"task_id":"a","priority":3}"""
        (TasksDetailMachine.reduce(detail, choice("effort", "25")).effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"task_id":"a","effort_min":25}"""
        // "None" clears an effort; on a task with none it is nothing.
        (TasksDetailMachine.reduce(detailOn(task("e", "Walk", due = "2026-06-19", days = 4).copy(effort_min = 25)), choice("effort", "none")).effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"task_id":"e","clear_effort":true}"""
        TasksDetailMachine.reduce(detail, choice("effort", "none")).effects.shouldBeEmpty()
        // A PICK CLOSES THE FIELD it was made from.
        val open = TasksDetailMachine.reduce(detail, TasksDetailInput.View(TasksDetailEvent(field_opened = TasksDetailEvent.FieldOpened(field_ = "when")))).state
        open.screen.open_field shouldBe "when"
        val picked = TasksDetailMachine.reduce(open, TasksDetailInput.View(TasksDetailEvent(date_picked = TasksDetailEvent.DatePicked(day = "2026-06-24"))))
        picked.state.screen.open_field shouldBe ""
        (picked.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"task_id":"a","due_at":"2026-06-24T09:00"}"""
        (TasksDetailMachine.reduce(detail, TasksDetailInput.View(TasksDetailEvent(tag_added = TasksDetailEvent.TagAdded(label = "home")))).effects.single() as ScreenEffect.SubmitWrite).let {
            it.command shouldBe "core.tag_item"
            it.inputJson shouldBe """{"subject_type":"schedule.task","subject_id":"a","label":"home"}"""
        }
        // Already so: nothing.
        TasksDetailMachine.reduce(detail, choice("priority", "none")).effects.shouldBeEmpty()

        val settled = TasksDetailMachine.reduce(now.state, TasksDetailInput.View(TasksDetailEvent(write_settled = WriteLaw.settledOf(CommandStatus.COMMAND_STATUS_EXECUTED, "", (now.effects.single() as ScreenEffect.SubmitWrite).invokeKey)))).state
        val again = TasksDetailMachine.reduce(settled, choice("priority", "3"))
        (again.effects.single() as ScreenEffect.SubmitWrite).invokeKey shouldNotBe (now.effects.single() as ScreenEffect.SubmitWrite).invokeKey

        // A REFUSED FIELD WRITE: the core's sentence on the status line.
        val refused = TasksDetailMachine.reduce(now.state, TasksDetailInput.View(TasksDetailEvent(write_settled = WriteLaw.settledOf(CommandStatus.COMMAND_STATUS_FAILED, "A repeating task needs a due date to repeat from.", (now.effects.single() as ScreenEffect.SubmitWrite).invokeKey)))).state
        refused.screen.status!!.sentence shouldBe "A repeating task needs a due date to repeat from."
    }

    "priority runs higher more urgent: Soon, Next and Now are 1, 2 and 3, anything above is Now, zero is none (Q-1047-10)" {
        // THE SCALE IS TODOIST'S, as the vault stores it and `tasks.proto` says
        // (D-1020-S5) — not RFC 5545's 1-is-highest. A level that rose with its
        // number is what makes "Now" the top chip and its write `3`.
        listOf(0L, -1L).forEach { TasksRows.priorityLabel(it) shouldBe "" }
        TasksRows.priorityLabel(1) shouldBe "Soon"
        TasksRows.priorityLabel(2) shouldBe "Next"
        TasksRows.priorityLabel(3) shouldBe "Now"
        listOf(4L, 5L, 9L).forEach { TasksRows.priorityLabel(it) shouldBe "Now" }
        val fields = detailOn(task("a", "Rent", due = "2026-06-19", days = 4)).screen.data_!!.fields.associateBy { it.key }
        fields.getValue("priority").choices.map { it.key to it.label } shouldBe
            listOf("none" to "None", "1" to "Soon", "2" to "Next", "3" to "Now")
    }

    "subtasks: a done count, add as a write, one level only" {
        val parent = task("a", "Move house").copy(children = listOf(task("c1", "Boxes").copy(parent_task_id = "a"), task("c2", "Van").copy(parent_task_id = "a", status = "completed")), done_children = 1)
        val detail = detailOn(parent)
        detail.screen.data_!!.let {
            it.subtasks_label shouldBe "Subtasks · 1 of 2"
            it.subtasks.size shouldBe 2
            it.can_add_subtask shouldBe true
        }
        (TasksDetailMachine.reduce(detail, TasksDetailInput.View(TasksDetailEvent(subtask_added = TasksDetailEvent.SubtaskAdded(title = "Keys")))).effects.single() as ScreenEffect.SubmitWrite).let {
            it.command shouldBe "schedule.add_task"
            it.inputJson shouldBe """{"title":"Keys","parent_task_id":"a"}"""
        }
        val child = detailOn(task("c1", "Boxes").copy(parent_task_id = "a"))
        child.screen.data_!!.let {
            it.can_add_subtask shouldBe false
            it.subtask_note shouldBe "Subtasks can't have subtasks."
            it.parent_task_id shouldBe "a"
        }
    }

    "delete asks in full sentences, then trashes and ends the screen; release destroys nothing" {
        val detail = detailOn(task("a", "Rent"))
        val asked = TasksDetailMachine.reduce(detail, TasksDetailInput.View(TasksDetailEvent(delete = TasksDetailEvent.DeleteRequested()))).state
        asked.screen.confirm!!.let {
            it.title shouldBe "Delete this task?"
            it.destructive shouldBe true
        }
        asked.screen.asking shouldBe TasksDetailState.Asking.ASKING_DELETE
        val confirmed = TasksDetailMachine.reduce(asked, TasksDetailInput.View(TasksDetailEvent(confirmed = TasksDetailEvent.Confirmed())))
        val write = confirmed.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "schedule.delete_task"
        write.inputJson shouldBe """{"task_id":"a"}"""
        val done = TasksDetailMachine.reduce(confirmed.state, TasksDetailInput.View(TasksDetailEvent(write_settled = WriteLaw.settledOf(CommandStatus.COMMAND_STATUS_EXECUTED, "", write.invokeKey)))).state
        done.screen.finished shouldBe true

        val release = TasksDetailMachine.reduce(detail, TasksDetailInput.View(TasksDetailEvent(release = TasksDetailEvent.ReleaseRequested()))).state
        release.screen.confirm!!.destructive shouldBe false
        (TasksDetailMachine.reduce(release, TasksDetailInput.View(TasksDetailEvent(confirmed = TasksDetailEvent.Confirmed()))).effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe
            """{"task_id":"a","status":"cancelled"}"""
    }

    "a task no live row has is drawn as gone, not as a failed read" {
        val gone = TasksDetailMachine.reduce(openDetail().state, TasksDetailInput.Answered(TasksTaskDetail(today = TODAY), TasksProjects())).state
        gone.screen.gone!!.headline shouldBe "This task is gone."
        gone.screen.failure.shouldBeNull()
    }

    // -----------------------------------------------------------------
    // tasks.catch_up
    // -----------------------------------------------------------------

    "catch up: three piles, the repeating one only what is behind, Complete all behind a confirm" {
        TasksCatchUpReads.requests(TasksCatchUpMachine.initial(), clock).let {
            it[0].tasks_catch_up.shouldNotBeNull()
            it[1].tasks_projects.shouldNotBeNull()
        }
        val opened = TasksCatchUpMachine.reduce(TasksCatchUpMachine.initial(), TasksCatchUpInput.View(TasksCatchUpEvent(opened = TasksCatchUpEvent.Opened())))
        val behind = task("r1", "Water", due = "2026-06-12", days = -3, overdue = true).copy(repeats = true, missed = 3)
        val onTime = task("r2", "Rent", due = "2026-06-19", days = 4).copy(repeats = true)
        val page = TasksCatchUpMachine.reduce(
            opened.state,
            TasksCatchUpInput.Answered(
                TasksCatchUp(
                    today = TODAY,
                    dated = listOf(task("d1", "Invoice", due = "2026-06-01", days = -14, overdue = true), task("d2", "Call", due = "2026-06-10", days = -5, overdue = true)),
                    repeating = listOf(behind, onTime),
                    sitting = emptyList(),
                    away_days = 14,
                    overdue = 3,
                    absent = true,
                ),
                TasksProjects(),
            ),
        ).state
        val data = page.screen.data_.shouldNotBeNull()
        data.head shouldBe "14 days away · 3 tasks came due"
        data.piles.map { it.key } shouldBe listOf("dated", "repeating")
        data.piles[1].rows.map { it.task_id } shouldBe listOf("r1")
        data.piles[0].verb_label shouldBe "Complete all"

        val asked = TasksCatchUpMachine.reduce(page, TasksCatchUpInput.View(TasksCatchUpEvent(complete_all = TasksCatchUpEvent.CompleteAllTapped(pile = "dated")))).state
        asked.screen.confirm!!.confirm_label shouldBe "Complete all"
        asked.screen.asking_pile shouldBe "dated"
        val all = TasksCatchUpMachine.reduce(asked, TasksCatchUpInput.View(TasksCatchUpEvent(confirmed = TasksCatchUpEvent.Confirmed())))
        all.effects.map { (it as ScreenEffect.SubmitWrite).inputJson } shouldBe listOf(
            """{"task_id":"d1","status":"completed"}""",
            """{"task_id":"d2","status":"completed"}""",
        )
        all.effects.map { (it as ScreenEffect.SubmitWrite).invokeKey }.toSet().size shouldBe 2
        all.state.screen.status!!.let {
            it.sentence shouldBe "2 tasks done"
            it.action_label shouldBe ""
        }
        all.state.screen.data_!!.piles.map { it.key } shouldBe listOf("repeating")

        val clear = TasksCatchUpMachine.reduce(opened.state, TasksCatchUpInput.Answered(TasksCatchUp(today = TODAY), TasksProjects())).state
        clear.screen.data_!!.empty!!.headline shouldBe "Nothing is overdue."
        clear.screen.data_.head shouldBe ""
    }

    // -----------------------------------------------------------------
    // tasks.trash
    // -----------------------------------------------------------------

    "the trash is the kit's: restore, and delete forever behind a confirm; nothing empties it" {
        val machine = TasksTrashMachine.machine
        machine.screenId shouldBe "tasks.trash"
        TasksTrashMachine.reads.table shouldBe "schedule_task"
        val opened = machine.reduce(machine.initial(), TrashListEvent(opened = TrashListEvent.Opened())).state
        val listed = machine.reduce(opened, TrashListEvent(data_ = TrashListEvent.DataArrived(data_ = TrashListData(rows = listOf(TrashRow(id = "a", title = "Rent"))), answered_cursor = ""))).state
        listed.data_!!.rows.single().purge_label shouldBe SharedCopy.TRASH_PURGE
        listed.data_.empty_label shouldBe ""
        listed.back_label shouldBe TasksCopy.APP_TITLE
        val asked = machine.reduce(listed, TrashListEvent(purge = TrashListEvent.PurgeTapped(id = "a"))).state
        asked.confirm.shouldNotBeNull().body shouldBe TasksCopy.TRASH_PURGE_BODY
        (machine.reduce(asked, TrashListEvent(confirmed = TrashListEvent.Confirmed())).effects.single() as ScreenEffect.SubmitWrite).let {
            it.command shouldBe "schedule.purge_task"
            it.inputJson shouldBe """{"task_id":"a"}"""
        }
        machine.reduce(listed, TrashListEvent(empty = TrashListEvent.EmptyTapped())).state.confirm.shouldBeNull()
        (machine.reduce(listed, TrashListEvent(restore = TrashListEvent.RestoreTapped(id = "a"))).effects.single() as ScreenEffect.SubmitWrite).let {
            it.command shouldBe "schedule.restore_task"
            it.inputJson shouldBe """{"task_id":"a"}"""
        }
    }
}) {
    companion object {
        const val TODAY: String = "2026-06-15"
        const val ID: String = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"

        fun openList(view: TasksListState.View): Step<TasksList> =
            TasksListMachine.reduce(TasksListMachine.initial(), TasksListInput.View(TasksListEvent(opened = TasksListEvent.Opened(view = view))))

        fun listOn(view: TasksListState.View, board: TasksBoard): TasksList =
            TasksListMachine.reduce(openList(view).state, TasksListInput.Answered(board)).state

        fun openProject(): Step<TasksProjectPage> = TasksProjectMachine.reduce(
            TasksProjectMachine.initial(),
            TasksProjectInput.View(TasksProjectEvent(opened = TasksProjectEvent.Opened(project_id = "p1", title = "Garden"))),
        )

        fun projectOn(board: TasksBoard): TasksProjectPage =
            TasksProjectMachine.reduce(openProject().state, TasksProjectInput.Answered(board)).state

        fun openDetail(): Step<TasksDetail> = TasksDetailMachine.reduce(
            TasksDetailMachine.initial(),
            TasksDetailInput.View(TasksDetailEvent(opened = TasksDetailEvent.Opened(task_id = "a"))),
        )

        fun detailOn(task: TasksTask): TasksDetail {
            val opened = TasksDetailMachine.reduce(
                TasksDetailMachine.initial(),
                TasksDetailInput.View(TasksDetailEvent(opened = TasksDetailEvent.Opened(task_id = task.task_id))),
            )
            return TasksDetailMachine.reduce(opened.state, TasksDetailInput.Answered(TasksTaskDetail(today = TODAY, task = task), TasksProjects())).state
        }

        fun choice(field: String, key: String): TasksDetailInput =
            TasksDetailInput.View(TasksDetailEvent(field_choice = TasksDetailEvent.FieldChoice(field_ = field, key = key)))

        fun task(
            id: String,
            title: String,
            due: String = "",
            time: String = "",
            days: Int? = null,
            overdue: Boolean = false,
            landsToday: Boolean = false,
            project: String? = null,
        ): TasksTask = TasksTask(
            task_id = id,
            title = title,
            status = "needs-action",
            due_day = due,
            due_time = time,
            due_local = if (time.isEmpty()) due else "${due}T$time",
            days_from_today = days,
            overdue = overdue,
            lands_today = landsToday || overdue,
            project_id = project,
        )

        fun board(view: TasksView, vararg groups: TasksGroup): TasksBoard = TasksBoard(
            today = TODAY,
            now_local = "${TODAY}T09:42",
            view = view,
            groups = groups.toList(),
            counts = TasksCounts(open_ = groups.sumOf { it.tasks.size }),
            window = 100,
        )

        fun overdueGroup(vararg tasks: TasksTask): TasksGroup =
            TasksGroup(kind = TasksGroupKind.TASKS_GROUP_KIND_OVERDUE, key = "overdue", tasks = tasks.toList())

        fun todayGroup(vararg tasks: TasksTask): TasksGroup =
            TasksGroup(kind = TasksGroupKind.TASKS_GROUP_KIND_TODAY, key = "today", tasks = tasks.toList())

        fun dayGroup(day: String, vararg tasks: TasksTask): TasksGroup =
            TasksGroup(kind = TasksGroupKind.TASKS_GROUP_KIND_DAY, key = "day|$day", day = day, tasks = tasks.toList())
    }
}
