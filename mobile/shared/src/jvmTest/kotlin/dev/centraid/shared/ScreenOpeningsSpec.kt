package dev.centraid.shared

import centraid.core.v1.AgendaDestination
import centraid.core.v1.DocsDestination
import centraid.core.v1.Route
import centraid.screen.v1.PhotoShelf
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
import dev.centraid.shared.nav.AgendaEntry
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.DocsEntry
import dev.centraid.shared.nav.RowRef
import dev.centraid.shared.nav.RowRoutes
import dev.centraid.shared.nav.ScreenIds
import dev.centraid.shared.nav.ScreenOpenings
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe

/**
 * NAVIGATION IS STATED ONCE, FOR A SHELL THAT CANNOT HOLD A [Destination]
 * (SwiftUI's views take bytes): the table that names where a reference opens,
 * answer as a screen id and an `Opened` event, and those
 * are the destinations Android pushes, spelled.
 */
class ScreenOpeningsSpec : StringSpec({
    fun row(app: String, entity: String, id: String, title: String = "", qualifier: String = "") =
        RowRef(app, entity, id, title, qualifier)

    "every row the table names opens the screen its machine owns, on the event that screen opens by" {
        val note = RowRoutes.route(row("notes", "note", "n1"))!!
        note.screenId shouldBe NotesEditorMachine.SCREEN_ID

        val notebook = RowRoutes.route(row("notes", "notebook", "nb", "Cabin"))!!
        notebook.screenId shouldBe NotesLibraryMachine.SCREEN_ID

        // DOCS' SCREENS ARE RUST'S (#1135): a document and a folder open as the Route Rust's registry
        // names, carrying the pushing page's title as their back word.
        val doc = RowRoutes.route(row("docs", "document", "d1", "Lease"), parent = "Search")!!
        doc shouldBe DocsEntry.document("d1", "Lease", parent = "Search")
        val folder = RowRoutes.route(row("docs", "folder", "f1", "Taxes"), parent = "Search")!!
        val opened = (folder as Destination.RustScreen).route.docs_drive!!
        opened.destination shouldBe DocsDestination.DOCS_DESTINATION_FOLDERS
        opened.folder_id shouldBe "f1"
        opened.folder_name shouldBe "Taxes"
        opened.parent shouldBe "Search"

        RowRoutes.route(row("people", "person", "pe1", "Ada"))!!.screenId shouldBe PeoplePersonMachine.SCREEN_ID
        RowRoutes.route(row("money", "transaction", "tx1"))!!.screenId shouldBe MoneyTransactionMachine.SCREEN_ID
        // A NOTE MAY LINK A LOCKER ITEM (#1135), and opening the link is Locker's page, which the
        // lock wall covers like every Locker destination.
        RowRoutes.route(row("locker", "locker_item", "lk1", "Bank"))!!.screenId shouldBe
            dev.centraid.shared.nav.ScreenIds.LOCKER_ITEM

        val shelf = RowRoutes.route(row("photos", "album", "al", "Summer"))!!
        shelf.screenId shouldBe PhotoShelfMachine.SCREEN_ID
        PhotoShelf.ADAPTER.decode(shelf.event).album!!.collection_id shouldBe "al"
    }

    "a photograph's swipe walks the photographs among the answer, in the order it showed them" {
        val among = listOf(
            row("agenda", "task", "t1"),
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
                RowRoutes.route(row("people", "tag", "x"))!!.screenId shouldBe PeopleHomeMachine.SCREEN_ID
        RowRoutes.route(row("money", "tag", "x"))!!.screenId shouldBe MoneyHomeMachine.SCREEN_ID
        RowRoutes.route(row("health", "activity", "x"))!!.screenId shouldBe HealthHomeMachine.SCREEN_ID
        RowRoutes.route(row("photos", "tag", "x"))!!.screenId shouldBe PhotosGridMachine.SCREEN_ID
        RowRoutes.route(row("weather", "forecast", "x")).shouldBeNull()
        RowRoutes.appHomeRoute("locker").shouldBeNull()
    }

    "a conversation is the Chat tab's, never a route" {
        RowRoutes.isThread(row("chat", "thread", "c1")) shouldBe true
        RowRoutes.isThread(row("agenda", "thread", "c1")) shouldBe false
    }

    "a route is its destination, spelled: a destination no route spells is null, not a guess" {
        ScreenOpenings.of(Destination.Settings).shouldBeNull()
        // Agenda's pages are Rust's (#1135): the opening is the `Route`, encoded, under one screen id.
        val rust = ScreenOpenings.of(AgendaEntry.home())!!
        rust.screenId shouldBe ScreenIds.RUST_SCREEN
        Route.ADAPTER.decode(rust.event).screen shouldBe "agenda.home"
    }

    "Agenda's rows and front doors are Rust routes the shell pushes" {
        fun open(app: String, entity: String, id: String, title: String = "", qualifier: String = "") =
            RowRoutes.destination(row(app, entity, id, title, qualifier))

        val task = open("agenda", "task", "t1") as Destination.RustScreen
        task.route.screen shouldBe "agenda.task"
        task.route.todo_detail!!.task_id shouldBe "t1"

        val project = open("agenda", "project", "p1", "Garden") as Destination.RustScreen
        project.route.screen shouldBe "agenda.project"
        project.route.todo_project!!.project_id shouldBe "p1"
        project.route.todo_project!!.name shouldBe "Garden"

        val event = open("agenda", "event", "e1", qualifier = "2026-10-17") as Destination.RustScreen
        event.route.screen shouldBe "agenda.event"
        event.route.agenda_event!!.event_id shouldBe "e1"
        event.route.agenda_event!!.instance_key shouldBe "2026-10-17"

        // A noun the table has no row for opens the app's home: Agenda's, on Day.
        val home = open("agenda", "tag", "x") as Destination.RustScreen
        home.route.screen shouldBe "agenda.home"
        home.route.agenda_home!!.destination shouldBe AgendaDestination.AGENDA_DESTINATION_DAY

        // Notes' "Send to Agenda" lands on To-do with the words in the quick add.
        val sent = AgendaEntry.home(AgendaDestination.AGENDA_DESTINATION_TODO, quickAdd = "Buy milk")
        sent.route.agenda_home!!.destination shouldBe AgendaDestination.AGENDA_DESTINATION_TODO
        sent.route.agenda_home!!.quick_add_title shouldBe "Buy milk"
    }
})
