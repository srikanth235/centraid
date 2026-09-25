package dev.centraid.shared.apps.photos

import centraid.screen.v1.AlbumChoicesArrived
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.PhotoShelfEvent
import centraid.screen.v1.PhotoShelfState
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
 * What SwiftUI holds instead of the photo shelf's `StateFlow` (#1029, the
 * photos port).
 *
 * `PhotosBridge`'s shape, for the same reasons, and they are worth restating
 * because both are load-bearing at this boundary:
 *
 * * **BYTES, NOT OBJECTS.** The state crosses as an encoded [PhotoShelfState]
 *   and the event arrives as an encoded [PhotoShelfEvent]; Swift decodes it
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
 * It lives in the app's own package rather than in `shell/` because a bridge
 * names its screen's types, and `PerAppLayoutSpec`'s second rule is that
 * nothing outside `apps` may do that.
 *
 * ## ONE BRIDGE, EVERY SHELF
 *
 * There is one of these for all eight shelves, not one per shelf, because
 * there is one MACHINE for all eight: the shelf is a parameter that arrives
 * with [opened]. A bridge per shelf would re-create a [ScreenHost] on every
 * push, and `ChangeStream.route` registers a host for the life of the session
 * with no removal — so the second host would leave the routed one drawing into
 * a view that is gone.
 */
public class PhotoShelfBridge : CopyExportScreen {
    /**
     * The host, exposed because Android drives it directly.
     *
     * One per bridge and never re-created. See the class note.
     */
    public val host: ScreenHost<PhotoShelfState, PhotoShelfEvent> =
        ScreenHost(PhotoShelfMachine)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var onState: ((ByteArray) -> Unit)? = null

    /**
     * Put this screen on the session's core, and start publishing.
     *
     * The attach is the session's ([HomeSession.attachScreen]) because the core
     * is: R-1020-24 is one core per process, so a bridge that opened its own
     * would be refused by `SingleHandleGuard`.
     *
     * [PhotoShelfReads] is passed twice because it is both halves — the reads
     * and the writes. The shelf has three verbs over its selection, so unlike
     * the library grid it is a screen with a write, and a null `writes` here
     * would make every Restore an effect nothing served.
     */
    public fun attach(session: HomeSession) {
        this.session = session
        session.attachScreen(host, PhotoShelfReads, PhotoShelfReads)
        // THE TWO READS BESIDE THE PAGE: the "Add to album" list, and the
        // whole trash for Empty Trash. Each is a `ReadPage` under its own id,
        // served by a collector of its own — `ScreenRuntime` serves this
        // screen's page and nothing else.
        AlbumChoice.attach(session, host, scope) { choices ->
            PhotoShelfEvent(album_choices = AlbumChoicesArrived(choices = choices))
        }
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            host.effects.collect { effect ->
                if (effect is ScreenEffect.ReadPage && effect.screenId == PhotoShelfMachine.TRASH_LIST_READ_ID) {
                    scope.launch { listTrash(session) }
                }
            }
        }
        // AN ALBUM'S "KEEP ORIGINALS ON THIS PHONE" SWITCH, served off this
        // host's own state (`KeepOriginals.kt`).
        KeepOriginals.attachShelf(session, host, scope)
        scope.launch { host.state.collect { state -> onState?.invoke(state.encode()) } }
    }

    private var session: HomeSession? = null

    /**
     * EVERY TRASHED ASSET, WALKED TO THE END.
     *
     * The trash's sort column cannot be NULL under its own predicate, so this
     * is the one shelf read the door lets continue page after page. A refusal
     * part way SENDS NOTHING: a purge of the first half of a list is a Empty
     * Trash that emptied half the trash and said nothing about the rest, and
     * the member presses again over a sentence rather than over a lie.
     */
    private suspend fun listTrash(session: HomeSession) {
        val ids = mutableListOf<String>()
        var after: String? = null
        do {
            val page = session.shelf.core().photosPage(
                PhotoShelfReads.trashListQuery(),
                limit = TRASH_PAGE,
                after = ScreenRuntime.decodeCursor(after),
            )
            if (page !is PhotosPage.Rows) {
                host.send(
                    PhotoShelfEvent(
                        write_settled = PhotoShelfEvent.WriteSettled(
                            committed = false,
                            sentence = (page as PhotosPage.Refused).failure.sentence,
                        ),
                    ),
                )
                return
            }
            page.rows.mapNotNullTo(ids) { row -> row.values.getOrNull(0)?.text?.takeIf { it.isNotEmpty() } }
            after = page.nextCursor
        } while (after != null)
        host.send(PhotoShelfEvent(trash_listed = PhotoShelfEvent.TrashListed(asset_ids = ids)))
    }

    /**
     * FIND THE PICKED ORIGINALS ON THIS DEVICE, for "Send a copy" and
     * "Download original" — `ShelfCopies.locate`, handed back on the main
     * thread. What the shell then does with the files is the platform's; what
     * it came to comes back through [exportSettled].
     */
    override fun locateOriginals(assetIds: List<String>, onLocated: (ShelfCopies.Located) -> Unit) {
        val bound = session ?: return onLocated(ShelfCopies.Located(emptyList(), assetIds.size))
        scope.launch { onLocated(ShelfCopies.locate(bound, assetIds)) }
    }

    /** What the shell's copy came to, as the one clause the shelf shows. */
    override fun exportSettled(sentence: String) {
        scope.launch {
            host.send(PhotoShelfEvent(export_settled = PhotoShelfEvent.ExportSettled(sentence = sentence)))
        }
    }

    private companion object {
        /** The door's own ceiling (`MAX_PAGE_ROWS`); asking for more is clamped. */
        const val TRASH_PAGE: Int = 500
    }

    /**
     * Open a shelf. The predicate arrives WITH the open and not after it.
     *
     * A screen reads because it was opened, not because it was built — and the
     * shelf is what says WHICH library this is, so an `Opened` without one
     * would make `PhotoShelfReads.query` answer null and the member read
     * "Centraid does not know what to read here."
     *
     * A method on the bridge rather than an encoded event from the shell
     * because Swift builds `PhotoShelf` from a route it already holds: the
     * destination carries the shelf (`nav/Navigation.kt`,
     * `Destination.PhotoShelfRoute`), and a shell that had to re-encode it
     * would be spelling the parameter twice.
     */
    public fun opened(shelf: PhotoShelf) {
        scope.launch { host.send(PhotoShelfEvent(opened = PhotoShelfEvent.Opened(shelf = shelf))) }
    }

    /**
     * THE SAME, FROM THE ENCODED SHELF — WHICH IS THE ONLY FORM SWIFT HAS.
     *
     * The shelf is a parameter that rides the route, and iOS's route holds it
     * as `Data`: `Centraid_Screen_V1_PhotoShelf` is SwiftProtobuf's struct,
     * generated from the same `.proto` as Wire's Kotlin class and **not the
     * same type**, so there is no value SwiftUI could hand to [opened] above.
     * The same ABI fact that made [sentences] necessary makes this necessary,
     * and the bytes are what both sides already agree on.
     *
     * A shelf that does not decode is NOT opened. It would be a screen reading
     * the whole library under no predicate — every photograph in the vault
     * under a heading that says "Trash" — so the honest answer is to send
     * nothing and let the screen stay on the sentence `PhotoShelfCopy.unknown`
     * carries.
     */
    public fun openedEncoded(shelf: ByteArray) {
        val decoded = runCatching { PhotoShelf.ADAPTER.decode(shelf) }.getOrNull() ?: return
        opened(decoded)
    }

    /**
     * THE SHELF'S OWN WORDS, DERIVED ONCE AND HANDED TO BOTH SHELLS.
     *
     * Compose calls [PhotoShelfMachine.emptySentence] and its siblings
     * directly; SwiftUI cannot, and the reason is worth stating because it is
     * the only place in this lane where the ABI changes a design. Those
     * functions take a `PhotoShelf`, and the `PhotoShelf` SwiftUI holds is
     * `Centraid_Screen_V1_PhotoShelf` — SwiftProtobuf's struct, generated from
     * the same `.proto` as Wire's Kotlin class and NOT the same type. There is
     * no value Swift could pass.
     *
     * So the derivation stays in the machine and the ANSWER crosses, as six
     * plain values off the state the host is already holding. The alternative
     * was a second table of sentences written in Swift, which is exactly the
     * drift that gave v0 a `PlaceDetail` with an empty sentence and three state
     * views without one.
     *
     * Read at the moment of the call rather than published, because it is a
     * function of `shelf` — which changes only on `Opened`, and an `Opened` is
     * the one event a shell sends before it draws anything.
     */
    public fun sentences(): ShelfCopy {
        val state = host.state.value
        val shelf = state.shelf
        return ShelfCopy(
            title = PhotoShelfMachine.title(shelf),
            empty = PhotoShelfMachine.emptySentence(shelf),
            emptyRemedy = PhotoShelfMachine.emptyRemedy(shelf),
            // THE WINDOW, READ OFF THE STATE'S OWN FIELD and not re-derived
            // from the shelf. `purge_window_days` is 0 on every shelf but the
            // trash, so the sentence is empty there — and a bridge that asked
            // "is this the trash" a second time could answer differently from
            // the state it is describing.
            purgeWindow = PhotoShelfMachine.purgeWindowSentence(state.purge_window_days),
            isTrash = PhotoShelfMachine.isTrash(shelf),
            isArchive = PhotoShelfMachine.isArchive(shelf),
        )
    }

    /** What a shelf says about itself. See [sentences]. */
    public data class ShelfCopy(
        public val title: String,
        public val empty: String,
        public val emptyRemedy: String,
        public val purgeWindow: String,
        public val isTrash: Boolean,
        public val isArchive: Boolean,
    )

    /** Publish every state to [onState], starting with the current one. */
    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        // The FIRST state, immediately. A view that subscribed and then waited
        // for a change would draw nothing at all until a read landed.
        onState(host.state.value.encode())
    }

    /** Forward one encoded event. */
    public fun send(event: ByteArray) {
        scope.launch { host.send(PhotoShelfEvent.ADAPTER.decode(event)) }
    }

    /** The current state, for a view that needs one before it subscribes. */
    public fun current(): ByteArray = host.state.value.encode()

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        scope.cancel()
    }
}
