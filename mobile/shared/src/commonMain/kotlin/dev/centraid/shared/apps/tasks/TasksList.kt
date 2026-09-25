package dev.centraid.shared.apps.tasks

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.TasksBoard
import centraid.core.v1.TasksBoardRequest
import centraid.core.v1.TasksTask
import centraid.core.v1.TasksView
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import centraid.screen.v1.TasksListData
import centraid.screen.v1.TasksListEvent
import centraid.screen.v1.TasksListState
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/** What `tasks.list` holds: the state, the board answer, and its writes. */
public data class TasksList(
    val screen: TasksListState,
    val board: TasksBoard? = null,
    val ops: TaskOps = TaskOps(),
    val reading: Boolean = false,
    val readQueued: Boolean = false,
    val limit: Int = TasksHomeMachine.PAGE,
)

public sealed interface TasksListInput {
    public data class View(val event: TasksListEvent) : TasksListInput

    public data class Answered(val board: TasksBoard?) : TasksListInput

    public data class Denied(val denial: AppQueryDenial) : TasksListInput
}

/**
 * ANYTIME, ALL, LOGBOOK, REMINDERS — one screen, the view a parameter (law 2),
 * each reached from Home's More sheet.
 *
 * Open views check a row off (hidden, "Task done", Undo); the Logbook's box
 * reopens, because a done row is drawn in the Logbook only (owner ruling).
 */
public object TasksListMachine : ScreenMachine<TasksList, TasksListInput> {
    public const val SCREEN_ID: String = "tasks.list"

    public val TABLES: Set<String> = TasksHomeMachine.TABLES

    private val ANYTIME = TasksListState.View.VIEW_ANYTIME
    private val ALL = TasksListState.View.VIEW_ALL
    private val LOGBOOK = TasksListState.View.VIEW_LOGBOOK
    private val REMINDERS = TasksListState.View.VIEW_REMINDERS

    override fun initial(): TasksList = decorate(
        TasksList(screen = TasksListState(view = ANYTIME, loading = Loading(first_load = true))),
    )

    override fun reduce(state: TasksList, event: TasksListInput): Step<TasksList> {
        val step = when (event) {
            is TasksListInput.View -> view(state, event.event)
            is TasksListInput.Answered -> answered(state, event.board)
            is TasksListInput.Denied -> if (state.readQueued) {
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

    override fun rowsChanged(table: String, keys: List<String>): TasksListInput? =
        if (table in TABLES) TasksListInput.View(TasksListEvent(rows_changed = TasksListEvent.RowsChanged(table = table))) else null

    override fun seatChanged(seat: SeatState): TasksListInput =
        TasksListInput.View(TasksListEvent(seat_changed = TasksListEvent.SeatChanged(seat = seat)))

    public fun viewOf(view: TasksListState.View): TasksView? = when (view) {
        ANYTIME -> TasksView.TASKS_VIEW_ANYTIME
        ALL -> TasksView.TASKS_VIEW_ALL
        LOGBOOK -> TasksView.TASKS_VIEW_LOGBOOK
        REMINDERS -> TasksView.TASKS_VIEW_REMINDERS
        else -> null
    }

    public fun titleOf(view: TasksListState.View): String = when (view) {
        ALL -> TasksCopy.VIEW_ALL
        LOGBOOK -> TasksCopy.VIEW_LOGBOOK
        REMINDERS -> TasksCopy.VIEW_REMINDERS
        else -> TasksCopy.VIEW_ANYTIME
    }

    private fun view(state: TasksList, event: TasksListEvent): Step<TasksList> {
        val screen = state.screen
        return when {
            event.opened != null -> {
                val to = event.opened.view.takeUnless { it == TasksListState.View.VIEW_UNSPECIFIED } ?: ANYTIME
                read(
                    state.copy(
                        screen = screen.copy(view = to, loading = Loading(first_load = true), failure = null, denied = null, data_ = null),
                        board = null,
                        limit = TasksHomeMachine.PAGE,
                    ),
                )
            }
            event.refreshed != null || event.rows_changed != null -> read(state.copy(screen = overRows(screen)))
            event.row_checked != null -> {
                val task = find(state, event.row_checked.task_id) ?: return Step(state)
                ops(state, TaskOpsLaw.checked(state.ops, task))
            }
            event.status_acted != null -> ops(state, TaskOpsLaw.undo(state.ops))
            event.write_settled != null -> ops(state, TaskOpsLaw.settled(state.ops, event.write_settled))
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
            event.next_page != null -> if (state.limit >= TasksHomeMachine.MAX_WINDOW) {
                Step(state)
            } else {
                read(state.copy(limit = (state.limit + TasksHomeMachine.PAGE).coerceAtMost(TasksHomeMachine.MAX_WINDOW)))
            }
            // INTENT: the detail.
            else -> Step(state)
        }
    }

    private fun ops(state: TasksList, out: TaskOpsLaw.Out): Step<TasksList> =
        Step(refold(state.copy(ops = out.ops)), out.effects)

    private fun read(state: TasksList): Step<TasksList> =
        if (state.reading) Step(state.copy(readQueued = true)) else reissue(state)

    private fun reissue(state: TasksList): Step<TasksList> = Step(
        state.copy(reading = true, readQueued = false),
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    private fun answered(state: TasksList, board: TasksBoard?): Step<TasksList> {
        if (state.readQueued) return reissue(state)
        if (board == null || board.view != viewOf(state.screen.view)) {
            return Step(
                state.copy(
                    reading = false,
                    screen = state.screen.copy(loading = null, data_ = null, denied = null, failure = Reads.refused(TasksCopy.READ_INCOMPLETE)),
                ),
            )
        }
        val open = board.groups.flatMap(TasksHomeMachine::flatten).filter(TasksRows::isOpen)
        return Step(
            refold(
                state.copy(reading = false, board = board, ops = TaskOpsLaw.answered(state.ops, open, board.today)),
                force = true,
            ),
        )
    }

    private fun refold(state: TasksList, force: Boolean = false): TasksList {
        if (!force && state.screen.data_ == null) return state
        val data = fold(state) ?: return state
        return state.copy(screen = state.screen.copy(loading = null, failure = null, denied = null, data_ = data))
    }

    public fun fold(state: TasksList): TasksListData? {
        val board = state.board ?: return null
        val ctx = TasksRows.Context(
            today = board.today,
            projects = board.projects.associateBy { it.project_id },
            sections = board.sections.associateBy { it.section_id },
            pending = state.ops.pendingIds,
            hidden = state.ops.hiddenIds,
        )
        val groups = TasksRows.groups(board.groups, ctx)
        val empty = if (groups.isNotEmpty()) {
            EmptyState()
        } else {
            EmptyState(
                headline = when (state.screen.view) {
                    ALL -> TasksCopy.ALL_EMPTY
                    LOGBOOK -> TasksCopy.LOGBOOK_EMPTY
                    REMINDERS -> TasksCopy.REMINDERS_EMPTY
                    else -> TasksCopy.ANYTIME_EMPTY
                },
            )
        }
        return TasksListData(
            today = board.today,
            groups = groups,
            empty = empty,
            count_label = TasksRows.count(TasksRows.rootCount(groups), TasksCopy.TASK_ONE, TasksCopy.TASK_MANY),
            window_label = if (board.truncated) {
                "${TasksRows.count(board.window, TasksCopy.TASK_ONE, TasksCopy.TASK_MANY)} · ${TasksCopy.WINDOW}"
            } else {
                ""
            },
            can_show_more = board.truncated && state.limit < TasksHomeMachine.MAX_WINDOW,
        )
    }

    private fun decorate(state: TasksList): TasksList = state.copy(
        screen = state.screen.copy(
            title = titleOf(state.screen.view),
            chrome = TasksRows.CHROME,
            status = state.ops.status,
        ),
    )

    public fun find(state: TasksList, id: String): TasksTask? =
        state.board?.groups?.flatMap(TasksHomeMachine::flatten)?.firstOrNull { it.task_id == id }

    private fun overRows(screen: TasksListState): TasksListState =
        if (screen.data_ != null) screen else screen.copy(loading = Loading(first_load = true), failure = null, denied = null)
}

/** `tasks.board` for the list's view, in the device's zone. */
public object TasksListReads : ScreenQueries<TasksList, TasksListInput>, ScreenWrites<TasksList, TasksListInput> {
    override val screenId: String = TasksListMachine.SCREEN_ID
    override val tables: Set<String> = TasksListMachine.TABLES
    override val appId: String = APP_ID

    override fun requests(state: TasksList, now: DeviceClock.Reading): List<AppQueryRequest>? {
        val view = TasksListMachine.viewOf(state.screen.view) ?: return null
        return listOf(AppQueryRequest(tasks_board = TasksBoardRequest(tz = now.zone, limit = state.limit, view = view)))
    }

    override fun arrived(answers: List<AppQueryResponse>): TasksListInput =
        TasksListInput.Answered(answers.firstNotNullOfOrNull { it.tasks_board })

    override fun refused(failure: ReadFailure): TasksListInput =
        TasksListInput.View(TasksListEvent(refused = TasksListEvent.ReadRefused(failure = failure)))

    override fun denied(denial: AppQueryDenial): TasksListInput = TasksListInput.Denied(denial)

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): TasksListInput =
        TasksListInput.View(TasksListEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey)))
}
