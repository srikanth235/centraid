package dev.centraid.shared

import dev.centraid.shared.sync.DrainAnswer
import dev.centraid.shared.sync.DrainClaim
import dev.centraid.shared.sync.DrainCopy
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain

/**
 * THE CLAIM A PASS'S ANSWER IS ALLOWED TO MAKE (#1029 W18-2, W18-3). The pass itself — the
 * try-lock, the refusal of a second pass, the next window on every path — is Rust's now
 * (`crates/screens/tests/passes_service.rs`); the words and the claim are the Backup screen's.
 *
 * This spec inherits the invariant `CustodyAndBackupClaimSpec` held over the
 * retired `URLSession` seam — **the UI never claims backup the gateway has not
 * acked** — and re-asserts it over the source that replaced it. The seam went
 * with its destination (the amendment's "Struck"); the invariant did not, which
 * is the whole reason this file exists in the same commit.
 */
class DrainPassSpec : StringSpec({

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
        deadline shouldBe "Still backing up. 3 MB to go."
        DrainCopy.stoppedSentence(DrainAnswer(0, DrainAnswer.Stopped.EMPTY)) shouldBe
            "Your backup device has everything that was ready."
        DrainCopy.stoppedSentence(DrainAnswer(99, DrainAnswer.Stopped.UNREACHABLE)) shouldBe
            "Backup device didn't answer. Will try again."
        // A MACHINE THAT IS NOT THE GATEWAY (#1080): it was sent nothing.
        DrainCopy.stoppedSentence(DrainAnswer(99, DrainAnswer.Stopped.UNTRUSTED)) shouldBe
            "That isn't your backup device. Nothing was sent."
        // A GATEWAY THAT ANSWERED AND REFUSED (#1080, the sweep's F1): its
        // disk is the member's to clear, so the sentence says so — and says
        // nothing was lost.
        DrainCopy.stoppedSentence(DrainAnswer(99, DrainAnswer.Stopped.REFUSED)) shouldBe
            "Your backup device refused the backup. It may be full. Nothing was lost."
        listOf(
            DrainCopy.stoppedSentence(DrainAnswer(99, DrainAnswer.Stopped.DEADLINE)),
            DrainCopy.stoppedSentence(DrainAnswer(99, DrainAnswer.Stopped.UNREACHABLE)),
            DrainCopy.stoppedSentence(DrainAnswer(0, DrainAnswer.Stopped.MOVED)),
            DrainCopy.stoppedSentence(DrainAnswer(0, DrainAnswer.Stopped.UNTRUSTED)),
            DrainCopy.stoppedSentence(DrainAnswer(99, DrainAnswer.Stopped.REFUSED)),
        ).forEach { it.contains("failed") shouldBe false }
    }

    "the two platform truths and the posture live with the pass, and say what #1080 made true" {
        // A SENTENCE SPELLED IN EACH SHELL is a sentence one shell gets wrong.
        // #1080 ruling 2 hands sealed parts to the OS, which uploads them while
        // the app is suspended; a force-quit cancels them and Low Power Mode
        // pauses them, and the copy says all three.
        DrainCopy.POSTURE_SENTENCE shouldContain "keeps uploading"
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
