package dev.centraid.shared.sync.phone

import dev.centraid.shared.platform.PlatformServices
import dev.centraid.shared.platform.platformServices
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * WHICH PHONE A FOLLOWING PASS RUNS ON (#1129, F-K-1): a random id minted once per install.
 *
 * A `local:` phone id means something on one device only (R-1127-10), so a link made for one names
 * the device that made it (`phone_link.device_id`), and an origin names the device that last read
 * it present. A vault restored onto a new phone then holds the old phone's links under the old
 * phone's id, and the new phone re-finds them by match instead of taking their absence for deletes.
 *
 * **Kept in [PlatformServices.secureStore], and nowhere else**: the iOS Keychain under
 * `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and Android's Keystore-sealed file, whose app
 * data is excluded from Auto Backup and device-to-device transfer. Neither travels with an iCloud
 * or Google restore or a device-to-device move, which is the whole point: a new phone mints its own.
 * **Never in the vault**, which is exactly what does travel. A reinstall that loses the store on the
 * same phone mints a new id; that phone's links are then another device's once, and are re-found by
 * match like a new phone's (nothing is trashed, nothing added twice).
 *
 * Read once per process and then held: a pass asks on every run, and the answer cannot change
 * under a running app.
 */
public object PhoneDevice {
    /** The secure store's key ([dev.centraid.shared.platform.SecureStore.PREFIX] is added by the store). */
    public const val KEY: String = "phone-device-id"

    private val lock = Mutex()
    private var held: String? = null

    /** This install's id, minted and stored on the first ask. */
    public suspend fun id(): String = lock.withLock { held ?: read(platformServices()).also { held = it } }

    /**
     * The id [services] hold, minted and stored when they hold none: 16 bytes of the platform's
     * CSPRNG, as hex. Not held, so a test reads a fresh platform's.
     */
    public suspend fun read(services: PlatformServices): String {
        services.secureStore.read(KEY)?.takeIf { it.isNotBlank() }?.let { return it }
        val minted = services.secureRandom.bytes(BYTES).joinToString("") { byte ->
            (byte.toInt() and 0xff).toString(16).padStart(2, '0')
        }
        services.secureStore.write(KEY, minted)
        return minted
    }

    private const val BYTES: Int = 16
}
