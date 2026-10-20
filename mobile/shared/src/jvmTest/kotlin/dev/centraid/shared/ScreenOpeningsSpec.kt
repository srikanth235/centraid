package dev.centraid.shared

import centraid.screen.v1.AgendaEventEvent
import centraid.screen.v1.DocsDriveEvent
import centraid.screen.v1.DocsDriveState
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.TasksCatchUpEvent
import centraid.screen.v1.TasksDetailEvent
import centraid.screen.v1.TasksDetailState
import centraid.screen.v1.TasksHomeEvent
import centraid.screen.v1.TasksHomeState
import centraid.screen.v1.TasksListEvent
import centraid.screen.v1.TasksListState
import dev.centraid.shared.apps.agenda.AgendaEventMachine
import dev.centraid.shared.apps.docs.DocsDocumentMachine
import dev.centraid.shared.apps.docs.DocsDriveMachine
import dev.centraid.shared.apps.health.HealthHomeMachine
import dev.centraid.shared.apps.money.MoneyHomeMachine
import dev.centraid.shared.apps.money.MoneyTransactionMachine
import dev.centraid.shared.apps.notes.NotesEditorMachine
import dev.centraid.shared.apps.notes.NotesLibraryMachine
import dev.centraid.shared.apps.people.PeopleHomeMachine
import dev.centraid.shared.apps.people.PeoplePersonMachine
import dev.centraid.shared.apps.photos.PhotoLightboxMachine
import dev.centraid.shared.apps.photos.PhotoShelfMachine
import dev.centraid.shared.apps.photos.PhotosGridMachine
import dev.centraid.shared.apps.tasks.TasksCatchUpMachine
import dev.centraid.shared.apps.tasks.TasksDetailMachine
import dev.centraid.shared.apps.tasks.TasksHomeMachine
import dev.centraid.shared.apps.tasks.TasksListMachine
import dev.centraid.shared.apps.tasks.TasksProjectMachine
import dev.centraid.shared.apps.tasks.TasksRouting
import dev.centraid.shared.apps.tasks.TasksTrashMachine
import dev.centraid.shared.nav.AppIds
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.RowRef
import dev.centraid.shared.nav.RowRoutes
import dev.centraid.shared.nav.ScreenOpenings
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * NAVIGATION IS STATED ONCE, FOR A SHELL THAT CANNOT HOLD A [Destination]
 * (SwiftUI's views take bytes): the table that names where a reference opens,
 * and Tasks' intents, answer as a screen id and an `Opened` event, and those
 * are the destinations Android pushes, spelled.
 */
class ScreenOpeningsSpec : StringSpec({
    fun row(app: String, entity: String, id: String, title: String = "", qualifier: String = "") =
        RowRef(app, entity, id, title, qualifier)

    "every row the table names opens the screen its machine owns, on the event that screen opens by" {
        val task = RowRoutes.route(row("tasks", "task", "t1"))!!
        task.screenId shouldBe TasksDetailMachine.SCREEN_ID
        TasksDetailEvent.ADAPTER.decode(task.event).opened!!.task_id shouldBe "t1"

        val project = RowRoutes.route(row("tasks", "project", "p1", "Garden"))!!
        project.screenId shouldBe TasksProjectMachine.SCREEN_ID

        val note = RowRoutes.route(row("notes", "note", "n1"))!!
        note.screenId shouldBe NotesEditorMachine.SCREEN_ID

        val notebook = RowRoutes.route(row("notes", "notebook", "nb", "Cabin"))!!
        notebook.screenId shouldBe NotesLibraryMachine.SCREEN_ID

        val doc = RowRoutes.route(row("docs", "document", "d1", "Lease"), parent = "Search")!!
        doc.screenId shouldBe DocsDocumentMachine.SCREEN_ID

        // A folder is the drive's machine on its own key, so the drive under it keeps its tab.
        val folder = RowRoutes.route(row("docs", "folder", "f1", "Taxes"), parent = "Search")!!
        folder.screenId shouldBe DocsDriveMachine.FOLDER_SCREEN_ID
        val opened = DocsDriveEvent.ADAPTER.decode(folder.event).opened!!
        opened.destination shouldBe DocsDriveState.Destination.DESTINATION_FOLDERS
        opened.folder_id shouldBe "f1"
        opened.folder_name shouldBe "Taxes"
        opened.parent shouldBe "Search"

        RowRoutes.route(row("people", "person", "pe1", "Ada"))!!.screenId shouldBe PeoplePersonMachine.SCREEN_ID
        RowRoutes.route(row("money", "transaction", "tx1"))!!.screenId shouldBe MoneyTransactionMachine.SCREEN_ID

        val event = RowRoutes.route(row("agenda", "event", "e1", qualifier = "2026-10-17"))!!
        event.screenId shouldBe AgendaEventMachine.SCREEN_ID
        AgendaEventEvent.ADAPTER.decode(event.event).opened!!.instance_key shouldBe "2026-10-17"

        val shelf = RowRoutes.route(row("photos", "album", "al", "Summer"))!!
        shelf.screenId shouldBe PhotoShelfMachine.SCREEN_ID
        PhotoShelf.ADAPTER.decode(shelf.event).album!!.collection_id shouldBe "al"
    }

    "a photograph's swipe walks the photographs among the answer, in the order it showed them" {
        val among = listOf(
            row("tasks", "task", "t1"),
            row("photos", "photo", "a"),
            row("photos", "photo", "b"),
        )
        val lightbox = RowRoutes.route(row("photos", "photo", "b"), among = among)!!
        lightbox.screenId shouldBe PhotoLightboxMachine.SCREEN_ID
        lightbox.assetId shouldBe "b"
        lightbox.neighbours shouldContainExactly listOf("a", "b")
        // Alone, it is its own swipe.
        RowRoutes.route(row("photos", "photo", "z"))!!.neighbours shouldContainExactly listOf("z")
    }

    "a noun the table has no row for opens the app's home, an unknown app opens nothing" {
        RowRoutes.route(row("tasks", "tag", "x"))!!.screenId shouldBe TasksHomeMachine.SCREEN_ID
        RowRoutes.route(row("people", "tag", "x"))!!.screenId shouldBe PeopleHomeMachine.SCREEN_ID
        RowRoutes.route(row("money", "tag", "x"))!!.screenId shouldBe MoneyHomeMachine.SCREEN_ID
        RowRoutes.route(row("health", "activity", "x"))!!.screenId shouldBe HealthHomeMachine.SCREEN_ID
        RowRoutes.route(row("photos", "tag", "x"))!!.screenId shouldBe PhotosGridMachine.SCREEN_ID
        RowRoutes.route(row("weather", "forecast", "x")).shouldBeNull()
        RowRoutes.appHomeRoute(AppIds.TASKS)!!.screenId shouldBe TasksHomeMachine.SCREEN_ID
        RowRoutes.appHomeRoute("locker").shouldBeNull()
    }

    "a conversation is the Chat tab's, never a route" {
        RowRoutes.isThread(row("chat", "thread", "c1")) shouldBe true
        RowRoutes.isThread(row("tasks", "thread", "c1")) shouldBe false
    }

    "a route is its destination, spelled: the same screen id the shell registers and the event it opens by" {
        ScreenOpenings.of(Destination.TasksHome())!!.run {
            screenId shouldBe TasksHomeMachine.SCREEN_ID
            TasksHomeEvent.ADAPTER.decode(event).opened!!.destination shouldBe TasksHomeState.Destination.DESTINATION_TODAY
        }
        ScreenOpenings.of(Destination.TasksList(TasksListState.View.VIEW_LOGBOOK))!!.run {
            screenId shouldBe TasksListMachine.SCREEN_ID
            TasksListEvent.ADAPTER.decode(event).opened!!.view shouldBe TasksListState.View.VIEW_LOGBOOK
        }
        ScreenOpenings.of(Destination.TasksCatchUp)!!.screenId shouldBe TasksCatchUpMachine.SCREEN_ID
        ScreenOpenings.of(Destination.TasksTrash)!!.screenId shouldBe TasksTrashMachine.machine.screenId
        // A destination no route spells is null, not a guess.
        ScreenOpenings.of(Destination.Settings).shouldBeNull()
    }

    "every More row of Tasks' home is a page the shell pushes, or the machine's own" {
        val rows = TasksHomeMachine.initial().screen.more_rows.map { it.key }
        val state = TasksHomeState()
        val routed = rows.filter { key ->
            TasksRouting.home(TasksHomeEvent(more_row = TasksHomeEvent.MoreRowPicked(key = key)), state) != null
        }
        // `reads` is a sheet over the home; every other row is a destination.
        rows.filterNot { it in routed } shouldContainExactly listOf(TasksHomeMachine.MORE_READS)
        TasksRouting.home(TasksHomeEvent(more_row = TasksHomeEvent.MoreRowPicked(key = TasksHomeMachine.MORE_TRASH)), state) shouldBe
            Destination.TasksTrash
        TasksRouting.home(TasksHomeEvent(more_row = TasksHomeEvent.MoreRowPicked(key = TasksHomeMachine.MORE_CATCH_UP)), state) shouldBe
            Destination.TasksCatchUp
        TasksRouting.home(TasksHomeEvent(more_row = TasksHomeEvent.MoreRowPicked(key = TasksHomeMachine.MORE_ALL)), state) shouldBe
            Destination.TasksList(TasksListState.View.VIEW_ALL)
    }

    "Tasks' intents, asked as bytes, answer the destination Android would push" {
        val picked = TasksHomeEvent(row_picked = TasksHomeEvent.RowPicked(task_id = "t9"))
        val route = TasksRouting.route(TasksHomeMachine.SCREEN_ID, picked.encode(), TasksHomeState().encode())
        route.shouldNotBeNull()
        route.screenId shouldBe TasksDetailMachine.SCREEN_ID
        TasksDetailEvent.ADAPTER.decode(route.event).opened!!.task_id shouldBe "t9"

        // A task with no id, an event that routes nowhere and bytes that are not an event open nothing.
        TasksRouting.route(TasksHomeMachine.SCREEN_ID, TasksHomeEvent(row_picked = TasksHomeEvent.RowPicked()).encode(), ByteArray(0)).shouldBeNull()
        TasksRouting.route(TasksHomeMachine.SCREEN_ID, TasksHomeEvent().encode(), ByteArray(0)).shouldBeNull()
        TasksRouting.route(TasksHomeMachine.SCREEN_ID, byteArrayOf(-1, -1, -1), ByteArray(0)).shouldBeNull()
        TasksRouting.route("notes.library", picked.encode(), ByteArray(0)).shouldBeNull()

        val catchUp = TasksCatchUpEvent(row_picked = TasksCatchUpEvent.RowPicked(task_id = "t2"))
        TasksRouting.route(TasksCatchUpMachine.SCREEN_ID, catchUp.encode(), ByteArray(0))!!.screenId shouldBe TasksDetailMachine.SCREEN_ID
    }

    "a detail's parent opens the task it hangs from, once the state names it" {
        val parent = TasksDetailEvent(parent_picked = TasksDetailEvent.ParentPicked())
        TasksRouting.detail(parent, TasksDetailState()).shouldBeNull()
        val state = TasksDetailState(data_ = centraid.screen.v1.TasksDetailData(parent_task_id = "up"))
        TasksRouting.detail(parent, state) shouldBe Destination.TasksDetail("up")
    }
})
