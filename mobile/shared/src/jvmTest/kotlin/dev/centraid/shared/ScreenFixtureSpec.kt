package dev.centraid.shared

import centraid.screen.v1.WriteState
import centraid.screen.v1.HomeState
import centraid.screen.v1.Springboard
import centraid.screen.v1.TileStatus
import centraid.screen.v1.ReadFailureKind
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

}) {
    companion object {
        fun File.bytes(case: String): ByteArray = resolve("$case.bin").readBytes()

        fun File.binFiles(): List<File> =
            listFiles { file -> file.extension == "bin" }?.sorted() ?: emptyList()

        fun contentCount(vararg cases: Any?): Int = cases.count { it != null }
    }
}
