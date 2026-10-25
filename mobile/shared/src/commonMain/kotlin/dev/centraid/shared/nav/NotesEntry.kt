package dev.centraid.shared.nav

import centraid.core.v1.NotesEditorRoute
import centraid.core.v1.NotesHomeRoute
import centraid.core.v1.NotesPlace
import centraid.core.v1.Route

/**
 * WHERE THE SHELL ENTERS NOTES FROM OUTSIDE IT (#1135): Home's tile, its first
 * move, search, a chat card. Inside Notes a row carries the `Route` Rust built;
 * these are the only routes the shell spells, because the caller holds an id and
 * no row.
 *
 * INTERIM: the shell lane (#1135) replaces the KMP stack with Rust's and
 * deletes this file; a front door then asks Rust for the route.
 */
public object NotesEntry {
    private const val HOME: String = "notes.home"
    private const val EDITOR: String = "notes.editor"

    /** Notes' home on [place], filtered to a notebook or to the unfiled notes. */
    public fun home(
        place: NotesPlace = NotesPlace.NOTES_PLACE_NOTES,
        notebookId: String = "",
        notebookName: String = "",
        unfiledOnly: Boolean = false,
    ): Destination.RustScreen = Destination.RustScreen(
        Route(
            screen = HOME,
            notes_home = NotesHomeRoute(
                place = place,
                notebook_id = notebookId,
                notebook_name = notebookName,
                unfiled_only = unfiledOnly,
            ),
        ),
    )

    /** One note. */
    public fun editor(noteId: String): Destination.RustScreen = Destination.RustScreen(
        Route(screen = EDITOR, notes_editor = NotesEditorRoute(note_id = noteId)),
    )

    /** An empty draft: its first save creates the note. */
    public fun newNote(): Destination.RustScreen = Destination.RustScreen(
        Route(screen = EDITOR, notes_editor = NotesEditorRoute(is_new = true)),
    )
}
