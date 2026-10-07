package dev.centraid.shared.apps.photos

import centraid.screen.v1.PlacesEvent
import centraid.screen.v1.PlacesState
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * What SwiftUI holds instead of the Places screen's `StateFlow` (#1029, photos port).
 *
 * `PhotosBridge`'s shape, for the same two load-bearing reasons: the state
 * crosses as **bytes** so one fixture proves both shells, and [send] is **not
 * `suspend`** so a SwiftUI button never holds the main thread while a reducer
 * thinks. Android does not use this — Compose collects [host]'s `StateFlow`
 * directly, which on that side already is the right shape.
 *
 * ## IT ATTACHES TWO READS, AND ROUTES THE HOST ONCE
 *
 * Places is a join the door will not do, so the machine emits two
 * `ReadPage`s under two screen ids ([PlacesMachine.SCREEN_ID] and
 * [PlacesMachine.ASSETS_SCREEN_ID]) and each needs its own runtime — a runtime
 * serves the one `screenId` its `ScreenReads` names.
 *
 * Only the FIRST goes through [HomeSession.attachScreen], and the second
 * through [HomeSession.attachReads], which is the same thing WITHOUT
 * `changes.route(host)`. That distinction is the whole reason the second method
 * exists: routing is registration with no removal, so a second `attachScreen`
 * for the same host would deliver every vault change twice and double every
 * re-read for ever — a cost no test would show, growing by one multiple per
 * extra pass.
 */
public class PlacesBridge {
    /**
     * The host, exposed because Android drives it directly.
     *
     * One per bridge and never re-created: a routed host lives for the session,
     * so a second would leave the routed one drawing into nothing.
     */
    public val host: ScreenHost<PlacesState, PlacesEvent> = ScreenHost(PlacesMachine)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var onState: ((ByteArray) -> Unit)? = null

    /**
     * Put this screen on the session's core, and start publishing.
     *
     * The attach is the session's because the core is: R-1020-24 is one core per
     * process, so a bridge that opened its own would be refused by
     * `SingleHandleGuard`.
     */
    public fun attach(session: HomeSession) {
        session.attachScreen(host, PlacesReads, PlacesReads)
        // THE SECOND PASS, WITHOUT A SECOND ROUTE. See the class note, and
        // `attachReads`' own, which carries the reason in full.
        //
        // No writes on this one: `media.name_place` is submitted through the
        // runtime attached above, which is the one carrying `PlacesReads`'
        // `ScreenWrites`. A second writer would be a second gate over one
        // command.
        session.attachReads(host, PlacesAssetReads)
        scope.launch { host.state.collect { state -> onState?.invoke(state.encode()) } }
    }

    /** The screen is on screen — read both passes. */
    public fun opened() {
        scope.launch { host.send(PlacesEvent(opened = PlacesEvent.Opened())) }
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
        scope.launch { host.send(PlacesEvent.ADAPTER.decode(event)) }
    }

    /** The current state, for a view that needs one before it subscribes. */
    public fun current(): ByteArray = host.state.value.encode()

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        scope.cancel()
    }
}
