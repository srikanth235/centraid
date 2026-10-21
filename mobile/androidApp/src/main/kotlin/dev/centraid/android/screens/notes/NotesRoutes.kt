package dev.centraid.android.screens.notes

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesHistoryEvent
import centraid.screen.v1.NotesJournalEvent
import centraid.screen.v1.NotesLibraryEvent
import centraid.screen.v1.NotesLinkPickerEvent
import centraid.screen.v1.NotesNotebooksEvent
import centraid.screen.v1.TrashListEvent
import dev.centraid.android.kit.TrashListScreen
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.NotesEditorScreen
import dev.centraid.android.screens.RouteNav
import dev.centraid.design.copy.NotesCopy
import dev.centraid.shared.apps.notes.NotesBridge
import dev.centraid.shared.apps.notes.NotesHistoryBridge
import dev.centraid.shared.apps.notes.NotesJournalBridge
import dev.centraid.shared.apps.notes.NotesLibraryBridge
import dev.centraid.shared.apps.notes.NotesLinkPickerBridge
import dev.centraid.shared.apps.notes.NotesNotebooksBridge
import dev.centraid.shared.apps.notes.NotesRouting
import dev.centraid.shared.apps.notes.NotesTrashBridge
import dev.centraid.shared.nav.AppIds
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.ScreenOpenings
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope

/**
 * NOTES' ROUTES (#1029 app port): the library, notebooks and journal under
 * one band (a place change swaps the top entry, never a push), the editor
 * with the powerbox over it, a note's history and the trash — each on its
 * bridge for the activity's life. The editor's bridge is `departed()` on the
 * way out, never `leave()`, which would shut it down for good.
 *
 * The machines emit intents and route nothing; `NotesRouting` decides where
 * each goes (for iOS too), and this file applies the move.
 */
public class NotesRoutes : AppRoutes {
    private val notes = NotesBridge()
    private val library = NotesLibraryBridge()
    private val notebooks = NotesNotebooksBridge()
    private val journal = NotesJournalBridge()
    private val history = NotesHistoryBridge()
    private val links = NotesLinkPickerBridge()
    private val trash = NotesTrashBridge()

    /** The session, for the Notes tile Home's move is routed by. */
    private var session: HomeSession? = null

    override fun handles(destination: Destination): Boolean =
        destination is Destination.NotesEditor ||
            destination is Destination.NotesLibrary ||
            destination == Destination.NotesNotebooks ||
            destination == Destination.NotesJournal ||
            destination is Destination.NotesHistory ||
            destination == Destination.NotesTrash

    /**
     * THE TILE DECIDES, ONE RULE FOR BOTH SHELLS (`NotesRouting.tile`): the
     * Notes place over its shelf, a new note when there is none, nowhere
     * while it reads.
     */
    override fun opens(moveId: String): Destination? {
        if (moveId != AppIds.NOTES) return null
        val tile = session?.state?.value?.data_?.tiles?.firstOrNull { it.app_id == AppIds.NOTES }
        return NotesRouting.tile(tile)
    }

    override fun attach(session: HomeSession, scope: CoroutineScope) {
        this.session = session
        notes.attach(session)
        library.attach(session)
        notebooks.attach(session)
        journal.attach(session)
        history.attach(session)
        links.attach(session)
        trash.attach(session)
    }

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
        when (destination) {
            is Destination.NotesEditor -> EditorRoute(destination, nav)
            is Destination.NotesLibrary -> LibraryRoute(destination, nav)
            is Destination.NotesHistory -> HistoryRoute(destination, nav)
            Destination.NotesNotebooks -> NotebooksRoute(destination, nav)
            Destination.NotesJournal -> JournalRoute(destination, nav)
            else -> TrashRoute(destination, nav)
        }
    }

    @Composable
    private fun EditorRoute(destination: Destination.NotesEditor, nav: RouteNav) {
        // THE NOTE'S ID RIDES ON THE EVENT: the editor's read is parameterised
        // by it, and a new note's id was minted on the phone.
        LaunchedEffect(destination) {
            notes.forward(
                NotesEditorEvent(opened = NotesEditorEvent.Opened(note_id = destination.noteId, is_new = destination.isNew)),
            )
        }
        val state by notes.host.state.collectAsStateWithLifecycle()
        // THE POWERBOX opens on the machine's say, over the editor.
        LaunchedEffect(state.link_sheet_open) {
            if (state.link_sheet_open) links.forward(NotesLinkPickerEvent(opened = NotesLinkPickerEvent.Opened(term = "")))
        }
        NotesEditorScreen(
            state = state,
            onEvent = { event ->
                notes.forward(event)
                // History (over the note, re-spelled as no longer new) and Send
                // to Tasks (Tasks' Inbox, the words in a focused quick add that
                // Tasks' route opens on arrival).
                nav.apply(NotesRouting.editor(event, state))
            },
            // CLOSE = DONE, the room's `onDeparted` is the save.
            onClose = { closeEditor(nav) },
            onDeparted = { notes.departed() },
        )
        if (state.link_sheet_open) {
            val picker by links.host.state.collectAsStateWithLifecycle()
            NotesLinkPickerSheet(
                state = picker,
                onEvent = { event ->
                    links.forward(event)
                    val picked = event.picked?.target
                    when {
                        picked != null -> notes.forward(NotesEditorEvent(link_picked = NotesEditorEvent.LinkPicked(picked)))
                        event.dismissed != null -> notes.forward(NotesEditorEvent(link_dismissed = NotesEditorEvent.LinkDismissed()))
                    }
                },
            )
        }
    }

    /** DONE LANDS IN NOTES (`NotesRouting.close`): a pop onto a Notes screen, else the library in place. */
    private fun closeEditor(nav: RouteNav) {
        val below = nav.stack.entries.dropLast(1).lastOrNull()
        nav.apply(NotesRouting.close(below?.let(ScreenOpenings::of)?.screenId.orEmpty()))
    }

    @Composable
    private fun LibraryRoute(destination: Destination.NotesLibrary, nav: RouteNav) {
        LaunchedEffect(destination) {
            library.forward(
                NotesLibraryEvent(
                    opened = NotesLibraryEvent.Opened(
                        notebook_id = destination.notebookId,
                        notebook_name = destination.notebookName,
                        unfiled_only = destination.unfiledOnly,
                    ),
                ),
            )
        }
        val state by library.host.state.collectAsStateWithLifecycle()
        NotesLibraryScreen(
            state = state,
            onEvent = { event ->
                library.forward(event)
                nav.apply(NotesRouting.library(event))
            },
            onHome = { nav.home() },
            onOpenContainer = { card -> nav.open(card, parent = state.chrome?.title.orEmpty()) },
        )
    }

    @Composable
    private fun NotebooksRoute(destination: Destination, nav: RouteNav) {
        // KEYED ON THE DESTINATION: a band swap into this place is an arrival,
        // and an arrival re-sends `Opened`.
        LaunchedEffect(destination) { notebooks.forward(NotesNotebooksEvent(opened = NotesNotebooksEvent.Opened())) }
        val state by notebooks.host.state.collectAsStateWithLifecycle()
        NotesNotebooksScreen(
            state = state,
            onEvent = { event ->
                notebooks.forward(event)
                nav.apply(NotesRouting.notebooks(event))
            },
            onHome = { nav.home() },
        )
    }

    @Composable
    private fun JournalRoute(destination: Destination, nav: RouteNav) {
        LaunchedEffect(destination) { journal.forward(NotesJournalEvent(opened = NotesJournalEvent.Opened())) }
        val state by journal.host.state.collectAsStateWithLifecycle()
        NotesJournalScreen(
            state = state,
            onEvent = { event ->
                journal.forward(event)
                nav.apply(NotesRouting.journal(event))
            },
            onHome = { nav.home() },
        )
    }

    @Composable
    private fun HistoryRoute(destination: Destination.NotesHistory, nav: RouteNav) {
        LaunchedEffect(destination) {
            history.forward(
                NotesHistoryEvent(opened = NotesHistoryEvent.Opened(note_id = destination.noteId, note_title = destination.title)),
            )
        }
        val state by history.host.state.collectAsStateWithLifecycle()
        NotesHistoryScreen(
            state = state,
            onEvent = { event -> history.forward(event) },
            // `chrome.back` is the machine's back word (#1047).
            parentTitle = state.chrome?.back.orEmpty(),
            onBack = { nav.pop() },
        )
    }

    @Composable
    private fun TrashRoute(destination: Destination, nav: RouteNav) {
        LaunchedEffect(destination) { trash.forward(TrashListEvent(opened = TrashListEvent.Opened())) }
        val state by trash.host.state.collectAsStateWithLifecycle()
        TrashListScreen(
            state = state,
            onEvent = { event -> trash.forward(event) },
            parentTitle = NotesCopy.TITLE,
            onBack = { nav.pop() },
        )
    }
}
