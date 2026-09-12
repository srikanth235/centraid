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
    override suspend fun current(): NetworkStatus.Reading = reading
}

public class FakeMediaLibrary(
    public var grant: MediaPermission = MediaPermission.MEDIA_PERMISSION_NOT_ASKED,
    public var grantOnRequest: MediaPermission = MediaPermission.MEDIA_PERMISSION_GRANTED,
    public var assets: List<MediaLibrary.Asset> = emptyList(),
) : MediaLibrary {
    override suspend fun permission(): MediaPermission = grant

    override suspend fun requestPermission(): MediaPermission {
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
