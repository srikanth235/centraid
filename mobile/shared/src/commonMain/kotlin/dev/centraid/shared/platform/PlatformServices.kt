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
    // THE OS MOVES BYTES WHILE THE APP IS SUSPENDED, ON iOS ONLY (#1080
    // rulings 1, 2). That seam is `dev.centraid.shared.sync.BackgroundUploads`,
    // installed by the iOS shell rather than built here, because its delegate
    // is a Swift object; every other platform moves bytes in the pass itself.
    //
    // `syncedSecrets` is here because the OS is the only thing that can
    // synchronise a secret to a member's next phone.
    public val syncedSecrets: SyncedSecrets
    public val networkStatus: NetworkStatus
    public val powerAndLink: PowerAndLink
    public val mediaLibrary: MediaLibrary
    public val ocr: Ocr
    public val secureRandom: SecureRandom
    public val clock: DeviceClock
}

/**
 * WHAT A PASS IS TOLD ABOUT THE LINK AND THE CHARGER (#1080, `DrainRequest`).
 *
 * Synchronous and cheap, because it is read at the start of every pass and
 * must not hang one. **Null is "the platform would not say"**, and the pass
 * reads it as the expensive answer — metered, not charging — because a guess
 * wrong towards cheap spends a member's data plan and a guess wrong towards
 * expensive delays a photograph (D-1025-S7-74). That mapping is
 * `dev.centraid.shared.sync.PassConditions.input` and nowhere else.
 */
public interface PowerAndLink {
    /** True on cellular, tethering or Low Data Mode; null when unknown. */
    public fun metered(): Boolean?

    /** True on external power; null when unknown. */
    public fun charging(): Boolean?
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
 * BGTaskScheduler on iOS, WorkManager on Android (#1080, the shells).
 *
 * **Registration is observable rather than assumed**: [register] returns what
 * the platform said, and "Background App Refresh is off" is a sentence a
 * member reads rather than a silent absence of passes. It is called ONCE per
 * launch, by `HomeSession.open`, and `BackgroundSchedulingSpec` counts it.
 *
 * The other three are the shells' to call, and none of them suspends: they
 * are reached from an app-delegate callback, a scene phase or a capture, none
 * of which can await.
 */
public interface BackgroundTasks {
    public suspend fun register(): Registration

    /**
     * Ask for the next window again. iOS: at EVERY background entry and at the
     * end of each pass, because a `BGTaskRequest` is one-shot and a request not
     * resubmitted is the last one. Android: re-enqueues under the rule the
     * member holds now, so a changed rule changes the constraints.
     */
    public fun resubmit()

    /**
     * Something new is worth a window soon: a capture, an import. Android
     * enqueues an expedited one-off; iOS resubmits with no earliest date.
     */
    public fun nudge()

    /**
     * A long run the member asked for ("Back up now") or a backlog is
     * starting ([start] true) or ended. Android runs it as a long-running job
     * with a notification the app supplies; iOS keeps the screen awake while
     * it runs. Idempotent both ways.
     */
    public fun backlog(start: Boolean)

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
 * * **A Live Photo is ONE [Asset] with two [Resource]s** (#1080, the walker):
 *   the still and its paired movie are one place in the walk and two staged
 *   files, committed as two rows sharing one [Asset.captureGroupId], so a pair
 *   is one thing to a grid and two things to the core.
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

    public data class Page(
        public val assets: List<Asset>,
        /** Where the next page starts; null only when this page is empty. */
        public val nextCursor: String?,
        /**
         * NOTHING IS LEFT TO WALK (#1080). Its own field, because "the roll is
         * walked" and "here is where to resume" are two facts: a cursor that
         * went null at the end made every later pass re-walk the last page.
         */
        public val exhausted: Boolean = nextCursor == null,
    )

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
     * **No temporary copy** (#1080 ruling 6): the phone keeps no second copy
     * of what the OS library already holds, so the bytes stream from the
     * library straight into the stage door, which hashes and seals them as
     * they pass. What it could not produce is an [Opened] answer, not a null.
     */
    public suspend fun open(ref: String, allowNetwork: Boolean = true): Opened

    /**
     * What [open] found (#1080, the walker).
     *
     * [ref] is a [Resource.ref]. [allowNetwork] says whether the platform may
     * DOWNLOAD the bytes — an original that lives only in iCloud — and is the
     * walker's to decide from the member's rule and the link: an original the
     * phone does not hold is [InCloud] rather than fetched behind the rule.
     */
    public sealed interface Opened {
        public class Ready(public val original: Original) : Opened

        /** Only in iCloud, and this pass may not download it. It waits; it is never skipped. */
        public data object InCloud : Opened

        /**
         * Removed between the page and the read, outside a LIMITED selection,
         * or refused. **Not an error**: a roll changes under an enumeration,
         * and a shell that threw would end a backup pass over one photograph
         * that moved.
         */
        public data object Gone : Opened
    }

    /**
     * A DERIVATIVE THE PLATFORM DECODED (#1080: the core stores derivatives
     * the phone's own decoder rendered, because it cannot decode HEIC and
     * keeps no copy of a library original to decode later).
     *
     * JPEG at quality 80, the long edge no longer than [Tier.longEdge], drawn
     * from the CURRENT edit, upright, and with no metadata — a thumbnail
     * travels first, over any link, and one carrying a home's coordinates is
     * worse than none. Null when the platform cannot: the walker stages the
     * original either way.
     */
    public suspend fun render(ref: String, tier: Tier): ByteArray? = null

    /** The two derivatives `crates/media/src/renditions.rs` names, at its sizes. */
    public enum class Tier(public val wire: String, public val longEdge: Int) {
        THUMB("thumb", 360),
        PREVIEW("preview", 2048),
    }

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

        /**
         * The resource's own length, or 0 when the platform does not state
         * one before the read — Photos never does. `StageBegin.byte_size`
         * reads 0 as unknown (seam contract A8), so no copy is made to learn it.
         */
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
         * `photo` or `video` — `media.add_asset`'s own vocabulary (#1025 S6),
         * for the asset's ORIGINAL. A Live Photo is a `photo` whose paired
         * movie is its second [Resource], committed as a `video` row in the
         * same [captureGroupId].
         */
        public val kind: Kind = Kind.PHOTO,
        /** A duplicates hint. Never auto-merges, never an identity. */
        public val perceptualHash: String? = null,
        /** A Live Photo pair. Null for motion photos, RAW and burst members. */
        public val captureGroupId: String? = null,
        /**
         * WHAT IS STAGED FOR IT, in order (#1080, the walker): the camera's
         * original first, then a Live Photo's paired movie. Each [Resource.ref]
         * is what [open] reads and what the core keeps as the item's
         * `os_ref`, so it must find the same bytes again after a relaunch.
         */
        public val resources: List<Resource> = listOf(Resource(Resource.Role.ORIGINAL, localId)),
        /**
         * The cursor that resumes AFTER this asset: everything up to and
         * including it has been offered. Null when the platform cannot resume
         * mid-page; the page's own [Page.nextCursor] then covers it.
         */
        public val after: String? = null,
    )

    /** One file of an [Asset]. */
    public data class Resource(public val role: Role, public val ref: String) {
        public enum class Role {
            /**
             * The camera's own bytes — never an edit's render, which changes
             * when the member edits again and so could not be found by its
             * `os_ref` a second time.
             */
            ORIGINAL,

            /** A Live Photo's movie. */
            PAIRED_VIDEO,
        }
    }

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
