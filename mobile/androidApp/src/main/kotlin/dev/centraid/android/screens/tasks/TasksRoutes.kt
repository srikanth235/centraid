package dev.centraid.android.screens.tasks

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.TasksCatchUpEvent
import centraid.screen.v1.TasksDetailEvent
import centraid.screen.v1.TasksHomeEvent
import centraid.screen.v1.TasksHomeState
import centraid.screen.v1.TasksListState
import centraid.screen.v1.TasksProjectEvent
import dev.centraid.android.kit.TrashListScreen
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.RouteNav
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.apps.tasks.TasksCatchUpBridge
import dev.centraid.shared.apps.tasks.TasksDetailBridge
import dev.centraid.shared.apps.tasks.TasksHomeBridge
import dev.centraid.shared.apps.tasks.TasksHomeMachine
import dev.centraid.shared.apps.tasks.TasksListBridge
import dev.centraid.shared.apps.tasks.TasksProjectBridge
import dev.centraid.shared.apps.tasks.TasksRows
import dev.centraid.shared.apps.tasks.TasksTrashBridge
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.nav.withTasksDestination
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope

/**
 * TASKS' ROUTES (#1029 port). One bridge per screen, held for the activity.
 * The machines emit intents (a row picked, a More row, Catch up) and route
 * nowhere; this file is where they become pushes. A pushed page opens its
 * bridge when its destination arrives (keyed on the destination's
 * parameters), so a pop back onto an earlier task re-opens that task.
 */
public class TasksRoutes : AppRoutes {
    private val home = TasksHomeBridge()
    private val list = TasksListBridge()
    private val project = TasksProjectBridge()
    private val detail = TasksDetailBridge()
    private val catchUp = TasksCatchUpBridge()
    private val trash = TasksTrashBridge()

    override fun handles(destination: Destination): Boolean = when (destination) {
        is Destination.TasksHome,
        is Destination.TasksList,
        is Destination.TasksProject,
        is Destination.TasksDetail,
        Destination.TasksCatchUp,
        Destination.TasksTrash,
        -> true
        else -> false
    }

    // `open()` ON THE PUSH: a band move swaps the top entry and must not land on Today.
    override fun opens(moveId: String): Destination? = if (moveId == "tasks") {
        home.open()
        Destination.TasksHome()
    } else {
        null
    }

    override fun attach(session: HomeSession, scope: CoroutineScope) {
        home.attach(session)
        list.attach(session)
        project.attach(session)
        detail.attach(session)
        catchUp.attach(session)
        trash.attach(session)
    }

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
        when (destination) {
            is Destination.TasksHome -> HomeRoute(destination, nav)
            is Destination.TasksList -> ListRoute(destination, nav)
            is Destination.TasksProject -> ProjectRoute(destination, nav)
            is Destination.TasksDetail -> DetailRoute(destination, nav)
            Destination.TasksCatchUp -> CatchUpRoute(nav)
            Destination.TasksTrash -> TrashRoute(nav)
            else -> Unit
        }
    }

    private fun pushDetail(nav: RouteNav, taskId: String) {
        if (taskId.isNotEmpty()) nav.go(nav.stack.push(Destination.TasksDetail(taskId)))
    }

    @Composable
    private fun HomeRoute(destination: Destination.TasksHome, nav: RouteNav) {
        var stack by nav
        val state by home.host.state.collectAsStateWithLifecycle()
        val screen = state.screen
        // NOTES' "SEND TO TASKS" arrives as words on the destination: they go
        // to the bridge ONCE, then leave the entry, so a pop back onto this
        // home never seeds the quick add a second time.
        LaunchedEffect(destination.quickAdd) {
            val words = destination.quickAdd
            if (words.isNotEmpty() && stack.current == destination) {
                home.openQuickAdd(words)
                stack = NavStack(stack.entries.dropLast(1) + destination.copy(quickAdd = ""))
            }
        }
        // THE ROUTE FOLLOWS THE MACHINE: a band tab is a parameter swap.
        LaunchedEffect(screen.destination) {
            val band = screen.destination
            if (band != TasksHomeState.Destination.DESTINATION_UNSPECIFIED && band != destination.destination) {
                stack = stack.withTasksDestination(band)
            }
        }
        TasksHomeScreen(
            state = screen,
            onEvent = { event ->
                home.forward(event)
                routeHome(event, screen, nav)
            },
            onHome = { nav.home() },
        )
    }

    /** Home's intents, as pushes. The event reached the machine first (it closes its sheet). */
    private fun routeHome(event: TasksHomeEvent, screen: TasksHomeState, nav: RouteNav) {
        val picked = event.row_picked
        val projectPicked = event.project_picked
        val more = event.more_row
        when {
            picked != null -> pushDetail(nav, picked.task_id)
            projectPicked != null -> {
                val name = screen.data_?.projects.orEmpty().flatMap { it.rows }.firstOrNull { it.id == projectPicked.project_id }?.title.orEmpty()
                nav.go(nav.stack.push(Destination.TasksProject(projectPicked.project_id, name)))
            }
            more != null -> when (more.key) {
                TasksHomeMachine.MORE_ANYTIME -> nav.go(nav.stack.push(Destination.TasksList(TasksListState.View.VIEW_ANYTIME)))
                TasksHomeMachine.MORE_ALL -> nav.go(nav.stack.push(Destination.TasksList(TasksListState.View.VIEW_ALL)))
                TasksHomeMachine.MORE_LOGBOOK -> nav.go(nav.stack.push(Destination.TasksList(TasksListState.View.VIEW_LOGBOOK)))
                TasksHomeMachine.MORE_REMINDERS -> nav.go(nav.stack.push(Destination.TasksList(TasksListState.View.VIEW_REMINDERS)))
                TasksHomeMachine.MORE_CATCH_UP -> nav.go(nav.stack.push(Destination.TasksCatchUp))
                TasksHomeMachine.MORE_TRASH -> nav.go(nav.stack.push(Destination.TasksTrash))
                else -> Unit
            }
            event.group_verb?.key == TasksRows.VERB_CATCH_UP -> nav.go(nav.stack.push(Destination.TasksCatchUp))
            event.notice_acted != null && screen.data_?.notice?.verb_key == TasksRows.VERB_CATCH_UP ->
                nav.go(nav.stack.push(Destination.TasksCatchUp))
        }
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
                event.row_picked?.let { pushDetail(nav, it.task_id) }
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
                event.row_picked?.let { pushDetail(nav, it.task_id) }
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
                event.subtask_picked?.let { pushDetail(nav, it.task_id) }
                if (event.parent_picked != null) pushDetail(nav, screen.data_?.parent_task_id.orEmpty())
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
                event.row_picked?.let { pushDetail(nav, it.task_id) }
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
