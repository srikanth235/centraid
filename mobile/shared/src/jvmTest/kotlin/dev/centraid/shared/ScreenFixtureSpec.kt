package dev.centraid.shared

import centraid.screen.v1.BackupState
import centraid.screen.v1.WriteState
import centraid.screen.v1.CollectionsDoor
import centraid.screen.v1.DuplicateReviewState
import centraid.screen.v1.DuplicatesState
import centraid.screen.v1.HomeState
import centraid.screen.v1.MoneyHomeState
import centraid.screen.v1.MoneyImportState
import centraid.screen.v1.MoneyTransactionState
import centraid.screen.v1.Springboard
import centraid.screen.v1.TileStatus
import centraid.screen.v1.MediaPermission
import centraid.screen.v1.NotesEditorState
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotoLightboxState
import centraid.screen.v1.PhotoStateView
import centraid.screen.v1.PhotosCollectionsState
import centraid.screen.v1.PhotosGridState
import centraid.screen.v1.PhotosSearchState
import centraid.screen.v1.ReadFailureKind
import centraid.screen.v1.SearchMatch
import centraid.screen.v1.SeatState
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldBeEmpty
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
        state.backup.paused_reason.contains("Settings").shouldBeTrue()
    }

    "photos/limited-selection is neither an empty library nor a denial" {
        val state = PhotosGridState.ADAPTER.decode(screens.bytes("photos/limited-selection"))
        state.permission shouldBe MediaPermission.MEDIA_PERMISSION_LIMITED
        state.backup.shouldNotBeNull().phase shouldBe BackupState.Phase.PHASE_TRANSFERRING
        // FIELD 5 IS RESERVED (#1080): the fixture carries no transport, so
        // nothing decodes into the unknown fields where a stale `.bin` would put it.
        state.backup.unknownFields.size shouldBe 0
        // A Live Photo's still and its paired movie share one capture group.
        state.data_.shouldNotBeNull().cells.single().capture_group_id.shouldNotBeNull()
    }

    "photos: the two empty-cell sentences are two different facts" {
        val noPack = PhotosGridState.ADAPTER
            .decode(screens.bytes("photos/thumbnail-pack-absent"))
        val evicted = PhotosGridState.ADAPTER
            .decode(screens.bytes("photos/more-sheet-open"))
        noPack.data_.shouldNotBeNull().thumbnail_pack_absent.shouldBeTrue()
        noPack.data_.cells.single().thumbnail_path.shouldBeNull()
        // The other case: a pack exists and these particular cells are not in
        // it. Same absent path, different sentence.
        evicted.data_.shouldNotBeNull().thumbnail_pack_absent.shouldBeFalse()
        evicted.data_.cells.single().thumbnail_path.shouldBeNull()
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
        val duplicates = data.doors.single { it.kind == CollectionsDoor.Kind.KIND_DUPLICATES }
        duplicates.count shouldBe 3
        duplicates.needs_attention shouldBe 3
        data.doors.size shouldBe 2
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

        val placesDoor = data.doors.single { it.kind == CollectionsDoor.Kind.KIND_PLACES }
        val duplicatesDoor = data.doors.single {
            it.kind == CollectionsDoor.Kind.KIND_DUPLICATES
        }
        placesDoor.count_capped.shouldBeTrue()
        duplicatesDoor.count_capped.shouldBeFalse()
        // A badge is "there is work": a floor and a total draw the same dot,
        // which is why `needs_attention` has no capped sibling to assert.
        duplicatesDoor.needs_attention shouldBe 3
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

    "photos-search: a corrected answer is the field's words, and the hits answer what was typed" {
        // #1097, R-1097-27. The correction rides the shared field, which the
        // kit draws as "Including results for"; the hits still answer the TYPED
        // words, so a reducer can tell a late page from a current one.
        val corrected = search("corrected")
        corrected.query shouldBe "sunscren"
        corrected.search.shouldNotBeNull().corrected shouldBe "sunscreen"
        corrected.search.shouldNotBeNull().term shouldBe "sunscren"
        corrected.hits.shouldNotBeNull().query shouldBe "sunscren"
        corrected.hits.shouldNotBeNull().cells.size shouldBe 1
        // An exact answer carries no correction.
        search("hits-say-why").search shouldBe null
    }

    "photos-search: a match is a KIND and a name, never prose" {
        // Field 4 was `repeated string matched_on` and is now reserved. A
        // prose line made each shell compose its own sentence, which is how
        // v0's empty states drifted apart; the kind is the contract's and the
        // sentence is the view's.
        val hits = search("hits-say-why").hits.shouldNotBeNull()
        hits.matches.map { it.kind } shouldContainExactly listOf(
            SearchMatch.Kind.KIND_PLACE,
            SearchMatch.Kind.KIND_LABEL,
            SearchMatch.Kind.KIND_TITLE,
        )
        // The value is the vault's word for the thing, never the query echoed
        // back: two of these three do not contain "Dublin" as it was typed.
        // (`value_` is Wire's escaped name, as `data_` and `where_` are.)
        hits.matches.first().value_ shouldBe "Dún Laoghaire"
        hits.matches.count { it.value_.contains("Dublin") } shouldBe 1
        hits.cells.size shouldBe 2
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
        incomplete.data_.scan_complete.shouldBeFalse()
        clean.data_.scan_complete.shouldBeTrue()
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

    "photos: each of the six new screens sets exactly one content state" {
        // The three-state law as a sweep. An empty data case standing in for a
        // failure is the fourth state every one of these is tempted to grow,
        // and the only way to know none of them did is to ask all of them.
        fun sweep(directory: String, count: (ByteArray) -> Int) =
            screens.resolve(directory).binFiles().forEach { count(it.readBytes()) shouldBe 1 }

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
        sweep("photos-duplicates") { bytes ->
            DuplicatesState.ADAPTER.decode(bytes)
                .let { contentCount(it.loading, it.failure, it.data_) }
        }
        sweep("photos-duplicate-review") { bytes ->
            DuplicateReviewState.ADAPTER.decode(bytes)
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
        saveRefused.draft.save_failure.shouldNotBeNull().kind shouldBe
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
        state.draft.body.contains('\n').shouldBeTrue()
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
        unreadable.data_.springboard shouldBe Springboard.SPRINGBOARD_CONTENT
        unreadable.data_.tiles.all { it.status == TileStatus.TILE_STATUS_UNKNOWN }.shouldBeTrue()

        firstRun.data_!!.springboard shouldBe Springboard.SPRINGBOARD_FIRST_RUN
        firstRun.data_.every_tile_unreadable.shouldBeFalse()

        // The two must never decode to the same screen.
        unreadable.data_.springboard shouldNotBe firstRun.data_.springboard
    }

    "home: a withheld count is ABSENT and never zero" {
        val content = home("content")
        val locker = content.data_!!.tiles.first { it.app_id == "locker" }
        // Locker has CONTENT and hands over no count. A `0` here would be a lie
        // about how many secrets a member holds.
        locker.status shouldBe TileStatus.TILE_STATUS_CONTENT
        locker.count.shouldBeNull()
    }

    "home: an unaddressable photo is still a CELL" {
        val photos = home("content").data_!!.tiles.first { it.app_id == "photos" }
        val cells = photos.body!!.photos!!.cells
        cells.size shouldBe 3
        // Dropping this row would reflow ten photos as one blank under a "10".
        cells.last().thumbnail_path.shouldBeNull()
    }

    "home: every app is on the grid on day one, Locker included" {
        val data = home("first-run").data_!!
        data.tiles.first { it.app_id == "locker" }.status shouldBe TileStatus.TILE_STATUS_EMPTY
        data.grid_rows.flatMap { it.app_ids }.toSet() shouldBe data.tiles.map { it.app_id }.toSet()
    }

    "home: a loading springboard holds every slot" {
        val loading = home("loading-first").data_!!
        loading.springboard shouldBe Springboard.SPRINGBOARD_LOADING
        // A read in flight holds its slot at full geometry.
        loading.grid_rows.flatMap { it.app_ids }.toSet() shouldBe loading.tiles.map { it.app_id }.toSet()
    }

    "home: a refused Home has no grid at all" {
        // Distinct from every tile being unreadable: that Home loaded and could
        // not read its apps; this one could not load, so it invents no apps.
        val refused = home("read-refused")
        refused.data_.shouldBeNull()
        refused.failure.shouldNotBeNull().kind shouldBe
            ReadFailureKind.READ_FAILURE_KIND_NO_COPY_YET
    }

    // --- Money (#1099) ----------------------------------------------------

    fun money(case: String): MoneyHomeState =
        MoneyHomeState.ADAPTER.decode(screens.bytes("money/$case"))

    "money: day one is one sentence and one action, with the same verb in the header" {
        val state = money("day-one")
        val empty = state.data_.shouldNotBeNull().spending.shouldNotBeNull().empty.shouldNotBeNull()
        empty.headline shouldBe "Import a bank statement to see this month."
        empty.action_label shouldBe state.chrome.shouldNotBeNull().add_label
        state.band.map { it.key } shouldBe listOf("spending", "activity", "cashflow", "more")
        state.data_.spending.shouldNotBeNull().heroes.shouldBeEmpty()
    }

    "money: two currencies are two heroes, and a figure never spans them" {
        val spending = money("spending").data_.shouldNotBeNull().spending.shouldNotBeNull()
        spending.heroes.map { it.spent?.currency } shouldBe listOf("USD", "CAD")
        spending.tables.single().currency shouldBe "USD"
        // Over plan is a minus sign and a tone, never a colour alone.
        val over = spending.tables.single().rows.single()
        over.over.shouldBeTrue()
        over.left?.minor shouldBe -2_827L
        spending.in_out_net.single().figures.map { it.label } shouldBe listOf("In", "Out", "Net")
    }

    "money: a transfer keeps its row, greyed, and the chip row has no sort chip" {
        val state = money("activity")
        state.chips.map { it.key } shouldBe listOf("month", "account", "category")
        val transfer = state.data_.shouldNotBeNull().activity.shouldNotBeNull().sections[1].rows.single()
        transfer.dimmed.shouldBeTrue()
        transfer.chips.single().label shouldBe "Transfer"
    }

    "money: a denied Money is the gate and a failed read keeps its band" {
        val denied = money("denied")
        val refused = money("read-refused")
        denied.denied.shouldNotBeNull().title shouldBe "Money is off"
        denied.band.shouldContainExactly()
        denied.failure.shouldBeNull()
        refused.failure.shouldNotBeNull().kind shouldBe ReadFailureKind.READ_FAILURE_KIND_UNAVAILABLE
        refused.band.size shouldBe 4
    }

    "money: the import review counts every verdict, and the date-order question has no rows and no default" {
        val review = MoneyImportState.ADAPTER.decode(screens.bytes("money-import/planned"))
        val statement = review.data_.shouldNotBeNull().statements.single()
        statement.counts.map { it.label } shouldBe listOf("New", "Already in", "Check these", "Can’t read")
        statement.rows.first { it.line_label == "Row 88" }.reason shouldBe "Amount has a letter O."
        review.data_.publish_label shouldBe "Import 186 rows"
        val question = MoneyImportState.ADAPTER.decode(screens.bytes("money-import/question"))
        val asked = question.data_.shouldNotBeNull().statements.single()
        asked.question.shouldNotBeNull().options.none { it.selected }.shouldBeTrue()
        asked.rows.shouldBeEmpty()
        question.data_.publish_label shouldBe ""
    }

    "money: a transaction offers a transfer and a rule and carries no write" {
        val state = MoneyTransactionState.ADAPTER.decode(screens.bytes("money-transaction/offers"))
        val data = state.data_.shouldNotBeNull()
        data.transfer_offer.shouldNotBeNull().key shouldBe "transfer"
        data.rule_offer.shouldNotBeNull().key shouldBe "rule"
        state.write.shouldNotBeNull().phase shouldBe WriteState.Phase.PHASE_IDLE
        data.actions.single { it.destructive }.key shouldBe "void"
    }

    "money: every fixture sets exactly one content state" {
        screens.resolve("money").binFiles().forEach { file ->
            val state = MoneyHomeState.ADAPTER.decode(file.readBytes())
            contentCount(state.loading, state.failure, state.denied, state.data_) shouldBe 1
        }
        screens.resolve("money-import").binFiles().forEach { file ->
            val state = MoneyImportState.ADAPTER.decode(file.readBytes())
            contentCount(state.loading, state.failure, state.denied, state.data_) shouldBe 1
        }
        screens.resolve("money-transaction").binFiles().forEach { file ->
            val state = MoneyTransactionState.ADAPTER.decode(file.readBytes())
            contentCount(state.loading, state.failure, state.denied, state.data_) shouldBe 1
        }
    }

}) {
    companion object {
        fun File.bytes(case: String): ByteArray = resolve("$case.bin").readBytes()

        fun File.binFiles(): List<File> =
            listFiles { file -> file.extension == "bin" }?.sorted() ?: emptyList()

        fun contentCount(vararg cases: Any?): Int = cases.count { it != null }
    }
}
