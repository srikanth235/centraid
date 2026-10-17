package dev.centraid.shared.apps.notes

import centraid.core.v1.AppQueryDenial
import centraid.screen.v1.Denied
import centraid.screen.v1.NotesBandTab
import dev.centraid.design.copy.NotesCopy

/**
 * NOTES' BAND: Notes · Notebooks · Journal, then More — an ordinary tab, last,
 * whose tap opens the place's More sheet (#1029 port, R-CHROME-4/5).
 *
 * Each place is its own screen id; the band is computed here once so the
 * three screens draw one band. A tap on another place is an intent the shell
 * answers in place (`NotesRouting`).
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
        NotesBandTab(key = MORE, label = NotesCopy.BAND_MORE, icon_key = "MoreHoriz", current = false),
    )

    /** The gate Notes draws when the vault will not let it read. */
    public fun denied(denial: AppQueryDenial?): Denied = Denied(
        title = NotesCopy.DENIED_TITLE,
        body = NotesCopy.DENIED_BODY,
        receipt = denial?.message ?: "",
    )
}
