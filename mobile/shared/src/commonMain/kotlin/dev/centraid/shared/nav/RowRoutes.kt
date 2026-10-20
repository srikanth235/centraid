package dev.centraid.shared.nav

import centraid.screen.v1.ChatCard
import centraid.screen.v1.PhotoShelf

/**
 * WHERE A REFERENCE TO ONE ROW OPENS (R-CHROME-6).
 *
 * A row reference is `ChatCard`'s shape — an app, the row's noun in that app
 * (`task`, `event`, `person`…), its id and a second key. THIS IS THE ONE TABLE
 * FOR BOTH SHELLS: Android routes by [Destination] ([destination]), and iOS,
 * whose views cannot hold one, asks for the screen id and opening event
 * ([route], [ScreenOpenings]) — so a chat card, a Home search hit and an
 * import's "open" land on the same screen on both:
 *
 * | app | entity | destination |
 * | --- | --- | --- |
 * | tasks | `task` | the task's detail |
 * | tasks | `project` | the project's list |
 * | notes | `note` | the note's editor |
 * | docs | `document` | the document page |
 * | people | `person` | the person page |
 * | agenda | `event` | the event's detail (`qualifier` is the occurrence) |
 * | photos | `photo` | the lightbox, with [neighbours] as its swipe |
 * | notes | `notebook` | the library under that notebook (a container found by name, #1097) |
 * | photos | `album` | the album's shelf |
 * | docs | `folder` | the folder's page; `parent` is the pushing page's title |
 * | money | `transaction` | the transaction page; `parent` is the pushing page's title |
 * | chat | `thread` | none: Chat is a tab and not a screen ([isThread]). The iOS shell opens it (`ShellModel.openChatThread`), and Android has no Chat tab, so Home's search never offers the row there (R-1097-24) |
 *
 * A notebook, album or folder arrives with its id and its name (the
 * card's `title`) and nothing else, which is all each destination needs: the
 * names ride along the route so the head has words before the page reads.
 *
 * An entity this table has no row for opens the app's home; an app it does
 * not know is null, and the stack stays put.
 */
public object RowRoutes {
    private const val TASK: String = "task"
    private const val PROJECT: String = "project"
    private const val NOTE: String = "note"
    private const val NOTEBOOK: String = "notebook"
    private const val ALBUM: String = "album"
    private const val PHOTO: String = "photo"
    private const val FOLDER: String = "folder"
    private const val DOCUMENT: String = "document"
    private const val PERSON: String = "person"
    private const val EVENT: String = "event"
    private const val TRANSACTION: String = "transaction"
    private const val THREAD: String = "thread"

    /** [parent] is the pushing page's title, which a pushed page's back says. */
    public fun destination(
        card: ChatCard,
        parent: String = "",
        neighbours: List<String> = emptyList(),
    ): Destination? = destination(RowRef(card.app, card.entity, card.id, card.title, card.qualifier), parent, neighbours)

    /** [destination] over a reference's plain fields, for a shell that cannot hand over a `ChatCard`. */
    public fun destination(
        row: RowRef,
        parent: String = "",
        neighbours: List<String> = emptyList(),
    ): Destination? = when (row.app to row.entity) {
        AppIds.TASKS to TASK -> Destination.TasksDetail(row.id)
        AppIds.TASKS to PROJECT -> Destination.TasksProject(row.id, row.title)
        AppIds.NOTES to NOTE -> Destination.NotesEditor(row.id, title = row.title)
        AppIds.NOTES to NOTEBOOK -> Destination.NotesLibrary(notebookId = row.id, notebookName = row.title, unfiledOnly = false)
        AppIds.PHOTOS to ALBUM -> Destination.PhotoShelfRoute(
            PhotoShelf(album = PhotoShelf.Album(collection_id = row.id, name = row.title)),
        )
        AppIds.DOCS to FOLDER -> Destination.DocsFolder(row.id, row.title, parent = parent)
        AppIds.DOCS to DOCUMENT -> Destination.DocsDocument(row.id, row.title, parent = parent)
        AppIds.PEOPLE to PERSON -> Destination.PeoplePerson(row.id, row.title)
        AppIds.AGENDA to EVENT -> Destination.AgendaEvent(
            eventId = row.id,
            instanceKey = row.qualifier,
            originalStartLocal = null,
            day = "",
        )
        AppIds.PHOTOS to PHOTO -> Destination.PhotoLightbox(row.id, neighbours.ifEmpty { listOf(row.id) })
        AppIds.MONEY to TRANSACTION -> Destination.MoneyTransaction(row.id, parent = parent)
        else -> appHome(row.app)
    }

    /**
     * [destination] AS THE SCREEN ID AND OPENING EVENT a shell that keys its
     * screens by id opens. [among] is the answer's other references: a
     * photograph's swipe walks the photographs among them, in the order they
     * were shown.
     */
    public fun route(row: RowRef, parent: String = "", among: List<RowRef> = emptyList()): ScreenOpening? {
        val neighbours = among.filter { it.app == AppIds.PHOTOS && it.entity == PHOTO }.map { it.id }
        return destination(row, parent, neighbours)?.let(ScreenOpenings::of)
    }

    /** Whether a reference names one of the member's conversations, which opens in the Chat tab and is no route. */
    public fun isThread(row: RowRef): Boolean = row.app == AppIds.CHAT && row.entity == THREAD

    /** An app's own front door, for a reference whose noun has no row route. */
    public fun appHome(app: String): Destination? = when (app) {
        AppIds.TASKS -> Destination.TasksHome()
        AppIds.NOTES -> Destination.NotesLibrary()
        AppIds.DOCS -> Destination.DocsHome()
        AppIds.PEOPLE -> Destination.PeopleHome()
        AppIds.AGENDA -> Destination.AgendaHome()
        AppIds.PHOTOS -> Destination.PhotosHome()
        AppIds.MONEY -> Destination.MoneyHome()
        AppIds.HEALTH -> Destination.HealthHome()
        else -> null
    }

    /** [appHome] as a route, for a shell that keys its screens by id. */
    public fun appHomeRoute(app: String): ScreenOpening? = appHome(app)?.let(ScreenOpenings::of)
}

/**
 * A ROW REFERENCE IN PLAIN FIELDS: `ChatCard`'s routing shape, which a shell
 * that cannot hand over a Wire message builds directly.
 */
public class RowRef(
    public val app: String,
    public val entity: String,
    public val id: String,
    public val title: String = "",
    /** The second key some nouns need: an event's occurrence. */
    public val qualifier: String = "",
)

/** THE CATALOGUE IDS the apps go by: what a Home tile, a card and a screen id's prefix name. */
public object AppIds {
    public const val TASKS: String = "tasks"
    public const val NOTES: String = "notes"
    public const val DOCS: String = "docs"
    public const val PEOPLE: String = "people"
    public const val AGENDA: String = "agenda"
    public const val PHOTOS: String = "photos"
    public const val MONEY: String = "money"
    public const val HEALTH: String = "health"
    public const val LOCKER: String = "locker"

    /** Not an app: the Chat tab, which a card's reference can name (a conversation). */
    public const val CHAT: String = "chat"
}
