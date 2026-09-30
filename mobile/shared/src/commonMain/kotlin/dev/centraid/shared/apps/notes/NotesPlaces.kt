package dev.centraid.shared.apps.notes

import centraid.core.v1.AppQueryDenial
import centraid.screen.v1.Denied
import centraid.screen.v1.HomeTile
import centraid.screen.v1.NotesBandTab
import centraid.screen.v1.TileStatus
import dev.centraid.design.copy.NotesCopy
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/**
 * NOTES' BAND: Notes · Notebooks · Journal, and More as a sheet (#1029 port).
 *
 * Each place is its own screen id; the band is computed here once so the
 * three screens draw one band. A tap on another place is an intent the shell
 * answers in place (`NavStack.withNotesPlace`).
 */
public object NotesBand {
    public const val NOTES: String = "notes"
    public const val NOTEBOOKS: String = "notebooks"
    public const val JOURNAL: String = "journal"
    public const val MORE: String = "more"

    /** The four tabs, [current] marked. */
    public fun tabs(current: String): List<NotesBandTab> = listOf(
        NotesBandTab(key = NOTES, label = NotesCopy.BAND_NOTES, icon_key = "FileText", current = current == NOTES),
        NotesBandTab(key = NOTEBOOKS, label = NotesCopy.BAND_NOTEBOOKS, icon_key = "Folder", current = current == NOTEBOOKS),
        NotesBandTab(key = JOURNAL, label = NotesCopy.BAND_JOURNAL, icon_key = "Journal", current = current == JOURNAL),
        NotesBandTab(key = MORE, label = NotesCopy.BAND_MORE, icon_key = "more", current = false),
    )

    /** The gate Notes draws when the vault will not let it read. */
    public fun denied(denial: AppQueryDenial?): Denied = Denied(
        title = NotesCopy.DENIED_TITLE,
        body = NotesCopy.DENIED_BODY,
        receipt = denial?.message ?: "",
    )
}

/** Where a Notes entry point lands. */
public sealed interface NotesTarget {
    /** An existing note, by id; the title rides along for the app bar. */
    public data class Existing(val noteId: String, val title: String) : NotesTarget

    /** A new note under an id minted on this phone, created on its first save. */
    public data class New(val noteId: String) : NotesTarget
}

/**
 * WHERE THE NOTES TILE, THE ALL-APPS ROW AND THE FIRST MOVE LAND — one
 * decision for both shells, not three (the Android demo-id defect).
 *
 * - The tile shows a note: that note.
 * - The tile's read landed with nothing (`EMPTY`), or there is no tile at all
 *   (the first move on a new vault): a NEW note.
 * - The read is in flight (`LOADING`) or did not land (`UNKNOWN`): NOTHING.
 *   A blank editor opened over a vault that does have notes would be a guess.
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

    /**
     * A note id minted on the phone: a lowercase version-4 UUID, the shape
     * `knowledge.create_note`'s `note_id` pattern takes.
     */
    @OptIn(ExperimentalUuidApi::class)
    public fun mintNoteId(): String = Uuid.random().toString()
}
