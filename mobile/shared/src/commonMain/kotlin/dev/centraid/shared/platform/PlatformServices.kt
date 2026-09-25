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
    // ONE W5 SEAM IS LEFT, AND THE OTHER LEFT WITH ITS DESTINATION
    // (#1029 W18-3, the amendment of 2026-09-21, "Struck").
    //
    // `backgroundTransfers` stood here: a seam onto `NSURLSession`'s background
    // session and a WorkManager upload worker, because the OS was the only
    // thing that could move bytes to an HTTPS endpoint while the app was not
    // running. There is no such endpoint any more — the gateway is the member's
    // own laptop, reached over iroh by a client inside this process — so the
    // seam had nowhere to carry bytes to. `dev.centraid.shared.sync.DrainPass`
    // is what replaced it, and it is `commonMain` because the flow no longer
    // needs anything a platform alone can do.
    //
    // `syncedSecrets` stays for the reason it was always here: the OS is the
    // only thing that can synchronise a secret to a member's next phone.
    public val syncedSecrets: SyncedSecrets
    public val networkStatus: NetworkStatus
    public val mediaLibrary: MediaLibrary
    public val ocr: Ocr
    public val secureRandom: SecureRandom
    public val clock: DeviceClock
}

/**
 * THE DEVICE'S ZONE AND ITS WALL CLOCK, AS PLATFORM FACTS (#1046).
 *
 * `commonMain` has no calendar and no zone database, and keeps none
 * (`sync/Instants.kt`). A read that answers civil time — Agenda's app queries
 * answer every occurrence's `local_start` and the answer's `today` — needs to
 * say WHICH zone, and a founded vault names none, so an empty `tz` is refused
 * rather than read as UTC (`agenda.proto`'s zone rule). The zone is therefore
 * the platform's, stated on every request, and the core does all the
 * arithmetic against its bundled database.
 *
 * **Read at every request, never captured.** A phone crossing a border changes
 * zone while the app is open, and a zone read at launch would place the
 * member's morning in the city they flew out of.
 *
 * [Reading.epochMillis] is here for a BOUND, not a calendar: a read that says
 * "the next fourteen days" needs an instant fourteen days on, which is
 * arithmetic on milliseconds and needs no zone. Which day is TODAY is never
 * derived from it in `commonMain` — the core answers that.
 */
public interface DeviceClock {
    public fun read(): Reading

    public data class Reading(
        /** The IANA name, e.g. `America/New_York`. Never an offset, never empty. */
        public val zone: String,
        /** The wall clock, milliseconds since 1970-01-01T00:00:00Z. */
        public val epochMillis: Long,
    )
}

/** The platform's services. Fakes on the JVM; the real things elsewhere. */
public expect fun platformServices(): PlatformServices

/**
 * Keychain and Keystore.
 *
 * Two rules:
 *
 * * **Setting `""` deletes the item** rather than storing an empty string.
 *   An empty secret that reads back as present is a credential the
 *   app believes it has.
 * * **[clear] drops every decrypted credential from memory when the app
 *   locks**. It is a method and not a side effect of locking because
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

    // THE WINDOW, THE EXPIRY SIGNAL AND THE WAKE REASON LEFT WITH THE PASS
    // (#1029 §1, §6). `window(WakeReason)` existed to bound one `seat.sync`
    // call — its answer became the `SyncWindow` on the command, and
    // `onPlatformExpiration`/`platformExpired` were the second trigger
    // `SyncScheduler` honoured. There is no gateway, no pass and no scheduler,
    // so all three named a shape of work this device no longer does.
    //
    // `register` stays: whether the OS will wake this app at all is a fact a
    // member reads, and it is what W5's background transfers and W10's
    // reminders will register against.

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

    /**
     * Hear the radio move (#1025, R-SHELL-4).
     *
     * `NWPathMonitor` on iOS, `ConnectivityManager.NetworkCallback` on
     * Android. The listener is the airplane-mode journey: a path that stops
     * being satisfied is LOST, one that becomes satisfied again while the
     * member is looking is RESUME. This is not a poll — the platform fires
     * when the path changes, and nothing in the shell holds an interval
     * (D-1025-S7-40).
     *
     * The reading is the same object [current] answers. A listener that
     * treated "the callback fired" as "the gateway is reachable" would be
     * the trap: only a pass may raise reachability.
     */
    public fun onChange(listener: (Reading) -> Unit)

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
