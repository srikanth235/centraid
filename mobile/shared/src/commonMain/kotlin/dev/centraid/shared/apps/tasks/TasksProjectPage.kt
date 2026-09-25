package dev.centraid.shared.apps.tasks

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.TasksBoard
import centraid.core.v1.TasksBoardRequest
import centraid.core.v1.TasksGroupKind
import centraid.core.v1.TasksTask
import centraid.core.v1.TasksView
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import centraid.screen.v1.TasksProjectData
import centraid.screen.v1.TasksProjectEvent
import centraid.screen.v1.TasksProjectState
import centraid.screen.v1.TasksQuickAdd
import centraid.screen.v1.TasksRowGroup
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/** What `tasks.project` holds. */
public data class TasksProjectPage(
    val screen: TasksProjectState,
    val board: TasksBoard? = null,
    val ops: TaskOps = TaskOps(),
    val reading: Boolean = false,
    val readQueued: Boolean = false,
)

public sealed interface TasksProjectInput {
    public data class View(val event: TasksProjectEvent) : TasksProjectInput

    /** The quick add, with the id the bridge minted. */
    public data class Add(val taskId: String) : TasksProjectInput

    public data class Answered(val board: TasksBoard?) : TasksProjectInput

    public data class Denied(val denial: AppQueryDenial) : TasksProjectInput
}

/**
 * ONE PROJECT: its work in no section, then every section in its order — an
 * empty section drawn too, with its own "Add task" — and "Add section".
 *
 * A quick add here is two writes: `add_task` (which takes no project), then
 * `organize_task` into the project and the section the member pointed at.
 */
public object TasksProjectMachine : ScreenMachine<TasksProjectPage, TasksProjectInput> {
    public const val SCREEN_ID: String = "tasks.project"

    public val TABLES: Set<String> = TasksHomeMachine.TABLES

    private val NONE = TasksProjectState.Sheet.SHEET_NONE

    override fun initial(): TasksProjectPage = decorate(
        TasksProjectPage(screen = TasksProjectState(sheet = NONE, loading = Loading(first_load = true))),
    )

    override fun reduce(state: TasksProjectPage, event: TasksProjectInput): Step<TasksProjectPage> {
        val step = when (event) {
            is TasksProjectInput.View -> view(state, event.event)
            is TasksProjectInput.Add -> add(state, event.taskId)
            is TasksProjectInput.Answered -> answered(state, event.board)
            is TasksProjectInput.Denied -> if (state.readQueued) {
                reissue(state)
            } else {
                Step(
                    state.copy(
                        reading = false,
                        screen = state.screen.copy(loading = null, failure = null, data_ = null, denied = TasksHomeMachine.deniedOf(event.denial)),
                    ),
                )
            }
        }
        return Step(decorate(step.state), step.effects)
    }

    override fun rowsChanged(table: String, keys: List<String>): TasksProjectInput? =
        if (table in TABLES) TasksProjectInput.View(TasksProjectEvent(rows_changed = TasksProjectEvent.RowsChanged(table = table))) else null

    override fun seatChanged(seat: SeatState): TasksProjectInput =
        TasksProjectInput.View(TasksProjectEvent(seat_changed = TasksProjectEvent.SeatChanged(seat = seat)))

    private fun view(state: TasksProjectPage, event: TasksProjectEvent): Step<TasksProjectPage> {
        val screen = state.screen
        return when {
            event.opened != null -> read(
                TasksProjectPage(
                    screen = screen.copy(
                        project_id = event.opened.project_id,
                        title = event.opened.title,
                        sheet = NONE,
                        target_section_id = "",
                        new_section_name = "",
                        quick_add = TasksQuickAdd(),
                        loading = Loading(first_load = true),
                        failure = null,
                        denied = null,
                        data_ = null,
                    ),
                    ops = state.ops,
                    reading = state.reading,
                    readQueued = state.readQueued,
                ),
            )
            event.refreshed != null || event.rows_changed != null -> read(state.copy(screen = overRows(screen)))
            event.row_checked != null -> {
                val task = find(state, event.row_checked.task_id) ?: return Step(state)
                ops(state, TaskOpsLaw.checked(state.ops, task))
            }
            event.status_acted != null -> ops(state, TaskOpsLaw.undo(state.ops))
            event.write_settled != null -> ops(state, TaskOpsLaw.settled(state.ops, event.write_settled))
            event.quick_add_changed != null ->
                Step(state.copy(screen = screen.copy(quick_add = (screen.quick_add ?: TasksQuickAdd()).copy(title = event.quick_add_changed.title))))
            event.group_verb != null -> {
                val key = event.group_verb.key
                if (!key.startsWith(TasksRows.VERB_ADD)) {
                    Step(state)
                } else {
                    Step(state.copy(screen = screen.copy(target_section_id = key.removePrefix(TasksRows.VERB_ADD))))
                }
            }
            event.add_section != null -> Step(state.copy(screen = screen.copy(sheet = TasksProjectState.Sheet.SHEET_ADD_SECTION)))
            event.section_name != null -> Step(state.copy(screen = screen.copy(new_section_name = event.section_name.name)))
            event.section_submitted != null -> {
                val name = screen.new_section_name.trim()
                if (name.isEmpty() || screen.project_id.isEmpty()) {
                    Step(state)
                } else {
                    val input = "{\"project_id\":${jsonString(screen.project_id)},\"name\":${jsonString(name)}}"
                    val out = TaskOpsLaw.created(state.ops, TaskOpsLaw.SAVE_SECTION, input, "${screen.project_id}/$name", TasksCopy.SECTION_ADDED)
                    Step(state.copy(ops = out.ops, screen = screen.copy(sheet = NONE, new_section_name = "")), out.effects)
                }
            }
            event.sheet_closed != null -> Step(state.copy(screen = screen.copy(sheet = NONE, new_section_name = "")))
            event.refused != null -> if (state.readQueued) {
                reissue(state)
            } else {
                Step(
                    state.copy(
                        reading = false,
                        screen = screen.copy(loading = null, data_ = null, denied = null, failure = event.refused.failure ?: Reads.refused(TasksCopy.READ_INCOMPLETE)),
                    ),
                )
            }
            event.seat_changed != null -> Step(state.copy(screen = screen.copy(seat = event.seat_changed.seat)))
            // INTENTS: the bridge mints a quick add's id; a row opens the detail.
            else -> Step(state)
        }
    }

    private fun add(state: TasksProjectPage, taskId: String): Step<TasksProjectPage> {
        val screen = state.screen
        val title = screen.quick_add?.title?.trim().orEmpty()
        if (title.isEmpty() || screen.project_id.isEmpty() || screen.data_?.found != true) return Step(state)
        val section = screen.target_section_id.ifEmpty { null }
        val out = TaskOpsLaw.added(
            state.ops,
            taskId = taskId,
            title = title,
            dueDay = "",
            landsIn = landsIn(state),
            projectId = screen.project_id,
            sectionId = section,
        )
        return Step(
            refold(state.copy(ops = out.ops, screen = screen.copy(quick_add = (screen.quick_add ?: TasksQuickAdd()).copy(title = "")))),
            out.effects,
        )
    }

    private fun ops(state: TasksProjectPage, out: TaskOpsLaw.Out): Step<TasksProjectPage> =
        Step(refold(state.copy(ops = out.ops)), out.effects)

    private fun read(state: TasksProjectPage): Step<TasksProjectPage> =
        if (state.reading) Step(state.copy(readQueued = true)) else reissue(state)

    private fun reissue(state: TasksProjectPage): Step<TasksProjectPage> = Step(
        state.copy(reading = true, readQueued = false),
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    private fun answered(state: TasksProjectPage, board: TasksBoard?): Step<TasksProjectPage> {
        if (state.readQueued) return reissue(state)
        if (board == null) {
            return Step(
                state.copy(
                    reading = false,
                    screen = state.screen.copy(loading = null, data_ = null, denied = null, failure = Reads.refused(TasksCopy.READ_INCOMPLETE)),
                ),
            )
        }
        val open = board.groups.flatMap(TasksHomeMachine::flatten).filter(TasksRows::isOpen)
        return Step(refold(state.copy(reading = false, board = board, ops = TaskOpsLaw.answered(state.ops, open, board.today)), force = true))
    }

    private fun refold(state: TasksProjectPage, force: Boolean = false): TasksProjectPage {
        if (!force && state.screen.data_ == null) return state
        val data = fold(state) ?: return state
        val name = state.board?.projects?.firstOrNull { it.project_id == state.screen.project_id }?.name
        return state.copy(
            screen = state.screen.copy(
                title = name ?: state.screen.title,
                loading = null,
                failure = null,
                denied = null,
                data_ = data,
            ),
        )
    }

    public fun fold(state: TasksProjectPage): TasksProjectData? {
        val board = state.board ?: return null
        val projectId = state.screen.project_id
        val found = board.projects.any { it.project_id == projectId }
        if (!found) {
            return TasksProjectData(today = board.today, found = false, empty = EmptyState(headline = TasksCopy.PROJECT_GONE))
        }
        val ctx = TasksRows.Context(
            today = board.today,
            projects = board.projects.associateBy { it.project_id },
            sections = board.sections.associateBy { it.section_id },
            showProject = false,
            pending = state.ops.pendingIds,
            hidden = state.ops.hiddenIds,
        )
        val groups = withAdds(TasksRows.groups(board.groups, ctx), state.ops, projectId)
        val any = groups.any { it.rows.isNotEmpty() }
        return TasksProjectData(
            today = board.today,
            groups = groups,
            empty = if (any || groups.isNotEmpty()) EmptyState() else EmptyState(headline = TasksCopy.PROJECT_EMPTY),
            count_label = TasksRows.count(TasksRows.rootCount(groups), TasksCopy.TASK_ONE, TasksCopy.TASK_MANY),
            add_section_label = TasksCopy.ADD_SECTION,
            found = true,
        )
    }

    /** A pending add, drawn under the section it was pointed at. */
    private fun withAdds(groups: List<TasksRowGroup>, ops: TaskOps, projectId: String): List<TasksRowGroup> {
        val carried = groups.flatMap { g -> g.rows.map { it.task_id } }.toSet()
        val adds = ops.adds.filter { it.projectId == projectId && it.taskId !in carried }
        if (adds.isEmpty()) return groups
        var out = groups
        adds.groupBy { it.sectionId }.forEach { (section, pending) ->
            val rows = pending.map { TasksRows.pendingRow(it.taskId, it.title) }
            val at = out.indexOfFirst { if (section == null) it.section_id == null else it.section_id == section }
            out = if (at >= 0) {
                out.mapIndexed { i, g -> if (i == at) g.copy(rows = g.rows + rows, meta = (g.rows.size + rows.size).toString()) else g }
            } else {
                listOf(
                    TasksRowGroup(
                        key = "${TasksGroupKind.TASKS_GROUP_KIND_UNSECTIONED.value}|$projectId",
                        title = TasksCopy.GROUP_UNSECTIONED,
                        meta = rows.size.toString(),
                        verb_label = TasksCopy.ADD_TASK,
                        verb_key = TasksRows.VERB_ADD,
                        rows = rows,
                    ),
                ) + out
            }
        }
        return out
    }

    private fun landsIn(state: TasksProjectPage): String {
        val board = state.board
        val name = board?.projects?.firstOrNull { it.project_id == state.screen.project_id }?.name ?: state.screen.title
        val section = board?.sections?.firstOrNull { it.section_id == state.screen.target_section_id }?.name
        return if (section != null) "$name · $section" else name
    }

    private fun decorate(state: TasksProjectPage): TasksProjectPage {
        val screen = state.screen
        val title = screen.quick_add?.title.orEmpty()
        return state.copy(
            screen = screen.copy(
                chrome = TasksRows.CHROME,
                status = state.ops.status,
                quick_add = TasksQuickAdd(
                    title = title,
                    can_submit = title.isNotBlank(),
                    lands_label = "${TasksCopy.LANDS_IN} ${landsIn(state)}",
                    shown = screen.data_?.found == true,
                ),
                new_section_can_submit = screen.new_section_name.isNotBlank(),
            ),
        )
    }

    public fun find(state: TasksProjectPage, id: String): TasksTask? =
        state.board?.groups?.flatMap(TasksHomeMachine::flatten)?.firstOrNull { it.task_id == id }

    private fun overRows(screen: TasksProjectState): TasksProjectState =
        if (screen.data_ != null) screen else screen.copy(loading = Loading(first_load = true), failure = null, denied = null)
}

/** `tasks.board` for one project, in the device's zone. */
public object TasksProjectReads : ScreenQueries<TasksProjectPage, TasksProjectInput>, ScreenWrites<TasksProjectPage, TasksProjectInput> {
    override val screenId: String = TasksProjectMachine.SCREEN_ID
    override val tables: Set<String> = TasksProjectMachine.TABLES
    override val appId: String = APP_ID

    override fun requests(state: TasksProjectPage, now: DeviceClock.Reading): List<AppQueryRequest>? {
        val project = state.screen.project_id.ifEmpty { return null }
        return listOf(
            AppQueryRequest(
                tasks_board = TasksBoardRequest(
                    tz = now.zone,
                    limit = TasksHomeMachine.MAX_WINDOW,
                    view = TasksView.TASKS_VIEW_PROJECT,
                    project_id = project,
                ),
            ),
        )
    }

    override fun arrived(answers: List<AppQueryResponse>): TasksProjectInput =
        TasksProjectInput.Answered(answers.firstNotNullOfOrNull { it.tasks_board })

    override fun refused(failure: ReadFailure): TasksProjectInput =
        TasksProjectInput.View(TasksProjectEvent(refused = TasksProjectEvent.ReadRefused(failure = failure)))

    override fun denied(denial: AppQueryDenial): TasksProjectInput = TasksProjectInput.Denied(denial)

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): TasksProjectInput =
        TasksProjectInput.View(TasksProjectEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey)))
}
