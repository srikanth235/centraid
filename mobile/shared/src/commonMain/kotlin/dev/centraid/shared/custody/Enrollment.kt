package dev.centraid.shared.custody

import dev.centraid.shared.platform.PlatformServices
import dev.centraid.shared.shell.FoundResult
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.shell.Shelf

/**
 * THE ORDER THE 24 WORDS ARE KEPT IN (#1047 E1, `docs/decisions.md`
 * R-1047-E1…E5).
 *
 * Three flows put a seed on this phone, and each has one order that is right
 * and several that lose a member's vaults. They are here, in one class the
 * specs drive, rather than in the machines that draw them:
 *
 * * **Making a vault** ([keep], then [make]): the words are minted, shown once
 *   and checked, THEN their seed is stored and settled, THEN the vault is
 *   founded at the next index — keyed from its first commit. An unchecked
 *   phrase never roots a vault, and a crash between the store and the found
 *   leaves a phone that makes its vault from the same words next time without
 *   minting new ones.
 * * **Restoring** ([restore]): the words are judged and seeded BEFORE the
 *   laptop is dialled; a phone already holding different words for vaults it
 *   keys is refused; the seed is stored only once the laptop brought something
 *   back; then each vault is held under the id its own file names, at the
 *   index the restore found it at, with the device secret the restore minted.
 * * **Re-keying** ([rekey], Locker's wall): the words are seeded, checked
 *   against any seed already here, stored, and every vault with a recorded
 *   index is reopened keyed. No laptop; and no index is ever guessed.
 * * **Restoring from the seed this phone already holds** ([restoreHeld],
 *   Q-1047-18): a seed that arrived through the synchronised keychain, with no
 *   words and no record of its indices, restores exactly what its words would.
 *   Nothing new is stored; the seed is settled once the laptop brought
 *   something back.
 *
 * **The words are kept beside the seed** (Q-1047-19): whenever this phone
 * stores a seed from words — made, restored or re-keyed — it keeps the words
 * in the device-only store too, so settings can show them again
 * ([VaultSecrets.rememberWords]). Nothing here holds them past the call.
 */
public class Enrollment(
    private val secrets: VaultSecrets,
    private val phrase: PhraseDoor,
    private val restoreDoor: RestoreDoor,
    private val keeper: Keeper,
) {
    /** The shelf's half: founding, holding what a restore laid down, re-keying. */
    public interface Keeper {
        public suspend fun found(): FoundResult

        public suspend fun adoptRestored(restored: List<Shelf.Restored>, deviceSecretHex: String): Int

        public suspend fun rekey(): Int

        public suspend fun indexedHoldings(): Int
    }

    /** What this phone holds before the make-vault flow starts. */
    public enum class Standing {
        /** No seed: mint the words. */
        NO_SEED,

        /** A seed this phone may make vaults from: no words, the next index. */
        SETTLED,

        /** A seed that arrived from elsewhere, with no record of its indices: restore first. */
        UNSETTLED,
    }

    public suspend fun standing(): Standing = when {
        secrets.seed() == null -> Standing.NO_SEED
        secrets.seedSettled() -> Standing.SETTLED
        else -> Standing.UNSETTLED
    }

    /** 24 fresh words from the core, or null. */
    public suspend fun mint(): List<String>? = phrase.mint()

    /** Why words were not kept. */
    public enum class Refusal { NOT_A_PHRASE, DIFFERENT_WORDS, STORE_REFUSED }

    /**
     * STORE [words]' SEED AND SETTLE IT — after the check, before the found.
     * Null when kept.
     */
    public suspend fun keep(words: List<String>): Refusal? {
        val seed = phrase.seed(words) ?: return Refusal.NOT_A_PHRASE
        return store(seed, words)
    }

    /** Found a vault at the next index; the seed is already stored. */
    public suspend fun make(): FoundResult = keeper.found()

    public sealed interface Restored {
        public class Done(public val answer: RestoreAnswer, public val added: Int) : Restored {
            override fun toString(): String = "Done(added=$added)"
        }

        public data object Unreachable : Restored

        /** The laptop answered and holds nothing for these words. Nothing was stored. */
        public data object NothingHeld : Restored

        /** The laptop answered and would not grant this phone the vault. Nothing was stored. */
        public data object NotTaken : Restored

        /**
         * What the laptop sent did not pass this phone's check (#1047 R3).
         * Nothing was stored, nothing laid down, and the lease did not move.
         */
        public data object DidNotCheck : Restored

        public data class Refused(public val because: Refusal) : Restored
    }

    /** BRING THIS MEMBER'S VAULTS BACK FROM [words]. See the header for the order. */
    public suspend fun restore(words: List<String>, endpoint: String?): Restored {
        val seed = phrase.seed(words) ?: return Restored.Refused(Refusal.NOT_A_PHRASE)
        if (conflicts(seed)) return Restored.Refused(Refusal.DIFFERENT_WORDS)
        val answer = when (val result = restoreDoor.restore(words, endpoint)) {
            is RestoreResult.Restored -> result.answer
            is RestoreResult.Refused -> return stopped(result.because)
        }
        if (answer.vaults.isEmpty()) return Restored.NothingHeld
        store(seed, words)?.let { return Restored.Refused(it) }
        val added = keeper.adoptRestored(
            answer.vaults.map { Shelf.Restored(path = it.path, index = it.index) },
            answer.deviceSecretHex,
        )
        return Restored.Done(answer, added)
    }

    /**
     * BRING THIS MEMBER'S VAULTS BACK FROM THE SEED ALREADY HERE (#1047,
     * Q-1047-18) — the synchronised seed, with no words to type.
     *
     * Refused as [Refusal.NOT_A_PHRASE] when this phone holds no seed. The
     * seed is not stored again (it is where it came from); it is SETTLED once
     * the laptop brought something back, because the restore is what records
     * the indices the words spent.
     */
    public suspend fun restoreHeld(endpoint: String?): Restored {
        val seed = secrets.seed() ?: return Restored.Refused(Refusal.NOT_A_PHRASE)
        val answer = when (val result = restoreDoor.restoreSeed(seed, endpoint)) {
            is RestoreResult.Restored -> result.answer
            is RestoreResult.Refused -> return stopped(result.because)
        }
        if (answer.vaults.isEmpty()) return Restored.NothingHeld
        secrets.settleSeed()
        val added = keeper.adoptRestored(
            answer.vaults.map { Shelf.Restored(path = it.path, index = it.index) },
            answer.deviceSecretHex,
        )
        return Restored.Done(answer, added)
    }

    public sealed interface Rekeyed {
        public data class Done(public val keyed: Int) : Rekeyed

        /** No vault on this phone has an index recorded: only a restore can key them. */
        public data object NoneToKey : Rekeyed

        public data class Refused(public val because: Refusal) : Rekeyed
    }

    /** HAND THE WORDS BACK TO THIS PHONE'S VAULTS. See the header. */
    public suspend fun rekey(words: List<String>): Rekeyed {
        val seed = phrase.seed(words) ?: return Rekeyed.Refused(Refusal.NOT_A_PHRASE)
        if (conflicts(seed)) return Rekeyed.Refused(Refusal.DIFFERENT_WORDS)
        // NOTHING IS STORED FOR A PHONE WITH NO INDEX: an unkeyed vault with no
        // recorded index was never sealed under any index this phone knows,
        // and a guessed one could be the laptop's copy of another vault.
        if (keeper.indexedHoldings() == 0) return Rekeyed.NoneToKey
        store(seed, words)?.let { return Rekeyed.Refused(it) }
        return Rekeyed.Done(keeper.rekey())
    }

    /** Each door refusal, as the outcome the entry screen draws. Nothing was stored for any. */
    private fun stopped(because: RestoreRefusal): Restored = when (because) {
        RestoreRefusal.UNREACHABLE -> Restored.Unreachable
        RestoreRefusal.NOT_TAKEN -> Restored.NotTaken
        RestoreRefusal.DID_NOT_CHECK -> Restored.DidNotCheck
    }

    /**
     * A DIFFERENT SEED IS ALREADY HERE AND THIS PHONE'S VAULTS OPEN WITH IT.
     * Replacing it would reopen them under keys they were never sealed with.
     */
    private suspend fun conflicts(seed: String): Boolean {
        val held = secrets.seed() ?: return false
        return held != seed && secrets.anyVaultIndex()
    }

    private suspend fun store(seed: String, words: List<String>): Refusal? {
        runCatching { secrets.rememberSeed(seed) }.onFailure { return Refusal.STORE_REFUSED }
        // `rememberSeed` answers whether the platform SYNCHRONISES, not
        // whether it stored; the read-back is what says it is there.
        if (secrets.seed() != seed) return Refusal.STORE_REFUSED
        // THE WORDS AFTER THE SEED (Q-1047-19): a phone that kept the seed and
        // not the words still opens every vault; one that kept words for a
        // seed it does not hold would show a member words that open nothing.
        // A refused write costs only the settings screen, so it refuses
        // nothing here.
        runCatching { secrets.rememberWords(words.map { it.trim().lowercase() }) }
        secrets.settleSeed()
        return null
    }

    public companion object {
        /**
         * The enrollment over a live session: phrase requests through any open
         * core (they need no vault), a restore through the shelf's custody
         * core, and the shelf as the keeper.
         */
        public fun over(session: HomeSession, services: PlatformServices): Enrollment = Enrollment(
            secrets = VaultSecrets(services.secureStore, services.syncedSecrets),
            phrase = CorePhraseDoor { session.shelf.core() ?: session.shelf.custodyCore() },
            restoreDoor = dev.centraid.shared.sync.CoreRestoreDoor { session.shelf.custodyCore() },
            keeper = object : Keeper {
                override suspend fun found(): FoundResult = session.found()

                override suspend fun adoptRestored(restored: List<Shelf.Restored>, deviceSecretHex: String): Int =
                    session.adoptRestored(restored, deviceSecretHex)

                override suspend fun rekey(): Int = session.rekeyed()

                override suspend fun indexedHoldings(): Int = session.shelf.indexedHoldings()
            },
        )
    }
}
