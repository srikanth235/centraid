package dev.centraid.shared.apps.agenda

import centraid.screen.v1.AgendaHomeEvent
import centraid.screen.v1.AgendaHomeState
import dev.centraid.shared.kit.tasks.TaskOpsLaw
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * WHAT BOTH SHELLS HOLD FOR AGENDA'S HOME (#1046).
 *
 * The retired Tally bridge's shape, for its reasons — bytes and not objects across to
 * SwiftUI, and nothing `suspend` — with one difference: the machine's state is
 * [AgendaHome], which carries the raw answers beside the screen, and only
 * [AgendaHome.screen] ever leaves. So Compose reads [screen] (or
 * `host.state.value.screen`), and SwiftUI decodes the `AgendaHomeState` bytes
 * [observe] publishes.
 *
 * ## One call to open it
 *
 * A shell pushes `Destination.AgendaHome` and calls [open] with its band
 * destination — from the Agenda tile, the all-apps row or a first move. Every
 * open lands on today with search closed; the calendars hidden this session
 * stay hidden.
 *
 * ## Intents
 *
 * `NewEventRequested` and `EventPicked` change nothing here; a shell that
 * routes them reads them off the event it forwards — `EventPicked` to
 * `AgendaEventBridge.open`, `NewEventRequested` to `AgendaEditorBridge.openNew`
 * with [screen]'s `anchor_day`. The task intents (`TaskPicked`, `ProjectPicked`,
 * `GroupVerb`, `NoticeActed`, a Tasks More row) route through `AgendaRouting`
 * (R-1128-5).
 *
 * ## The quick add mints its id here
 *
 * To-do's `QuickAddSubmitted` becomes [AgendaInput.Add] with a fresh task id,
 * because a reducer is pure and `add_task` honours a phone-minted UUID (so the
 * row the member sees is the row the vault keeps).
 *
 * ## Held writes
 *
 * Construct all three Agenda bridges with ONE [AgendaMarks]: the rows'
 * "pending" and "cancellation asked" chips come from it.
 */
public class AgendaBridge(
    /** The session's held writes — the SAME one the event and editor bridges hold. */
    private val marks: AgendaMarks,
    /** Mints a quick add's task id; a spec's seam. */
    private val mint: () -> String,
) {
    /**
     * The one a shell uses (Kotlin's default arguments do not reach Swift):
     * quick-add ids are minted here.
     */
    public constructor(marks: AgendaMarks = AgendaMarks()) : this(marks, { TaskOpsLaw.mintId() })

    /**
     * The host. One per bridge and never re-created: `ChangeStream.route`
     * registers it for the life of the session.
     */
    public val host: ScreenHost<AgendaHome, AgendaInput> = ScreenHost(AgendaHomeMachine)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var onState: ((ByteArray) -> Unit)? = null

    /**
     * Put this screen on the session's core, and start publishing. Once per
     * bridge: `attachQueries` routes the host onto the change stream, and a
     * second route would re-read twice on every commit.
     */
    public fun attach(session: HomeSession) {
        session.attachQueries(host, AgendaReads, AgendaReads)
        scope.launch {
            marks.held.collect { held ->
                host.send(AgendaInput.Marks(AgendaMarks.pendingIds(held), AgendaMarks.cancelIds(held)))
            }
        }
        scope.launch {
            host.state.map { it.screen }.distinctUntilChanged().collect { screen ->
                onState?.invoke(screen.encode())
            }
        }
    }

    /** The screen a view draws, now. */
    public val screen: AgendaHomeState get() = host.state.value.screen

    /** Publish every screen state to [onState], starting with the current one. */
    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        onState(screen.encode())
    }

    /** Land on [destination] at today: the one call a shell makes to open Agenda. */
    public fun open(
        destination: AgendaHomeState.Destination = AgendaHomeState.Destination.DESTINATION_DAY,
    ) {
        forward(AgendaHomeEvent(opened = AgendaHomeEvent.Opened(destination = destination)))
    }

    /**
     * NOTES' "SEND TO AGENDA": land on [destination] (To-do) with [text] waiting
     * in the quick add, focused. Nothing is written until the member adds it.
     */
    public fun open(destination: AgendaHomeState.Destination, quickAdd: String) {
        forward(
            AgendaHomeEvent(
                opened = AgendaHomeEvent.Opened(destination = destination, quick_add_title = quickAdd),
            ),
        )
    }

    /** Forward one event, encoded (SwiftUI). */
    public fun send(event: ByteArray) {
        forward(AgendaHomeEvent.ADAPTER.decode(event))
    }

    /** Forward one event (Compose). Named apart from [send] so Swift sees one `send(event:)`. */
    public fun forward(event: AgendaHomeEvent) {
        val input = if (event.quick_add_submitted != null) AgendaInput.Add(mint()) else AgendaInput.View(event)
        scope.launch { host.send(input) }
    }

    /** The current screen state, encoded, for a view that needs one before it subscribes. */
    public fun current(): ByteArray = screen.encode()

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        scope.cancel()
    }
}
