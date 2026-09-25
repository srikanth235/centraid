package dev.centraid.shared.apps.tasks

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.TasksCatchUp
import centraid.core.v1.TasksCatchUpRequest
import centraid.core.v1.TasksProjects
import centraid.core.v1.TasksProjectsRequest
import centraid.core.v1.TasksTask
import centraid.screen.v1.Confirm
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import centraid.screen.v1.StatusLine
import centraid.screen.v1.TasksCatchUpData
import centraid.screen.v1.TasksCatchUpEvent
import centraid.screen.v1.TasksCatchUpState
import centraid.screen.v1.TasksPile
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/** What `tasks.catch_up` holds. */
public data class TasksCatchUpPage(
    val screen: TasksCatchUpState,
    val answer: TasksCatchUp? = null,
    val projects: TasksProjects? = null,
    val ops: TaskOps = TaskOps(),
    val reading: Boolean = false,
    val readQueued: Boolean = false,
)

public sealed interface TasksCatchUpInput {
    public data class View(val event: TasksCatchUpEvent) : TasksCatchUpInput

    public data class Answered(val catchUp: TasksCatchUp?, val projects: TasksProjects?) : TasksCatchUpInput

    public data class Denied(val denial: AppQueryDenial) : TasksCatchUpInput
}

/**
 * CATCH UP — the pressure valve, reachable any day: what came due, what
 * repeats and is behind, what has sat 90 days. One bulk verb per pile,
 * "Complete all", behind a confirm.
 *
 * THE REPEATING PILE KEEPS ONLY WHAT IS BEHIND (owner ruling): a missed
 * period, or a due before today. The core answers that set; the machine keeps
 * the rule too, so a pile never shows a series that is merely repeating.
 */
public object TasksCatchUpMachine : ScreenMachine<TasksCatchUpPage, TasksCatchUpInput> {
    public const val SCREEN_ID: String = "tasks.catch_up"

    public val TABLES: Set<String> = TasksHomeMachine.TABLES

    public const val PILE_DATED: String = "dated"
    public const val PILE_REPEATING: String = "repeating"
    public const val PILE_SITTING: String = "sitting"

    override fun initial(): TasksCatchUpPage = decorate(
        TasksCatchUpPage(screen = TasksCatchUpState(loading = Loading(first_load = true))),
    )

    override fun reduce(state: TasksCatchUpPage, event: TasksCatchUpInput): Step<TasksCatchUpPage> {
        val step = when (event) {
            is TasksCatchUpInput.View -> view(state, event.event)
            is TasksCatchUpInput.Answered -> answered(state, event)
            is TasksCatchUpInput.Denied -> if (state.readQueued) {
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

    override fun rowsChanged(table: String, keys: List<String>): TasksCatchUpInput? =
        if (table in TABLES) TasksCatchUpInput.View(TasksCatchUpEvent(rows_changed = TasksCatchUpEvent.RowsChanged(table = table))) else null

    override fun seatChanged(seat: SeatState): TasksCatchUpInput =
        TasksCatchUpInput.View(TasksCatchUpEvent(seat_changed = TasksCatchUpEvent.SeatChanged(seat = seat)))

    /** Is this repeating task actually behind? */
    public fun behind(task: TasksTask): Boolean = task.missed > 0 || task.overdue

    private fun view(state: TasksCatchUpPage, event: TasksCatchUpEvent): Step<TasksCatchUpPage> {
        val screen = state.screen
        return when {
            event.opened != null -> read(
                state.copy(
                    screen = screen.copy(confirm = null, asking_pile = "", loading = Loading(first_load = true), failure = null, denied = null, data_ = null),
                    answer = null,
                ),
            )
            event.refreshed != null || event.rows_changed != null -> read(state.copy(screen = overRows(screen)))
            event.complete_all != null -> {
                val pile = event.complete_all.pile
                if (pile(state, pile).isEmpty()) {
                    Step(state)
                } else {
                    Step(
                        state.copy(
                            screen = screen.copy(
                                confirm = Confirm(
                                    title = TasksCopy.COMPLETE_ALL_TITLE,
                                    body = TasksCopy.COMPLETE_ALL_BODY,
                                    confirm_label = TasksCopy.COMPLETE_ALL,
                                    destructive = false,
                                ),
                                asking_pile = pile,
                            ),
                        ),
                    )
                }
            }
            event.confirmed != null -> {
                val tasks = pile(state, screen.asking_pile).filter { it.task_id !in state.ops.hidden }
                val cleared = state.copy(screen = screen.copy(confirm = null, asking_pile = ""))
                if (tasks.isEmpty()) return Step(cleared)
                var ops = cleared.ops
                val effects = mutableListOf<ScreenEffect>()
                tasks.forEach { task ->
                    val out = TaskOpsLaw.checked(ops, task)
                    ops = out.ops
                    effects += out.effects
                }
                // A BULK VERB SAYS ITS COUNT, and offers no Undo of twelve.
                ops = ops.copy(
                    status = StatusLine(sentence = "${tasks.size} ${if (tasks.size == 1) TasksCopy.TASK_DONE.lowercase() else TasksCopy.TASKS_DONE}"),
                    undo = null,
                    nextOf = null,
                )
                Step(refold(cleared.copy(ops = ops)), effects)
            }
            event.dismissed != null -> Step(state.copy(screen = screen.copy(confirm = null, asking_pile = "")))
            event.row_checked != null -> {
                val task = all(state).firstOrNull { it.task_id == event.row_checked.task_id } ?: return Step(state)
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
            else -> Step(state)
        }
    }

    private fun ops(state: TasksCatchUpPage, out: TaskOpsLaw.Out): Step<TasksCatchUpPage> =
        Step(refold(state.copy(ops = out.ops)), out.effects)

    private fun read(state: TasksCatchUpPage): Step<TasksCatchUpPage> =
        if (state.reading) Step(state.copy(readQueued = true)) else reissue(state)

    private fun reissue(state: TasksCatchUpPage): Step<TasksCatchUpPage> = Step(
        state.copy(reading = true, readQueued = false),
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    private fun answered(state: TasksCatchUpPage, answer: TasksCatchUpInput.Answered): Step<TasksCatchUpPage> {
        if (state.readQueued) return reissue(state)
        val catchUp = answer.catchUp ?: return Step(
            state.copy(
                reading = false,
                screen = state.screen.copy(loading = null, data_ = null, denied = null, failure = Reads.refused(TasksCopy.READ_INCOMPLETE)),
            ),
        )
        val held = state.copy(reading = false, answer = catchUp, projects = answer.projects ?: state.projects)
        val open = (catchUp.dated + catchUp.repeating + catchUp.sitting).filter(TasksRows::isOpen)
        return Step(refold(held.copy(ops = TaskOpsLaw.answered(held.ops, open, catchUp.today)), force = true))
    }

    private fun refold(state: TasksCatchUpPage, force: Boolean = false): TasksCatchUpPage {
        if (!force && state.screen.data_ == null) return state
        val data = fold(state) ?: return state
        return state.copy(screen = state.screen.copy(loading = null, failure = null, denied = null, data_ = data))
    }

    public fun fold(state: TasksCatchUpPage): TasksCatchUpData? {
        val answer = state.answer ?: return null
        val projects = state.projects
        val ctx = TasksRows.Context(
            today = answer.today,
            projects = projects?.projects?.associateBy { it.project_id } ?: emptyMap(),
            sections = projects?.sections?.associateBy { it.section_id } ?: emptyMap(),
            pending = state.ops.pendingIds,
            hidden = state.ops.hiddenIds,
        )
        val busy = state.ops.inFlight.values.map { it.taskId }.toSet()
        val piles = listOf(
            Triple(PILE_DATED, TasksCopy.PILE_DATED, answer.dated),
            Triple(PILE_REPEATING, TasksCopy.PILE_REPEATING, answer.repeating.filter(::behind)),
            Triple(PILE_SITTING, TasksCopy.PILE_SITTING, answer.sitting),
        ).mapNotNull { (key, title, tasks) ->
            val shown = tasks.filter { it.task_id !in ctx.hidden }
            if (shown.isEmpty()) return@mapNotNull null
            TasksPile(
                key = key,
                title = title,
                meta = shown.size.toString(),
                verb_label = TasksCopy.COMPLETE_ALL,
                verb_enabled = shown.none { it.task_id in busy },
                rows = shown.map { TasksRows.row(it, ctx) },
            )
        }
        val overdue = answer.overdue
        return TasksCatchUpData(
            today = answer.today,
            head = if (answer.absent) {
                "${answer.away_days} ${TasksCopy.DAYS_AWAY} · $overdue ${if (overdue == 1) TasksCopy.CAME_DUE_ONE else TasksCopy.CAME_DUE_MANY}"
            } else {
                ""
            },
            piles = piles,
            empty = if (piles.isEmpty()) EmptyState(headline = TasksCopy.CATCH_UP_EMPTY) else EmptyState(),
        )
    }

    private fun pile(state: TasksCatchUpPage, key: String): List<TasksTask> {
        val answer = state.answer ?: return emptyList()
        return when (key) {
            PILE_DATED -> answer.dated
            PILE_REPEATING -> answer.repeating.filter(::behind)
            PILE_SITTING -> answer.sitting
            else -> emptyList()
        }
    }

    private fun all(state: TasksCatchUpPage): List<TasksTask> =
        state.answer?.let { it.dated + it.repeating + it.sitting } ?: emptyList()

    private fun decorate(state: TasksCatchUpPage): TasksCatchUpPage = state.copy(
        screen = state.screen.copy(chrome = TasksRows.CHROME.copy(title = TasksCopy.CATCH_UP), status = state.ops.status),
    )

    private fun overRows(screen: TasksCatchUpState): TasksCatchUpState =
        if (screen.data_ != null) screen else screen.copy(loading = Loading(first_load = true), failure = null, denied = null)
}

/** `tasks.catch-up`, and the projects its rows name. */
public object TasksCatchUpReads : ScreenQueries<TasksCatchUpPage, TasksCatchUpInput>, ScreenWrites<TasksCatchUpPage, TasksCatchUpInput> {
    override val screenId: String = TasksCatchUpMachine.SCREEN_ID
    override val tables: Set<String> = TasksCatchUpMachine.TABLES
    override val appId: String = APP_ID

    override fun requests(state: TasksCatchUpPage, now: DeviceClock.Reading): List<AppQueryRequest> = listOf(
        AppQueryRequest(tasks_catch_up = TasksCatchUpRequest(tz = now.zone)),
        AppQueryRequest(tasks_projects = TasksProjectsRequest(tz = now.zone)),
    )

    override fun arrived(answers: List<AppQueryResponse>): TasksCatchUpInput = TasksCatchUpInput.Answered(
        catchUp = answers.firstNotNullOfOrNull { it.tasks_catch_up },
        projects = answers.firstNotNullOfOrNull { it.tasks_projects },
    )

    override fun refused(failure: ReadFailure): TasksCatchUpInput =
        TasksCatchUpInput.View(TasksCatchUpEvent(refused = TasksCatchUpEvent.ReadRefused(failure = failure)))

    override fun denied(denial: AppQueryDenial): TasksCatchUpInput = TasksCatchUpInput.Denied(denial)

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): TasksCatchUpInput =
        TasksCatchUpInput.View(TasksCatchUpEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey)))
}
