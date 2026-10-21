package dev.centraid.shared.apps.agenda

import centraid.screen.v1.AgendaEventEvent
import centraid.screen.v1.AgendaEventState
import centraid.screen.v1.AgendaHomeEvent
import centraid.screen.v1.AgendaHomeState
import centraid.screen.v1.TasksCatchUpEvent
import centraid.screen.v1.TasksDetailEvent
import centraid.screen.v1.TasksDetailState
import centraid.screen.v1.TasksListEvent
import centraid.screen.v1.TasksListState
import centraid.screen.v1.TasksProjectEvent
import dev.centraid.shared.kit.tasks.TasksRows
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.ScreenIds
import dev.centraid.shared.nav.ScreenMove
import dev.centraid.shared.nav.ScreenMoves

/**
 * WHERE AGENDA'S INTENTS GO, ONCE (#1046, #1128).
 *
 * `EventPicked`, `NewEventRequested` and the detail's `ActionPicked{edit}`
 * change nothing in their machines; the shell pushes. So do the task intents
 * (R-1128-5): a task or project picked on Day, Schedule or To-do (a project
 * also as a search's container, Q-1128-1), the Overdue group's and the
 * notice's "Reschedule", a Tasks place in More, and a row
 * picked on the pushed Tasks pages (a list, a project, Catch up, a task's
 * subtask or parent). WHICH page lives here: Android pushes the [Destination]
 * (opening the bridge on the push), and iOS asks [route] for the same push
 * spelled. A new event lands on the home's anchor day (empty is the core's
 * today); an edit on the occurrence the detail holds.
 */
public object AgendaRouting {
    public fun home(event: AgendaHomeEvent, state: AgendaHomeState): Destination? {
        val picked = event.event_picked
        val task = event.task_picked
        val project = event.project_picked
        val more = event.more_row
        return when {
            picked != null && picked.event_id.isNotEmpty() ->
                Destination.AgendaEvent(picked.event_id, picked.instance_key, picked.original_start_local, picked.day)
            event.new_event != null -> Destination.AgendaEditor(day = state.anchor_day)
            task != null -> detailOf(task.task_id)
            project != null && project.project_id.isNotEmpty() -> {
                // THE NAME RIDES ALONG from whichever row was picked: To-do's project row, or a
                // search's project container (Q-1128-1), so the page's head has words before it reads.
                val data = state.data_
                val name = data?.todo?.projects.orEmpty().flatMap { it.rows }
                    .firstOrNull { it.id == project.project_id }?.title
                    ?: data?.containers.orEmpty().firstOrNull { it.id == project.project_id }?.title
                Destination.TasksProject(project.project_id, name.orEmpty())
            }
            more != null -> when (more.key) {
                AgendaHomeMachine.MORE_ANYTIME -> Destination.TasksList(TasksListState.View.VIEW_ANYTIME)
                AgendaHomeMachine.MORE_LOGBOOK -> Destination.TasksList(TasksListState.View.VIEW_LOGBOOK)
                AgendaHomeMachine.MORE_REMINDERS -> Destination.TasksList(TasksListState.View.VIEW_REMINDERS)
                AgendaHomeMachine.MORE_TRASH -> Destination.TasksTrash
                else -> null
            }
            event.group_verb?.key == TasksRows.VERB_CATCH_UP -> Destination.TasksCatchUp
            event.notice_acted != null && state.data_?.notice?.verb_key == TasksRows.VERB_CATCH_UP -> Destination.TasksCatchUp
            else -> null
        }
    }

    public fun event(event: AgendaEventEvent, state: AgendaEventState): Destination? =
        if (event.action?.key == AgendaEventMachine.ACTION_EDIT && state.event_id.isNotEmpty()) {
            Destination.AgendaEditor(state.event_id, state.instance_key, state.original_start_local, state.day)
        } else {
            null
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
     * THE SAME DECISIONS FOR A SHELL THAT SENDS BYTES: [event] is what screen
     * [screenId] just forwarded and [state] is that screen's own state. Null
     * for an event that routes nowhere, a screen that is neither Agenda's nor a
     * Tasks page's, or bytes that do not decode. Every answer is a push.
     */
    public fun route(screenId: String, event: ByteArray, state: ByteArray): ScreenMove? {
        val destination = runCatching {
            when (screenId) {
                AgendaHomeMachine.SCREEN_ID -> home(AgendaHomeEvent.ADAPTER.decode(event), AgendaHomeState.ADAPTER.decode(state))
                AgendaEventMachine.SCREEN_ID -> event(AgendaEventEvent.ADAPTER.decode(event), AgendaEventState.ADAPTER.decode(state))
                ScreenIds.TASKS_LIST -> list(TasksListEvent.ADAPTER.decode(event))
                ScreenIds.TASKS_PROJECT -> project(TasksProjectEvent.ADAPTER.decode(event))
                ScreenIds.TASKS_CATCH_UP -> catchUp(TasksCatchUpEvent.ADAPTER.decode(event))
                ScreenIds.TASKS_DETAIL -> detail(TasksDetailEvent.ADAPTER.decode(event), TasksDetailState.ADAPTER.decode(state))
                else -> null
            }
        }.getOrNull()
        return ScreenMoves.push(destination)
    }

    /** A task with no id names nothing, so it opens nothing. */
    private fun detailOf(taskId: String): Destination? =
        if (taskId.isEmpty()) null else Destination.TasksDetail(taskId)
}
