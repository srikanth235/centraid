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
    public const val NOTES_NOTEBOOKS: String = "notes.notebooks"
    public const val NOTES_JOURNAL: String = "notes.journal"
    public const val NOTES_HISTORY: String = "notes.history"
    public const val NOTES_TRASH: String = "notes.trash"

    public const val DOCS_DRIVE: String = "docs.drive"

    /** The folder page: the drive's machine on a bridge of its own, keyed apart so the drive under it keeps its tab. */
    public const val DOCS_FOLDER: String = "docs.folder"
    public const val DOCS_DOCUMENT: String = "docs.document"
    public const val DOCS_EDITOR: String = "docs.editor"
    public const val DOCS_TRASH: String = "docs.trash"

    public const val PEOPLE_HOME: String = "people.home"
    public const val PEOPLE_PERSON: String = "people.person"
    public const val PEOPLE_EDITOR: String = "people.editor"
    public const val PEOPLE_TRASH: String = "people.trash"

    public const val AGENDA_HOME: String = "agenda.home"
    public const val AGENDA_EVENT: String = "agenda.event"
    public const val AGENDA_EDITOR: String = "agenda.editor"

    public const val MONEY_HOME: String = "money.home"
    public const val MONEY_TRANSACTION: String = "money.transaction"
    public const val MONEY_TARGET: String = "money.target"
    public const val MONEY_RECURRING: String = "money.recurring"
    public const val MONEY_IMPORT: String = "money.import"
    public const val MONEY_ACCOUNTS: String = "money.accounts"
    public const val MONEY_RULES: String = "money.rules"
    public const val MONEY_CATEGORIES: String = "money.categories"
    public const val MONEY_SEARCH: String = "money.search"

    /** Health's home place: Today, Trends and Workouts are its band's parameter (#1129). */
    public const val HEALTH_HOME: String = "health.home"
    public const val HEALTH_METRIC: String = "health.metric"
    public const val HEALTH_WORKOUT: String = "health.workout"
    public const val HEALTH_CONNECT: String = "health.connect"

    public const val LOCKER_HOME: String = "locker.home"
    public const val LOCKER_ITEM: String = "locker.item"
    public const val LOCKER_EDITOR: String = "locker.editor"
    public const val LOCKER_TRASH: String = "locker.trash"
    public const val LOCKER_EXPORT: String = "locker.export"
    public const val LOCKER_IMPORT: String = "locker.import"
    public const val LOCKER_ACCESS: String = "locker.access"

    public const val PHOTOS_GRID: String = "photos.grid"
    public const val PHOTOS_SHELF: String = "photos.shelf"
    public const val PHOTOS_LIGHTBOX: String = "photos.lightbox"
}
