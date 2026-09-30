package dev.centraid.shared.platform

import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.io.encoding.Base64

/**
 * THE SEALING HALF OF [AndroidSecureStore], with its two keys handed in.
 *
 * It replaces `androidx.security.crypto`'s `EncryptedSharedPreferences`, which
 * the library deprecated as a whole. What it does is the same two things that
 * file did, over a plain `SharedPreferences` the store owns:
 *
 * - **A value is AES-256-GCM** under [valueKey], a fresh 12-byte nonce per
 *   write, stored as `base64(nonce ‖ ciphertext ‖ tag)`. The entry's logical
 *   name is the associated data, so a value copied onto another entry's name
 *   does not open — it throws, as a tampered value does.
 * - **A name is HMAC-SHA256** under [nameKey], base64url with no padding. It is
 *   deterministic, which is what still allows a lookup by name, and it keeps a
 *   vault id out of the file the way `EncryptedSharedPreferences`' SIV-sealed
 *   names did.
 *
 * On a phone both keys are generated inside the ANDROID KEYSTORE and never
 * leave it ([AndroidSecureStore]); the keys are parameters so that a JVM test
 * can drive exactly this code with software keys (`SealedEntriesTest` in
 * `:androidApp`'s unit tests). Nothing here reads a platform API.
 */
public class SealedEntries(
    private val valueKey: () -> SecretKey,
    private val nameKey: () -> SecretKey,
) {
    /** The name [logicalName]'s value is stored under. */
    public fun nameOf(logicalName: String): String {
        val mac = Mac.getInstance(HMAC)
        mac.init(nameKey())
        return URL_SAFE.encode(mac.doFinal(logicalName.encodeToByteArray()))
    }

    /** [value] sealed to [logicalName]. Never the same text twice. */
    public fun seal(logicalName: String, value: String): String {
        val cipher = Cipher.getInstance(AEAD)
        // NO NONCE IS SUPPLIED. A Keystore AES key refuses a caller-chosen
        // nonce unless it was generated with randomised encryption turned off;
        // the provider draws one, and it travels in front of the ciphertext.
        cipher.init(Cipher.ENCRYPT_MODE, valueKey())
        cipher.updateAAD(logicalName.encodeToByteArray())
        val nonce = cipher.iv
        check(nonce.size == NONCE_BYTES) { "AES-GCM drew a ${nonce.size}-byte nonce, not $NONCE_BYTES" }
        return Base64.encode(nonce + cipher.doFinal(value.encodeToByteArray()))
    }

    /**
     * The value [sealed] holds for [logicalName].
     *
     * THROWS, never null, on a value that does not open: a tampered value, one
     * moved from another name, or one sealed under a key this phone no longer
     * holds. A `null` here would read as "no credential", and a caller that
     * then mints a fresh one would silently replace this device's identity.
     */
    public fun open(logicalName: String, sealed: String): String {
        val bytes = Base64.decode(sealed)
        require(bytes.size > NONCE_BYTES) { "a sealed entry shorter than its nonce" }
        val cipher = Cipher.getInstance(AEAD)
        cipher.init(
            Cipher.DECRYPT_MODE,
            valueKey(),
            GCMParameterSpec(TAG_BITS, bytes, 0, NONCE_BYTES),
        )
        cipher.updateAAD(logicalName.encodeToByteArray())
        return cipher.doFinal(bytes, NONCE_BYTES, bytes.size - NONCE_BYTES).decodeToString()
    }

    public companion object {
        public const val AEAD: String = "AES/GCM/NoPadding"
        public const val HMAC: String = "HmacSHA256"
        public const val NONCE_BYTES: Int = 12
        public const val TAG_BITS: Int = 128
        private val URL_SAFE = Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT)
    }
}
