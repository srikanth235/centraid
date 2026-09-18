package dev.centraid.shared.platform

/**
 * THE ONE SECRET THAT IS ALLOWED TO LEAVE THIS DEVICE (#1029 §0, §5, W5B-3).
 *
 * [SecureStore] is deliberately device-only: iOS pins every item with
 * `kSecAttrAccessible…ThisDeviceOnly`, which keeps a seat credential out of the
 * iCloud Keychain and out of an encrypted backup, so a restore cannot hand a
 * seat's identity to a device nobody enrolled.
 *
 * **The seed is the exception, and it is the only one.** It is the thing a
 * member restores FROM, so a seed that could not follow them to a new phone
 * would make the 24 words the only path — and the 24 words are the fallback,
 * not the plan.
 *
 * ## THE TWO PLATFORMS ARE NOT SYMMETRIC, AND THE COPY MUST NOT PRETEND THEY ARE
 *
 * * **iOS**: an iCloud Keychain item (`kSecAttrSynchronizable`) is restored on a
 *   new phone as part of signing in to iCloud. A member who has iCloud Keychain
 *   on gets their vaults back without typing anything.
 * * **Android**: Block Store restores **only during the device-setup flow** —
 *   the new-phone wizard, before the app has ever run. A member who set the
 *   phone up first and installed Centraid afterwards gets nothing back, and
 *   there is no API that changes this. So on Android **the written phrase is
 *   the common path**, and [ANDROID_SENTENCE] says so.
 *
 * Copy that implied parity would be copy that loses somebody their vault, which
 * is why the sentences are here, beside the seam, and not in a per-shell screen.
 *
 * ## WHAT IS NEVER PUT HERE
 *
 * A vault root key, a device key, a seat credential, a gateway token. F5 says
 * no vault-derived path reaches an OS backup, and this seam IS an OS backup.
 * The seed is upstream of every one of those keys — losing it loses everything
 * anyway — so syncing it adds no exposure that the phrase on a member's shelf
 * does not already carry. Syncing a derived key would.
 */
public interface SyncedSecrets {

    /** Whether the platform will synchronise at all right now. */
    public suspend fun availability(): Availability

    /**
     * Store the seed. **Replaces**, so a second call after a re-derivation does
     * not leave two.
     */
    public suspend fun putSeed(seedHex: String): Boolean

    /** The seed this platform has for this member, or null. */
    public suspend fun seed(): String?

    /**
     * Forget it. What "stop syncing my seed" does, and what a member choosing
     * the written phrase alone gets.
     */
    public suspend fun forgetSeed()

    /** What the platform says about synchronising. */
    public data class Availability(
        /** Whether a seed put here would reach another device. */
        public val synchronizing: Boolean,
        /** The sentence a member reads about it. */
        public val sentence: String,
        /**
         * **Whether this platform can restore outside the device-setup flow.**
         *
         * False on Android, and that is not a bug to work around: it is what
         * makes the written phrase the common path there.
         */
        public val restoresAfterSetup: Boolean,
    )

    public companion object {
        /** The key the seed is held under, under [SecureStore]'s own prefix. */
        public const val SEED_KEY: String = "recovery-seed"

        /** iOS, with iCloud Keychain on. */
        public const val IOS_SENTENCE: String =
            "Your key is saved in your iCloud Keychain. Sign in to iCloud on a new iPhone and " +
                "your vaults come back."

        /** iOS, with iCloud Keychain off. */
        public const val IOS_OFF_SENTENCE: String =
            "iCloud Keychain is off, so your key is only on this iPhone. Write down your " +
                "24 words — they are the only way back."

        /**
         * **ANDROID, AND IT SAYS THE UNCOMFORTABLE THING.**
         *
         * Block Store hands the key back during the new-phone setup wizard and
         * at no other time. A member who has already finished setting a phone up
         * needs the words, and finding that out on the day they need it is the
         * failure this sentence exists to prevent.
         */
        public const val ANDROID_SENTENCE: String =
            "Android can hand your key to a new phone during its setup, before you install " +
                "anything. If you set the phone up first, you will need your 24 words. " +
                "Write them down."

        /** When the platform will not say. */
        public const val UNKNOWN_SENTENCE: String =
            "This phone would not say whether your key is saved anywhere else. " +
                "Write down your 24 words."
    }
}
