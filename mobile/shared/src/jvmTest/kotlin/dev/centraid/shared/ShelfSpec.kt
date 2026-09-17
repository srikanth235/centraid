package dev.centraid.shared

import centraid.screen.v1.VaultLockup
import dev.centraid.core.CentraidCore
import dev.centraid.shared.shell.Shelf
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.Dispatchers

/**
 * A VAULT'S STATE IS DERIVED, NEVER STORED (#1025 S7-9), AND ON A PHONE THAT IS
 * THE VAULT THERE IS ONE OF THEM (#1029 §1).
 *
 * ## What this spec used to assert, and why that subject is gone
 *
 * `Shelf.Holding.state` was a function of the last `SyncOutcome` and whether a
 * pass was in flight, read in a fixed order — a pass in flight is SYNCING, a
 * just-recorded unreachable is OFFLINE even over a marked tail (R-SHELL-1), a
 * tail over a reachable last pass is ONLINE, a bootstrap mid-copy is SYNCING,
 * and otherwise the last pass decides. Eleven cases, one per branch, because
 * the ORDER was the whole definition.
 *
 * Every input to that table was a fact about a GATEWAY: the pass, the tail, the
 * bootstrap, reachability. #1029 deletes all four — `grep -rn
 * 'SyncOutcome|tailing|passInFlight' mobile/ --include=*.kt` is empty — so the
 * branches are not failing, they have nothing to branch on. These are cases
 * whose subject is gone.
 *
 * ## What is left, and why it is still worth pinning
 *
 * The derivation itself: a vault this device holds is a file that opened, and
 * the state is the one value of the three whose wording is a past-tense fact.
 * It is worth a test for one reason — **`STATE_UNSPECIFIED` must never reach a
 * lockup.** Its own proto comment says a shell that receives it "is looking at
 * a lockup nobody filled in", and a `Holding` built with defaults is exactly
 * the shape that used to produce one.
 */
class ShelfSpec : StringSpec({

    // A CORE WITH NO ABI AND NO FILE. `CentraidCore.answering` exists for
    // exactly this: a distinct handle identity without the FFI. Nothing here
    // calls it; what the derivation reads is whether there is one.
    fun open() = CentraidCore.answering(Dispatchers.Unconfined) { it }

    fun holding(core: CentraidCore? = open()) = Shelf.Holding(
        vaultId = "v1",
        path = "/vaults/centraid-vault-0a1b.sqlite3",
        name = "Tahoe Demo",
        color = "#336699",
        core = core,
    )

    "a vault this device holds is synced, because it is here" {
        holding().state shouldBe VaultLockup.State.STATE_ONLINE
    }

    "a resting holding is not a degraded one" {
        // `rest()` closes a background core to give the OS its memory back.
        // The file is whole and nothing about the vault changed, so a member
        // switching to it must not first read a state that says otherwise.
        val resting = holding(core = null)
        resting.resting shouldBe true
        resting.state shouldBe VaultLockup.State.STATE_ONLINE
    }

    "the lockup a switcher row draws is never the unfilled one" {
        val lockup = holding().lockup()
        lockup.state shouldBe VaultLockup.State.STATE_ONLINE
        lockup.vault_id shouldBe "v1"
        lockup.vault_name shouldBe "Tahoe Demo"
        lockup.color shouldBe "#336699"
        // NOTHING WITHHOLDS ORIGINALS FROM ITSELF (#1029 §1). The field carried
        // the last pass's `withheld` — originals a transfer rule held back on a
        // metered link — and the originals are on the device that took them.
        lockup.originals_withheld shouldBe 0
    }
})
