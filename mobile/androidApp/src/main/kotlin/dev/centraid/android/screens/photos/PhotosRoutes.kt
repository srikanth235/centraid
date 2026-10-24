package dev.centraid.android.screens.photos

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.DuplicateReviewScreen
import dev.centraid.android.screens.DuplicatesScreen
import dev.centraid.android.screens.LocalPhotoEditOpener
import dev.centraid.android.screens.PhotoEditorScreen
import dev.centraid.android.screens.PhotoLightboxScreen
import dev.centraid.android.screens.PhotoPickerScreen
import dev.centraid.android.screens.PhotoShelfScreen
import dev.centraid.android.screens.PlacesScreen
import dev.centraid.android.screens.RouteNav
import dev.centraid.android.screens.exportShelfCopies
import dev.centraid.android.screens.installPhotoEditRenderer
import dev.centraid.design.copy.PhotosCopy
import dev.centraid.shared.apps.photos.DuplicateReviewBridge
import dev.centraid.shared.apps.photos.DuplicatesBridge
import dev.centraid.shared.apps.photos.PhotoEditorBridge
import dev.centraid.shared.apps.photos.PhotoLightboxBridge
import dev.centraid.shared.apps.photos.PhotoPickerBridge
import dev.centraid.shared.apps.photos.PhotoShelfBridge
import dev.centraid.shared.apps.photos.PlacesBridge
import dev.centraid.shared.apps.photos.PlacesMachine
import dev.centraid.shared.nav.PhotosEntry
import dev.centraid.shared.shell.PhotosDevice
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * THE PHOTOS MINIAPP'S ROUTES (#1029, photos port): the library and its
 * nine pushed screens, moved out of `MainActivity` unchanged (K5).
 *
 * **The nine are held as BRIDGES and not as bare [ScreenHost]s.** Compose
 * collects the grid's host directly, but a screen with more than one read has
 * nothing to hand `attachScreen`:
 *
 * * **Collections and Search have no `ScreenReads` at all.** Their reads are a
 *   FAN-OUT folded into one state; the trip lives in the bridge and
 *   `changes.route(host)` is what it calls instead.
 * * **The lightbox, Duplicates and Duplicate review carry LEGS whose
 *   constructors are `internal`** to `:shared`, so only the bridge can write
 *   `attachReads(host, PhotoLightboxLeg(leg))`.
 *
 * One instance per screen for the life of the activity, never re-created:
 * `ChangeStream.route` is registration with no removal, so a second host would
 * leave the routed one drawing into nothing.
 */
public class PhotosRoutes(private val cacheDir: java.io.File) : AppRoutes {
    private val photoShelf = PhotoShelfBridge()
    private val photoLightbox = PhotoLightboxBridge()
    private val photoPicker = PhotoPickerBridge()
    private val places = PlacesBridge()
    private val duplicates = DuplicatesBridge()
    private val duplicateReview = DuplicateReviewBridge()
    private val photoEditor = PhotoEditorBridge()

    /**
     * THE DEVICE'S HALF OF PHOTOS: the camera roll (walked once PER VAULT), free up
     * space and an original back from the gateway. Held so the Photos screen's
     * remedies have something to call (#1025 S6).
     */
    private val device = PhotosDevice()

    /** Photos' screens that Rust owns (#1135): the home, and whatever joins it. */
    private val rust = PhotosRustHost(device)

    override fun handles(destination: Destination): Boolean = when (destination) {
        is Destination.PhotoShelfRoute,
        is Destination.PhotoLightbox,
        is Destination.PhotoEditor,
        is Destination.PhotoPicker,
        is Destination.Places,
        is Destination.PhotoDuplicates,
        is Destination.PhotoDuplicateReview,
        -> true
        else -> rust.handles(destination)
    }

    override fun opens(moveId: String): Destination? = if (moveId == "photos") PhotosEntry.home() else null

    /**
     * A VAULT WAS JUST MADE and the system's photo prompt was answered
     * (R-ONBOARD-8): read the grant and, when it allows, bring the camera roll
     * in. The prompt itself is the activity's launcher.
     */
    public fun photosAnswered(scope: CoroutineScope) {
        device.perform(PhotosDevice.ACTION_ASK_PERMISSION)
    }

    override fun attach(session: HomeSession, scope: CoroutineScope) {
        // THE CAMERA ROLL FIRST: the screen is told its grant as it opens. **Called
        // exactly once**, because attaching routes a host onto the change stream.
        device.attach(session)
        rust.attach(session, scope)
        // Each `attach` is the bridge's, which is either `attachScreen` plus its legs
        // or `changes.route` plus a fan-out.
        photoShelf.attach(session)
        photoLightbox.attach(session)
        photoPicker.attach(session)
        places.attach(session)
        duplicates.attach(session)
        duplicateReview.attach(session)
        // THE EDITOR'S SAVE RENDERS HERE, on this shell's own decoder, and
        // ingests through the bridge (#1029).
        installPhotoEditRenderer(photoEditor, cacheDir)
        photoEditor.attach(session)
    }

    /**
     * THE BAND IS THE SPECIAL CASE, and it is doctrine 1 read backwards. Moving to
     * Collections is not a push, so there is no entry for back to pop — back returns
     * the screen to its library rather than popping Photos whole.
     */
    override fun back(stack: NavStack, scope: CoroutineScope): NavStack? = rust.back(stack, scope)

    @Composable
    override fun Global(nav: RouteNav) {
        rust.Global(nav)
    }

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
        var stack by nav
        val scope = nav.scope
        when (destination) {
            is Destination.RustScreen -> rust.Routes(destination, nav)

            // A PHOTO SHELF: the library under a predicate, and the one
            // screen four of v0's routes became. The predicate ARRIVES
            // WITH THE OPEN — `PhotoShelfReads.query` reads it off the
            // state and a shelf opened without one answers null, which
            // the member reads as "Centraid does not know what to read
            // here".
            //
            // Keyed on the SHELF and not on the destination: they are
            // the same value here, and naming the shelf says what the
            // key is for — walking from Lisbon to Porto is a different
            // shelf and re-opens, a rotation is not and does not.
            is Destination.PhotoShelfRoute -> {
                LaunchedEffect(destination.shelf) { photoShelf.opened(destination.shelf) }
                val state by photoShelf.host.state.collectAsStateWithLifecycle()
                val shelfContext = androidx.compose.ui.platform.LocalContext.current
                PhotoShelfScreen(
                    state = state,
                    onEvent = { event -> scope.launch { photoShelf.host.send(event) } },
                    // THIS SHELF'S OWN ORDER RIDES ALONG. A lightbox
                    // that worked its neighbours out would page the
                    // library once per photograph a member flicked
                    // past, and would order them differently from the
                    // shelf they came out of the moment the two
                    // predicates drifted.
                    onOpenAsset = { assetId, neighbours ->
                        stack = stack.push(
                            Destination.PhotoLightbox(
                                assetId = assetId,
                                neighbours = neighbours,
                                // AN ALBUM'S LIGHTBOX KNOWS ITS ALBUM,
                                // for "Make key photo".
                                albumId = destination.shelf.album?.collection_id.orEmpty(),
                            ),
                        )
                    },
                    // THE PICKER'S ONLY DOOR, on either shell.
                    onAddPhotographs = { collectionId, name ->
                        stack = stack.push(
                            Destination.PhotoPicker(
                                collectionId = collectionId,
                                collectionName = name,
                            ),
                        )
                    },
                    // "SEND A COPY" / "DOWNLOAD ORIGINAL" over the
                    // pick: `screens/PhotoShelfCopies.kt`.
                    onExport = { assetIds, export ->
                        scope.launch { exportShelfCopies(shelfContext, photoShelf, assetIds, export) }
                    },
                    // THE ALBUM WAS DELETED; the shelf showing it goes.
                    onClose = { stack = stack.pop() },
                )
            }

            is Destination.PhotoLightbox -> {
                LaunchedEffect(destination.assetId, destination.neighbours) {
                    photoLightbox.opened(
                        assetId = destination.assetId,
                        neighbours = destination.neighbours,
                        albumId = destination.albumId,
                    )
                }
                val state by photoLightbox.host.state.collectAsStateWithLifecycle()
                // "SEND A COPY" AND "DOWNLOAD" ARE THE SCREEN'S OWN
                // (`PhotoHandOff.kt`, behind the manifest's
                // `FileProvider`): the precision is reduced, and the
                // bytes leave from the lightbox that chose it.
                // EDIT PUSHES THE EDITOR, and the neighbours ride along
                // so a save can come back to the same shelf's order.
                androidx.compose.runtime.CompositionLocalProvider(
                    LocalPhotoEditOpener provides { assetId, neighbours ->
                        stack = stack.push(Destination.PhotoEditor(assetId, neighbours))
                    },
                ) {
                PhotoLightboxScreen(
                        state = state,
                        onEvent = { event ->
                            scope.launch { photoLightbox.host.send(event) }
                        },
                        // THE SWIPE DOWN AND THE CLOSE CHIP: one way out.
                        onClose = { stack = stack.pop() },
                    )
                }
            }

            // THE EDITOR (#1029, photos port). Cancel pops back onto
            // the lightbox it came from; a save replaces that lightbox
            // with one on the NEW photograph, which is the one the
            // member just made, with the shelf's order kept behind it.
            is Destination.PhotoEditor -> {
                LaunchedEffect(destination.assetId) { photoEditor.opened(destination.assetId) }
                val state by photoEditor.host.state.collectAsStateWithLifecycle()
                PhotoEditorScreen(
                    state = state,
                    onEvent = { event -> scope.launch { photoEditor.host.send(event) } },
                    onClose = { stack = stack.pop() },
                    onSaved = { saved ->
                        val under = stack.pop()
                        stack = if (saved.isNotEmpty() &&
                            under.current is Destination.PhotoLightbox
                        ) {
                            NavStack(
                                under.entries.dropLast(1) + Destination.PhotoLightbox(
                                    assetId = saved,
                                    neighbours = listOf(saved) +
                                        destination.neighbours.filter { it != saved },
                                ),
                            )
                        } else {
                            under
                        }
                    },
                )
            }

            // THE PICKER, pushed by an album shelf's "Add
            // photographs" — its one door, on either shell.
            is Destination.PhotoPicker -> {
                LaunchedEffect(destination.collectionId) {
                    photoPicker.opened(
                        collectionId = destination.collectionId,
                        collectionName = destination.collectionName,
                        // EMPTY, AND NOT A GAP: the picker reads the
                        // album's whole membership itself on open
                        // (`PhotoPickerMachine.MEMBERS_READ_ID`) — no
                        // caller holds more than one page of it.
                        alreadyInAlbumAssetIds = emptyList(),
                    )
                }
                val state by photoPicker.host.state.collectAsStateWithLifecycle()
                PhotoPickerScreen(
                    state = state,
                    onEvent = { event -> scope.launch { photoPicker.host.send(event) } },
                    // ADDING IS THE END OF THIS SCREEN. The pop is the
                    // shell's, which is what v0 did on a successful
                    // batch.
                    onFinished = { stack = stack.pop() },
                )
            }

            // PLACES, AND CARDS-OR-MAP IS A PARAMETER — the band's rule
            // applied to two of v0's routes over one read.
            is Destination.Places -> {
                // KEYED ON NOTHING, deliberately. The only parameter
                // this destination carries is the presentation, and
                // re-opening on a presentation toggle would be a full
                // re-read every time a member looked at the plot and
                // back. Leaving the screen disposes this effect, so a
                // return still re-reads.
                LaunchedEffect(Unit) { places.opened() }
                val state by places.host.state.collectAsStateWithLifecycle()
                PushedPage(
                    title = PhotosCopy.PHOTOS_PLACES,
                    parentTitle = PhotosCopy.PHOTOS_BAND_COLLECTIONS,
                    onBack = { stack = stack.pop() },
                ) {
                    PlacesScreen(
                        state = state,
                        onEvent = { event ->
                            // The presentation lives on the route as well
                            // as on the state, for the band's reason and
                            // with the band's consequence if only one moves.
                            val moved = event.presentation
                            if (moved != null) {
                                stack = stack.withPlacesPresentation(moved.presentation)
                            }
                            scope.launch { places.host.send(event) }
                        },
                        // THE MACHINE'S OWN VALUE, never a `PhotoShelf`
                        // composed here: both shells need the same one, and
                        // a second spelling of it is a second chance to send
                        // a place id with no name.
                        onOpenPlace = { row ->
                            stack = stack.push(
                                Destination.PhotoShelfRoute(PlacesMachine.shelfFor(row)),
                            )
                        },
                        // THE PHOTOGRAPHS WITH NO PLACE, as the machine builds it.
                        onOpenShelf = { shelf ->
                            stack = stack.push(Destination.PhotoShelfRoute(shelf))
                        },
                    )
                }
            }

            is Destination.PhotoDuplicates -> {
                LaunchedEffect(destination) { duplicates.opened() }
                val state by duplicates.host.state.collectAsStateWithLifecycle()
                PushedPage(
                    title = PhotosCopy.PHOTOS_DUPLICATES,
                    parentTitle = PhotosCopy.PHOTOS_BAND_COLLECTIONS,
                    onBack = { stack = stack.pop() },
                ) {
                    DuplicatesScreen(
                        state = state,
                        onEvent = { event -> scope.launch { duplicates.host.send(event) } },
                        onOpenCluster = { clusterId ->
                            stack = stack.push(Destination.PhotoDuplicateReview(clusterId))
                        },
                    )
                }
            }

            // THE CLUSTER'S ID RIDES ON THE EVENT, for the note
            // editor's reason: `DuplicateReviewReads.query` reads it off
            // the state, and a review opened without one reads nothing
            // rather than reading whichever cluster sorted first.
            is Destination.PhotoDuplicateReview -> {
                LaunchedEffect(destination.clusterId) {
                    duplicateReview.opened(destination.clusterId)
                }
                val state by duplicateReview.host.state.collectAsStateWithLifecycle()
                PushedPage(
                    title = PhotosCopy.PHOTOS_DUPLICATES,
                    parentTitle = PhotosCopy.PHOTOS_DUPLICATES,
                    onBack = { stack = stack.pop() },
                ) {
                    DuplicateReviewScreen(
                        state = state,
                        onEvent = { event ->
                            scope.launch { duplicateReview.host.send(event) }
                        },
                    )
                }
            }

            else -> Unit
        }
    }
}
