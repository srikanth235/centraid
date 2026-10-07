package dev.centraid.shared.custody

import dev.centraid.shared.platform.SecureStore
import dev.centraid.shared.platform.SyncedSecrets

/**
 * THE SEED A CORE IS OPENED WITH, AND WHAT THIS PHONE KEEPS BESIDE IT
 * (#1029 W18, `crates/core-ffi/CONTRACT.md` §4b).
 *
 * The seed and the device-only facts about it have opposite durability rules.
 * Storing one where the other belongs is a defect a member finds out about on
 * the worst possible day, so they are one object with the rule written on
 * each accessor rather than call sites a shell gets right by remembering.
 *
 * | What | Where | Why |
 * |---|---|---|
 * | the vault's **seed** (128 hex) | [SyncedSecrets] — **synchronised** | it is the 24 words; iCloud Keychain carrying it to the member's next phone is the point |
 * | the **words**, each vault's **index**, and the seed when no synchronised store took it | [SecureStore] — **this device only** | they are facts about THIS phone's vaults; see each accessor |
 *
 * ## The seed is synchronised and that is deliberate
 *
 * `SyncedSecrets` is the one exception to `IosSecureStore`'s `…ThisDeviceOnly`
 * pinning, and the argument is §5's: the seed **is** the recovery phrase, so a
 * member whose phone is at the bottom of a river is restored by the thing that
 * followed their Apple ID rather than by a piece of paper they did not write.
 * The written phrase stays the common path on Android, where Block Store hands
 * bytes back only inside the setup wizard.
 *
 * ## There is no device secret (#1080 A21)
 *
 * A gateway knows a phone by a bearer token in the core's backup ledger
 * (#1080 ruling 1), so no device key is stored here and a core is opened
 * with none.
 *
 * ## Absent is not an error
 *
 * A core opened with no seed reads and writes perfectly well and cannot seal
 * a backup, which a shell draws as "unlock to back up". **Present and
 * malformed IS an error** (`BAD_ARGUMENT`), because carrying on would leave a
 * shell believing it had unlocked something it had not.
 */
public class VaultSecrets(
    private val store: SecureStore,
    private val synced: SyncedSecrets,
) {

    /**
     * This member's seed, or null when this phone holds none: the synchronised
     * store's, else this device's own copy (see [rememberSeed]).
     */
    public suspend fun seed(): String? =
        synced.seed()?.takeIf { it.isSeed() } ?: store.read(LOCAL_SEED)?.takeIf { it.isSeed() }

    /**
     * Remember the seed. Answers whether the platform synchronises it.
     *
     * **A PLATFORM THAT WILL NOT TAKE IT STILL LEAVES IT ON THIS PHONE** (#1047
     * E1, R-1047-E6). Android's Block Store refuses without Google Play
     * services, and a phone whose seed was stored nowhere could never open a
     * vault keyed — no Locker, no backup — for a member who has just written
     * their words down. So a refused synchronised write falls back to the
     * device-only store, which is where iOS's Keychain already keeps it when
     * iCloud Keychain is off; the custody sentence tells the member their
     * words are then the only way back. A synchronised write that succeeds
     * removes the device copy, so there is one seed and not two.
     */
    public suspend fun rememberSeed(seedHex: String): Boolean {
        require(seedHex.isSeed()) { "a seed is $SEED_HEX_LENGTH lowercase hex characters" }
        val synchronised = runCatching { synced.putSeed(seedHex) }.getOrDefault(false) &&
            synced.seed() == seedHex
        store.write(LOCAL_SEED, if (synchronised) "" else seedHex)
        return synchronised
    }

    /** Forget the seed everywhere this object put it, and the words with it. */
    public suspend fun forgetSeed() {
        synced.forgetSeed()
        store.write(LOCAL_SEED, "")
        store.write(LOCAL_WORDS, "")
    }

    /**
     * THE 24 WORDS THEMSELVES, KEPT SO SETTINGS CAN SHOW THEM AGAIN (#1047,
     * Q-1047-19, the owner's ruling of 2026-09-29).
     *
     * The seed is one-way from the words, so a phone that kept only the seed
     * could never show them. They are kept in the DEVICE-ONLY store and never
     * the synchronised one: the synchronised seed already carries everything
     * a member's next phone needs to restore (Q-1047-18), and a second
     * synchronised copy of the same secret would be a second exposure path
     * that buys nothing. So a phone that minted the words, or had them typed
     * into it for a restore or a re-key, can show them; a phone that received
     * only the seed through the keychain says it has none to show.
     */
    public suspend fun rememberWords(words: List<String>) {
        require(words.size == WORDS && words.all { it.isWord() }) { "the words are $WORDS lowercase list words" }
        store.write(LOCAL_WORDS, words.joinToString(" "))
    }

    /** The words kept by [rememberWords], or null. */
    public suspend fun words(): List<String>? =
        store.read(LOCAL_WORDS)?.split(' ')?.takeIf { kept -> kept.size == WORDS && kept.all { it.isWord() } }

    /**
     * THE DERIVATION INDEX [vaultId] SITS AT UNDER THE SEED, or null (#1047 W2).
     *
     * The seed is one per member — "these 24 words are your vaults" — and each
     * vault is the seed's child at its own index (`seed / vault'(i)`), so a core
     * is only KEYED when the shell hands it both. The index is not a secret, but
     * it lives in the device-only store because it is a fact about this phone:
     * its knowledge of one vault it holds. It is
     * never synchronised — a restore rediscovers every index by scanning from
     * the words (`RestoreResponse.vaults[].index`), so a copy that travelled
     * would be a second answer to a question the words already answer.
     *
     * **Absent is a state**: a core opened without an index opens without the
     * seed, reads and writes its vault, and refuses Locker and the drain. Never
     * a guess at 0 — two vaults at one index are one identity and one Locker
     * `K`, which is the reuse `DeriveError::VaultIndexReused` exists to refuse.
     */
    public suspend fun vaultIndex(vaultId: String): Int? =
        store.read(INDEX_PREFIX + vaultId)?.toIntOrNull()?.takeIf { it >= 0 }

    /**
     * Record [vaultId]'s index, and raise the high-water mark past it.
     *
     * The mark is never lowered — not by [forgetVaultIndex], not by forgetting
     * a vault — so [nextVaultIndex] never hands out an index a vault this phone
     * once held was sealed under.
     */
    public suspend fun rememberVaultIndex(vaultId: String, index: Int) {
        require(index >= 0) { "a vault index is a non-negative integer" }
        store.write(INDEX_PREFIX + vaultId, index.toString())
        val mark = highWater()
        if (mark == null || index > mark) store.write(INDEX_HIGH_WATER, index.toString())
    }

    /** Drop one vault's index. The high-water mark stays where it is. */
    public suspend fun forgetVaultIndex(vaultId: String) {
        store.write(INDEX_PREFIX + vaultId, "")
    }

    /** The index a vault founded now takes: one past the highest ever recorded. */
    public suspend fun nextVaultIndex(): Int = highWater()?.plus(1) ?: 0

    /**
     * SPEND THE NEXT INDEX BEFORE THE FOUND, AND SAY WHERE (#1047 E4, the
     * crash window).
     *
     * A found commits the vault keyed at index `i` and only then can the shelf
     * record `i` under the id the file names. A process killed between the two
     * left a keyed vault with no record: the next launch opened it unkeyed —
     * Locker walled, the drain refused — and the next found took `i` again,
     * two vaults on one identity and one Locker `K`. So the index is spent
     * FIRST: the high-water mark is raised past it and [pendingFound] names the
     * file it is for, both before the core is asked to found anything. A
     * launch that finds the mark names a file finishes the record
     * (`Shelf.load`); a found that is refused gives the index back
     * ([releaseVaultIndex]).
     */
    public suspend fun reserveVaultIndex(path: String): Int {
        val index = nextVaultIndex()
        store.write(PENDING_FOUND, "$index\n$path")
        store.write(INDEX_HIGH_WATER, index.toString())
        return index
    }

    /** A found that spent an index and has not yet recorded it, or null. See [reserveVaultIndex]. */
    public suspend fun pendingFound(): PendingFound? {
        val raw = store.read(PENDING_FOUND)?.takeIf { it.isNotEmpty() } ?: return null
        val index = raw.substringBefore('\n').toIntOrNull()?.takeIf { it >= 0 } ?: return null
        val path = raw.substringAfter('\n', "").takeIf { it.isNotEmpty() } ?: return null
        return PendingFound(index, path)
    }

    /** The found finished: its index is recorded under the vault's id. */
    public suspend fun clearPendingFound() {
        store.write(PENDING_FOUND, "")
    }

    /**
     * A REFUSED FOUND GIVES ITS INDEX BACK — only while it is still the
     * highest, and only because nothing was sealed under it: the file is
     * deleted before this is called, and a vault that never paired has put
     * nothing on any laptop. An index a restore's gap scan must cross is one
     * this phone skipped, and the scan stops after twenty in a row.
     */
    public suspend fun releaseVaultIndex(index: Int) {
        store.write(PENDING_FOUND, "")
        if (highWater() != index) return
        store.write(INDEX_HIGH_WATER, if (index == 0) "" else (index - 1).toString())
    }

    /** One spent, unrecorded index and the file it was spent for. */
    public data class PendingFound(public val index: Int, public val path: String)

    /**
     * WHETHER THIS PHONE KNOWS WHICH INDICES ITS SEED HAS SPENT (#1047 E1,
     * R-1047-E2).
     *
     * The seed is synchronised; the indices are not. A seed that arrived on
     * this phone through iCloud Keychain carries no record of the vaults the
     * member made with it elsewhere, and [nextVaultIndex] would answer 0 — the
     * index of a vault that already exists, so the new one would share its
     * identity, its backup keys and its Locker `K`. So the seed is SETTLED
     * here only when this phone minted it, restored from it or was re-keyed
     * with it (each calls [settleSeed]), or has recorded an index under it.
     */
    public suspend fun seedSettled(): Boolean =
        highWater() != null || store.read(SEED_SETTLED) == SETTLED

    /** Record that this phone's seed is its own to make vaults from. See [seedSettled]. */
    public suspend fun settleSeed() {
        store.write(SEED_SETTLED, SETTLED)
    }

    /** Whether this phone has recorded any vault index at all. */
    public suspend fun anyVaultIndex(): Boolean = highWater() != null

    private suspend fun highWater(): Int? =
        store.read(INDEX_HIGH_WATER)?.toIntOrNull()?.takeIf { it >= 0 }

    public companion object {
        /** 64 bytes, as 128 lowercase hex characters (`CONTRACT.md` §4b). */
        public const val SEED_HEX_LENGTH: Int = 128

        /**
         * Per VAULT: `vault-index.<vaultId>`. A device holding two vaults holds
         * two indices, and one shared across them would be two vaults at one
         * identity.
         */
        public const val INDEX_PREFIX: String = "vault-index."

        /** The highest index this phone ever recorded. See [rememberVaultIndex]. */
        public const val INDEX_HIGH_WATER: String = "vault-index-high-water"

        /** `<index>\n<path>` of a found in flight. See [reserveVaultIndex]. */
        public const val PENDING_FOUND: String = "vault-index-pending"

        /**
         * Device-only: the seed, when the synchronised store refused it. See
         * [rememberSeed]. Named apart from `SyncedSecrets.SEED_KEY` so the two
         * stores never answer for each other.
         */
        public const val LOCAL_SEED: String = "recovery-seed.this-device"

        /** Device-only: the 24 words, space-separated. See [rememberWords]. */
        public const val LOCAL_WORDS: String = "recovery-words.this-device"

        /** How many words a phrase is. */
        public const val WORDS: Int = 24

        /** Device-only: this phone's seed is settled. See [seedSettled]. */
        public const val SEED_SETTLED: String = "seed-settled"

        private const val SETTLED: String = "1"

        internal fun String.isSeed(): Boolean = isHex(SEED_HEX_LENGTH)

        /** A lowercase ASCII word — the shape of a BIP39 English list word, not the list. */
        private fun String.isWord(): Boolean = isNotEmpty() && all { it in 'a'..'z' }

        private fun String.isHex(length: Int): Boolean =
            this.length == length && all { it in "0123456789abcdef" }

        internal fun ByteArray.toHex(): String =
            joinToString("") { byte ->
                val value = byte.toInt() and 0xff
                "0123456789abcdef"[value shr 4].toString() +
                    "0123456789abcdef"[value and 0x0f]
            }
    }
}
