package dev.centraid.android.screens.tasks

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.TasksCatchUpEvent
import centraid.screen.v1.TasksDetailEvent
import centraid.screen.v1.TasksProjectEvent
import dev.centraid.android.kit.TrashListScreen
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.RouteNav
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.apps.agenda.AgendaRouting
import dev.centraid.shared.apps.tasks.TasksCatchUpBridge
import dev.centraid.shared.apps.tasks.TasksDetailBridge
import dev.centraid.shared.apps.tasks.TasksListBridge
import dev.centraid.shared.apps.tasks.TasksProjectBridge
import dev.centraid.shared.apps.tasks.TasksTrashBridge
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope

/**
 * THE TASK PAGES' ROUTES (#1029 port, #1128): the list, a project, the task,
 * Catch up and the trash, each on a bridge held for the activity. Tasks has no
 * home of its own any more — its home is Agenda's To-do place (`AgendaRoutes`)
 * — so these are PUSHED PAGES only, and their back says "Agenda"
 * (`TasksChrome.back`). The machines emit intents (a row picked, a subtask,
 * the parent) and route nowhere; `AgendaRouting` decides which page, for iOS
 * too, and this file is where it becomes a push. A pushed page opens its
 * bridge when its destination arrives (keyed on the destination's
 * parameters), so a pop back onto an earlier task re-opens that task.
 */
public class TasksRoutes : AppRoutes {
    private val list = TasksListBridge()
    private val project = TasksProjectBridge()
    private val detail = TasksDetailBridge()
    private val catchUp = TasksCatchUpBridge()
    private val trash = TasksTrashBridge()

    override fun handles(destination: Destination): Boolean = when (destination) {
        is Destination.TasksList,
        is Destination.TasksProject,
        is Destination.TasksDetail,
        Destination.TasksCatchUp,
        Destination.TasksTrash,
        -> true
        else -> false
    }

    override fun attach(session: HomeSession, scope: CoroutineScope) {
        list.attach(session)
        project.attach(session)
        detail.attach(session)
        catchUp.attach(session)
        trash.attach(session)
    }

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
        when (destination) {
            is Destination.TasksList -> ListRoute(destination, nav)
            is Destination.TasksProject -> ProjectRoute(destination, nav)
            is Destination.TasksDetail -> DetailRoute(destination, nav)
            Destination.TasksCatchUp -> CatchUpRoute(nav)
            Destination.TasksTrash -> TrashRoute(nav)
            else -> Unit
        }
    }

    private fun push(nav: RouteNav, destination: Destination?) {
        if (destination != null) nav.go(nav.stack.push(destination))
    }

    @Composable
    private fun ListRoute(destination: Destination.TasksList, nav: RouteNav) {
        LaunchedEffect(destination.view) {
            if (list.screen.view != destination.view) list.open(destination.view)
        }
        val state by list.host.state.collectAsStateWithLifecycle()
        TasksListScreen(
            state = state.screen,
            onEvent = { event ->
                list.forward(event)
                push(nav, AgendaRouting.list(event))
            },
            onBack = { nav.pop() },
        )
    }

    @Composable
    private fun ProjectRoute(destination: Destination.TasksProject, nav: RouteNav) {
        LaunchedEffect(destination.projectId) {
            if (project.screen.project_id != destination.projectId) project.open(destination.projectId, destination.name)
        }
        val state by project.host.state.collectAsStateWithLifecycle()
        TasksProjectScreen(
            state = state.screen,
            onEvent = { event: TasksProjectEvent ->
                project.forward(event)
                push(nav, AgendaRouting.project(event))
            },
            onBack = { nav.pop() },
        )
    }

    @Composable
    private fun DetailRoute(destination: Destination.TasksDetail, nav: RouteNav) {
        // A POP BACK ONTO A PARENT re-opens it: the one bridge holds one task.
        LaunchedEffect(destination.taskId) {
            if (detail.screen.task_id != destination.taskId || detail.screen.finished) detail.open(destination.taskId)
        }
        val state by detail.host.state.collectAsStateWithLifecycle()
        val screen = state.screen
        // DELETED: the task is gone, so is its page.
        LaunchedEffect(screen.finished) {
            if (screen.finished && screen.task_id == destination.taskId) nav.pop()
        }
        TasksDetailScreen(
            state = screen,
            onEvent = { event: TasksDetailEvent ->
                detail.forward(event)
                push(nav, AgendaRouting.detail(event, screen))
            },
            // CLOSE = DONE: the pop; the room's `onDeparted` is the flush.
            onClose = { nav.pop() },
            onDeparted = { detail.departed() },
        )
    }

    @Composable
    private fun CatchUpRoute(nav: RouteNav) {
        LaunchedEffect(Unit) { catchUp.open() }
        val state by catchUp.host.state.collectAsStateWithLifecycle()
        TasksCatchUpScreen(
            state = state.screen,
            onEvent = { event: TasksCatchUpEvent ->
                catchUp.forward(event)
                push(nav, AgendaRouting.catchUp(event))
            },
            onBack = { nav.pop() },
        )
    }

    @Composable
    private fun TrashRoute(nav: RouteNav) {
        LaunchedEffect(Unit) { trash.open() }
        val state by trash.host.state.collectAsStateWithLifecycle()
        TrashListScreen(
            state = state,
            onEvent = { trash.forward(it) },
            parentTitle = TasksCopy.APP_TITLE,
            onBack = { nav.pop() },
        )
    }
}
