package dev.centraid.shared.apps.tasks

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.TasksProjects
import centraid.core.v1.TasksProjectsRequest
import centraid.core.v1.TasksTask
import centraid.core.v1.TasksTaskDetail
import centraid.core.v1.TasksTaskRequest
import centraid.screen.v1.Autosave
import centraid.screen.v1.Confirm
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import centraid.screen.v1.StatusLine
import centraid.screen.v1.TasksCheck
import centraid.screen.v1.TasksChoice
import centraid.screen.v1.TasksDetailData
import centraid.screen.v1.TasksDetailEvent
import centraid.screen.v1.TasksDetailState
import centraid.screen.v1.TasksDraft
import centraid.screen.v1.TasksField
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.kit.AutosaveLaw
import dev.centraid.shared.kit.AutosaveLens
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.kit.dataOf
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.kit.time.isoWeekdayOf
import dev.centraid.shared.kit.time.plusDays
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/** What `tasks.detail` holds: the state, the raw answers, and its writes. */
public data class TasksDetail(
    val screen: TasksDetailState,
    val answer: TasksTaskDetail? = null,
    val projects: TasksProjects? = null,
    /** The box, and a subtask's box: the list laws' check-off and Undo. */
    val ops: TaskOps = TaskOps(),
    /** A counter for field writes, so a choice made again is a new command. */
    val seq: Long = 0,
    /** The one field write out, and what it was (`delete` ends the screen). */
    val verb: String = "",
)

public sealed interface TasksDetailInput {
    public data class View(val event: TasksDetailEvent) : TasksDetailInput

    public data class Answered(val detail: TasksTaskDetail?, val projects: TasksProjects?) : TasksDetailInput

    public data class Denied(val denial: AppQueryDenial) : TasksDetailInput
}

/**
 * THE TASK DETAIL — an editor (#1015 D3: autosave everywhere, close = done).
 *
 * The title and the notes are typed, so they autosave ([AutosaveLaw]: 900 ms,
 * one key per edit, only what changed, a vault change never overwrites
 * typing). Every other field is a decision, so it is one write when it is
 * made ([WriteLaw]): When, Time, Reminder, Repeats, Anchor, Priority, Effort,
 * Project, Tags, a subtask added, Release, Delete. There is no Save.
 *
 * Repeats is the core's sentence ("Every 2 weeks on Monday"), "Never" for a
 * one-off — never v0's "—". The stored rule (`TasksTask.rrule`) rides as the
 * field's `raw` and pre-selects the preset it is, and is never drawn (#834).
 * A date-only reminder names no moment: "On the day". A date or time picked
 * from the platform's picker closes the field, as a chip does.
 */
public object TasksDetailMachine : ScreenMachine<TasksDetail, TasksDetailInput> {
    public const val SCREEN_ID: String = "tasks.detail"

    public val TABLES: Set<String> = TasksHomeMachine.TABLES

    public const val EDIT: String = "schedule.edit_task"
    public const val DELETE: String = "schedule.delete_task"
    public const val TAG: String = "core.tag_item"
    public const val UNTAG: String = "core.untag_item"

    /** `TasksField.key`s. */
    public const val WHEN: String = "when"
    public const val TIME: String = "time"
    public const val REMINDER: String = "reminder"
    public const val REPEATS: String = "repeats"
    public const val ANCHOR: String = "anchor"
    public const val PRIORITY: String = "priority"
    public const val EFFORT: String = "effort"
    public const val PROJECT: String = "project"
    public const val TAGS: String = "tags"

    /** Choice keys. */
    public const val NONE: String = "none"
    public const val TODAY: String = "today"
    public const val TOMORROW: String = "tomorrow"
    public const val WEEKEND: String = "weekend"
    public const val NEXT_WEEK: String = "next_week"

    private val REMINDER_LEADS: List<Pair<Long, String>> = listOf(
        0L to TasksCopy.REMIND_AT_TIME,
        10L to "10 ${TasksCopy.MINUTES_BEFORE}",
        30L to "30 ${TasksCopy.MINUTES_BEFORE}",
        60L to TasksCopy.REMIND_HOUR,
        1440L to TasksCopy.REMIND_DAY,
    )

    private val REPEAT_RULES: List<Triple<String, String, String>> = listOf(
        Triple("daily", TasksCopy.REPEATS_DAILY, "FREQ=DAILY"),
        Triple("weekly", TasksCopy.REPEATS_WEEKLY, "FREQ=WEEKLY"),
        Triple("monthly", TasksCopy.REPEATS_MONTHLY, "FREQ=MONTHLY"),
        Triple("yearly", TasksCopy.REPEATS_YEARLY, "FREQ=YEARLY"),
    )

    private val EFFORTS: List<Long> = listOf(5, 15, 25, 60)

    private val ASK_NONE = TasksDetailState.Asking.ASKING_NONE

    override fun initial(): TasksDetail = decorate(
        TasksDetail(
            screen = TasksDetailState(
                loading = Loading(first_load = true),
                autosave = Autosave(phase = Autosave.Phase.PHASE_CLEAN),
                write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
                asking = ASK_NONE,
            ),
        ),
    )

    override fun reduce(state: TasksDetail, event: TasksDetailInput): Step<TasksDetail> {
        val step = when (event) {
            is TasksDetailInput.View -> view(state, event.event)
            is TasksDetailInput.Answered -> answered(state, event)
            is TasksDetailInput.Denied -> Step(
                Lens.with(state, ReadContent.Denied(TasksHomeMachine.deniedOf(event.denial))),
            )
        }
        return Step(decorate(step.state), step.effects)
    }

    override fun rowsChanged(table: String, keys: List<String>): TasksDetailInput? =
        if (table in TABLES) {
            TasksDetailInput.View(TasksDetailEvent(rows_changed = TasksDetailEvent.RowsChanged(table = table, ids = keys)))
        } else {
            null
        }

    override fun seatChanged(seat: SeatState): TasksDetailInput =
        TasksDetailInput.View(TasksDetailEvent(seat_changed = TasksDetailEvent.SeatChanged(seat = seat)))

    override fun ticked(token: String): TasksDetailInput =
        TasksDetailInput.View(TasksDetailEvent(tick = TasksDetailEvent.Tick(token = token)))

    override fun left(): TasksDetailInput = TasksDetailInput.View(TasksDetailEvent(left = TasksDetailEvent.Left()))

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    private fun view(state: TasksDetail, event: TasksDetailEvent): Step<TasksDetail> {
        val screen = state.screen
        return when {
            event.opened != null -> {
                val id = event.opened.task_id
                if (id.isEmpty()) return Step(state)
                val fresh = state.copy(
                    screen = screen.copy(
                        task_id = id,
                        finished = false,
                        confirm = null,
                        asking = ASK_NONE,
                        open_field = "",
                        write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
                        gone = null,
                    ),
                    answer = null,
                    ops = TaskOps(seq = state.ops.seq),
                    verb = "",
                )
                AutosaveLaw.opened(Lens, fresh)
            }

            event.refreshed != null -> Step(state, listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)))

            event.title != null -> AutosaveLaw.edited(Lens, state) { d ->
                d.copy(draft = (d.draft ?: TasksDraft()).copy(title = event.title.title))
            }

            event.notes != null -> AutosaveLaw.edited(Lens, state) { d ->
                d.copy(draft = (d.draft ?: TasksDraft()).copy(notes = event.notes.notes))
            }

            event.tick != null -> AutosaveLaw.tick(Lens, state, event.tick.token)

            // CLOSE = DONE: whatever is typed is saved.
            event.left != null -> AutosaveLaw.flush(Lens, state)

            event.field_choice != null -> choice(state, event.field_choice.field_, event.field_choice.key)

            // A PICK IS A CHOICE: the field closes, as a chip closes it.
            event.date_picked != null -> {
                val task = task(state) ?: return Step(state)
                val closed = state.copy(screen = screen.copy(open_field = ""))
                val day = event.date_picked.day
                when {
                    isoWeekdayOf(day) == null -> Step(closed)
                    day == task.due_day -> Step(closed)
                    else -> edit(closed, WHEN, "{${id(task)},\"due_at\":${jsonString(withTime(task, day))}}", day)
                }
            }

            event.time_picked != null -> {
                val task = task(state) ?: return Step(state)
                val closed = state.copy(screen = screen.copy(open_field = ""))
                val time = event.time_picked.time
                if (!isClock(time) || time == task.due_time) {
                    Step(closed)
                } else {
                    val day = task.due_day.ifEmpty { todayOf(state) }
                    if (day.isEmpty()) Step(closed) else edit(closed, TIME, "{${id(task)},\"due_at\":${jsonString("${day}T$time")}}", time)
                }
            }

            event.field_opened != null -> Step(state.copy(screen = screen.copy(open_field = event.field_opened.field_)))
            event.field_closed != null -> Step(state.copy(screen = screen.copy(open_field = "")))

            event.tag_added != null -> {
                val task = task(state) ?: return Step(state)
                val label = event.tag_added.label.trim()
                if (label.isEmpty()) {
                    Step(state)
                } else {
                    val input = "{\"subject_type\":\"schedule.task\",\"subject_id\":${jsonString(task.task_id)},\"label\":${jsonString(label)}}"
                    submit(state, TAG, input, InvokeKeys.of(TAG, task.task_id, label, "n=${state.seq + 1}"), TAGS)
                }
            }

            event.check != null -> {
                val task = task(state) ?: return Step(state)
                val out = TaskOpsLaw.checked(state.ops, task)
                // The detail is not a list: its own row is not hidden.
                Step(state.copy(ops = out.ops.copy(hidden = out.ops.hidden - task.task_id)), out.effects)
            }

            event.subtask_checked != null -> {
                val child = task(state)?.children?.firstOrNull { it.task_id == event.subtask_checked.task_id } ?: return Step(state)
                val out = TaskOpsLaw.checked(state.ops, child)
                Step(refold(state.copy(ops = out.ops)), out.effects)
            }

            event.status_acted != null -> {
                val out = TaskOpsLaw.undo(state.ops)
                Step(refold(state.copy(ops = out.ops)), out.effects)
            }

            event.subtask_added != null -> {
                val task = task(state) ?: return Step(state)
                val title = event.subtask_added.title.trim()
                if (title.isEmpty() || task.parent_task_id != null) {
                    Step(state)
                } else {
                    val input = "{\"title\":${jsonString(title)},\"parent_task_id\":${jsonString(task.task_id)}}"
                    submit(state, TaskOpsLaw.ADD, input, InvokeKeys.of(TaskOpsLaw.ADD, task.task_id, "sub=$title", "n=${state.seq + 1}"), "subtask")
                }
            }

            event.delete != null -> Step(
                state.copy(
                    screen = screen.copy(
                        confirm = Confirm(
                            title = TasksCopy.DELETE_TITLE,
                            body = TasksCopy.DELETE_BODY,
                            confirm_label = TasksCopy.DELETE,
                            destructive = true,
                        ),
                        asking = TasksDetailState.Asking.ASKING_DELETE,
                    ),
                ),
            )

            // RELEASING DESTROYS NOTHING: the outlined secondary, not `net`.
            event.release != null -> Step(
                state.copy(
                    screen = screen.copy(
                        confirm = Confirm(
                            title = TasksCopy.RELEASE_TITLE,
                            body = TasksCopy.RELEASE_BODY,
                            confirm_label = TasksCopy.RELEASE,
                            destructive = false,
                        ),
                        asking = TasksDetailState.Asking.ASKING_RELEASE,
                    ),
                ),
            )

            event.confirmed != null -> confirmed(state)

            event.dismissed != null -> Step(state.copy(screen = screen.copy(confirm = null, asking = ASK_NONE)))

            event.write_settled != null -> settled(state, event.write_settled)

            event.refused != null -> Step(Lens.with(state, ReadContent.Failed(event.refused.failure ?: Reads.refused(TasksCopy.READ_INCOMPLETE))))

            // A VAULT CHANGE never overwrites typing (the kit's autosave
            // law); any Tasks table is this task's business — a subtask, a
            // tag, a project renamed — so the keys are not matched.
            event.rows_changed != null -> AutosaveLaw.rowsChanged(Lens, state, emptyList())

            event.seat_changed != null -> Step(state.copy(screen = screen.copy(seat = event.seat_changed.seat)))

            // INTENTS: the shell routes them.
            else -> Step(state)
        }
    }

    /** A chip, a card, a sheet row: one write, or nothing when it is already so. */
    private fun choice(state: TasksDetail, field: String, key: String): Step<TasksDetail> {
        val task = task(state) ?: return Step(state)
        val today = todayOf(state)
        val id = id(task)
        val closed = state.copy(screen = state.screen.copy(open_field = ""))
        return when (field) {
            WHEN -> {
                if (key == NONE) {
                    if (task.due_day.isEmpty()) Step(closed) else edit(closed, WHEN, "{$id,\"clear_due\":true}", key)
                } else {
                    val day = dayFor(key, today) ?: return Step(closed)
                    edit(closed, WHEN, "{$id,\"due_at\":${jsonString(withTime(task, day))}}", day)
                }
            }
            TIME -> if (key == NONE && task.due_time.isNotEmpty()) {
                edit(closed, TIME, "{$id,\"due_at\":${jsonString(task.due_day)}}", key)
            } else {
                Step(closed)
            }
            REMINDER -> when {
                task.due_day.isEmpty() -> Step(closed)
                key == NONE -> if (task.remind_before_min == null) Step(closed) else edit(closed, REMINDER, "{$id,\"clear_remind\":true}", key)
                else -> {
                    val lead = key.toLongOrNull()?.takeIf { l -> REMINDER_LEADS.any { it.first == l } } ?: return Step(closed)
                    edit(closed, REMINDER, "{$id,\"remind_before_min\":$lead}", key)
                }
            }
            REPEATS -> when {
                key == NONE -> if (!task.repeats) Step(closed) else edit(closed, REPEATS, "{$id,\"clear_rrule\":true}", key)
                task.due_day.isEmpty() -> Step(closed)
                else -> {
                    val rule = REPEAT_RULES.firstOrNull { it.first == key }?.third ?: return Step(closed)
                    if (rule == task.rrule) Step(closed) else edit(closed, REPEATS, "{$id,\"rrule\":${jsonString(rule)}}", key)
                }
            }
            ANCHOR -> if ((key == "scheduled" || key == "completion") && task.repeats) {
                val input = "{$id,\"sort_order\":${task.sort_order},\"recurrence_anchor\":${jsonString(key)}}"
                submit(closed, TaskOpsLaw.ORGANIZE, input, key(TaskOpsLaw.ORGANIZE, task, ANCHOR, key, closed), ANCHOR)
            } else {
                Step(closed)
            }
            PRIORITY -> {
                val level = when (key) {
                    NONE -> 0L
                    else -> key.toLongOrNull()?.takeIf { it in 1L..3L } ?: return Step(closed)
                }
                if (level == task.priority) Step(closed) else edit(closed, PRIORITY, "{$id,\"priority\":$level}", key)
            }
            // "None" is `edit_task`'s `clear_effort`.
            EFFORT -> if (key == NONE) {
                if (task.effort_min == null) Step(closed) else edit(closed, EFFORT, "{$id,\"clear_effort\":true}", key)
            } else {
                val minutes = key.toLongOrNull()?.takeIf { it in EFFORTS } ?: return Step(closed)
                if (minutes == task.effort_min) Step(closed) else edit(closed, EFFORT, "{$id,\"effort_min\":$minutes}", key)
            }
            PROJECT -> {
                if (task.parent_task_id != null) return Step(closed)
                val (projects, sections) = projectsOf(state)
                val (projectId, sectionId) = when {
                    key == TasksHomeMachine.FILE_INBOX -> null to null
                    key.startsWith(TasksHomeMachine.FILE_PROJECT) ->
                        key.removePrefix(TasksHomeMachine.FILE_PROJECT).takeIf { p -> projects.any { it.project_id == p } } to null
                    key.startsWith(TasksHomeMachine.FILE_SECTION) -> {
                        val section = sections.firstOrNull { it.section_id == key.removePrefix(TasksHomeMachine.FILE_SECTION) }
                            ?: return Step(closed)
                        section.project_id to section.section_id
                    }
                    else -> return Step(closed)
                }
                if (key != TasksHomeMachine.FILE_INBOX && projectId == null) return Step(closed)
                val input = TaskOpsLaw.organizeInput(task.task_id, projectId, sectionId, task.sort_order)
                submit(closed, TaskOpsLaw.ORGANIZE, input, key(TaskOpsLaw.ORGANIZE, task, PROJECT, key, closed), PROJECT)
            }
            // A TAG CHIP IS ITS OWN REMOVAL: tapping it untags.
            TAGS -> {
                val tag = task.tags.firstOrNull { it.tag_id == key } ?: return Step(closed)
                submit(closed, UNTAG, "{\"tag_id\":${jsonString(tag.tag_id)}}", InvokeKeys.of(UNTAG, tag.tag_id), TAGS)
            }
            else -> Step(closed)
        }
    }

    private fun confirmed(state: TasksDetail): Step<TasksDetail> {
        val task = task(state)
        val cleared = state.copy(screen = state.screen.copy(confirm = null, asking = ASK_NONE))
        if (task == null) return Step(cleared)
        return when (state.screen.asking) {
            TasksDetailState.Asking.ASKING_DELETE -> submit(
                cleared,
                DELETE,
                "{${id(task)}}",
                InvokeKeys.of(DELETE, task.task_id),
                VERB_DELETE,
            )
            TasksDetailState.Asking.ASKING_RELEASE -> submit(
                cleared,
                TaskOpsLaw.STATUS,
                "{${id(task)},\"status\":\"${TasksRows.STATUS_CANCELLED}\"}",
                key(TaskOpsLaw.STATUS, task, "release", TasksRows.STATUS_CANCELLED, cleared),
                VERB_RELEASE,
            )
            else -> Step(cleared)
        }
    }

    private fun edit(state: TasksDetail, field: String, input: String, value: String): Step<TasksDetail> {
        val task = task(state) ?: return Step(state)
        return submit(state, EDIT, input, key(EDIT, task, field, value, state), field)
    }

    private fun key(command: String, task: TasksTask, field: String, value: String, state: TasksDetail): String =
        InvokeKeys.of(command, task.task_id, "$field=$value", "n=${state.seq + 1}")

    private fun submit(state: TasksDetail, command: String, input: String, key: String, verb: String): Step<TasksDetail> {
        val step = WriteLaw.submit(Writes, state.copy(seq = state.seq + 1, verb = verb), command, input, key)
        return Step(step.state.copy(ops = step.state.ops.copy(status = null)), step.effects)
    }

    /** A save's, a field write's or a box's answer: each law takes only its own key. */
    private fun settled(state: TasksDetail, settled: WriteSettled): Step<TasksDetail> {
        val saved = AutosaveLaw.settled(Lens, state, settled)
        val mine = settled.invoke_key == state.screen.write?.invoke_key
        val written = WriteLaw.settled(Writes, saved.state, settled)
        val boxed = TaskOpsLaw.settled(written.state.ops, settled)
        var next = written.state.copy(ops = boxed.ops)
        if (mine) {
            next = when {
                !settled.committed -> next.copy(
                    ops = next.ops.copy(
                        status = StatusLine(
                            sentence = settled.failure?.sentence?.takeIf { it.isNotBlank() } ?: TasksCopy.WRITE_REFUSED,
                            refused = true,
                        ),
                    ),
                )
                state.verb == VERB_DELETE -> next.copy(
                    screen = next.screen.copy(finished = true),
                    ops = next.ops.copy(status = StatusLine(sentence = TasksCopy.TASK_DELETED)),
                )
                state.verb == VERB_RELEASE -> next.copy(ops = next.ops.copy(status = StatusLine(sentence = TasksCopy.TASK_RELEASED)))
                else -> next
            }
        }
        return Step(refold(next), saved.effects + written.effects + boxed.effects)
    }

    // ---------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------

    private fun answered(state: TasksDetail, answer: TasksDetailInput.Answered): Step<TasksDetail> {
        val detail = answer.detail ?: return Step(Lens.with(state, ReadContent.Failed(Reads.refused(TasksCopy.READ_INCOMPLETE))))
        val held = state.copy(answer = detail, projects = answer.projects ?: state.projects)
        val task = detail.task
        if (task == null) {
            // GONE is drawn, not failed: never made, deleted, or in the trash.
            return Step(
                held.copy(
                    screen = held.screen.copy(
                        loading = null,
                        failure = null,
                        denied = null,
                        data_ = null,
                        gone = EmptyState(headline = TasksCopy.TASK_GONE),
                    ),
                ),
            )
        }
        val open = task.children.filter(TasksRows::isOpen) + listOf(task).filter(TasksRows::isOpen)
        val settled = held.copy(ops = TaskOpsLaw.answered(held.ops, open, detail.today))
        val fresh = fold(settled, TasksDraft(title = task.title, notes = task.description ?: "")) ?: return Step(settled)
        val loaded = AutosaveLaw.loaded(Lens, settled, fresh, task.updated_at ?: "")
        // Over unsaved words the law replaces nothing; the FIELDS are still
        // the vault's, so they are refreshed around the words being typed.
        val current = Lens.dataOf(loaded.state)
        val next = if (current != null && current !== fresh) {
            Lens.with(loaded.state, ReadContent.Data(fresh.copy(draft = current.draft)))
        } else {
            loaded.state
        }
        return Step(next, loaded.effects)
    }

    private fun refold(state: TasksDetail): TasksDetail {
        val current = Lens.dataOf(state) ?: return state
        val fresh = fold(state, current.draft ?: TasksDraft()) ?: return state
        return Lens.with(state, ReadContent.Data(fresh))
    }

    /** Everything the detail draws, around [draft]. */
    public fun fold(state: TasksDetail, draft: TasksDraft): TasksDetailData? {
        val detail = state.answer ?: return null
        val task = detail.task ?: return null
        val today = detail.today
        val (projects, sections) = projectsOf(state)
        val ctx = TasksRows.Context(
            today = today,
            projects = projects.associateBy { it.project_id },
            sections = sections.associateBy { it.section_id },
            showProject = false,
            pending = state.ops.pendingIds,
            hidden = state.ops.hiddenIds,
        )
        val check = TasksRows.checkOf(task.status)
        val open = TasksRows.isOpen(task)
        val title = task.title.ifBlank { TasksCopy.UNTITLED }
        val subtask = task.parent_task_id != null
        val children = task.children.filter { it.task_id !in ctx.hidden }.map { TasksRows.row(it, ctx, subtask = true) }
        return TasksDetailData(
            draft = draft,
            check = check,
            check_label = TasksRows.checkLabel(title, open),
            status_label = when (check) {
                TasksCheck.TASKS_CHECK_DONE -> TasksCopy.DONE
                TasksCheck.TASKS_CHECK_WONT_DO -> TasksCopy.WONT_DO
                TasksCheck.TASKS_CHECK_IN_PROCESS -> TasksCopy.STARTED
                else -> ""
            },
            fields = fields(task, today, projects, sections),
            subtasks_label = if (task.children.isEmpty()) {
                TasksCopy.FIELD_SUBTASKS
            } else {
                "${TasksCopy.FIELD_SUBTASKS} · ${task.done_children} ${TasksCopy.OF} ${task.children.size}"
            },
            subtasks = children,
            can_add_subtask = !subtask && open,
            subtask_note = if (subtask) TasksCopy.SUBTASK_CAP else "",
            parent_task_id = detail.parent?.task_id ?: task.parent_task_id ?: "",
            parent_title = detail.parent?.title ?: "",
            title_placeholder = TasksCopy.TITLE_PLACEHOLDER,
            notes_placeholder = TasksCopy.NOTES_PLACEHOLDER,
            add_subtask_placeholder = TasksCopy.SUBTASK_PLACEHOLDER,
            delete_label = TasksCopy.DELETE,
            release_label = TasksCopy.RELEASE,
            can_release = open,
            today = today,
        )
    }

    private fun fields(
        task: TasksTask,
        today: String,
        projects: List<centraid.core.v1.TasksProject>,
        sections: List<centraid.core.v1.TasksSection>,
    ): List<TasksField> {
        val dated = task.due_day.isNotEmpty()
        fun chip(key: String, label: String, selected: Boolean, enabled: Boolean = true, meta: String = "") =
            TasksChoice(key = key, label = label, meta = meta, selected = selected, enabled = enabled)

        val whenChoices = listOf(
            TODAY to TasksCopy.WHEN_TODAY,
            TOMORROW to TasksCopy.WHEN_TOMORROW,
            WEEKEND to TasksCopy.WHEN_WEEKEND,
            NEXT_WEEK to TasksCopy.WHEN_NEXT_WEEK,
        ).map { (key, label) ->
            val day = dayFor(key, today)
            chip(key, label, selected = day != null && day == task.due_day, enabled = day != null)
        } + chip(NONE, TasksCopy.WHEN_NONE, selected = !dated)

        val out = mutableListOf(
            TasksField(
                key = WHEN,
                label = TasksCopy.FIELD_WHEN,
                value_ = if (dated) CivilWords.relativeDay(task.due_day, today) else TasksCopy.WHEN_NONE,
                choices = whenChoices,
                pick_date = true,
                enabled = true,
                // THE PICKER OPENS ON THE DUE DAY, else the core's today.
                day = task.due_day.ifEmpty { today },
                pick_label = TasksCopy.PICK_DATE,
            ),
            TasksField(
                key = TIME,
                label = TasksCopy.FIELD_TIME,
                value_ = task.due_time.ifEmpty { TasksCopy.TIME_NONE },
                choices = listOf(chip(NONE, TasksCopy.TIME_NONE, selected = task.due_time.isEmpty(), enabled = task.due_time.isNotEmpty())),
                pick_time = true,
                enabled = true,
                day = task.due_day.ifEmpty { today },
                time = task.due_time,
                pick_label = TasksCopy.PICK_TIME,
            ),
            TasksField(
                key = REMINDER,
                label = TasksCopy.FIELD_REMINDER,
                value_ = reminderValue(task, today),
                note = if (dated) TasksCopy.REMINDER_NOTE_A else TasksCopy.REMINDER_NEEDS_DUE,
                choices = listOf(chip(NONE, TasksCopy.REMIND_NONE, selected = task.remind_before_min == null, enabled = dated)) +
                    REMINDER_LEADS.map { (lead, label) -> chip(lead.toString(), label, selected = task.remind_before_min == lead, enabled = dated) },
                enabled = dated,
            ),
            TasksField(
                key = REPEATS,
                label = TasksCopy.FIELD_REPEATS,
                value_ = task.recurrence_summary?.takeIf { task.repeats && it.isNotBlank() } ?: TasksCopy.REPEATS_NEVER,
                note = when {
                    !dated -> TasksCopy.REPEATS_NEEDS_DUE
                    task.missed > 0 -> "${TasksCopy.MISSED} ${task.missed} · ${TasksCopy.NEXT_IS} ${CivilWords.relativeDay(task.due_day, today)}. ${TasksCopy.MISSED_NOTE_A}"
                    else -> ""
                },
                choices = listOf(chip(NONE, TasksCopy.REPEATS_NEVER, selected = !task.repeats)) +
                    REPEAT_RULES.map { (key, label, rule) -> chip(key, label, selected = task.repeats && task.rrule == rule, enabled = dated) },
                // For the picker only; the member reads `value` (#834).
                raw = task.rrule ?: "",
                enabled = dated || task.repeats,
            ),
        )
        if (task.repeats) {
            val anchor = task.recurrence_anchor ?: "scheduled"
            out += TasksField(
                key = ANCHOR,
                label = TasksCopy.FIELD_ANCHOR,
                value_ = if (anchor == "completion") TasksCopy.ANCHOR_COMPLETION else TasksCopy.ANCHOR_SCHEDULED,
                note = TasksCopy.ANCHOR_NOTE,
                choices = listOf(
                    chip("scheduled", TasksCopy.ANCHOR_SCHEDULED, anchor == "scheduled", meta = TasksCopy.ANCHOR_SCHEDULED_BODY),
                    chip("completion", TasksCopy.ANCHOR_COMPLETION, anchor == "completion", meta = TasksCopy.ANCHOR_COMPLETION_BODY),
                ),
                enabled = true,
            )
        }
        val level = task.priority.coerceIn(0L, 3L)
        out += TasksField(
            key = PRIORITY,
            label = TasksCopy.FIELD_PRIORITY,
            value_ = TasksRows.priorityLabel(task.priority).ifEmpty { TasksCopy.PRIORITY_NONE },
            note = "${TasksCopy.PRIORITY_NOTE_A} ${TasksCopy.PRIORITY_NOTE_B}",
            choices = listOf(
                chip(NONE, TasksCopy.PRIORITY_NONE, level == 0L),
                chip("1", TasksCopy.PRIORITY_SOON, level == 1L),
                chip("2", TasksCopy.PRIORITY_NEXT, level == 2L),
                chip("3", TasksCopy.PRIORITY_NOW, level == 3L),
            ),
            enabled = true,
        )
        out += TasksField(
            key = EFFORT,
            label = TasksCopy.FIELD_EFFORT,
            value_ = task.effort_min?.let(TasksRows::effortLabel) ?: TasksCopy.FIELD_EMPTY,
            choices = listOf(chip(NONE, TasksCopy.PRIORITY_NONE, task.effort_min == null)) +
                EFFORTS.map { m ->
                    chip(m.toString(), if (m == 60L) TasksCopy.EFFORT_HOUR else "$m ${TasksCopy.MIN}", task.effort_min == m)
                },
            enabled = true,
        )
        val project = task.project_id?.let { p -> projects.firstOrNull { it.project_id == p } }
        val section = task.section_id?.let { s -> sections.firstOrNull { it.section_id == s } }
        out += TasksField(
            key = PROJECT,
            label = TasksCopy.FIELD_PROJECT,
            value_ = when {
                project == null -> TasksCopy.INBOX
                section == null -> project.name
                else -> "${project.name} · ${section.name}"
            },
            choices = placeChoices(task, projects, sections),
            sheet = true,
            enabled = task.parent_task_id == null,
        )
        out += TasksField(
            key = TAGS,
            label = TasksCopy.FIELD_TAGS,
            value_ = if (task.tags.isEmpty()) TasksCopy.FIELD_EMPTY else task.tags.joinToString(" ") { "#${it.label}" },
            note = if (task.tags.isEmpty()) "" else TasksCopy.TAGS_NOTE_B,
            choices = task.tags.map { chip(it.tag_id, it.label, selected = true) },
            add_text = true,
            add_placeholder = TasksCopy.TAGS_ADD,
            enabled = true,
        )
        return out
    }

    /** The owner's ruling: a moment only when the core supplies one, else "On the day". */
    private fun reminderValue(task: TasksTask, today: String): String = when {
        task.remind_before_min == null -> TasksCopy.REMIND_NONE
        task.remind_at_local.isNotEmpty() ->
            "${CivilWords.relativeDay(task.remind_at_local.take(DAY), today)} ${CivilWords.clock(task.remind_at_local)}"
        else -> TasksCopy.REMINDER_ON_THE_DAY
    }

    private fun placeChoices(
        task: TasksTask,
        projects: List<centraid.core.v1.TasksProject>,
        sections: List<centraid.core.v1.TasksSection>,
    ): List<TasksChoice> = buildList {
        add(TasksChoice(key = TasksHomeMachine.FILE_INBOX, label = TasksCopy.INBOX, selected = task.project_id == null, enabled = true, icon_key = "Inbox"))
        val bySection = sections.groupBy { it.project_id }
        projects.sortedWith(compareBy({ it.sort_order }, { it.name })).forEach { project ->
            add(
                TasksChoice(
                    key = TasksHomeMachine.FILE_PROJECT + project.project_id,
                    label = project.name,
                    selected = task.project_id == project.project_id && task.section_id == null,
                    enabled = true,
                    icon_key = "Folder",
                ),
            )
            bySection[project.project_id].orEmpty().sortedBy { it.sort_order }.forEach { section ->
                add(
                    TasksChoice(
                        key = TasksHomeMachine.FILE_SECTION + section.section_id,
                        label = section.name,
                        selected = task.section_id == section.section_id,
                        enabled = true,
                        indented = true,
                    ),
                )
            }
        }
    }

    // ---------------------------------------------------------------------
    // Days
    // ---------------------------------------------------------------------

    /**
     * A quick pick's day, from the core's today (never the device clock):
     * this weekend is the Saturday on or after today (today, on a Sunday),
     * next week the Monday after.
     */
    public fun dayFor(key: String, today: String): String? {
        if (today.isEmpty()) return null
        val weekday = isoWeekdayOf(today) ?: return null
        return when (key) {
            TODAY -> today
            TOMORROW -> plusDays(today, 1)
            WEEKEND -> if (weekday == SUNDAY) today else plusDays(today, SATURDAY - weekday)
            NEXT_WEEK -> plusDays(today, SUNDAY - weekday + 1)
            else -> null
        }
    }

    /** SETTING THE DAY KEEPS THE TIME (v0's rule): a task due at 09:00 moved is still due at 09:00. */
    private fun withTime(task: TasksTask, day: String): String =
        if (task.due_time.isEmpty()) day else "${day}T${task.due_time}"

    private fun isClock(time: String): Boolean =
        time.length == CLOCK && time[2] == ':' && time.substring(0, 2).toIntOrNull()?.let { it in 0..23 } == true &&
            time.substring(3).toIntOrNull()?.let { it in 0..59 } == true

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    private fun decorate(state: TasksDetail): TasksDetail = state.copy(
        screen = state.screen.copy(chrome = TasksRows.CHROME, status = state.ops.status),
    )

    private fun task(state: TasksDetail): TasksTask? = state.answer?.task

    private fun todayOf(state: TasksDetail): String = state.answer?.today ?: ""

    private fun id(task: TasksTask): String = "\"task_id\":${jsonString(task.task_id)}"

    private fun projectsOf(state: TasksDetail): Pair<List<centraid.core.v1.TasksProject>, List<centraid.core.v1.TasksSection>> {
        val answer = state.projects
        if (answer != null) return answer.projects to answer.sections
        val detail = state.answer
        return listOfNotNull(detail?.project) to listOfNotNull(detail?.section)
    }

    private const val VERB_DELETE: String = "delete"
    private const val VERB_RELEASE: String = "release"
    private const val SATURDAY: Int = 6
    private const val SUNDAY: Int = 7
    private const val DAY: Int = 10
    private const val CLOCK: Int = 5

    // ---------------------------------------------------------------------
    // Lenses
    // ---------------------------------------------------------------------

    /** The detail's content and its autosave, for the kit's law. */
    internal object Lens : AutosaveLens<TasksDetail, TasksDetailData> {
        override val screenId: String = SCREEN_ID
        override val command: String = EDIT

        override fun subjectId(state: TasksDetail): String = state.screen.task_id

        override fun autosave(state: TasksDetail): Autosave = state.screen.autosave ?: Autosave()

        override fun withAutosave(state: TasksDetail, autosave: Autosave): TasksDetail =
            state.copy(screen = state.screen.copy(autosave = autosave))

        override fun baseline(state: TasksDetail): TasksDetailData? = state.screen.baseline?.let { TasksDetailData(draft = it) }

        override fun withBaseline(state: TasksDetail, baseline: TasksDetailData?): TasksDetail =
            state.copy(screen = state.screen.copy(baseline = baseline?.draft))

        override fun sending(state: TasksDetail): TasksDetailData? = state.screen.sending?.let { TasksDetailData(draft = it) }

        override fun withSending(state: TasksDetail, sending: TasksDetailData?): TasksDetail =
            state.copy(screen = state.screen.copy(sending = sending?.draft))

        /** `edit_task`'s input: the task, and ONLY the words that changed. */
        override fun input(state: TasksDetail, draft: TasksDetailData, baseline: TasksDetailData?): String? {
            val now = draft.draft ?: TasksDraft()
            val was = baseline?.draft ?: TasksDraft()
            val parts = mutableListOf<String>()
            if (now.title.trim() != was.title.trim()) parts += "\"title\":${jsonString(now.title.trim())}"
            if (now.notes != was.notes) {
                parts += if (now.notes.isBlank()) "\"clear_description\":true" else "\"description\":${jsonString(now.notes)}"
            }
            if (parts.isEmpty()) return null
            return "{\"task_id\":${jsonString(state.screen.task_id)},${parts.joinToString(",")}}"
        }

        /** A task needs a name: an emptied title is kept on screen and not sent. */
        override fun refusal(state: TasksDetail, draft: TasksDetailData, baseline: TasksDetailData?): ReadFailure? =
            if ((draft.draft?.title ?: "").isBlank()) Reads.refused(TasksCopy.TITLE_REQUIRED) else null

        override fun content(state: TasksDetail): ReadContent<TasksDetailData> {
            val s = state.screen
            return when {
                s.data_ != null -> ReadContent.Data(s.data_)
                s.failure != null -> ReadContent.Failed(s.failure)
                s.denied != null -> ReadContent.Denied(s.denied)
                else -> ReadContent.Loading(s.loading?.first_load ?: true)
            }
        }

        override fun with(state: TasksDetail, content: ReadContent<TasksDetailData>): TasksDetail {
            val s = state.screen
            val next = when (content) {
                is ReadContent.Loading -> s.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null, gone = null)
                is ReadContent.Failed -> s.copy(loading = null, failure = content.failure, denied = null, data_ = null, gone = null)
                is ReadContent.Denied -> s.copy(loading = null, failure = null, denied = content.denied, data_ = null, gone = null)
                is ReadContent.Data -> s.copy(loading = null, failure = null, denied = null, data_ = content.data, gone = null)
            }
            return state.copy(screen = next)
        }
    }

    private object Writes : WriteLens<TasksDetail> {
        override fun write(state: TasksDetail): WriteState = state.screen.write ?: WriteState()

        override fun with(state: TasksDetail, write: WriteState): TasksDetail = state.copy(screen = state.screen.copy(write = write))
    }
}

/** `tasks.task` and `tasks.projects` (the Project field's choices), in the device's zone. */
public object TasksDetailReads : ScreenQueries<TasksDetail, TasksDetailInput>, ScreenWrites<TasksDetail, TasksDetailInput> {
    override val screenId: String = TasksDetailMachine.SCREEN_ID
    override val tables: Set<String> = TasksDetailMachine.TABLES
    override val appId: String = APP_ID

    override fun requests(state: TasksDetail, now: DeviceClock.Reading): List<AppQueryRequest>? {
        val id = state.screen.task_id.ifEmpty { return null }
        return listOf(
            AppQueryRequest(tasks_task = TasksTaskRequest(task_id = id, tz = now.zone)),
            AppQueryRequest(tasks_projects = TasksProjectsRequest(tz = now.zone)),
        )
    }

    override fun arrived(answers: List<AppQueryResponse>): TasksDetailInput = TasksDetailInput.Answered(
        detail = answers.firstNotNullOfOrNull { it.tasks_task },
        projects = answers.firstNotNullOfOrNull { it.tasks_projects },
    )

    override fun refused(failure: ReadFailure): TasksDetailInput =
        TasksDetailInput.View(TasksDetailEvent(refused = TasksDetailEvent.ReadRefused(failure = failure)))

    override fun denied(denial: AppQueryDenial): TasksDetailInput = TasksDetailInput.Denied(denial)

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): TasksDetailInput =
        TasksDetailInput.View(TasksDetailEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey)))
}
