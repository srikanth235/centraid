package dev.centraid.shared

import centraid.screen.v1.WriteState
import centraid.screen.v1.HomeState
import centraid.screen.v1.MoneyHomeState
import centraid.screen.v1.MoneyImportState
import centraid.screen.v1.MoneyTransactionState
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
