package dev.centraid.shared.apps.notes

import centraid.screen.v1.HomeTile
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState
import centraid.screen.v1.NotesJournalEvent
import centraid.screen.v1.NotesLibraryEvent
import centraid.screen.v1.NotesNotebooksEvent
import centraid.screen.v1.TasksHomeState
import centraid.screen.v1.TileStatus
import dev.centraid.shared.nav.AppIds
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavMove
import dev.centraid.shared.nav.ScreenMove
import dev.centraid.shared.nav.ScreenMoves
import dev.centraid.shared.nav.ScreenOpening
import dev.centraid.shared.nav.ScreenOpenings
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/** Where a Notes entry point lands. */
public sealed interface NotesTarget {
    /** An existing note, by id; the title rides along for the app bar. */
    public data class Existing(val noteId: String, val title: String) : NotesTarget

    /** A new note under an id minted on this phone, created on its first save. */
    public data class New(val noteId: String) : NotesTarget
}

/**
 * WHERE NOTES' ENTRY POINTS AND INTENTS GO, ONCE (#1029 port).
 *
 * **The tile.** Where the Notes tile, the all-apps row and the first move land
 * — one decision for both shells, not three (the Android demo-id defect):
 * - The tile shows a note: that note.
 * - The tile's read landed with nothing (`EMPTY`), or there is no tile at all
 *   (the first move on a new vault): a NEW note.
 * - The read is in flight (`LOADING`) or did not land (`UNKNOWN`): NOTHING.
 *   A blank editor opened over a vault that does have notes would be a guess.
 *
 * **The intents.** A Notes machine that emits a band tap, a note, a notebook,
 * More's Trash, History or Send to Tasks changes nothing, or only closes its
 * sheet; the shell moves. WHICH move lives here: Android applies the
 * [NavMove] to its stack, and iOS asks [route] for the same move spelled.
 * Notes · Notebooks · Journal are three screens under one band, so a tap on
 * another place — and a notebook, which opens the Notes place filtered —
 * SWAPS the top entry: back never walks through the places a member tapped.
 */
public object NotesRouting {
    /** [target] with a phone-minted id — the call Swift can make (default arguments do not cross). */
    public fun target(tile: HomeTile?): NotesTarget? = target(tile, ::mintNoteId)

    public fun target(tile: HomeTile?, mint: () -> String = ::mintNoteId): NotesTarget? {
        val note = tile?.body?.notes
        if (note != null && note.note_id.isNotEmpty()) return NotesTarget.Existing(note.note_id, note.title)
        return when (tile?.status) {
            null, TileStatus.TILE_STATUS_EMPTY, TileStatus.TILE_STATUS_CONTENT -> NotesTarget.New(mint())
            else -> null
        }
    }

    /** The tile's [target], as the page it opens. */
    public fun tile(tile: HomeTile?): Destination? = when (val target = target(tile)) {
        is NotesTarget.Existing -> Destination.NotesEditor(target.noteId, target.title)
        is NotesTarget.New -> Destination.NotesEditor(target.noteId, isNew = true)
        null -> null
    }

    /** [tile] for a shell that sends bytes: [tile] is the encoded `HomeTile`, empty for none. */
    public fun tileOpening(tile: ByteArray): ScreenOpening? {
        val decoded = if (tile.isEmpty()) null else runCatching { HomeTile.ADAPTER.decode(tile) }.getOrElse { return null }
        return tile(decoded)?.let(ScreenOpenings::of)
    }

    /**
     * A note id minted on the phone: a lowercase version-4 UUID, the shape
     * `knowledge.create_note`'s `note_id` pattern takes.
     */
    @OptIn(ExperimentalUuidApi::class)
    public fun mintNoteId(): String = Uuid.random().toString()

    public fun library(event: NotesLibraryEvent): NavMove? {
        val band = event.band
        val picked = event.note_picked
        return when {
            band != null -> place(band.key, from = NotesBand.NOTES)
            event.new_note != null -> NavMove.push(Destination.NotesEditor(mintNoteId(), isNew = true))
            picked != null -> editorOf(picked.note_id, picked.title)
            event.more_row?.key == NotesLibraryMachine.MORE_TRASH -> NavMove.push(Destination.NotesTrash)
            else -> null
        }
    }

    public fun notebooks(event: NotesNotebooksEvent): NavMove? {
        val band = event.band
        val picked = event.notebook_picked
        return when {
            band != null -> place(band.key, from = NotesBand.NOTEBOOKS)
            // THE NOTES PLACE, FILTERED: still a band place, so swapped in.
            picked != null -> NavMove.swap(
                if (picked.id == NotesNotebooksMachine.UNFILED) {
                    Destination.NotesLibrary(notebookName = picked.name, unfiledOnly = true)
                } else {
                    Destination.NotesLibrary(notebookId = picked.id, notebookName = picked.name)
                },
            )
            event.trash_opened != null -> NavMove.push(Destination.NotesTrash)
            else -> null
        }
    }

    /** "New entry" is the machine's own sheet (`compose`), written through People's journal command. */
    public fun journal(event: NotesJournalEvent): NavMove? {
        val band = event.band
        val picked = event.entry_picked
        return when {
            band != null -> place(band.key, from = NotesBand.JOURNAL)
            picked != null -> editorOf(picked.note_id, picked.title)
            event.trash_opened != null -> NavMove.push(Destination.NotesTrash)
            else -> null
        }
    }

    public fun editor(event: NotesEditorEvent, state: NotesEditorState): NavMove? {
        val sent = event.send_to_tasks
        return when {
            // HISTORY, once the note exists. The entry under it is re-spelled
            // as no longer new: coming back re-opens the note, never blanks it.
            event.history != null -> {
                if (state.chrome?.history_enabled != true || state.note_id.isEmpty()) return null
                val title = state.draft?.title.orEmpty()
                NavMove(
                    dropsTop = true,
                    pushes = listOf(
                        Destination.NotesEditor(state.note_id, title, isNew = false),
                        Destination.NotesHistory(state.note_id, title),
                    ),
                )
            }
            // SEND TO TASKS: Tasks' Inbox, the words waiting in a focused quick
            // add. Nothing is written until the member adds them.
            sent != null && sent.text.isNotBlank() -> NavMove.push(
                Destination.TasksHome(TasksHomeState.Destination.DESTINATION_INBOX, quickAdd = sent.text),
            )
            else -> null
        }
    }

    /**
     * DONE LANDS IN NOTES. An editor opened from Home (the tile, the first
     * move) has no Notes place under it, so Done swaps it for the library
     * rather than popping to Home — the only road from a Home-opened note to
     * the band's places. Opened from a Notes screen, Done is a pop. [below] is
     * the screen id of the entry under the editor, empty for none or Home.
     */
    public fun close(below: String): NavMove =
        if (below.startsWith(AppIds.NOTES + ".")) NavMove.Pop else NavMove.swap(Destination.NotesLibrary())

    /**
     * THE SAME DECISIONS FOR A SHELL THAT SENDS BYTES: [event] is what screen
     * [screenId] just forwarded and [state] is that screen's own state. Null
     * for an event that moves nothing, a screen that is not Notes', or bytes
     * that do not decode.
     */
    public fun route(screenId: String, event: ByteArray, state: ByteArray): ScreenMove? {
        val move = runCatching {
            when (screenId) {
                NotesLibraryMachine.SCREEN_ID -> library(NotesLibraryEvent.ADAPTER.decode(event))
                NotesNotebooksMachine.SCREEN_ID -> notebooks(NotesNotebooksEvent.ADAPTER.decode(event))
                NotesJournalMachine.SCREEN_ID -> journal(NotesJournalEvent.ADAPTER.decode(event))
                NotesEditorMachine.SCREEN_ID -> editor(NotesEditorEvent.ADAPTER.decode(event), NotesEditorState.ADAPTER.decode(state))
                else -> null
            }
        }.getOrNull()
        return ScreenMoves.of(move)
    }

    /** [close], spelled. */
    public fun closeMove(below: String): ScreenMove? = ScreenMoves.of(close(below))

    /** A band key from place [from]: the same place and More are the machine's; another is swapped in. */
    private fun place(key: String, from: String): NavMove? {
        if (key == from) return null
        return when (key) {
            NotesBand.NOTES -> NavMove.swap(Destination.NotesLibrary())
            NotesBand.NOTEBOOKS -> NavMove.swap(Destination.NotesNotebooks)
            NotesBand.JOURNAL -> NavMove.swap(Destination.NotesJournal)
            else -> null
        }
    }

    /** A note with no id names nothing, so it opens nothing. */
    private fun editorOf(noteId: String, title: String): NavMove? =
        if (noteId.isEmpty()) null else NavMove.push(Destination.NotesEditor(noteId, title))
}
