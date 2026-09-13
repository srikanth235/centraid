package dev.centraid.shared.platform

import centraid.screen.v1.MediaPermission

/**
 * Everything `commonMain` cannot do for itself (#1020, D-1020-E4).
 *
 * The inventory is v0's five first-party Expo modules —
 * `centraid-{network-status,ocr,storage,tunnel,upload}` — plus the two
 * platform APIs those modules wrapped. That is not a coincidence: the modules
 * exist because those are exactly the things a JavaScript shell could not do,
 * and they are exactly the things `commonMain` cannot do either.
 *
 * Interfaces plus one `expect` factory, rather than an `expect interface` each:
 * the interfaces are the same on every platform (that is the point), and only
 * their construction differs.
 */
public interface PlatformServices {
    public val secureStore: SecureStore
    public val backgroundTasks: BackgroundTasks
    public val networkStatus: NetworkStatus
    public val mediaLibrary: MediaLibrary
    public val ocr: Ocr
}

/** The platform's services. Fakes on the JVM; the real things elsewhere. */
public expect fun platformServices(): PlatformServices

/**
 * Keychain and Keystore (v0's `expo-secure-store` under the `centraid.v1.`
 * prefix, `apps/mobile/src/lib/secure-storage.ts`).
 *
 * Two rules carried over verbatim:
 *
 * * **Setting `""` deletes the item** rather than storing an empty string
 *   (`:39-43`). An empty secret that reads back as present is a credential the
 *   app believes it has.
 * * **[clear] drops every decrypted credential from memory when the app
 *   locks** (`:13-16`). It is a method and not a side effect of locking because
 *   the lifecycle machine has to be able to name it as an effect.
 */
public interface SecureStore {
    public suspend fun read(key: String): String?

    /** An empty [value] DELETES. See the class comment. */
    public suspend fun write(key: String, value: String)

    public suspend fun clear()

    public companion object {
        /** v0's prefix, kept so a migrating device finds its own secrets. */
        public const val PREFIX: String = "centraid.v1."
    }
}

/**
 * BGTaskScheduler on iOS, WorkManager on Android (v0's
 * `expo-background-task`, `docs/mobile-offline.md:208`).
 *
 * **Registration is observable rather than assumed** (`:214`): [register]
 * returns what the platform said, and "Background App Refresh is off" is a
 * sentence a member reads rather than a silent absence of passes.
 */
public interface BackgroundTasks {
    public suspend fun register(): Registration

    public data class Registration(
        public val registered: Boolean,
        /** The platform's verdict, in words a member can read. */
        public val sentence: String,
        /** Why it refused, when it did. Empty when it did not. */
        public val refusal: String = "",
    )
}

/**
 * The real connectivity answer, asked for rather than assumed from a radio
 * (`docs/mobile-offline.md:212`). v0's `centraid-network-status` module.
 */
public interface NetworkStatus {
    public suspend fun current(): Reading

    public data class Reading(
        public val online: Boolean,
        public val metered: Boolean,
        public val charging: Boolean,
        /**
         * True when the platform would not say. NOT the same as offline: the
         * `SeatState.Connectivity` enum keeps them apart for this reason.
         */
        public val platformRefused: Boolean = false,
    )
}

/**
 * The camera roll (v0's `centraid-upload` module and `NATIVE_V0.md:11-19`).
 *
 * Four of v0's rules are in the types rather than in a comment somewhere:
 *
 * * **Exact SHA-256 is identity**; [Asset.perceptualHash] is a duplicates HINT
 *   that never auto-merges, which is why the two fields are named differently
 *   and why only one is called an id.
 * * **A Live Photo's HEIC and its paired MOV share one [Asset.captureGroupId]**,
 *   so a pair is one thing to a grid and two things to an uploader.
 * * **Android motion photos, RAW and burst members pass through as original
 *   bytes with NO inferred grouping** — so [Asset.captureGroupId] is null for
 *   them, and a platform that guessed would be inventing a relationship.
 * * **Vault trash never calls media deletion.** There is no `delete` on this
 *   interface, and that absence is the enforcement.
 */
public interface MediaLibrary {
    public suspend fun permission(): MediaPermission

    public suspend fun requestPermission(): MediaPermission

    /**
     * Enumerate, in pages. Keyset, not offset: a camera roll grows while it is
     * being read.
     */
    public suspend fun page(afterCursor: String?, limit: Int): Page

    public data class Page(public val assets: List<Asset>, public val nextCursor: String?)

    public data class Asset(
        public val localId: String,
        /** Exact SHA-256, hex. THE identity. */
        public val sha256: String,
        public val bytes: Long,
        public val capturedAtIso: String,
        public val capturedUtcOffsetMinutes: Int,
        /** A duplicates hint. Never auto-merges, never an identity. */
        public val perceptualHash: String? = null,
        /** A Live Photo pair. Null for motion photos, RAW and burst members. */
        public val captureGroupId: String? = null,
    )
}

/** On-device text recognition. Wave 4 (v0's `centraid-ocr` module). */
public interface Ocr {
    public suspend fun available(): Boolean

    public suspend fun recognise(imagePath: String): List<String>
}
