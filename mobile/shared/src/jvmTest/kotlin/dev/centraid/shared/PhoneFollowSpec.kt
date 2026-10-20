package dev.centraid.shared

import dev.centraid.shared.shell.PhoneFollowQuestion
import dev.centraid.shared.shell.PhoneFollower
import dev.centraid.shared.sync.phone.GoneReason
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneFollowPass
import dev.centraid.shared.sync.phone.PhoneFollowReads
import dev.centraid.shared.sync.phone.PhoneSource
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

/** A source over a vault that answers what a spec tells it and records what the follower asked. */
private class FakePass : PhoneFollowPass {
    var imported: Boolean? = true
    var gone: List<OriginGone>? = emptyList()
    var gate: CompletableDeferred<Unit>? = null
    var runs = 0
    val resolved = mutableListOf<Pair<String, Boolean>>()

    override suspend fun imported(): Boolean? = imported

    override suspend fun run(): List<OriginGone>? {
        runs += 1
        gate?.await()
        return gone
    }

    override suspend fun resolve(gone: OriginGone, keep: Boolean) {
        resolved += gone.originId to keep
    }
}

private fun held(id: String, count: Int = 3, source: PhoneSource = PhoneSource.CONTACTS, reason: GoneReason = GoneReason.LEFT) =
    OriginGone(source, id, "account:$id", "Google $id", count, reason)

/** `PhoneFollower`: triggers in, one pass at a time, questions out (#1127), in virtual time. */
@OptIn(ExperimentalCoroutinesApi::class)
class PhoneFollowSpec : StringSpec({
    class Bench(val scope: TestScope) {
        val contacts = FakePass()
        val calendar = FakePass()
        val asked = mutableListOf<PhoneFollowQuestion>()
        val follower = PhoneFollower(
            scope = scope.backgroundScope,
            passes = mapOf(PhoneSource.CONTACTS to contacts, PhoneSource.CALENDAR to calendar),
            ask = { asked += it },
            now = { scope.testScheduler.currentTime },
        )

        suspend fun settle(ms: Long = 2_000) {
            scope.advanceTimeBy(ms)
            scope.runCurrent()
        }
    }

    "a source the member never imported is not followed, and the phone is not even read" {
        runTest {
            val bench = Bench(this)
            bench.contacts.imported = false
            bench.follower.requested(PhoneSource.CONTACTS)
            bench.settle(3_000)
            bench.contacts.runs shouldBe 0
        }
    }

    "a vault that cannot say whether it imported is not followed either" {
        runTest {
            val bench = Bench(this)
            bench.contacts.imported = null
            bench.follower.requested(PhoneSource.CONTACTS)
            bench.settle(3_000)
            bench.contacts.runs shouldBe 0
        }
    }

    "an imported source runs once the two seconds are up, not before" {
        runTest {
            val bench = Bench(this)
            bench.follower.requested(PhoneSource.CONTACTS)
            bench.settle(1_999)
            bench.contacts.runs shouldBe 0
            bench.settle(1)
            bench.contacts.runs shouldBe 1
        }
    }

    "a burst of triggers is one pass" {
        runTest {
            val bench = Bench(this)
            repeat(10) {
                bench.follower.requested(PhoneSource.CONTACTS)
                bench.settle(100)
            }
            bench.settle(3_000)
            bench.contacts.runs shouldBe 1
        }
    }

    "the queued pass starts at once when the pass in flight ends, and no third follows" {
        runTest {
            val bench = Bench(this)
            val first = CompletableDeferred<Unit>()
            bench.contacts.gate = first
            bench.follower.requested(PhoneSource.CONTACTS)
            bench.settle()
            repeat(4) { bench.follower.requested(PhoneSource.CONTACTS) }
            bench.contacts.gate = null
            first.complete(Unit)
            bench.settle(10)
            bench.contacts.runs shouldBe 2
            bench.settle(60_000)
            bench.contacts.runs shouldBe 2
        }
    }

    "a source whose run answers null (no access) asks nothing" {
        runTest {
            val bench = Bench(this)
            bench.calendar.gone = null
            bench.follower.requested(PhoneSource.CALENDAR)
            bench.settle()
            bench.calendar.runs shouldBe 1
            bench.asked.shouldBeEmpty()
        }
    }

    "a source the shell did not bring is not followed" {
        runTest {
            val follower = PhoneFollower(backgroundScope, emptyMap(), {}, { testScheduler.currentTime })
            follower.requested(PhoneSource.FILES)
            advanceTimeBy(5_000)
            runCurrent()
        }
    }

    "an origin held is asked once, however many passes hold it, with the copy's words" {
        runTest {
            val bench = Bench(this)
            bench.contacts.gone = listOf(held("o1", count = 4))
            repeat(3) {
                bench.follower.requested(PhoneSource.CONTACTS)
                bench.settle()
            }
            bench.contacts.runs shouldBe 3
            bench.asked.map { it.originId } shouldContainExactly listOf("o1")
            bench.asked.single().title shouldBe "Google o1 is no longer on this phone"
            bench.asked.single().body shouldBe "Keep its 4 people in People?"
            bench.asked.single().keepLabel shouldBe "Keep"
            bench.asked.single().trashLabel shouldBe "Move to trash"
        }
    }

    "questions come one at a time, the next after the answer to the last" {
        runTest {
            val bench = Bench(this)
            bench.contacts.gone = listOf(held("o1"), held("o2"))
            bench.follower.requested(PhoneSource.CONTACTS)
            bench.settle()
            bench.asked.map { it.originId } shouldContainExactly listOf("o1")
            bench.follower.answer("o1", keep = true)
            bench.scope.runCurrent()
            bench.contacts.resolved shouldContainExactly listOf("o1" to true)
            bench.asked.map { it.originId } shouldContainExactly listOf("o1", "o2")
            bench.follower.answer("o2", keep = false)
            bench.scope.runCurrent()
            bench.contacts.resolved shouldContainExactly listOf("o1" to true, "o2" to false)
        }
    }

    "an answer to a question that is not open is ignored, and a second tap is too" {
        runTest {
            val bench = Bench(this)
            bench.contacts.gone = listOf(held("o1"))
            bench.follower.answer("o1", keep = false)
            bench.follower.requested(PhoneSource.CONTACTS)
            bench.settle()
            bench.follower.answer("elsewhere", keep = false)
            bench.scope.runCurrent()
            bench.contacts.resolved.shouldBeEmpty()
            bench.follower.answer("o1", keep = true)
            bench.follower.answer("o1", keep = false)
            bench.scope.runCurrent()
            bench.contacts.resolved shouldContainExactly listOf("o1" to true)
        }
    }

    "the answer goes to the source the question came from" {
        runTest {
            val bench = Bench(this)
            bench.calendar.gone = listOf(held("c1", count = 1, source = PhoneSource.CALENDAR, reason = GoneReason.VANISHED))
            bench.follower.requested(PhoneSource.CALENDAR)
            bench.settle()
            bench.asked.single().title shouldBe "Most of Google c1 is missing from this phone"
            bench.asked.single().body shouldBe "Keep the 1 event missing from it in Agenda?"
            bench.follower.answer("c1", keep = false)
            bench.scope.runCurrent()
            bench.calendar.resolved shouldContainExactly listOf("c1" to false)
            bench.contacts.resolved.shouldBeEmpty()
        }
    }

    "a read that never answers is abandoned at the timeout, and one that answers is handed on" {
        runTest {
            var out: String? = "unset"
            val job = launch { out = PhoneFollowReads.await<String>(timeoutMs = 1_000) { /* never calls back */ } }
            advanceTimeBy(999)
            runCurrent()
            out shouldBe "unset"
            advanceTimeBy(2)
            runCurrent()
            job.join()
            out shouldBe null
            PhoneFollowReads.await<String> { done -> done("read") } shouldBe "read"
            PhoneFollowReads.await<String> { done -> done(null) } shouldBe null
        }
    }
})
