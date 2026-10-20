package dev.centraid.shared

import centraid.core.v1.NotesLibrary
import centraid.core.v1.NotesNotebook
import centraid.core.v1.NotesNotebooks
import centraid.core.v1.NotesRow
import centraid.screen.v1.TileStatus
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.shell.HomeMachine
import dev.centraid.shared.shell.HomeNotesTile
import dev.centraid.shared.shell.HomeReads
import dev.centraid.shared.shell.SpringboardPolicy
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * HOME'S NOTES TILE, THE SHELF: notebooks with their counts over the newest
 * note, and the newest notes when nothing is filed.
 */
class HomeNotesTileSpec : StringSpec({

    fun note(id: String, title: String? = id, day: String = "2026-10-19", preview: String = "") =
        NotesRow(note_id = id, title = title, preview = preview, updated_local_day = day)

    fun notebook(id: String, name: String?, count: Int) =
        NotesNotebook(notebook_id = id, name = name, note_count = count)

    fun arrived(notes: List<NotesRow>, notebooks: List<NotesNotebook> = emptyList(), truncated: Boolean = false) =
        HomeNotesTile.arrived(NotesLibrary(notes = notes, truncated = truncated), NotesNotebooks(notebooks = notebooks))
            .tile.shouldNotBeNull()

    "the shelf is the notebooks that hold notes, in the member's order, three at most" {
        val tile = arrived(
            notes = listOf(note("n1", "Grocery run"), note("n2")),
            notebooks = listOf(
                notebook("a", "Recipes", 12),
                notebook("b", "Empty", 0),
                notebook("c", "Work", 9),
                notebook("d", "Lisbon trip", 4),
                notebook("e", "Garden", 2),
            ),
        )
        tile.status shouldBe TileStatus.TILE_STATUS_CONTENT
        val body = tile.body.shouldNotBeNull().notes.shouldNotBeNull()
        body.notebooks.map { it.name to it.note_count } shouldContainExactly
            listOf("Recipes" to 12, "Work" to 9, "Lisbon trip" to 4)
        // The newest note is the foot: its title, and nothing under it.
        body.note_id shouldBe "n1"
        body.title shouldBe "Grocery run"
        // With a shelf there is no list of notes to draw.
        body.recent.shouldBeEmpty()
    }

    "with nothing filed the tile draws the newest notes instead" {
        val body = arrived(
            notes = listOf(note("n1"), note("n2"), note("n3"), note("n4")),
            notebooks = listOf(notebook("b", "Empty", 0)),
        ).body.shouldNotBeNull().notes.shouldNotBeNull()
        body.notebooks.shouldBeEmpty()
        body.recent.map { it.note_id } shouldContainExactly listOf("n1", "n2", "n3")
    }

    "an untitled note is named by its first line, and an unnamed notebook says so" {
        val body = arrived(
            notes = listOf(note("n1", title = " ", preview = "\n  Buy oat milk\nlemons")),
            notebooks = listOf(notebook("a", null, 1)),
        ).body.shouldNotBeNull().notes.shouldNotBeNull()
        body.title shouldBe "Buy oat milk"
        body.notebooks.single().name shouldBe "Untitled notebook"
        arrived(listOf(note("n1", title = null))).body!!.notes!!.recent.single().title shouldBe "Untitled note"
    }

    "the count is the library's, capped when the library says more exist" {
        val tile = arrived(List(3) { note("n$it") }, truncated = true)
        tile.count.shouldNotBeNull().value_ shouldBe 3
        tile.count.shouldNotBeNull().capped shouldBe true
        tile.count_label shouldBe "notes"
        arrived(listOf(note("n1"))).count_label shouldBe "note"
    }

    "no notes is EMPTY with a stated zero, never UNKNOWN" {
        val tile = arrived(emptyList(), notebooks = listOf(notebook("a", "Recipes", 0)))
        tile.status shouldBe TileStatus.TILE_STATUS_EMPTY
        tile.count.shouldNotBeNull().value_ shouldBe 0
        tile.body.shouldBeNull()
    }

    "it asks the library in the device's zone, then the spine" {
        val requests = HomeNotesTile.requests(DeviceClock.Reading(epochMillis = 0, zone = "Europe/Lisbon"))
        requests.map { it.notes_library?.tz } shouldContainExactly listOf("Europe/Lisbon", null)
        requests[1].notes_notebooks.shouldNotBeNull()
    }

    "Home re-reads on the notes, the notebooks and the filing, and Notes is no page read" {
        HomeNotesTile.TABLES.forEach { table ->
            withClue(table) {
                HomeReads.TABLES shouldContain table
                HomeMachine.rowsChanged(table, listOf("k")).shouldNotBeNull()
            }
        }
        HomeReads.READS.map { it.appId } shouldNotContain "notes"
        HomeReads.READ_APP_IDS shouldContain "notes"
    }

    "a shelf is half width, so the six smalls pair and no tile is left alone" {
        SpringboardPolicy.isWide("notes") shouldBe false
    }
})
