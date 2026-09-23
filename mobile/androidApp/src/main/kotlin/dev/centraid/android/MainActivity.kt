package dev.centraid.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalView
import androidx.compose.runtime.SideEffect
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.core.view.WindowCompat
import dev.centraid.android.kit.AppBand
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.screens.PhotosSearchBar
import dev.centraid.android.screens.PhotosSheets
import dev.centraid.android.screens.PhotosSelectionBar
import dev.centraid.android.screens.photosBandTabs
import dev.centraid.android.screens.tallyBandTabs
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
// `var x by mutableStateOf(...)` needs BOTH operators in scope. Only
// `getValue` was imported, so the read compiled and the write did not
// (#1020, wave A) — the whole `by` delegate fails on the setter alone.
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.CollectionsDoor
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.PhotosGridEvent
import centraid.screen.v1.PhotosGridState
import centraid.screen.v1.PhotosSearchEvent
import centraid.screen.v1.TallyListEvent
import centraid.screen.v1.TallyListState
import android.os.Build
import dev.centraid.shared.platform.SyncPass
import dev.centraid.shared.sync.DrainPass
import dev.centraid.android.kit.MakeVaultSheet
import dev.centraid.android.kit.TransferRulesSheet
import dev.centraid.android.screens.DuplicateReviewScreen
import dev.centraid.android.screens.DuplicatesScreen
import dev.centraid.android.screens.FaceReviewScreen
import dev.centraid.android.screens.HomeScreen
import dev.centraid.android.screens.NotesEditorScreen
import dev.centraid.android.screens.LocalPhotoEditOpener
import dev.centraid.android.screens.PhotoEditorScreen
import dev.centraid.android.screens.PhotoLightboxScreen
import dev.centraid.android.screens.installPhotoEditRenderer
import dev.centraid.android.screens.PhotoPickerScreen
import dev.centraid.android.screens.PhotoShelfScreen
import dev.centraid.android.screens.exportShelfCopies
import dev.centraid.android.screens.PhotosCollectionsScreen
import dev.centraid.android.screens.PhotosGridScreen
import dev.centraid.android.screens.PhotosMemoriesScreen
import dev.centraid.android.screens.PhotosPeopleScreen
import dev.centraid.android.screens.PhotosSearchScreen
import dev.centraid.android.screens.PlacesScreen
import dev.centraid.android.screens.TallyListScreen
import dev.centraid.android.theme.CentraidTheme
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.shell.HomeMachine
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.apps.notes.NotesEditorMachine
import dev.centraid.shared.apps.notes.NotesReads
import dev.centraid.shared.apps.photos.DuplicateReviewBridge
import dev.centraid.shared.apps.photos.DuplicatesBridge
import dev.centraid.shared.apps.photos.FaceReviewBridge
import dev.centraid.shared.apps.photos.PhotoEditorBridge
import dev.centraid.shared.apps.photos.PhotoLightboxBridge
import dev.centraid.shared.apps.photos.PhotoPickerBridge
import dev.centraid.shared.apps.photos.PhotoShelfBridge
import dev.centraid.shared.apps.photos.PhotosCollectionsBridge
import dev.centraid.shared.apps.photos.PhotosGridMachine
import dev.centraid.shared.apps.photos.PhotosMemoriesBridge
import dev.centraid.shared.apps.photos.PhotosMemoriesMachine
import dev.centraid.shared.apps.photos.PhotosPeopleBridge
import dev.centraid.shared.apps.photos.PhotosPeopleMachine
import dev.centraid.shared.apps.photos.LibraryCopies
import dev.centraid.shared.apps.photos.PhotosGridWiring
import dev.centraid.shared.apps.photos.PhotosSearchBridge
import dev.centraid.shared.apps.photos.PlacesBridge
import dev.centraid.shared.apps.photos.PlacesMachine
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.apps.tally.TallyListMachine
import dev.centraid.shared.apps.tally.TallyReads
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.shell.CameraRoll
import dev.centraid.shared.shell.FoundResult
import dev.centraid.shared.shell.TransferRuleChoice
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.sync.TransferRule
import dev.centraid.shared.shell.CameraRollRunner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The composition root, and the only file allowed to name screens from every
 * app (#1020).
 *
 * ONE ROOT STACK, NO BOTTOM TABS — apps are covers over Home.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
public class MainActivity : ComponentActivity() {
    /**
     * HOME OVER A REAL VAULT.
     *
     * `HomeSession` owns the host, the core and the effect runner; this
     * activity owns only the file path, which is the one part that is
     * genuinely Android's. Opened off the main thread because
     * `centraid_open` asserts it is not on the UI thread — and the assertion
     * is the thing standing between a well-meaning `LaunchedEffect` and a
     * frozen app.
     */
    private var session: HomeSession? = null

    /**
     * What Home draws while the core is opening.
     *
     * `HomeMachine.initial()` and nothing else: loading, no data, no tiles. It
     * is a value rather than a nullable branch in the composable because "the
     * session is not ready" and "the session has no data" are the same screen,
     * and a view that had to know the difference would be a view that decides.
     */
    private val fallbackHome =
        kotlinx.coroutines.flow.MutableStateFlow(HomeMachine.initial()).asStateFlow()
    private val tally = ScreenHost(TallyListMachine)
    private val photos = ScreenHost(PhotosGridMachine)

    /** "Send a copy" over the library's selection, onto [photos] (`LibraryCopies`). */
    private val photosCopies = LibraryCopies(photos)
    private val notes = ScreenHost(NotesEditorMachine)

    /**
     * THE PHOTOS MINIAPP'S OTHER ELEVEN SCREENS (#1029, photos port).
     *
     * **They are held as BRIDGES and not as bare [ScreenHost]s**, which is the
     * one place this file departs from the three above, so the reason is here
     * rather than repeated eleven times. `PhotosBridge`'s own note says Android
     * does not use it — Compose collects the host's `StateFlow` directly — and
     * that is still true of the grid. It stops being true the moment a screen
     * needs more than one read, and eight of these do:
     *
     * * **Collections, People and Faces have no `ScreenReads` at all.** Their
     *   reads are a FAN-OUT — ten statements, three, four — folded into one
     *   state, which `HomeSession.attachReads`' own note calls the shape a
     *   partial answer cannot render. There is nothing to hand `attachScreen`;
     *   the trip lives in the bridge and `changes.route(host)` is what it calls
     *   instead.
     * * **The lightbox, Duplicates and Duplicate review carry LEGS whose
     *   constructors are `internal`** (`PhotoLightboxLeg`, `DuplicatesLeg`,
     *   `DuplicateReviewLeg`). `:androidApp` is a different Gradle module from
     *   `:shared`, so `internal` is not visible here and this file *cannot*
     *   write `attachReads(host, PhotoLightboxLeg(leg))` even though that is
     *   exactly what has to happen. The bridge is the only caller that can.
     *
     * So every new screen goes on the session the same way rather than five one
     * way and six the other: a file with two idioms is a file where the next
     * screen's author has to work out which one their screen is. Each bridge
     * exposes `host` for precisely this — Compose sends to it and collects it
     * directly, and `observe`/`send`'s encode-decode pair stays iOS's.
     *
     * One instance per screen for the life of the activity, never re-created:
     * `ChangeStream.route` is registration with no removal, so a second host
     * would leave the routed one drawing into nothing.
     */
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
     * THE OS ASKING FOR MEMORY BACK (#1025 S7-13, ruling F).
     *
     * Every held vault's core is open, so a switch is a pointer move rather
     * than a SQLite close-and-open. The bound on that is not a count of cores —
     * that would make "is this vault open" depend on how recently some other
     * vault was touched — it is this callback: every core but the foreground's
     * closes, and a rested vault reopens on the next tap or the next sync
     * round.
     *
     * Every level, including the trims Android sends a BACKGROUNDED process.
     * A phone the member is not looking at is exactly when giving the memory
     * back costs nothing.
     */
    // `onResume` AND `onPause` ARE GONE FROM THIS ACTIVITY (#1029 §1). They
    // ran `HomeSession.foreground()` and `leftTheForeground()`: catch every
    // holding up and hold the foreground one's log stream open while the member
    // is looking, close it when they leave. There is no gateway, no log stream
    // and no pass, so arriving and leaving are not occasions this shell acts
    // on. The vault is on the phone and it is already current.
    //
    // `onTrimMemory` STAYS, and it is now the only lifecycle hook here: giving
    // the OS its memory back is a fact about a device, not about a link.

    /**
     * THE FOREGROUND TRIGGER (#1029 W18-6).
     *
     * `onResume` came back, and it is not what it was. It used to run
     * `HomeSession.foreground()` — catch every holding up and hold the
     * foreground one's log stream open — and that whole shape left with the
     * gateway. What it does now is the amendment's foreground half: the phone
     * drains **while the member is in the app**, not only in the windows
     * WorkManager grants.
     *
     * Fire-and-forget on the IO dispatcher. `ShelfDrain` refuses a second pass
     * while one runs, so a rotation or a permission dialog costs nothing.
     */
    override fun onResume() {
        super.onResume()
        val open = session ?: return
        kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch { open.drain.onBecameActive() }
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        val open = session ?: return
        kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch { open.rest() }
    }

    override fun onDestroy() {
        // The core is a HANDLE and it is released here. One core per device
        // process (R-1020-24), so an activity that leaked one would refuse to
        // open the next.
        // CLOSED ON A SCOPE OF ITS OWN, because closing N cores is N ABI calls
        // and `centraid_close` does not belong on the UI thread.
        val going = session
        session = null
        if (going != null) {
            kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch {
                going.close()
            }
        }
        super.onDestroy()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // EDGE TO EDGE, and it owns the system bars' icon contrast. The page
        // ground is the emitted `bg` and it reaches the notch; the insets are
        // then paid back by `safeDrawingPadding` below, which is the only place
        // this shell knows a system bar exists.
        enableEdgeToEdge()
        // THE VAULT IS AN ARTIFACT THAT WAS PUT HERE, never founded on the
        // phone. `mobile/scripts/demo-vault.sh` seeds one and places it; the
        // asset copy below is what makes a fresh install carry it too. A core
        // opened with `create = true` in its place would found an empty vault
        // and the screen would be honestly, uselessly empty.
        //
        // EVERY `.sqlite3` IN `filesDir` IS A VAULT, and the directory is the
        // roster: no manifest sits beside it, because a manifest would be a
        // second place a vault's name and existence live. What each file is
        // CALLED is read out of the file itself; see `VaultRoster`.
        //
        // THE SUFFIX IS `Shelf.SUFFIX` AND NOTHING ELSE. This filter said
        // `.db`, which is what `mobile/scripts/demo-vault.sh` used to write,
        // and the shelf has taken only `*.sqlite3` since #1025 S7 — so a placed
        // fixture was copied into `filesDir` and then ignored by the roster that
        // was supposed to adopt it. Nothing failed: the switcher simply said the
        // device held one vault.
        for (name in assets.list("")?.filter { it.endsWith(Shelf.SUFFIX) }.orEmpty()) {
            val file = java.io.File(filesDir, name)
            if (file.exists()) continue
            runCatching {
                assets.open(name).use { source ->
                    file.outputStream().use { sink -> source.copyTo(sink) }
                }
            }.onFailure {
                // No asset and no file: the screen still runs and draws its
                // loading grid. An app that refused to start because a demo
                // fixture is missing would be worse than one that shows a Home
                // nothing lands in.
                android.util.Log.w("Centraid", "could not place $name: ${it.message}")
            }
        }
        // WHERE THIS DEVICE'S VAULTS LIVE, as a DIRECTORY and not a list of
        // paths (#1025 S5). The shell used to enumerate whatever `.db` files
        // had been placed in `filesDir` and hand the list over; a device makes
        // its own vaults now, so what it knows is where they go and `Shelf`
        // opens every file it finds. An empty directory is the ordinary first
        // run.
        val vaultDir = filesDir.absolutePath
        setContent {
            CentraidTheme {
                // The stack is shell state, not a library's: `NavStack` is
                // immutable and a swap is the navigation.
                var stack by androidx.compose.runtime.remember {
                    androidx.compose.runtime.mutableStateOf(NavStack())
                }
                val scope = androidx.compose.runtime.rememberCoroutineScope()
                // THE CAMERA ROLL'S RUNNER, held so the Photos screen's "Back
                // up now" has something to call (#1025 S6). It is built with
                // the session below, because a roll is walked per VAULT.
                val cameraRoll = androidx.compose.runtime.remember {
                    androidx.compose.runtime.mutableStateOf<CameraRollRunner?>(null)
                }
                // ONE SESSION FOR THE LIFE OF THE ACTIVITY. `produceState`
                // rather than `LaunchedEffect` + a `mutableStateOf`, so the
                // first composition already has a value to draw and the open
                // runs on the IO dispatcher exactly once.
                val homeSession by androidx.compose.runtime.produceState<HomeSession?>(null) {
                    value = HomeSession.open(
                        vaultDir = vaultDir,
                        services = platformServices(),
                        dispatcher = Dispatchers.IO,
                        uiThreadName = Thread.currentThread().name,
                    ).also { opened ->
                        session = opened
                        // THE BACKGROUND WINDOW NOW HAS SOMETHING TO RUN
                        // (#1029 W18-6). `AndroidBackgroundTasks.register()`
                        // enqueues `CentraidSyncWorker` every 15 minutes and
                        // that worker runs `SyncPass.installed` — which was
                        // null on every device, so every window was a
                        // `Result.success()` over nothing. This is the install.
                        //
                        // **WorkManager's stop signal IS the deadline.** A
                        // worker gets about ten minutes before `onStopped`, so
                        // the budget is that minus a margin to finish the
                        // object in flight; a drain stopped short resumes next
                        // window, because the spool never loses a sealed
                        // object.
                        SyncPass.install {
                            opened.drain.run(SyncPass.WORK_MANAGER_BUDGET_MS)
                                .all { outcome ->
                                    val done = outcome.outcome
                                    done is DrainPass.Outcome.Ran && done.answer.drained
                                }
                        }
                        // AND THE FIRST FOREGROUND PASS, which `onResume` below
                        // would otherwise miss: the activity resumed before the
                        // session existed.
                        opened.drain.onBecameActive()
                        // THE APP SCREENS GO ON THE SAME CORE (#1025 S5, lane
                        // L5). R-1020-24 is one core per VAULT FILE, so Tally,
                        // Photos and Notes read through the handle this session
                        // holds rather than opening their own — and until this
                        // existed nothing served their `ReadPage` effects at
                        // all, so all three sat on their seeded `LOADING` state
                        // for ever.
                        //
                        // `attachScreen` also routes the host onto the change
                        // stream, so a row that arrives from sync moves the
                        // screen without a tap.
                        opened.attachScreen(tally, TallyReads)
                        // THE LIBRARY'S PAGE, ITS WRITES, ITS ALBUM LIST AND ITS
                        // STORED TILE SIZE, in the one call iOS's bridge makes
                        // too (#1029, photos port).
                        PhotosGridWiring.attach(opened, photos, scope, platformServices().secureStore)
                        photosCopies.attach(opened)
                        opened.attachScreen(notes, NotesReads, NotesReads)
                        // AND THE REST OF PHOTOS, ON THE SAME CORE AND FOR THE
                        // SAME REASON (#1029, photos port). Eleven screens
                        // landed with machines, reads and views and nothing
                        // routed to them, so every one of them was a screen
                        // that could not be reached and would have sat on its
                        // seeded LOADING if it had been.
                        //
                        // Each `attach` is the bridge's, which is either
                        // `attachScreen` plus its legs or `changes.route` plus
                        // a fan-out — see the field block above for which is
                        // which and why this file does not make that choice
                        // itself. **Called exactly once**, here, because
                        // routing is registration with no removal: a host
                        // routed twice answers every change event with two
                        // re-reads for ever.
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
                        // THE EDITOR'S SAVE RENDERS HERE, on this shell's own
                        // decoder, and ingests through the bridge (#1029).
                        installPhotoEditRenderer(photoEditor, cacheDir)
                        photoEditor.attach(opened)
                        // THE PHOTOS SCREEN'S OTHER PLANE (#1025 S6). The grid
                        // reads the vault; this reads the CAMERA ROLL. Nothing
                        // collected `ScreenEffect.Backup` or
                        // `RequestMediaPermission` before this, so the permission
                        // button emitted into a flow with no subscriber and no
                        // photograph on this phone could ever reach a vault.
                        //
                        // Android builds it here rather than through
                        // `PhotosBridge`, which is iOS's holder: Compose collects
                        // the host directly, so there is no bridge on this side
                        // to hang it on.
                        val platform = platformServices()
                        cameraRoll.value = CameraRollRunner(
                            services = platform,
                            roll = CameraRoll(
                                services = platform,
                                core = { opened.shelf.core() },
                                // A BACKUP IS A WRITE (#1029 F1). A vault that
                                // moved to the member's other phone takes no
                                // photographs.
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
                }
                // BACK IS THE STACK'S, AND A BAND IS NOT A STEP IN IT.
                //
                // **There was no back handling in this activity at all**, and
                // with three covers over Home that was survivable: the system
                // gesture finished the activity and a member reopened where
                // they left off. It stops being survivable at eleven more
                // screens, because Collections → a shelf → the lightbox is
                // three pushes deep and every one of them would have been a
                // one-way trip out of Photos.
                //
                // DISABLED AT HOME, so the floor keeps the platform's own
                // meaning: back out of the app. `NavStack.pop` refuses to pop
                // the floor anyway — this is the difference between a gesture
                // that does nothing and a gesture that leaves.
                //
                // THE BAND IS THE SPECIAL CASE, and it is doctrine 1 read
                // backwards. Moving to Collections is not a push
                // (`withPhotosDestination` swaps the top entry in place), so
                // there is no entry for back to pop — and the band row itself
                // lives inside `PhotosGridScreen`, which is the LIBRARY band's
                // body, so a member standing in Collections has nothing on
                // screen that offers the way back. Back returns the parameter
                // to the library rather than popping Photos whole.
                BackHandler(enabled = stack.entries.size > 1) {
                    val top = stack.current
                    if (top is Destination.PhotosHome &&
                        top.destination != PhotosGridState.Destination.DESTINATION_LIBRARY
                    ) {
                        stack = stack.withPhotosDestination(
                            PhotosGridState.Destination.DESTINATION_LIBRARY,
                        )
                        // AND THE MACHINE IS TOLD, for the reason the band row
                        // tells it: the destination is on `PhotosGridState` as
                        // well as on the route, and a shell that moved one
                        // without the other would be two places disagreeing
                        // about where the member is standing.
                        scope.launch {
                            photos.send(
                                PhotosGridEvent(
                                    destination = PhotosGridEvent.DestinationChanged(
                                        PhotosGridState.Destination.DESTINATION_LIBRARY,
                                    ),
                                ),
                            )
                        }
                    } else {
                        stack = stack.pop()
                    }
                }
                // THE GROUND IS PAINTED HERE, under the insets: the window's own
                // background is transparent, and a screen that paints none (the
                // Photos pages) would otherwise sit on black. A photograph's
                // screens stand on `stage` edge to edge, as iOS draws them, so
                // the ground under the system bars follows, and the bars' icons
                // turn light to be read on it.
                val onStage = stack.current is Destination.PhotoLightbox ||
                    stack.current is Destination.PhotoEditor
                val view = LocalView.current
                val darkScheme = isSystemInDarkTheme()
                SideEffect {
                    WindowCompat.getInsetsController(window, view).apply {
                        val light = !onStage && !darkScheme
                        isAppearanceLightStatusBars = light
                        isAppearanceLightNavigationBars = light
                    }
                }
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(centraidColor(if (onStage) "stage" else "bg"))
                        .safeDrawingPadding(),
                ) {
                when (val destination = stack.current) {
                    is Destination.TallyHome -> {
                        // A SCREEN READS BECAUSE IT WAS OPENED (#1025 S5, lane
                        // L5). The machine emits its first `ReadPage` from
                        // `Opened` and from nothing else, so a cover that was
                        // pushed and never told would sit loading for ever.
                        // Keyed on the destination, so coming back re-reads
                        // rather than showing the page the member left.
                        LaunchedEffect(destination) {
                            tally.send(TallyListEvent(opened = TallyListEvent.Opened()))
                        }
                        val state by tally.state.collectAsStateWithLifecycle()
                        val moveTally: (TallyListState.Destination) -> Unit = { band ->
                            stack = stack.withTallyDestination(band)
                            scope.launch {
                                tally.send(
                                    TallyListEvent(
                                        destination =
                                            TallyListEvent.DestinationChanged(band),
                                    ),
                                )
                            }
                        }
                        // THE BAND AT THE FOOT, under the page and never in it:
                        // the home circle and Tally's own plate (`AppBand`).
                        Column(Modifier.fillMaxSize()) {
                            Box(Modifier.weight(1f)) {
                                TallyListScreen(
                                    state = state,
                                    onEvent = { event -> scope.launch { tally.send(event) } },
                                    onBandChange = moveTally,
                                )
                            }
                            AppBand(
                                app = "tally",
                                tabs = tallyBandTabs(state.destination),
                                onSelect = { key ->
                                    moveTally(TallyListState.Destination.valueOf(key))
                                },
                                onHome = { stack = NavStack() },
                            )
                        }
                    }

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

                    is Destination.NotesEditor -> {
                        // THE NOTE'S ID RIDES ON THE EVENT, because the
                        // editor's read is parameterised by it: `NotesReads`
                        // binds it into the predicate, and an editor opened
                        // without one reads nothing rather than reading
                        // whichever note sorted first.
                        LaunchedEffect(destination) {
                            notes.send(
                                NotesEditorEvent(
                                    opened = NotesEditorEvent.Opened(
                                        note_id = destination.noteId,
                                    ),
                                ),
                            )
                        }
                        val state by notes.state.collectAsStateWithLifecycle()
                        NotesEditorScreen(
                            state = state,
                            onEvent = { event -> scope.launch { notes.send(event) } },
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

                    // HOME IS THE FLOOR, and it is a real screen now: the
                    // graded springboard over `HomeMachine`, not a list of
                    // links (#1020, wave A). A first move names WHERE it goes
                    // and the stack takes it there — the screen itself
                    // navigates nothing.
                    else -> {
                        val live = homeSession
                        val state by (live?.state ?: fallbackHome).collectAsStateWithLifecycle()
                        // THE TRANSFER RULES (#1025 S4). Read from the secure
                        // store when the sheet OPENS and not held since launch:
                        // the store is the authority, and a value cached at
                        // launch is one a restore may have moved underneath.
                        var rulesOpen by remember { mutableStateOf(false) }
                        var rule by remember { mutableStateOf("") }
                        // THE VAULT SHEET (#1029 §1). Same door as iOS
                        // Settings → Vault; the empty roster's button opens it.
                        // It was the GATEWAY sheet and it pairs with nothing
                        // now: the one act it offers is founding a vault here.
                        var vaultSheetOpen by remember { mutableStateOf(false) }
                        var vaultWorking by remember { mutableStateOf(false) }
                        // R-SHELL-2: member-visible sentences name the
                        // foreground holding. Cleared on forget / switch.
                        var vaultStatus by remember { mutableStateOf("") }
                        HomeScreen(
                            state = state,
                            onEvent = { event ->
                                val picked = event.move_picked
                                if (picked != null) {
                                    val before = stack
                                    stack = when (picked.move_id) {
                                        "tally" -> stack.push(Destination.TallyHome())
                                        "photos" -> stack.push(Destination.PhotosHome())
                                        "notes" ->
                                            stack.push(Destination.NotesEditor("note-0001"))
                                        // The other moves have no destination in
                                        // this shell yet; the stack stays put
                                        // rather than pushing a blank cover.
                                        else -> stack
                                    }
                                    // A PICK FROM THE ALL-APPS SHEET closes it —
                                    // but only when it went somewhere. An app
                                    // with no screen leaves the member in the
                                    // listing, as its tile leaves them on Home,
                                    // rather than shutting the sheet on nothing.
                                    if (stack !== before && state.all_apps_sheet_open) {
                                        live?.send(
                                            HomeEvent(
                                                all_apps = HomeEvent.AllAppsSheetToggled(open_ = false),
                                            ),
                                        )
                                    }
                                }
                                val vaultPick = event.vault_picked
                                if (vaultPick != null &&
                                    vaultPick.vault_id.isNotEmpty() &&
                                    vaultPick.vault_id != state.vault?.vault_id
                                ) {
                                    vaultStatus = ""
                                }
                                live?.send(event)
                            },
                            // FORGETTING IS I/O, NOT AN EVENT (#1025 S7-9).
                            // `HomeSession.forget` closes the core, deletes the
                            // replica and rebinds onto whatever the shelf
                            // brings forward, so it is a `suspend` call and it
                            // goes on the same scope every other send uses
                            // rather than through a second plumbing layer. Off
                            // Explicitly on IO for the same reason `open` is:
                            // `centraid_open` asserts it is not on the main
                            // thread and the rebind opens a core, so a forget
                            // launched on the composition's Main-confined scope
                            // would trip that assertion rather than block.
                            onForget = { vaultId ->
                                scope.launch(Dispatchers.IO) {
                                    live?.forget(vaultId)
                                    withContext(Dispatchers.Main) { vaultStatus = "" }
                                }
                            },
                            onDownloadSettings = {
                                scope.launch {
                                    rule = TransferRule.read(
                                        platformServices().secureStore,
                                    ).stored
                                    vaultSheetOpen = false
                                    rulesOpen = true
                                }
                            },
                            onMakeVault = { vaultSheetOpen = true },
                        )
                        if (vaultSheetOpen) {
                            ModalBottomSheet(onDismissRequest = { vaultSheetOpen = false }) {
                                MakeVaultSheet(
                                    status = vaultStatus,
                                    working = vaultWorking,
                                    onFound = { done ->
                                        val open = live
                                        if (open == null) {
                                            vaultStatus = "This build has no core."
                                            done()
                                            return@MakeVaultSheet
                                        }
                                        vaultWorking = true
                                        // ON IO, for the reason `open` is:
                                        // `centraid_open` asserts it is not on
                                        // the main thread, and founding a vault
                                        // opens one.
                                        scope.launch(Dispatchers.IO) {
                                            val outcome = open.found()
                                            withContext(Dispatchers.Main) {
                                                vaultStatus = when (outcome) {
                                                    is FoundResult.Made ->
                                                        "Made ${outcome.vaultName}."
                                                    is FoundResult.Refused ->
                                                        outcome.sentence
                                                    FoundResult.NoSession ->
                                                        "Centraid is still opening."
                                                }
                                                vaultWorking = false
                                                done()
                                            }
                                        }
                                    },
                                    onOpenTransferRules = {
                                        scope.launch {
                                            rule = TransferRule.read(
                                                platformServices().secureStore,
                                            ).stored
                                            vaultSheetOpen = false
                                            rulesOpen = true
                                        }
                                    },
                                )
                            }
                        }
                        if (rulesOpen) {
                            ModalBottomSheet(onDismissRequest = { rulesOpen = false }) {
                                TransferRulesSheet(
                                    choices = TransferRule.entries.map {
                                        TransferRuleChoice(it.stored, it.sentence)
                                    },
                                    selected = rule,
                                    onPick = { picked ->
                                        scope.launch {
                                            val settled = TransferRule.of(picked)
                                            TransferRule.write(
                                                platformServices().secureStore,
                                                settled,
                                            )
                                            // WHAT THE STORE HOLDS, and not
                                            // what was tapped: an unknown word
                                            // settles to the conservative
                                            // default, and a tick the next
                                            // launch would not draw is worse
                                            // than a tap that appears to do
                                            // nothing.
                                            rule = settled.stored
                                        }
                                    },
                                )
                            }
                        }
                    }
                }
                }
            }
        }
    }
}
