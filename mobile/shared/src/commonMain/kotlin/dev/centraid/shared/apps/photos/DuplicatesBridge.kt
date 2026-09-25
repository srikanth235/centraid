package dev.centraid.shared.apps.photos

import centraid.screen.v1.DuplicatesEvent
import centraid.screen.v1.DuplicatesState
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * What SwiftUI holds instead of the duplicates shelf's `StateFlow`
 * (#1029, photos port).
 *
 * `PhotosBridge`'s shape, for the same reasons, and they are worth restating
 * because both are load-bearing at this boundary:
 *
 * * **BYTES, NOT OBJECTS.** The state crosses as an encoded `DuplicatesState`
 *   and the event arrives as an encoded `DuplicatesEvent`; Swift decodes it
 *   with SwiftProtobuf from the same schema Wire reads here, so one fixture
 *   proves both sides. Handing Swift a Kotlin object would put an Objective-C
 *   bridging layer between the shells and give the contract two shapes.
 * * **NOT `suspend`.** A SwiftUI button cannot await, and a view that could
 *   await a reducer would be a view holding the main thread while a screen
 *   thinks. The launch is what keeps [send]'s ordering — one coroutine, one
 *   queue — without the caller knowing there is one.
 *
 * Android does NOT use this: Compose collects [host]'s `StateFlow` directly,
 * because on that side it already is the right shape.
 *
 * **NO `ScreenWrites`.** This shelf lists clusters and writes nothing; the one
 * write in this pair belongs to `photos.duplicate`, where the member can see
 * which copy they are keeping. v0 put a Trash verb on the shelf itself
 * (`DuplicatesShelf.tsx:132-150`) and it is not ported.
 */
public class DuplicatesBridge {
    /**
     * The host, exposed because Android drives it directly.
     *
     * One per bridge and never re-created: `ChangeStream.route` registers a
     * host for the life of the session, so a second host would leave the routed
     * one drawing into nothing.
     */
    public val host: ScreenHost<DuplicatesState, DuplicatesEvent> =
        ScreenHost(DuplicatesMachine)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var onState: ((ByteArray) -> Unit)? = null

    /**
     * Put this screen on the session's core, and start publishing.
     *
     * The attach is the session's ([HomeSession.attachScreen]) because the core
     * is: R-1020-24 is one core per process, so a bridge that opened its own
     * would be refused by `SingleHandleGuard`.
     */
    public fun attach(session: HomeSession) {
        // THE FOLD, AND THE ONE THING THAT ROUTES SYNC. `attachScreen` does two
        // jobs — serve this screen's `ReadPage` effects, and `changes.route`
        // the host so a vault change moves the shelf without a tap.
        session.attachScreen(host, DuplicatesReads)
        // THE SECOND STATEMENT, THROUGH `attachReads` AND NOT A SECOND
        // `attachScreen`. The route is registration with no removal by design,
        // so a host routed twice answers every change event with two re-reads
        // for ever — which on this screen is two full folds of five hundred
        // fingerprints. `HomeSession.attachReads`' own note carries the
        // argument; this is the call it exists for.
        DuplicatesMachine.Leg.entries.forEach { leg ->
            session.attachReads(host, DuplicatesLeg(leg))
        }
        scope.launch { host.state.collect { state -> onState?.invoke(state.encode()) } }
    }

    /** The shelf is on screen — read the fold. */
    public fun opened() {
        scope.launch { host.send(DuplicatesEvent(opened = DuplicatesEvent.Opened())) }
    }

    /** Publish every state to [onState], starting with the current one. */
    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        // The FIRST state, immediately. A view that subscribed and then waited
        // for a change would draw nothing at all until a read landed.
        onState(host.state.value.encode())
    }

    /** Forward one encoded event. */
    public fun send(event: ByteArray) {
        scope.launch { host.send(DuplicatesEvent.ADAPTER.decode(event)) }
    }

    /** The current state, for a view that needs one before it subscribes. */
    public fun current(): ByteArray = host.state.value.encode()

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        scope.cancel()
    }
}
