package dev.centraid.shared

import centraid.core.v1.CommandStatus
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.Loading
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.PhotoShelfEvent
import centraid.screen.v1.PhotoShelfState
import centraid.screen.v1.PhotoStateView
import centraid.screen.v1.PhotosGridData
import dev.centraid.shared.apps.photos.AlbumChoice
import dev.centraid.shared.apps.photos.PhotoShelfMachine
import dev.centraid.shared.apps.photos.PhotoShelfReads
import dev.centraid.shared.apps.photos.PhotosGridMachine
import dev.centraid.shared.apps.photos.PhotosReads
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import java.io.File

/**
 * THE PHOTO SHELF (#1029, photos port).
 *
 * The screen that replaced four of v0's, so the laws under test are the ones
 * that were four times each: the predicate is the parameter, the empty sentence
 * is the shelf's, the selection survives a page it has not loaded, and a write
 * is one command per row named by a key that is not an ordinal.
 *
 * Everything here is `(state, event) -> (state, effects)` or a statement built
 * from a state. No dispatcher, no clock, no core — which is the whole reason
 * the screens are pure.
 */
class PhotoShelfSpec : StringSpec({

    fun mode(kind: PhotoStateView.Mode.Kind): PhotoShelf =
        PhotoShelf(state_view = PhotoStateView(mode = PhotoStateView.Mode(kind = kind)))

    val trash = mode(PhotoStateView.Mode.Kind.KIND_TRASH)
    val favorites = mode(PhotoStateView.Mode.Kind.KIND_FAVORITES)
    val archive = mode(PhotoStateView.Mode.Kind.KIND_ARCHIVE)

    fun opened(shelf: PhotoShelf) = PhotoShelfMachine.reduce(
        PhotoShelfMachine.initial(),
        PhotoShelfEvent(opened = PhotoShelfEvent.Opened(shelf = shelf)),
    )

    fun loaded(shelf: PhotoShelf, vararg assetIds: String): PhotoShelfState =
        PhotoShelfMachine.reduce(
            opened(shelf).state,
            PhotoShelfEvent(
                data_ = PhotoShelfEvent.DataArrived(
                    data_ = PhotosGridData(cells = assetIds.map { PhotoCell(asset_id = it) }),
                ),
            ),
        ).state

    "the first Opened stores the shelf and asks for a page" {
        // THE PREDICATE ARRIVES WITH THE OPEN. A read cannot be asked for until
        // the shelf is known, and `ScreenHost` publishes the state before it
        // emits the same reduce's effects — which is what lets `query` read it.
        val step = opened(trash)
        step.state.shelf shouldBe trash
        step.state.loading shouldBe Loading(first_load = true)
        step.effects shouldBe listOf(
            ScreenEffect.ReadPage(PhotoShelfMachine.SCREEN_ID, afterCursor = null),
        )
    }

    "a refusal lands as a failure and is NOT an empty shelf, and emits no re-read" {
        val shelf = loaded(favorites, "a1", "a2")
        shelf.data_.shouldNotBeNull().cells.size shouldBe 2

        val refused = PhotoShelfMachine.reduce(
            shelf,
            PhotoShelfEvent(
                refused = PhotoShelfEvent.ReadRefused(
                    Reads.refused("This is not shared with you."),
                ),
            ),
        )
        refused.state.data_.shouldBeNull()
        refused.state.failure.shouldNotBeNull().sentence shouldBe "This is not shared with you."
        // A retry is a wake, not a reducer's reflex. A reducer that re-read on
        // its own refusal is the 1 s loop the low-disk park exists to stop.
        refused.effects.shouldBeEmpty()
    }

    "a parked feed emits no re-read either" {
        val parked = PhotoShelfMachine.reduce(
            loaded(favorites, "a1"),
            PhotoShelfEvent(refused = PhotoShelfEvent.ReadRefused(Reads.lowDiskParked())),
        )
        Reads.isParked(parked.state.failure).shouldBeTrue()
        parked.effects.shouldBeEmpty()
    }

    "an empty shelf is data with no cells, and is a different state from a refusal" {
        val empty = PhotoShelfMachine.reduce(
            opened(archive).state,
            PhotoShelfEvent(data_ = PhotoShelfEvent.DataArrived(data_ = PhotosGridData())),
        ).state
        empty.data_.shouldNotBeNull().cells.shouldBeEmpty()
        empty.failure.shouldBeNull()

        val refused = PhotoShelfMachine.reduce(
            opened(archive).state,
            PhotoShelfEvent(refused = PhotoShelfEvent.ReadRefused(Reads.refused("no"))),
        ).state
        (empty == refused) shouldBe false
    }

    "rowsChanged on a foreign table answers null" {
        PhotoShelfMachine.rowsChanged("tally_expense", listOf("k")) shouldBe null
        PhotoShelfMachine.rowsChanged("media_asset_phash", listOf("k")) shouldBe null
    }

    "a change over assets this shelf is not showing moves nothing" {
        val shelf = loaded(favorites, "a1")
        val elsewhere = PhotoShelfMachine.reduce(
            shelf,
            PhotoShelfEvent(rows_changed = PhotoShelfEvent.RowsChanged(asset_ids = listOf("z9"))),
        )
        elsewhere.effects.shouldBeEmpty()
        elsewhere.state shouldBe shelf
    }

    "a change over an asset this shelf IS showing re-reads the first page" {
        val moved = PhotoShelfMachine.reduce(
            loaded(favorites, "a1"),
            PhotoShelfEvent(rows_changed = PhotoShelfEvent.RowsChanged(asset_ids = listOf("a1"))),
        )
        moved.effects shouldBe listOf(
            ScreenEffect.ReadPage(PhotoShelfMachine.SCREEN_ID, afterCursor = null),
        )
    }

    "a membership table moves the shelf although its keys are not asset ids" {
        // `media.add_to_album` writes `core_collection_entry` AND NOTHING ELSE,
        // so a shelf listening to `media_asset` alone would be right only after
        // a relaunch. The keys are entry ids, which match nothing this shelf
        // holds, so the machine answers an EMPTY list — this screen's own
        // spelling of "the membership moved and I cannot tell whose" — and the
        // reducer reads that as "read again".
        listOf("core_collection_entry", "core_tag", "media_face_region", "media_memory_member")
            .forEach { table ->
                val event = PhotoShelfMachine.rowsChanged(table, listOf("entry-1"))
                    .shouldNotBeNull()
                withClue(table) {
                    event.rows_changed.shouldNotBeNull().asset_ids.shouldBeEmpty()
                    PhotoShelfMachine.reduce(loaded(favorites, "a1"), event).effects shouldBe
                        listOf(ScreenEffect.ReadPage(PhotoShelfMachine.SCREEN_ID, null))
                }
            }
    }

    "a later page appends and never duplicates" {
        var state = PhotoShelfMachine.reduce(
            opened(favorites).state,
            PhotoShelfEvent(
                data_ = PhotoShelfEvent.DataArrived(
                    data_ = PhotosGridData(
                        cells = listOf(PhotoCell(asset_id = "a1"), PhotoCell(asset_id = "a2")),
                        next_cursor = "c1",
                    ),
                ),
            ),
        ).state
        state = PhotoShelfMachine.reduce(
            state,
            PhotoShelfEvent(
                data_ = PhotoShelfEvent.DataArrived(
                    data_ = PhotosGridData(
                        cells = listOf(PhotoCell(asset_id = "a2"), PhotoCell(asset_id = "a3")),
                    ),
                ),
            ),
        ).state
        state.data_.shouldNotBeNull().cells.map { it.asset_id } shouldBe listOf("a1", "a2", "a3")
    }

    "a pick survives a page the shelf has not loaded" {
        // THE SELECTION IS THE STATE'S AND NOT THE CELL'S. A member who picked
        // a photograph and scrolled past the page it was on must still be able
        // to act on it, so the id stays whatever the page does.
        val picked = PhotoShelfMachine.reduce(
            loaded(favorites, "a1"),
            PhotoShelfEvent(selection = PhotoShelfEvent.SelectionToggled(asset_id = "a1")),
        ).state
        picked.selected_asset_ids shouldBe listOf("a1")
        picked.selecting shouldBe true

        val reloaded = PhotoShelfMachine.reduce(
            picked,
            PhotoShelfEvent(
                data_ = PhotoShelfEvent.DataArrived(
                    data_ = PhotosGridData(cells = listOf(PhotoCell(asset_id = "a9"))),
                ),
            ),
        ).state
        reloaded.selected_asset_ids shouldBe listOf("a1")
    }

    "leaving selection mode empties the selection" {
        val picked = PhotoShelfMachine.reduce(
            loaded(favorites, "a1"),
            PhotoShelfEvent(selection = PhotoShelfEvent.SelectionToggled(asset_id = "a1")),
        ).state
        val left = PhotoShelfMachine.reduce(
            picked,
            PhotoShelfEvent(
                selection_mode = PhotoShelfEvent.SelectionModeChanged(selecting = false),
            ),
        ).state
        left.selecting shouldBe false
        left.selected_asset_ids.shouldBeEmpty()
    }

    "opening another shelf drops the selection the last one had" {
        // A Restore that fired at rows the member chose under a different
        // predicate is a write against photographs they are no longer looking
        // at.
        val picked = PhotoShelfMachine.reduce(
            loaded(trash, "a1"),
            PhotoShelfEvent(selection = PhotoShelfEvent.SelectionToggled(asset_id = "a1")),
        ).state
        val moved = PhotoShelfMachine.reduce(
            picked,
            PhotoShelfEvent(opened = PhotoShelfEvent.Opened(shelf = favorites)),
        ).state
        moved.selected_asset_ids.shouldBeEmpty()
        moved.selecting shouldBe false
    }

    "the three verbs are one registered command per picked asset" {
        val picked = PhotoShelfMachine.reduce(
            loaded(trash, "a1", "a2"),
            PhotoShelfEvent(selection = PhotoShelfEvent.SelectionToggled(asset_id = "a1")),
        ).state.let {
            PhotoShelfMachine.reduce(
                it,
                PhotoShelfEvent(selection = PhotoShelfEvent.SelectionToggled(asset_id = "a2")),
            ).state
        }

        val restored = PhotoShelfMachine.reduce(
            picked,
            PhotoShelfEvent(restore = PhotoShelfEvent.RestoreRequested()),
        )
        restored.effects.size shouldBe 2
        restored.effects.forEach { effect ->
            val write = effect as ScreenEffect.SubmitWrite
            // THE VAULT'S COMMAND NAME, not the app's action word.
            // `NotesEditorMachine.SAVE_COMMAND` said `knowledge.save_note` and
            // no such command exists; every member read "That request does not
            // make sense to this build", for ever.
            write.command shouldBe "media.restore_asset"
            // A KEY THAT IS NOT AN ORDINAL. v0's fallback was the call's
            // ordinal and was stable only for a handler making the same call
            // sequence every time.
            write.invokeKey shouldContain write.inputJson.substringAfter("\"asset_id\":\"")
                .substringBefore('"')
        }
        // AND THE SELECTION DOES NOT CLEAR ON THE REQUEST. Twelve writes are
        // twelve outcomes; a set emptied here would tell a member all twelve
        // happened. It drains one `WriteSettled` at a time.
        restored.state.selected_asset_ids shouldBe listOf("a1", "a2")
        restored.state.selecting shouldBe true
    }

    "a committed settle clears ONLY its own row, and a refused one clears none" {
        // WITHOUT THE ID A PARTIAL REFUSAL READS AS A WHOLE SUCCESS: a screen
        // told only "something committed" marks all twelve done while the two
        // the vault refused a precondition on quietly stay where they were.
        var state = PhotoShelfMachine.reduce(
            PhotoShelfMachine.reduce(
                loaded(trash, "a1", "a2"),
                PhotoShelfEvent(selection = PhotoShelfEvent.SelectionToggled(asset_id = "a1")),
            ).state,
            PhotoShelfEvent(selection = PhotoShelfEvent.SelectionToggled(asset_id = "a2")),
        ).state
        state = PhotoShelfMachine.reduce(
            state,
            PhotoShelfEvent(restore = PhotoShelfEvent.RestoreRequested()),
        ).state

        state = PhotoShelfMachine.reduce(
            state,
            PhotoShelfEvent(
                write_settled = PhotoShelfEvent.WriteSettled(
                    committed = true,
                    asset_id = "a1",
                ),
            ),
        ).state
        state.selected_asset_ids shouldBe listOf("a2")
        state.selecting shouldBe true

        val refused = PhotoShelfMachine.reduce(
            state,
            PhotoShelfEvent(
                write_settled = PhotoShelfEvent.WriteSettled(
                    committed = false,
                    sentence = "that photograph is already in the trash",
                    asset_id = "a2",
                ),
            ),
        ).state
        // THE ROW THE VAULT REFUSED IS STILL PICKED, which is the state a
        // member can retry from and the one the shelf can honestly draw.
        refused.selected_asset_ids shouldBe listOf("a2")
        refused.write_failure.shouldNotBeNull().sentence shouldBe
            "that photograph is already in the trash"

        // AND THE BAR GOES WHEN THE LAST ROW HAS SETTLED, not before.
        val done = PhotoShelfMachine.reduce(
            refused,
            PhotoShelfEvent(
                write_settled = PhotoShelfEvent.WriteSettled(
                    committed = true,
                    asset_id = "a2",
                ),
            ),
        ).state
        done.selected_asset_ids.shouldBeEmpty()
        done.selecting shouldBe false
    }

    "a settle with no id is about the BATCH, and moves no selection" {
        // A screen that cannot tell which row settled must not act as though it
        // can. `PhotoShelfReads.settled` emits an empty id today because
        // `ScreenWrites.settled` is not handed the write it is answering; the
        // reducer's job is to be right either way.
        val state = PhotoShelfMachine.reduce(
            loaded(trash, "a1"),
            PhotoShelfEvent(selection = PhotoShelfEvent.SelectionToggled(asset_id = "a1")),
        ).state
        val settled = PhotoShelfMachine.reduce(
            state,
            PhotoShelfEvent(
                write_settled = PhotoShelfEvent.WriteSettled(committed = true, asset_id = ""),
            ),
        ).state
        settled.selected_asset_ids shouldBe listOf("a1")
    }

    "the archive's Restore is an un-archive, not a restore_asset" {
        // `media.restore_asset`'s precondition is
        // `asset_is_trashed_within_its_window`, so sending it for a photograph
        // that was only ARCHIVED is refused with "that photograph is not in the
        // trash" — which a member unarchiving would read as a failure.
        val picked = PhotoShelfMachine.reduce(
            loaded(archive, "a1"),
            PhotoShelfEvent(selection = PhotoShelfEvent.SelectionToggled(asset_id = "a1")),
        ).state
        val write = PhotoShelfMachine.reduce(
            picked,
            PhotoShelfEvent(restore = PhotoShelfEvent.RestoreRequested()),
        ).effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "media.update_asset"
        write.inputJson shouldContain "\"archived\":0"
    }

    "permanent is the screen's word, and it picks a different command" {
        val picked = PhotoShelfMachine.reduce(
            loaded(trash, "a1"),
            PhotoShelfEvent(selection = PhotoShelfEvent.SelectionToggled(asset_id = "a1")),
        ).state
        val trashed = PhotoShelfMachine.reduce(
            picked,
            PhotoShelfEvent(delete = PhotoShelfEvent.DeleteRequested(permanent = false)),
        ).effects.single() as ScreenEffect.SubmitWrite
        trashed.command shouldBe "media.delete_asset"

        val purged = PhotoShelfMachine.reduce(
            picked,
            PhotoShelfEvent(delete = PhotoShelfEvent.DeleteRequested(permanent = true)),
        ).effects.single() as ScreenEffect.SubmitWrite
        purged.command shouldBe "media.purge_asset"
        // TWO INTENTS OVER ONE ROW MUST NOT SHARE A KEY: trashing and purging
        // one photograph are one tap apart and only one of them is reversible.
        (purged.invokeKey == trashed.invokeKey) shouldBe false
    }

    "an archive toggle keys on the row AND the value being set" {
        val picked = PhotoShelfMachine.reduce(
            loaded(favorites, "a1"),
            PhotoShelfEvent(selection = PhotoShelfEvent.SelectionToggled(asset_id = "a1")),
        ).state
        val on = PhotoShelfMachine.reduce(
            picked,
            PhotoShelfEvent(archive = PhotoShelfEvent.ArchiveToggled(archived = true)),
        ).effects.single() as ScreenEffect.SubmitWrite
        val off = PhotoShelfMachine.reduce(
            picked,
            PhotoShelfEvent(archive = PhotoShelfEvent.ArchiveToggled(archived = false)),
        ).effects.single() as ScreenEffect.SubmitWrite
        on.inputJson shouldContain "\"archived\":1"
        off.inputJson shouldContain "\"archived\":0"
        (on.invokeKey == off.invokeKey) shouldBe false
    }

    "a verb with nothing picked writes nothing" {
        val step = PhotoShelfMachine.reduce(
            loaded(trash, "a1"),
            PhotoShelfEvent(delete = PhotoShelfEvent.DeleteRequested(permanent = true)),
        )
        step.effects.shouldBeEmpty()
    }

    "a refused write lands in write_failure and disturbs neither rows nor picks" {
        // A FAILED WRITE IS NOT A FAILED READ. `failure` is the READ's slot —
        // one of the three states a read can be in — and a denied delete put
        // there would swap a shelf full of photographs for an error message, so
        // a member would lose the very selection they were deleting from.
        // `NoteDraft.save_failure` is the same field for the same reason.
        val shelf = PhotoShelfMachine.reduce(
            loaded(trash, "a1", "a2"),
            PhotoShelfEvent(selection = PhotoShelfEvent.SelectionToggled(asset_id = "a1")),
        ).state
        val settled = PhotoShelfMachine.reduce(
            shelf,
            PhotoShelfEvent(
                write_settled = PhotoShelfEvent.WriteSettled(
                    committed = false,
                    sentence = "Only a photograph that is already in the trash can be deleted.",
                ),
            ),
        )
        settled.state.write_failure.shouldNotBeNull().sentence shouldBe
            "Only a photograph that is already in the trash can be deleted."
        // THE ROWS AND THE PICKS ARE UNTOUCHED, which is the whole point of the
        // field existing beside `failure` rather than inside the oneof.
        settled.state.data_ shouldBe shelf.data_
        settled.state.selected_asset_ids shouldBe shelf.selected_asset_ids
        settled.state.failure.shouldBeNull()
        settled.effects.shouldBeEmpty()
    }

    "a refusal with no sentence still says something a member can read" {
        // A REFUSAL A MEMBER CANNOT SEE IS THE DEFECT `write_failure` CLOSES,
        // and an empty sentence in the slot would be exactly as silent as no
        // slot at all. Nothing here composes a sentence out of an error:
        // `Error.detail` is logs-only.
        val settled = PhotoShelfMachine.reduce(
            loaded(trash, "a1"),
            PhotoShelfEvent(
                write_settled = PhotoShelfEvent.WriteSettled(committed = false, sentence = ""),
            ),
        ).state
        settled.write_failure.shouldNotBeNull().sentence shouldBe
            PhotoShelfMachine.WRITE_REFUSED_SENTENCE
    }

    "a commit clears the last refusal, and so does opening another shelf" {
        val refused = PhotoShelfMachine.reduce(
            loaded(trash, "a1"),
            PhotoShelfEvent(
                write_settled = PhotoShelfEvent.WriteSettled(committed = false, sentence = "no"),
            ),
        ).state
        refused.write_failure.shouldNotBeNull()

        // A sentence about a delete that failed, still on screen after one that
        // worked, is a screen contradicting itself.
        PhotoShelfMachine.reduce(
            refused,
            PhotoShelfEvent(
                write_settled = PhotoShelfEvent.WriteSettled(committed = true, sentence = ""),
            ),
        ).state.write_failure.shouldBeNull()

        PhotoShelfMachine.reduce(
            refused,
            PhotoShelfEvent(opened = PhotoShelfEvent.Opened(shelf = favorites)),
        ).state.write_failure.shouldBeNull()
    }

    "a new attempt clears the previous one's refusal" {
        // A member who has just pressed Restore is owed the outcome of THAT
        // press; the previous one's sentence sitting under it is a screen
        // answering a question nobody asked twice.
        val refused = PhotoShelfMachine.reduce(
            PhotoShelfMachine.reduce(
                loaded(trash, "a1"),
                PhotoShelfEvent(selection = PhotoShelfEvent.SelectionToggled(asset_id = "a1")),
            ).state,
            PhotoShelfEvent(
                write_settled = PhotoShelfEvent.WriteSettled(committed = false, sentence = "no"),
            ),
        ).state
        val retried = PhotoShelfMachine.reduce(
            refused,
            PhotoShelfEvent(restore = PhotoShelfEvent.RestoreRequested()),
        )
        retried.state.write_failure.shouldBeNull()
        retried.effects.size shouldBe 1
    }

    "every shelf has its own empty sentence, and none of them is generic" {
        val sentences = listOf(
            PhotoShelfMachine.emptySentence(trash),
            PhotoShelfMachine.emptySentence(favorites),
            PhotoShelfMachine.emptySentence(archive),
            PhotoShelfMachine.emptySentence(mode(PhotoStateView.Mode.Kind.KIND_VIDEOS)),
            PhotoShelfMachine.emptySentence(
                PhotoShelf(album = PhotoShelf.Album(collection_id = "c1", name = "Portugal")),
            ),
            PhotoShelfMachine.emptySentence(
                PhotoShelf(place = PhotoShelf.Place(place_id = "p1", place_name = "Lisbon")),
            ),
            PhotoShelfMachine.emptySentence(
                PhotoShelf(memory = PhotoShelf.Memory(memory_id = "m1", title = "Last June")),
            ),
            PhotoShelfMachine.emptySentence(
                PhotoShelf(
                    state_view = PhotoStateView(
                        person = PhotoStateView.Person(party_id = "p", person_name = "Ana"),
                    ),
                ),
            ),
        )
        // EIGHT SHELVES, EIGHT SENTENCES. v0 had four screens and three
        // sentences between them, which is how `PlaceDetail` ended up with copy
        // the state views did not have.
        sentences.toSet().size shouldBe sentences.size
        // The names ride along, so a sentence can use them without a read.
        PhotoShelfMachine.emptySentence(
            PhotoShelf(place = PhotoShelf.Place(place_id = "p1", place_name = "Lisbon")),
        ) shouldContain "Lisbon"
    }

    "a title is a projection off the route and never a read" {
        PhotoShelfMachine.title(trash) shouldBe "Trash"
        PhotoShelfMachine.title(
            PhotoShelf(album = PhotoShelf.Album(collection_id = "c1", name = "Portugal")),
        ) shouldBe "Portugal"
        PhotoShelfMachine.title(null) shouldBe "Photographs"
    }

    // --- The statements ---------------------------------------------------

    "the shelf's select BEGINS with the cell's five, in PhotosReads' order" {
        // THE DOOR APPENDS ITS COMPUTED COLUMNS AFTER THE NAMED ONES, and
        // `PhotosReads` reads a cell's five by position and the appended three
        // from the END of the row. The grid alone names three more after the
        // five — `width`, `height`, `duration_s` — so a shelf shares the FIVE,
        // not the whole list. `PhotoShelfReads` names a sixth of its own —
        // `deleted_at`, so the trash can order by it — and reshapes each row
        // before delegating. If the five ever stopped matching, every cell on
        // every shelf would come back with the wrong column in it, silently.
        val shelfQuery = PhotoShelfReads.query(opened(trash).state, null).shouldNotBeNull()
        val gridQuery = PhotosReads.query(PhotosGridMachine.initial(), null)
        val cellFive = gridQuery.select.take(5)
        cellFive shouldBe listOf("asset_id", "captured_at", "tz_offset_min", "kind", "capture_group_id")
        shelfQuery.select shouldBe cellFive + "deleted_at"
        shelfQuery.with_held_thumbnail shouldBe gridQuery.with_held_thumbnail
    }

    "every arm selects both order columns" {
        // THE DOOR HAS NO `key_of` CALLBACK, so the cursor is read off the row
        // by the two columns the ORDER BY names. A statement that ordered by a
        // column it did not project produces a walk that is not a walk: the
        // second page starts from an empty key and repeats the first.
        val shelves = listOf(
            trash,
            favorites,
            archive,
            mode(PhotoStateView.Mode.Kind.KIND_VIDEOS),
            PhotoShelf(album = PhotoShelf.Album(collection_id = "c1", name = "Portugal")),
            PhotoShelf(place = PhotoShelf.Place(place_id = "p1", place_name = "Lisbon")),
            PhotoShelf(memory = PhotoShelf.Memory(memory_id = "m1", title = "Last June")),
            PhotoShelf(
                state_view = PhotoStateView(
                    person = PhotoStateView.Person(party_id = "party-1", person_name = "Ana"),
                ),
            ),
        )
        shelves.forEach { shelf ->
            val query = PhotoShelfReads.query(opened(shelf).state, null).shouldNotBeNull()
            val order = query.order.shouldNotBeNull()
            withClue("${query.name} selects ${query.select}") {
                query.select shouldContain order.sort_column
                query.select shouldContain order.pk_column
                query.from shouldBe PhotoShelfReads.table
            }
        }
    }

    "a shelf with no predicate reads nothing rather than the whole library" {
        // A SHELF OPENED WITHOUT ITS PARAMETER IS A DEFECT, not a state a
        // member is in. `ScreenRuntime` turns the null into a sentence rather
        // than into silence; an unbound read would have shown the member every
        // photograph they own under the word "Trash".
        PhotoShelfReads.query(PhotoShelfMachine.initial(), null).shouldBeNull()
        PhotoShelfReads.query(
            opened(mode(PhotoStateView.Mode.Kind.KIND_UNSPECIFIED)).state,
            null,
        ).shouldBeNull()
    }

    "every id a shelf is about is BOUND and never spelled into the predicate" {
        val person = PhotoShelf(
            state_view = PhotoStateView(
                person = PhotoStateView.Person(party_id = "party-1", person_name = "Ana"),
            ),
        )
        val query = PhotoShelfReads.query(opened(person).state, null).shouldNotBeNull()
        query.where_.shouldNotBeNull() shouldNotContain "party-1"
        query.bind.map { it.text } shouldContain "party-1"
        // A PROPOSAL IS A QUESTION, NOT AN IDENTIFICATION. Putting proposed
        // faces on a person's shelf would show a member photographs of a
        // stranger under their sister's name.
        query.bind.map { it.text } shouldContain "confirmed"
    }

    "favourites reads the column the favourite WRITE writes" {
        // `media_asset` HAS NO `favorite` COLUMN. `media.update_asset`'s
        // `favorite` input calls `set_starred`, which writes one `core_tag` row
        // against the `starred` concept of the flags scheme. A shelf that read
        // a column would read nothing, for ever, and show an empty favourites
        // shelf to a member who had starred a hundred photographs.
        val query = PhotoShelfReads.query(opened(favorites).state, null).shouldNotBeNull()
        val predicate = query.where_.shouldNotBeNull()
        predicate shouldContain "core_tag"
        // NO JOIN. The door pages one table and joins none, so the membership
        // is a sub-select per table — which is the door's own idiom
        // (`with_held_thumbnail` is three correlated subqueries).
        predicate shouldNotContain "JOIN"
        query.bind.map { it.text } shouldContain "starred"
        query.bind.map { it.text } shouldContain "https://centraid.dev/schemes/flags"
        query.bind.map { it.text } shouldContain "media.asset"
    }

    "the trash sorts by WHEN IT WAS DELETED, as the desktop does" {
        // `crates/apps/photos`' `trash_statement` orders `deleted_at DESC,
        // asset_id DESC`, and a shelf in a different order from the desktop's
        // over the same assets is two libraries. It matters most here: "what
        // did I just delete" is the question a trash shelf exists to answer,
        // and a capture-time order scatters a batch deleted together across
        // however many years those photographs were taken in.
        val trashOrder = PhotoShelfReads.query(opened(trash).state, null)
            .shouldNotBeNull().order.shouldNotBeNull()
        trashOrder.sort_column shouldBe "deleted_at"
        trashOrder.pk_column shouldBe "asset_id"
        trashOrder.descending shouldBe true

        // AND NO OTHER ARM LEAVES THE TIMELINE.
        listOf(favorites, archive, mode(PhotoStateView.Mode.Kind.KIND_VIDEOS)).forEach { shelf ->
            withClue(PhotoShelfMachine.title(shelf)) {
                PhotoShelfReads.query(opened(shelf).state, null)
                    .shouldNotBeNull().order.shouldNotBeNull().sort_column shouldBe "captured_at"
            }
        }
    }

    "the trash is every deleted row and the archive is neither trashed nor live" {
        PhotoShelfReads.query(opened(trash).state, null)
            .shouldNotBeNull().where_ shouldBe "deleted_at IS NOT NULL"
        // BOTH HALVES. A shelf that asked only for `archived_at IS NOT NULL`
        // would show a member every photograph they had archived AND then
        // thrown away.
        PhotoShelfReads.query(opened(archive).state, null)
            .shouldNotBeNull().where_ shouldBe "deleted_at IS NULL AND archived_at IS NOT NULL"
    }

    "the cells are PhotosReads' cells, held derivation and all" {
        // ONE DERIVATION OF `PhotoCell.Held` FOR EVERY SURFACE (D-1025-S7-62).
        // The shelf delegates rather than projecting again, which is what stops
        // this screen becoming the fifth place "which cell gets the download
        // arrow" is answered.
        val named = listOf(
            Value(text = "asset-1"),
            Value(text = "2026-02-03T10:00:00Z"),
            Value(integer = -480L),
            Value(text = "video"),
            Value(text = "group-9"),
        )
        val computed = listOf(
            Value(text = "/store/data/abc.data"),
            Value(text = "a0b1"),
            Value(integer = 0L),
        )
        // THE SHELF'S ROW CARRIES `deleted_at` BETWEEN THE TWO, because its
        // select names six columns and the door appends the computed ones
        // behind whatever was named. The grid's does not. Both must project the
        // same cell, which is what the reshape is for — and a shelf that handed
        // its row over unchanged would read the hash as the path.
        val shelfCell = PhotoShelfReads
            .arrived(listOf(Row(values = named + Value(text = "") + computed)), "c1")
            .data_.shouldNotBeNull().data_.shouldNotBeNull().cells.single()
        val gridCell = PhotosReads.arrived(listOf(Row(values = named + computed)), "c1")
            .data_.shouldNotBeNull().data_.shouldNotBeNull().cells.single()
        shelfCell shouldBe gridCell
        shelfCell.held shouldBe PhotoCell.Held.HELD_THUMBNAIL_ONLY
        shelfCell.thumbnail_path shouldBe "/store/data/abc.data"
        shelfCell.original_hash shouldBe "a0b1"
    }

    "the window is a fact about the shelf, known the moment the shelf is" {
        // NO READ AND NO CLOCK. `purge_window_days` is what v0's trash meta
        // line said — "purged 30 days after deletion" — and the constant is
        // `PURGE_AFTER_DAYS` in `crates/vault/src/commands/media.rs`, not
        // `retentionWindows` in `v0-registries.json`, which holds only `audit`
        // and `ledger`.
        opened(trash).state.purge_window_days shouldBe PhotoShelfMachine.PURGE_WINDOW_DAYS
        // 0 ON EVERY OTHER SHELF, and the sentence is empty there: a line about
        // a purge over the favourites would be about something that is not
        // going to happen.
        opened(favorites).state.purge_window_days shouldBe 0
        PhotoShelfMachine.purgeWindowSentence(0) shouldBe ""
        PhotoShelfMachine.purgeWindowSentence(30) shouldContain "30 days"
    }

    "an empty page is data with no cells, never a refusal" {
        val arrived = PhotoShelfReads.arrived(emptyList(), nextCursor = null)
        arrived.refused shouldBe null
        arrived.data_.shouldNotBeNull().data_.shouldNotBeNull().cells.shouldBeEmpty()
    }

    "only EXECUTED is committed" {
        // QUEUED, IN_FLIGHT and PARKED all mean "somewhere durable, not yet
        // committed". A shelf that reported one of them as committed would be
        // the shell asserting a commit the vault has not made.
        PhotoShelfReads.settled(CommandStatus.COMMAND_STATUS_EXECUTED, "", "test.command:row-0001")
            .write_settled.shouldNotBeNull().committed shouldBe true
        listOf(
            CommandStatus.COMMAND_STATUS_QUEUED,
            CommandStatus.COMMAND_STATUS_IN_FLIGHT,
            CommandStatus.COMMAND_STATUS_PARKED,
            CommandStatus.COMMAND_STATUS_DENIED,
            CommandStatus.COMMAND_STATUS_FAILED,
        ).forEach { status ->
            withClue(status.name) {
                PhotoShelfReads.settled(status, "no", "test.command:row-0001")
                    .write_settled.shouldNotBeNull().committed shouldBe false
            }
        }
    }

    "every command this shelf can submit exists in the vault's declared surface" {
        // THE GATE `ShellCommandsExistSpec` IS, APPLIED TO THIS LANE'S FOUR.
        // That spec holds a hand-written map of every command a screen can
        // submit, and a screen added without an entry in it is a screen outside
        // the gate — so the assertion is restated here, over this screen's own
        // constants, rather than left to a file this lane does not own.
        //
        // The oracle is the registry's own source, and the scan over-matches on
        // purpose: it cannot prove a command is REGISTERED, only that the name
        // is spelled in `crates/vault/src/commands`. That is exactly the class
        // of defect it exists for — `knowledge.save_note` appeared nowhere in
        // this repository, and a typo never does.
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
        listOf(
            PhotoShelfMachine.RESTORE_COMMAND,
            PhotoShelfMachine.DELETE_COMMAND,
            PhotoShelfMachine.PURGE_COMMAND,
            PhotoShelfMachine.UPDATE_COMMAND,
            PhotoShelfMachine.FAVORITE_COMMAND,
            PhotoShelfMachine.RENAME_ALBUM_COMMAND,
            PhotoShelfMachine.DELETE_ALBUM_COMMAND,
            PhotoShelfMachine.SET_COVER_COMMAND,
            PhotoShelfMachine.REMOVE_FROM_ALBUM_COMMAND,
            AlbumChoice.ADD_COMMAND,
            AlbumChoice.CREATE_COMMAND,
        ).forEach { command ->
            withClue(command) { declared.contains(command) shouldBe true }
        }
    }

    "an album's own verbs settle about no row, and a rename carries its title" {
        val renamed = PhotoShelfReads.settled(
            CommandStatus.COMMAND_STATUS_EXECUTED,
            "",
            "${PhotoShelfMachine.RENAME_ALBUM_COMMAND}:album-1:Lisbon: day two",
        ).write_settled.shouldNotBeNull()
        renamed.asset_id shouldBe ""
        renamed.command shouldBe PhotoShelfMachine.RENAME_ALBUM_COMMAND
        renamed.album_title shouldBe "Lisbon: day two"
        PhotoShelfReads.settled(
            CommandStatus.COMMAND_STATUS_EXECUTED,
            "",
            "${AlbumChoice.ADD_COMMAND}:album-1:asset-7",
        ).write_settled.shouldNotBeNull().asset_id shouldBe "asset-7"
    }

    "the machine reads the table its query reads" {
        // THE PAIRING, ASSERTED MECHANICALLY. When the two part company nothing
        // fails — the screen simply stops redrawing on sync, and the symptom is
        // a shelf that is right only after a relaunch.
        PhotoShelfReads.screenId shouldBe PhotoShelfMachine.SCREEN_ID
        PhotoShelfMachine.rowsChanged(PhotoShelfReads.table, listOf("k")).shouldNotBeNull()
        PhotoShelfMachine.rowsChanged(PhotoShelfReads.table + "_other", listOf("k")) shouldBe null
    }
})
