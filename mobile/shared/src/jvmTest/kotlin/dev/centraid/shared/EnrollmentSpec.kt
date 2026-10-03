package dev.centraid.shared

import dev.centraid.shared.custody.Enrollment
import dev.centraid.shared.custody.PhraseDoor
import dev.centraid.shared.custody.PhraseVerdict
import dev.centraid.shared.custody.RestoreAnswer
import dev.centraid.shared.custody.RestoreDoor
import dev.centraid.shared.custody.RestoreRefusal
import dev.centraid.shared.custody.RestoreResult
import dev.centraid.shared.custody.RestoredVaultAt
import dev.centraid.shared.custody.UnclaimedVaultAt
import dev.centraid.shared.custody.VaultSecrets
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.shell.FoundResult
import dev.centraid.shared.shell.Shelf
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.types.shouldBeInstanceOf
import kotlinx.coroutines.test.runTest

/**
 * THE ORDER THE 24 WORDS ARE KEPT IN (#1047 E1, R-1047-E1…E5).
 *
 * A fake core stands behind the phrase and restore doors and a recording
 * keeper stands in for the shelf; the secure stores are the platform fakes.
 * What is asserted is ORDER and REFUSAL: what is stored before what is asked,
 * and what is never stored at all.
 */
class EnrollmentSpec : StringSpec({

    val seedA = "aa".repeat(64)
    val wordsA = List(24) { "alpha" }
    val wordsB = List(24) { "bravo" }

    class Phone {
        val services = FakePlatformServices()
        val secrets = VaultSecrets(services.secureStore, services.syncedSecrets)
        val log = mutableListOf<String>()
        var restoreAnswer: RestoreAnswer? = null

        /** What the door answers when [restoreAnswer] is null. */
        var refusal: RestoreRefusal = RestoreRefusal.UNREACHABLE

        private fun answered(): RestoreResult =
            restoreAnswer?.let { RestoreResult.Restored(it) } ?: RestoreResult.Refused(refusal)
        var indexed = 0

        val phrase = object : PhraseDoor {
            override suspend fun mint(): List<String> = List(24) { "minted" }
            override suspend fun check(words: List<String>): PhraseVerdict? = null
            override suspend fun seed(words: List<String>): String? = when (words.first()) {
                "alpha" -> "aa".repeat(64)
                "bravo" -> "bb".repeat(64)
                else -> null
            }
        }

        val restore = object : RestoreDoor {
            override suspend fun restore(words: List<String>, payload: String?): RestoreResult {
                log += "restore seed=${secrets.seed() != null}"
                return answered()
            }

            override suspend fun restoreSeed(seedHex: String, payload: String?): RestoreResult {
                log += "restore-seed ${seedHex.take(4)} payload=$payload"
                return answered()
            }

            override suspend fun restoreStayed(seedHex: String, payload: String?, indices: List<Int>): RestoreResult {
                log += "restore-stayed ${seedHex.take(4)} payload=$payload indices=$indices"
                return answered()
            }
        }

        val keeper = object : Enrollment.Keeper {
            override suspend fun found(): FoundResult {
                log += "found seed=${secrets.seed() != null} settled=${secrets.seedSettled()}"
                return FoundResult.Made("My vault")
            }

            override suspend fun adoptRestored(restored: List<Shelf.Restored>): Int {
                log += "adopt ${restored.map { it.index }} seed=${secrets.seed() != null}"
                return restored.size
            }

            override suspend fun rekey(): Int {
                log += "rekey seed=${secrets.seed() != null}"
                return indexed
            }

            override suspend fun indexedHoldings(): Int = indexed
        }

        val enrollment = Enrollment(secrets, phrase, restore, keeper)
    }

    // --- making a vault ------------------------------------------------------

    "no seed: the words are minted; kept words are stored and SETTLED before the vault is founded" {
        runTest {
            val phone = Phone()
            phone.enrollment.standing() shouldBe Enrollment.Standing.NO_SEED
            phone.enrollment.keep(wordsA).shouldBeNull()
            phone.secrets.seed() shouldBe seedA
            phone.secrets.seedSettled() shouldBe true
            phone.enrollment.make().shouldBeInstanceOf<FoundResult.Made>()
            phone.log shouldBe listOf("found seed=true settled=true")
        }
    }

    // --- the words kept for settings (Q-1047-19) ------------------------------

    "kept, restored and re-keyed words are kept on THIS phone for settings, never in the synchronised store" {
        runTest {
            val made = Phone()
            made.enrollment.keep(wordsA).shouldBeNull()
            made.secrets.words() shouldBe wordsA
            made.services.secureStore.read(VaultSecrets.LOCAL_WORDS) shouldBe wordsA.joinToString(" ")
            made.services.syncedSecrets.seed() shouldBe seedA

            val restored = Phone()
            restored.restoreAnswer = RestoreAnswer(vaults = listOf(RestoredVaultAt("/v/a/vault.db", 0)))
            restored.enrollment.restore(wordsA, null).shouldBeInstanceOf<Enrollment.Restored.Done>()
            restored.secrets.words() shouldBe wordsA

            val rekeyed = Phone()
            rekeyed.secrets.rememberVaultIndex("v-a", 0)
            rekeyed.indexed = 1
            rekeyed.enrollment.rekey(wordsA) shouldBe Enrollment.Rekeyed.Done(1)
            rekeyed.secrets.words() shouldBe wordsA
        }
    }

    "words that were refused, or a restore that brought nothing back, keep no words" {
        runTest {
            val phone = Phone()
            phone.enrollment.keep(List(24) { "nonsense" }) shouldBe Enrollment.Refusal.NOT_A_PHRASE
            phone.restoreAnswer = RestoreAnswer(vaults = emptyList())
            phone.enrollment.restore(wordsA, null) shouldBe Enrollment.Restored.NothingHeld
            phone.secrets.words().shouldBeNull()
        }
    }

    "a seed that arrived by sync has no words to show, and forgetting the seed forgets the words" {
        runTest {
            val synced = Phone()
            synced.services.syncedSecrets.putSeed(seedA)
            synced.secrets.words().shouldBeNull()

            val made = Phone()
            made.enrollment.keep(wordsA).shouldBeNull()
            made.secrets.forgetSeed()
            made.secrets.words().shouldBeNull()
        }
    }

    "a seed this phone settled makes the next vault without words; one that arrived by sync must restore first" {
        runTest {
            val settled = Phone()
            settled.secrets.rememberSeed(seedA)
            settled.secrets.settleSeed()
            settled.enrollment.standing() shouldBe Enrollment.Standing.SETTLED

            // THE SYNCED SEED: iCloud Keychain carried it here, and index 0 is
            // a vault the member already has on the laptop.
            val synced = Phone()
            synced.services.syncedSecrets.putSeed(seedA)
            synced.enrollment.standing() shouldBe Enrollment.Standing.UNSETTLED
        }
    }

    "words that are not a phrase store nothing" {
        runTest {
            val phone = Phone()
            phone.enrollment.keep(List(24) { "nonsense" }) shouldBe Enrollment.Refusal.NOT_A_PHRASE
            phone.secrets.seed().shouldBeNull()
            phone.secrets.seedSettled() shouldBe false
        }
    }

    // --- restoring -----------------------------------------------------------

    "a restore dials with NOTHING stored, then stores the seed before holding what came back" {
        runTest {
            val phone = Phone()
            phone.restoreAnswer = RestoreAnswer(
                vaults = listOf(RestoredVaultAt("/v/a/vault.db", 0, rows = 10), RestoredVaultAt("/v/b/vault.db", 2)),
            )
            val done = phone.enrollment.restore(wordsA, null).shouldBeInstanceOf<Enrollment.Restored.Done>()
            done.added shouldBe 2
            phone.log shouldBe listOf("restore seed=false", "adopt [0, 2] seed=true")
            phone.secrets.seed() shouldBe seedA
            phone.secrets.seedSettled() shouldBe true
            // A RESTORED VAULT'S PATH NEVER PRINTS: the answer's text is counts.
            done.answer.toString() shouldNotContain "/v/a/vault.db"
        }
    }

    "a restore that left a vault with the old phone holds only what it claimed, and carries the rest to the screen" {
        runTest {
            // R-1047-R5: the file of an unclaimed vault is gone and its lease is
            // the old phone's, so the shelf must not be told to hold it.
            val phone = Phone()
            phone.restoreAnswer = RestoreAnswer(
                vaults = listOf(RestoredVaultAt("/v/a/vault.db", 0)),
                unclaimed = listOf(UnclaimedVaultAt(index = 1, vaultId = "ef".repeat(32))),
            )
            val done = phone.enrollment.restore(wordsA, null).shouldBeInstanceOf<Enrollment.Restored.Done>()
            done.added shouldBe 1
            phone.log shouldBe listOf("restore seed=false", "adopt [0] seed=true")
            done.answer.unclaimed.map { it.index } shouldBe listOf(1)
        }
    }

    "a vault that stayed is asked for again by index from the seed already stored, and only what came back is held" {
        runTest {
            // R-1047-R6: the first restore stored the seed and held vault 0;
            // vault 1 stayed. The retry needs no words: the seed is here.
            val phone = Phone()
            phone.restoreAnswer = RestoreAnswer(
                vaults = listOf(RestoredVaultAt("/v/a/vault.db", 0)),
                unclaimed = listOf(UnclaimedVaultAt(index = 1, vaultId = "ef".repeat(32))),
            )
            phone.enrollment.restore(wordsA, null).shouldBeInstanceOf<Enrollment.Restored.Done>()
            phone.restoreAnswer = RestoreAnswer(
                vaults = listOf(RestoredVaultAt("/v/c/vault.db", 1)),
            )
            val again = phone.enrollment.restoreStayed(listOf(1), "ab")
                .shouldBeInstanceOf<Enrollment.Restored.Done>()
            again.added shouldBe 1
            phone.log.drop(2) shouldBe listOf(
                "restore-stayed aaaa payload=ab indices=[1]",
                "adopt [1] seed=true",
            )
            // STILL REFUSED, NOTHING HELD: the vaults already here are untouched.
            phone.restoreAnswer = null
            phone.refusal = RestoreRefusal.NOT_TAKEN
            phone.enrollment.restoreStayed(listOf(1), null) shouldBe Enrollment.Restored.NotTaken
            phone.log.last() shouldBe "restore-stayed aaaa payload=null indices=[1]"
            // NO SEED HERE, NO RETRY: nothing is dialled.
            val bare = Phone()
            bare.enrollment.restoreStayed(listOf(1), null) shouldBe Enrollment.Restored.Refused(Enrollment.Refusal.NOT_A_PHRASE)
            bare.log.shouldBeEmpty()
        }
    }

    "a synchronised seed restores with NO words: the seed rides the request and is settled once vaults came back" {
        runTest {
            val phone = Phone()
            phone.services.syncedSecrets.putSeed(seedA)
            phone.enrollment.standing() shouldBe Enrollment.Standing.UNSETTLED
            phone.restoreAnswer = RestoreAnswer(
                vaults = listOf(RestoredVaultAt("/v/a/vault.db", 0), RestoredVaultAt("/v/c/vault.db", 1)),
            )
            val done = phone.enrollment.restoreHeld("ab".repeat(32))
                .shouldBeInstanceOf<Enrollment.Restored.Done>()
            done.added shouldBe 2
            phone.log shouldBe listOf("restore-seed aaaa payload=${"ab".repeat(32)}", "adopt [0, 1] seed=true")
            phone.enrollment.standing() shouldBe Enrollment.Standing.SETTLED
            phone.secrets.words().shouldBeNull()
        }
    }

    "a held-seed restore with no seed, or one the laptop answered with nothing, settles nothing" {
        runTest {
            val none = Phone()
            none.enrollment.restoreHeld(null) shouldBe Enrollment.Restored.Refused(Enrollment.Refusal.NOT_A_PHRASE)
            none.log shouldBe emptyList()

            val empty = Phone()
            empty.services.syncedSecrets.putSeed(seedA)
            empty.restoreAnswer = RestoreAnswer(vaults = emptyList())
            empty.enrollment.restoreHeld(null) shouldBe Enrollment.Restored.NothingHeld
            empty.enrollment.standing() shouldBe Enrollment.Standing.UNSETTLED
        }
    }

    "a laptop that holds nothing, or does not answer, leaves this phone exactly as it was" {
        runTest {
            val phone = Phone()
            phone.restoreAnswer = RestoreAnswer(vaults = emptyList())
            phone.enrollment.restore(wordsA, null) shouldBe Enrollment.Restored.NothingHeld
            phone.restoreAnswer = null
            phone.enrollment.restore(wordsA, null) shouldBe Enrollment.Restored.Unreachable
            phone.secrets.seed().shouldBeNull()
        }
    }

    "a laptop that refused the lease, or a backup this phone would not accept, is its own outcome and stores nothing" {
        runTest {
            val phone = Phone()
            phone.refusal = RestoreRefusal.NOT_TAKEN
            phone.enrollment.restore(wordsA, null) shouldBe Enrollment.Restored.NotTaken
            phone.refusal = RestoreRefusal.DID_NOT_CHECK
            phone.enrollment.restore(wordsA, null) shouldBe Enrollment.Restored.DidNotCheck
            phone.secrets.seed().shouldBeNull()
            phone.secrets.words().shouldBeNull()

            val held = Phone()
            held.services.syncedSecrets.putSeed(seedA)
            held.refusal = RestoreRefusal.DID_NOT_CHECK
            held.enrollment.restoreHeld(null) shouldBe Enrollment.Restored.DidNotCheck
            held.enrollment.standing() shouldBe Enrollment.Standing.UNSETTLED
        }
    }

    "different words are refused, before the laptop is asked, on a phone whose vaults open with its own" {
        runTest {
            val phone = Phone()
            phone.secrets.rememberSeed(seedA)
            phone.secrets.rememberVaultIndex("v-a", 0)
            phone.enrollment.restore(wordsB, null) shouldBe
                Enrollment.Restored.Refused(Enrollment.Refusal.DIFFERENT_WORDS)
            phone.enrollment.rekey(wordsB) shouldBe Enrollment.Rekeyed.Refused(Enrollment.Refusal.DIFFERENT_WORDS)
            phone.log shouldBe emptyList()
            phone.secrets.seed() shouldBe seedA
        }
    }

    // --- re-keying -----------------------------------------------------------

    "re-keying stores the seed and reopens the vaults that have an index" {
        runTest {
            val phone = Phone()
            phone.secrets.rememberVaultIndex("v-a", 3)
            phone.indexed = 1
            phone.enrollment.rekey(wordsA) shouldBe Enrollment.Rekeyed.Done(1)
            phone.secrets.seed() shouldBe seedA
            phone.log shouldBe listOf("rekey seed=true")
        }
    }

    "re-keying a phone with no recorded index stores NOTHING and says only a restore can key it" {
        runTest {
            val phone = Phone()
            phone.enrollment.rekey(wordsA) shouldBe Enrollment.Rekeyed.NoneToKey
            phone.secrets.seed().shouldBeNull()
            phone.log shouldBe emptyList()
        }
    }

    "the same words handed back again are not a conflict" {
        runTest {
            val phone = Phone()
            phone.secrets.rememberSeed(seedA)
            phone.secrets.rememberVaultIndex("v-a", 0)
            phone.indexed = 1
            phone.enrollment.rekey(wordsA) shouldBe Enrollment.Rekeyed.Done(1)
            phone.secrets.seed() shouldBe seedA
        }
    }
})
