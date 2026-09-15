package dev.centraid.shared.platform

import centraid.screen.v1.MediaPermission
import dev.centraid.shared.sync.WakeReason

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
    public val secureRandom: SecureRandom
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
 * The platform's CSPRNG (#1025 S5).
 *
 * A PLATFORM SEAM BECAUSE `commonMain` HAS NO CRYPTOGRAPHIC RNG.
 * `kotlin.random.Random` is a `XorWowRandom` seeded from the clock — a fine
 * shuffler and not a key source — so a `commonMain` implementation would look
 * right and mint guessable secrets. The shell mints this device's per-vault
 * endpoint secret key here (32 bytes, kept in [SecureStore], handed to
 * `centraid_open` as `endpointSecretKey`), which is what makes a relaunched
 * seat still the enrolled one.
 *
 * The JVM actual is a REAL `java.security.SecureRandom` rather than a fake:
 * this is the one service whose fake passing green would prove the opposite of
 * what the test is for.
 */
public interface SecureRandom {
    /** Exactly [count] unpredictable bytes, or a throw. Never a short draw. */
    public fun bytes(count: Int): ByteArray
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

    /**
     * THE WINDOW THIS PLATFORM ALLOWS A PASS WOKEN THIS WAY (#1025 S5).
     *
     * `LifecycleState.BUDGET_MS = 20_000` used to answer this, and a constant
     * cannot: a foreground "sync now" has no expiry at all, an iOS
     * `BGAppRefreshTask` has one iOS chose, and an Android `ListenableWorker`
     * is stopped when WorkManager's own budget runs out. The answer is per
     * [dev.centraid.shared.sync.WakeReason] for that reason — a foreground
     * pass must not be handed a background number.
     *
     * **IT IS A STATEMENT, NOT A MEASUREMENT**, and [PlatformWindow.source]
     * says whose. [platformExpired] is the authority; see there.
     */
    public suspend fun window(wake: WakeReason): PlatformWindow

    /**
     * Hear the platform's OWN expiry signal.
     *
     * Registered here and not in each shell because the two signals —
     * `BGAppRefreshTask.expirationHandler` on iOS, `ListenableWorker`'s stop
     * on Android — say one thing, and a listener per shell is a listener one
     * shell forgets. The runner turns each call into
     * `LifecycleEvent.PlatformExpirationWarning`, which `SyncScheduler`
     * already honours as a second, independent trigger.
     */
    public fun onPlatformExpiration(listener: () -> Unit)

    /**
     * THE CALL THE APP'S TASK HANDLER MAKES. Named, and on the interface, so
     * that the seam is one symbol on both platforms:
     *
     * * **iOS** — the app registers the launch handler (`shared` cannot:
     *   `BGTaskScheduler.register(forTaskWithIdentifier:using:launchHandler:)`
     *   must run before the app finishes launching, from the app delegate).
     *   Inside it, `task.expirationHandler = { backgroundTasks.platformExpired() }`.
     * * **Android** — the `ListenableWorker` running the pass calls it from
     *   `onStopped()`, where `getStopReason()` is also available.
     *
     * Either call is the OS speaking about the time it actually has left, and
     * on iOS it is the ONLY such statement: there is no API for the remaining
     * time on a `BGAppRefreshTask`, so [window]'s number is the documented
     * duration of the class and never a reading off a clock the OS owns.
     */
    public fun platformExpired()

    public data class Registration(
        public val registered: Boolean,
        /** The platform's verdict, in words a member can read. */
        public val sentence: String,
        /** Why it refused, when it did. Empty when it did not. */
        public val refusal: String = "",
    )

    /**
     * How long this platform says a pass woken this way has.
     *
     * [source] is carried beside the number because the two platforms know it
     * differently and a reader deciding whether to trust the number needs to
     * be told which: iOS's is Apple's documented duration for the task class,
     * Android's is WorkManager's ten-minute execution window, and a foreground
     * window is bounded only by the member closing the app.
     */
    public data class PlatformWindow(
        public val deadlineMs: Long,
        /** Where the number came from. Never "measured" on iOS. */
        public val source: String,
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
     *
     * **[afterCursor] IS DURABLE AND OPAQUE** (#1025 S6, D-1025-S7-70). The
     * shell writes the last page's [Page.nextCursor] down and hands it back
     * after a relaunch, so re-enumeration resumes instead of walking the roll
     * from the start and offering every photograph again. What it spells is the
     * platform's: iOS pairs the `localIdentifier` with the `creationDate`
     * because `creationDate` alone is not unique across a burst, and Android
     * uses `MediaStore`'s `_ID`. Nothing above this interface parses it.
     */
    public suspend fun page(afterCursor: String?, limit: Int): Page

    public data class Page(public val assets: List<Asset>, public val nextCursor: String?)

    /**
     * OPEN ONE ORIGINAL'S BYTES, AS A STREAM (#1025 S6, D-1025-S7-71).
     *
     * The seam had no byte door at all: it could describe a camera roll and
     * never hand one photograph over, so `Staging` — the door the core hashes
     * behind — had no caller on any platform and a phone could not upload.
     *
     * A STREAM AND NOT A `ByteArray`, for `Staging.stage`'s reason: a 4K video
     * is the ordinary case on a phone and a call that answered the whole thing
     * would hold it in memory to hand it to a door whose whole point is that it
     * never does. [Original.read] has exactly `Staging`'s shape so the two
     * compose with no buffer between them.
     *
     * Null when the platform will not produce the bytes — an asset only in
     * iCloud with no network, one the member removed between the page and the
     * read, or one outside a LIMITED selection. **Not an error**: a roll changes
     * under an enumeration, and a shell that threw would end a backup pass over
     * one photograph that moved.
     */
    public suspend fun open(localId: String): Original?

    /**
     * One original, open. [close] is owed on every path, including a refusal
     * part-way through: on iOS this holds a `PHAssetResourceManager` request
     * and on Android an open file descriptor.
     */
    public interface Original {
        /**
         * WHAT THE CORE IS TOLD THE BYTES ARE. The core has no sniffer
         * (`Staging`), so this travels with them, and it is the PLATFORM's
         * answer — a uniform type identifier mapped to its MIME spelling —
         * rather than a guess off the filename.
         */
        public val mediaType: String

        /** The resource's own length, which may differ from [Asset.bytes]. */
        public val bytes: Long

        /** The next slice, at most [max] bytes. An EMPTY array means the end. */
        public suspend fun read(max: Int): ByteArray

        public suspend fun close()
    }

    /**
     * Hear about new captures while the app is on screen (#1025 S6).
     *
     * `PHPhotoLibraryChangeObserver` on iOS. Foreground only, deliberately: a
     * background pass is the ordinary enumeration from the durable cursor, and
     * an observer that tried to run while the app is suspended would be a
     * second, weaker copy of the thing the cursor already does correctly.
     *
     * A platform with no such signal registers nothing and loses nothing.
     */
    public fun onLibraryChanged(listener: () -> Unit) {
        // Default: this platform has no change signal. The cursor pass covers it.
    }

    /**
     * One original in the roll, as the PLATFORM describes it.
     *
     * **There is no digest here** (#1025 S4, D-1025-S4-6). This carried a
     * `sha256` documented as "THE identity", and it was not one: the identity of
     * a member's bytes is `core_content_item.content_hash`, which is BLAKE3 and
     * is UNIQUE — and neither `CryptoKit` nor `MessageDigest` offers BLAKE3, so
     * the shell was computing a different function and calling it by the vault's
     * name. Enrolling an asset means streaming its bytes into the core through
     * the staging door (`centraid.core.v1.StageRequest`), which answers the
     * handle. `localId` is what this interface identifies an asset by, and it is
     * the platform's own id, which is all a shell needs to open it again.
     */
    public data class Asset(
        public val localId: String,
        public val bytes: Long,
        public val capturedAtIso: String,
        public val capturedUtcOffsetMinutes: Int,
        /**
         * `photo` or `video` — `media.add_asset`'s own vocabulary (#1025 S6).
         *
         * Carried because the command takes it and the gateway's fallback is a
         * guess off the media type. A Live Photo is TWO assets here, a `photo`
         * and a `video` sharing one [captureGroupId], which is what the field
         * below means.
         */
        public val kind: Kind = Kind.PHOTO,
        /** A duplicates hint. Never auto-merges, never an identity. */
        public val perceptualHash: String? = null,
        /** A Live Photo pair. Null for motion photos, RAW and burst members. */
        public val captureGroupId: String? = null,
    )

    /**
     * `media_asset.kind`'s two values a camera roll can produce.
     *
     * `audio` and `scan` are not here because a camera roll does not make them:
     * they reach the vault through the voice memo and document doors.
     */
    public enum class Kind(public val wire: String) {
        PHOTO("photo"),
        VIDEO("video"),
    }
}

/** On-device text recognition. Wave 4 (v0's `centraid-ocr` module). */
public interface Ocr {
    public suspend fun available(): Boolean

    public suspend fun recognise(imagePath: String): List<String>
}
