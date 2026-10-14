package dev.centraid.shared.custody

import dev.centraid.shared.platform.SecureStore
import dev.centraid.shared.platform.SyncedSecrets
import kotlin.random.Random

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
    public suspend fun rememberSeed(seedHex: String, sync: Boolean = true): Boolean {
        require(seedHex.isSeed()) { "a seed is $SEED_HEX_LENGTH lowercase hex characters" }
        // THE MEMBER OPTED OUT (R-1047-E16): this phone only, and no synced
        // copy left behind from an earlier write.
        if (!sync) {
            runCatching { synced.forgetSeed() }
            store.write(LOCAL_SEED, seedHex)
            return false
        }
        val synchronised = runCatching { synced.putSeed(seedHex) }.getOrDefault(false) &&
            synced.seed() == seedHex
        store.write(LOCAL_SEED, if (synchronised) "" else seedHex)
        return synchronised
    }

    /**
     * WHETHER THE SYNCHRONISED STORE HOLDS THIS PHONE'S SEED right now (R-ONBOARD-10):
     * what the Backup tab says about where the recovery key is, read rather
     * than remembered, so a keychain the member turned off is said as off.
     */
    public suspend fun seedSynced(): Boolean {
        val held = seed() ?: return false
        return runCatching { synced.seed() }.getOrNull() == held
    }

    /**
     * MOVE THE SEED INTO OR OUT OF THE SYNCHRONISED STORE (R-ONBOARD-10): the
     * Backup tab's "Keep my key off iCloud" and its way back. Answers whether
     * it is synchronised afterwards; a phone holding no seed answers false and
     * changes nothing. [wordsSaved] is untouched: a copy the member saved
     * elsewhere is still saved, and only the keychain copy moved.
     */
    public suspend fun setSeedSync(on: Boolean): Boolean {
        val held = seed() ?: return false
        return rememberSeed(held, sync = on)
    }

    /**
     * THE MEMBER SAID THEY SAVED A COPY OF THEIR RECOVERY KEY (R-ONBOARD-10):
     * on the shown key's "I've saved it", or by typing it in for a restore or
     * a re-key. Device-only, and a claim rather than a proof — it only quiets
     * the Backup tab's warning for a key that is on this phone alone.
     */
    public suspend fun wordsSaved(): Boolean = store.read(WORDS_SAVED) == SETTLED

    /** Record [wordsSaved]. */
    public suspend fun markWordsSaved() {
        store.write(WORDS_SAVED, SETTLED)
    }

    /** Forget the seed everywhere this object put it, and the words with it. */
    public suspend fun forgetSeed() {
        synced.forgetSeed()
        store.write(LOCAL_SEED, "")
        store.write(LOCAL_WORDS, "")
        store.write(WORDS_SAVED, "")
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
        val lines = raw.split('\n')
        val index = lines.getOrNull(0)?.toIntOrNull()?.takeIf { it >= 0 } ?: return null
        val path = lines.getOrNull(1)?.takeIf { it.isNotEmpty() } ?: return null
        return PendingFound(index, path, lines.getOrNull(2)?.takeIf { it.isNotEmpty() })
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

    /** What opens one vault: an index, under the member's seed or entry [own]'s. */
    public data class VaultKey(public val index: Int, public val own: String? = null)

    /** One vault seed on its own words. **Redacted**: [seedHex] is a key to a vault. */
    public class OwnSeed(public val id: String, public val label: String, internal val seedHex: String) {
        override fun toString(): String = "OwnSeed($id, $label, <redacted>)"
    }

    /**
     * One spent, unrecorded index and the file it was spent for — and, for a
     * vault on its own words, the entry whose seed keys it ([own]).
     */
    public data class PendingFound(public val index: Int, public val path: String, public val own: String? = null)

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

    // -----------------------------------------------------------------------
    // Vaults on their own words (R-1047-E18)
    // -----------------------------------------------------------------------

    /**
     * WHICH SEED AND INDEX OPEN [vaultId], or null when this phone cannot key
     * it. A vault on its own words is its entry's seed at its recorded index
     * (always 0 when this phone made it); any other vault is the member's seed
     * at its recorded index. [VaultKey.own] names the entry, never the seed.
     */
    public suspend fun vaultKey(vaultId: String): VaultKey? {
        val index = vaultIndex(vaultId) ?: return null
        val own = ownSeedOf(vaultId)
        return when {
            own != null -> if (ownSeed(own) != null) VaultKey(index, own) else null
            seed() != null -> VaultKey(index)
            else -> null
        }
    }

    /** The seed [key] opens with: its entry's, or the member's. */
    public suspend fun seedFor(key: VaultKey): String? = if (key.own != null) ownSeed(key.own) else seed()

    /**
     * KEEP A FRESH SEED FOR ONE VAULT, before that vault is founded, and answer
     * its entry id. Synchronised when [sync] and the platform takes it — under
     * its own key, with [label] (the vault's name) in [OWN_SEED_INDEX] so a
     * restore can list it — else on this phone only. Never the member's slot.
     */
    public suspend fun keepOwnSeed(seedHex: String, label: String, sync: Boolean = true): String {
        require(seedHex.isSeed()) { "a seed is $SEED_HEX_LENGTH lowercase hex characters" }
        val id = Random.nextBytes(OWN_ID_BYTES).toHex()
        val clean = label.cleanLabel()
        val synchronised = sync &&
            runCatching { synced.put(OWN_SEED_PREFIX + id, seedHex) }.getOrDefault(false) &&
            runCatching { synced.get(OWN_SEED_PREFIX + id) }.getOrNull() == seedHex &&
            runCatching { synced.put(OWN_SEED_INDEX, writeIndex(syncedIndex() + (id to clean))) }.getOrDefault(false)
        if (!synchronised) {
            runCatching { synced.remove(OWN_SEED_PREFIX + id) }
            store.write(LOCAL_OWN_SEED_PREFIX + id, seedHex)
            store.write(LOCAL_OWN_INDEX, writeIndex(localIndex() + (id to clean)))
        }
        return id
    }

    /** Every vault seed this phone can reach — synchronised here or kept here — with its label. */
    public suspend fun ownSeeds(): List<OwnSeed> {
        val fromSync = syncedIndex().mapNotNull { (id, label) ->
            runCatching { synced.get(OWN_SEED_PREFIX + id) }.getOrNull()?.takeIf { it.isSeed() }?.let { OwnSeed(id, label, it) }
        }
        val fromHere = localIndex().mapNotNull { (id, label) ->
            store.read(LOCAL_OWN_SEED_PREFIX + id)?.takeIf { it.isSeed() }?.let { OwnSeed(id, label, it) }
        }
        return (fromSync + fromHere).distinctBy { it.id }
    }

    /** Entry [id]'s seed, or null. */
    public suspend fun ownSeed(id: String): String? =
        runCatching { synced.get(OWN_SEED_PREFIX + id) }.getOrNull()?.takeIf { it.isSeed() }
            ?: store.read(LOCAL_OWN_SEED_PREFIX + id)?.takeIf { it.isSeed() }

    /** The entry whose seed already is [seedHex], or null. */
    public suspend fun ownSeedMatching(seedHex: String): String? = ownSeeds().firstOrNull { it.seedHex == seedHex }?.id

    /** Rename entry [id]'s label wherever it is listed. */
    public suspend fun labelOwnSeed(id: String, label: String) {
        val clean = label.cleanLabel()
        val inSync = syncedIndex()
        if (inSync.any { it.first == id }) {
            runCatching { synced.put(OWN_SEED_INDEX, writeIndex(inSync.map { if (it.first == id) id to clean else it })) }
        }
        val inHere = localIndex()
        if (inHere.any { it.first == id }) {
            store.write(LOCAL_OWN_INDEX, writeIndex(inHere.map { if (it.first == id) id to clean else it }))
        }
    }

    /** Forget entry [id] everywhere: its seed, its words and its line in either index. */
    public suspend fun forgetOwnSeed(id: String) {
        runCatching { synced.remove(OWN_SEED_PREFIX + id) }
        val inSync = syncedIndex()
        if (inSync.any { it.first == id }) {
            runCatching { synced.put(OWN_SEED_INDEX, writeIndex(inSync.filter { it.first != id })) }
        }
        store.write(LOCAL_OWN_SEED_PREFIX + id, "")
        store.write(LOCAL_OWN_WORDS_PREFIX + id, "")
        store.write(LOCAL_OWN_INDEX, writeIndex(localIndex().filter { it.first != id }))
        clearPendingFiling(id)
    }

    /**
     * A VAULT'S OWN KEY STILL TO BE FILED IN THE MAIN VAULT'S LOCKER
     * (R-ONBOARD-10): `<id>\t<vault name>` per line, device-only. The core
     * seals a Locker secret only while that vault's Locker is unlocked, which
     * it never is when a vault is made, so the filing waits for the member's
     * next unlock of the main vault ([dev.centraid.shared.custody.OwnKeyFiling]).
     */
    public suspend fun pendingFilings(): List<Pair<String, String>> = readIndex(store.read(PENDING_FILINGS))

    /** Record entry [id], made as [name], as still to be filed. */
    public suspend fun addPendingFiling(id: String, name: String) {
        store.write(PENDING_FILINGS, writeIndex(pendingFilings().filter { it.first != id } + (id to name.cleanLabel())))
    }

    /** Entry [id] was filed, or forgotten: nothing left to file for it. */
    public suspend fun clearPendingFiling(id: String) {
        store.write(PENDING_FILINGS, writeIndex(pendingFilings().filter { it.first != id }))
    }

    /** Entry [id]'s 24 words, device-only, so Settings can show them again — as [rememberWords]. */
    public suspend fun rememberOwnWords(id: String, words: List<String>) {
        require(words.size == WORDS && words.all { it.isWord() }) { "the words are $WORDS lowercase list words" }
        store.write(LOCAL_OWN_WORDS_PREFIX + id, words.joinToString(" "))
    }

    /** The words kept by [rememberOwnWords], or null. */
    public suspend fun ownWords(id: String): List<String>? =
        store.read(LOCAL_OWN_WORDS_PREFIX + id)?.split(' ')?.takeIf { kept -> kept.size == WORDS && kept.all { it.isWord() } }

    /**
     * [vaultId] OPENS WITH ENTRY [own]'s SEED AT [index]. The member's
     * high-water mark is not touched: the index is under another seed, and
     * raising it would settle — or skip past — the member's own.
     */
    public suspend fun bindOwnVault(vaultId: String, own: String, index: Int = 0) {
        require(index >= 0) { "a vault index is a non-negative integer" }
        store.write(OWN_VAULT_PREFIX + vaultId, own)
        store.write(INDEX_PREFIX + vaultId, index.toString())
    }

    /** The entry [vaultId] is kept on, or null for a vault on the member's words. */
    public suspend fun ownSeedOf(vaultId: String): String? = store.read(OWN_VAULT_PREFIX + vaultId)?.takeIf { it.isNotEmpty() }

    /** Unbind [vaultId] and forget its entry: what forgetting a vault on its own words does. */
    public suspend fun forgetOwnVault(vaultId: String) {
        val own = ownSeedOf(vaultId) ?: return
        store.write(OWN_VAULT_PREFIX + vaultId, "")
        forgetOwnSeed(own)
    }

    /** A found of a vault on entry [own]'s seed, pending against [path]: as [reserveVaultIndex], at index 0, no mark. */
    public suspend fun reserveOwnFound(path: String, own: String) {
        store.write(PENDING_FOUND, "0\n$path\n$own")
    }

    private suspend fun syncedIndex(): List<Pair<String, String>> =
        readIndex(runCatching { synced.get(OWN_SEED_INDEX) }.getOrNull())

    private suspend fun localIndex(): List<Pair<String, String>> = readIndex(store.read(LOCAL_OWN_INDEX))

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

        /** Device-only: vaults' own keys still to be filed in Locker. See [pendingFilings]. */
        public const val PENDING_FILINGS: String = "vault-seeds.to-file"

        /** Device-only: the member saved a copy of their key. See [wordsSaved]. */
        public const val WORDS_SAVED: String = "recovery-words-saved"

        /** Device-only: this phone's seed is settled. See [seedSettled]. */
        public const val SEED_SETTLED: String = "seed-settled"

        private const val SETTLED: String = "1"

        /** Synchronised: one vault's own seed, by entry id (R-1047-E18). */
        public const val OWN_SEED_PREFIX: String = "vault-seed."

        /** Synchronised: `<id>\t<label>` per line, every vault seed synchronised. */
        public const val OWN_SEED_INDEX: String = "vault-seeds"

        /** Device-only: a vault's own seed the synchronised store did not take. */
        public const val LOCAL_OWN_SEED_PREFIX: String = "vault-seed.this-device."

        /** Device-only: the index of [LOCAL_OWN_SEED_PREFIX] entries. */
        public const val LOCAL_OWN_INDEX: String = "vault-seeds.this-device"

        /** Device-only: a vault's own 24 words. */
        public const val LOCAL_OWN_WORDS_PREFIX: String = "vault-words.this-device."

        /** Device-only, per vault: the entry it is kept on. */
        public const val OWN_VAULT_PREFIX: String = "vault-own."

        private const val OWN_ID_BYTES: Int = 8

        private fun readIndex(raw: String?): List<Pair<String, String>> =
            raw.orEmpty().split('\n').mapNotNull { line ->
                val id = line.substringBefore('\t').takeIf { it.isHex(OWN_ID_BYTES * 2) } ?: return@mapNotNull null
                id to line.substringAfter('\t', "")
            }

        private fun writeIndex(entries: List<Pair<String, String>>): String =
            entries.distinctBy { it.first }.joinToString("\n") { (id, label) -> "$id\t$label" }

        private fun String.cleanLabel(): String = replace('\t', ' ').replace('\n', ' ').trim()

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
