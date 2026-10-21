package dev.centraid.shared

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.ContainerHit
import centraid.core.v1.VaultSearch
import centraid.core.v1.VaultSearchHit
import centraid.core.v1.VaultSearchRequest
import centraid.screen.v1.ChatCard
import centraid.screen.v1.HomeSearchEvent
import centraid.screen.v1.PhotoShelf
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.kit.SearchContainers
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.RowRoutes
import dev.centraid.shared.shell.HomeSearchMachine
import dev.centraid.shared.shell.HomeSearchReads
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe

/**
 * A CONTAINER AS A SEARCH RESULT (#1097, R-1097-19..21), as the shells see it:
 * the one table that names a container's kind and opening key, Home's group
 * putting containers before that app's rows, and the one router that opens each
 * of them (a chat card for a notebook opens through the same table).
 */
class SearchContainersSpec : StringSpec({
    fun hit(app: String, entity: String, id: String, title: String) =
        VaultSearchHit(entity = entity, id = id, title = title, app_id = app, subtitle = app)

    "the four kinds are named once, each with its word, its glyph and the key it opens by" {
        val hits = listOf(
            ContainerHit(entity = "notebook", id = "nb", title = "Cabin", app_id = "notes"),
            ContainerHit(entity = "core.collection", id = "al", title = "Summer", app_id = "photos"),
            ContainerHit(entity = "schedule.project", id = "pr", title = "Garden", app_id = "tasks"),
            ContainerHit(entity = "core.concept", id = "fo", title = "Taxes", app_id = "docs"),
        )
        val rows = SearchContainers.fold(hits)
        rows.map { it.kind_label } shouldContainExactly listOf(
            SharedCopy.SEARCH_KIND_NOTEBOOK,
            SharedCopy.SEARCH_KIND_ALBUM,
            SharedCopy.SEARCH_KIND_PROJECT,
            SharedCopy.SEARCH_KIND_FOLDER,
        )
        rows.map { it.icon_key } shouldContainExactly listOf("Book", "Image", "List", "Folder")
        rows.map { it.target!!.entity } shouldContainExactly listOf("notebook", "album", "project", "folder")
        // EVERY CONTAINER OPENS BY ITS OWN ID.
        rows.map { it.target!!.id } shouldContainExactly listOf("nb", "al", "pr", "fo")
        rows.map { it.id } shouldContainExactly listOf("nb", "al", "pr", "fo")
        rows[0].accessibility_label shouldBe "Notebook, Cabin"
        // An entity this table does not name is no container.
        SearchContainers.fold(listOf(ContainerHit(entity = "core.collection", id = "x", title = "X", app_id = "agenda"))).shouldBeEmpty()
    }

    "Home puts an app's containers before its rows, counts both, and a container-only app still has its group" {
        val data = HomeSearchMachine.fold(
            listOf(
                hit("notes", "note", "n1", "Cabin packing"),
                hit("notes", "note", "n2", "Cabin key"),
                hit("notes", "notebook", "nb", "Cabin"),
                hit("docs", "core.concept", "fo", "Cabin papers"),
            ),
        )
        // GROUPED IN HOME'S TILE ORDER: Docs' tile comes before Notes'.
        data.groups.map { it.app_id } shouldContainExactly listOf("docs", "notes")
        val notes = data.groups[1]
        notes.containers.map { it.title } shouldContainExactly listOf("Cabin")
        notes.rows.map { it.title } shouldContainExactly listOf("Cabin packing", "Cabin key")
        notes.count shouldBe 3
        notes.accessibility_label shouldBe "Notes, 3 results"
        val docs = data.groups[0]
        docs.rows.shouldBeEmpty()
        docs.count shouldBe 1
        docs.containers.single().target shouldBe ChatCard(app = "docs", entity = "folder", id = "fo", title = "Cabin papers")
    }

    "a container answer for an older term is dropped, and one for the current term is drawn" {
        val opened = HomeSearchMachine.reduce(HomeSearchMachine.initial(), HomeSearchEvent(opened = HomeSearchEvent.Opened())).state
        fun typed(state: centraid.screen.v1.HomeSearchState, term: String) =
            HomeSearchMachine.reduce(state, HomeSearchEvent(term = HomeSearchEvent.TermChanged(term = term))).state
        fun answer(term: String) = HomeSearchReads.arrived(
            listOf(AppQueryResponse(vault_search = VaultSearch(hits = listOf(hit("notes", "notebook", "nb", "Cabin"))))),
            listOf(AppQueryRequest(vault_search = VaultSearchRequest(term = term, tz = "Europe/Lisbon"))),
        )
        val second = typed(typed(opened, "ca"), "cabin")
        HomeSearchMachine.reduce(second, answer("ca")).state.data_ shouldBe null
        val current = HomeSearchMachine.reduce(second, answer("cabin")).state
        current.data_!!.groups.single().containers.single().title shouldBe "Cabin"
        // A new term keeps the rows on screen (and with them the containers) while it reads; a cancel clears both.
        HomeSearchMachine.reduce(current, HomeSearchEvent(cancelled = HomeSearchEvent.Cancelled())).state.data_ shouldBe null
    }

    "each container opens where its app opens it, from Home or from a chat card" {
        fun open(app: String, entity: String, id: String, title: String) =
            RowRoutes.destination(ChatCard(app = app, entity = entity, id = id, title = title), parent = "Search")

        open("notes", "notebook", "nb", "Cabin") shouldBe
            Destination.NotesLibrary(notebookId = "nb", notebookName = "Cabin", unfiledOnly = false)
        open("photos", "album", "al", "Summer") shouldBe
            Destination.PhotoShelfRoute(PhotoShelf(album = PhotoShelf.Album(collection_id = "al", name = "Summer")))
        open("tasks", "project", "pr", "Garden") shouldBe Destination.TasksProject("pr", "Garden")
        open("docs", "folder", "fo", "Taxes") shouldBe Destination.DocsFolder("fo", "Taxes", parent = "Search")
        // A noun the table does not name still opens the app's home.
        open("notes", "shelf", "x", "X") shouldBe Destination.NotesLibrary()
    }
})
