package dev.centraid.shared

import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotosGridData
import centraid.screen.v1.PhotosGridEvent
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.apps.photos.FreeUpFlow
import dev.centraid.shared.apps.photos.KeepOriginals
import dev.centraid.shared.apps.photos.PhotosGridMachine
import dev.centraid.shared.platform.FakeLibraryDeleter
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.sync.ContentHash
import dev.centraid.shared.sync.CoreOriginals
import dev.centraid.shared.sync.DeleteCapability
import dev.centraid.shared.sync.DeleteOutcome
import dev.centraid.shared.sync.FetchedOriginal
import dev.centraid.shared.sync.FreeUpDoors
import dev.centraid.shared.sync.ReleasableItem
import dev.centraid.shared.sync.ReleasableList
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlin.io.path.createTempDirectory

/**
 * FREE UP SPACE IS A VERB AGAIN (#1080 A19, A20; R-1029-PH-1 superseded).
 *
 * The row offers only what the core named releasable — library originals a
 * gateway holds whole, never an edited one — and only where the shell
 * installed a deleter that asks through the system's own confirmation. The
 * deleter answers which hashes went, and the core is told exactly those. The
 * three answers a deleter gives — deleted, declined, failed — are each a
 * sentence on the row.
 */
class FreeUpSpec : StringSpec({

    val census = CoreOriginals.Census(onPhoneCount = 40, onPhoneBytes = 3_000_000_000, keptCount = 0, keptBytes = 0)
    val a = ReleasableItem(ContentHash.raw("aa".repeat(32))!!.toByteArray(), "A/L0/001", 1_500_000_000, "image/heic")
    val b = ReleasableItem(ContentHash.raw("bb".repeat(32))!!.toByteArray(), "B/L0/001", 500_000_000, "video/quicktime")
    val both = ReleasableList(listOf(a, b), totalBytes = 2_000_000_000)

    /** Doors that answer [list] and remember, as hex, what they were told went. */
    class Doors(var list: ReleasableList?, var records: Boolean = true) : FreeUpDoors {
        val released = mutableListOf<List<String>>()

        override suspend fun releasable(limit: Long): ReleasableList? = list

        override suspend fun released(contentHashes: List<ByteArray>): Int? {
            released += contentHashes.map { bytes -> bytes.joinToString("") { "%02x".format(it) } }
            return if (records) contentHashes.size else null
        }
    }

    "nothing is offered until a gateway holds an original whole, and a core that cannot say offers nothing" {
        val unchecked = KeepOriginals.freeUp(census, null)
        unchecked.offered shouldBe true
        unchecked.enabled shouldBe false
        unchecked.reason shouldContain KeepOriginals.NOT_CHECKED
        unchecked.action_label shouldBe ""
        val none = KeepOriginals.freeUp(census, ReleasableList(emptyList(), 0))
        none.enabled shouldBe false
        none.reason shouldContain KeepOriginals.NOTHING_SAFE

        val offered = KeepOriginals.freeUp(census, both)
        offered.enabled shouldBe true
        offered.action_label shouldBe "Free up 2 GB"
        offered.reason shouldBe "2 photos are safe on your gateways."
        offered.releasable_count shouldBe 2
        offered.releasable_bytes shouldBe 2_000_000_000L
        offered.meta shouldBe "40 originals · 3 GB on this phone"
        // NOT COUNTED IS NEVER ZERO, and offers nothing either.
        KeepOriginals.freeUp(null, both).enabled shouldBe false
    }

    "a phone that cannot delete behind the system's confirmation draws no row at all" {
        val none = KeepOriginals.freeUp(census, both, DeleteCapability.NONE)
        none.offered shouldBe false
        none.enabled shouldBe false
        none.action_label shouldBe ""
    }

    "a tap holds the row while the system asks, and only a counted, enabled row is tapped" {
        val offered = KeepOriginals.freeUp(census, both)
        KeepOriginals.tapped(offered)?.freeing shouldBe true
        KeepOriginals.tapped(offered.copy(freeing = true)).shouldBeNull()
        KeepOriginals.tapped(KeepOriginals.freeUp(census, null)).shouldBeNull()
        KeepOriginals.tapped(null).shouldBeNull()

        val grid = PhotosGridMachine.initial().copy(free_up = offered)
        val tapped = PhotosGridMachine.reduce(grid, PhotosGridEvent(free_up_tapped = PhotosGridEvent.FreeUpTapped()))
        tapped.state.free_up?.freeing shouldBe true
        PhotosGridMachine.reduce(tapped.state, PhotosGridEvent(free_up_tapped = PhotosGridEvent.FreeUpTapped()))
            .state shouldBe tapped.state
    }

    "deleted: the deleter is handed the items whole, and the core is told exactly the hashes that went" {
        runTest {
            val doors = Doors(both)
            val deleter = FakeLibraryDeleter()
            val after = FreeUpFlow(doors, { census }) { deleter }.free()
            deleter.handed shouldBe listOf(listOf(a, b))
            doors.released shouldBe listOf(listOf(a.hex, b.hex))
            after.notice shouldBe "Freed 2 GB. Those photos stay in Centraid and come back from your gateways when you open one."
            after.freeing shouldBe false

            // AN ASSET THE PLATFORM KEPT WHOLE is not reported.
            val partial = Doors(both)
            deleter.answer = { items -> DeleteOutcome(listOf(items.first().contentHash), declined = false, error = null) }
            FreeUpFlow(partial, { census }) { deleter }.free().notice shouldContain "Freed 1 GB"
            partial.released shouldBe listOf(listOf(a.hex))
        }
    }

    "declined: the member's no in the system's dialog frees nothing and tells the core nothing" {
        runTest {
            val doors = Doors(both)
            val deleter = FakeLibraryDeleter(answer = { DeleteOutcome(emptyList(), declined = true, error = null) })
            FreeUpFlow(doors, { census }) { deleter }.free().notice shouldBe KeepOriginals.NOTHING_REMOVED
            doors.released.shouldBeEmpty()
        }
    }

    "failed: the platform's own words, and only what it says went is reported" {
        runTest {
            val doors = Doors(both)
            val deleter = FakeLibraryDeleter(answer = { DeleteOutcome(emptyList(), declined = false, error = "Photos access is limited.") })
            FreeUpFlow(doors, { census }) { deleter }.free().notice shouldBe "Photos access is limited."
            doors.released.shouldBeEmpty()

            // A CORE THAT WILL NOT RECORD what went says so.
            FreeUpFlow(Doors(both, records = false), { census }) { FakeLibraryDeleter() }.free().notice shouldBe
                KeepOriginals.NOT_RECORDED
            // AND ONE THAT CANNOT SAY WHAT IS SAFE deletes nothing.
            val unasked = FakeLibraryDeleter()
            val unchecked = FreeUpFlow(Doors(null), { census }) { unasked }.free()
            unchecked.notice shouldBe KeepOriginals.NOT_CHECKED
            unasked.handed.shouldBeEmpty()
        }
    }

    "the deleter is the session's, installed and cleared; with none the row does not draw and nothing is deleted" {
        runTest {
            val session = HomeSession.open(
                vaultDir = createTempDirectory("centraid-free-up").toString(),
                services = FakePlatformServices(),
                dispatcher = Dispatchers.Unconfined,
                uiThreadName = "test",
            )
            val doors = Doors(both)
            val flow = FreeUpFlow(doors, { census }) { session.libraryDeleter }
            // NOTHING INSTALLED: no row, and a stray tap deletes nothing.
            flow.capability() shouldBe DeleteCapability.NONE
            flow.count().offered shouldBe false

            val deleter = FakeLibraryDeleter()
            session.installLibraryDeleter(deleter)
            flow.capability() shouldBe DeleteCapability.SYSTEM_CONFIRMATION
            flow.count().offered shouldBe true

            // ANDROID CLEARS IT WITH ITS ACTIVITY: a rotation must not leave a
            // destroyed activity's launcher in the session.
            session.installLibraryDeleter(null)
            session.libraryDeleter.shouldBeNull()
            flow.count().offered shouldBe false
            flow.free().offered shouldBe false
            deleter.handed.shouldBeEmpty()
            doors.released.shouldBeEmpty()
            session.close()
        }
    }

    "the way back: a freed original fetched from the grid re-reads on success and says why not on a failure (#1080)" {
        val grid = PhotosGridMachine.initial().copy(
            loading = null,
            data_ = PhotosGridData(cells = listOf(PhotoCell(asset_id = "a-1", held = PhotoCell.Held.HELD_WITHHELD_BY_RULE))),
        )
        val tapped = PhotosGridMachine.reduce(
            grid,
            PhotosGridEvent(fetch_original = PhotosGridEvent.OriginalRequested(asset_id = "a-1", content_hash = "ab".repeat(32))),
        )
        tapped.state.data_!!.cells.single().held shouldBe PhotoCell.Held.HELD_FETCHING
        tapped.effects shouldBe listOf(ScreenEffect.FetchOriginal(PhotosGridMachine.SCREEN_ID, "a-1", "ab".repeat(32)))
        // A SUCCESS IS A RE-READ: the bytes are here, and only a read draws them.
        PhotosGridMachine.reduce(
            tapped.state,
            PhotosGridEvent(fetch_settled = PhotosGridEvent.FetchSettled(asset_id = "a-1", fetched = true)),
        ).effects.any { it is ScreenEffect.ReadPage } shouldBe true
        // A FAILURE STOPS THE SPINNER AND NAMES WHY, without replacing the library.
        val failed = PhotosGridMachine.reduce(
            tapped.state,
            PhotosGridEvent(
                fetch_settled = PhotosGridEvent.FetchSettled(asset_id = "a-1", fetched = false, sentence = SharedCopy.FETCH_UNTRUSTED),
            ),
        )
        failed.state.data_!!.cells.single().held shouldBe PhotoCell.Held.HELD_WITHHELD_BY_RULE
        failed.state.write_failure!!.sentence shouldBe SharedCopy.FETCH_UNTRUSTED
        failed.state.failure.shouldBeNull()
        failed.effects.shouldBeEmpty()
    }

    "every way a fetch ends is fetched or a line that names why, the two outcomes lane C adds included" {
        FetchedOriginal.entries.filter { it.fetched } shouldBe listOf(FetchedOriginal.LANDED, FetchedOriginal.ALREADY_HELD)
        FetchedOriginal.entries.filterNot { it.fetched }.associateWith { it.sentence } shouldBe mapOf(
            FetchedOriginal.UNREACHABLE to SharedCopy.FETCH_UNREACHABLE,
            FetchedOriginal.NOT_IN_BACKUP to SharedCopy.FETCH_NOT_IN_BACKUP,
            FetchedOriginal.UNTRUSTED to SharedCopy.FETCH_UNTRUSTED,
            FetchedOriginal.DAMAGED to SharedCopy.FETCH_DAMAGED,
        )
        FetchedOriginal.entries.filter { it.fetched }.all { it.sentence.isEmpty() } shouldBe true
    }
})
