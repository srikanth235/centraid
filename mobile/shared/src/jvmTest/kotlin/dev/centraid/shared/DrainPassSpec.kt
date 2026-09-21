package dev.centraid.shared

import dev.centraid.shared.sync.DrainAnswer
import dev.centraid.shared.sync.DrainClaim
import dev.centraid.shared.sync.DrainCopy
import dev.centraid.shared.sync.DrainDoor
import dev.centraid.shared.sync.DrainPass
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.test.runTest
import java.util.concurrent.atomic.AtomicInteger

/**
 * THE PASS, AND THE CLAIM IT IS ALLOWED TO MAKE (#1029 W18-2, W18-3).
 *
 * This spec inherits the invariant `CustodyAndBackupClaimSpec` held over the
 * retired `URLSession` seam — **the UI never claims backup the gateway has not
 * acked** — and re-asserts it over the source that replaced it. The seam went
 * with its destination (the amendment's "Struck"); the invariant did not, which
 * is the whole reason this file exists in the same commit.
 */
class DrainPassSpec : StringSpec({

    fun door(answer: DrainAnswer?) = object : DrainDoor {
        override suspend fun drain(deadlineMs: Long): DrainAnswer? = answer
    }

    "a pass answers what the core answered, and nothing it worked out itself" {
        runTest {
            val answer = DrainAnswer(
                ackedTxid = 41,
                pendingBytes = 0,
                stopped = DrainAnswer.Stopped.EMPTY,
                lastAckedAtMs = 1_700_000_000_000,
            )
            val outcome = DrainPass(door(answer)).run(deadlineMs = 25_000)
            outcome shouldBe DrainPass.Outcome.Ran(answer)
        }
    }

    "no core to ask is not a failure and is not a sentence" {
        runTest {
            DrainPass(door(null)).run(deadlineMs = 25_000) shouldBe DrainPass.Outcome.Unavailable
        }
    }

    "a second pass while one runs is REFUSED, and the door is called once" {
        runTest {
            // BOTH TRIGGERS FIRE TOGETHER ALL THE TIME: the app becomes active
            // while a background window is still draining. A queued second pass
            // would spend a member's data twice for no new bytes.
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val calls = AtomicInteger(0)
            val slow = object : DrainDoor {
                override suspend fun drain(deadlineMs: Long): DrainAnswer {
                    calls.incrementAndGet()
                    entered.complete(Unit)
                    release.await()
                    return DrainAnswer(1, 0, DrainAnswer.Stopped.EMPTY, lastAckedAtMs = 1)
                }
            }
            val pass = DrainPass(slow)
            coroutineScope {
                val first = async { pass.run(deadlineMs = 60_000) }
                entered.await()
                pass.run(deadlineMs = 60_000) shouldBe DrainPass.Outcome.Busy
                release.complete(Unit)
                first.await()
            }
            calls.get() shouldBe 1
        }
    }

    "the next window is asked for on every path, including one that stopped short" {
        runTest {
            // A `BGTaskRequest` IS ONE-SHOT. A pass that only resubmitted when it
            // emptied the spool would run once in the life of an install, which
            // reads to a member as "it worked the first day".
            val asked = AtomicInteger(0)
            val unreachable = DrainAnswer(0, 900, DrainAnswer.Stopped.UNREACHABLE)
            DrainPass(door(unreachable)) { asked.incrementAndGet() }
                .run(deadlineMs = 25_000)
            DrainPass(door(null)) { asked.incrementAndGet() }.run(deadlineMs = 25_000)
            asked.get() shouldBe 2
        }
    }

    "the claim is never 'backed up' without an acknowledgement" {
        // THE UMBRELLA'S UI INVARIANT. Everything below has run a pass; only the
        // one the laptop acknowledged may use the word.
        DrainClaim.isBackedUp(
            DrainAnswer(0, 0, DrainAnswer.Stopped.EMPTY, lastAckedAtMs = null),
        ) shouldBe false
        DrainClaim.isBackedUp(
            DrainAnswer(9, 0, DrainAnswer.Stopped.EMPTY, lastAckedAtMs = 1_700_000_000_000),
        ) shouldBe true
    }

    "an acknowledged vault with bytes still in the spool is BEHIND, not backed up" {
        val behind = DrainAnswer(
            ackedTxid = 9,
            pendingBytes = 4_096,
            stopped = DrainAnswer.Stopped.DEADLINE,
            lastAckedAtMs = 1_700_000_000_000,
        )
        DrainClaim.isBackedUp(behind) shouldBe false
        DrainClaim.line(behind, unacked = 3, relative = "2 minutes ago") shouldContain
            "3 changes not backed up"
    }

    "each stopped reason has its own sentence and a deadline is not an error" {
        // A FIRST CAMERA-ROLL BACKUP ENDS ON A DEADLINE EVERY TIME. A phone that
        // called that a failure would train a member to distrust a product that
        // is working.
        val deadline = DrainCopy.stoppedSentence(DrainAnswer(1, 99, DrainAnswer.Stopped.DEADLINE))
        deadline shouldContain "Still backing up"
        DrainCopy.stoppedSentence(DrainAnswer(1, 0, DrainAnswer.Stopped.EMPTY)) shouldContain
            "on your laptop"
        DrainCopy.stoppedSentence(DrainAnswer(0, 99, DrainAnswer.Stopped.UNREACHABLE)) shouldContain
            "did not answer"
    }

    "the two platform truths and the amendment's posture live with the pass" {
        // THEY MOVED HERE FROM `BackgroundTransfers` WITH THE PASS, because a
        // sentence spelled in each shell is a sentence one shell gets wrong.
        DrainCopy.FORCE_QUIT_SENTENCE shouldContain "swipe Centraid away"
        DrainCopy.FORCE_QUIT_SENTENCE shouldContain "until you open it again"
        DrainCopy.ANDROID_UNMETERED_SENTENCE shouldContain "Downloads setting"
        // THE AMENDMENT'S OWN COMPARISON. "This is the iCloud Backup posture and
        // the copy says so."
        DrainCopy.POSTURE_SENTENCE shouldContain "iCloud Backup"
        DrainCopy.POSTURE_SENTENCE shouldContain "does not upload while the app is closed"
    }

    "the old promise that uploads survive the app is gone from the copy" {
        // THE `URLSession` SENTENCE SAID "Uploads keep going if iOS closes the
        // app itself", which was true of a system-owned background session and
        // is false of a drain that runs inside this process. A sentence that
        // outlived its mechanism is the failure this assertion exists for.
        listOf(
            DrainCopy.POSTURE_SENTENCE,
            DrainCopy.FORCE_QUIT_SENTENCE,
            DrainCopy.ANDROID_UNMETERED_SENTENCE,
        ).forEach { it.contains("keep going if iOS closes") shouldBe false }
    }
})
