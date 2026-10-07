package dev.centraid.android

import android.content.pm.PackageManager
import android.os.Bundle
import androidx.fragment.app.FragmentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.ui.platform.LocalView
import androidx.compose.runtime.SideEffect
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.core.view.WindowCompat
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.RouteNav
import dev.centraid.android.screens.agenda.AgendaRoutes
import dev.centraid.android.screens.docs.DocsRoutes
import dev.centraid.android.screens.locker.LockerRoutes
import dev.centraid.android.screens.notes.NotesRoutes
import dev.centraid.android.screens.people.PeopleRoutes
import dev.centraid.android.screens.photos.PhotosRoutes
import dev.centraid.android.screens.tally.TallyRoutes
import dev.centraid.android.screens.tasks.TasksRoutes
import dev.centraid.android.screens.words.FirstLaunchScreen
import dev.centraid.android.screens.words.WordsSheets
import androidx.compose.runtime.key
import dev.centraid.android.theme.centraidColor
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
import centraid.screen.v1.HomeEvent
import dev.centraid.android.backup.MediaStoreDeleter
import dev.centraid.android.backup.ProcessSession
import dev.centraid.android.screens.backup.BackupSheets
import dev.centraid.android.screens.backup.writeTransferRule
import dev.centraid.android.kit.MakeVaultSheet
import dev.centraid.android.kit.TransferRulesSheet
import dev.centraid.android.screens.HomeScreen
import dev.centraid.android.screens.PhotosGridScreen
import dev.centraid.android.theme.CentraidTheme
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.shell.HomeMachine
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.shell.TransferRuleChoice
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.sync.TransferRule
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The composition root (#1020). It names Home and each app's ROUTES, never an
 * app's screens: those are `screens/<app>/<App>Routes.kt`, one list entry each
 * in [routes] (K5).
 *
 * ONE ROOT STACK, NO BOTTOM TABS — apps are covers over Home.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
// A `FragmentActivity` AND NOT A PLAIN `ComponentActivity` for one reason:
// Locker's unlock raises `BiometricPrompt`, which hosts itself in a fragment
// of the activity it is given (#1047, D-5).
public class MainActivity : FragmentActivity() {
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

    /**
     * What the first-launch gate reads while the core is opening: not read yet.
     * Null is neither "none" nor "some" (`Shelf.holdsNoVault`), so a phone that
     * holds a vault never flashes the gate on its way up.
     */
    private val shelfUnread =
        kotlinx.coroutines.flow.MutableStateFlow<Boolean?>(null).asStateFlow()
    /**
     * EVERY APP'S ROUTES, ONE LINE EACH (K5). Each holds its own bridges for
     * the activity's life — `ChangeStream.route` is registration with no
     * removal, so a screen's host is built once and attached once — and draws
     * its own destinations. This file names no app screen; it delegates
     * Home's moves, the session attach, back and the destination switch to
     * this list. The order is the attach order.
     */
    private val routes: List<AppRoutes> by lazy {
        listOf(
            TallyRoutes(),
            AgendaRoutes(),
            PhotosRoutes(cacheDir),
            NotesRoutes(),
            DocsRoutes(),
            PeopleRoutes(),
            TasksRoutes(),
            locker,
        )
    }

    /**
     * LOCKER'S ROUTES, NAMED because two things outside them reach in: its
     * wall's "Enter your 24 words" opens [words]' words.enter, and that
     * sheet's close has the gate re-read `keyed` (#1047 E3).
     */
    private val locker: LockerRoutes by lazy { LockerRoutes(openWords = { words.openRekey() }) }

    /** THE 24 WORDS' SHEETS (#1047 E3), over every screen. See `WordsSheets`. */
    private val words: WordsSheets by lazy { WordsSheets(onEnterClosed = { locker.reattach(this) }) }

    /** THE BACKUP SCREEN'S SHEET (#1080), over every screen. See `BackupSheets`. */
    private val backupSheet: BackupSheets by lazy { BackupSheets() }

    /**
     * FREE UP SPACE'S HAND ON MEDIASTORE (#1080 A20). A FIELD, NEVER `lazy`: its
     * activity result launcher must be registered before this activity starts.
     * Installed on the session when it opens and cleared when this activity
     * goes (`produceState` below). See `MediaStoreDeleter`.
     */
    private val libraryDeleter: MediaStoreDeleter = MediaStoreDeleter(this)

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
    // `onPause` IS GONE FROM THIS ACTIVITY (#1029 §1). With `onResume` it ran
    // `HomeSession.foreground()` and `leftTheForeground()`: catch every
    // holding up and hold the foreground one's log stream open while the member
    // is looking, close it when they leave. That shape left with the gateway;
    // what arriving and leaving do now is the backup's (#1080): `onResume`
    // runs a pass and `onStop` a pass with a snapshot, below.

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

    /**
     * THE APP LEFT THE SCREEN (#1080): a pass that takes a snapshot now, as
     * iOS's `wentToBackground` runs `enteredBackground`, so what the member
     * just wrote is backed up rather than waiting for the hour after the last
     * one. Without it, nothing on Android ever asked for that snapshot.
     *
     * A ROTATION IS NOT LEAVING: the activity stops and starts again with the
     * member still looking, so a configuration change runs nothing.
     *
     * Android may freeze or end the process while this pass runs, and the
     * laptop may be asleep. Neither loses the snapshot: the core keeps the
     * request in the ledger the moment the pass begins, and the next pass
     * that reaches a gateway — a WorkManager window — takes it.
     */
    override fun onStop() {
        super.onStop()
        if (isChangingConfigurations) return
        val open = session ?: return
        kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch {
            open.drain.enteredBackground(BACKGROUND_PASS_MS)
        }
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        val open = session ?: return
        kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch { open.rest() }
    }

    // `onDestroy` NO LONGER CLOSES THE SESSION (#1080). The session is the
    // PROCESS's ([ProcessSession]); this activity's hold on it is released by
    // the composition that took it, when the composition is disposed — so a
    // pass a job or a worker is running finishes its part rather than losing
    // its core under it, and the last holder's release is what closes it.

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
        // EVERY `<dir>/vault.db` IN `filesDir` IS A VAULT, one directory per
        // vault (#1047, Q-1047-17), and the directory is the roster: no
        // manifest sits beside it, because a manifest would be a second place a
        // vault's name and existence live. What each file is CALLED is read out
        // of the file itself; see `VaultRoster`. A placed fixture
        // `demo-vault.sqlite3` lands as `files/demo-vault/vault.db`
        // (`Shelf.VAULT_FILE`), beside the backup home the core keeps for it.
        for (name in assets.list("")?.filter { it.endsWith(".sqlite3") }.orEmpty()) {
            val home = java.io.File(filesDir, name.substringBeforeLast('.'))
            val file = java.io.File(home, Shelf.VAULT_FILE)
            if (file.exists()) continue
            runCatching {
                home.mkdirs()
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
        // paths (#1025 S5): `filesDir`, which `ProcessSession` opens for this
        // activity and for every background pass alike. The shell used to
        // enumerate whatever `.db` files had been placed there and hand the
        // list over; a device makes its own vaults now, so what it knows is
        // where they go and `Shelf` opens every file it finds. An empty
        // directory is the ordinary first run.
        // THE DEMO VAULT'S SEED, HANDED TO A DEBUG BUILD AT LAUNCH (#1047 W2).
        // `mobile/scripts/demo-vault.sh android` starts the activity with the
        // seed `seed-demo-vault` printed as `CENTRAID_DEMO_SEED` — the public
        // all-`abandon` words' seed — as an extra, and the shelf stores it where
        // a real seed lives, so the demo Locker opens keyed. A build that is not
        // debuggable never reads the extra. See `DevSeed`.
        val devSeed = if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            dev.centraid.shared.custody.DevSeed.parse(intent?.getStringExtra(DEV_SEED_EXTRA))
        } else {
            null
        }
        setContent {
            CentraidTheme {
                // The stack is shell state, not a library's: `NavStack` is
                // immutable and a swap is the navigation.
                var stack by androidx.compose.runtime.remember {
                    androidx.compose.runtime.mutableStateOf(NavStack())
                }
                val scope = androidx.compose.runtime.rememberCoroutineScope()
                // ONE SESSION FOR THE LIFE OF THE ACTIVITY. `produceState`
                // rather than `LaunchedEffect` + a `mutableStateOf`, so the
                // first composition already has a value to draw and the open
                // runs on the IO dispatcher exactly once.
                val homeSession by androidx.compose.runtime.produceState<HomeSession?>(null) {
                    // THE PROCESS'S ONE SESSION (#1080): opened here or by a
                    // background pass that got there first, and held for as
                    // long as this composition lives — over `filesDir`, the
                    // one directory the passes open too. The
                    // pass the OS runs is installed by `CentraidApplication`,
                    // not here, so a window that wakes the app with no activity
                    // still has a body to run.
                    //
                    // NOT CANCELLABLE WHILE IT OPENS, and released in `finally`:
                    // a composition disposed mid-open (a fast rotation) still
                    // gets its hold back and gives it up, so the count never
                    // keeps a session open for an activity that is gone.
                    val opened = withContext(kotlinx.coroutines.NonCancellable) {
                        ProcessSession.acquire(applicationContext, devSeed)
                    }
                    try {
                        session = opened
                        // THE APP SCREENS GO ON THE SAME CORE (#1025 S5, lane
                        // L5). R-1020-24 is one core per VAULT FILE, so every app
                        // reads through the handle this session holds rather than
                        // opening its own. Each app attaches its own screens,
                        // once, here: `attachScreen` also routes a host onto the
                        // change stream, so a row that arrives moves the screen
                        // without a tap — and a host routed twice re-reads twice.
                        routes.forEach { it.attach(opened, scope) }
                        words.attach(opened, scope)
                        backupSheet.attach(opened)
                        opened.installLibraryDeleter(libraryDeleter)
                        value = opened
                        // AND THE FIRST FOREGROUND PASS, which `onResume` would
                        // otherwise miss: the activity resumed before the session
                        // existed. LAUNCHED, NOT AWAITED (#1080): a pass now takes
                        // a snapshot and seals what is new, and Home does not wait
                        // for a backup to draw.
                        launch { opened.drain.onBecameActive() }
                        kotlinx.coroutines.awaitCancellation()
                    } finally {
                        session = null
                        // CLEARED ONLY IF STILL THIS ACTIVITY'S: after a rotation
                        // the new activity may have installed its own first.
                        if (opened.libraryDeleter === libraryDeleter) opened.installLibraryDeleter(null)
                        ProcessSession.release()
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
                // AN APP MAY GIVE BACK ITS OWN MEANING first
                // (`AppRoutes.back`): Photos returns a band parameter to the
                // library rather than popping Photos whole.
                BackHandler(enabled = stack.entries.size > 1) {
                    val current = stack
                    stack = routes.firstNotNullOfOrNull { it.back(current, scope) } ?: current.pop()
                }
                // THE FIRST-LAUNCH GATE: the shelf's one answer to "does this
                // device hold no vault", read here and nowhere else.
                val holdsNoVault by (homeSession?.shelf?.holdsNoVault ?: shelfUnread)
                    .collectAsStateWithLifecycle()
                // ENGAGING IT LEAVES NOTHING OF HOME STANDING: an app screen
                // pushed over it, and the switcher the last Forget was made
                // from, would each come back with Home once a vault is made.
                LaunchedEffect(holdsNoVault) {
                    if (holdsNoVault == true) {
                        stack = NavStack()
                        homeSession?.send(HomeEvent(vault_picked = HomeEvent.VaultPicked(vault_id = "")))
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
                val route = routes.firstOrNull { it.handles(stack.current) }
                val nav = remember(scope) {
                    RouteNav(read = { stack }, write = { next -> stack = next }, scope = scope)
                }
                // EVERY APP'S ROOT WATCH (`AppRoutes.Global`), on every screen.
                routes.forEach { app -> key(app) { app.Global(nav) } }
                if (route != null) {
                    // KEYED ON THE APP, so one app's effects never carry
                    // into another's at this one call site.
                    key(route) { route.Routes(stack.current, nav) }
                } else if (holdsNoVault == true) {
                    // A DEVICE THAT HOLDS NO VAULT opens onto the way to make
                    // one, not onto a Home with nothing to read. The words
                    // sheet below rises over it, so a cancel lands back here.
                    FirstLaunchScreen(
                        onMake = { words.makeVault() },
                        onRestore = { words.openRestore() },
                    )
                } else {
                    // HOME IS THE FLOOR, and it is a real screen now: the
                    // graded springboard over `HomeMachine`, not a list of
                    // links (#1020, wave A). A first move names WHERE it goes
                    // and the stack takes it there — the screen itself
                    // navigates nothing.
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
                    // R-SHELL-2: member-visible sentences name the
                    // foreground holding. Cleared on forget / switch.
                    var vaultStatus by remember { mutableStateOf("") }
                    // THE MADE VAULT'S SENTENCE (words.make's MADE) stays on
                    // the vault sheet, as `found`'s did — taken once.
                    val made = words.made
                    LaunchedEffect(made.first) { words.takeMade()?.let { vaultStatus = it } }
                    HomeScreen(
                        state = state,
                        onEvent = { event ->
                            val picked = event.move_picked
                            if (picked != null) {
                                val before = stack
                                // THE APP THAT ANSWERS THIS MOVE says where it lands.
                                // A move no app answers has no destination in this shell
                                // yet; the stack stays put rather than pushing a blank
                                // cover.
                                stack = routes.firstNotNullOfOrNull { it.opens(picked.move_id) }
                                    ?.let { stack.push(it) } ?: stack
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
                        // THE MORE SHEET'S CUSTODY ROWS (#1047 E6). Whether
                        // this phone has a camera is the one fact pair.laptop
                        // is told; without one it is paste-only.
                        onShowWords = { words.openShow() },
                        onPairLaptop = {
                            words.openPair(
                                camera = packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY),
                            )
                        },
                        // HOME'S BACKUP LINE OPENS THE BACKUP SCREEN (#1080).
                        onOpenBackup = { backupSheet.open() },
                    )
                    if (vaultSheetOpen) {
                        ModalBottomSheet(onDismissRequest = { vaultSheetOpen = false }) {
                            MakeVaultSheet(
                                status = vaultStatus,
                                // THE BARE TAP IS GONE (#1047 E3): making a
                                // vault goes through its words. One sheet at
                                // a time — the vault sheet goes first.
                                onMake = {
                                    vaultSheetOpen = false
                                    words.makeVault()
                                },
                                onRestore = {
                                    vaultSheetOpen = false
                                    words.openRestore()
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
                                        // WHAT THE STORE HOLDS, and not
                                        // what was tapped: an unknown word
                                        // settles to the conservative
                                        // default, and a tick the next
                                        // launch would not draw is worse
                                        // than a tap that appears to do
                                        // nothing. The background windows
                                        // are asked for again under it
                                        // (#1080), as from the Backup screen.
                                        rule = writeTransferRule(session, picked)
                                    }
                                },
                            )
                        }
                    }
                }
                // THE 24 WORDS' SHEET, over whatever is drawn (#1047 E3).
                words.Sheets()
                // THE BACKUP SCREEN (#1080). "Add a gateway" is pairing: the
                // Backup sheet closes and pair.laptop opens in its place.
                backupSheet.Sheet(
                    onAddDestination = {
                        words.openPair(
                            camera = packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY),
                        )
                    },
                )
                }
            }
        }
    }

    private companion object {
        /** The launch extra a debug build reads its demo seed from. See `DevSeed`. */
        const val DEV_SEED_EXTRA: String = "dev.centraid.DEV_SEED"

        /**
         * The leaving pass's deadline, as iOS's `backgroundPassSeconds`: a
         * stopped app is cached and soon frozen, so the pass finishes its
         * part well inside that rather than counting on the process.
         */
        const val BACKGROUND_PASS_MS: Long = 20_000L
    }
}
