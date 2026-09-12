package dev.centraid.shared

import app.cash.turbine.test
import centraid.screen.v1.BackupState
import centraid.screen.v1.Loading
import centraid.screen.v1.MediaPermission
import centraid.screen.v1.NoteDraft
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotosGridData
import centraid.screen.v1.PhotosGridEvent
import centraid.screen.v1.PhotosGridState
import centraid.screen.v1.SeatState
import centraid.screen.v1.TallyListData
import centraid.screen.v1.TallyListState
import centraid.screen.v1.TallyListEvent
import centraid.screen.v1.TallyRow
import dev.centraid.shared.screen.NotesEditorMachine
import dev.centraid.shared.screen.PhotosGridMachine
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.TallyListMachine
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * The three screens, as state machines (#1020, D-1020-E3).
 *
 * Every test here is `(state, event) -> (state, effects)` and nothing else: no
 * dispatcher, no clock, no core. That is the whole reason the screens are pure
 * — it is what makes them provable on a machine with no device.
 */
class ScreenMachineSpec : StringSpec({

    // --- Tally ------------------------------------------------------------

    "tally: a refused read clears the rows and is NOT an empty ledger" {
        val loaded = TallyListMachine.reduce(
            TallyListMachine.initial(),
            TallyListEvent(data_ = TallyListEvent.DataArrived(TallyListData(rows = twoRows()))),
        ).state
        loaded.data_.shouldNotBeNull().rows.size shouldBe 2

        val refused = TallyListMachine.reduce(
            loaded,
            TallyListEvent(
                refused = TallyListEvent.ReadRefused(Reads.refused("This is not shared with you.")),
            ),
        )
        refused.state.data_.shouldBeNull()
        refused.state.failure.shouldNotBeNull().sentence shouldBe "This is not shared with you."
        // AND NO RE-READ. A retry is a wake, not a reducer's reflex; a reducer
        // that re-read on its own refusal is the 1 s loop the low-disk park
        // exists to stop.
        refused.effects.shouldBeEmpty()
    }

    "tally: an empty ledger is data with no rows, and the two are different states" {
        val empty = TallyListMachine.reduce(
            TallyListMachine.initial(),
            TallyListEvent(data_ = TallyListEvent.DataArrived(TallyListData())),
        ).state
        empty.data_.shouldNotBeNull().rows.shouldBeEmpty()
        empty.failure.shouldBeNull()

        val refused = TallyListMachine.reduce(
            TallyListMachine.initial(),
            TallyListEvent(refused = TallyListEvent.ReadRefused(Reads.refused("no"))),
        ).state
        (empty == refused).shouldBeFalse()
    }

    "tally: a refresh over rows does not replace them with a spinner" {
        val loaded = TallyListMachine.reduce(
            TallyListMachine.initial(),
            TallyListEvent(data_ = TallyListEvent.DataArrived(TallyListData(rows = twoRows()))),
        ).state
        val refreshed = TallyListMachine.reduce(
            loaded,
            TallyListEvent(refreshed = TallyListEvent.Refreshed()),
        )
        refreshed.state.data_.shouldNotBeNull().rows.size shouldBe 2
        refreshed.state.loading.shouldBeNull()
        refreshed.effects shouldBe listOf(
            ScreenEffect.ReadPage(TallyListMachine.SCREEN_ID, afterCursor = null),
        )
    }

    "tally: a refresh with nothing to refresh over IS a first load" {
        val refreshed = TallyListMachine.reduce(
            TallyListMachine.initial(),
            TallyListEvent(refreshed = TallyListEvent.Refreshed()),
        )
        refreshed.state.loading shouldBe Loading(first_load = true)
    }

    "tally: a band destination changes a parameter, not the machine" {
        val moved = TallyListMachine.reduce(
            TallyListMachine.initial(),
            TallyListEvent(
                destination = TallyListEvent.DestinationChanged(
                    TallyListState.Destination.DESTINATION_BALANCES,
                ),
            ),
        )
        moved.state.destination shouldBe TallyListState.Destination.DESTINATION_BALANCES
        moved.effects.size shouldBe 1
    }

    "tally: a later page appends and never duplicates; a first page replaces" {
        var state = TallyListMachine.reduce(
            TallyListMachine.initial(),
            TallyListEvent(
                data_ = TallyListEvent.DataArrived(
                    TallyListData(rows = twoRows(), next_cursor = "c1"),
                ),
            ),
        ).state
        // The second page repeats one row, as a page boundary can.
        state = TallyListMachine.reduce(
            state,
            TallyListEvent(
                data_ = TallyListEvent.DataArrived(
                    TallyListData(rows = listOf(twoRows()[1], row("exp-0003"))),
                ),
            ),
        ).state
        state.data_.shouldNotBeNull().rows.map { it.expense_id } shouldBe
            listOf("exp-0001", "exp-0002", "exp-0003")

        // A first load clears, so the next page REPLACES rather than appending.
        val reloaded = TallyListMachine.reduce(
            state,
            TallyListEvent(opened = TallyListEvent.Opened()),
        ).state
        reloaded.data_.shouldBeNull()
    }

    "tally: a change event for rows this screen is not showing costs nothing" {
        val loaded = TallyListMachine.reduce(
            TallyListMachine.initial(),
            TallyListEvent(data_ = TallyListEvent.DataArrived(TallyListData(rows = twoRows()))),
        ).state
        TallyListMachine.reduce(
            loaded,
            TallyListEvent(rows_changed = TallyListEvent.RowsChanged(listOf("exp-9999"))),
        ).effects.shouldBeEmpty()
        TallyListMachine.reduce(
            loaded,
            TallyListEvent(rows_changed = TallyListEvent.RowsChanged(listOf("exp-0002"))),
        ).effects.size shouldBe 1
    }

    "tally: offline WITHHOLDS the recurring verb rather than queueing it" {
        val offline = TallyListMachine.reduce(
            TallyListMachine.initial(),
            TallyListEvent(
                seat_changed = TallyListEvent.SeatChanged(
                    SeatState(durability = SeatState.Durability.DURABILITY_LOCAL_ONLY),
                ),
            ),
        ).state
        offline.recurring_materialisation_withheld.shouldBeTrue()

        val online = TallyListMachine.reduce(
            offline,
            TallyListEvent(
                seat_changed = TallyListEvent.SeatChanged(
                    SeatState(durability = SeatState.Durability.DURABILITY_AUTHORITATIVE),
                ),
            ),
        ).state
        online.recurring_materialisation_withheld.shouldBeFalse()

        // And the ask, when it comes, is an answer and not an enqueue.
        val withheld = TallyListMachine.withhold()
        (withheld is ScreenEffect.WithheldOffline).shouldBeTrue()
        (withheld as ScreenEffect.WithheldOffline).verb shouldBe
            TallyListMachine.WITHHELD_VERB
    }

    // --- Photos -----------------------------------------------------------

    "photos: a denied media permission does not blank the grid" {
        val loaded = PhotosGridMachine.reduce(
            PhotosGridMachine.initial(),
            PhotosGridEvent(
                data_ = PhotosGridEvent.DataArrived(
                    PhotosGridData(cells = listOf(PhotoCell(asset_id = "ast-1"))),
                ),
            ),
        ).state
        val denied = PhotosGridMachine.reduce(
            loaded,
            PhotosGridEvent(
                permission = PhotosGridEvent.PermissionChanged(
                    MediaPermission.MEDIA_PERMISSION_DENIED,
                ),
            ),
        ).state
        denied.data_.shouldNotBeNull().cells.size shouldBe 1
        denied.failure.shouldBeNull()
        denied.backup.shouldNotBeNull().paused_reason.contains("Settings").shouldBeTrue()
    }

    "photos: limited access can still enumerate; denied and restricted cannot" {
        PhotosGridMachine.canEnumerate(MediaPermission.MEDIA_PERMISSION_LIMITED).shouldBeTrue()
        PhotosGridMachine.canEnumerate(MediaPermission.MEDIA_PERMISSION_GRANTED).shouldBeTrue()
        PhotosGridMachine.canEnumerate(MediaPermission.MEDIA_PERMISSION_DENIED).shouldBeFalse()
        PhotosGridMachine.canEnumerate(MediaPermission.MEDIA_PERMISSION_RESTRICTED).shouldBeFalse()
        PhotosGridMachine.canEnumerate(MediaPermission.MEDIA_PERMISSION_NOT_ASKED).shouldBeFalse()
    }

    "photos: low disk parks the grid AND the backup, and asks for no retry" {
        val parked = PhotosGridMachine.reduce(
            PhotosGridMachine.initial(),
            PhotosGridEvent(refused = PhotosGridEvent.ReadRefused(Reads.lowDiskParked())),
        )
        parked.state.backup.shouldNotBeNull().phase shouldBe
            BackupState.Phase.PHASE_PARKED_LOW_DISK
        parked.state.failure.shouldNotBeNull()
        parked.effects.shouldBeEmpty()
    }

    "photos: opening the more sheet cannot change the band" {
        val opened = PhotosGridMachine.reduce(
            PhotosGridMachine.initial(),
            PhotosGridEvent(sheet = PhotosGridEvent.SheetChanged(PhotosGridState.Sheet.SHEET_MORE)),
        ).state
        opened.sheet shouldBe PhotosGridState.Sheet.SHEET_MORE
        opened.destination shouldBe PhotosGridState.Destination.DESTINATION_LIBRARY
    }

    "photos: asking for permission is one effect, and an answer does not ask again" {
        PhotosGridMachine.reduce(
            PhotosGridMachine.initial(),
            PhotosGridEvent(permission_requested = PhotosGridEvent.PermissionRequested()),
        ).effects shouldBe listOf(ScreenEffect.RequestMediaPermission)

        PhotosGridMachine.reduce(
            PhotosGridMachine.initial(),
            PhotosGridEvent(
                permission = PhotosGridEvent.PermissionChanged(
                    MediaPermission.MEDIA_PERMISSION_DENIED,
                ),
            ),
        ).effects.shouldBeEmpty()
    }

    // --- Notes ------------------------------------------------------------

    "notes: an edit marks the draft dirty and writes nothing" {
        val step = NotesEditorMachine.reduce(loadedNote(), NotesEditorEvent(
            body = NotesEditorEvent.BodyEdited("Book the cabin."),
        ))
        step.state.save shouldBe NotesEditorState.SaveState.SAVE_STATE_DIRTY
        step.effects.shouldBeEmpty()
    }

    "notes: a save submits once, with the base revision as its invoke key" {
        val dirty = NotesEditorMachine.reduce(
            loadedNote(),
            NotesEditorEvent(body = NotesEditorEvent.BodyEdited("Book the cabin.")),
        ).state
        val saving = NotesEditorMachine.reduce(
            dirty,
            NotesEditorEvent(save = NotesEditorEvent.SaveRequested()),
        )
        saving.state.save shouldBe NotesEditorState.SaveState.SAVE_STATE_SAVING
        val write = saving.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe NotesEditorMachine.SAVE_COMMAND
        write.invokeKey shouldBe "notes.save:note-0001:rev-0007"
        write.onlineOnly.shouldBeFalse()
        write.inputJson.contains("\"base_revision_id\":\"rev-0007\"").shouldBeTrue()

        // A SECOND SAVE WHILE ONE IS IN FLIGHT IS NOT A SECOND COMMAND. Two
        // `invoke_key`s for one edit is two revisions of one note.
        NotesEditorMachine.reduce(
            saving.state,
            NotesEditorEvent(save = NotesEditorEvent.SaveRequested()),
        ).effects.shouldBeEmpty()
    }

    "notes: a refused SAVE keeps the words; a refused READ does not" {
        val dirty = NotesEditorMachine.reduce(
            loadedNote(),
            NotesEditorEvent(body = NotesEditorEvent.BodyEdited("Book the cabin.")),
        ).state
        val refusedSave = NotesEditorMachine.reduce(
            dirty,
            NotesEditorEvent(
                save_settled = NotesEditorEvent.SaveSettled(
                    outcome = NotesEditorState.SaveState.SAVE_STATE_REFUSED,
                    failure = Reads.unavailable("Centraid could not reach your gateway."),
                ),
            ),
        ).state
        refusedSave.draft.shouldNotBeNull().body shouldBe "Book the cabin."
        refusedSave.failure.shouldBeNull()
        refusedSave.draft!!.save_failure.shouldNotBeNull()

        val refusedRead = NotesEditorMachine.reduce(
            dirty,
            NotesEditorEvent(refused = NotesEditorEvent.ReadRefused(Reads.refused("no"))),
        ).state
        refusedRead.draft.shouldBeNull()
        refusedRead.failure.shouldNotBeNull()
    }

    "notes: the save input escapes what JSON has to escape" {
        val quoted = NotesEditorMachine.jsonString("a \"quote\"\nand a \\ and a \u0001")
        quoted shouldBe "\"a \\\"quote\\\"\\nand a \\\\ and a \\u0001\""
    }

    // --- The host ---------------------------------------------------------

    "the host publishes a finished state before it emits the effect that asked for it" {
        val host = ScreenHost(TallyListMachine)
        host.effects.test {
            host.send(TallyListEvent(opened = TallyListEvent.Opened()))
            // The state is already the loading state by the time the effect
            // arrives, so an answer delivered synchronously cannot beat it.
            host.state.value.loading.shouldNotBeNull().first_load.shouldBeTrue()
            awaitItem() shouldBe ScreenEffect.ReadPage(TallyListMachine.SCREEN_ID, null)
        }
        host.revision shouldBe 1uL
    }

    "the host's revision is monotonic per instance" {
        val host = ScreenHost(NotesEditorMachine)
        host.send(NotesEditorEvent(opened = NotesEditorEvent.Opened("note-1")))
        host.send(NotesEditorEvent(pin = NotesEditorEvent.PinToggled()))
        host.revision shouldBe 2uL
    }
}) {
    companion object {
        fun row(id: String): TallyRow = TallyRow(expense_id = id, description = id)

        fun twoRows(): List<TallyRow> = listOf(row("exp-0001"), row("exp-0002"))

        fun loadedNote(): NotesEditorState = NotesEditorMachine.reduce(
            NotesEditorMachine.reduce(
                NotesEditorMachine.initial(),
                NotesEditorEvent(opened = NotesEditorEvent.Opened("note-0001")),
            ).state,
            NotesEditorEvent(
                data_ = NotesEditorEvent.DataArrived(
                    NoteDraft(
                        title = "Winter plans",
                        body = "",
                        format = NoteDraft.Format.FORMAT_MARKDOWN,
                        base_revision_id = "rev-0007",
                    ),
                ),
            ),
        ).state
    }
}
