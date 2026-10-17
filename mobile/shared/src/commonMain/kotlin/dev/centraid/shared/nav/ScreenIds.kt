package dev.centraid.shared.nav

/**
 * THE SCREEN IDS A ROUTE IS SPELLED WITH, STATED ONCE.
 *
 * A route that crosses an app's border (a chat card, Home's search, an import's
 * "open") names the screen it opens without importing the machine that owns
 * it: nothing outside `apps` may name an app's types (`PerAppLayoutSpec`), and
 * no app may name another. So the id lives here, in the one package both sides
 * may import, and the machine's own `SCREEN_ID` IS this constant. The SwiftUI
 * shell reads the machine's (`TasksHomeMachine.shared.SCREEN_ID`), never a
 * string.
 *
 * Only the ids [ScreenOpenings] spells are here; a screen no route crosses an
 * app's border to open keeps its id on its machine.
 */
public object ScreenIds {
    public const val TASKS_HOME: String = "tasks.home"
    public const val TASKS_LIST: String = "tasks.list"
    public const val TASKS_PROJECT: String = "tasks.project"
    public const val TASKS_DETAIL: String = "tasks.detail"
    public const val TASKS_CATCH_UP: String = "tasks.catch_up"

    /** The kit's trash with Tasks as its parameter: `TrashMachine`'s `"<app>.trash"`, which a spec ties to this. */
    public const val TASKS_TRASH: String = "tasks.trash"

    public const val NOTES_EDITOR: String = "notes.editor"
    public const val NOTES_LIBRARY: String = "notes.library"

    public const val DOCS_DRIVE: String = "docs.drive"

    /** The folder page: the drive's machine on a bridge of its own, keyed apart so the drive under it keeps its tab. */
    public const val DOCS_FOLDER: String = "docs.folder"
    public const val DOCS_DOCUMENT: String = "docs.document"

    public const val PEOPLE_HOME: String = "people.home"
    public const val PEOPLE_PERSON: String = "people.person"

    public const val AGENDA_HOME: String = "agenda.home"
    public const val AGENDA_EVENT: String = "agenda.event"

    public const val MONEY_HOME: String = "money.home"
    public const val MONEY_TRANSACTION: String = "money.transaction"

    public const val PHOTOS_GRID: String = "photos.grid"
    public const val PHOTOS_SHELF: String = "photos.shelf"
    public const val PHOTOS_LIGHTBOX: String = "photos.lightbox"
}
