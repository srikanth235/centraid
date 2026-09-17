package dev.centraid.shared

import centraid.core.v1.ChangeEvent
import centraid.core.v1.Event
import centraid.core.v1.HealthEvent
import centraid.core.v1.RecordKey
import centraid.core.v1.Value
import centraid.screen.v1.NoteDraft
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotosGridData
import centraid.screen.v1.PhotosGridEvent
import centraid.screen.v1.TallyListData
import centraid.screen.v1.TallyListEvent
import centraid.screen.v1.TallyRow
import dev.centraid.shared.apps.notes.NotesEditorMachine
import dev.centraid.shared.apps.photos.PhotosGridMachine
import dev.centraid.shared.apps.tally.TallyListMachine
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeMachine
import dev.centraid.shared.shell.HomeReads
import dev.centraid.shared.sync.ChangeStream
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * A ROW THAT ARRIVES FROM SYNC MOVES THE SCREEN (#1025 S5, D-1025-S5-3).
 *
 * The property the whole change-stream path exists for, asserted without an
 * ABI: [ChangeStream.deliver] is the behaviour and [ChangeStream.start] is four
 * lines of plumbing over it, so the fake core here is a
 * `centraid.core.v1.Event` — which is exactly what a real one hands over.
 *
 * What makes these worth having is that every PIECE of this path already
 * existed and passed its own tests while the path as a whole did nothing at
 * all: `TallyListEvent.RowsChanged` has been reduced correctly since #1020 with
 * no producer anywhere, and `crates/core`'s event queue has nine tests and,
 * until this umbrella, nothing that ever pushed into it. A test of a reducer or
 * of a queue cannot see that; only a test that joins them can.
 */
class ChangeStreamSpec : StringSpec({

    // THE COMMIT-SEQ FIELD IS NOT SET HERE, AND NOT READ (#1029 §1). This
    // fake set it to 7 because the stream passed the number to every machine
    // and no machine ever used it — it was the position a SEAT's overlay
    // settled against, and the overlay left with the log plane. The field is
    // still on the wire, because `crates/api-proto` is another lane's, and no
    // line of this shell reads it.
    fun change(table: String, vararg keys: String): Event = Event(
        change = ChangeEvent(
            table = table,
            pk_set = keys.map { RecordKey(values = listOf(Value(text = it))) },
        ),
    )

    /** Collect a host's effects from now on. Unconfined, so it is live at once. */
    fun watch(host: ScreenHost<*, *>, into: MutableList<ScreenEffect>): Job =
        CoroutineScope(Dispatchers.Unconfined).launch {
            host.effects.collect { into += it }
        }

    suspend fun tallyShowing(vararg ids: String): ScreenHost<*, TallyListEvent> {
        val host = ScreenHost(TallyListMachine)
        host.send(
            TallyListEvent(
                data_ = TallyListEvent.DataArrived(
                    data_ = TallyListData(rows = ids.map { TallyRow(expense_id = it) }),
                ),
            ),
        )
        return host
    }

    suspend fun photosShowing(vararg ids: String): ScreenHost<*, PhotosGridEvent> {
        val host = ScreenHost(PhotosGridMachine)
        host.send(
            PhotosGridEvent(
                data_ = PhotosGridEvent.DataArrived(
                    data_ = PhotosGridData(cells = ids.map { PhotoCell(asset_id = it) }),
                ),
            ),
        )
        return host
    }

    "a row a list is showing moves it, with no relaunch and no gesture" {
        val host = tallyShowing("exp-1")
        val effects = mutableListOf<ScreenEffect>()
        val watcher = watch(host, effects)

        val stream = ChangeStream()
        stream.route(host)
        stream.deliver(change("tally_expense", "exp-1"))

        // THE SCREEN ASKED FOR ITS PAGE AGAIN. Not "the state changed" — the
        // state cannot change until rows are read, and the re-read IS the
        // deliverable: without it a member sees a gateway's write on the next
        // relaunch.
        effects shouldBe listOf(ScreenEffect.ReadPage(TallyListMachine.SCREEN_ID, null))
        watcher.cancel()
    }

    "a row the list is not showing moves nothing" {
        val host = tallyShowing("exp-1")
        val effects = mutableListOf<ScreenEffect>()
        val watcher = watch(host, effects)

        val stream = ChangeStream()
        stream.route(host)
        stream.deliver(change("tally_expense", "exp-99"))

        // A TAILING PASS APPLIES THOUSANDS OF ROWS. If every one of them made
        // every open screen re-read its page, catching up would cost a page
        // read per row, which is what makes a first sync unusable.
        effects shouldBe emptyList()
        watcher.cancel()
    }

    "a table a screen does not read is not that screen's event" {
        // The routing decision is the MACHINE's, so it is asserted on the
        // machine: a stream holding its own table map would be a second place
        // every screen's reads are written down.
        TallyListMachine.rowsChanged("media_asset", listOf("ast-1")).shouldBeNull()
        PhotosGridMachine.rowsChanged("tally_expense", listOf("exp-1")).shouldBeNull()
        NotesEditorMachine.rowsChanged("media_asset", listOf("ast-1")).shouldBeNull()
        HomeMachine.rowsChanged("locker_item", listOf("lck-1")).shouldBeNull()
    }

    "every table Home counts is a table Home redraws on" {
        // Derived rather than listed, and this is what says so: a tile whose
        // query moved to another table would otherwise stop redrawing on sync
        // with nothing failing anywhere.
        HomeReads.READS.forEach { read ->
            HomeMachine.rowsChanged(read.query.from, listOf("x")).shouldNotBeNull()
        }
        HomeReads.TABLES shouldBe HomeReads.READS.map { it.query.from }.toSet()
    }

    "a change from the gateway never takes a member's typing" {
        val host = ScreenHost(NotesEditorMachine)
        host.send(NotesEditorEvent(opened = NotesEditorEvent.Opened(note_id = "note-1")))
        val arrived = NotesEditorEvent(
            data_ = NotesEditorEvent.DataArrived(
                draft = NoteDraft(title = "t", body = "b"),
            ),
        )
        host.send(arrived)
        host.send(NotesEditorEvent(body = NotesEditorEvent.BodyEdited(body = "half a paragraph")))
        (host.state.value.save != NotesEditorState.SaveState.SAVE_STATE_CLEAN).shouldBeTrue()

        val effects = mutableListOf<ScreenEffect>()
        val watcher = watch(host, effects)
        val stream = ChangeStream()
        stream.route(host)
        stream.deliver(change("knowledge_note", "note-1"))

        // NO RE-READ, and the typing is still there. This is the one outcome no
        // member forgives, and the decision is in the REDUCER because only it
        // knows there is an unsaved draft.
        effects shouldBe emptyList()
        host.state.value.draft?.body shouldBe "half a paragraph"

        // And the same event on a CLEAN editor DOES re-read: the rule is about
        // an unsaved draft, not about ignoring the gateway.
        host.send(arrived)
        stream.deliver(change("knowledge_note", "note-1"))
        effects shouldBe listOf(ScreenEffect.ReadPage(NotesEditorMachine.SCREEN_ID, null))
        watcher.cancel()
    }

    "a grid re-reads its first page rather than patching a cell" {
        val host = photosShowing("ast-1")
        val effects = mutableListOf<ScreenEffect>()
        val watcher = watch(host, effects)
        val stream = ChangeStream()
        stream.route(host)
        stream.deliver(change("media_asset", "ast-1"))
        // The FIRST page, with a null cursor: a grid ordered by capture time
        // cannot patch a cell whose position in that order may have moved.
        effects shouldBe listOf(ScreenEffect.ReadPage(PhotosGridMachine.SCREEN_ID, null))
        watcher.cancel()
    }

    "one change reaches every screen that cares and no others" {
        val tally = tallyShowing("exp-1")
        val photos = photosShowing("ast-1")
        val seen = mutableListOf<String>()
        val scope = CoroutineScope(Dispatchers.Unconfined)
        val a = scope.launch { tally.effects.collect { seen += "tally" } }
        val b = scope.launch { photos.effects.collect { seen += "photos" } }

        val stream = ChangeStream()
        stream.route(tally)
        stream.route(photos)
        stream.deliver(change("media_asset", "ast-1"))

        seen shouldBe listOf("photos")
        a.cancel()
        b.cancel()
    }

    "a stall is a state the shell can render" {
        val stream = ChangeStream()
        stream.health.value.stalled.shouldBeFalse()
        stream.deliver(
            Event(
                health = HealthEvent(
                    queue_depth = 1024,
                    capacity = 1024,
                    stalled = true,
                    behind = 4_000L,
                ),
            ),
        )
        // `behind` IS A DISTANCE IN LOG POSITIONS, never rows and never
        // seconds: the shell renders "catching up" and never a time remaining.
        stream.health.value shouldBe ChangeStream.Health(
            queueDepth = 1024,
            capacity = 1024,
            stalled = true,
            behind = 4_000uL,
        )
    }
})
