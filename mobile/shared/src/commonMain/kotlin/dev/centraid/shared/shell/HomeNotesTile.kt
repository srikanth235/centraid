package dev.centraid.shared.shell

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.NotesLibrary
import centraid.core.v1.NotesLibraryRequest
import centraid.core.v1.NotesNotebooks
import centraid.core.v1.NotesNotebooksRequest
import centraid.core.v1.NotesRow
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.TileBody
import centraid.screen.v1.TileCount
import centraid.screen.v1.TileStatus
import dev.centraid.design.copy.NotesCopy
import dev.centraid.shared.platform.DeviceClock

/**
 * HOME'S NOTES TILE: THE SHELF. The notebooks that hold notes, each with its
 * count, and the newest note at the foot; a vault with nothing filed draws its
 * newest notes instead.
 *
 * It rides the app-query arm, on the two reads the Notes app itself draws its
 * places from: `notes.library` (the newest notes, and how many there are) and
 * `notes.notebooks` (the spine, with each notebook's count). A page read over
 * `knowledge_note` could say neither a notebook nor how many notes it holds,
 * and the tile it drew — one note's title under a count of every note — read
 * as a note, not as Notes.
 *
 * **The count is the library's**, so it is the Notes place's own number: live
 * notes, journal entries left out, over the library's window and `capped` when
 * the library says more exist beyond it.
 *
 * Nothing here imports `apps.notes` (`PerAppLayoutSpec`): the words are
 * `NotesCopy`'s and the folds are the few lines the tile needs.
 */
public object HomeNotesTile {
    public const val APP_ID: String = "notes"

    /** How many notebooks the shelf holds, and how many notes stand in for it. */
    public const val SHELF: Int = 3

    /**
     * THE TABLES WHOSE CHANGES MOVE THIS TILE, which `HomeReads.TABLES`
     * carries: the notes, the notebooks, and the filing between them — the
     * Notebooks place's own set.
     */
    public val TABLES: Set<String> = setOf("knowledge_note", "core_collection", "core_collection_entry")

    /** The two queries, in this order: the library, then the spine. */
    public fun requests(now: DeviceClock.Reading): List<AppQueryRequest> = listOf(
        AppQueryRequest(notes_library = NotesLibraryRequest(tz = now.zone)),
        AppQueryRequest(notes_notebooks = NotesNotebooksRequest()),
    )

    /**
     * The tile, out of the two answers.
     *
     * **NO NOTES IS `EMPTY`, not `UNKNOWN`**: both reads landed and the library
     * holds nothing, which is a true answer, so the tile falls to its
     * invitation. A read that did not land never reaches here.
     */
    public fun arrived(library: NotesLibrary, spine: NotesNotebooks): HomeEvent {
        val notes = library.notes
        val label = HomeReads.countNoun(notes.size, library.truncated, NotesCopy.TILE_COUNT_ONE, NotesCopy.TILE_COUNT_MANY)
        val newest = notes.firstOrNull() ?: return HomeEvent(
            tile = HomeEvent.TileArrived(
                app_id = APP_ID,
                status = TileStatus.TILE_STATUS_EMPTY,
                count = TileCount(value_ = 0),
                count_label = label,
            ),
        )
        // A NOTEBOOK WITH NOTHING IN IT IS NOT ON THE SHELF: it would spend one
        // of three lines on a zero. The spine's order is the member's own.
        val shelf = spine.notebooks.filter { it.note_count > 0 }.take(SHELF).map { notebook ->
            TileBody.Notes.Notebook(
                notebook_id = notebook.notebook_id,
                name = notebook.name?.trim()?.takeIf { it.isNotEmpty() } ?: NotesCopy.UNTITLED_NOTEBOOK,
                note_count = notebook.note_count,
            )
        }
        return HomeEvent(
            tile = HomeEvent.TileArrived(
                app_id = APP_ID,
                status = TileStatus.TILE_STATUS_CONTENT,
                count = TileCount(value_ = notes.size, capped = library.truncated),
                count_label = label,
                body = TileBody(
                    notes = TileBody.Notes(
                        note_id = newest.note_id,
                        title = titleOf(newest),
                        notebooks = shelf,
                        recent = if (shelf.isNotEmpty()) emptyList() else notes.take(SHELF).map {
                            TileBody.Notes.Recent(note_id = it.note_id, title = titleOf(it))
                        },
                    ),
                ),
            ),
        )
    }

    /** The title, else the preview's first line, else "Untitled note" — the Notes list's rule. */
    private fun titleOf(row: NotesRow): String =
        row.title?.trim()?.takeIf { it.isNotEmpty() }
            ?: row.preview.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }
            ?: NotesCopy.UNTITLED
}
