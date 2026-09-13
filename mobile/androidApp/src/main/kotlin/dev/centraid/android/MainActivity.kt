package dev.centraid.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
// `var x by mutableStateOf(...)` needs BOTH operators in scope. Only
// `getValue` was imported, so the read compiled and the write did not
// (#1020, wave A) — the whole `by` delegate fails on the setter alone.
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.TallyListEvent
import dev.centraid.android.screens.HomeScreen
import dev.centraid.android.screens.NotesEditorScreen
import dev.centraid.android.screens.PhotosGridScreen
import dev.centraid.android.screens.TallyListScreen
import dev.centraid.android.theme.CentraidTheme
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.screen.HomeMachine
import dev.centraid.shared.screen.HomeSession
import dev.centraid.shared.screen.NotesEditorMachine
import dev.centraid.shared.screen.PhotosGridMachine
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.screen.TallyListMachine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The composition root, and the only file allowed to name screens from every
 * app (#1020; v0's `apps/mobile/navigators.tsx:1-6` rule, enforced there by
 * `scripts/check-import-boundaries.ts`).
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

    override fun onDestroy() {
        // The core is a HANDLE and it is released here. One core per device
        // process (R-1020-24), so an activity that leaked one would refuse to
        // open the next.
        session?.close()
        session = null
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
        // Sorted, so the same device opens the same vault twice running rather
        // than whichever one the filesystem enumerated first. `-wal` and `-shm`
        // are SQLite's sidecars and not vaults; the extension filter drops them.
        val vaultPaths = filesDir.listFiles()
            .orEmpty()
            .filter { it.isFile && it.name.endsWith(".db") }
            .map { it.absolutePath }
            .sorted()
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
                    value = HomeSession.open(
                        vaultPaths = vaultPaths,
                        dispatcher = Dispatchers.IO,
                        uiThreadName = Thread.currentThread().name,
                    ).also { session = it }
                }
                Box(Modifier.fillMaxSize().safeDrawingPadding()) {
                when (val destination = stack.current) {
                    is Destination.TallyHome -> {
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
                        val state by photos.state.collectAsStateWithLifecycle()
                        PhotosGridScreen(
                            state = state,
                            onEvent = { event -> scope.launch { photos.send(event) } },
                        )
                    }

                    is Destination.NotesEditor -> {
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
                                live?.send(event)
                            },
                        )
                    }
                }
                }
            }
        }
    }
}
