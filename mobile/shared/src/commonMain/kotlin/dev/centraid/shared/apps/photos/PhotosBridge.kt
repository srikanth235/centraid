package dev.centraid.shared.apps.photos

import centraid.screen.v1.AlbumChoicesArrived
import centraid.screen.v1.PhotosGridState
import centraid.screen.v1.PhotosGridEvent
import dev.centraid.shared.platform.PlatformServices
import dev.centraid.shared.platform.SecureStore
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.CameraRoll
import dev.centraid.shared.shell.CameraRollRunner
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.shell.Shelf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * What SwiftUI holds instead of the Photos grid's `StateFlow` (#1025 S5, lane L5).
 *
 * `HomeBridge`'s shape, for the same reasons, and they are worth restating
 * because both are load-bearing at this boundary:
 *
 * * **BYTES, NOT OBJECTS.** The state crosses as an encoded `PhotosGridState` and
 *   the event arrives as an encoded `PhotosGridEvent`; Swift decodes it with
 *   SwiftProtobuf from the same schema Wire reads here, so one fixture proves
 *   both sides. Handing Swift a Kotlin object would put an Objective-C
 *   bridging layer between the shells and give the contract two shapes.
 * * **NOT `suspend`.** A SwiftUI button cannot await, and a view that could
 *   await a reducer would be a view holding the main thread while a screen
 *   thinks. The launch is what keeps `send`'s ordering — one coroutine, one
 *   queue — without the caller knowing there is one.
 *
 * Android does NOT use this: Compose collects [host]'s `StateFlow` directly,
 * because on that side it already is the right shape.
 *
 * It lives in the app's own package rather than in `shell/` because a bridge
 * names its screen's types, and `PerAppLayoutSpec`'s second rule is that
 * nothing outside `apps` may do that. A shell that had to be edited to add an
 * app is the thing the rule exists to prevent.
 */
public class PhotosBridge {
    /**
     * The host, exposed because Android drives it directly.
     *
     * One per bridge and never re-created: `ChangeStream.route` registers a
     * host for the life of the session, so a second host would leave the routed
     * one drawing into nothing.
     */
    public val host: ScreenHost<PhotosGridState, PhotosGridEvent> = ScreenHost(PhotosGridMachine)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var onState: ((ByteArray) -> Unit)? = null

    /**
     * Put this screen on the session's core, and start publishing.
     *
     * The attach is the session's ([HomeSession.attachScreen]) because the core
     * is: R-1020-24 is one core per process, so a bridge that opened its own
     * would be refused by `SingleHandleGuard`.
     */
    /**
     * TWO OVERLOADS AND NOT ONE DEFAULT ARGUMENT.
     *
     * **Kotlin default arguments do not cross into Swift.** The Objective-C
     * interop exports one selector with every parameter required, so a
     * `services: PlatformServices = platformServices()` compiles on this side
     * and then fails the app build with "missing argument for parameter
     * 'services'" — which is exactly how this was first written and exactly
     * what the simulator build said. The no-argument overload is the shells'
     * call; the other is for a test with fakes.
     */
    public fun attach(session: HomeSession): Unit = attach(session, platformServices())

    public fun attach(
        session: HomeSession,
        /**
         * The platform, for the camera roll's half of this screen (#1025 S6).
         *
         * A parameter rather than a read off the session, because
         * `HomeSession` keeps its services private and this is the only caller
         * that needs them.
         */
        services: PlatformServices,
    ) {
        PhotosGridWiring.attach(session, host, scope, services.secureStore)
        copies.attach(session)
        // THE OTHER PLANE ON THIS SCREEN. The grid reads the vault; this reads
        // the camera roll. Until #1025 S6 nothing collected `Backup` or
        // `RequestMediaPermission` at all, so "Allow photo access" emitted an
        // effect into a flow with no subscriber and a phone never uploaded
        // (`CameraRollRunner`).
        cameraRoll = CameraRollRunner(
            services = services,
            roll = CameraRoll(
                services = services,
                core = { session.shelf.core() },
                // A BACKUP IS A WRITE (#1029 F1). A vault that moved to the
                // member's other phone takes no photographs.
                readOnly = {
                    if (session.shelf.foregroundHolding()?.readOnly == true) {
                        Shelf.MOVED_SENTENCE
                    } else {
                        null
                    }
                },
            ),
            host = host,
            scope = scope,
            // READ AT EACH USE, not captured: a vault switch moves the
            // foreground, and a roll is walked once PER VAULT because a
            // photograph offered to two vaults is two uploads
            // (`docs/mobile-offline.md:175`).
            vaultId = { session.shelf.foregroundHolding()?.vaultId },
        ).also { it.start() }
        // AFTER the runner's start job: that job syncs permission before it
        // suspends on effects, so the first state this collect publishes past
        // the machine's seed already carries the OS grant (R-PHOTOS-1).
        scope.launch { host.state.collect { state -> onState?.invoke(state.encode()) } }
    }

    private var cameraRoll: CameraRollRunner? = null

    /**
     * "Send a copy" over the selection — the shell's batch hand-off
     * (`ShelfCopyExport.swift`) takes this as its [CopyExportScreen].
     */
    public val copies: LibraryCopies = LibraryCopies(host)

    /**
     * The Photos cover is on screen — re-read the grant, then open the grid.
     *
     * Session attach already seeded once; this is the read at first paint of
     * THIS screen (R-PHOTOS-1). A grant that landed after attach (Settings, a
     * launch prompt) must move the banner before `Opened` reloads the page, or
     * the member sees "Allow photo access" over a library the app can read.
     */
    public fun opened() {
        scope.launch {
            cameraRoll?.syncPermission()
            host.send(PhotosGridEvent(opened = PhotosGridEvent.Opened()))
        }
    }

    /**
     * Run one camera-roll pass now — what a foreground wake calls.
     *
     * Named on the bridge because Swift cannot reach into the runner, and a
     * pass is what a member expects "Sync now" on the Photos screen to mean.
     */
    public fun backUpNow() {
        scope.launch { cameraRoll?.pass() }
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
        scope.launch { host.send(PhotosGridEvent.ADAPTER.decode(event)) }
    }

    /** The current state, for a view that needs one before it subscribes. */
    public fun current(): ByteArray = host.state.value.encode()

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        scope.cancel()
    }
}

/**
 * EVERYTHING THE LIBRARY GRID NEEDS ON A SESSION, IN ONE CALL (#1029, photos
 * port), so iOS's bridge and Android's activity attach the same screen the
 * same way rather than each remembering three things.
 *
 * * **The page and its writes**, through `attachScreen` — which is also the
 *   ONE `changes.route(host)` this host gets; routing is registration with no
 *   removal, so nothing else here may route it again.
 * * **The album list** the selection's "Add to album" sheet draws, served by
 *   [AlbumChoice.attach] beside the page runner.
 * * **The tile size across launches** (`photos-rung-store.ts`): v0 persisted
 *   the rung and ONLY the rung — the filter and the zoom are session-scoped,
 *   because this product has no member-preference plane and a device store
 *   should not grow into one. It rides [SecureStore] because that is the one
 *   key-value store the platform seam has; a tile size is not a secret, and
 *   the store's own rule (`""` deletes) never bites, since a rung is a digit.
 */
public object PhotosGridWiring {
    public fun attach(
        session: HomeSession,
        host: ScreenHost<PhotosGridState, PhotosGridEvent>,
        scope: CoroutineScope,
        store: SecureStore,
    ) {
        session.attachScreen(host, PhotosReads, PhotosReads)
        AlbumChoice.attach(session, host, scope) { choices ->
            PhotosGridEvent(album_choices = AlbumChoicesArrived(choices = choices))
        }
        // THE MORE SHEET'S "FREE UP SPACE" ROW, counted when the sheet opens
        // (`KeepOriginals.kt`).
        KeepOriginals.attachGrid(session, host, scope)
        scope.launch {
            // THE STORED RUNG FIRST, THEN THE WATCH. A watch started before the
            // restore would write the seed over the member's choice.
            val stored = runCatching { store.read(PhotosTimeline.RUNG_KEY) }.getOrNull()?.toIntOrNull()
            if (stored != null) {
                host.send(PhotosGridEvent(rung = PhotosGridEvent.RungChanged(rung = stored)))
            }
            host.state
                .map { it.rung }
                .distinctUntilChanged()
                .drop(1)
                .collect { rung ->
                    runCatching { store.write(PhotosTimeline.RUNG_KEY, rung.toString()) }
                }
        }
    }
}

/**
 * THE LIBRARY'S SELECTION AS A [CopyExportScreen] (#1029, photos port): the
 * shelf's batch hand-off, pointed at the grid. Finding the originals is
 * [ShelfCopies.locate]'s and the outcome is the grid's `export_notice`, so the
 * library's "Send a copy" asks the same one question and says the same
 * sentences as a shelf's.
 *
 * A class of its own rather than a method on [PhotosBridge] because Android
 * holds the grid's host bare (`MainActivity`) and has no bridge to hang it on.
 */
public class LibraryCopies(
    private val host: ScreenHost<PhotosGridState, PhotosGridEvent>,
) : CopyExportScreen {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: HomeSession? = null

    /** The session whose vault the originals are found in. */
    public fun attach(session: HomeSession) {
        this.session = session
    }

    override fun locateOriginals(assetIds: List<String>, onLocated: (ShelfCopies.Located) -> Unit) {
        val bound = session ?: return onLocated(ShelfCopies.Located(emptyList(), assetIds.size))
        scope.launch { onLocated(ShelfCopies.locate(bound, assetIds)) }
    }

    override fun exportSettled(sentence: String) {
        scope.launch {
            host.send(PhotosGridEvent(export_settled = PhotosGridEvent.ExportSettled(sentence = sentence)))
        }
    }
}
