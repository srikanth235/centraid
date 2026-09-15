package dev.centraid.shared

import centraid.core.v1.ErrorCode
import centraid.core.v1.PageCursor
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.NoteDraft
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.ReadFailureKind
import dev.centraid.core.CoreFailure
import dev.centraid.shared.apps.notes.NotesEditorMachine
import dev.centraid.shared.apps.notes.NotesReads
import dev.centraid.shared.apps.photos.PhotosGridMachine
import dev.centraid.shared.apps.photos.PhotosReads
import dev.centraid.shared.apps.tally.TallyListMachine
import dev.centraid.shared.apps.tally.TallyReads
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.sync.ScreenReads
import dev.centraid.shared.sync.ScreenRuntime
import dev.centraid.shared.sync.fromCore
import dev.centraid.shared.sync.sentenceFor
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain

/**
 * THE THREE APP SCREENS' READS (#1025 S5, lane L5).
 *
 * Everything here runs on the JVM with no ABI, because everything here is the
 * part of a read that is DATA: the statement, the projection off a `Row`, and
 * the sentence a refusal becomes. What needs a real vault — that the door
 * answers this statement at all — is the device contract's job, and a test that
 * mocked a core to assert a mock's answer would prove only that the mock was
 * written to match.
 */
class AppReadsSpec : StringSpec({

    /**
     * Every screen's reads beside the machine that emits its effects.
     *
     * A list and not three copies of one test: the properties below are laws
     * for every app screen, and a fourth app that got its own hand-written test
     * would be a fourth chance to leave one out.
     */
    val screens: List<Triple<String, ScreenReads<*, *>, ScreenMachine<*, *>>> = listOf(
        Triple("tally", TallyReads, TallyListMachine),
        Triple("photos", PhotosReads, PhotosGridMachine),
        Triple("notes", NotesReads, NotesEditorMachine),
    )

    /** The statement each screen makes when it is holding a state that can read. */
    fun statementOf(name: String) = when (name) {
        "tally" -> TallyReads.query(TallyListMachine.initial(), null)
        "photos" -> PhotosReads.query(PhotosGridMachine.initial(), null)
        else -> NotesReads.query(
            NotesEditorMachine.initial().copy(note_id = "note-0001"),
            null,
        )
    }

    "every screen's select carries both order columns" {
        // THE DOOR HAS NO `key_of` CALLBACK, so the cursor is read off the row
        // by the two columns the ORDER BY names (`statement.ts:43-48`). A
        // statement that orders by a column it did not project produces a walk
        // that is not a walk: the second page starts from an empty key and
        // repeats the first.
        screens.forEach { (name, _, _) ->
            val query = statementOf(name).shouldNotBeNull()
            val order = query.order.shouldNotBeNull()
            withClue("$name selects ${query.select}") {
                query.select.contains(order.sort_column) shouldBe true
                query.select.contains(order.pk_column) shouldBe true
            }
        }
    }

    "every screen reads the table its machine says it re-reads on" {
        // THE PAIRING, ASSERTED MECHANICALLY. `rowsChanged` is what makes a
        // screen move when a row arrives from sync, and it is the machine's own
        // declaration of a table name; the query is where the rows actually
        // come from. When the two part company nothing fails — the screen
        // simply stops redrawing on sync, and the symptom is a list that is
        // right only after a relaunch. So the machine is asked, rather than the
        // table being re-listed here: a query that moves to another table
        // without updating `rowsChanged` makes this RED.
        screens.forEach { (name, reads, machine) ->
            val query = statementOf(name).shouldNotBeNull()
            withClue("$name reads ${query.from}") {
                query.from shouldBe reads.table
                // The machine answers an event for its own table and null for
                // any other, which is the only way to ask it what its table is
                // without it declaring it twice.
                machine.rowsChanged(reads.table, listOf("k"), 1uL).shouldNotBeNull()
                machine.rowsChanged(reads.table + "_other", listOf("k"), 1uL) shouldBe null
            }
        }
    }

    "the notes editor will not read until it knows which note" {
        // A STATEMENT WITH NO NOTE IS NOT A STATEMENT OVER EVERY NOTE. The
        // predicate binds the id, so a missing id could only have become an
        // unbound read of the whole table — which would open the editor on
        // whichever note sorted first.
        NotesReads.query(NotesEditorMachine.initial(), null) shouldBe null
        val query = NotesReads.query(
            NotesEditorMachine.initial().copy(note_id = "note-0001"),
            null,
        ).shouldNotBeNull()
        query.bind.map { it.text } shouldBe listOf("note-0001")
        query.where_.shouldNotBeNull() shouldNotContain "note-0001"
        // R-NOTES-1: the door appends `body_text` from `core_content_text`.
        query.with_note_body shouldBe true
    }

    "a tally row is projected off the columns it selected" {
        val row = Row(
            values = listOf(
                Value(text = "exp-1"),
                Value(text = "Dinner"),
                // AN INTEGER COLUMN ARRIVES ON THE INTEGER ARM. Read as text it
                // comes back empty, and every amount in the ledger would be nil.
                Value(integer = 4250L),
                Value(text = "JPY"),
                Value(text = "2026-02-03"),
            ),
        )
        val arrived = TallyReads.arrived(listOf(row), nextCursor = "c").data_.shouldNotBeNull()
        val data = arrived.data_.shouldNotBeNull()
        data.next_cursor shouldBe "c"
        val projected = data.rows.single()
        projected.expense_id shouldBe "exp-1"
        projected.description shouldBe "Dinner"
        projected.occurred_at shouldBe "2026-02-03"
        projected.amount.shouldNotBeNull().minor shouldBe 4250L
        projected.amount.shouldNotBeNull().currency shouldBe "JPY"
        // NAMES ARE ABSENT RATHER THAN INVENTED: they live on `tally_group` and
        // `core_party` and this read joins neither, so a renderer draws no name
        // instead of drawing an id as a person.
        projected.group_name shouldBe ""
        projected.payer_name shouldBe ""
        // THE NET BALANCE IS A FOLD AND NOT A COLUMN. A figure summed off one
        // page would be the balance of a screenful.
        data.net_balance shouldBe null
    }

    "an empty tally page is data with no rows, never a refusal" {
        // A FAILED READ IS NOT AN EMPTY LEDGER, and the converse is the law
        // this pins: an empty ledger is a real answer and reaches the screen as
        // data, so the machine clears its loading rather than drawing a
        // sentence about a vault that is simply new.
        val arrived = TallyReads.arrived(emptyList(), nextCursor = null)
        arrived.data_.shouldNotBeNull().data_.shouldNotBeNull().rows shouldBe emptyList()
        arrived.refused shouldBe null
    }

    "a photo cell is projected off the columns it selected" {
        val row = Row(
            values = listOf(
                Value(text = "asset-1"),
                Value(text = "2026-02-03T10:00:00Z"),
                Value(integer = -480L),
                Value(text = "video"),
                Value(text = "group-9"),
                // THE DOOR'S APPENDED COLUMN (D-1025-S7-20): the path of the
                // bytes this device holds for this row, resolved in the same
                // statement rather than by a second trip nobody made.
                Value(text = "/store/data/abc.data"),
                // AND THE TWO THE HELD STATE IS DERIVED FROM (#1025 S5,
                // D-1025-S7-62): the original's hash, so a tap can name a blob,
                // and `original_held` as its OWN column — the thumbnail path
                // falls back to the original's own bytes on a vault with no
                // derivative rows, so it cannot stand in for this.
                Value(text = "a0b1"),
                Value(integer = 0L),
            ),
        )
        val cell = PhotosReads.arrived(listOf(row), null)
            .data_.shouldNotBeNull().data_.shouldNotBeNull().cells.single()
        cell shouldBe PhotoCell(
            asset_id = "asset-1",
            captured_at = "2026-02-03T10:00:00Z",
            captured_utc_offset_minutes = -480,
            kind = PhotoCell.Kind.KIND_VIDEO,
            capture_group_id = "group-9",
            thumbnail_path = "/store/data/abc.data",
            original_hash = "a0b1",
            // A THUMBNAIL IS HERE AND THE DEFAULT RULE IS NOT WITHHOLDING THIS
            // ONE: the read's default link is unmetered, and `WIFI_ONLY` on an
            // unmetered link admits a video's original. So the cell is waiting
            // for the bytes rather than for the member — no download arrow.
            held = PhotoCell.Held.HELD_THUMBNAIL_ONLY,
        )
    }

    "a row with no held bytes carries no path, and that is an answer" {
        // ABSENT HAS MORE THAN ONE CAUSE — the bytes have not reached this
        // device, or they are a reading no surface may embed (the seat decides
        // that where the path is produced, so this side cannot be handed one).
        // Neither is an error and both draw the cell's own empty sentence.
        val row = Row(
            values = listOf(
                Value(text = "asset-2"),
                Value(text = "2026-02-03T10:00:00Z"),
                Value(integer = 0L),
                Value(text = "photo"),
                Value(text = ""),
            ),
        )
        val cell = PhotosReads.arrived(listOf(row), null)
            .data_.shouldNotBeNull().data_.shouldNotBeNull().cells.single()
        cell.thumbnail_path shouldBe null
    }

    "an unrecognised kind is unspecified, never a photograph" {
        // The DDL's CHECK admits four values today. A fifth arriving from a
        // newer gateway must not be drawn as a still image.
        val row = Row(values = listOf(Value(text = "a"), Value(text = ""), Value(integer = 0L)))
        val cell = PhotosReads.arrived(listOf(row), null)
            .data_.shouldNotBeNull().data_.shouldNotBeNull().cells.single()
        cell.kind shouldBe PhotoCell.Kind.KIND_UNSPECIFIED
        // An absent capture group is ABSENT, not the empty string: a Live
        // Photo's pairing is a real id or it is nothing.
        cell.capture_group_id shouldBe null
    }

    "a note draft whose core_content_text row arrived fills the body" {
        // R-NOTES-1: the editor reads the same text the replica holds. The
        // door appends `body_text` from `core_content_text` (not `seat_blob_held`)
        // after the named columns, the same way `thumbnail_path` rides a photos
        // page (#1025 live-notes).
        val row = Row(
            values = listOf(
                Value(text = "note-1"),
                Value(text = "Groceries"),
                Value(text = "markdown"),
                Value(integer = 1L),
                Value(text = "rev-7"),
                Value(text = "2026-02-03T10:00:00Z"),
                Value(text = "milk and eggs"),
            ),
        )
        val draft = NotesReads.arrived(listOf(row), null).data_.shouldNotBeNull().draft
        draft shouldBe NoteDraft(
            title = "Groceries",
            body = "milk and eggs",
            body_unavailable = false,
            format = NoteDraft.Format.FORMAT_MARKDOWN,
            pinned = true,
            base_revision_id = "rev-7",
        )
    }

    "a note draft without a core_content_text row is unavailable, not empty" {
        // NULL on the appended column is "not on this device". An empty string
        // would be a real body of zero characters, and collapsing the two would
        // let a save blank a note whose words simply have not landed yet.
        val row = Row(
            values = listOf(
                Value(text = "note-1"),
                Value(text = "Groceries"),
                Value(text = "markdown"),
                Value(integer = 1L),
                Value(text = "rev-7"),
                Value(text = "2026-02-03T10:00:00Z"),
                Value(null_ = centraid.core.v1.NullValue()),
            ),
        )
        val draft = NotesReads.arrived(listOf(row), null).data_.shouldNotBeNull().draft
        draft shouldBe NoteDraft(
            title = "Groceries",
            body = "",
            body_unavailable = true,
            format = NoteDraft.Format.FORMAT_MARKDOWN,
            pinned = true,
            base_revision_id = "rev-7",
        )
    }

    "a note that is not there is a sentence, not an empty editor" {
        // AN EMPTY PAGE IS NOT AN EMPTY NOTE. An empty list is a real answer;
        // an editor with no row is an editor over a note that was deleted,
        // purged or never reached this seat, and an empty title over an empty
        // body would invite a member to type into a document that does not
        // exist.
        val event = NotesReads.arrived(emptyList(), null)
        event.data_ shouldBe null
        val failure = event.refused.shouldNotBeNull().failure.shouldNotBeNull()
        failure.kind shouldBe ReadFailureKind.READ_FAILURE_KIND_REFUSED
        failure.sentence shouldNotContain "null"
    }

    "the cursor pair survives the one string a screen carries" {
        // `PageCursor` IS A PAIR and `next_cursor` is one string, so the two
        // halves are spelled with a separator. A cursor that did not round-trip
        // would be a second page that silently repeats the first.
        //
        // The separator is the FIXTURES': `ScreenFixtureSpec` asserts that
        // `tally/data-page`'s `next_cursor` contains a `|`, so that is the
        // product's written-down spelling and a second one here would make the
        // fixture a fixture of nothing.
        val cursor = PageCursor(sort_key = "2026-02-03", pk = "exp-1")
        ScreenRuntime.encodeCursor(cursor) shouldBe "2026-02-03|exp-1"
        ScreenRuntime.decodeCursor(ScreenRuntime.encodeCursor(cursor)) shouldBe cursor
        // THE FIRST PAGE IS `null`, not "start from zero" — for a pruned feed
        // those are different requests.
        ScreenRuntime.decodeCursor(null) shouldBe null
        // A STRING THIS RUNTIME DID NOT WRITE IS NOT A CURSOR. Dropped rather
        // than split at a guess, which starts the walk again instead of paging
        // under a mangled key.
        ScreenRuntime.decodeCursor("not-a-cursor") shouldBe null
    }

    "every refusal reaches a member as a sentence and never as a detail" {
        // ONE MAPPING, SHARED. This is the function `HomeRuntime` uses and the
        // one `ScreenRuntime` uses; a second copy would answer "what does a
        // member read when a read is refused" differently depending on which
        // screen they were on, and nothing would fail.
        ErrorCode.values().forEach { code ->
            withClue(code.name) { sentenceFor(code).sentence.isNotEmpty() shouldBe true }
        }
        sentenceFor(ErrorCode.ERROR_CODE_UNAUTHORIZED).kind shouldBe
            ReadFailureKind.READ_FAILURE_KIND_REFUSED
        // AN UNREACHABLE GATEWAY IS UNAVAILABLE AND NOT REFUSED: one is waited
        // out and the other is not, and the remedy differs.
        sentenceFor(ErrorCode.ERROR_CODE_PEER_UNREACHABLE).kind shouldBe
            ReadFailureKind.READ_FAILURE_KIND_UNAVAILABLE
        sentenceFor(ErrorCode.ERROR_CODE_TIMEOUT).kind shouldBe
            ReadFailureKind.READ_FAILURE_KIND_UNAVAILABLE
        sentenceFor(ErrorCode.ERROR_CODE_VERSION_WINDOW).remedy shouldBe "Update Centraid."
    }

    "a closed core is a restart, and it keeps the words the core wrote" {
        // EVERY `CoreFailure` ALREADY CARRIES A SENTENCE, written for a member
        // by the layer that refused. This maps the KIND and keeps the words;
        // re-writing them would be a second vocabulary for one refusal.
        val closed = CoreFailure.Closed
        val mapped = fromCore(closed)
        mapped.kind shouldBe ReadFailureKind.READ_FAILURE_KIND_CORE_RESTARTED
        mapped.sentence shouldBe closed.sentence
    }
})
