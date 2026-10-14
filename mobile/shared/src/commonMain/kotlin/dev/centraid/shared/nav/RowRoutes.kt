package dev.centraid.shared.nav

import centraid.screen.v1.ChatCard
import centraid.screen.v1.PhotoShelf

/**
 * WHERE A REFERENCE TO ONE ROW OPENS (R-CHROME-6).
 *
 * A row reference is `ChatCard`'s shape — an app, the row's noun in that app
 * (`task`, `event`, `person`…), its id and a second key — and iOS has routed
 * it since the chat's cards (`ChatRouting.swift`). This is the same table for
 * a shell that routes by [Destination], so Home's search opens a row on
 * Android exactly where a chat card opens it on iOS:
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
 * | chat | `thread` | none: Chat is a tab and not a screen. The iOS shell opens it (`ShellModel.openChatThread`), and Android has no Chat tab, so Home's search never offers the row there (R-1097-24) |
 *
 * A notebook, album or folder arrives with its id and its name (the
 * card's `title`) and nothing else, which is all each destination needs: the
 * names ride along the route so the head has words before the page reads.
 *
 * An entity this table has no row for opens the app's home; an app it does
 * not know is null, and the stack stays put.
 */
public object RowRoutes {
    /** [parent] is the pushing page's title, which a pushed page's back says. */
    public fun destination(
        card: ChatCard,
        parent: String = "",
        neighbours: List<String> = emptyList(),
    ): Destination? = when (card.app to card.entity) {
        "tasks" to "task" -> Destination.TasksDetail(card.id)
        "tasks" to "project" -> Destination.TasksProject(card.id, card.title)
        "notes" to "note" -> Destination.NotesEditor(card.id, title = card.title)
        "notes" to "notebook" -> Destination.NotesLibrary(notebookId = card.id, notebookName = card.title, unfiledOnly = false)
        "photos" to "album" -> Destination.PhotoShelfRoute(
            PhotoShelf(album = PhotoShelf.Album(collection_id = card.id, name = card.title)),
        )
        "docs" to "folder" -> Destination.DocsFolder(card.id, card.title, parent = parent)
        "docs" to "document" -> Destination.DocsDocument(card.id, card.title, parent = parent)
        "people" to "person" -> Destination.PeoplePerson(card.id, card.title)
        "agenda" to "event" -> Destination.AgendaEvent(
            eventId = card.id,
            instanceKey = card.qualifier,
            originalStartLocal = null,
            day = "",
        )
        "photos" to "photo" -> Destination.PhotoLightbox(card.id, neighbours.ifEmpty { listOf(card.id) })
        "money" to "transaction" -> Destination.MoneyTransaction(card.id, parent = parent)
        else -> appHome(card.app)
    }

    /** An app's own front door, for a reference whose noun has no row route. */
    public fun appHome(app: String): Destination? = when (app) {
        "tasks" -> Destination.TasksHome()
        "notes" -> Destination.NotesLibrary()
        "docs" -> Destination.DocsHome()
        "people" -> Destination.PeopleHome()
        "agenda" -> Destination.AgendaHome()
        "photos" -> Destination.PhotosHome()
        "money" -> Destination.MoneyHome()
        else -> null
    }
}
