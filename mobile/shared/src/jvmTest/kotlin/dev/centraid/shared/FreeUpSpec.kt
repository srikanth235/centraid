package dev.centraid.shared

import dev.centraid.shared.shell.FreeUpFlow
import dev.centraid.shared.platform.FakeLibraryDeleter
import dev.centraid.shared.platform.FakePlatformServices
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlin.io.path.createTempDirectory

/**
 * FREE UP SPACE IS A VERB AGAIN (#1080 A19, A20; R-1029-PH-1 superseded): the
 * shell's half.
 *
 * What a member READS about it (the row, its reason, the action's size, the
 * notice) is Rust's and is pinned by `crates/screens/tests/photos_home.rs`. What
 * is pinned here is the flow: only what the core named releasable is handed to
 * the installed deleter, which asks through the system's own confirmation; the
 * core is told exactly the hashes that went; and the three answers a deleter
 * gives — deleted, declined, failed — each reach the screen as a closed outcome.
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

    "a phone that cannot delete behind the system's confirmation offers no row, and counts what the core said" {
        runTest {
            val none = FreeUpFlow(Doors(both), { census }) { null }
            none.count().offered shouldBe false

            val counted = FreeUpFlow(Doors(both), { census }) { FakeLibraryDeleter() }.count()
            counted.offered shouldBe true
            counted.counted shouldBe true
            counted.onPhoneCount shouldBe 40
            counted.checked shouldBe true
            counted.releasableCount shouldBe 2
            counted.releasableBytes shouldBe 2_000_000_000L
            // NOT COUNTED IS NEVER ZERO, and a core that cannot say what is safe is not "nothing safe".
            val blind = FreeUpFlow(Doors(null), { null }) { FakeLibraryDeleter() }.count()
            blind.counted shouldBe false
            blind.checked shouldBe false
        }
    }

    "deleted: the deleter is handed the items whole, and the core is told exactly the hashes that went" {
        runTest {
            val doors = Doors(both)
            val deleter = FakeLibraryDeleter()
            val after = FreeUpFlow(doors, { census }) { deleter }.free()
            deleter.handed shouldBe listOf(listOf(a, b))
            doors.released shouldBe listOf(listOf(a.hex, b.hex))
            after.outcome shouldBe FreeUpFlow.Outcome.FREED
            after.freedBytes shouldBe 2_000_000_000L

            // AN ASSET THE PLATFORM KEPT WHOLE is not reported.
            val partial = Doors(both)
            deleter.answer = { items -> DeleteOutcome(listOf(items.first().contentHash), declined = false, error = null) }
            val some = FreeUpFlow(partial, { census }) { deleter }.free()
            some.outcome shouldBe FreeUpFlow.Outcome.FREED
            some.freedBytes shouldBe 1_500_000_000L
            partial.released shouldBe listOf(listOf(a.hex))
        }
    }

    "declined: the member's no in the system's dialog frees nothing and tells the core nothing" {
        runTest {
            val doors = Doors(both)
            val deleter = FakeLibraryDeleter(answer = { DeleteOutcome(emptyList(), declined = true, error = null) })
            FreeUpFlow(doors, { census }) { deleter }.free().outcome shouldBe FreeUpFlow.Outcome.NOTHING_REMOVED
            doors.released.shouldBeEmpty()
        }
    }

    "failed: the platform's own words, and only what it says went is reported" {
        runTest {
            val doors = Doors(both)
            val deleter = FakeLibraryDeleter(answer = { DeleteOutcome(emptyList(), declined = false, error = "Photos access is limited.") })
            val failed = FreeUpFlow(doors, { census }) { deleter }.free()
            failed.outcome shouldBe FreeUpFlow.Outcome.PLATFORM_ERROR
            failed.platformError shouldBe "Photos access is limited."
            doors.released.shouldBeEmpty()

            // A CORE THAT WILL NOT RECORD what went says so.
            FreeUpFlow(Doors(both, records = false), { census }) { FakeLibraryDeleter() }.free().outcome shouldBe
                FreeUpFlow.Outcome.NOT_RECORDED
            // AND ONE THAT CANNOT SAY WHAT IS SAFE deletes nothing.
            val unasked = FakeLibraryDeleter()
            FreeUpFlow(Doors(null), { census }) { unasked }.free().outcome shouldBe FreeUpFlow.Outcome.NOT_CHECKED
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

    "every way a fetch ends is fetched or a line that names why" {
        FetchedOriginal.entries.filter { it.fetched } shouldBe listOf(FetchedOriginal.LANDED, FetchedOriginal.ALREADY_HELD)
        // The sentences are Rust's (`photos::fetch`); the shell reports the closed outcome.
        FetchedOriginal.entries.filterNot { it.fetched }.map { it.name } shouldBe
            listOf("UNREACHABLE", "NOT_IN_BACKUP", "UNTRUSTED", "DAMAGED")
    }
})
