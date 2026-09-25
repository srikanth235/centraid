package dev.centraid.shared.kit

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
import kotlinx.coroutines.launch

/**
 * WHAT SWIFTUI HOLDS INSTEAD OF A SCREEN'S `StateFlow` — once, for every screen
 * whose state is its own proto message (was sixteen copies differing only in
 * type names and the attach line).
 *
 * * **BYTES, NOT OBJECTS.** The state crosses encoded and the event arrives
 *   encoded; Swift decodes with SwiftProtobuf from the same schema Wire reads,
 *   so one fixture proves both sides.
 * * **NOT `suspend`.** A SwiftUI button cannot await; the launch keeps `send`'s
 *   ordering — one scope, one queue — without the caller knowing there is one.
 *
 * Android drives [host] directly. Each app names a subclass
 * (`class NotesBridge : ScreenBridge<…>(…)`) so the Swift symbol stays the
 * app's, and so a bridge that names a screen's types lives in that app's
 * package (`PerAppLayoutSpec`'s second rule). [wire] is the one line that
 * differs: `attachScreen`, `attachQueries` or `attachReads`.
 *
 * ## Leaving is not closing
 *
 * [leave] is close = done (#1015 D3): it sends the machine's [ScreenMachine.left]
 * event on the SESSION's scope, then releases this bridge's. The write that
 * event emits runs on the session's scope too (the runtime is the session's),
 * so the flush outlives the bridge — and a flush that then fails has no screen
 * to say so on, which is what `HomeSession.strandedWrites` is for.
 */
public open class ScreenBridge<S : Message<S, *>, E : Message<E, *>>(
    machine: ScreenMachine<S, E>,
    private val events: ProtoAdapter<E>,
    private val wire: (Wiring<S, E>) -> Unit,
    dispatcher: CoroutineDispatcher = Dispatchers.Main,
) {
    /** What an app's attach line is handed. [left] goes to `attachScreen`/`attachQueries`. */
    public class Wiring<S, E> internal constructor(
        public val session: HomeSession,
        public val host: ScreenHost<S, E>,
        public val left: () -> Boolean,
    )

    /**
     * The host, exposed because Android drives it directly. One per bridge and
     * never re-created: `ChangeStream.route` registers it for the session's
     * life, and a second host would leave the routed one drawing into nothing.
     */
    public val host: ScreenHost<S, E> = ScreenHost(machine)

    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private var onState: ((ByteArray) -> Unit)? = null
    private var outliving: CoroutineScope? = null
    @kotlin.concurrent.Volatile
    private var hasLeft: Boolean = false

    /**
     * Put this screen on the session's core, and start publishing. Once per
     * bridge: the attach routes the host onto the change stream, and a second
     * route would re-read twice on every commit.
     */
    public fun attach(session: HomeSession) {
        attachOn(session.outliving) { wire(Wiring(session, host) { hasLeft }) }
    }

    /** [attach] without a session: the seam a spec wires a runtime through. */
    internal fun attachOn(outliving: CoroutineScope, wireUp: () -> Unit) {
        this.outliving = outliving
        wireUp()
        scope.launch { host.state.collect { state -> onState?.invoke(state.encode()) } }
    }

    /** Whether [leave] has run. */
    internal val left: Boolean get() = hasLeft

    /** Publish every state to [onState], starting with the current one. */
    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        // The FIRST state, immediately. A view that subscribed and then waited
        // for a change would draw nothing at all until a read landed.
        onState(host.state.value.encode())
    }

    /** Forward one encoded event (SwiftUI). */
    public fun send(event: ByteArray) {
        forward(events.decode(event))
    }

    /** Forward one event (Compose). Named apart from [send] so Swift sees one `send(event:)`. */
    public fun forward(event: E) {
        // A member sending events is on the screen again.
        hasLeft = false
        scope.launch { host.send(event) }
    }

    /** The current state, for a view that needs one before it subscribes. */
    public fun current(): ByteArray = host.state.value.encode()

    /**
     * CLOSE = DONE. The machine's `Left` event is sent on the session's scope,
     * started UNDISPATCHED so it is under way before this returns, and then
     * this bridge's scope is released. A bridge never attached has no session,
     * nothing to flush through, and simply closes.
     */
    public fun leave() {
        departed()
        close()
    }

    /**
     * THE SCREEN CLOSED, THE BRIDGE STAYS: [leave] for a bridge the shell
     * keeps for the app's lifetime (both shells hold Tally's and Notes' that
     * way today). The flush is the same; the scope is not released, and the
     * next event forwarded marks the screen as on screen again.
     */
    public fun departed() {
        hasLeft = true
        val event = host.machine.left()
        val on = outliving
        if (event != null && on != null) {
            on.launch(start = CoroutineStart.UNDISPATCHED) { host.send(event) }
        }
    }

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        scope.cancel()
    }
}
