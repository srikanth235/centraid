package dev.centraid.shared.nav

import centraid.screen.v1.AgendaEventEvent
import centraid.screen.v1.AgendaHomeEvent
import centraid.screen.v1.DocsDocumentEvent
import centraid.screen.v1.DocsDriveEvent
import centraid.screen.v1.DocsDriveState
import centraid.screen.v1.MoneyHomeEvent
import centraid.screen.v1.MoneyTransactionEvent
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesLibraryEvent
import centraid.screen.v1.PeopleHomeEvent
import centraid.screen.v1.PeoplePersonEvent
import centraid.screen.v1.TasksCatchUpEvent
import centraid.screen.v1.TasksDetailEvent
import centraid.screen.v1.TasksHomeEvent
import centraid.screen.v1.TasksListEvent
import centraid.screen.v1.TasksProjectEvent
import centraid.screen.v1.TrashListEvent

/**
 * ONE ROUTE, AS A SHELL THAT KEYS ITS SCREENS BY ID OPENS IT.
 *
 * A [Destination] is the stack's value in a shell that pushes Kotlin; a shell
 * whose views are written in another language (SwiftUI) cannot hold one, so it
 * is handed this: the screen's id ([ScreenIds], which its machine's `SCREEN_ID`
 * is) and the screen's own `Opened` event, encoded, which the shell sends as it
 * stands. Nothing
 * here is a second table of where things go: [ScreenOpenings.of] only SPELLS a
 * destination the shared side already chose.
 *
 * The photographs are not registry screens, so they ride the same value:
 * [screenId] names the machine, [event] is a shelf's `PhotoShelf`, and
 * [assetId] and [neighbours] are the lightbox's photograph and swipe order.
 */
public class ScreenOpening(
    public val screenId: String,
    public val event: ByteArray = ByteArray(0),
    public val assetId: String = "",
    public val neighbours: List<String> = emptyList(),
)

/** A [Destination], spelled as the screen id and `Opened` event its screen takes. */
public object ScreenOpenings {
    /**
     * The route [destination] opens, or null for a destination no route
     * spells (a shell-owned page, or one the callers have not needed yet).
     */
    public fun of(destination: Destination): ScreenOpening? = when (destination) {
        is Destination.TasksHome -> screen(
            ScreenIds.TASKS_HOME,
            TasksHomeEvent(
                opened = TasksHomeEvent.Opened(
                    destination = destination.destination,
                    quick_add_title = destination.quickAdd,
                ),
            ).encode(),
        )
        is Destination.TasksList -> screen(
            ScreenIds.TASKS_LIST,
            TasksListEvent(opened = TasksListEvent.Opened(view = destination.view)).encode(),
        )
        is Destination.TasksProject -> screen(
            ScreenIds.TASKS_PROJECT,
            TasksProjectEvent(
                opened = TasksProjectEvent.Opened(project_id = destination.projectId, title = destination.name),
            ).encode(),
        )
        is Destination.TasksDetail -> screen(
            ScreenIds.TASKS_DETAIL,
            TasksDetailEvent(opened = TasksDetailEvent.Opened(task_id = destination.taskId)).encode(),
        )
        Destination.TasksCatchUp -> screen(
            ScreenIds.TASKS_CATCH_UP,
            TasksCatchUpEvent(opened = TasksCatchUpEvent.Opened()).encode(),
        )
        Destination.TasksTrash -> screen(
            ScreenIds.TASKS_TRASH,
            TrashListEvent(opened = TrashListEvent.Opened()).encode(),
        )
        is Destination.NotesEditor -> screen(
            ScreenIds.NOTES_EDITOR,
            NotesEditorEvent(opened = NotesEditorEvent.Opened(note_id = destination.noteId, is_new = destination.isNew)).encode(),
        )
        is Destination.NotesLibrary -> screen(
            ScreenIds.NOTES_LIBRARY,
            NotesLibraryEvent(
                opened = NotesLibraryEvent.Opened(
                    notebook_id = destination.notebookId,
                    notebook_name = destination.notebookName,
                    unfiled_only = destination.unfiledOnly,
                ),
            ).encode(),
        )
        is Destination.DocsHome -> screen(
            ScreenIds.DOCS_DRIVE,
            DocsDriveEvent(opened = DocsDriveEvent.Opened(destination = destination.destination)).encode(),
        )
        is Destination.DocsFolder -> screen(
            ScreenIds.DOCS_FOLDER,
            DocsDriveEvent(
                opened = DocsDriveEvent.Opened(
                    destination = DocsDriveState.Destination.DESTINATION_FOLDERS,
                    folder_id = destination.folderId,
                    folder_name = destination.folderName,
                    parent = destination.parent,
                ),
            ).encode(),
        )
        is Destination.DocsDocument -> screen(
            ScreenIds.DOCS_DOCUMENT,
            DocsDocumentEvent(
                opened = DocsDocumentEvent.Opened(
                    document_id = destination.documentId,
                    title = destination.title,
                    parent = destination.parent,
                ),
            ).encode(),
        )
        is Destination.PeopleHome -> screen(
            ScreenIds.PEOPLE_HOME,
            PeopleHomeEvent(opened = PeopleHomeEvent.Opened(destination = destination.destination)).encode(),
        )
        is Destination.PeoplePerson -> screen(
            ScreenIds.PEOPLE_PERSON,
            PeoplePersonEvent(
                opened = PeoplePersonEvent.Opened(
                    party_id = destination.partyId,
                    name = destination.name,
                    log_touch = destination.logTouch,
                ),
            ).encode(),
        )
        is Destination.AgendaHome -> screen(
            ScreenIds.AGENDA_HOME,
            AgendaHomeEvent(opened = AgendaHomeEvent.Opened(destination = destination.destination)).encode(),
        )
        is Destination.AgendaEvent -> screen(
            ScreenIds.AGENDA_EVENT,
            AgendaEventEvent(
                opened = AgendaEventEvent.Opened(
                    event_id = destination.eventId,
                    instance_key = destination.instanceKey,
                    original_start_local = destination.originalStartLocal,
                    day = destination.day,
                ),
            ).encode(),
        )
        is Destination.MoneyHome -> screen(
            ScreenIds.MONEY_HOME,
            MoneyHomeEvent(opened = MoneyHomeEvent.Opened(destination = destination.destination)).encode(),
        )
        is Destination.MoneyTransaction -> screen(
            ScreenIds.MONEY_TRANSACTION,
            MoneyTransactionEvent(
                opened = MoneyTransactionEvent.Opened(txn_id = destination.txnId, parent = destination.parent),
            ).encode(),
        )
        // THE PHOTOGRAPHS: a shelf is its `PhotoShelf`, a lightbox its photograph and swipe.
        is Destination.PhotoShelfRoute -> screen(ScreenIds.PHOTOS_SHELF, destination.shelf.encode())
        is Destination.PhotoLightbox -> ScreenOpening(
            ScreenIds.PHOTOS_LIGHTBOX,
            assetId = destination.assetId,
            neighbours = destination.neighbours,
        )
        is Destination.PhotosHome -> ScreenOpening(ScreenIds.PHOTOS_GRID)
        else -> null
    }

    private fun screen(screenId: String, event: ByteArray): ScreenOpening = ScreenOpening(screenId, event)
}
