package dev.centraid.shared.apps.photos

import centraid.screen.v1.PhotoPickerEvent
import centraid.screen.v1.PhotoPickerState
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
 * What SwiftUI holds instead of the picker's `StateFlow` (#1029, the photos
 * port).
 *
 * `PhotosBridge`'s shape and `PhotoShelfBridge`'s reasons: bytes and not
 * objects, so one fixture proves both shells; not `suspend`, because a SwiftUI
 * button cannot await and a view that could await a reducer would hold the main
 * thread while a screen thinks.
 *
 * Android does NOT use this: Compose collects [host]'s `StateFlow` directly.
 */
public class PhotoPickerBridge {
    /** The host, exposed because Android drives it directly. One per bridge. */
    public val host: ScreenHost<PhotoPickerState, PhotoPickerEvent> =
        ScreenHost(PhotoPickerMachine)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var onState: ((ByteArray) -> Unit)? = null

    /**
     * Put this screen on the session's core, and start publishing.
     *
     * [PhotoPickerReads] is passed twice: the picker reads the library and
     * writes `media.add_to_album`, so a null `writes` would make Confirm an
     * effect nothing served — which is the defect `ScreenRuntime`'s own file
     * comment describes for reads, applied to the other half of the door.
     */
    public fun attach(session: HomeSession) {
        session.attachScreen(host, PhotoPickerReads, PhotoPickerReads)
        // THE ALBUM'S MEMBERSHIP, BESIDE THE PAGE. `ScreenRuntime` serves this
        // screen's library page and nothing else, so the second read is a
        // collector of its own — UNDISPATCHED, for `ScreenRuntime.start`'s
        // reason: an effect emitted into a `SharedFlow` nobody is subscribed
        // to yet is dropped.
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            host.effects.collect { effect ->
                if (effect is ScreenEffect.ReadPage && effect.screenId == PhotoPickerMachine.MEMBERS_READ_ID) {
                    val collectionId = host.state.value.collection_id
                    scope.launch { members(session, collectionId) }
                }
            }
        }
        scope.launch { host.state.collect { state -> onState?.invoke(state.encode()) } }
    }

    /**
     * EVERY PHOTOGRAPH THE ALBUM HOLDS, WALKED. `entry_id` is the entry's own
     * primary key, so the walk continues past a page the way no nullable
     * timestamp can. A refusal part way sends what was read — the taken set is
     * a union, so a partial list marks fewer cells taken and never marks a
     * wrong one, and the add's own precondition refuses the rest by name.
     */
    private suspend fun members(session: HomeSession, collectionId: String) {
        if (collectionId.isEmpty()) return
        val ids = mutableListOf<String>()
        var after: String? = null
        do {
            val page = session.shelf.core().photosPage(
                PhotoPickerReads.membersQuery(collectionId),
                limit = MEMBERS_PAGE,
                after = ScreenRuntime.decodeCursor(after),
            ) as? PhotosPage.Rows ?: break
            page.rows.mapNotNullTo(ids) { row -> row.values.getOrNull(1)?.text?.takeIf { it.isNotEmpty() } }
            after = page.nextCursor
        } while (after != null)
        host.send(
            PhotoPickerEvent(
                members = PhotoPickerEvent.MembersArrived(collection_id = collectionId, asset_ids = ids),
            ),
        )
    }

    private companion object {
        /** The door's own ceiling (`MAX_PAGE_ROWS`). */
        const val MEMBERS_PAGE: Int = 500
    }

    /**
     * Open the picker on one album.
     *
     * All three arrive together because all three ride the route
     * (`nav/Navigation.kt`, `Destination.PhotoPicker`): the id the writes name,
     * the name the head says before any read, and what the album already holds
     * so the grid can draw those cells as taken rather than letting a member
     * add one twice.
     *
     * [alreadyInAlbumAssetIds] is what the CALLER already knows, and may be
     * empty: the picker reads the album's whole membership itself on open
     * (`PhotoPickerMachine.MEMBERS_READ_ID`) and unions the two, because no
     * caller holds more than one page of the album.
     */
    public fun opened(
        collectionId: String,
        collectionName: String,
        alreadyInAlbumAssetIds: List<String>,
    ) {
        scope.launch {
            host.send(
                PhotoPickerEvent(
                    opened = PhotoPickerEvent.Opened(
                        collection_id = collectionId,
                        collection_name = collectionName,
                        already_in_album_asset_ids = alreadyInAlbumAssetIds,
                    ),
                ),
            )
        }
    }

    /** Publish every state to [onState], starting with the current one. */
    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        onState(host.state.value.encode())
    }

    /** Forward one encoded event. */
    public fun send(event: ByteArray) {
        scope.launch { host.send(PhotoPickerEvent.ADAPTER.decode(event)) }
    }

    /** The current state, for a view that needs one before it subscribes. */
    public fun current(): ByteArray = host.state.value.encode()

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        scope.cancel()
    }
}
