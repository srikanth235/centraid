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
import centraid.screen.v1.TasksHomeState
import centraid.screen.v1.TrashListEvent
import dev.centraid.android.kit.TrashListScreen
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.NotesEditorScreen
import dev.centraid.android.screens.RouteNav
import dev.centraid.design.copy.NotesCopy
import dev.centraid.shared.apps.notes.NotesBand
import dev.centraid.shared.apps.notes.NotesBridge
import dev.centraid.shared.apps.notes.NotesHistoryBridge
import dev.centraid.shared.apps.notes.NotesJournalBridge
import dev.centraid.shared.apps.notes.NotesLibraryBridge
import dev.centraid.shared.apps.notes.NotesLinkPickerBridge
import dev.centraid.shared.apps.notes.NotesNotebooksBridge
import dev.centraid.shared.apps.notes.NotesNotebooksMachine
import dev.centraid.shared.apps.notes.NotesRouting
import dev.centraid.shared.apps.notes.NotesTarget
import dev.centraid.shared.apps.notes.NotesTrashBridge
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.nav.withNotesPlace
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope

/**
 * NOTES' ROUTES (#1029 app port): the library, notebooks and journal under
 * one band (a place change is `withNotesPlace`, never a push), the editor
 * with the powerbox over it, a note's history and the trash — each on its
 * bridge for the activity's life. The editor's bridge is `departed()` on the
 * way out, never `leave()`, which would shut it down for good.
 *
 * The machines emit intents and route nothing; this file answers them.
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
     * THE TILE DECIDES, ONE RULE FOR BOTH SHELLS (`NotesRouting.target`): the
     * note it shows, a new note when there is none, nowhere while it reads.
     */
    override fun opens(moveId: String): Destination? {
        if (moveId != "notes") return null
        val tile = session?.state?.value?.data_?.tiles?.firstOrNull { it.app_id == "notes" }
        return when (val target = NotesRouting.target(tile)) {
            is NotesTarget.Existing -> Destination.NotesEditor(target.noteId, target.title)
            is NotesTarget.New -> Destination.NotesEditor(target.noteId, isNew = true)
            null -> null
        }
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

    /** A band key: another place in place; More and the current place are the machine's. */
    private fun place(nav: RouteNav, key: String) {
        if (key != NotesBand.MORE) nav.go(nav.stack.withNotesPlace(key))
    }

    private fun newNote(nav: RouteNav) {
        nav.go(nav.stack.push(Destination.NotesEditor(NotesRouting.mintNoteId(), isNew = true)))
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
                if (event.history != null) {
                    // THE ENTRY UNDER HISTORY IS NO LONGER NEW (history is
                    // offered only once the note exists): coming back must
                    // re-open it, not blank it.
                    val title = state.draft?.title.orEmpty()
                    val editor = Destination.NotesEditor(state.note_id, title, isNew = false)
                    nav.go(NavStack(nav.stack.entries.dropLast(1) + editor).push(Destination.NotesHistory(state.note_id, title)))
                }
                // SEND TO TASKS: Tasks' Inbox, the words waiting in a focused
                // quick add (`TasksHomeBridge.openQuickAdd`, sent by Tasks'
                // route on arrival). Nothing is written until the member adds.
                event.send_to_tasks?.let { sent ->
                    if (sent.text.isNotBlank()) {
                        nav.go(
                            nav.stack.push(
                                Destination.TasksHome(TasksHomeState.Destination.DESTINATION_INBOX, quickAdd = sent.text),
                            ),
                        )
                    }
                }
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

    /**
     * DONE LANDS IN NOTES (as on iOS). An editor opened from Home — the tile,
     * the first move — has no Notes place under it, so Done swaps it for the
     * library rather than popping to Home: the only road from a Home-opened
     * note to the band's places. Opened from a Notes screen, Done is a pop.
     */
    private fun closeEditor(nav: RouteNav) {
        val entries = nav.stack.entries
        val below = entries.dropLast(1).lastOrNull()
        if (below != null && handles(below)) {
            nav.pop()
        } else {
            nav.go(NavStack(entries.dropLast(1) + Destination.NotesLibrary()))
        }
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
                event.band?.let { place(nav, it.key) }
                if (event.new_note != null) newNote(nav)
                event.note_picked?.let { nav.go(nav.stack.push(Destination.NotesEditor(it.note_id, it.title))) }
                if (event.trash_opened != null) nav.go(nav.stack.push(Destination.NotesTrash))
            },
            onHome = { nav.home() },
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
                event.band?.let { place(nav, it.key) }
                event.notebook_picked?.let { picked ->
                    val library = if (picked.id == NotesNotebooksMachine.UNFILED) {
                        Destination.NotesLibrary(notebookName = picked.name, unfiledOnly = true)
                    } else {
                        Destination.NotesLibrary(notebookId = picked.id, notebookName = picked.name)
                    }
                    nav.go(nav.stack.push(library))
                }
                if (event.trash_opened != null) nav.go(nav.stack.push(Destination.NotesTrash))
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
                event.band?.let { place(nav, it.key) }
                event.entry_picked?.let { nav.go(nav.stack.push(Destination.NotesEditor(it.note_id, it.title))) }
                // TODO(intent): Notes has no command that writes a journal
                // entry for a day, so "New entry" opens a new note; the day
                // it carries is not written anywhere yet.
                if (event.new_entry != null) newNote(nav)
                if (event.trash_opened != null) nav.go(nav.stack.push(Destination.NotesTrash))
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
            parentTitle = destination.title.ifEmpty { NotesCopy.UNTITLED },
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
