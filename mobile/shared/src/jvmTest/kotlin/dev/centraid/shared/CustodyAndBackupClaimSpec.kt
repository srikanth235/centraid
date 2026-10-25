package dev.centraid.shared

import dev.centraid.shared.sync.BackupClaim
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

/**
 * THE UI INVARIANT (#1029 §3, §5, W5B-2): **the phone never claims backup the gateway
 * has not acknowledged.** (The words a member reads about where their key is kept are
 * Rust's: `crates/screens/src/custody/mod.rs` tests.)
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
        line shouldBe "3 changes not backed up. Last backup 2 minutes ago."
        // The member would be wrong about the unsent half, so the unsent half
        // is what the sentence opens with.
        line.startsWith("3 changes not backed up").shouldBeTrue()
        BackupClaim.isBackedUp(1_770_000_000_000, 3).shouldBeFalse()
    }

    "one change reads as one, because a member counts" {
        BackupClaim.line(1, 1, "an hour ago") shouldBe
            "1 change not backed up. Last backup an hour ago."
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
        line shouldContain "Moved to another phone"
        line shouldContain "4 changes since 12 March are only here"
        withClue("nothing here may suggest the changes were discarded") {
            line shouldNotContain "lost"
            line shouldNotContain "deleted"
        }
        BackupClaim.frozen(0, "12 March") shouldContain "Nothing unsent here"
    }
})
