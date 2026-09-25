package dev.centraid.core

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.Command
import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.NotesHistoryRequest
import centraid.core.v1.NotesJournalRequest
import centraid.core.v1.NotesLibrary
import centraid.core.v1.NotesLibraryRequest
import centraid.core.v1.NotesNote
import centraid.core.v1.NotesNoteRequest
import centraid.core.v1.NotesNotebooksRequest
import centraid.core.v1.NotesSearchRequest
import centraid.core.v1.NotesSort
import centraid.core.v1.NotesTrashRequest
import centraid.core.v1.Request
import dev.centraid.core.AbiRoundTripSpec.Companion.openRealCore
import dev.centraid.core.AbiRoundTripSpec.Companion.shouldBeAnsweredWith
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.longs.shouldBeGreaterThan
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import java.time.LocalDate
import java.time.ZoneId
import okio.ByteString.Companion.encodeUtf8

/**
 * NOTES' QUERIES, KOTLIN TO RUST AND BACK (#1046).
 *
 * The phone's Notes had one page read of one table and an editor that saved
 * title and body. `app_query` at 40–47 runs `crates/apps/notes`' folds in the
 * core — the library window plus every pin, the journal asymmetry, the
 * revision chain, the FTS door — and answers typed messages Wire decodes like
 * everything else the core says.
 *
 * Over JNA, against the real `libcentraid_core_ffi` and the vault
 * `spike-fixture` founded — nothing faked. The fixture vault is shared by every
 * spec in the run, so each case asks about the notes it wrote and no others.
 */
class NotesQueryRoundTripSpec : StringSpec({

    "notes.note answers the whole body and a base revision that moves only with the body" {
        val core = openRealCore()
        try {
            val noteId = core.write(
                "knowledge.create_note",
                """{"title":"Round trip","body_text":"kotlin to rust and back"}""",
                key = "notes-round-trip-create",
            )
            val opened = core.note(noteId)
            opened.found shouldBe true
            opened.title shouldBe "Round trip"
            opened.body shouldBe "kotlin to rust and back"
            opened.current_revision_id shouldNotBe null

            // A TITLE EDIT RECORDS NO BODY OCCURRENCE: the base an autosave
            // compares against stays put, and `row_version` moves.
            core.write(
                "knowledge.edit_note",
                """{"note_id":"$noteId","title":"Round trip, renamed"}""",
                key = "notes-round-trip-rename",
            )
            val renamed = core.note(noteId)
            renamed.title shouldBe "Round trip, renamed"
            renamed.current_revision_id shouldBe opened.current_revision_id
            renamed.row_version shouldBeGreaterThan opened.row_version

            core.write(
                "knowledge.edit_note",
                """{"note_id":"$noteId","body_text":"second draft"}""",
                key = "notes-round-trip-body",
            )
            core.note(noteId).current_revision_id shouldNotBe opened.current_revision_id
            var bodies = emptyList<String>()
            core.appQuery(AppQueryRequest(notes_history = NotesHistoryRequest(note_id = noteId)))
                .shouldBeAnsweredWith { envelope ->
                    bodies = envelope.appQuery().notes_history?.versions?.map { it.body }
                        ?: error("a history answer, got ${envelope.appQuery()}")
                }
            bodies shouldBe listOf("second draft", "kotlin to rust and back")

            // A MISS IS `found = false`, never an empty note to save over.
            core.note("no-such-note").found shouldBe false
        } finally {
            core.close()
        }
    }

    "a trashed note leaves the library and the search for the trash shelf" {
        val core = openRealCore()
        try {
            val kept = core.write(
                "knowledge.create_note",
                """{"title":"Quince paste","body_text":"quince, sugar, lemon"}""",
                key = "notes-round-trip-kept",
            )
            val gone = core.write(
                "knowledge.create_note",
                """{"title":"Quince jelly","body_text":"quince that did not set"}""",
                key = "notes-round-trip-gone",
            )
            core.library().notes.map { it.note_id }.let { ids ->
                ids shouldContain kept
                ids shouldContain gone
            }
            core.write(
                "knowledge.delete_note",
                """{"note_id":"$gone"}""",
                key = "notes-round-trip-delete",
            )
            val shelf = core.library().notes.map { it.note_id }
            shelf shouldContain kept
            shelf shouldNotContain gone

            var trashed = emptyList<String>()
            core.appQuery(AppQueryRequest(notes_trash = NotesTrashRequest()))
                .shouldBeAnsweredWith { envelope ->
                    trashed = envelope.appQuery().notes_trash?.notes?.map { it.note_id }
                        ?: error("a trash answer, got ${envelope.appQuery()}")
                }
            trashed shouldContain gone
            trashed shouldNotContain kept

            var hits = emptyList<String>()
            core.appQuery(AppQueryRequest(notes_search = NotesSearchRequest(term = "quince")))
                .shouldBeAnsweredWith { envelope ->
                    hits = envelope.appQuery().notes_search?.hits?.map { it.note_id }
                        ?: error("a search answer, got ${envelope.appQuery()}")
                }
            hits shouldContain kept
            hits shouldNotContain gone

            // THE SORT IS THE CORE'S: by title, pins first.
            var titled: NotesLibrary? = null
            core.appQuery(
                AppQueryRequest(notes_library = NotesLibraryRequest(sort = NotesSort.NOTES_SORT_TITLE)),
            ).shouldBeAnsweredWith { envelope ->
                titled = envelope.appQuery().notes_library
            }
            val unpinned = titled!!.notes.filterNot { it.pinned }.map { it.title.orEmpty().lowercase() }
            unpinned shouldBe unpinned.sorted()

            core.appQuery(AppQueryRequest(notes_notebooks = NotesNotebooksRequest()))
                .shouldBeAnsweredWith { envelope ->
                    envelope.appQuery().notes_notebooks shouldNotBe null
                }
        } finally {
            core.close()
        }
    }

    "notes.journal answers today in the zone the shell states" {
        val core = openRealCore()
        try {
            core.appQuery(
                AppQueryRequest(notes_journal = NotesJournalRequest(tz = TZ)),
            ).shouldBeAnsweredWith { envelope ->
                val journal = envelope.appQuery().notes_journal
                    ?: error("a journal answer, got ${envelope.appQuery()}")
                // The core's clock is the real one here, so the device's day
                // is what `java.time` reads in the same zone.
                journal.today shouldBe LocalDate.now(ZoneId.of(TZ)).toString()
            }
        } finally {
            core.close()
        }
    }
}) {
    companion object {
        private const val TZ = "America/New_York"

        suspend fun CentraidCore.appQuery(query: AppQueryRequest): CoreOutcome<Envelope> =
            call(Envelope(request_id = 1, request = Request(app_query = query)))

        fun Envelope.appQuery(): AppQueryResponse =
            response?.app_query ?: error("an AppQueryResponse, got $this")

        suspend fun CentraidCore.library(): NotesLibrary {
            var answer: NotesLibrary? = null
            appQuery(AppQueryRequest(notes_library = NotesLibraryRequest()))
                .shouldBeAnsweredWith { envelope ->
                    answer = envelope.appQuery().notes_library
                        ?: error("a library answer, got ${envelope.appQuery()}")
                }
            return answer!!
        }

        suspend fun CentraidCore.note(noteId: String): NotesNote {
            var answer: NotesNote? = null
            appQuery(AppQueryRequest(notes_note = NotesNoteRequest(note_id = noteId)))
                .shouldBeAnsweredWith { envelope ->
                    answer = envelope.appQuery().notes_note
                        ?: error("a note answer, got ${envelope.appQuery()}")
                }
            return answer!!
        }

        /** One command through the command plane; answers its `note_id`, if any. */
        suspend fun CentraidCore.write(name: String, input: String, key: String): String {
            var noteId = ""
            call(
                Envelope(
                    request_id = 1,
                    request = Request(
                        command = Command(
                            name = name,
                            input = input.encodeUtf8(),
                            invoke_key = key,
                        ),
                    ),
                ),
            ).shouldBeAnsweredWith { envelope ->
                val outcome = envelope.response?.command ?: error("a CommandOutcome")
                outcome.status shouldBe CommandStatus.COMMAND_STATUS_EXECUTED
                noteId = Regex("\"note_id\":\"([^\"]+)\"")
                    .find(outcome.output.utf8())
                    ?.groupValues
                    ?.get(1)
                    .orEmpty()
            }
            return noteId
        }
    }
}
