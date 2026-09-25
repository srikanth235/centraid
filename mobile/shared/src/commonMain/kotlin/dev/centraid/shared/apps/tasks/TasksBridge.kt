package dev.centraid.shared.apps.tasks

import centraid.screen.v1.TasksCatchUpEvent
import centraid.screen.v1.TasksCatchUpState
import centraid.screen.v1.TasksDetailEvent
import centraid.screen.v1.TasksDetailState
import centraid.screen.v1.TasksHomeEvent
import centraid.screen.v1.TasksHomeState
import centraid.screen.v1.TasksListEvent
import centraid.screen.v1.TasksListState
import centraid.screen.v1.TasksProjectEvent
import centraid.screen.v1.TasksProjectState
import com.squareup.wire.Message
import com.squareup.wire.ProtoAdapter
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/**
 * WHAT BOTH SHELLS HOLD FOR ONE TASKS SCREEN (#1029 port).
 *
 * The kit's `ScreenBridge` contract — bytes across to SwiftUI, nothing
 * `suspend`, [leave] is close = done and [departed] its lifetime-bridge twin —
 * for a screen whose machine state is NOT its proto message. A Tasks machine
 * holds the core's raw typed answers beside the state a view draws (so a
 * local change re-folds without a read), and `screen.proto` cannot carry them
 * (`AgendaHomeState`'s reason), so the kit bridge's `S : Message` does not fit
 * and only [screenOf] of the machine's state ever leaves. `AgendaBridge` is
 * the same shape, written once more there.
 *
 * [input] is where a view's event becomes the machine's: the home and
 * project quick adds mint their task's id HERE, because a reducer is pure and
 * `add_task` honours a phone-minted UUID (so the row the member sees is the
 * row the vault keeps).
 */
public open class TasksBridge<W, I, S : Message<S, *>, E : Message<E, *>>(
    machine: ScreenMachine<W, I>,
    private val screenOf: (W) -> S,
    private val events: ProtoAdapter<E>,
    private val input: (E) -> I,
    private val wire: (HomeSession, ScreenHost<W, I>, () -> Boolean) -> Unit,
    dispatcher: CoroutineDispatcher = Dispatchers.Main,
) {
    /** The host; Android drives it directly. One per bridge, never re-created. */
    public val host: ScreenHost<W, I> = ScreenHost(machine)

    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private var onState: ((ByteArray) -> Unit)? = null
    private var outliving: CoroutineScope? = null

    @kotlin.concurrent.Volatile
    private var hasLeft: Boolean = false

    /** Put this screen on the session's core. Once per bridge. */
    public fun attach(session: HomeSession) {
        outliving = session.outliving
        wire(session, host) { hasLeft }
        scope.launch {
            host.state.map { screenOf(it) }.distinctUntilChanged().collect { onState?.invoke(it.encode()) }
        }
    }

    /** The screen a view draws, now (Compose). */
    public val screen: S get() = screenOf(host.state.value)

    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        onState(screen.encode())
    }

    /** Forward one encoded event (SwiftUI). */
    public fun send(event: ByteArray) {
        forward(events.decode(event))
    }

    /** Forward one event (Compose). */
    public fun forward(event: E) {
        hasLeft = false
        val mapped = input(event)
        scope.launch { host.send(mapped) }
    }

    public fun current(): ByteArray = screen.encode()

    /** CLOSE = DONE: the machine's leave event on the session's scope, then release. */
    public fun leave() {
        departed()
        close()
    }

    /** The screen closed and the bridge stays: flush, keep the scope. */
    public fun departed() {
        hasLeft = true
        val event = host.machine.left() ?: return
        outliving?.launch(start = CoroutineStart.UNDISPATCHED) { host.send(event) }
    }

    public fun close() {
        scope.cancel()
    }

    public companion object {
        /** A fresh task id: a v4 UUID, the shape `add_task` honours. */
        @OptIn(ExperimentalUuidApi::class)
        public fun mintTaskId(): String = Uuid.random().toString()
    }
}

/**
 * `tasks.home`. The no-argument constructor mints quick-add ids itself — the
 * one a shell uses (Kotlin's default arguments do not reach Swift); [mint] is
 * a spec's seam.
 */
public class TasksHomeBridge(mint: () -> String) :
    TasksBridge<TasksHome, TasksHomeInput, TasksHomeState, TasksHomeEvent>(
        machine = TasksHomeMachine,
        screenOf = { it.screen },
        events = TasksHomeEvent.ADAPTER,
        input = { event ->
            if (event.quick_add_submitted != null) TasksHomeInput.Add(mint()) else TasksHomeInput.View(event)
        },
        wire = { session, host, left -> session.attachQueries(host, TasksHomeReads, TasksHomeReads, left = left) },
    ) {
    public constructor() : this({ TasksBridge.mintTaskId() })

    /** Land on Today: the one call a shell makes to open Tasks. */
    public fun open() {
        open(TasksHomeState.Destination.DESTINATION_TODAY)
    }

    /** Land on [destination]. */
    public fun open(destination: TasksHomeState.Destination) {
        forward(TasksHomeEvent(opened = TasksHomeEvent.Opened(destination = destination)))
    }

    /**
     * NOTES' "SEND TO TASKS": land on the Inbox with [text] waiting in the
     * quick add, focused. Nothing is written until the member adds it.
     */
    public fun openQuickAdd(text: String) {
        forward(
            TasksHomeEvent(
                opened = TasksHomeEvent.Opened(
                    destination = TasksHomeState.Destination.DESTINATION_INBOX,
                    quick_add_title = text,
                ),
            ),
        )
    }
}

/** `tasks.list`: Anytime, All, Logbook, Reminders. */
public class TasksListBridge :
    TasksBridge<TasksList, TasksListInput, TasksListState, TasksListEvent>(
        machine = TasksListMachine,
        screenOf = { it.screen },
        events = TasksListEvent.ADAPTER,
        input = { TasksListInput.View(it) },
        wire = { session, host, left -> session.attachQueries(host, TasksListReads, TasksListReads, left = left) },
    ) {
    public fun open(view: TasksListState.View) {
        forward(TasksListEvent(opened = TasksListEvent.Opened(view = view)))
    }
}

/** `tasks.project`. The no-argument constructor mints ([TasksHomeBridge]'s reason). */
public class TasksProjectBridge(mint: () -> String) :
    TasksBridge<TasksProjectPage, TasksProjectInput, TasksProjectState, TasksProjectEvent>(
        machine = TasksProjectMachine,
        screenOf = { it.screen },
        events = TasksProjectEvent.ADAPTER,
        input = { event ->
            if (event.quick_add_submitted != null) TasksProjectInput.Add(mint()) else TasksProjectInput.View(event)
        },
        wire = { session, host, left -> session.attachQueries(host, TasksProjectReads, TasksProjectReads, left = left) },
    ) {
    public constructor() : this({ TasksBridge.mintTaskId() })

    public fun open(projectId: String) {
        open(projectId, "")
    }

    /** [title] rides along from the route, so the head names the project at once. */
    public fun open(projectId: String, title: String) {
        forward(TasksProjectEvent(opened = TasksProjectEvent.Opened(project_id = projectId, title = title)))
    }
}

/** `tasks.detail`. Closing it is [leave] (or [departed]): close = done. */
public class TasksDetailBridge :
    TasksBridge<TasksDetail, TasksDetailInput, TasksDetailState, TasksDetailEvent>(
        machine = TasksDetailMachine,
        screenOf = { it.screen },
        events = TasksDetailEvent.ADAPTER,
        input = { TasksDetailInput.View(it) },
        wire = { session, host, left -> session.attachQueries(host, TasksDetailReads, TasksDetailReads, left = left) },
    ) {
    public fun open(taskId: String) {
        forward(TasksDetailEvent(opened = TasksDetailEvent.Opened(task_id = taskId)))
    }
}

/** `tasks.catch_up`. */
public class TasksCatchUpBridge :
    TasksBridge<TasksCatchUpPage, TasksCatchUpInput, TasksCatchUpState, TasksCatchUpEvent>(
        machine = TasksCatchUpMachine,
        screenOf = { it.screen },
        events = TasksCatchUpEvent.ADAPTER,
        input = { TasksCatchUpInput.View(it) },
        wire = { session, host, left -> session.attachQueries(host, TasksCatchUpReads, TasksCatchUpReads, left = left) },
    ) {
    public fun open() {
        forward(TasksCatchUpEvent(opened = TasksCatchUpEvent.Opened()))
    }
}
