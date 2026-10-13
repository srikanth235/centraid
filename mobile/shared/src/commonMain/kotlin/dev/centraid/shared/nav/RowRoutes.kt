package dev.centraid.shared.nav

import centraid.screen.v1.ChatCard

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
 * | tally | `expense` | the expense page |
 * | tally | `friend` | the friend page |
 * | tasks | `task` | the task's detail |
 * | tasks | `project` | the project's list |
 * | notes | `note` | the note's editor |
 * | docs | `document` | the document page |
 * | people | `person` | the person page |
 * | agenda | `event` | the event's detail (`qualifier` is the occurrence) |
 * | photos | `photo` | the lightbox, with [neighbours] as its swipe |
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
        "tally" to "expense" -> Destination.TallyExpense(card.id, parent = parent)
        "tally" to "friend" -> Destination.TallyFriend(card.id, card.title, parent = parent)
        "tasks" to "task" -> Destination.TasksDetail(card.id)
        "tasks" to "project" -> Destination.TasksProject(card.id, card.title)
        "notes" to "note" -> Destination.NotesEditor(card.id, title = card.title)
        "docs" to "document" -> Destination.DocsDocument(card.id, card.title, parent = parent)
        "people" to "person" -> Destination.PeoplePerson(card.id, card.title)
        "agenda" to "event" -> Destination.AgendaEvent(
            eventId = card.id,
            instanceKey = card.qualifier,
            originalStartLocal = null,
            day = "",
        )
        "photos" to "photo" -> Destination.PhotoLightbox(card.id, neighbours.ifEmpty { listOf(card.id) })
        else -> appHome(card.app)
    }

    /** An app's own front door, for a reference whose noun has no row route. */
    public fun appHome(app: String): Destination? = when (app) {
        "tally" -> Destination.TallyApp()
        "tasks" -> Destination.TasksHome()
        "notes" -> Destination.NotesLibrary()
        "docs" -> Destination.DocsHome()
        "people" -> Destination.PeopleHome()
        "agenda" -> Destination.AgendaHome()
        "photos" -> Destination.PhotosHome()
        else -> null
    }
}
