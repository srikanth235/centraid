package dev.centraid.shared.apps.agenda

import centraid.screen.v1.AgendaEditorEvent
import centraid.screen.v1.AgendaEditorState
import centraid.screen.v1.AgendaEventEvent
import centraid.screen.v1.AgendaEventState
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * WHAT BOTH SHELLS HOLD FOR `agenda.event` (#1046 wave 4).
 *
 * `AgendaBridge`'s shape and for its reason — the machine's state carries the
 * raw answer beside the screen, so only [screen] leaves (bytes to SwiftUI,
 * `host.state.value.screen` to Compose). Give it the SAME [marks] the home's
 * and the editor's bridges hold: that is how the home's chips and the parked
 * card see a write this screen left behind.
 *
 * ## Routing
 *
 * - Open: push `Destination.AgendaEvent` and call [open] with `EventPicked`'s
 *   fields.
 * - `ActionPicked{edit}`: push `Destination.AgendaEditor` for this occurrence
 *   (the ids are on [screen]).
 * - `AgendaEventState.dismissed`, or the gone state's action: pop.
 */
public class AgendaEventBridge(
    private val marks: AgendaMarks = AgendaMarks(),
) {
    public val host: ScreenHost<AgendaEventScreen, AgendaEventInput> = ScreenHost(AgendaEventMachine)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var onState: ((ByteArray) -> Unit)? = null

    @kotlin.concurrent.Volatile
    private var hasLeft: Boolean = false

    /** Put this screen on the session's core. Once per bridge. */
    public fun attach(session: HomeSession) {
        session.attachQueries(host, AgendaEventReads(marks), AgendaEventReads(marks), left = { hasLeft })
        feedMarks(session.outliving, host.effects, marks)
        scope.launch { marks.held.collect { host.send(AgendaEventInput.Held(it)) } }
        scope.launch {
            host.state.map { it.screen }.distinctUntilChanged().collect { onState?.invoke(it.encode()) }
        }
    }

    public val screen: AgendaEventState get() = host.state.value.screen

    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        onState(screen.encode())
    }

    /** Open on one occurrence — `EventPicked`'s fields. */
    public fun open(eventId: String, instanceKey: String, originalStartLocal: String?, day: String) {
        forward(
            AgendaEventEvent(
                opened = AgendaEventEvent.Opened(
                    event_id = eventId,
                    instance_key = instanceKey,
                    original_start_local = originalStartLocal,
                    day = day,
                ),
            ),
        )
    }

    public fun send(event: ByteArray) {
        forward(AgendaEventEvent.ADAPTER.decode(event))
    }

    public fun forward(event: AgendaEventEvent) {
        hasLeft = false
        // A DISMISSED PARKED CARD is the session's to forget, not this screen's.
        if (event.parked_dismissed != null) marks.dismissed(screen.event_id)
        scope.launch { host.send(AgendaEventInput.View(event)) }
    }

    public fun current(): ByteArray = screen.encode()

    /** The screen closed; a write in flight still settles into [marks]. */
    public fun departed() {
        hasLeft = true
    }

    public fun close() {
        hasLeft = true
        scope.cancel()
    }
}

/**
 * WHAT BOTH SHELLS HOLD FOR `agenda.editor` (#1046 wave 5). [AgendaEventBridge]'s
 * shape, with the same [marks].
 *
 * ## Routing
 *
 * - New event: push `Destination.AgendaEditor()` and call [openNew] with the
 *   home's `anchor_day`.
 * - Edit: push `Destination.AgendaEditor(eventId, …)` and call [openEdit].
 * - Back or close: forward `LeaveRequested` — never pop directly; the machine
 *   asks first when there are changes.
 * - `AgendaEditorState.dismissed`: pop.
 */
public class AgendaEditorBridge(
    private val marks: AgendaMarks = AgendaMarks(),
) {
    public val host: ScreenHost<AgendaEditorScreen, AgendaEditorInput> = ScreenHost(AgendaEditorMachine)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var onState: ((ByteArray) -> Unit)? = null

    @kotlin.concurrent.Volatile
    private var hasLeft: Boolean = false

    public fun attach(session: HomeSession) {
        session.attachQueries(host, AgendaEditorReads(marks), AgendaEditorReads(marks), left = { hasLeft })
        feedMarks(session.outliving, host.effects, marks)
        scope.launch {
            host.state.map { it.screen }.distinctUntilChanged().collect { onState?.invoke(it.encode()) }
        }
    }

    public val screen: AgendaEditorState get() = host.state.value.screen

    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        onState(screen.encode())
    }

    /** A new event on [day] (`YYYY-MM-DD`, the home's anchor; empty is the core's today). */
    public fun openNew(day: String) {
        forward(
            AgendaEditorEvent(
                opened = AgendaEditorEvent.Opened(mode = AgendaEditorState.Mode.MODE_CREATE, day = day),
            ),
        )
    }

    /** Edit one occurrence — the ids `AgendaEventState` carries. */
    public fun openEdit(eventId: String, instanceKey: String, originalStartLocal: String?, day: String) {
        forward(
            AgendaEditorEvent(
                opened = AgendaEditorEvent.Opened(
                    mode = AgendaEditorState.Mode.MODE_EDIT,
                    event_id = eventId,
                    instance_key = instanceKey,
                    original_start_local = originalStartLocal,
                    day = day,
                ),
            ),
        )
    }

    public fun send(event: ByteArray) {
        forward(AgendaEditorEvent.ADAPTER.decode(event))
    }

    public fun forward(event: AgendaEditorEvent) {
        hasLeft = false
        scope.launch { host.send(AgendaEditorInput.View(event)) }
    }

    public fun current(): ByteArray = screen.encode()

    public fun departed() {
        hasLeft = true
    }

    public fun close() {
        hasLeft = true
        scope.cancel()
    }
}

/**
 * EVERY AGENDA WRITE A SCREEN EMITS, INTO THE SESSION'S [marks] — collected on
 * the session's scope, started UNDISPATCHED so the first effect is not missed,
 * and outliving the bridge, as the write itself does.
 */
internal fun feedMarks(
    on: CoroutineScope,
    effects: kotlinx.coroutines.flow.SharedFlow<ScreenEffect>,
    marks: AgendaMarks,
) {
    on.launch(start = CoroutineStart.UNDISPATCHED) {
        effects.collect { effect -> if (effect is ScreenEffect.SubmitWrite) marks.submitted(effect) }
    }
}
