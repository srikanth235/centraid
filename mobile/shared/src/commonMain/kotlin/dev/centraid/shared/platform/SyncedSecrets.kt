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
 * would make the recovery key — the 24 words — the only path, and the words
 * are the fallback, not the plan. **So it goes here without asking**
 * (R-ONBOARD-10): a member is shown their words only where nothing here will
 * hold the key, and keeping it off the keychain is the Backup tab's choice.
 *
 * ## THE TWO PLATFORMS ARE NOT SYMMETRIC, AND THE COPY MUST NOT PRETEND THEY ARE
 *
 * * **iOS**: an iCloud Keychain item (`kSecAttrSynchronizable`) is restored on a
 *   new phone as part of signing in to iCloud. A member who has iCloud Keychain
 *   on gets their vaults back without typing anything.
 * * **Android**: Block Store restores **only during the device-setup flow** —
 *   the new-phone wizard, before the app has ever run. A member who set the
 *   phone up first and installed Centraid afterwards gets nothing back, and
 *   there is no API that changes this, and Auto Backup restores on the same
 *   terms (from the backup picked during setup), so it would add nothing but a
 *   second copy. [ANDROID_SENTENCE] says where the key comes back, and the
 *   Backup tab offers the recovery key for a member who skips that step.
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

    /**
     * A VAULT KEPT ON ITS OWN WORDS (R-1047-E18) synchronises its seed beside
     * the member's, under its own [key] (`VaultSecrets.OWN_SEED_PREFIX` + its
     * entry id, and `VaultSecrets.OWN_SEED_INDEX` naming every entry). The
     * same exception as [putSeed], for the same reason — each is a seed a
     * member restores FROM — and nothing derived. **Replaces.**
     */
    public suspend fun put(key: String, value: String): Boolean

    /** What [put] stored under [key], or null. */
    public suspend fun get(key: String): String?

    /** Forget [key]. */
    public suspend fun remove(key: String)

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
        /**
         * Where the key goes, in the member's words ([IOS_PLACE],
         * [ANDROID_PLACE]) — what the Backup tab names when it says where the
         * key is and offers to keep it off. Empty when [synchronizing] is
         * false: there is nowhere to name.
         */
        public val place: String = "",
    )

    public companion object {
        /** The key the seed is held under, under [SecureStore]'s own prefix. */
        public const val SEED_KEY: String = "recovery-seed"

        /** iOS, with iCloud Keychain on. */
        public const val IOS_SENTENCE: String =
            "Saved in iCloud Keychain. Sign in to iCloud on a new iPhone to restore your vaults."

        /** iOS: where the key goes. */
        public const val IOS_PLACE: String = "iCloud Keychain"

        /** Android: where the key goes (Block Store, end-to-end encrypted). */
        public const val ANDROID_PLACE: String = "Google"

        /** iOS, with iCloud Keychain off. */
        public const val IOS_OFF_SENTENCE: String =
            "iCloud Keychain is off, so your recovery key is only on this iPhone. Save a copy."

        /**
         * **ANDROID, AND IT SAYS THE UNCOMFORTABLE THING.**
         *
         * Block Store hands the key back during the new-phone setup wizard and
         * at no other time. A member who skips the restore there needs the
         * recovery key, and finding that out on the day they need it is the
         * failure this sentence exists to prevent.
         */
        public const val ANDROID_SENTENCE: String =
            "Backed up with Google. It returns when you restore this phone's backup while " +
                "setting up a new one. If you skip that step, you'll need your recovery key."

        /** When the platform will not say. */
        public const val UNKNOWN_SENTENCE: String =
            "Can't tell whether your recovery key is saved elsewhere. Save a copy."
    }
}
