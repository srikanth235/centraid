package dev.centraid.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.TallyListEvent
import dev.centraid.android.screens.NotesEditorScreen
import dev.centraid.android.screens.PhotosGridScreen
import dev.centraid.android.screens.TallyListScreen
import dev.centraid.android.theme.CentraidTheme
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.screen.NotesEditorMachine
import dev.centraid.shared.screen.PhotosGridMachine
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.screen.TallyListMachine
import kotlinx.coroutines.launch

/**
 * The composition root, and the only file allowed to name screens from every
 * app (#1020; v0's `apps/mobile/navigators.tsx:1-6` rule, enforced there by
 * `scripts/check-import-boundaries.ts`).
 *
 * ONE ROOT STACK, NO BOTTOM TABS — apps are covers over Home.
 */
public class MainActivity : ComponentActivity() {
    private val tally = ScreenHost(TallyListMachine)
    private val photos = ScreenHost(PhotosGridMachine)
    private val notes = ScreenHost(NotesEditorMachine)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            CentraidTheme {
                // The stack is shell state, not a library's: `NavStack` is
                // immutable and a swap is the navigation.
                var stack by androidx.compose.runtime.remember {
                    androidx.compose.runtime.mutableStateOf(NavStack())
                }
                val scope = androidx.compose.runtime.rememberCoroutineScope()
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

                    else -> HomeScreen(
                        onOpenTally = { stack = stack.push(Destination.TallyHome()) },
                        onOpenPhotos = { stack = stack.push(Destination.PhotosHome()) },
                        onOpenNotes = {
                            stack = stack.push(Destination.NotesEditor("note-0001"))
                        },
                        currentName = destination::class.simpleName ?: "Home",
                    )
                }
            }
        }
    }
}
