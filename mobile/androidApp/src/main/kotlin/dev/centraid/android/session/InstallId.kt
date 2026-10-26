package dev.centraid.android.session

import android.content.Context
import dev.centraid.android.kit.SecretStores

/**
 * WHICH PHONE A FOLLOWING PASS RUNS ON (#1129, F-K-1): a random id minted once per install, sent
 * with every phone read (`device_id`) so a `local:` link names the device that made it.
 *
 * **Kept in the device secret store and nowhere else** (Keystore-sealed, excluded from Auto Backup
 * and device-to-device transfer), so a new phone mints its own; never in the vault, which is what
 * does travel. Read once per process and then held.
 */
internal object InstallId {
    /** The device store's key, as earlier builds wrote it. */
    private const val KEY = "phone-device-id"

    @Volatile private var held: String? = null

    @Synchronized
    fun of(context: Context): String {
        held?.let { return it }
        val stored = SecretStores.read(context, KEY)?.takeIf { it.isNotBlank() }
        val id = stored ?: ByteArray(16).also(java.security.SecureRandom()::nextBytes)
            .joinToString("") { byte -> (byte.toInt() and 0xff).toString(16).padStart(2, '0') }
            .also { SecretStores.write(context, KEY, it) }
        held = id
        return id
    }
}
