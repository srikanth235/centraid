package dev.centraid.shared

import centraid.core.v1.CommandStatus
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.Loading
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotoPickerEvent
import centraid.screen.v1.PhotoPickerState
import centraid.screen.v1.PhotosGridData
import dev.centraid.shared.apps.photos.PhotoPickerMachine
import dev.centraid.shared.apps.photos.PhotoPickerReads
import dev.centraid.shared.apps.photos.PhotoShelfMachine
import dev.centraid.shared.apps.photos.PhotosGridMachine
import dev.centraid.shared.apps.photos.PhotosReads
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import java.io.File

/**
 * THE PICKER (#1029, photos port; v0's `PhotoPicker.tsx`).
 *
 * The screen whose whole reason to exist is that its picked set is its OWN.
 * So the laws under test are the ones that would be broken by making it a
 * shelf with `selecting = true`: the album is a parameter, what the album
 * already holds cannot be picked, and the picks survive a refused confirm.
 */
class PhotoPickerSpec : StringSpec({

    fun opened(
        vararg already: String,
    ) = PhotoPickerMachine.reduce(
        PhotoPickerMachine.initial(),
        PhotoPickerEvent(
            opened = PhotoPickerEvent.Opened(
                collection_id = "album-1",
                collection_name = "Portugal",
                already_in_album_asset_ids = already.toList(),
            ),
        ),
    )

    fun loaded(vararg assetIds: String): PhotoPickerState = PhotoPickerMachine.reduce(
        opened("taken-1").state,
        PhotoPickerEvent(
            data_ = PhotoPickerEvent.DataArrived(
                data_ = PhotosGridData(cells = assetIds.map { PhotoCell(asset_id = it) }),
            ),
        ),
    ).state

    fun picked(state: PhotoPickerState, vararg assetIds: String): PhotoPickerState =
        assetIds.fold(state) { carried, assetId ->
            PhotoPickerMachine.reduce(
                carried,
                PhotoPickerEvent(pick = PhotoPickerEvent.PickToggled(asset_id = assetId)),
            ).state
        }

    "the first Opened names the album and asks for a page" {
        // THE NAME RIDES ALONG, so the head says "Add to Portugal" before any
        // read has landed and never paints under the previous screen's title.
        val step = opened("taken-1")
        step.state.collection_id shouldBe "album-1"
        step.state.collection_name shouldBe "Portugal"
        step.state.already_in_album_asset_ids shouldBe listOf("taken-1")
        step.state.loading shouldBe Loading(first_load = true)
        // AND THE ALBUM'S OWN MEMBERSHIP, beside the page: no caller holds
        // more than one page of it, so the picker reads it itself.
        step.effects shouldBe listOf(
            ScreenEffect.ReadPage(PhotoPickerMachine.SCREEN_ID, afterCursor = null),
            ScreenEffect.ReadPage(PhotoPickerMachine.MEMBERS_READ_ID, afterCursor = null),
        )
    }

    "the membership read UNIONS into what is taken, and drops picks it covers" {
        val picked = PhotoPickerMachine.reduce(
            opened("taken-1").state,
            PhotoPickerEvent(pick = PhotoPickerEvent.PickToggled(asset_id = "a-2")),
        ).state
        val step = PhotoPickerMachine.reduce(
            picked,
            PhotoPickerEvent(
                members = PhotoPickerEvent.MembersArrived(collection_id = "album-1", asset_ids = listOf("a-2", "a-3")),
            ),
        )
        step.state.already_in_album_asset_ids shouldBe listOf("taken-1", "a-2", "a-3")
        step.state.picked_asset_ids.shouldBeEmpty()
        // A list for another album is a reopened picker under a slow read.
        PhotoPickerMachine.reduce(
            picked,
            PhotoPickerEvent(
                members = PhotoPickerEvent.MembersArrived(collection_id = "album-9", asset_ids = listOf("a-2")),
            ),
        ).state shouldBe picked
    }

    "a refusal lands as a failure, not as an empty library, and emits no re-read" {
        // ON THIS SCREEN THE DIFFERENCE DECIDES WHAT A MEMBER DOES NEXT: an
        // empty library means there is nothing left to add, and a refused read
        // means they must not conclude that.
        val refused = PhotoPickerMachine.reduce(
            loaded("a1"),
            PhotoPickerEvent(
                refused = PhotoPickerEvent.ReadRefused(Reads.refused("No vault is open.")),
            ),
        )
        refused.state.data_.shouldBeNull()
        refused.state.failure.shouldNotBeNull().sentence shouldBe "No vault is open."
        refused.effects.shouldBeEmpty()
    }

    "a parked feed emits no re-read" {
        val parked = PhotoPickerMachine.reduce(
            loaded("a1"),
            PhotoPickerEvent(refused = PhotoPickerEvent.ReadRefused(Reads.lowDiskParked())),
        )
        Reads.isParked(parked.state.failure) shouldBe true
        parked.effects.shouldBeEmpty()
    }

    "an empty library is data with no cells and is not a refusal" {
        val empty = PhotoPickerMachine.reduce(
            opened().state,
            PhotoPickerEvent(data_ = PhotoPickerEvent.DataArrived(data_ = PhotosGridData())),
        ).state
        empty.data_.shouldNotBeNull().cells.shouldBeEmpty()
        empty.failure.shouldBeNull()
    }

    "rowsChanged on a foreign table answers null" {
        PhotoPickerMachine.rowsChanged("core_collection_entry", listOf("e1")) shouldBe null
        PhotoPickerMachine.rowsChanged("knowledge_note", listOf("n1")) shouldBe null
        PhotoPickerMachine.rowsChanged("media_asset", listOf("a1")).shouldNotBeNull()
    }

    "a change over assets this picker is not showing moves nothing" {
        val state = loaded("a1")
        val elsewhere = PhotoPickerMachine.reduce(
            state,
            PhotoPickerEvent(rows_changed = PhotoPickerEvent.RowsChanged(asset_ids = listOf("z9"))),
        )
        elsewhere.effects.shouldBeEmpty()
        elsewhere.state shouldBe state
    }

    "what the album already holds cannot be picked" {
        // THE RULE IS THE MACHINE'S AND NOT THE DRAWING'S. A member who could
        // pick a taken cell would send `media.add_to_album` for a row the album
        // has, and the command's own precondition would refuse it — which the
        // member reads as a failure rather than as a no-op.
        val state = picked(loaded("a1", "taken-1"), "taken-1")
        state.picked_asset_ids.shouldBeEmpty()
    }

    "a pick is a toggle" {
        val once = picked(loaded("a1", "a2"), "a1", "a2")
        once.picked_asset_ids shouldBe listOf("a1", "a2")
        val twice = picked(once, "a1")
        twice.picked_asset_ids shouldBe listOf("a2")
    }

    "confirm is one add_to_album per picked asset, with no position" {
        val state = picked(loaded("a1", "a2"), "a1", "a2")
        val step = PhotoPickerMachine.reduce(
            state,
            PhotoPickerEvent(confirm = PhotoPickerEvent.ConfirmRequested()),
        )
        step.effects.size shouldBe 2
        step.effects.forEach { effect ->
            val write = effect as ScreenEffect.SubmitWrite
            write.command shouldBe "media.add_to_album"
            write.inputJson shouldContain "\"album_id\":\"album-1\""
            // v0 SENT A `position` AND THE VAULT WOULD REFUSE IT.
            // `media.add_to_album`'s schema is `additionalProperties: false`
            // over `album_id` and `asset_id`, so the whole add would fail on a
            // field that was only ever there to preserve an ordering the vault
            // assigns itself.
            write.inputJson shouldNotContain "position"
            // THE KEY IS THE PAIR, because the intent is the pair.
            write.invokeKey shouldContain "album-1"
        }
        (step.effects[0] as ScreenEffect.SubmitWrite).invokeKey shouldNotContain
            (step.effects[1] as ScreenEffect.SubmitWrite).invokeKey.substringAfterLast(':')
    }

    "a confirm with nothing picked writes nothing" {
        PhotoPickerMachine.reduce(
            loaded("a1"),
            PhotoPickerEvent(confirm = PhotoPickerEvent.ConfirmRequested()),
        ).effects.shouldBeEmpty()
    }

    "the picks survive a confirm that was refused" {
        // Clearing them optimistically would mean re-choosing thirty
        // photographs to find out which of them the album already had.
        val state = picked(loaded("a1"), "a1")
        val settled = PhotoPickerMachine.reduce(
            state,
            PhotoPickerEvent(
                write_settled = PhotoPickerEvent.WriteSettled(
                    committed = false,
                    sentence = "that photograph is already in this album",
                    asset_id = "a1",
                ),
            ),
        )
        settled.state.picked_asset_ids shouldBe listOf("a1")
        settled.state.already_in_album_asset_ids shouldBe listOf("taken-1")
        // AND THE GRID IS NOT REPLACED. A failed write is not a failed read:
        // `failure` is the READ's slot, and a denied add drawn through it would
        // take the library off the screen the member was picking from.
        settled.state.data_ shouldBe state.data_
        settled.state.failure.shouldBeNull()
        // THE SENTENCE LANDS, in its own field. Without it the refusal is
        // silent — the event carries words and, for one draft, there was
        // nowhere to put them.
        settled.state.write_failure.shouldNotBeNull().sentence shouldBe
            "that photograph is already in this album"
        settled.effects.shouldBeEmpty()
    }

    "a refusal with no sentence still says something a member can read" {
        val settled = PhotoPickerMachine.reduce(
            picked(loaded("a1"), "a1"),
            PhotoPickerEvent(
                write_settled = PhotoPickerEvent.WriteSettled(committed = false, sentence = ""),
            ),
        ).state
        settled.write_failure.shouldNotBeNull().sentence shouldBe
            PhotoShelfMachine.WRITE_REFUSED_SENTENCE
    }

    "a commit clears the last refusal, and so does a fresh confirm" {
        val refused = PhotoPickerMachine.reduce(
            picked(loaded("a1"), "a1"),
            PhotoPickerEvent(
                write_settled = PhotoPickerEvent.WriteSettled(committed = false, sentence = "no"),
            ),
        ).state
        refused.write_failure.shouldNotBeNull()

        PhotoPickerMachine.reduce(
            refused,
            PhotoPickerEvent(
                write_settled = PhotoPickerEvent.WriteSettled(committed = true, sentence = ""),
            ),
        ).state.write_failure.shouldBeNull()

        val retried = PhotoPickerMachine.reduce(
            refused,
            PhotoPickerEvent(confirm = PhotoPickerEvent.ConfirmRequested()),
        )
        retried.state.write_failure.shouldBeNull()
        retried.effects.size shouldBe 1

        PhotoPickerMachine.reduce(
            refused,
            PhotoPickerEvent(
                opened = PhotoPickerEvent.Opened(
                    collection_id = "album-2",
                    collection_name = "Spain",
                ),
            ),
        ).state.write_failure.shouldBeNull()
    }

    "a committed add moves ONE pick to taken, because no read could say it" {
        // The membership is `core_collection_entry` and this screen's read is
        // over `media_asset`, so there is nothing a re-read could fetch that
        // would draw the cell as taken. The machine knows, so the machine says.
        //
        // AND IT SAYS IT ABOUT ONE ROW. A confirm submits one
        // `media.add_to_album` per pick, and a screen that moved the WHOLE
        // picked set on the first commit would tell a member their photographs
        // are in an album when some of the adds were refused.
        var state = picked(loaded("a1", "a2"), "a1", "a2")
        state = PhotoPickerMachine.reduce(
            state,
            PhotoPickerEvent(confirm = PhotoPickerEvent.ConfirmRequested()),
        ).state
        state = PhotoPickerMachine.reduce(
            state,
            PhotoPickerEvent(
                write_settled = PhotoPickerEvent.WriteSettled(
                    committed = true,
                    asset_id = "a1",
                ),
            ),
        ).state
        state.picked_asset_ids shouldBe listOf("a2")
        state.already_in_album_asset_ids shouldBe listOf("taken-1", "a1")

        // THE ONE THE VAULT REFUSED STAYS PICKED and does NOT become taken.
        val refused = PhotoPickerMachine.reduce(
            state,
            PhotoPickerEvent(
                write_settled = PhotoPickerEvent.WriteSettled(
                    committed = false,
                    sentence = "that photograph is already in this album",
                    asset_id = "a2",
                ),
            ),
        ).state
        refused.picked_asset_ids shouldBe listOf("a2")
        refused.already_in_album_asset_ids shouldBe listOf("taken-1", "a1")
    }

    "a settle with no id is about the BATCH, and moves nothing" {
        // A screen that cannot tell which pick landed must not act as though it
        // can. `PhotoPickerReads.settled` emits an empty id today because
        // `ScreenWrites.settled` is not handed the write it is answering; the
        // reducer's job is to be right either way.
        val state = picked(loaded("a1"), "a1")
        val settled = PhotoPickerMachine.reduce(
            state,
            PhotoPickerEvent(
                write_settled = PhotoPickerEvent.WriteSettled(committed = true, asset_id = ""),
            ),
        ).state
        settled.picked_asset_ids shouldBe listOf("a1")
        settled.already_in_album_asset_ids shouldBe listOf("taken-1")
    }

    // --- The statement ----------------------------------------------------

    "the picker's select is PhotosReads' cell five, exactly" {
        // The door appends its computed columns after the named ones and
        // `PhotosReads` reads the cell's five by position; `PhotoPickerReads`
        // delegates its projection. The grid alone names `width`, `height` and
        // `duration_s` after the five — a justified timeline packs from them,
        // and a picker's square mosaic does not — so the picker shares the
        // five and nothing more.
        val picker = PhotoPickerReads.query(PhotoPickerMachine.initial(), null)
        val grid = PhotosReads.query(PhotosGridMachine.initial(), null)
        picker.select shouldBe grid.select.take(5)
        picker.with_held_thumbnail shouldBe grid.with_held_thumbnail
        picker.from shouldBe PhotoPickerReads.table
    }

    "the picker offers the LIVE library and orders it the library's way" {
        // A TRASHED PHOTOGRAPH IS NOT OFFERED (v0's own filter): adding would
        // put a deleted reference into a curated album, and the next trash
        // sweep would take the entry away again. An archived one is not
        // offered because the member put it away.
        val query = PhotoPickerReads.query(PhotoPickerMachine.initial(), null)
        query.where_ shouldBe "deleted_at IS NULL AND archived_at IS NULL"
        val order = query.order.shouldNotBeNull()
        order.sort_column shouldBe "captured_at"
        order.pk_column shouldBe "asset_id"
        order.descending shouldBe true
        // THE CURSOR IS READ OFF THE ROW by the two columns the ORDER BY names,
        // so both have to be projected.
        query.select.contains(order.sort_column) shouldBe true
        query.select.contains(order.pk_column) shouldBe true
    }

    "the album never enters the statement" {
        // The picker offers everything and MARKS what is taken, rather than
        // asking the vault for the complement: a NOT IN over a membership table
        // would also make the page count change under a member as the album
        // filled.
        val query = PhotoPickerReads.query(opened("taken-1").state, null)
        query.where_.shouldNotBeNull() shouldNotContain "album"
        query.bind.shouldBeEmpty()
    }

    "the cells are PhotosReads' cells, held derivation and all" {
        // v0's PICKER CELLS NEVER SHOWED HELD STATE, so a member could pick a
        // photograph this device does not have and find out afterwards. They
        // show it here because it is the same renderer over the same
        // derivation, not because this screen remembered to.
        val row = Row(
            values = listOf(
                Value(text = "asset-1"),
                Value(text = "2026-02-03T10:00:00Z"),
                Value(integer = 0L),
                Value(text = "photo"),
                Value(text = ""),
                Value(text = "/store/data/abc.data"),
                Value(text = "a0b1"),
                Value(integer = 1L),
            ),
        )
        val pickerCell = PhotoPickerReads.arrived(listOf(row), null)
            .data_.shouldNotBeNull().data_.shouldNotBeNull().cells.single()
        val gridCell = PhotosReads.arrived(listOf(row), null)
            .data_.shouldNotBeNull().data_.shouldNotBeNull().cells.single()
        pickerCell shouldBe gridCell
        pickerCell.held shouldBe PhotoCell.Held.HELD_ORIGINAL
    }

    "only EXECUTED is committed" {
        // A cell that went grey before the entry existed would tell a member
        // the album holds something it does not.
        PhotoPickerReads.settled(CommandStatus.COMMAND_STATUS_EXECUTED, "", "test.command:row-0001")
            .write_settled.shouldNotBeNull().committed shouldBe true
        listOf(
            CommandStatus.COMMAND_STATUS_QUEUED,
            CommandStatus.COMMAND_STATUS_IN_FLIGHT,
            CommandStatus.COMMAND_STATUS_PARKED,
            CommandStatus.COMMAND_STATUS_DENIED,
            CommandStatus.COMMAND_STATUS_FAILED,
        ).forEach { status ->
            withClue(status.name) {
                PhotoPickerReads.settled(status, "no", "test.command:row-0001")
                    .write_settled.shouldNotBeNull().committed shouldBe false
            }
        }
    }

    "the command this picker submits exists in the vault's declared surface" {
        // `ShellCommandsExistSpec`'s gate, restated over this screen's own
        // constant: that spec holds a hand-written map and a screen added
        // without an entry in it is a screen outside the gate.
        // `NotesEditorMachine.SAVE_COMMAND` said `knowledge.save_note`, which
        // is in no registry, and every member read "That request does not make
        // sense to this build" on every attempt, for ever.
        val root = File(
            System.getProperty("centraid.repositoryRoot")
                ?: error("centraid.repositoryRoot is unset; see mobile/shared/build.gradle.kts"),
        )
        val declared = root.resolve("crates/vault/src/commands")
            .walkTopDown()
            .filter { it.isFile && it.extension == "rs" }
            .flatMap { file ->
                Regex("\"([a-z_]+\\.[a-z_]+)\"").findAll(file.readText())
                    .map { it.groupValues[1] }
            }
            .toSet()
        withClue(PhotoPickerMachine.ADD_COMMAND) {
            declared.contains(PhotoPickerMachine.ADD_COMMAND) shouldBe true
        }
    }

    "the machine reads the table its query reads" {
        PhotoPickerReads.screenId shouldBe PhotoPickerMachine.SCREEN_ID
        PhotoPickerMachine.rowsChanged(PhotoPickerReads.table, listOf("k")).shouldNotBeNull()
        PhotoPickerMachine.rowsChanged(PhotoPickerReads.table + "_other", listOf("k")) shouldBe null
    }
})
