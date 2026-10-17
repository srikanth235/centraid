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
 *   index the restore found it at.
 * * **Re-keying** ([rekey], Locker's wall): the words are seeded, checked
 *   against any seed already here, stored, and every vault with a recorded
 *   index is reopened keyed. No laptop; and no index is ever guessed.
 * * **Restoring from the seed this phone already holds** ([restoreHeld],
 *   Q-1047-18): a seed that arrived through the synchronised keychain, with no
 *   words and no record of its indices, restores exactly what its words would.
 *   Nothing new is stored; the seed is settled once the laptop brought
 *   something back.
 * * **Asking again for what stayed** ([restoreStayed], R-1047-R6): the vaults
 *   a restore named as staying with the old phone, by index, from the seed
 *   that restore stored. The vaults already here are never laid down again.
 *
 * * **A vault on its own words** ([keepOwn], then [make] with its entry,
 *   R-1047-E18): fresh words are minted and shown as for the first vault,
 *   and their seed is kept under an entry of its own — never the member's
 *   slot — before the vault is founded on it at index 0. A restore brings
 *   such a vault back from its entry when the keychain carried it
 *   ([restoreHeld]), or from its words typed on a phone whose own words
 *   differ ([restore]).
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
        /**
         * Found a vault: on the member's seed, or — [own] set — on that entry's
         * (R-1047-E18), named [name] when the member gave one.
         */
        public suspend fun found(own: String? = null, name: String? = null): FoundResult

        public suspend fun adoptRestored(restored: List<Shelf.Restored>): Int

        public suspend fun rekey(): Int

        public suspend fun indexedHoldings(): Int

        /** Whether any vault is on this phone; false until the shelf has read its directory. */
        public suspend fun holdsAVault(): Boolean
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

    /** Whether any vault is on this phone: a settled seed with none is a reinstall's first make. */
    public suspend fun holdsAVault(): Boolean = keeper.holdsAVault()

    /** 24 fresh words from the core, or null. */
    public suspend fun mint(): List<String>? = phrase.mint()

    /** Why words were not kept. */
    public enum class Refusal { NOT_A_PHRASE, DIFFERENT_WORDS, STORE_REFUSED }

    /**
     * STORE [words]' SEED AND SETTLE IT — after the check, before the found.
     * Null when kept.
     */
    public suspend fun keep(words: List<String>, sync: Boolean = true, shown: Boolean = true): Refusal? {
        val seed = phrase.seed(words) ?: return Refusal.NOT_A_PHRASE
        return store(seed, words, sync, saved = shown)
    }

    /**
     * Found a vault at the next index — or on entry [own]'s seed; the seed is
     * already stored. A vault on its own key is recorded as STILL TO BE FILED
     * in the main vault's Locker (R-ONBOARD-10): the core seals a Locker
     * secret only while that Locker is unlocked, so [OwnKeyFiling] files it on
     * the member's next unlock there.
     */
    public suspend fun make(own: String? = null, name: String? = null): FoundResult {
        val result = keeper.found(own, name)
        if (own != null && result is FoundResult.Made) {
            runCatching { secrets.addPendingFiling(own, result.vaultName) }
        }
        return result
    }

    /** Whether this phone's recovery key is in the synchronised store (R-ONBOARD-10). */
    public suspend fun seedSynced(): Boolean = secrets.seedSynced()

    /** What [keepOwn] answered: the entry the seed is kept under, or why not. */
    public sealed interface OwnKept {
        public data class Kept(public val id: String) : OwnKept

        public data class Refused(public val because: Refusal) : OwnKept
    }

    /**
     * KEEP FRESH WORDS FOR ONE VAULT, before it is founded (R-1047-E18). Their
     * seed goes under an entry of its own — synchronised when [sync] and the
     * platform takes it — and the words beside it, device-only, so settings
     * can show them again. The member's seed is not touched.
     */
    public suspend fun keepOwn(words: List<String>, label: String, sync: Boolean = true): OwnKept {
        val seed = phrase.seed(words) ?: return OwnKept.Refused(Refusal.NOT_A_PHRASE)
        val id = runCatching { secrets.keepOwnSeed(seed, label, sync) }.getOrNull()
            ?: return OwnKept.Refused(Refusal.STORE_REFUSED)
        if (secrets.ownSeed(id) != seed) {
            secrets.forgetOwnSeed(id)
            return OwnKept.Refused(Refusal.STORE_REFUSED)
        }
        runCatching { secrets.rememberOwnWords(id, words.map { it.trim().lowercase() }) }
        return OwnKept.Kept(id)
    }

    /** A kept entry no vault was founded on — the member walked away. */
    public suspend fun dropOwn(id: String) {
        secrets.forgetOwnSeed(id)
    }

    public sealed interface Restored {
        public class Done(
            public val answer: RestoreAnswer,
            public val added: Int,
            /**
             * The vaults on their own words (R-1047-E18) whose key came back
             * and for which the backup device held nothing, by name — told to
             * the member rather than left out of the list.
             */
            public val missing: List<String> = emptyList(),
        ) : Restored {
            override fun toString(): String = "Done(added=$added, missing=${missing.size})"
        }

        public data object Unreachable : Restored

        /** The laptop answered and holds nothing for these words. Nothing was stored. */
        public data object NothingHeld : Restored

        /** The laptop answered and would not grant this phone the vault. Nothing was stored. */
        public data object NotTaken : Restored

        /**
         * What the laptop sent did not pass this phone's check (#1047 R3).
         * Nothing was stored, nothing laid down, and nothing was claimed.
         */
        public data object DidNotCheck : Restored

        public data class Refused(public val because: Refusal) : Restored
    }

    /** BRING THIS MEMBER'S VAULTS BACK FROM [words]. See the header for the order. */
    public suspend fun restore(words: List<String>, endpoint: String?): Restored {
        val seed = phrase.seed(words) ?: return Restored.Refused(Refusal.NOT_A_PHRASE)
        // WORDS THAT ARE NOT THE MEMBER'S, on a phone whose vaults open with
        // the member's, are a vault on its own words (R-1047-E18) — or one the
        // keychain already holds an entry for.
        val asOwn = conflicts(seed) || secrets.ownSeedMatching(seed) != null
        val answer = when (val result = restoreDoor.restore(words, endpoint)) {
            is RestoreResult.Restored -> result.answer
            is RestoreResult.Refused -> return stopped(result.because)
        }
        if (answer.vaults.isEmpty()) return Restored.NothingHeld
        if (asOwn) {
            val id = secrets.ownSeedMatching(seed)
                ?: when (val kept = keepOwn(words, label = "")) {
                    is OwnKept.Kept -> kept.id
                    is OwnKept.Refused -> return Restored.Refused(kept.because)
                }
            val tagged = answer.taggedOwn(id)
            val added = keeper.adoptRestored(tagged.vaults.map { Shelf.Restored(path = it.path, index = it.index, own = id) })
            return Restored.Done(tagged, added)
        }
        store(seed, words, saved = true)?.let { return Restored.Refused(it) }
        val added = keeper.adoptRestored(answer.vaults.map { Shelf.Restored(path = it.path, index = it.index) })
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
        // EVERY SEED THE KEYCHAIN CARRIED (R-1047-E18): the member's, and each
        // vault kept on its own words, asked in turn. One that answered with
        // nothing, or was refused, does not stop the others.
        val member = secrets.seed()
        val owned = secrets.ownSeeds()
        if (member == null && owned.isEmpty()) return Restored.Refused(Refusal.NOT_A_PHRASE)
        val answers = mutableListOf<RestoreAnswer>()
        val missing = mutableListOf<String>()
        var refusal: Restored? = null
        var added = 0
        if (member != null) {
            when (val result = restoreDoor.restoreSeed(member, endpoint)) {
                is RestoreResult.Restored -> if (result.answer.vaults.isNotEmpty()) {
                    secrets.settleSeed()
                    added += keeper.adoptRestored(result.answer.vaults.map { Shelf.Restored(path = it.path, index = it.index) })
                    answers += result.answer
                }
                is RestoreResult.Refused -> refusal = stopped(result.because)
            }
        }
        for (entry in owned) {
            when (val result = restoreDoor.restoreSeed(entry.seedHex, endpoint)) {
                is RestoreResult.Restored -> if (result.answer.vaults.isNotEmpty()) {
                    val tagged = result.answer.taggedOwn(entry.id)
                    added += keeper.adoptRestored(tagged.vaults.map { Shelf.Restored(path = it.path, index = it.index, own = entry.id) })
                    answers += tagged
                } else {
                    missing += entry.label
                }
                is RestoreResult.Refused -> {
                    if (refusal == null) refusal = stopped(result.because)
                    missing += entry.label
                }
            }
        }
        if (answers.isEmpty()) return refusal ?: Restored.NothingHeld
        return Restored.Done(merged(answers), added, missing)
    }

    /** What a held restore will ask for: the member's vaults, and each vault on its own words by name. */
    public suspend fun heldKeys(): List<String> = secrets.ownSeeds().map { it.label }

    /**
     * BRING BACK THE VAULTS THAT STAYED, ON THEIR OWN (R-1047-R6): a restore
     * answered some vaults and named [indices] as `unclaimed`, and the member
     * asks again. The seed is already stored — the first restore stored it —
     * so no words are asked for and nothing is stored; the core leaves the
     * vaults this phone holds as they are, and only what came back is held.
     */
    public suspend fun restoreStayed(stayed: List<UnclaimedVaultAt>, endpoint: String?): Restored {
        // ONE ASK PER SEED: the member's indices under the member's seed, a
        // vault on its own words under its entry's (R-1047-E18).
        val answers = mutableListOf<RestoreAnswer>()
        var refusal: Restored? = null
        var added = 0
        for ((own, group) in stayed.groupBy { it.own }) {
            val seed = (if (own != null) secrets.ownSeed(own) else secrets.seed())
                ?: run { if (refusal == null) refusal = Restored.Refused(Refusal.NOT_A_PHRASE); null }
                ?: continue
            when (val result = restoreDoor.restoreStayed(seed, endpoint, group.map { it.index })) {
                is RestoreResult.Restored -> if (result.answer.vaults.isNotEmpty()) {
                    val tagged = if (own != null) result.answer.taggedOwn(own) else result.answer
                    added += keeper.adoptRestored(tagged.vaults.map { Shelf.Restored(path = it.path, index = it.index, own = own) })
                    answers += tagged
                }
                is RestoreResult.Refused -> if (refusal == null) refusal = stopped(result.because)
            }
        }
        if (answers.isEmpty()) return refusal ?: Restored.NothingHeld
        return Restored.Done(merged(answers), added)
    }

    /** [this] answer's vaults, marked as entry [id]'s. */
    private fun RestoreAnswer.taggedOwn(id: String): RestoreAnswer = RestoreAnswer(
        vaults = vaults.map { it.copy(own = id) },
        gapScanned = gapScanned,
        unclaimed = unclaimed.map { it.copy(own = id) },
    )

    private fun merged(answers: List<RestoreAnswer>): RestoreAnswer = answers.singleOrNull() ?: RestoreAnswer(
        vaults = answers.flatMap { it.vaults },
        gapScanned = answers.sumOf { it.gapScanned },
        unclaimed = answers.flatMap { it.unclaimed },
    )

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
        store(seed, words, saved = true)?.let { return Rekeyed.Refused(it) }
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

    /**
     * [saved]: the member saw or typed the key, so a copy outside this phone
     * is theirs ([VaultSecrets.markWordsSaved]). A key kept without being
     * shown (R-ONBOARD-10) is not.
     */
    private suspend fun store(seed: String, words: List<String>, sync: Boolean = true, saved: Boolean = false): Refusal? {
        runCatching { secrets.rememberSeed(seed, sync) }.onFailure { return Refusal.STORE_REFUSED }
        // `rememberSeed` answers whether the platform SYNCHRONISES, not
        // whether it stored; the read-back is what says it is there.
        if (secrets.seed() != seed) return Refusal.STORE_REFUSED
        // THE WORDS AFTER THE SEED (Q-1047-19): a phone that kept the seed and
        // not the words still opens every vault; one that kept words for a
        // seed it does not hold would show a member words that open nothing.
        // A refused write costs only the settings screen, so it refuses
        // nothing here.
        runCatching { secrets.rememberWords(words.map { it.trim().lowercase() }) }
        if (saved) runCatching { secrets.markWordsSaved() }
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
                override suspend fun found(own: String?, name: String?): FoundResult =
                    session.found(name = name?.trim()?.takeIf { it.isNotEmpty() } ?: Shelf.DEFAULT_VAULT_NAME, own = own)

                override suspend fun adoptRestored(restored: List<Shelf.Restored>): Int =
                    session.adoptRestored(restored)

                override suspend fun rekey(): Int = session.rekeyed()

                override suspend fun indexedHoldings(): Int = session.shelf.indexedHoldings()

                override suspend fun holdsAVault(): Boolean = session.shelf.holdsNoVault.value == false
            },
        )
    }
}
