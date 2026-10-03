package dev.centraid.shared

import dev.centraid.shared.sync.DrainAnswer
import dev.centraid.shared.sync.DrainClaim
import dev.centraid.shared.sync.DrainCopy
import dev.centraid.shared.sync.DrainDoor
import dev.centraid.shared.sync.DrainInput
import dev.centraid.shared.sync.DrainPass
import dev.centraid.shared.sync.TransferRule
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

    fun door(answer: DrainAnswer?) = DrainDoor { answer }

    fun input(deadlineMs: Long = 25_000) = DrainInput(
        deadlineMs = deadlineMs,
        rule = TransferRule.WIFI_ONLY,
        includeVideos = true,
        metered = false,
        charging = true,
        wantsSnapshot = false,
    )

    "a pass answers what the core answered, and nothing it worked out itself" {
        runTest {
            val answer = DrainAnswer(
                pendingBytes = 0,
                stopped = DrainAnswer.Stopped.EMPTY,
                ackedAtMs = 1_700_000_000_000,
                confirmedParts = 41,
            )
            val outcome = DrainPass(door(answer)).run(input())
            outcome shouldBe DrainPass.Outcome.Ran(answer)
        }
    }

    "the pass hands the core exactly the input it was given" {
        runTest {
            // THE RULE CROSSES (#1080): a pass that dropped it would be the core
            // planning a member's bill under a rule the member never chose.
            val seen = mutableListOf<DrainInput>()
            val asked = input(deadlineMs = 9_000).copy(
                rule = TransferRule.WIFI_AND_CELLULAR_PHOTOS,
                includeVideos = false,
                metered = true,
                charging = false,
                wantsSnapshot = true,
            )
            DrainPass(DrainDoor { seen += it; null }).run(asked)
            seen shouldBe listOf(asked)
        }
    }

    "no core to ask is not a failure and is not a sentence" {
        runTest {
            DrainPass(door(null)).run(input()) shouldBe DrainPass.Outcome.Unavailable
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
            val slow = DrainDoor {
                calls.incrementAndGet()
                entered.complete(Unit)
                release.await()
                DrainAnswer(0, DrainAnswer.Stopped.EMPTY, ackedAtMs = 1)
            }
            val pass = DrainPass(slow)
            coroutineScope {
                val first = async { pass.run(input(60_000)) }
                entered.await()
                pass.busy shouldBe true
                pass.run(input(60_000)) shouldBe DrainPass.Outcome.Busy
                release.complete(Unit)
                first.await()
            }
            pass.busy shouldBe false
            calls.get() shouldBe 1
        }
    }

    "the next window is asked for on every path, including one that stopped short" {
        runTest {
            // A `BGTaskRequest` IS ONE-SHOT. A pass that only resubmitted when it
            // emptied the spool would run once in the life of an install, which
            // reads to a member as "it worked the first day".
            val asked = AtomicInteger(0)
            val unreachable = DrainAnswer(900, DrainAnswer.Stopped.UNREACHABLE)
            DrainPass(door(unreachable)) { asked.incrementAndGet() }.run(input())
            DrainPass(door(null)) { asked.incrementAndGet() }.run(input())
            asked.get() shouldBe 2
        }
    }

    "the claim is never 'backed up' without an acknowledgement" {
        // THE UMBRELLA'S UI INVARIANT. Everything below has run a pass; only the
        // one the laptop acknowledged may use the word.
        DrainClaim.isBackedUp(
            DrainAnswer(0, DrainAnswer.Stopped.EMPTY, ackedAtMs = null),
        ) shouldBe false
        DrainClaim.isBackedUp(
            DrainAnswer(0, DrainAnswer.Stopped.EMPTY, ackedAtMs = 1_700_000_000_000),
        ) shouldBe true
    }

    "an acknowledged vault with bytes still in the spool is BEHIND, not backed up" {
        val behind = DrainAnswer(
            pendingBytes = 4_096,
            stopped = DrainAnswer.Stopped.DEADLINE,
            ackedAtMs = 1_700_000_000_000,
        )
        DrainClaim.isBackedUp(behind) shouldBe false
        DrainClaim.line(behind, unacked = 3, relative = "2 minutes ago") shouldContain
            "3 changes not backed up"
    }

    "each stopped reason has its own sentence, and neither of the two ordinary ones is an error" {
        // A FIRST CAMERA-ROLL BACKUP ENDS ON A DEADLINE EVERY TIME. A phone that
        // called that a failure would train a member to distrust a product that
        // is working — and an unreachable laptop lost nothing, so neither
        // sentence may read as "backup failed". These are W15's own words.
        val deadline = DrainCopy.stoppedSentence(
            DrainAnswer(3_200_000, DrainAnswer.Stopped.DEADLINE),
        )
        deadline shouldBe "Still backing up — 3 MB to go. It will finish on its own."
        DrainCopy.stoppedSentence(DrainAnswer(0, DrainAnswer.Stopped.EMPTY)) shouldBe
            "Your laptop has everything this phone had ready to send."
        DrainCopy.stoppedSentence(DrainAnswer(99, DrainAnswer.Stopped.UNREACHABLE)) shouldBe
            "Your laptop didn't answer. Nothing was lost; we'll pick up where we left off."
        listOf(
            DrainCopy.stoppedSentence(DrainAnswer(99, DrainAnswer.Stopped.DEADLINE)),
            DrainCopy.stoppedSentence(DrainAnswer(99, DrainAnswer.Stopped.UNREACHABLE)),
            DrainCopy.stoppedSentence(DrainAnswer(0, DrainAnswer.Stopped.MOVED)),
        ).forEach { it.contains("failed") shouldBe false }
    }

    "the two platform truths and the posture live with the pass, and say what #1080 made true" {
        // A SENTENCE SPELLED IN EACH SHELL is a sentence one shell gets wrong.
        // #1080 ruling 2 hands sealed parts to the OS, which uploads them while
        // the app is suspended; a force-quit cancels them and Low Power Mode
        // pauses them, and the copy says all three.
        DrainCopy.POSTURE_SENTENCE shouldContain "goes on uploading"
        DrainCopy.FORCE_QUIT_SENTENCE shouldContain "swipe Centraid away"
        DrainCopy.FORCE_QUIT_SENTENCE shouldContain "cancels those uploads until you open it again"
        DrainCopy.FORCE_QUIT_SENTENCE shouldContain "Low Power Mode pauses them"
        DrainCopy.ANDROID_UNMETERED_SENTENCE shouldContain "your setting"
        // THE v0 POSTURE IS GONE: it promised nothing moved while the app was
        // closed, which the background mover makes false.
        DrainCopy.POSTURE_SENTENCE.contains("does not upload while the app is closed") shouldBe false
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
