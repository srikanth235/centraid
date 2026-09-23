package dev.centraid.shared.apps.photos

import centraid.screen.v1.DuplicateReviewEvent
import centraid.screen.v1.DuplicateReviewState
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * What SwiftUI holds instead of one cluster's review `StateFlow`
 * (#1029, photos port).
 *
 * `PhotosBridge`'s shape, for the same reasons, and they are worth restating
 * because both are load-bearing at this boundary:
 *
 * * **BYTES, NOT OBJECTS.** The state crosses as an encoded
 *   `DuplicateReviewState` and the event arrives as an encoded
 *   `DuplicateReviewEvent`; Swift decodes it with SwiftProtobuf from the same
 *   schema Wire reads here, so one fixture proves both sides. Handing Swift a
 *   Kotlin object would put an Objective-C bridging layer between the shells
 *   and give the contract two shapes.
 * * **NOT `suspend`.** A SwiftUI button cannot await, and a view that could
 *   await a reducer would be a view holding the main thread while a screen
 *   thinks. The launch is what keeps [send]'s ordering — one coroutine, one
 *   queue — without the caller knowing there is one.
 *
 * Android does NOT use this: Compose collects [host]'s `StateFlow` directly,
 * because on that side it already is the right shape.
 *
 * **THIS SCREEN WRITES**, so the attach passes [DuplicateReviewReads] on both
 * doors. Its write is `media.delete_asset`, one per copy the member did not
 * keep, and `ScreenRuntime` is what refuses it on a vault that has MOVED to the
 * member's other phone (#1029 F1) — a read-only vault trashes nothing.
 */
public class DuplicateReviewBridge {
    /**
     * The host, exposed because Android drives it directly.
     *
     * One per bridge and never re-created: `ChangeStream.route` registers a
     * host for the life of the session, so a second host would leave the routed
     * one drawing into nothing.
     */
    public val host: ScreenHost<DuplicateReviewState, DuplicateReviewEvent> =
        ScreenHost(DuplicateReviewMachine)

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
        // THE MEMBERS AND THE WRITE, AND THE ONE THING THAT ROUTES SYNC.
        session.attachScreen(host, DuplicateReviewReads, DuplicateReviewReads)
        // THE PLACEMENT LEG, THROUGH `attachReads` AND NOT A SECOND
        // `attachScreen`. The route is registration with no removal by design,
        // so a host routed twice answers every change event with two re-reads
        // for ever — and on this screen the re-reads run under a member who is
        // deciding what to delete.
        DuplicateReviewMachine.Leg.entries.forEach { leg ->
            session.attachReads(host, DuplicateReviewLeg(leg))
        }
        scope.launch { host.state.collect { state -> onState?.invoke(state.encode()) } }
    }

    /**
     * Open one cluster.
     *
     * The id is a PARAMETER of the destination and rides in with the event —
     * `Opened` carries it and the reducer puts it on the state, which is where
     * [DuplicateReviewReads.query] reads it from. A bridge that held the id in
     * a field of its own would be a second place the answer lives, and the two
     * would disagree the first time a member backed out of one cluster into
     * another.
     */
    public fun opened(clusterId: String) {
        scope.launch {
            host.send(
                DuplicateReviewEvent(
                    opened = DuplicateReviewEvent.Opened(cluster_id = clusterId),
                ),
            )
        }
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
        scope.launch { host.send(DuplicateReviewEvent.ADAPTER.decode(event)) }
    }

    /** The current state, for a view that needs one before it subscribes. */
    public fun current(): ByteArray = host.state.value.encode()

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        scope.cancel()
    }
}
