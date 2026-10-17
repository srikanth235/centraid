package dev.centraid.shared.apps.tasks

import centraid.screen.v1.TasksCatchUpEvent
import centraid.screen.v1.TasksDetailEvent
import centraid.screen.v1.TasksDetailState
import centraid.screen.v1.TasksHomeEvent
import centraid.screen.v1.TasksHomeState
import centraid.screen.v1.TasksListEvent
import centraid.screen.v1.TasksListState
import centraid.screen.v1.TasksProjectEvent
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.ScreenOpening
import dev.centraid.shared.nav.ScreenOpenings

/**
 * WHERE TASKS' INTENTS GO, ONCE (#1029 port).
 *
 * A Tasks machine that emits a row, a project, a More row, a Catch-up verb, a
 * subtask or a parent changes nothing, or only closes its sheet; the shell
 * pushes. WHICH page that is lives here and nowhere else: Android reads the
 * [Destination] ([home], [list], [project], [catchUp], [detail]) and pushes it,
 * and iOS, whose views cannot hold one, asks [route] for the screen id and
 * `Opened` event and pushes that. The event is the one the view just forwarded
 * and the state is the screen's own, so a project's name and a parent's id are
 * read where the machine already holds them.
 */
public object TasksRouting {
    /** Home's intents; null for an event that is the machine's own (`search`, `reads`, a tab). */
    public fun home(event: TasksHomeEvent, state: TasksHomeState): Destination? {
        val picked = event.row_picked
        val projectPicked = event.project_picked
        val more = event.more_row
        return when {
            picked != null -> detailOf(picked.task_id)
            projectPicked != null -> {
                val name = state.data_?.projects.orEmpty().flatMap { it.rows }
                    .firstOrNull { it.id == projectPicked.project_id }?.title.orEmpty()
                Destination.TasksProject(projectPicked.project_id, name)
            }
            more != null -> when (more.key) {
                TasksHomeMachine.MORE_ANYTIME -> Destination.TasksList(TasksListState.View.VIEW_ANYTIME)
                TasksHomeMachine.MORE_ALL -> Destination.TasksList(TasksListState.View.VIEW_ALL)
                TasksHomeMachine.MORE_LOGBOOK -> Destination.TasksList(TasksListState.View.VIEW_LOGBOOK)
                TasksHomeMachine.MORE_REMINDERS -> Destination.TasksList(TasksListState.View.VIEW_REMINDERS)
                TasksHomeMachine.MORE_CATCH_UP -> Destination.TasksCatchUp
                TasksHomeMachine.MORE_TRASH -> Destination.TasksTrash
                else -> null
            }
            event.group_verb?.key == TasksRows.VERB_CATCH_UP -> Destination.TasksCatchUp
            event.notice_acted != null && state.data_?.notice?.verb_key == TasksRows.VERB_CATCH_UP -> Destination.TasksCatchUp
            else -> null
        }
    }

    public fun list(event: TasksListEvent): Destination? = event.row_picked?.let { detailOf(it.task_id) }

    public fun project(event: TasksProjectEvent): Destination? = event.row_picked?.let { detailOf(it.task_id) }

    public fun catchUp(event: TasksCatchUpEvent): Destination? = event.row_picked?.let { detailOf(it.task_id) }

    /** A subtask opens its own page; the parent opens the task this one hangs from, once the state names it. */
    public fun detail(event: TasksDetailEvent, state: TasksDetailState): Destination? {
        val subtask = event.subtask_picked
        return when {
            subtask != null -> detailOf(subtask.task_id)
            event.parent_picked != null -> detailOf(state.data_?.parent_task_id.orEmpty())
            else -> null
        }
    }

    /**
     * THE SAME DECISION FOR A SHELL THAT SENDS BYTES: [event] is what screen
     * [screenId] just forwarded and [state] is that screen's own state. Null
     * for an event that routes nowhere, a screen that is not Tasks', or bytes
     * that do not decode.
     */
    public fun route(screenId: String, event: ByteArray, state: ByteArray): ScreenOpening? {
        val destination = runCatching {
            when (screenId) {
                TasksHomeMachine.SCREEN_ID -> home(TasksHomeEvent.ADAPTER.decode(event), TasksHomeState.ADAPTER.decode(state))
                TasksListMachine.SCREEN_ID -> list(TasksListEvent.ADAPTER.decode(event))
                TasksProjectMachine.SCREEN_ID -> project(TasksProjectEvent.ADAPTER.decode(event))
                TasksCatchUpMachine.SCREEN_ID -> catchUp(TasksCatchUpEvent.ADAPTER.decode(event))
                TasksDetailMachine.SCREEN_ID -> detail(TasksDetailEvent.ADAPTER.decode(event), TasksDetailState.ADAPTER.decode(state))
                else -> null
            }
        }.getOrNull()
        return destination?.let(ScreenOpenings::of)
    }

    /** A task with no id names nothing, so it opens nothing. */
    private fun detailOf(taskId: String): Destination? =
        if (taskId.isEmpty()) null else Destination.TasksDetail(taskId)
}
