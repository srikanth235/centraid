package dev.centraid.shared.platform

import centraid.screen.v1.MediaPermission
import dev.centraid.shared.sync.DeleteCapability
import dev.centraid.shared.sync.DeleteOutcome
import dev.centraid.shared.sync.LibraryDeleter
import dev.centraid.shared.sync.ReleasableItem

/**
 * The JVM's platform services: IN-MEMORY FAKES, and they say so
 * (#1020, D-1020-E4).
 *
 * The JVM target exists so the state machines can be proved on a machine with
 * no device. These fakes are what the tests drive; they are not a desktop
 * implementation and they are not a stub pretending to be one. Every method
 * answers the way a *cooperative* platform would, and the tests that need an
 * uncooperative one construct [FakePlatformServices] directly with the answer
 * they want — which is why the class is public and its fields are `var`.
 *
 * A file named `*.jvm.kt` full of `TODO()` would have been the alternative, and
 * it would have turned a JVM test run into a green that proved nothing.
 */
public actual fun platformServices(): PlatformServices = FakePlatformServices()

public class FakePlatformServices(
    override val secureStore: FakeSecureStore = FakeSecureStore(),
    override val backgroundTasks: FakeBackgroundTasks = FakeBackgroundTasks(),
    override val syncedSecrets: FakeSyncedSecrets = FakeSyncedSecrets(),
    override val networkStatus: FakeNetworkStatus = FakeNetworkStatus(),
    override val powerAndLink: FakePowerAndLink = FakePowerAndLink(),
    override val mediaLibrary: FakeMediaLibrary = FakeMediaLibrary(),
    override val ocr: FakeOcr = FakeOcr(),
    // NOT A FAKE, and it is the one member here that must not be. A fake CSPRNG
    // that tested green would prove the opposite of what the test is for, so
    // the JVM actual is the real `java.security.SecureRandom` the tests draw
    // from (#1025 S5).
    override val secureRandom: SecureRandom = JvmSecureRandom(),
    override val clock: FakeDeviceClock = FakeDeviceClock(),
) : PlatformServices

public class FakeSecureStore : SecureStore {
    private val items = mutableMapOf<String, String>()

    public val keys: Set<String> get() = items.keys.toSet()

    /** How many times the app asked for everything to be dropped. */
    public var clears: Int = 0
        private set

    override suspend fun read(key: String): String? = items[SecureStore.PREFIX + key]

    override suspend fun write(key: String, value: String) {
        // AN EMPTY VALUE DELETES (`secure-storage.ts:39-43`). A stored empty
        // string reads back as a credential the app believes it has.
        if (value.isEmpty()) items.remove(SecureStore.PREFIX + key)
        else items[SecureStore.PREFIX + key] = value
    }

    override suspend fun clear() {
        clears += 1
        items.clear()
    }
}

public class FakeBackgroundTasks(
    public var answer: BackgroundTasks.Registration = BackgroundTasks.Registration(
        registered = true,
        sentence = "Centraid catches up in the background.",
    ),
) : BackgroundTasks {
    /** How many times launch registered. `BackgroundSchedulingSpec` holds it at one per open. */
    public var registrations: Int = 0
        private set

    public var resubmits: Int = 0
        private set

    public var nudges: Int = 0
        private set

    /** Every `backlog(start)` call, in order: a run is `[true, false]`. */
    public val backlogs: MutableList<Boolean> = mutableListOf()

    override suspend fun register(): BackgroundTasks.Registration {
        registrations += 1
        return answer
    }

    override fun resubmit() {
        resubmits += 1
    }

    override fun nudge() {
        nudges += 1
    }

    override fun backlog(start: Boolean) {
        backlogs += start
    }
}

/**
 * A link and a charger a test sets. Null is the platform refusing to say,
 * which the pass must read as the expensive answer.
 */
public class FakePowerAndLink(
    public var metered: Boolean? = false,
    public var charging: Boolean? = true,
) : PowerAndLink {
    override fun metered(): Boolean? = metered

    override fun charging(): Boolean? = charging
}

/**
 * A platform that synchronises, ANSWERING AS iOS DOES by default.
 *
 * `restoresAfterSetup` is the field a test flips to stand in for Android, and
 * that is the asymmetry worth having a fake for: it is the one that changes
 * what a member is told.
 */
public class FakeSyncedSecrets(
    public var availability: SyncedSecrets.Availability = SyncedSecrets.Availability(
        synchronizing = true,
        sentence = SyncedSecrets.IOS_SENTENCE,
        restoresAfterSetup = true,
    ),
) : SyncedSecrets {
    private var held: String? = null

    override suspend fun availability(): SyncedSecrets.Availability = availability

    override suspend fun putSeed(seedHex: String): Boolean {
        if (!availability.synchronizing) return false
        held = seedHex
        return true
    }

    override suspend fun seed(): String? = held

    override suspend fun forgetSeed() {
        held = null
    }
}

public class FakeNetworkStatus(
    public var reading: NetworkStatus.Reading = NetworkStatus.Reading(
        online = true,
        metered = false,
        charging = true,
    ),
) : NetworkStatus {
    private val listeners = mutableListOf<(NetworkStatus.Reading) -> Unit>()

    override suspend fun current(): NetworkStatus.Reading = reading

    override fun onChange(listener: (NetworkStatus.Reading) -> Unit) {
        listeners += listener
    }

    /**
     * A test's radio. Assigning [reading] alone does not fire: a fixture that
     * only wants [current] to answer a value should keep doing that. This is
     * the airplane-mode toggle.
     */
    public fun set(next: NetworkStatus.Reading) {
        reading = next
        listeners.toList().forEach { it(next) }
    }
}

public class FakeMediaLibrary(
    public var grant: MediaPermission = MediaPermission.MEDIA_PERMISSION_NOT_ASKED,
    public var grantOnRequest: MediaPermission = MediaPermission.MEDIA_PERMISSION_GRANTED,
    public var assets: List<MediaLibrary.Asset> = emptyList(),
    /**
     * The bytes each resource ref answers with, for the staging half of a
     * backup pass. A ref with no entry answers `Gone` from [open] — which is
     * the REAL case a pass must survive (one the member removed between the
     * page and the read, one outside a LIMITED selection) and not an error.
     */
    public var originals: Map<String, ByteArray> = emptyMap(),
) : MediaLibrary {
    /** Every ref [open] was asked for, in order. */
    public val opened: MutableList<String> = mutableListOf()

    /** Opens that were closed. A pass that leaks a resource fails this. */
    public var closed: Int = 0
        private set

    private val libraryListeners = mutableListOf<() -> Unit>()

    /** Pretend a new photograph was taken while the app is on screen. */
    public fun libraryChanged() {
        libraryListeners.forEach { it() }
    }

    override fun onLibraryChanged(listener: () -> Unit) {
        libraryListeners += listener
    }

    /**
     * Refs whose bytes live only in iCloud: [open] answers `InCloud` for them
     * unless the walker allowed the download.
     */
    public var inCloud: Set<String> = emptySet()

    /** What [render] answers; null, the default, is a platform with no decoder. */
    public var renders: (ref: String, tier: MediaLibrary.Tier) -> ByteArray? = { _, _ -> null }

    /** Every `(ref, allowNetwork)` [open] was asked for, in order. */
    public val asked: MutableList<Pair<String, Boolean>> = mutableListOf()

    /** Every `(ref, tier)` [render] was asked for, in order. */
    public val rendered: MutableList<Pair<String, MediaLibrary.Tier>> = mutableListOf()

    override suspend fun open(ref: String, allowNetwork: Boolean): MediaLibrary.Opened {
        opened += ref
        asked += ref to allowNetwork
        if (ref in inCloud && !allowNetwork) return MediaLibrary.Opened.InCloud
        val bytes = originals[ref] ?: return MediaLibrary.Opened.Gone
        val video = assets.any { asset ->
            asset.resources.any { it.ref == ref && it.role == MediaLibrary.Resource.Role.PAIRED_VIDEO } ||
                (asset.localId == ref && asset.kind == MediaLibrary.Kind.VIDEO)
        }
        return MediaLibrary.Opened.Ready(
            object : MediaLibrary.Original {
                private var at = 0
                override val mediaType: String = if (video) "video/quicktime" else "image/png"

                // PHOTOS STATES NO SIZE, and the fake says so the same way.
                override val bytes: Long = if (statesSize) bytes.size.toLong() else 0L

                override suspend fun read(max: Int): ByteArray {
                    if (at >= bytes.size) return ByteArray(0)
                    val end = minOf(at + max, bytes.size)
                    return bytes.copyOfRange(at, end).also { at = end }
                }

                override suspend fun close() {
                    closed += 1
                }
            },
        )
    }

    /** Whether [open] states a length before the read, as Android does and Photos does not. */
    public var statesSize: Boolean = true

    override suspend fun render(ref: String, tier: MediaLibrary.Tier): ByteArray? {
        rendered += ref to tier
        return renders(ref, tier)
    }

    override suspend fun permission(): MediaPermission = grant

    /** How many times the app asked the OS. A seed that asks is a prompt on attach. */
    public var requests: Int = 0
        private set

    override suspend fun requestPermission(): MediaPermission {
        requests += 1
        grant = grantOnRequest
        return grant
    }

    override suspend fun page(afterCursor: String?, limit: Int): MediaLibrary.Page {
        // Keyset over the local id, as a real enumeration must be: a camera
        // roll grows while it is being read, and an offset would skip or repeat.
        val start = afterCursor?.let { cursor ->
            assets.indexOfFirst { it.localId == cursor } + 1
        } ?: 0
        val window = assets.drop(start).take(limit).map { it.copy(after = it.localId) }
        return MediaLibrary.Page(
            assets = window,
            nextCursor = window.lastOrNull()?.localId ?: afterCursor,
            exhausted = start + window.size >= assets.size,
        )
    }
}

/**
 * The shells' library deleter, as a spec drives it (#1080 A20): the system's
 * confirmation always available, and an answer the spec chooses — by default
 * every item it is handed went.
 */
public class FakeLibraryDeleter(
    public var capability: DeleteCapability = DeleteCapability.SYSTEM_CONFIRMATION,
    public var answer: (List<ReleasableItem>) -> DeleteOutcome = { items ->
        DeleteOutcome(deleted = items.map { it.contentHash }, declined = false, error = null)
    },
) : LibraryDeleter {
    /** Every list [delete] was handed, in order. */
    public val handed: MutableList<List<ReleasableItem>> = mutableListOf()

    override fun capability(): DeleteCapability = capability

    override fun delete(items: List<ReleasableItem>, done: (DeleteOutcome) -> Unit) {
        handed += items
        done(answer(items))
    }
}

public class FakeOcr(public var availability: Boolean = false) : Ocr {
    override suspend fun available(): Boolean = availability

    override suspend fun recognise(imagePath: String): List<String> = emptyList()
}

/**
 * The real `java.security.SecureRandom`. See [FakePlatformServices]'s field.
 */
public class JvmSecureRandom : SecureRandom {
    private val random = java.security.SecureRandom()

    override fun bytes(count: Int): ByteArray = ByteArray(count).also(random::nextBytes)
}

/**
 * A device standing still in one zone (#1046).
 *
 * FIXED, not `TimeZone.getDefault()`: a spec that read the JVM's zone would
 * answer differently on a laptop in London and a runner in UTC, and a spec
 * whose answer depends on where it ran proves nothing. A test that needs a
 * traveller assigns [zone].
 */
public class FakeDeviceClock(
    public var zone: String = "Europe/London",
    /** 2026-06-15T09:00:00Z, a Monday. */
    public var epochMillis: Long = 1_781_514_000_000L,
) : DeviceClock {
    override fun read(): DeviceClock.Reading = DeviceClock.Reading(zone, epochMillis)
}
