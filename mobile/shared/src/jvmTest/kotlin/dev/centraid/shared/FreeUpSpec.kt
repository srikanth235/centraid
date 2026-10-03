package dev.centraid.shared

import centraid.screen.v1.FreeUpSpace
import centraid.screen.v1.PhotosGridEvent
import dev.centraid.shared.apps.photos.FreeUpFlow
import dev.centraid.shared.apps.photos.KeepOriginals
import dev.centraid.shared.apps.photos.PhotosGridMachine
import dev.centraid.shared.platform.FakeMediaLibrary
import dev.centraid.shared.platform.MediaLibrary
import dev.centraid.shared.sync.CoreOriginals
import dev.centraid.shared.sync.FreeUpDoors
import dev.centraid.shared.sync.ReleasableItem
import dev.centraid.shared.sync.ReleasableList
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import kotlinx.coroutines.test.runTest

/**
 * FREE UP SPACE IS A VERB AGAIN (#1080 A19; R-1029-PH-1 superseded).
 *
 * The row offers only what the core named releasable — library originals a
 * gateway holds whole — the platform deletes behind the system's own
 * confirmation and says which went, and the core is told exactly those. Every
 * other answer frees nothing and says so.
 */
class FreeUpSpec : StringSpec({

    val census = CoreOriginals.Census(onPhoneCount = 40, onPhoneBytes = 3_000_000_000, keptCount = 0, keptBytes = 0)
    val a = ReleasableItem("aa".repeat(32), "A/L0/001", 1_500_000_000, "image/heic")
    val b = ReleasableItem("bb".repeat(32), "B/L0/001", 500_000_000, "video/quicktime")
    val both = ReleasableList(listOf(a, b), totalBytes = 2_000_000_000)

    /** Doors that answer [list] and remember what they were told went. */
    class Doors(var list: ReleasableList?, var records: Boolean = true) : FreeUpDoors {
        val released = mutableListOf<List<String>>()

        override suspend fun releasable(limit: Long): ReleasableList? = list

        override suspend fun released(contentHashes: List<String>): Int? {
            released += contentHashes
            return if (records) contentHashes.size else null
        }
    }

    "nothing is offered until a gateway holds an original whole, and a core that cannot say offers nothing" {
        val unchecked = KeepOriginals.freeUp(census, null)
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

    "the flow deletes what is safe, tells the core exactly which went, and counts again" {
        runTest {
            val doors = Doors(both)
            val library = FakeMediaLibrary()
            val flow = FreeUpFlow(doors, { census }, library)
            val after = flow.free()
            library.deletions shouldBe listOf(listOf(a.osRef, b.osRef))
            doors.released shouldBe listOf(listOf(a.contentHash, b.contentHash))
            after.notice shouldBe "Freed 2 GB. Those photos stay in Centraid and come back from your gateways when you open one."
            after.freeing shouldBe false
        }
    }

    "the platform's word is final: a declined dialog frees nothing, and an asset it kept is not reported" {
        runTest {
            val declined = Doors(both)
            val library = FakeMediaLibrary()
            library.deleting = { MediaLibrary.DeleteOutcome.Declined }
            FreeUpFlow(declined, { census }, library).free().notice shouldBe KeepOriginals.NOTHING_REMOVED
            declined.released.shouldBeEmpty()

            // A LIVE PHOTO WHOSE MOVIE IS NOT CONFIRMED, or an edited one, stays.
            val partial = Doors(both)
            library.deleting = { refs -> MediaLibrary.DeleteOutcome.Deleted(refs.take(1)) }
            FreeUpFlow(partial, { census }, library).free().notice shouldContain "Freed 1 GB"
            partial.released shouldBe listOf(listOf(a.contentHash))

            library.deleting = { MediaLibrary.DeleteOutcome.Refused("Photos access is limited.") }
            FreeUpFlow(Doors(both), { census }, library).free().notice shouldBe "Photos access is limited."
        }
    }

    "a core that will not record says so, and one that cannot say deletes nothing" {
        runTest {
            val library = FakeMediaLibrary()
            FreeUpFlow(Doors(both, records = false), { census }, library).free().notice shouldBe
                KeepOriginals.NOT_RECORDED
            library.deletions.clear()
            val unchecked = FreeUpFlow(Doors(null), { census }, library).free()
            unchecked.notice shouldBe KeepOriginals.NOT_CHECKED
            unchecked.enabled shouldBe false
            library.deletions.shouldBeEmpty()
        }
    }

    "the library's default refuses: a platform that has not built deletion frees nothing" {
        runTest {
            val bare = object : MediaLibrary {
                override suspend fun permission() = centraid.screen.v1.MediaPermission.MEDIA_PERMISSION_GRANTED

                override suspend fun requestPermission() = permission()

                override suspend fun page(afterCursor: String?, limit: Int) = MediaLibrary.Page(emptyList(), null)

                override suspend fun open(ref: String, allowNetwork: Boolean): MediaLibrary.Opened = MediaLibrary.Opened.Gone
            }
            (bare.deleteFromLibrary(listOf("A")) is MediaLibrary.DeleteOutcome.Refused) shouldBe true
            val doors = Doors(both)
            FreeUpFlow(doors, { census }, bare).free().notice shouldContain "cannot remove"
            doors.released.shouldBeEmpty()
        }
    }

    "a row is a FreeUpSpace a view draws whole" {
        // THE VIEW DECIDES NOTHING: the action's words, whether it is live, and
        // what the last one did all arrive finished.
        val row: FreeUpSpace = KeepOriginals.freeUp(census, both, notice = "Nothing was removed.")
        row.notice shouldBe "Nothing was removed."
        row.counted shouldBe true
    }
})
