package dev.centraid.shared

import dev.centraid.shared.custody.PhraseMachine
import dev.centraid.shared.platform.FakeSyncedSecrets
import dev.centraid.shared.platform.JvmSecureRandom
import dev.centraid.shared.platform.SyncedSecrets
import dev.centraid.shared.sync.BackupClaim
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

/**
 * THE UI INVARIANT, AND THE WORDS A MEMBER READS ABOUT THEIR KEY
 * (#1029 §3, §5, W5B-2/-3).
 *
 * Two promises this wave is where they are easiest to break:
 *
 * 1. **The phone never claims backup the gateway has not acknowledged.**
 * 2. **The two platforms' custody is not symmetric, and the copy says so.**
 *
 * Both are `commonMain`, so both run here — which is most of what a machine
 * with no Xcode and no Android SDK can prove about this lane.
 */
class CustodyAndBackupClaimSpec : StringSpec({

    "nothing is 'backed up' before the gateway has acknowledged a commit" {
        // A vault founded five minutes ago has no acknowledgement, and the
        // sentence says so without calling it a failure.
        BackupClaim.line(lastAckedAtMs = null, unacked = 0, relative = "just now") shouldBe
            BackupClaim.NEVER
        BackupClaim.isBackedUp(lastAckedAtMs = null, unacked = 0).shouldBeFalse()

        // AND NOT EVEN WITH AN EMPTY SPOOL. "No changes waiting" is not the
        // same claim as "the gateway has it", and collapsing the two is the
        // exact lie this object exists to prevent.
        withClue("an empty spool with no ack must not read as backed up") {
            BackupClaim.line(null, 0, "just now") shouldNotContain "Backed up"
        }
    }

    "an acknowledgement with changes behind it leads with what is NOT backed up" {
        val line = BackupClaim.line(lastAckedAtMs = 1_770_000_000_000, unacked = 3, "2 minutes ago")
        line shouldBe "3 changes not backed up. Records last backed up 2 minutes ago."
        // The member would be wrong about the unsent half, so the unsent half
        // is what the sentence opens with.
        line.startsWith("3 changes not backed up").shouldBeTrue()
        BackupClaim.isBackedUp(1_770_000_000_000, 3).shouldBeFalse()
    }

    "one change reads as one, because a member counts" {
        BackupClaim.line(1, 1, "an hour ago") shouldBe
            "1 change not backed up. Records last backed up an hour ago."
    }

    "an acknowledgement with an empty spool is the only thing that says backed up" {
        BackupClaim.line(1_770_000_000_000, 0, "2 minutes ago") shouldBe
            "Records backed up 2 minutes ago."
        BackupClaim.isBackedUp(1_770_000_000_000, 0).shouldBeTrue()
    }

    "a frozen vault says the changes are only here, and never that they are lost" {
        // F1 is freeze and show, never wipe. The sentence a member reads has to
        // match what the phone actually did with their rows.
        val line = BackupClaim.frozen(unacked = 4, since = "12 March")
        line shouldContain "moved to another phone"
        line shouldContain "4 changes since 12 March are only here"
        withClue("nothing here may suggest the changes were discarded") {
            line shouldNotContain "lost"
            line shouldNotContain "deleted"
        }
        BackupClaim.frozen(0, "12 March") shouldContain "Nothing is waiting here"
    }

    // ---------------------------------------------------------------- custody --

    "the phrase check asks three distinct positions, drawn from platform entropy" {
        val random = JvmSecureRandom()
        repeat(50) {
            val asked = PhraseMachine.positions { bound -> random.bytes(4).let { bytes ->
                // Four bytes folded into the bound, which is all this file needs
                // of a generator: the draw itself is `SecureRandom`'s.
                ((bytes[0].toInt() and 0xFF) shl 8 or (bytes[1].toInt() and 0xFF)) % bound
            } }
            asked shouldHaveSize PhraseMachine.POSITIONS_ASKED
            withClue("positions must be distinct, sorted and 1-based") {
                asked.toSet() shouldHaveSize PhraseMachine.POSITIONS_ASKED
                (asked == asked.sorted()).shouldBeTrue()
                asked.all { it in 1..PhraseMachine.WORDS }.shouldBeTrue()
            }
        }
    }

    "a draw that will not yield enough positions fills in rather than hanging" {
        // A setup screen that hung because entropy was uncooperative is worse
        // than one that asks 1, 2 and 3.
        val asked = PhraseMachine.positions { 0 }
        asked shouldBe listOf(1, 2, 3)
    }

    "the check is answered by the phrase and not by the screen above it" {
        val phrase = List(PhraseMachine.WORDS) { "word${it + 1}" }
        val machine = PhraseMachine(listOf(2, 9, 20)) { position, typed ->
            phrase[position - 1] == typed
        }
        machine.confirmed.shouldBeFalse()

        machine.answer(2, "word2").shouldBeTrue()
        machine.answer(9, "  WORD9 ").shouldBeTrue() // case and spaces forgiven
        machine.confirmed.shouldBeFalse()
        machine.answer(20, "word19").shouldBeFalse()
        machine.confirmed.shouldBeFalse()
        machine.verdict(20) shouldBe false

        machine.answer(20, "word20").shouldBeTrue()
        machine.confirmed.shouldBeTrue()
        machine.correct shouldBe 3

        machine.reset()
        machine.confirmed.shouldBeFalse()
        machine.verdict(2).shouldBeNull()
    }

    "an empty answer is never correct, however forgiving the check is" {
        val machine = PhraseMachine(listOf(1)) { _, _ -> true }
        machine.answer(1, "   ").shouldBeFalse()
    }

    "iOS and Android are told different things about their key, and Android is told the truth" {
        // THE ASYMMETRY IS THE POINT. Block Store restores only in the
        // device-setup flow, so on Android the written phrase is the common
        // path — and a member who learns that on the day they need it has
        // already lost.
        SyncedSecrets.ANDROID_SENTENCE shouldContain "during its setup"
        SyncedSecrets.ANDROID_SENTENCE shouldContain "you will need your 24 words"
        SyncedSecrets.IOS_SENTENCE shouldContain "iCloud Keychain"

        withClue("no custody sentence may promise a restore Android cannot do") {
            SyncedSecrets.ANDROID_SENTENCE shouldNotContain "automatically"
        }

        // The screen branches on the platform's own answer, not on a build flag:
        // a member with iCloud Keychain off is on iOS and is in Android's place.
        val off = SyncedSecrets.Availability(
            synchronizing = false,
            sentence = SyncedSecrets.IOS_OFF_SENTENCE,
            restoresAfterSetup = true,
        )
        PhraseMachine.custodySentence(off) shouldContain "only on this iPhone"
    }

    "a platform that will not synchronise holds no seed, and says so" {
        val secrets = FakeSyncedSecrets(
            availability = SyncedSecrets.Availability(
                synchronizing = false,
                sentence = SyncedSecrets.UNKNOWN_SENTENCE,
                restoresAfterSetup = false,
            ),
        )
        secrets.putSeed("00".repeat(64)).shouldBeFalse()
        secrets.seed().shouldBeNull()
        secrets.availability().sentence shouldContain "Write down your 24 words"
    }

    "the seed round-trips on a platform that does synchronise, and forgetting is complete" {
        val secrets = FakeSyncedSecrets()
        secrets.putSeed("ab".repeat(64)).shouldBeTrue()
        secrets.seed() shouldBe "ab".repeat(64)
        secrets.forgetSeed()
        secrets.seed().shouldBeNull()
    }
})
