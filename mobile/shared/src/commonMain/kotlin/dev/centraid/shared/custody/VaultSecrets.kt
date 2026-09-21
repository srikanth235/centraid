package dev.centraid.shared.custody

import dev.centraid.shared.platform.SecureStore
import dev.centraid.shared.platform.SecureRandom
import dev.centraid.shared.platform.SyncedSecrets

/**
 * THE TWO SECRETS A CORE IS OPENED WITH, AND THEY LIVE IN DIFFERENT PLACES
 * (#1029 W18, `crates/core-ffi/CONTRACT.md` §4b).
 *
 * They look alike — both are hex strings handed to `centraid_open` — and they
 * have opposite durability rules. Storing either one where the other belongs is
 * a defect a member finds out about on the worst possible day, so they are one
 * object with the rule written on each accessor rather than two call sites a
 * shell gets right by remembering.
 *
 * | Secret | Where | Why |
 * |---|---|---|
 * | the vault's **seed** (128 hex) | [SyncedSecrets] — **synchronised** | it is the 24 words; iCloud Keychain carrying it to the member's next phone is the point |
 * | this device's **secret** (64 hex) | [SecureStore] — **this device only** | it identifies THIS phone; a copy on a second device would be two devices claiming to be one |
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
 * ## The device secret never leaves
 *
 * It goes in the ordinary [SecureStore], which both platforms pin to this
 * device. **A device secret that synchronised would enrol a member's old phone
 * and their new one as the same device**, and F1's `VAULT_MOVED` freeze — the
 * thing that stops two phones writing one vault — is keyed on exactly that
 * distinction.
 *
 * ## Absent is not an error, on either
 *
 * A core opened with no seed reads and writes perfectly well and refuses to
 * drain, which a shell draws as "unlock to back up". A core opened with no
 * device secret mints one and hands it back to be stored, which is every first
 * launch. **Present and malformed IS an error on both** (`BAD_ARGUMENT`),
 * because carrying on would leave a shell believing it had unlocked something
 * it had not.
 */
public class VaultSecrets(
    private val store: SecureStore,
    private val synced: SyncedSecrets,
    private val random: SecureRandom,
) {

    /** This vault's seed, or null when the member has not unlocked. */
    public suspend fun seed(): String? = synced.seed()?.takeIf { it.isSeed() }

    /** Remember the seed. Answers whether the platform synchronises it. */
    public suspend fun rememberSeed(seedHex: String): Boolean {
        require(seedHex.isSeed()) { "a seed is $SEED_HEX_LENGTH lowercase hex characters" }
        return synced.putSeed(seedHex)
    }

    /** Forget the seed everywhere this object put it. */
    public suspend fun forgetSeed() {
        synced.forgetSeed()
    }

    /**
     * This device's secret for [vaultId], minting one on first use.
     *
     * Minted from the PLATFORM's CSPRNG (`SecureRandom`), never from
     * `kotlin.random.Random`, which is a clock-seeded shuffler and not a key
     * source — a device identity a third party could predict is a device
     * identity they could claim.
     */
    public suspend fun deviceSecret(vaultId: String): String {
        val key = deviceKey(vaultId)
        store.read(key)?.takeIf { it.isDeviceSecret() }?.let { return it }
        val minted = random.bytes(DEVICE_SECRET_BYTES).toHex()
        store.write(key, minted)
        return minted
    }

    /**
     * Store a device secret the CORE minted.
     *
     * The core mints one when it is opened without it; this is the other half
     * of that, and a shell that dropped the answer would mint a fresh identity
     * on every launch and silently un-enrol itself from its own laptop.
     */
    public suspend fun rememberDeviceSecret(vaultId: String, secretHex: String) {
        require(secretHex.isDeviceSecret()) {
            "a device secret is $DEVICE_SECRET_HEX_LENGTH lowercase hex characters"
        }
        store.write(deviceKey(vaultId), secretHex)
    }

    /** Drop this device's secret for one vault. What unpairing calls. */
    public suspend fun forgetDeviceSecret(vaultId: String) {
        // AN EMPTY VALUE DELETES — `SecureStore`'s own rule, and the reason it
        // has one: a stored empty string reads back as a credential the app
        // believes it has.
        store.write(deviceKey(vaultId), "")
    }

    private fun deviceKey(vaultId: String): String = DEVICE_SECRET_PREFIX + vaultId

    public companion object {
        /** 64 bytes, as 128 lowercase hex characters (`CONTRACT.md` §4b). */
        public const val SEED_HEX_LENGTH: Int = 128

        /** 32 bytes, as 64 lowercase hex characters. */
        public const val DEVICE_SECRET_BYTES: Int = 32

        public const val DEVICE_SECRET_HEX_LENGTH: Int = DEVICE_SECRET_BYTES * 2

        /**
         * Per VAULT, not per device.
         *
         * A device holding two vaults is two cores, two endpoints and two
         * records (D-1025-S7-13), so it is two secrets; one shared across them
         * would make unpairing one vault un-enrol the other.
         */
        public const val DEVICE_SECRET_PREFIX: String = "device-secret."

        internal fun String.isSeed(): Boolean = isHex(SEED_HEX_LENGTH)

        internal fun String.isDeviceSecret(): Boolean = isHex(DEVICE_SECRET_HEX_LENGTH)

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
