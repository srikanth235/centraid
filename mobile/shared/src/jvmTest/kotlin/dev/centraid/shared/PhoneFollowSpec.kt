package dev.centraid.shared

import dev.centraid.shared.shell.CalendarRead
import dev.centraid.shared.shell.ContactsRead
import dev.centraid.shared.shell.FollowOutcome
import dev.centraid.shared.shell.FollowVault
import dev.centraid.shared.shell.PhoneFollowQuestion
import dev.centraid.shared.shell.PhoneFollower
import dev.centraid.shared.shell.PhoneFollowShell
import dev.centraid.shared.shell.PhoneRead
import dev.centraid.shared.sync.phone.GoneReason
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneSource
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

/** A vault that answers what a spec tells it and records what the follower asked. */
private class FakeVault : FollowVault {
    var imported: Map<PhoneSource, Boolean?> = emptyMap()
    var gone: List<OriginGone> = emptyList()
    val syncs = mutableListOf<PhoneRead>()
    val resolved = mutableListOf<Pair<String, Boolean>>()

    override suspend fun imported(source: PhoneSource): Boolean? = imported[source]

    override suspend fun sync(read: PhoneRead): FollowOutcome? {
        syncs += read
        return FollowOutcome(gone)
    }

    override suspend fun resolve(gone: OriginGone, keep: Boolean) {
        resolved += gone.originId to keep
    }
}

/** A shell whose reads answer when a spec says so; `null` is access not granted. */
private class FakeShell : PhoneFollowShell {
    var contacts: ContactsRead? = ContactsRead(emptyList(), emptyList(), complete = true)
    var calendar: CalendarRead? = CalendarRead(emptyList(), emptyList(), complete = true, deviceTz = "UTC", now = 0)
    var hang = false
    var reads = 0
    val asked = mutableListOf<PhoneFollowQuestion>()

    override fun readContacts(done: (ContactsRead?) -> Unit) {
        reads += 1
        if (!hang) done(contacts)
    }

    override fun readCalendar(done: (CalendarRead?) -> Unit) {
        reads += 1
        if (!hang) done(calendar)
    }

    override fun ask(question: PhoneFollowQuestion) {
        asked += question
    }
}

private fun held(id: String, count: Int = 3, source: PhoneSource = PhoneSource.CONTACTS, reason: GoneReason = GoneReason.LEFT) =
    OriginGone(source, id, "account:$id", "Google $id", count, reason)

/** `PhoneFollower`: triggers in, one pass at a time, questions out (#1127), in virtual time. */
@OptIn(ExperimentalCoroutinesApi::class)
class PhoneFollowSpec : StringSpec({
    fun TestScope.followerOf(vault: FakeVault, shell: FakeShell) =
        PhoneFollower(backgroundScope, vault, shell, now = { testScheduler.currentTime })

    "a source the member never imported is not followed, and the phone is not even read" {
        runTest {
            val vault = FakeVault()
            val shell = FakeShell()
            val follower = followerOf(vault, shell)
            follower.requested(PhoneSource.CONTACTS)
            advanceTimeBy(3_000)
            runCurrent()
            shell.reads shouldBe 0
            vault.syncs.shouldBeEmpty()
        }
    }

    "a vault that cannot say whether it imported is not followed either" {
        runTest {
            val vault = FakeVault().apply { imported = mapOf(PhoneSource.CONTACTS to null) }
            val shell = FakeShell()
            followerOf(vault, shell).requested(PhoneSource.CONTACTS)
            advanceTimeBy(3_000)
            runCurrent()
            shell.reads shouldBe 0
        }
    }

    "an imported source is read and synced once the two seconds are up, not before" {
        runTest {
            val vault = FakeVault().apply { imported = mapOf(PhoneSource.CONTACTS to true) }
            val shell = FakeShell()
            followerOf(vault, shell).requested(PhoneSource.CONTACTS)
            advanceTimeBy(1_999)
            runCurrent()
            vault.syncs.shouldBeEmpty()
            advanceTimeBy(1)
            runCurrent()
            vault.syncs.size shouldBe 1
            vault.syncs.single().shouldBeInstanceOfContacts()
        }
    }

    "a burst of triggers is one pass" {
        runTest {
            val vault = FakeVault().apply { imported = mapOf(PhoneSource.CONTACTS to true) }
            val shell = FakeShell()
            val follower = followerOf(vault, shell)
            repeat(10) {
                follower.requested(PhoneSource.CONTACTS)
                advanceTimeBy(100)
            }
            advanceTimeBy(3_000)
            runCurrent()
            vault.syncs.size shouldBe 1
        }
    }

    "a trigger during a pass queues exactly one more" {
        runTest {
            val vault = FakeVault().apply { imported = mapOf(PhoneSource.CONTACTS to true) }
            val shell = FakeShell().apply { hang = true }
            val follower = followerOf(vault, shell)
            follower.requested(PhoneSource.CONTACTS)
            advanceTimeBy(2_000)
            runCurrent()
            shell.reads shouldBe 1
            repeat(4) { follower.requested(PhoneSource.CONTACTS) }
            advanceTimeBy(60_000)
            runCurrent()
            // The first read never answers; nothing else may start while it is out.
            shell.reads shouldBe 1
            advanceTimeBy(60_000)
            runCurrent()
            // It is abandoned at the timeout, and the one queued pass reads.
            shell.reads shouldBe 2
        }
    }

    "the shell saying no access ends the pass without touching the vault" {
        runTest {
            val vault = FakeVault().apply { imported = mapOf(PhoneSource.CALENDAR to true) }
            val shell = FakeShell().apply { calendar = null }
            followerOf(vault, shell).requested(PhoneSource.CALENDAR)
            advanceTimeBy(2_000)
            runCurrent()
            shell.reads shouldBe 1
            vault.syncs.shouldBeEmpty()
        }
    }

    "an origin held is asked once, however many passes hold it, with the copy's words" {
        runTest {
            val vault = FakeVault().apply {
                imported = mapOf(PhoneSource.CONTACTS to true)
                gone = listOf(held("o1", count = 4))
            }
            val shell = FakeShell()
            val follower = followerOf(vault, shell)
            repeat(3) {
                follower.requested(PhoneSource.CONTACTS)
                advanceTimeBy(2_000)
                runCurrent()
            }
            vault.syncs.size shouldBe 3
            shell.asked.map { it.originId } shouldContainExactly listOf("o1")
            shell.asked.single().title shouldBe "Google o1 is no longer on this phone"
            shell.asked.single().body shouldBe "Keep its 4 people in People?"
            shell.asked.single().keepLabel shouldBe "Keep"
            shell.asked.single().trashLabel shouldBe "Move to trash"
        }
    }

    "questions come one at a time, the next after the answer to the last" {
        runTest {
            val vault = FakeVault().apply {
                imported = mapOf(PhoneSource.CONTACTS to true)
                gone = listOf(held("o1"), held("o2"))
            }
            val shell = FakeShell()
            val follower = followerOf(vault, shell)
            follower.requested(PhoneSource.CONTACTS)
            advanceTimeBy(2_000)
            runCurrent()
            shell.asked.map { it.originId } shouldContainExactly listOf("o1")
            follower.answer("o1", keep = true)
            runCurrent()
            vault.resolved shouldContainExactly listOf("o1" to true)
            shell.asked.map { it.originId } shouldContainExactly listOf("o1", "o2")
            follower.answer("o2", keep = false)
            runCurrent()
            vault.resolved shouldContainExactly listOf("o1" to true, "o2" to false)
        }
    }

    "an answer to a question that is not open is ignored" {
        runTest {
            val vault = FakeVault().apply {
                imported = mapOf(PhoneSource.CONTACTS to true)
                gone = listOf(held("o1"))
            }
            val shell = FakeShell()
            val follower = followerOf(vault, shell)
            follower.answer("o1", keep = false)
            follower.requested(PhoneSource.CONTACTS)
            advanceTimeBy(2_000)
            runCurrent()
            follower.answer("elsewhere", keep = false)
            runCurrent()
            vault.resolved.shouldBeEmpty()
            follower.answer("o1", keep = true)
            follower.answer("o1", keep = false)
            runCurrent()
            vault.resolved shouldContainExactly listOf("o1" to true)
        }
    }

    "a calendar question speaks of events and Agenda, and a vanished origin says so" {
        runTest {
            val vault = FakeVault().apply {
                imported = mapOf(PhoneSource.CALENDAR to true)
                gone = listOf(held("c1", count = 1, source = PhoneSource.CALENDAR, reason = GoneReason.VANISHED))
            }
            val shell = FakeShell()
            followerOf(vault, shell).requested(PhoneSource.CALENDAR)
            advanceTimeBy(2_000)
            runCurrent()
            shell.asked.single().title shouldBe "Most of Google c1 is missing from this phone"
            shell.asked.single().body shouldBe "Keep the 1 event missing from it in Agenda?"
        }
    }
})

private fun PhoneRead.shouldBeInstanceOfContacts() {
    (this is PhoneRead.Contacts) shouldBe true
}
