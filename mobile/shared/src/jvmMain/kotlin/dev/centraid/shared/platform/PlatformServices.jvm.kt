package dev.centraid.shared.platform

import centraid.screen.v1.MediaPermission

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
    override val networkStatus: FakeNetworkStatus = FakeNetworkStatus(),
    override val mediaLibrary: FakeMediaLibrary = FakeMediaLibrary(),
    override val ocr: FakeOcr = FakeOcr(),
    // NOT A FAKE, and it is the one member here that must not be. A fake CSPRNG
    // that tested green would prove the opposite of what the test is for, so
    // the JVM actual is the real `java.security.SecureRandom` the tests draw
    // from (#1025 S5).
    override val secureRandom: SecureRandom = JvmSecureRandom(),
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
    public var registrations: Int = 0
        private set

    override suspend fun register(): BackgroundTasks.Registration {
        registrations += 1
        return answer
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
     * The bytes each `localId` answers with, for the staging half of a backup
     * pass. An id with no entry answers null from [open] — which is the REAL
     * case a pass must survive (an iCloud-only asset, one the member removed
     * between the page and the read, one outside a LIMITED selection) and not
     * an error.
     */
    public var originals: Map<String, ByteArray> = emptyMap(),
) : MediaLibrary {
    /** Every `localId` [open] was asked for, in order. */
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

    override suspend fun open(localId: String): MediaLibrary.Original? {
        opened += localId
        val bytes = originals[localId] ?: return null
        val asset = assets.firstOrNull { it.localId == localId }
        return object : MediaLibrary.Original {
            private var at = 0
            override val mediaType: String =
                if (asset?.kind == MediaLibrary.Kind.VIDEO) "video/quicktime" else "image/png"
            override val bytes: Long = bytes.size.toLong()

            override suspend fun read(max: Int): ByteArray {
                if (at >= bytes.size) return ByteArray(0)
                val end = minOf(at + max, bytes.size)
                return bytes.copyOfRange(at, end).also { at = end }
            }

            override suspend fun close() {
                closed += 1
            }
        }
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
        val window = assets.drop(start).take(limit)
        return MediaLibrary.Page(window, window.lastOrNull()?.localId.takeIf {
            start + window.size < assets.size
        })
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
