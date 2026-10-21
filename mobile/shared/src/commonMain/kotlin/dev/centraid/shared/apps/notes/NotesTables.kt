package dev.centraid.shared.apps.notes

/**
 * THE TABLES A NOTES COMMAND CHANGES (#1135): a change event names tables, and a
 * note is an `entity` (its title, its trash) with a `note` row (its words, its
 * notebook), a pin, a tag or a link is an `edge`, a notebook is a `container`
 * and a version is a `revision`.
 *
 * The model has one `entity` table for every kind, so another app's command
 * moves it too: Notes re-reads a shelf it did not need to, never a wrong one.
 */
public object NotesTables {
    /** What every Notes read depends on. */
    public val SHELF: Set<String> = setOf("entity", "note", "edge", "container")

    /** The shelf's tables and the revisions a history lists. */
    public val HISTORY: Set<String> = SHELF + "revision"
}

/**
 * A PIN IS THE SHARED `flag.set` / `flag.clear` OF THE `pinned` FLAG, on the
 * note's own id: Notes has no pin command of its own, and the library and the
 * editor both send these two.
 */
internal object NotesFlags {
    const val SET: String = "flag.set"
    const val CLEAR: String = "flag.clear"

    fun command(pinned: Boolean): String = if (pinned) SET else CLEAR

    fun input(noteId: String): String =
        "{\"id\":${dev.centraid.shared.kit.jsonString(noteId)},\"flag\":\"pinned\"}"
}
