package dev.centraid.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
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
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.PhotosGridEvent
import centraid.screen.v1.TallyListEvent
import android.os.Build
import dev.centraid.android.kit.GatewaySheet
import dev.centraid.android.kit.TransferRulesSheet
import dev.centraid.android.screens.HomeScreen
import dev.centraid.android.screens.NotesEditorScreen
import dev.centraid.android.screens.PhotosGridScreen
import dev.centraid.android.screens.TallyListScreen
import dev.centraid.android.theme.CentraidTheme
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.shell.HomeMachine
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.apps.notes.NotesEditorMachine
import dev.centraid.shared.apps.notes.NotesReads
import dev.centraid.shared.apps.photos.PhotosFetches
import dev.centraid.shared.apps.photos.PhotosGridMachine
import dev.centraid.shared.apps.photos.PhotosReads
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.apps.tally.TallyListMachine
import dev.centraid.shared.apps.tally.TallyReads
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.shell.CameraRoll
import dev.centraid.shared.shell.PairOutcome
import dev.centraid.shared.shell.TransferRuleChoice
import dev.centraid.shared.sync.TransferRule
import dev.centraid.shared.sync.WakeReason
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
    private val notes = ScreenHost(NotesEditorMachine)

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
    /**
     * THE MEMBER ARRIVED: catch up, then hold the log open (#1025 S2,
     * D-1025-S7-40).
     *
     * **There is no timer here and none anywhere else in this shell.** A seat
     * becomes current by connecting and staying on the log stream, so "the
     * member is looking at the app" is the whole of the schedule. A page
     * committed on the gateway is on this device within one round trip.
     *
     * Android's persistent foreground service — a tail that survives the
     * activity — is deliberately not here; it is Slice 7's, and a tail that
     * lives and dies with the activity is the honest shape until it is.
     */
    override fun onResume() {
        super.onResume()
        val open = session ?: return
        kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch { open.foreground() }
    }

    /**
     * THE MEMBER LEFT: close the tail (#1025 S2, D-1025-S7-40, R-SHELL-4).
     *
     * `onPause` and not `onStop`, for the same reason iOS closes on `inactive`:
     * a phone in the recents switcher is not a phone the member is looking at,
     * and a stream held open by a process about to be frozen is a socket nobody
     * reads. The next `onResume` reopens it from the durable cursor. While
     * still resumed, airplane mode off is the same opener — so leaving has to
     * mark the member gone, or a path-up would reopen the tail in the recents
     * switcher.
     */
    override fun onPause() {
        super.onPause()
        val open = session ?: return
        kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch { open.leftTheForeground() }
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
        // EVERY `.db` IN `filesDir` IS A VAULT, and the directory is the roster:
        // no manifest sits beside it, because a manifest would be a second
        // place a vault's name and existence live. What each file is CALLED is
        // read out of the file itself; see `VaultRoster`.
        for (name in assets.list("")?.filter { it.endsWith(".db") }.orEmpty()) {
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
        // WHERE THIS DEVICE'S REPLICAS LIVE, as a DIRECTORY and not a list of
        // paths (#1025 S5). The shell used to enumerate whatever `.db` files
        // had been placed in `filesDir` and hand the list over; a device makes
        // its own replicas now, so what it knows is where they go and
        // `Replicas` knows what they are called. An empty directory is the
        // ordinary first run.
        val replicaDir = filesDir.absolutePath
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
                        replicaDir = replicaDir,
                        services = platformServices(),
                        dispatcher = Dispatchers.IO,
                        uiThreadName = Thread.currentThread().name,
                    ).also { opened ->
                        session = opened
                        // THE APP SCREENS GO ON THE SAME CORE (#1025 S5, lane
                        // L5). R-1020-24 is one core per process, so Tally,
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
                        opened.attachScreen(photos, PhotosReads, fetches = PhotosFetches)
                        opened.attachScreen(notes, NotesReads, NotesReads)
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
                            roll = CameraRoll(platform) { opened.shelf.core() },
                            host = photos,
                            scope = scope,
                            vaultId = { opened.shelf.foregroundHolding()?.vaultId },
                        ).also { it.start() }
                    }
                }
                Box(Modifier.fillMaxSize().safeDrawingPadding()) {
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
                        TallyListScreen(
                            state = state,
                            onEvent = { event -> scope.launch { tally.send(event) } },
                            onBandChange = { band ->
                                stack = stack.withTallyDestination(band)
                                scope.launch {
                                    tally.send(
                                        TallyListEvent(
                                            destination =
                                                TallyListEvent.DestinationChanged(band),
                                        ),
                                    )
                                }
                            },
                        )
                    }

                    is Destination.PhotosHome -> {
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
                            onEvent = { event -> scope.launch { photos.send(event) } },
                            onBackUpNow = {
                                scope.launch { cameraRoll.value?.pass() }
                            },
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
                        // GATEWAY / PAIR SHEET (#1025 live-shell). Same door as
                        // iOS Settings → Gateway; empty-roster Pair opens it.
                        var gatewayOpen by remember { mutableStateOf(false) }
                        var gatewayWorking by remember { mutableStateOf(false) }
                        // R-SHELL-2: member-visible pairing sentences name the
                        // foreground holding. Cleared on forget / switch.
                        var gatewayStatus by remember { mutableStateOf("") }
                        HomeScreen(
                            state = state,
                            onEvent = { event ->
                                val picked = event.move_picked
                                if (picked != null) {
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
                                }
                                val vaultPick = event.vault_picked
                                if (vaultPick != null &&
                                    vaultPick.vault_id.isNotEmpty() &&
                                    vaultPick.vault_id != state.vault?.vault_id
                                ) {
                                    gatewayStatus = ""
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
                                    withContext(Dispatchers.Main) { gatewayStatus = "" }
                                }
                            },
                            onDownloadSettings = {
                                scope.launch {
                                    rule = TransferRule.read(
                                        platformServices().secureStore,
                                    ).stored
                                    gatewayOpen = false
                                    rulesOpen = true
                                }
                            },
                            onPair = { gatewayOpen = true },
                        )
                        if (gatewayOpen) {
                            ModalBottomSheet(onDismissRequest = { gatewayOpen = false }) {
                                GatewaySheet(
                                    status = gatewayStatus,
                                    working = gatewayWorking,
                                    onPair = { ticket, done ->
                                        val open = live
                                        if (open == null) {
                                            gatewayStatus = "This build has no core."
                                            done()
                                            return@GatewaySheet
                                        }
                                        gatewayWorking = true
                                        scope.launch(Dispatchers.IO) {
                                            val outcome = open.pair(
                                                ticket = ticket,
                                                deviceName = Build.MODEL,
                                                platform = "android",
                                            )
                                            withContext(Dispatchers.Main) {
                                                gatewayStatus = when (outcome) {
                                                    is PairOutcome.Paired ->
                                                        "Paired with ${outcome.vaultName}."
                                                    is PairOutcome.Copying ->
                                                        "Paired. Your vault is being copied."
                                                    is PairOutcome.Refused ->
                                                        outcome.sentence
                                                    is PairOutcome.NoCore ->
                                                        "There is no vault open on this device yet."
                                                }
                                                gatewayWorking = false
                                                done()
                                            }
                                            open.foreground()
                                        }
                                    },
                                    onSyncNow = { done ->
                                        val open = live
                                        if (open == null) {
                                            gatewayStatus = "This build has no core."
                                            done()
                                            return@GatewaySheet
                                        }
                                        gatewayWorking = true
                                        scope.launch(Dispatchers.IO) {
                                            val outcome = open.syncNow(WakeReason.FOREGROUND)
                                            withContext(Dispatchers.Main) {
                                                gatewayStatus = when {
                                                    outcome.copying != null ->
                                                        outcome.copying!!
                                                    outcome.unreachable ->
                                                        outcome.sentence.ifEmpty {
                                                            "Centraid could not reach your gateway."
                                                        }
                                                    outcome.blocked != null ->
                                                        outcome.blocked!!
                                                    outcome.stale != null ->
                                                        outcome.stale!!
                                                    else -> {
                                                        var line =
                                                            "Synced: ${outcome.rowsApplied} changes, " +
                                                                "${outcome.blobsCompleted} files."
                                                        if (outcome.originalsWithheld > 0) {
                                                            line += " ${outcome.originalsWithheld} waiting for Wi-Fi."
                                                        }
                                                        outcome.bytesStalled?.let {
                                                            line += " $it"
                                                        }
                                                        line += " [${outcome.budget}" +
                                                            if (outcome.metered) {
                                                                ", metered]"
                                                            } else {
                                                                "]"
                                                            }
                                                        line
                                                    }
                                                }
                                                gatewayWorking = false
                                                done()
                                            }
                                        }
                                    },
                                    onOpenTransferRules = {
                                        scope.launch {
                                            rule = TransferRule.read(
                                                platformServices().secureStore,
                                            ).stored
                                            gatewayOpen = false
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
