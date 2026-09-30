package dev.centraid.android.screens.photos

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalFocusManager
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.CollectionsDoor
import centraid.screen.v1.PhotosGridEvent
import centraid.screen.v1.PhotosGridState
import centraid.screen.v1.PhotosSearchEvent
import dev.centraid.android.kit.AppBand
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.DuplicateReviewScreen
import dev.centraid.android.screens.DuplicatesScreen
import dev.centraid.android.screens.FaceReviewScreen
import dev.centraid.android.screens.LocalPhotoEditOpener
import dev.centraid.android.screens.PhotoEditorScreen
import dev.centraid.android.screens.PhotoLightboxScreen
import dev.centraid.android.screens.PhotoPickerScreen
import dev.centraid.android.screens.PhotoShelfScreen
import dev.centraid.android.screens.PhotosCollectionsScreen
import dev.centraid.android.screens.PhotosGridScreen
import dev.centraid.android.screens.PhotosMemoriesScreen
import dev.centraid.android.screens.PhotosPeopleScreen
import dev.centraid.android.screens.PhotosSearchBar
import dev.centraid.android.screens.PhotosSearchScreen
import dev.centraid.android.screens.PhotosSelectionBar
import dev.centraid.android.screens.PhotosSheets
import dev.centraid.android.screens.PlacesScreen
import dev.centraid.android.screens.RouteNav
import dev.centraid.android.screens.exportShelfCopies
import dev.centraid.android.screens.installPhotoEditRenderer
import dev.centraid.android.screens.photosBandTabs
import dev.centraid.shared.apps.photos.DuplicateReviewBridge
import dev.centraid.shared.apps.photos.DuplicatesBridge
import dev.centraid.shared.apps.photos.FaceReviewBridge
import dev.centraid.shared.apps.photos.LibraryCopies
import dev.centraid.shared.apps.photos.PhotoEditorBridge
import dev.centraid.shared.apps.photos.PhotoLightboxBridge
import dev.centraid.shared.apps.photos.PhotoPickerBridge
import dev.centraid.shared.apps.photos.PhotoShelfBridge
import dev.centraid.shared.apps.photos.PhotosCollectionsBridge
import dev.centraid.shared.apps.photos.PhotosGridMachine
import dev.centraid.shared.apps.photos.PhotosGridWiring
import dev.centraid.shared.apps.photos.PhotosMemoriesBridge
import dev.centraid.shared.apps.photos.PhotosMemoriesMachine
import dev.centraid.shared.apps.photos.PhotosPeopleBridge
import dev.centraid.shared.apps.photos.PhotosPeopleMachine
import dev.centraid.shared.apps.photos.PhotosSearchBridge
import dev.centraid.shared.apps.photos.PlacesBridge
import dev.centraid.shared.apps.photos.PlacesMachine
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.CameraRoll
import dev.centraid.shared.shell.CameraRollRunner
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.shell.Shelf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * THE PHOTOS MINIAPP'S ROUTES (#1029, photos port): the library and its
 * eleven pushed screens, moved out of `MainActivity` unchanged (K5).
 *
 * **The eleven are held as BRIDGES and not as bare [ScreenHost]s.** Compose
 * collects the grid's host directly, but a screen with more than one read has
 * nothing to hand `attachScreen`:
 *
 * * **Collections, People and Faces have no `ScreenReads` at all.** Their
 *   reads are a FAN-OUT folded into one state; the trip lives in the bridge
 *   and `changes.route(host)` is what it calls instead.
 * * **The lightbox, Duplicates and Duplicate review carry LEGS whose
 *   constructors are `internal`** to `:shared`, so only the bridge can write
 *   `attachReads(host, PhotoLightboxLeg(leg))`.
 *
 * One instance per screen for the life of the activity, never re-created:
 * `ChangeStream.route` is registration with no removal, so a second host would
 * leave the routed one drawing into nothing.
 */
public class PhotosRoutes(private val cacheDir: java.io.File) : AppRoutes {
    private val photos = ScreenHost(PhotosGridMachine)

    /** "Send a copy" over the library's selection, onto [photos] (`LibraryCopies`). */
    private val photosCopies = LibraryCopies(photos)
    private val photoShelf = PhotoShelfBridge()
    private val photoLightbox = PhotoLightboxBridge()
    private val photoPicker = PhotoPickerBridge()
    private val places = PlacesBridge()
    private val photosPeople = PhotosPeopleBridge()
    private val faceReview = FaceReviewBridge()
    private val photosMemories = PhotosMemoriesBridge()
    private val duplicates = DuplicatesBridge()
    private val duplicateReview = DuplicateReviewBridge()
    private val photosCollections = PhotosCollectionsBridge()
    private val photosSearch = PhotosSearchBridge()
    private val photoEditor = PhotoEditorBridge()

    /**
     * THE CAMERA ROLL'S RUNNER, held so the Photos screen's "Back up now" has
     * something to call (#1025 S6). Built on attach, because a roll is walked
     * per VAULT. Compose state, so the screens see it arrive.
     */
    private val cameraRoll: MutableState<CameraRollRunner?> = mutableStateOf(null)

    override fun handles(destination: Destination): Boolean = when (destination) {
        is Destination.PhotosHome,
        is Destination.PhotoShelfRoute,
        is Destination.PhotoLightbox,
        is Destination.PhotoEditor,
        is Destination.PhotoPicker,
        is Destination.Places,
        is Destination.PhotosPeople,
        is Destination.PhotoFaceReview,
        is Destination.PhotosMemories,
        is Destination.PhotoDuplicates,
        is Destination.PhotoDuplicateReview,
        -> true
        else -> false
    }

    override fun opens(moveId: String): Destination? = if (moveId == "photos") Destination.PhotosHome() else null

    override fun attach(session: HomeSession, scope: CoroutineScope) {
        val opened = session
        // THE LIBRARY'S PAGE, ITS WRITES, ITS ALBUM LIST AND ITS STORED TILE
        // SIZE, in the one call iOS's bridge makes too (#1029, photos port).
        PhotosGridWiring.attach(opened, photos, scope, platformServices().secureStore)
        photosCopies.attach(opened)
        // Each `attach` is the bridge's, which is either `attachScreen` plus
        // its legs or `changes.route` plus a fan-out. **Called exactly once**,
        // because routing is registration with no removal.
        photoShelf.attach(opened)
        photoLightbox.attach(opened)
        photoPicker.attach(opened)
        places.attach(opened)
        photosPeople.attach(opened)
        faceReview.attach(opened)
        photosMemories.attach(opened)
        duplicates.attach(opened)
        duplicateReview.attach(opened)
        photosCollections.attach(opened)
        photosSearch.attach(opened)
        // THE EDITOR'S SAVE RENDERS HERE, on this shell's own decoder, and
        // ingests through the bridge (#1029).
        installPhotoEditRenderer(photoEditor, cacheDir)
        photoEditor.attach(opened)
        // THE PHOTOS SCREEN'S OTHER PLANE (#1025 S6). The grid reads the
        // vault; this reads the CAMERA ROLL. Android builds it here rather
        // than through `PhotosBridge`, which is iOS's holder.
        val platform = platformServices()
        cameraRoll.value = CameraRollRunner(
            services = platform,
            roll = CameraRoll(
                services = platform,
                core = { opened.shelf.core() },
                // A BACKUP IS A WRITE (#1029 F1). A vault that moved to the
                // member's other phone takes no photographs.
                readOnly = {
                    if (opened.shelf.foregroundHolding()?.readOnly == true) {
                        Shelf.MOVED_SENTENCE
                    } else {
                        null
                    }
                },
            ),
            host = photos,
            scope = scope,
            vaultId = { opened.shelf.foregroundHolding()?.vaultId },
        ).also { it.start() }
    }

    /**
     * THE BAND IS THE SPECIAL CASE, and it is doctrine 1 read backwards.
     * Moving to Collections is not a push (`withPhotosDestination` swaps the
     * top entry in place), so there is no entry for back to pop — back returns
     * the parameter to the library rather than popping Photos whole. AND THE
     * MACHINE IS TOLD: the destination is on `PhotosGridState` as well as on
     * the route, and a shell that moved one without the other would be two
     * places disagreeing about where the member is standing.
     */
    override fun back(stack: NavStack, scope: CoroutineScope): NavStack? {
        val top = stack.current
        if (top !is Destination.PhotosHome ||
            top.destination == PhotosGridState.Destination.DESTINATION_LIBRARY
        ) {
            return null
        }
        scope.launch {
            photos.send(
                PhotosGridEvent(
                    destination = PhotosGridEvent.DestinationChanged(
                        PhotosGridState.Destination.DESTINATION_LIBRARY,
                    ),
                ),
            )
        }
        return stack.withPhotosDestination(PhotosGridState.Destination.DESTINATION_LIBRARY)
    }

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
        var stack by nav
        val scope = nav.scope
        val cameraRoll = this.cameraRoll
        when (destination) {
            // A BAND DESTINATION IS A PARAMETER, NOT A PUSH (doctrine 1,
            // D-1020-E3). All three of these are ONE destination with a
            // different `PhotosGridState.Destination` on it, which is
            // why `NavStack.withPhotosDestination` exists and why there
            // is no `Destination.PhotosCollections` to route to: a push
            // per band would make back walk through the bands a member
            // happened to tap.
            is Destination.PhotosHome -> {
                val band = destination.destination
                val gridState by photos.state.collectAsStateWithLifecycle()
                val searchState by photosSearch.host.state.collectAsStateWithLifecycle()
                val focusManager = LocalFocusManager.current
                // WHERE THE SEARCH ROW'S WAY BACK GOES: the band the
                // member came to Search from. Remembered here because
                // the state carries only the band on screen, and "the
                // one before" is a fact about this visit, not the vault.
                var beforeSearch by remember {
                    mutableStateOf(PhotosGridState.Destination.DESTINATION_LIBRARY)
                }
                LaunchedEffect(band) {
                    if (band != PhotosGridState.Destination.DESTINATION_SEARCH &&
                        band != PhotosGridState.Destination.DESTINATION_UNSPECIFIED
                    ) {
                        beforeSearch = band
                    }
                }
                val movePhotos: (PhotosGridState.Destination) -> Unit = { next ->
                    stack = stack.withPhotosDestination(next)
                    scope.launch {
                        photos.send(
                            PhotosGridEvent(
                                destination = PhotosGridEvent.DestinationChanged(next),
                            ),
                        )
                    }
                }
                // A SCROLL THROUGH THE HITS PUTS THE KEYBOARD AWAY, as
                // the system's search does: the member has stopped
                // typing and started looking.
                val dismissOnScroll = remember(focusManager) {
                    object : NestedScrollConnection {
                        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                            if (available.y != 0f) focusManager.clearFocus()
                            return Offset.Zero
                        }
                    }
                }
                Column(Modifier.fillMaxSize()) {
                    Box(Modifier.weight(1f).nestedScroll(dismissOnScroll)) {
                    when (destination.destination) {
                        PhotosGridState.Destination.DESTINATION_COLLECTIONS -> {
                            // Keyed on the band and not on `destination`: the
                            // two differ only by the band, so this is the same
                            // key said in the form that shows what it means.
                            LaunchedEffect(destination.destination) {
                                photosCollections.opened()
                            }
                            val state by photosCollections.host.state
                                .collectAsStateWithLifecycle()
                            PhotosCollectionsScreen(
                                state = state,
                                onEvent = { event ->
                                    scope.launch { photosCollections.host.send(event) }
                                },
                                // COLLECTIONS IS THE HUB, and this is the whole
                                // of it: the four standing shelves, every album
                                // and the four doors all leave from here. The
                                // grid's More sheet says so in as many words —
                                // "The rest of Photos is in Collections."
                                //
                                // The shelf arrives WHOLE, so nothing here
                                // composes a `PhotoShelf`: the row already
                                // carries the one the read built, names and all.
                                onOpenShelf = { shelf ->
                                    stack = stack.push(Destination.PhotoShelfRoute(shelf))
                                },
                                onOpenDoor = { kind ->
                                    stack = when (kind) {
                                        CollectionsDoor.Kind.KIND_PEOPLE ->
                                            stack.push(Destination.PhotosPeople)
                                        CollectionsDoor.Kind.KIND_PLACES ->
                                            stack.push(Destination.Places())
                                        CollectionsDoor.Kind.KIND_MEMORIES ->
                                            stack.push(Destination.PhotosMemories)
                                        CollectionsDoor.Kind.KIND_DUPLICATES ->
                                            stack.push(Destination.PhotoDuplicates)
                                        // A door whose kind did not decode is a
                                        // door this build does not have. The
                                        // stack stays put rather than pushing a
                                        // blank cover, which is what the Home
                                        // springboard does with a move it has no
                                        // destination for.
                                        CollectionsDoor.Kind.KIND_UNSPECIFIED -> stack
                                    }
                                },
                            )
                        }

                        PhotosGridState.Destination.DESTINATION_SEARCH -> {
                            LaunchedEffect(destination.destination) { photosSearch.opened() }
                            val state by photosSearch.host.state.collectAsStateWithLifecycle()
                            PhotosSearchScreen(
                                state = state,
                                onEvent = { event ->
                                    scope.launch { photosSearch.host.send(event) }
                                },
                                onOpenAsset = { assetId ->
                                    // THE HITS' OWN ORDER AS NEIGHBOURS, so a
                                    // swipe in the lightbox needs no read and
                                    // walks the results the member is looking
                                    // at rather than the whole library.
                                    stack = stack.push(
                                        Destination.PhotoLightbox(
                                            assetId = assetId,
                                            neighbours = state.hits?.cells
                                                ?.map { cell -> cell.asset_id }
                                                .orEmpty(),
                                        ),
                                    )
                                },
                                // A PERSON, PLACE OR ALBUM THE QUERY NAMED:
                                // the shelf arrives whole, built by the read.
                                onOpenShelf = { shelf ->
                                    stack = stack.push(Destination.PhotoShelfRoute(shelf))
                                },
                            )
                        }

                        else -> {
                            // Re-read the OS grant before Opened (R-PHOTOS-1): a
                            // grant that landed after session attach must be on
                            // state at first paint, or the banner still offers
                            // "Allow photo access".
                            LaunchedEffect(destination) {
                                cameraRoll.value?.syncPermission()
                                photos.send(PhotosGridEvent(opened = PhotosGridEvent.Opened()))
                            }
                            val state by photos.state.collectAsStateWithLifecycle()
                            PhotosGridScreen(
                                state = state,
                                onEvent = { event ->
                                    // THE BAND ROW IS INSIDE THIS SCREEN, so
                                    // the press arrives as an event and the
                                    // route has to be moved from here. Both,
                                    // and in this order: the destination is on
                                    // `PhotosGridState` as well as on the
                                    // route, and forwarding only one would
                                    // leave the two disagreeing. Tally's band
                                    // does the same thing through a callback,
                                    // which is the only difference.
                                    val band = event.destination
                                    if (band != null) {
                                        stack = stack.withPhotosDestination(band.destination)
                                    }
                                    scope.launch { photos.send(event) }
                                },
                                onBackUpNow = {
                                    scope.launch { cameraRoll.value?.pass() }
                                },
                                // THE LIBRARY GRID'S WAY INTO THE LIGHTBOX.
                                // The shelf and search both had one and this
                                // did not, so the one surface a member starts
                                // on was the one that could not open a
                                // photograph.
                                onOpenAsset = { assetId, neighbours ->
                                    stack = stack.push(
                                        Destination.PhotoLightbox(assetId, neighbours),
                                    )
                                },
                            )
                        }
                    }
                    }
                    // THE FOOT: Photos' band, or — on Search — the
                    // search row in the band's place, as the system
                    // Photos app replaces its tab bar rather than
                    // stacking a field over it.
                    if (band == PhotosGridState.Destination.DESTINATION_SEARCH) {
                        val back = photosBandTabs(beforeSearch).first { it.selected }
                        PhotosSearchBar(
                            query = searchState.query,
                            onQuery = { query ->
                                scope.launch {
                                    photosSearch.host.send(
                                        PhotosSearchEvent(
                                            query = PhotosSearchEvent.QueryChanged(query = query),
                                        ),
                                    )
                                }
                            },
                            returnIconKey = back.iconKey,
                            returnLabel = back.label,
                            onReturn = { movePhotos(beforeSearch) },
                            onClose = {
                                scope.launch {
                                    photosSearch.host.send(
                                        PhotosSearchEvent(
                                            query = PhotosSearchEvent.QueryChanged(query = ""),
                                        ),
                                    )
                                }
                                movePhotos(beforeSearch)
                            },
                        )
                    } else if (
                        gridState.selecting &&
                        band != PhotosGridState.Destination.DESTINATION_COLLECTIONS
                    ) {
                        // A SELECTION TAKES THE BAND'S PLACE (Apple
                        // Photos; v0's room), so a tap aimed at Trash
                        // cannot land on a destination.
                        val copyContext = androidx.compose.ui.platform.LocalContext.current
                        PhotosSelectionBar(
                            state = gridState,
                            onEvent = { event -> scope.launch { photos.send(event) } },
                            // THE SHELF'S BATCH HAND-OFF, pointed at the
                            // library's pick (`PhotoShelfCopies.kt`).
                            onSendCopy = { assetIds, export ->
                                scope.launch { exportShelfCopies(copyContext, photosCopies, assetIds, export) }
                            },
                        )
                    } else {
                        AppBand(
                            app = "photos",
                            tabs = photosBandTabs(band),
                            onSelect = { key ->
                                movePhotos(PhotosGridState.Destination.valueOf(key))
                            },
                            onHome = { stack = NavStack() },
                            // `more` IS A SHEET, NEVER A DESTINATION.
                            onMore = {
                                scope.launch {
                                    photos.send(
                                        PhotosGridEvent(
                                            sheet = PhotosGridEvent.SheetChanged(
                                                PhotosGridState.Sheet.SHEET_MORE,
                                            ),
                                        ),
                                    )
                                }
                            },
                        )
                    }
                }
                // WHICH SHEET IS OPEN IS STATE — read here, beside the
                // band that opens it, so More works from every band and
                // not only from the library body.
                PhotosSheets(
                    state = gridState,
                    onEvent = { event -> scope.launch { photos.send(event) } },
                    onBackUpNow = { scope.launch { cameraRoll.value?.pass() } },
                )
            }


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

            is Destination.PhotosPeople -> {
                LaunchedEffect(destination) { photosPeople.opened() }
                val state by photosPeople.host.state.collectAsStateWithLifecycle()
                PhotosPeopleScreen(
                    state = state,
                    onEvent = { event -> scope.launch { photosPeople.host.send(event) } },
                    onOpenPerson = { person ->
                        stack = stack.push(
                            Destination.PhotoShelfRoute(
                                PhotosPeopleMachine.shelfFor(person),
                            ),
                        )
                    },
                    onOpenFaceReview = {
                        stack = stack.push(Destination.PhotoFaceReview)
                    },
                )
            }

            is Destination.PhotoFaceReview -> {
                LaunchedEffect(destination) { faceReview.opened() }
                val state by faceReview.host.state.collectAsStateWithLifecycle()
                FaceReviewScreen(
                    state = state,
                    onEvent = { event -> scope.launch { faceReview.host.send(event) } },
                )
            }

            is Destination.PhotosMemories -> {
                LaunchedEffect(destination) { photosMemories.opened() }
                val state by photosMemories.host.state.collectAsStateWithLifecycle()
                PhotosMemoriesScreen(
                    state = state,
                    onEvent = { event ->
                        scope.launch { photosMemories.host.send(event) }
                    },
                    onOpenMemory = { row ->
                        stack = stack.push(
                            Destination.PhotoShelfRoute(
                                PhotosMemoriesMachine.shelfFor(row),
                            ),
                        )
                    },
                )
            }

            is Destination.PhotoDuplicates -> {
                LaunchedEffect(destination) { duplicates.opened() }
                val state by duplicates.host.state.collectAsStateWithLifecycle()
                DuplicatesScreen(
                    state = state,
                    onEvent = { event -> scope.launch { duplicates.host.send(event) } },
                    onOpenCluster = { clusterId ->
                        stack = stack.push(Destination.PhotoDuplicateReview(clusterId))
                    },
                )
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
                DuplicateReviewScreen(
                    state = state,
                    onEvent = { event ->
                        scope.launch { duplicateReview.host.send(event) }
                    },
                )
            }

            else -> Unit
        }
    }
}
