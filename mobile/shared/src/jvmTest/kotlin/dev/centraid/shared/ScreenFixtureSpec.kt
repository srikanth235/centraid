package dev.centraid.shared

import centraid.screen.v1.BackupState
import centraid.screen.v1.MediaPermission
import centraid.screen.v1.NotesEditorState
import centraid.screen.v1.PhotosGridState
import centraid.screen.v1.ReadFailureKind
import centraid.screen.v1.SeatState
import centraid.screen.v1.TallyListState
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
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
}) {
    companion object {
        fun File.bytes(case: String): ByteArray = resolve("$case.bin").readBytes()

        fun File.binFiles(): List<File> =
            listFiles { file -> file.extension == "bin" }?.sorted() ?: emptyList()

        fun contentCount(vararg cases: Any?): Int = cases.count { it != null }
    }
}
