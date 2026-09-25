package dev.centraid.shared

import centraid.screen.v1.BackupState
import centraid.screen.v1.CollectionsDoor
import centraid.screen.v1.DuplicateReviewState
import centraid.screen.v1.DuplicatesState
import centraid.screen.v1.FaceReviewState
import centraid.screen.v1.HomeState
import centraid.screen.v1.Springboard
import centraid.screen.v1.TileStatus
import centraid.screen.v1.MediaPermission
import centraid.screen.v1.MemoryRow
import centraid.screen.v1.NotesEditorState
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotoLightboxState
import centraid.screen.v1.PhotoPickerState
import centraid.screen.v1.PhotoShelfState
import centraid.screen.v1.PhotoStateView
import centraid.screen.v1.PhotosCollectionsState
import centraid.screen.v1.PhotosGridState
import centraid.screen.v1.PhotosMemoriesState
import centraid.screen.v1.PhotosPeopleData
import centraid.screen.v1.PhotosPeopleState
import centraid.screen.v1.PhotosSearchState
import centraid.screen.v1.PlacesState
import centraid.screen.v1.ReadFailureKind
import centraid.screen.v1.SearchMatch
import centraid.screen.v1.SeatState
import centraid.screen.v1.TallyListState
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import java.io.File

/**
 * ONE FIXTURE, TWO LANGUAGES (#1020, D-1020-E3).
 *
 * `contracts/screens` holds one `.textproto` per case and a committed `.bin`
 * beside it. This spec decodes the `.bin` with Wire;
 * `mobile/iosApp/Tests/ScreenFixtureTests.swift` decodes the SAME BYTES with
 * SwiftProtobuf and makes the same assertions in Swift. The pattern is v0's own
 * — `TunnelWireConformanceTest.kt` and its Swift twin over one golden file —
 * and the reason is that a fixture each is two fixtures.
 *
 * **The Swift half cannot run here.** No Xcode, no simulator; it is an owner
 * hand-off with the exact command in `mobile/README.md`, and it is written so
 * that the hand-off is a `swift test` invocation and not a porting job.
 *
 * ## What this spec asserts, and what it deliberately does not
 *
 * It asserts the **laws**, case by case — the three-state read law, the
 * permission-as-state law, the two empty-cell sentences, a refused save that
 * keeps the editor. It does not assert every field of every fixture: a spec
 * that restated the fixture would be a second copy of it, and the thing worth
 * checking is that the bytes mean what the case is named after.
 */
class ScreenFixtureSpec : StringSpec({

    val contracts = File(
        System.getProperty("centraid.contractsDir")
            ?: error("centraid.contractsDir is unset; see mobile/shared/build.gradle.kts"),
    )
    val screens = contracts.resolve("screens")

    "the manifest and the directory agree" {
        // A fixture added without regenerating the manifest is a fixture the
        // Swift side never sees, because the Swift test reads the manifest.
        val manifest = screens.resolve("manifest.json").readText()
        val listed = Regex("\"binary\": \"([^\"]+)\"")
            .findAll(manifest)
            .map { it.groupValues[1].substringAfter("contracts/") }
            .toSortedSet()
        val onDisk = screens.walkTopDown()
            .filter { it.isFile && it.extension == "bin" }
            .map { "screens/${it.parentFile.name}/${it.name}" }
            .toSortedSet()
        listed shouldBe onDisk
        // And every `.bin` has its `.textproto` source: a binary with no source
        // is a fixture nobody can review.
        onDisk.forEach { path ->
            contracts.resolve(path.replace(".bin", ".textproto")).exists().shouldBeTrue()
        }
    }

    // --- Tally ------------------------------------------------------------

    "tally/loading-first is the first load, and carries no rows and no failure" {
        val state = TallyListState.ADAPTER.decode(screens.bytes("tally/loading-first"))
        state.loading.shouldNotBeNull().first_load.shouldBeTrue()
        state.data_.shouldBeNull()
        state.failure.shouldBeNull()
        state.destination shouldBe TallyListState.Destination.DESTINATION_ACTIVITY
    }

    "tally/empty-ledger and tally/refused-denied are DIFFERENT screens" {
        // THE LAW. v0 pins it in `tally-store.test.ts`: a failed read never
        // reads as an empty ledger. Asserting the two fixtures separately would
        // not catch a decoder that collapsed them, so they are asserted
        // against each other.
        val empty = TallyListState.ADAPTER.decode(screens.bytes("tally/empty-ledger"))
        val refused = TallyListState.ADAPTER.decode(screens.bytes("tally/refused-denied"))

        empty.data_.shouldNotBeNull().rows.shouldContainExactly()
        empty.failure.shouldBeNull()

        refused.data_.shouldBeNull()
        refused.failure.shouldNotBeNull().kind shouldBe ReadFailureKind.READ_FAILURE_KIND_REFUSED

        // The sentence is the access plane's, not its predicate.
        refused.failure!!.sentence shouldBe "This is not shared with you."
        (empty == refused).shouldBeFalse()
    }

    "tally/data-page carries money with its own exponent and locale" {
        // v0's formatter divides minor units by 100 unconditionally and reads
        // the HOST's locale (`packages/design/src/format.ts:38`, `:49`), so the
        // same vault renders differently on two devices. The fixture carries a
        // JPY row precisely because an exponent of 0 is what breaks that code.
        val state = TallyListState.ADAPTER.decode(screens.bytes("tally/data-page"))
        val rows = state.data_.shouldNotBeNull().rows
        rows.size shouldBe 2
        val yen = rows.single { it.amount?.currency == "JPY" }
        yen.amount.shouldNotBeNull().exponent shouldBe 0
        yen.amount!!.locale shouldBe "ja-JP"
        val dollars = rows.single { it.amount?.currency == "USD" }
        dollars.amount!!.exponent shouldBe 2
        // A keyset cursor, and it is the SORT KEY plus the primary key.
        state.data_!!.next_cursor.shouldNotBeNull().contains('|').shouldBeTrue()
        // The pending-write overlay is on the STATE, not on the row.
        state.pending_expense_ids shouldContainExactly listOf("exp-0001")
    }

    "tally/low-disk-parked is a state with a remedy, never an eviction" {
        val state = TallyListState.ADAPTER.decode(screens.bytes("tally/low-disk-parked"))
        state.failure.shouldNotBeNull().kind shouldBe
            ReadFailureKind.READ_FAILURE_KIND_LOW_DISK_PARKED
        state.failure!!.remedy.isNotBlank().shouldBeTrue()
        state.seat.shouldNotBeNull().durability shouldBe
            SeatState.Durability.DURABILITY_PARKED_LOW_DISK
    }

    "tally/offline-withheld says the verb is withheld rather than offering it" {
        val state = TallyListState.ADAPTER.decode(screens.bytes("tally/offline-withheld"))
        state.recurring_materialisation_withheld.shouldBeTrue()
        state.seat.shouldNotBeNull().durability shouldBe
            SeatState.Durability.DURABILITY_LOCAL_ONLY
        state.seat!!.pending.shouldNotBeNull().queued_writes shouldBe 3
        // Rows are still there: offline is not a failed read.
        state.data_.shouldNotBeNull().rows.size shouldBe 1
    }

    // --- Photos -----------------------------------------------------------

    "photos/permission-denied keeps the grid full — the grant moves the BACKUP" {
        // The grid reads the vault; the backup reads the camera roll. Two
        // planes, two permissions, and a denied grant must not blank a library
        // the member already owns.
        val state = PhotosGridState.ADAPTER.decode(screens.bytes("photos/permission-denied"))
        state.permission shouldBe MediaPermission.MEDIA_PERMISSION_DENIED
        state.data_.shouldNotBeNull().cells.size shouldBe 1
        state.failure.shouldBeNull()
        state.backup.shouldNotBeNull().phase shouldBe BackupState.Phase.PHASE_IDLE
        state.backup!!.paused_reason.contains("Settings").shouldBeTrue()
    }

    "photos/limited-selection is neither an empty library nor a denial" {
        val state = PhotosGridState.ADAPTER.decode(screens.bytes("photos/limited-selection"))
        state.permission shouldBe MediaPermission.MEDIA_PERMISSION_LIMITED
        state.backup.shouldNotBeNull().phase shouldBe BackupState.Phase.PHASE_TRANSFERRING
        state.backup!!.transport shouldBe BackupState.Transport.TRANSPORT_IROH_BLOBS
        // A Live Photo's still and its paired movie share one capture group.
        state.data_.shouldNotBeNull().cells.single().capture_group_id.shouldNotBeNull()
    }

    "photos: the two empty-cell sentences are two different facts" {
        val noPack = PhotosGridState.ADAPTER
            .decode(screens.bytes("photos/thumbnail-pack-absent"))
        val evicted = PhotosGridState.ADAPTER
            .decode(screens.bytes("photos/more-sheet-open"))
        noPack.data_.shouldNotBeNull().thumbnail_pack_absent.shouldBeTrue()
        noPack.data_!!.cells.single().thumbnail_path.shouldBeNull()
        // The other case: a pack exists and these particular cells are not in
        // it. Same absent path, different sentence.
        evicted.data_.shouldNotBeNull().thumbnail_pack_absent.shouldBeFalse()
        evicted.data_!!.cells.single().thumbnail_path.shouldBeNull()
    }

    "photos/no-copy-yet is not a refusal" {
        val state = PhotosGridState.ADAPTER.decode(screens.bytes("photos/no-copy-yet"))
        state.failure.shouldNotBeNull().kind shouldBe
            ReadFailureKind.READ_FAILURE_KIND_NO_COPY_YET
        state.seat.shouldNotBeNull().availability shouldBe
            SeatState.Availability.AVAILABILITY_WAITING_FOR_MOUNT
    }

    "photos/more-sheet-open keeps the band it was on: more is a sheet" {
        val state = PhotosGridState.ADAPTER.decode(screens.bytes("photos/more-sheet-open"))
        state.sheet shouldBe PhotosGridState.Sheet.SHEET_MORE
        state.destination shouldBe PhotosGridState.Destination.DESTINATION_LIBRARY
    }

    // --- Photos: the rest of the miniapp ----------------------------------
    //
    // Ten screens for v0's fourteen routes. The cases below are the ones a
    // shell that got the distinction wrong would draw wrong; a happy path
    // would pass against every such shell and is therefore not here.

    fun shelf(case: String): PhotoShelfState =
        PhotoShelfState.ADAPTER.decode(screens.bytes("photos-shelf/$case"))

    "photos-shelf: ONLY trash states a retention window" {
        // The field exists on the one message that serves four of v0's routes,
        // so the law is not "trash may state a window" but "no other shelf
        // may". Asserting the trash case alone would pass against a shelf that
        // filled the field for everything.
        //
        // It is the WINDOW and not a countdown: a countdown needs `purge_at` on
        // the row, which `PhotoCell` does not carry, and a clock, which
        // `commonMain` deliberately has not got.
        val trash = shelf("trash-states-its-window")
        trash.shelf.shouldNotBeNull().state_view.shouldNotBeNull().mode
            .shouldNotBeNull().kind shouldBe PhotoStateView.Mode.Kind.KIND_TRASH
        trash.purge_window_days shouldBe 30
        listOf("person", "album-selecting", "memory-empty-but-titled").forEach { case ->
            shelf(case).purge_window_days shouldBe 0
        }
    }

    "photos-shelf: the person arm brings its own name, and is not a mode" {
        val view = shelf("person").shelf.shouldNotBeNull().state_view.shouldNotBeNull()
        // A discriminated union: taking the person arm means there is no mode
        // to read, which is what a bag of optionals could not promise.
        view.mode.shouldBeNull()
        view.person.shouldNotBeNull().person_name shouldBe "Ada Lovelace"
    }

    "photos-shelf: a selection outlives the page it was made on" {
        // `ast-0204` is selected and is NOT in the loaded page, which is the
        // whole reason the field is on the state: a selection carried on the
        // cells is a selection the next page read drops.
        val album = shelf("album-selecting")
        album.selecting.shouldBeTrue()
        album.selected_asset_ids shouldContainExactly listOf("ast-0201", "ast-0204")
        val loaded = album.data_.shouldNotBeNull().cells.map { it.asset_id }
        loaded.contains("ast-0204").shouldBeFalse()
    }

    "photos-shelf: an empty shelf is data, and its head still has a title" {
        val memory = shelf("memory-empty-but-titled")
        memory.data_.shouldNotBeNull().cells.shouldContainExactly()
        memory.failure.shouldBeNull()
        // The title rides on the shelf, so there is something to draw over the
        // empty frame without a read.
        memory.shelf.shouldNotBeNull().memory.shouldNotBeNull().title shouldBe "Lisbon, April"
    }

    fun lightbox(case: String): PhotoLightboxState =
        PhotoLightboxState.ADAPTER.decode(screens.bytes("photos-lightbox/$case"))

    "photos-lightbox: the download arrow needs a decision AND a hash" {
        val withheld = lightbox("withheld-by-rule")
        val detail = withheld.detail.shouldNotBeNull()
        detail.held shouldBe PhotoCell.Held.HELD_WITHHELD_BY_RULE
        // `seat.bytes.fetch` takes a hash, so the tap has one to name.
        detail.original_hash.length shouldBe 64
        // Absent original, present thumbnail: the fallback, not an error.
        detail.original_path.shouldBeNull()
        detail.thumbnail_path.shouldNotBeNull()
    }

    "photos-lightbox: chrome is a state, and it is not the sheet" {
        val hidden = lightbox("chrome-hidden")
        hidden.chrome_visible.shouldBeFalse()
        // Independent of the sheet: a decoder that inferred one from the other
        // would put the bars back the moment a sheet closed.
        hidden.sheet shouldBe PhotoLightboxState.Sheet.SHEET_NONE
        lightbox("withheld-by-rule").chrome_visible.shouldBeTrue()
    }

    "photos-lightbox: the facts panel says which labels are guesses" {
        val info = lightbox("info-sheet-proposals")
        info.sheet shouldBe PhotoLightboxState.Sheet.SHEET_INFO
        val detail = info.detail.shouldNotBeNull()
        // Confirmed regions only — a proposal here would look like a fact.
        detail.people.single().display_name shouldBe "Ada Lovelace"
        // The member's tag and a derivation's proposal in one list, each saying
        // which it is.
        detail.labels.map { it.confirmed } shouldContainExactly listOf(true, false)
    }

    "photos-lightbox: the surface a member waits on can show a percentage" {
        // `fetch_percent` was absent from `PhotoDetail` for one draft, which
        // put a number on the 120-cell grid and none on the one surface a
        // member actually watches a download on.
        val fetching = lightbox("fetching-with-percent")
        val detail = fetching.detail.shouldNotBeNull()
        detail.held shouldBe PhotoCell.Held.HELD_FETCHING
        detail.fetch_percent shouldBe 43
        // The bytes are still moving, so the thumbnail is what draws. Taking
        // HELD_FETCHING as permission to reach for the original is a blank
        // frame for as long as the transfer takes.
        detail.original_path.shouldBeNull()
        detail.thumbnail_path.shouldNotBeNull()
    }

    "photos-lightbox: a loading lightbox still knows which photograph it is" {
        val loading = lightbox("loading-keyed-by-asset")
        loading.detail.shouldBeNull()
        // `asset_id` sits outside the oneof, so the chrome and the filmstrip
        // have something to key by while the read is in flight.
        loading.asset_id shouldBe "ast-0330"
        loading.neighbour_asset_ids.size shouldBe 3
    }

    fun collections(case: String): PhotosCollectionsState =
        PhotosCollectionsState.ADAPTER.decode(screens.bytes("photos-collections/$case"))

    "photos-collections: one row type, and member_owned is the only difference" {
        val data = collections("standing-and-owned").data_.shouldNotBeNull()
        data.shelves.count { !it.member_owned } shouldBe 4
        data.shelves.single { it.member_owned }.title shouldBe "Portugal"
        // Zero is a real count and the row is still a door; and the absent
        // cover is absent rather than a placeholder path.
        val videos = data.shelves.single { it.title == "Videos" }
        videos.item_count shouldBe 0
        videos.cover_thumbnail_path.shouldBeNull()
        // The doors are the taps that do not land on a shelf, and the badge is
        // a different number from the count.
        val people = data.doors.single { it.kind == CollectionsDoor.Kind.KIND_PEOPLE }
        people.count shouldBe 214
        people.needs_attention shouldBe 63
        data.doors.size shouldBe 4
    }

    "photos-collections: the new-album sheet leaves the list underneath intact" {
        val sheet = collections("new-album-sheet")
        sheet.sheet shouldBe PhotosCollectionsState.Sheet.SHEET_NEW_ALBUM
        // A route could not produce this shape: the shelves are still here.
        sheet.data_.shouldNotBeNull().shelves.size shouldBe 2
    }

    "photos-collections: a count over a filled page is a floor and says so" {
        // No `COUNT(*)` on the read door, so every count here is counted from
        // the rows one page returned. Both pairs are in one fixture because a
        // view that drew capped and uncapped alike passes against either alone.
        val data = collections("counts-are-floors").data_.shouldNotBeNull()
        val trash = data.shelves.single { it.title == "Trash" }
        val album = data.shelves.single { it.member_owned }
        trash.item_count shouldBe 2
        trash.item_count_capped.shouldBeFalse()
        album.item_count shouldBe 137
        // "At least 137". A bare number here states a total nobody counted.
        album.item_count_capped.shouldBeTrue()

        val peopleDoor = data.doors.single { it.kind == CollectionsDoor.Kind.KIND_PEOPLE }
        val duplicatesDoor = data.doors.single {
            it.kind == CollectionsDoor.Kind.KIND_DUPLICATES
        }
        peopleDoor.count_capped.shouldBeTrue()
        duplicatesDoor.count_capped.shouldBeFalse()
        // A badge is "there is work": a floor and a total draw the same dot,
        // which is why `needs_attention` has no capped sibling to assert.
        peopleDoor.needs_attention shouldBe 63
        data.next_cursor.shouldNotBeNull()
    }

    "photos-collections: a refused Collections invents no standing shelves" {
        // The standing four exist in every vault, which makes this the screen
        // most likely to draw rows it did not read. Their counts and covers
        // come from a read, and a failed read has none.
        val refused = collections("read-refused")
        refused.data_.shouldBeNull()
        refused.failure.shouldNotBeNull().kind shouldBe
            ReadFailureKind.READ_FAILURE_KIND_NO_COPY_YET
    }

    fun search(case: String): PhotosSearchState =
        PhotosSearchState.ADAPTER.decode(screens.bytes("photos-search/$case"))

    "photos-search: resting and no-hits must never read the same words" {
        // The two that a bag of optionals collapses: both show a grid with
        // nothing in it, and only one of them may say "Nothing matched".
        val resting = search("resting")
        val noHits = search("no-hits")

        resting.query shouldBe ""
        resting.resting.shouldNotBeNull().suggested_labels.size shouldBe 2
        resting.hits.shouldBeNull()

        noHits.query shouldBe "kayak"
        noHits.hits.shouldNotBeNull().cells.shouldContainExactly()
        noHits.resting.shouldBeNull()
        // An empty result is DATA, not a failure.
        noHits.failure.shouldBeNull()
        (resting == noHits).shouldBeFalse()
    }

    "photos-search: a match is a KIND and a name, never prose" {
        // Field 4 was `repeated string matched_on` and is now reserved. A
        // prose line made each shell compose its own sentence, which is how
        // v0's empty states drifted apart; the kind is the contract's and the
        // sentence is the view's.
        val hits = search("hits-say-why").hits.shouldNotBeNull()
        hits.matches.map { it.kind } shouldContainExactly listOf(
            SearchMatch.Kind.KIND_PERSON,
            SearchMatch.Kind.KIND_LABEL,
            SearchMatch.Kind.KIND_TITLE,
        )
        // The value is the vault's word for the thing, never the query echoed
        // back: two of these three do not contain "Ada" as it was typed.
        // (`value_` is Wire's escaped name, as `data_` and `where_` are.)
        hits.matches.first().value_ shouldBe "Ada Lovelace"
        hits.matches.count { it.value_.contains("Ada") } shouldBe 2
        hits.cells.size shouldBe 2
    }

    fun places(case: String): PlacesState =
        PlacesState.ADAPTER.decode(screens.bytes("photos-places/$case"))

    "photos-places: 0,0 is a real point, and has_coordinate is what says so" {
        val rows = places("no-coordinate").data_.shouldNotBeNull().places
        val nullIsland = rows.single { it.place_id == "plc-0011" }
        val unlocated = rows.single { it.place_id == "plc-0012" }
        // Byte-identical doubles; only the bool separates a pin in the Gulf of
        // Guinea from a place the vault holds no coordinate for. Anything that
        // tested `lat != 0 || lng != 0` is wrong about one of these.
        nullIsland.latitude shouldBe unlocated.latitude
        nullIsland.longitude shouldBe unlocated.longitude
        nullIsland.has_coordinate.shouldBeTrue()
        unlocated.has_coordinate.shouldBeFalse()
    }

    "photos-places: cards and the map are one screen with a parameter" {
        val cards = places("no-coordinate")
        val map = places("map-presentation")
        cards.presentation shouldBe PlacesState.Presentation.PRESENTATION_CARDS
        map.presentation shouldBe PlacesState.Presentation.PRESENTATION_MAP
        // Same rows, read the same way. If the map ever needs a field the
        // cards do not have, it has to be added here in front of a reviewer.
        map.data_.shouldNotBeNull().unplaced_count shouldBe
            cards.data_.shouldNotBeNull().unplaced_count
        map.data_!!.places.all { row ->
            cards.data_!!.places.any { it.place_id == row.place_id }
        }.shouldBeTrue()
    }

    "photos-places: the unplaced count is not derived from the page" {
        // A screen that computed "everything not on this page" would say 0
        // here, because the page is empty, and be wrong by 1904.
        val data = places("no-places-but-unplaced").data_.shouldNotBeNull()
        data.places.shouldContainExactly()
        data.unplaced_count shouldBe 1904
    }

    fun people(case: String): PhotosPeopleState =
        PhotosPeopleState.ADAPTER.decode(screens.bytes("photos-people/$case"))

    "photos-people: an empty list is two different screens" {
        // v0 drew one sentence for all three causes (`PeopleEmptyState.tsx`).
        // These two have the same empty list and differ in both fields that
        // decide what a member is told and what they are offered.
        val off = people("recognition-off").data_.shouldNotBeNull()
        val noneNamed = people("none-named").data_.shouldNotBeNull()
        off.people.shouldContainExactly()
        noneNamed.people.shouldContainExactly()

        off.empty_reason shouldBe PhotosPeopleData.EmptyReason.EMPTY_REASON_RECOGNITION_OFF
        // No plane running means no queue: the answer is a setting, not a door.
        off.proposed_face_count shouldBe 0

        noneNamed.empty_reason shouldBe PhotosPeopleData.EmptyReason.EMPTY_REASON_NONE_NAMED
        // The answer here IS the door, with its count on it.
        noneNamed.proposed_face_count shouldBe 63
        off.empty_reason shouldNotBe noneNamed.empty_reason
    }

    "photos-people: a populated list says NONE explicitly, badge and all" {
        // `EMPTY_REASON_NONE` is a value and not the absence of one; 0 is the
        // UNSPECIFIED slot, so "not empty" is stated rather than inferred.
        val full = people("named-with-proposals-waiting").data_.shouldNotBeNull()
        full.empty_reason shouldBe PhotosPeopleData.EmptyReason.EMPTY_REASON_NONE
        full.people.size shouldBe 2
        // Independent facts: named people, and questions still waiting.
        full.proposed_face_count shouldBe 7
        // And the per-person count is a floor when its own read filled a page.
        // Ada's 148 is where the read stopped; Grace's twelve came back whole.
        full.people.single { it.display_name == "Ada Lovelace" }
            .photo_count_capped.shouldBeTrue()
        full.people.single { it.display_name == "Grace Hopper" }
            .photo_count_capped.shouldBeFalse()
    }

    fun faces(case: String): FaceReviewState =
        FaceReviewState.ADAPTER.decode(screens.bytes("photos-faces/$case"))

    "photos-faces: a cursor past the end is a finish, not an empty queue" {
        val done = faces("worked-through")
        val off = faces("recognition-off")
        done.data_.shouldNotBeNull().candidates.size shouldBe 2
        (done.cursor >= done.data_!!.candidates.size).shouldBeTrue()
        done.recognition_enabled.shouldBeTrue()

        // The other screen with no question showing, and it is not a finish: a
        // queue cannot fill while the plane that fills it is off.
        off.data_.shouldNotBeNull().candidates.shouldContainExactly()
        off.cursor shouldBe 0
        off.recognition_enabled.shouldBeFalse()
        // A setting a member chose is not an error, so there is no retry.
        off.failure.shouldBeNull()
    }

    "photos-faces: a face with no guess is still a question, in fractions" {
        val data = faces("unnamed-guess").data_.shouldNotBeNull()
        val unnamed = data.candidates.single { it.region_id == "rgn-0010" }
        unnamed.proposed_party_id shouldBe ""
        unnamed.proposed_name shouldBe ""
        unnamed.confidence shouldBe 0.0
        // Fractions of the image and never pixels: there is no per-face
        // derivative, so the box is drawn over the asset's thumbnail at
        // whatever size the view rendered.
        data.candidates.all {
            it.box_x + it.box_width <= 1.0 && it.box_y + it.box_height <= 1.0
        }.shouldBeTrue()
        // The picker needs no second read while a member is mid-answer.
        data.known_people.size shouldBe 2
    }

    fun duplicates(case: String): DuplicatesState =
        DuplicatesState.ADAPTER.decode(screens.bytes("photos-duplicates/$case"))

    "photos-duplicates: an unwalked library is not a clean one" {
        // Same empty list, one boolean apart, and only one of them may say
        // "No duplicates". Asserted against each other because two separate
        // assertions pass just as happily against a shell that collapsed them.
        val incomplete = duplicates("scan-incomplete")
        val clean = duplicates("scanned-and-clean")
        incomplete.data_.shouldNotBeNull().clusters.shouldContainExactly()
        clean.data_.shouldNotBeNull().clusters.shouldContainExactly()
        incomplete.data_!!.scan_complete.shouldBeFalse()
        clean.data_!!.scan_complete.shouldBeTrue()
        (incomplete.data_ == clean.data_).shouldBeFalse()
    }

    "photos-duplicates: the shelf is ordered by what resolving gives back" {
        val data = duplicates("clusters-by-reclaimable").data_.shouldNotBeNull()
        data.clusters.map { it.reclaimable_bytes } shouldBe
            data.clusters.map { it.reclaimable_bytes }.sortedDescending()
        // The page is whole, so the total is the sum and not a floor.
        data.next_cursor.shouldBeNull()
        data.total_reclaimable_bytes shouldBe data.clusters.sumOf { it.reclaimable_bytes }
    }

    "photos-duplicates: a partial page reports a floor and never a total" {
        // The pair the whole-page case needs. Same shelf, one page short: the
        // total accounts for the three clusters read and nothing behind them,
        // and `total_capped` is the only thing that says the sum is not the
        // answer. A screen printing both the same way promises space it has
        // not accounted for.
        val partial = duplicates("clusters-partial-page").data_.shouldNotBeNull()
        val whole = duplicates("clusters-by-reclaimable").data_.shouldNotBeNull()
        partial.next_cursor.shouldNotBeNull()
        partial.total_capped.shouldBeTrue()
        partial.total_reclaimable_bytes shouldBe partial.clusters.sumOf { it.reclaimable_bytes }
        whole.next_cursor.shouldBeNull()
        whole.total_capped.shouldBeFalse()
        // A cluster's own members are read within a page limit too.
        partial.clusters.single { it.member_count_capped }.cluster_id shouldBe "dup-0004"
        whole.clusters.none { it.member_count_capped }.shouldBeTrue()
    }

    fun memories(case: String): PhotosMemoriesState =
        PhotosMemoriesState.ADAPTER.decode(screens.bytes("photos-memories/$case"))

    "photos-memories: not yet computed is not 'there are none'" {
        // The same shape as `scan_complete`, and for the same reason: both
        // screens are a pass's output with an empty list while it is pending.
        // Asserted against each other, because two separate assertions pass
        // just as happily against a shell that collapsed them.
        val notYet = memories("not-yet-computed")
        val none = memories("computed-and-empty")
        notYet.data_.shouldNotBeNull().memories.shouldContainExactly()
        none.data_.shouldNotBeNull().memories.shouldContainExactly()
        notYet.data_!!.computed.shouldBeFalse()
        none.data_!!.computed.shouldBeTrue()
        (notYet.data_ == none.data_).shouldBeFalse()
        // Data, not a failure: a retry does not make a pass run.
        notYet.failure.shouldBeNull()
    }

    "photos-memories: a memory the pass could not name has no title to store" {
        // The view composes from `day_key` and `place_name`. A title written
        // into the vault by a view is a title no other surface agrees with,
        // and it outlives the view that invented it.
        val rows = memories("title-hint-absent").data_.shouldNotBeNull().memories
        val unnamed = rows.single { it.memory_id == "mem-0020" }
        unnamed.title_hint shouldBe ""
        unnamed.day_key shouldBe "2024-06-14"
        unnamed.place_name.isNotBlank().shouldBeTrue()
        // A span, not a day: the two kinds compose differently, which is why
        // the ends are on the row rather than derived from `day_key`.
        unnamed.kind shouldBe MemoryRow.Kind.KIND_TRIP
        (unnamed.ended_at > unnamed.started_at).shouldBeTrue()
        // The branch: one row has a hint the pass wrote, and a fixture with
        // only one of them passes against a view that handles neither.
        rows.single { it.memory_id == "mem-0021" }.title_hint shouldBe "On this day"
    }

    fun duplicateReview(case: String): DuplicateReviewState =
        DuplicateReviewState.ADAPTER.decode(screens.bytes("photos-duplicate-review/$case"))

    "photos-duplicate-review: a suggestion the member has not accepted deletes nothing" {
        // THE ONE THAT MATTERS MOST IN THIS SET. Resolving trashes every
        // member but the one `keep_asset_id` names, so a recommendation
        // written into that field is the product choosing which of a member's
        // photographs to delete.
        val state = duplicateReview("suggestion-not-accepted")
        val data = state.data_.shouldNotBeNull()
        data.suggested_keep_asset_id shouldBe "ast-0401"
        data.suggestion_reason.isNotBlank().shouldBeTrue()
        state.keep_asset_id shouldBe ""
    }

    "photos-duplicate-review: the member may keep the one the suggestion did not" {
        // Both fields set and disagreeing — only representable because they
        // are two fields. A single one would have lost the fact that a
        // recommendation was made and declined.
        val state = duplicateReview("member-overrode-the-suggestion")
        val data = state.data_.shouldNotBeNull()
        state.keep_asset_id shouldBe "ast-0402"
        data.suggested_keep_asset_id shouldBe "ast-0401"
        // And the reason they kept it: a copy put somewhere by hand is not a
        // stray, so deleting it is a different act.
        data.members.single { it.asset_id == state.keep_asset_id }.member_placed.shouldBeTrue()
    }

    "photos-duplicate-review: byte-identical copies get no recommendation at all" {
        // The rule is "largest by bytes"; when it has no answer the honest
        // state is silence, not an arbitrary pick dressed as advice.
        val data = duplicateReview("no-suggestion-at-all").data_.shouldNotBeNull()
        data.suggested_keep_asset_id shouldBe ""
        data.suggestion_reason shouldBe ""
        data.members.map { it.byte_size }.distinct().size shouldBe 1
    }

    fun picker(case: String): PhotoPickerState =
        PhotoPickerState.ADAPTER.decode(screens.bytes("photos-picker/$case"))

    "photos-picker: what the album holds is not what the member just picked" {
        val state = picker("already-in-album")
        val loaded = state.data_.shouldNotBeNull().cells.map { it.asset_id }
        // The overlap is the point: without it every cell looks addable,
        // including the ones this album already has.
        state.already_in_album_asset_ids shouldContainExactly listOf("ast-0201", "ast-0202")
        state.already_in_album_asset_ids.all { loaded.contains(it) }.shouldBeTrue()
        // Two lists, disjoint: collapsing them would make the member's new
        // picks indistinguishable from what was already there.
        state.picked_asset_ids shouldContainExactly listOf("ast-0203")
        state.picked_asset_ids.none {
            state.already_in_album_asset_ids.contains(it)
        }.shouldBeTrue()
    }

    "photos-picker: the head is named before the read lands" {
        val state = picker("named-before-the-read")
        state.data_.shouldBeNull()
        state.loading.shouldNotBeNull().first_load.shouldBeTrue()
        state.collection_name shouldBe "Portugal"
        // Arrived on `Opened`, from the album the member came from — not from
        // the library read, which has not landed.
        state.already_in_album_asset_ids.size shouldBe 2
        // The screen never pre-picks.
        state.picked_asset_ids.shouldContainExactly()
    }

    "photos: each of the eleven new screens sets exactly one content state" {
        // The three-state law as a sweep. An empty data case standing in for a
        // failure is the fourth state every one of these is tempted to grow,
        // and the only way to know none of them did is to ask all of them.
        fun sweep(directory: String, count: (ByteArray) -> Int) =
            screens.resolve(directory).binFiles().forEach { count(it.readBytes()) shouldBe 1 }

        sweep("photos-shelf") { bytes ->
            PhotoShelfState.ADAPTER.decode(bytes)
                .let { contentCount(it.loading, it.failure, it.data_) }
        }
        sweep("photos-lightbox") { bytes ->
            PhotoLightboxState.ADAPTER.decode(bytes)
                .let { contentCount(it.loading, it.failure, it.detail) }
        }
        sweep("photos-collections") { bytes ->
            PhotosCollectionsState.ADAPTER.decode(bytes)
                .let { contentCount(it.loading, it.failure, it.data_) }
        }
        // Search has FOUR arms: resting is a third thing that is neither a
        // load nor a result, and it is still exactly one of them.
        sweep("photos-search") { bytes ->
            PhotosSearchState.ADAPTER.decode(bytes)
                .let { contentCount(it.resting, it.loading, it.failure, it.hits) }
        }
        sweep("photos-places") { bytes ->
            PlacesState.ADAPTER.decode(bytes)
                .let { contentCount(it.loading, it.failure, it.data_) }
        }
        sweep("photos-memories") { bytes ->
            PhotosMemoriesState.ADAPTER.decode(bytes)
                .let { contentCount(it.loading, it.failure, it.data_) }
        }
        sweep("photos-people") { bytes ->
            PhotosPeopleState.ADAPTER.decode(bytes)
                .let { contentCount(it.loading, it.failure, it.data_) }
        }
        sweep("photos-faces") { bytes ->
            FaceReviewState.ADAPTER.decode(bytes)
                .let { contentCount(it.loading, it.failure, it.data_) }
        }
        sweep("photos-duplicates") { bytes ->
            DuplicatesState.ADAPTER.decode(bytes)
                .let { contentCount(it.loading, it.failure, it.data_) }
        }
        sweep("photos-duplicate-review") { bytes ->
            DuplicateReviewState.ADAPTER.decode(bytes)
                .let { contentCount(it.loading, it.failure, it.data_) }
        }
        sweep("photos-picker") { bytes ->
            PhotoPickerState.ADAPTER.decode(bytes)
                .let { contentCount(it.loading, it.failure, it.data_) }
        }
    }

    // --- Notes ------------------------------------------------------------

    "notes/save-refused keeps the words on the screen; notes/read-refused does not" {
        val saveRefused = NotesEditorState.ADAPTER.decode(screens.bytes("notes/save-refused"))
        val readRefused = NotesEditorState.ADAPTER.decode(screens.bytes("notes/read-refused"))

        // A failed SAVE: the draft is present, the editor is intact, and the
        // sentence rides on the draft.
        saveRefused.draft.shouldNotBeNull().body shouldBe "Book the cabin."
        saveRefused.failure.shouldBeNull()
        saveRefused.save shouldBe NotesEditorState.SaveState.SAVE_STATE_REFUSED
        saveRefused.draft!!.save_failure.shouldNotBeNull().kind shouldBe
            ReadFailureKind.READ_FAILURE_KIND_UNAVAILABLE

        // A failed READ: there is nothing to edit, because the body never came.
        readRefused.draft.shouldBeNull()
        readRefused.failure.shouldNotBeNull().kind shouldBe
            ReadFailureKind.READ_FAILURE_KIND_REFUSED
    }

    "notes/draft-dirty is edited and unsaved, with no write in flight" {
        val state = NotesEditorState.ADAPTER.decode(screens.bytes("notes/draft-dirty"))
        state.save shouldBe NotesEditorState.SaveState.SAVE_STATE_DIRTY
        state.draft.shouldNotBeNull().base_revision_id shouldBe "rev-0007"
        state.draft!!.body.contains('\n').shouldBeTrue()
    }

    // --- Seat -------------------------------------------------------------

    "the seat's four sentences decode, and 'platform refused to say' is not 'offline'" {
        val refusedToSay = SeatState.ADAPTER
            .decode(screens.bytes("seat/platform-refused-to-say"))
        val waiting = SeatState.ADAPTER.decode(screens.bytes("seat/waiting-for-mount"))
        refusedToSay.connectivity shouldBe
            SeatState.Connectivity.CONNECTIVITY_UNKNOWN_PLATFORM_REFUSED
        waiting.connectivity shouldBe SeatState.Connectivity.CONNECTIVITY_OFFLINE
        (refusedToSay.connectivity == waiting.connectivity).shouldBeFalse()
        refusedToSay.pending.shouldNotBeNull().queued_uploads shouldBe 41

        SeatState.ADAPTER.decode(screens.bytes("seat/locked")).availability shouldBe
            SeatState.Availability.AVAILABILITY_LOCKED
        SeatState.ADAPTER.decode(screens.bytes("seat/restarting")).availability shouldBe
            SeatState.Availability.AVAILABILITY_RESTARTING
    }

    "every fixture sets at most one of the three content states" {
        // The three-state law as a sweep rather than a claim: no fixture may
        // carry both a failure and data, which is the shape a decoder that
        // collapsed the two would produce.
        screens.resolve("tally").binFiles().forEach { file ->
            val state = TallyListState.ADAPTER.decode(file.readBytes())
            contentCount(state.loading, state.failure, state.data_) shouldBe 1
        }
        screens.resolve("photos").binFiles().forEach { file ->
            val state = PhotosGridState.ADAPTER.decode(file.readBytes())
            contentCount(state.loading, state.failure, state.data_) shouldBe 1
        }
        screens.resolve("notes").binFiles().forEach { file ->
            val state = NotesEditorState.ADAPTER.decode(file.readBytes())
            contentCount(state.loading, state.failure, state.draft) shouldBe 1
        }
    }
    // --- Home: the graded springboard -------------------------------------

    fun home(case: String): HomeState =
        HomeState.ADAPTER.decode(screens.resolve("home/$case.bin").readBytes())

    "home: an unreadable springboard is NOT a first run" {
        // THE FOURTH READ STATE, and the reason Home has one. Both fixtures
        // show eight tiles with no content; only one of them may say the vault
        // is empty, and it is the one whose reads LANDED.
        val unreadable = home("every-tile-unreadable")
        val firstRun = home("first-run")

        unreadable.data_.shouldNotBeNull().every_tile_unreadable.shouldBeTrue()
        unreadable.data_!!.springboard shouldBe Springboard.SPRINGBOARD_CONTENT
        unreadable.data_!!.tiles.all { it.status == TileStatus.TILE_STATUS_UNKNOWN }.shouldBeTrue()

        firstRun.data_!!.springboard shouldBe Springboard.SPRINGBOARD_FIRST_RUN
        firstRun.data_!!.every_tile_unreadable.shouldBeFalse()

        // The two must never decode to the same screen.
        unreadable.data_!!.springboard shouldNotBe firstRun.data_!!.springboard
    }

    "home: a withheld count is ABSENT and never zero" {
        val content = home("content")
        val locker = content.data_!!.tiles.first { it.app_id == "locker" }
        // Locker has CONTENT and hands over no count. A `0` here would be a lie
        // about how many secrets a member holds.
        locker.status shouldBe TileStatus.TILE_STATUS_CONTENT
        locker.count.shouldBeNull()
        // The vault total OMITS it rather than adding zero: 1284 + 42 + 7.
        content.data_!!.things!!.total shouldBe 1333
    }

    "home: a capped count says the total is only a floor" {
        val things = home("status-urgent").data_!!.things!!
        things.capped.shouldBeTrue()
        things.total shouldBe 500
    }

    "home: an unaddressable photo is still a CELL" {
        val photos = home("content").data_!!.tiles.first { it.app_id == "photos" }
        val cells = photos.body!!.photos!!.cells
        cells.size shouldBe 3
        // Dropping this row would reflow ten photos as one blank under a "10".
        cells.last().thumbnail_path.shouldBeNull()
    }

    "home: Locker earns the grid while EMPTY" {
        val locker = home("first-run").data_!!.tiles.first { it.app_id == "locker" }
        locker.status shouldBe TileStatus.TILE_STATUS_EMPTY
        locker.earns_grid.shouldBeTrue()
    }

    "home: a loading springboard reports its total unsettled" {
        val loading = home("loading-first").data_!!
        loading.springboard shouldBe Springboard.SPRINGBOARD_LOADING
        loading.things!!.settled.shouldBeFalse()
        // A read in flight holds its slot at full geometry.
        loading.tiles.all { it.earns_grid }.shouldBeTrue()
    }

    "home: a refused Home has no grid at all" {
        // Distinct from every tile being unreadable: that Home loaded and could
        // not read its apps; this one could not load, so it invents no apps.
        val refused = home("read-refused")
        refused.data_.shouldBeNull()
        refused.failure.shouldNotBeNull().kind shouldBe
            ReadFailureKind.READ_FAILURE_KIND_NO_COPY_YET
    }

    "home: the all-apps sheet leaves the Home underneath intact" {
        val sheet = home("all-apps-open")
        sheet.all_apps_sheet_open.shouldBeTrue()
        sheet.data_.shouldNotBeNull().tiles.size shouldBe 8
    }

}) {
    companion object {
        fun File.bytes(case: String): ByteArray = resolve("$case.bin").readBytes()

        fun File.binFiles(): List<File> =
            listFiles { file -> file.extension == "bin" }?.sorted() ?: emptyList()

        fun contentCount(vararg cases: Any?): Int = cases.count { it != null }
    }
}
