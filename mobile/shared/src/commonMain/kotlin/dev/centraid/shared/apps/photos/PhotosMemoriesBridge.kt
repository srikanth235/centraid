package dev.centraid.shared.apps.photos

import centraid.screen.v1.PhotosMemoriesData
import centraid.screen.v1.PhotosMemoriesEvent
import centraid.screen.v1.PhotosMemoriesState
import dev.centraid.core.CentraidCore
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.sync.ScreenRuntime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * What SwiftUI holds instead of the Memories screen's `StateFlow` (#1029, photos port).
 *
 * `PhotosBridge`'s shape, for the same two load-bearing reasons: the state
 * crosses as **bytes** so one fixture proves both shells, and [send] is **not
 * `suspend`** so a SwiftUI button never holds the main thread while a reducer
 * thinks. Android does not use this — Compose collects [host]'s `StateFlow`
 * directly.
 *
 * ## WHY THIS BRIDGE SERVES ITS OWN READS
 *
 * The shelf is one statement over `media_memory`; a TRIP's route is three more
 * — its members, where each was taken, and those places' pins — and each one's
 * predicate is built from the one before. That chaining cannot ride the
 * reducer, so it happens here, as `PhotosPeopleBridge` does it: the shelf, then
 * the route legs, folded by `PhotosMemoriesReads.withRoutes` into ONE
 * `DataArrived`.
 *
 * **A ROUTE LEG THAT REFUSES COSTS THE SKETCH AND NOTHING ELSE.** The route is
 * decoration beside a trip's name; replacing a readable shelf with a sentence
 * because a pin could not be read would be the decoration taking the content
 * down with it — `PhotosPeopleBridge.withCovers`' rule.
 *
 * **NO WRITES.** Memories is browse-only, as v0's `MemoriesView.tsx` was, so
 * no effect but `ReadPage` is served here.
 */
public class PhotosMemoriesBridge {
    /**
     * The host, exposed because Android drives it directly.
     *
     * One per bridge and never re-created: a routed host lives for the session,
     * so a second would leave the routed one drawing into nothing.
     */
    public val host: ScreenHost<PhotosMemoriesState, PhotosMemoriesEvent> =
        ScreenHost(PhotosMemoriesMachine)

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
        // ROUTED ONCE: the route list appends, and a host routed twice
        // re-reads the shelf twice on every commit.
        session.changes.route(host)
        // UNDISPATCHED, for `ScreenRuntime.start`'s reason: `effects` has no
        // replay, so a collector that is only SCHEDULED loses the first
        // `ReadPage`.
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            host.effects.collect { effect ->
                if (effect is ScreenEffect.ReadPage &&
                    effect.screenId == PhotosMemoriesMachine.SCREEN_ID
                ) {
                    scope.launch { serve(session, effect.afterCursor) }
                }
            }
        }
        scope.launch { host.state.collect { state -> onState?.invoke(state.encode()) } }
    }

    /** The shelf, then its trips' routes, as one `DataArrived`. */
    private suspend fun serve(session: HomeSession, afterCursor: String?) {
        val core = session.shelf.core()
        val shelf = core.photosPage(
            PhotosMemoriesReads.query(host.state.value, afterCursor),
            PhotosMemoriesReads.limit,
            after = ScreenRuntime.decodeCursor(afterCursor),
        )
        if (shelf is PhotosPage.Refused) {
            host.send(PhotosMemoriesReads.refused(shelf.failure))
            return
        }
        val arrived = PhotosMemoriesReads.arrived(
            (shelf as PhotosPage.Rows).rows,
            shelf.nextCursor,
        )
        val data = arrived.data_?.data_
        if (data == null) {
            host.send(arrived)
            return
        }
        host.send(
            PhotosMemoriesEvent(
                data_ = PhotosMemoriesEvent.DataArrived(data_ = withRoutes(core, data)),
            ),
        )
    }

    /** The three route legs; any refusal leaves the page as it was. */
    private suspend fun withRoutes(core: CentraidCore?, data: PhotosMemoriesData): PhotosMemoriesData {
        val limit = PhotosMemoriesReads.ROUTE_LIMIT
        val members = PhotosMemoriesReads.membersQuery(PhotosMemoriesReads.tripIds(data))
            ?.let { core.photosPage(it, limit) } as? PhotosPage.Rows ?: return data
        val assets = PhotosMemoriesReads.memberPlacesQuery(PhotosMemoriesReads.memberAssetIds(members.rows))
            ?.let { core.photosPage(it, limit) } as? PhotosPage.Rows ?: return data
        val places = PhotosMemoriesReads.stopsQuery(PhotosMemoriesReads.memberPlaceIds(assets.rows))
            ?.let { core.photosPage(it, limit) } as? PhotosPage.Rows ?: return data
        return PhotosMemoriesReads.withRoutes(data, members.rows, assets.rows, places.rows)
    }

    /** The screen is on screen — read the shelf. */
    public fun opened() {
        scope.launch { host.send(PhotosMemoriesEvent(opened = PhotosMemoriesEvent.Opened())) }
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
        scope.launch { host.send(PhotosMemoriesEvent.ADAPTER.decode(event)) }
    }

    /** The current state, for a view that needs one before it subscribes. */
    public fun current(): ByteArray = host.state.value.encode()

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        scope.cancel()
    }
}
