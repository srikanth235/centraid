package dev.centraid.shared.platform

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.provider.MediaStore
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import centraid.screen.v1.MediaPermission
import java.util.concurrent.TimeUnit

/**
 * Android's platform services (#1020, D-1020-E4).
 *
 * **NOT COMPILED IN CI TODAY.** There is no Android SDK on the machines that
 * run `cargo xtask gate`, so `-Pcentraid.android=true` is off and this file is
 * not on any compilation's source path. What proves it is the owner hand-off in
 * `mobile/README.md`; the receipt says so rather than implying a green.
 *
 * The mapping is v0's, module for module: `centraid-network-status` becomes
 * [AndroidNetworkStatus], `centraid-upload`'s enumeration becomes
 * [AndroidMediaLibrary], `expo-background-task` becomes WorkManager, and
 * `expo-secure-store` becomes the Keystore-backed [AndroidSecureStore].
 */
public actual fun platformServices(): PlatformServices =
    AndroidPlatformServices(AndroidPlatform.require())

/**
 * The one piece of global state Android forces, and the loudest possible
 * failure when it is missing.
 *
 * A `Context` cannot be conjured, so the `Application` hands it over once. The
 * error names the call site rather than throwing an NPE three frames deep.
 */
public object AndroidPlatform {
    private var applicationContext: Context? = null

    public fun install(context: Context) {
        applicationContext = context.applicationContext
    }

    internal fun require(): Context = applicationContext ?: error(
        "AndroidPlatform.install(context) was never called. Call it from " +
            "CentraidApplication.onCreate() before anything reads " +
            "platformServices() (mobile/androidApp).",
    )
}

public class AndroidPlatformServices(context: Context) : PlatformServices {
    override val secureStore: SecureStore = AndroidSecureStore(context)
    override val backgroundTasks: BackgroundTasks = AndroidBackgroundTasks(context)
    override val networkStatus: NetworkStatus = AndroidNetworkStatus(context)
    override val mediaLibrary: MediaLibrary = AndroidMediaLibrary(context)
    override val ocr: Ocr = AndroidOcr()
    override val secureRandom: SecureRandom = AndroidSecureRandom()
}

/**
 * Secrets under the `centraid.v1.` prefix, in `EncryptedSharedPreferences`
 * (#1025 S5).
 *
 * THIS WAS A PLAIN `SharedPreferences` FILE. The comment said "Keystore-wrapped"
 * and the code called `getSharedPreferences(..., MODE_PRIVATE)`, which is an XML
 * file in the app's data directory in CLEARTEXT — readable by anything that
 * gets the directory (a rooted device, an `adb backup`, a filesystem dump). It
 * was the Android twin of the `NSUserDefaults` stand-in that the iOS half
 * refused to write, except this one shipped.
 *
 * v0 put them in `expo-secure-store`, which on Android is a Keystore-wrapped
 * `SharedPreferences`, and this is that: a [MasterKey] generated inside the
 * ANDROID KEYSTORE — hardware-backed where the device has a TEE, and never
 * extractable either way — wrapping AES256-SIV key names and AES256-GCM values.
 * Deterministic SIV on the key names is what still allows a lookup by name;
 * GCM on the values is what makes a value unreadable and untamperable without
 * the Keystore. The prefix is carried over so a device that migrates finds its
 * own secrets, and **all** app data stays excluded from Auto Backup and
 * device-to-device transfer (`docs/mobile-offline.md:240-247`) — the same
 * property `ThisDeviceOnly` buys on the iOS half, since a Keystore key cannot
 * leave the device and a restored file would be undecryptable noise.
 *
 * **UNVERIFIED BY ANY COMPILER IN THIS REPOSITORY.** There is no Android SDK
 * here, so `-Pcentraid.android=true` is off and this file is on no compilation's
 * source path. It is written against the same two rules the iOS half now proves,
 * and `mobile/README.md`'s owner hand-off is what turns it green.
 */
public class AndroidSecureStore(private val context: Context) : SecureStore {
    private val preferences by lazy {
        EncryptedSharedPreferences.create(
            context,
            "centraid-secure",
            MasterKey.Builder(context, MASTER_KEY_ALIAS)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    override suspend fun read(key: String): String? =
        preferences.getString(SecureStore.PREFIX + key, null)

    override suspend fun write(key: String, value: String) {
        val name = SecureStore.PREFIX + key
        // AN EMPTY VALUE DELETES (`secure-storage.ts:39-43`). A stored empty
        // string reads back as a credential the app believes it has.
        preferences.edit().apply { if (value.isEmpty()) remove(name) else putString(name, value) }
            .commit()
    }

    override suspend fun clear() {
        // THE FILE IS THIS STORE'S ALONE, so clearing it is exactly "every item
        // under the prefix" and nothing else's. `commit()` rather than
        // `apply()`: the lifecycle machine names this as an effect of locking,
        // and an effect that has not reached the disk when the process is
        // killed did not happen.
        preferences.edit().clear().commit()
    }

    private companion object {
        /**
         * The Keystore entry the preferences file is wrapped with. Named rather
         * than defaulted so an owner can see it in `keystore` dumps and so a
         * second store cannot silently share it.
         */
        const val MASTER_KEY_ALIAS = "centraid.v1.secure-store"
    }
}

public class AndroidBackgroundTasks(private val context: Context) : BackgroundTasks {

    override suspend fun register(): BackgroundTasks.Registration = try {
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            WORK_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<androidx.work.Worker>(15, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder()
                        // Wi-Fi and charger rules are queried before each item
                        // as well; these are WorkManager's own floor.
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .build(),
        )
        BackgroundTasks.Registration(
            registered = true,
            sentence = "Centraid catches up in the background.",
        )
    } catch (error: IllegalStateException) {
        // OBSERVABLE, NOT ASSUMED (`docs/mobile-offline.md:214`).
        BackgroundTasks.Registration(
            registered = false,
            sentence = "Centraid cannot catch up in the background on this device.",
            refusal = error.message ?: "WorkManager refused",
        )
    }

    private companion object {
        const val WORK_NAME = "centraid-sync-pass"
    }
}

public class AndroidNetworkStatus(private val context: Context) : NetworkStatus {
    private val listeners = mutableListOf<(NetworkStatus.Reading) -> Unit>()

    init {
        // THE RADIO IS A STREAM (#1025, R-SHELL-4). `current()` is still a
        // question; airplane mode off is an event, and a snapshot asked later
        // is how the header stayed "synced" until the member tapped Sync now.
        val manager = context.getSystemService(ConnectivityManager::class.java)
        manager?.registerDefaultNetworkCallback(
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = emit()
                override fun onLost(network: Network) = emit()
                override fun onUnavailable() = emit()
                override fun onCapabilitiesChanged(
                    network: Network,
                    networkCapabilities: NetworkCapabilities,
                ) = emit()

                private fun emit() {
                    val reading = snapshot(manager)
                    listeners.toList().forEach { it(reading) }
                }
            },
        )
    }

    override suspend fun current(): NetworkStatus.Reading {
        val manager = context.getSystemService(ConnectivityManager::class.java)
            ?: return NetworkStatus.Reading(
                online = false,
                metered = true,
                charging = false,
                // THE PLATFORM WOULD NOT SAY. Not the same as offline.
                platformRefused = true,
            )
        return snapshot(manager)
    }

    override fun onChange(listener: (NetworkStatus.Reading) -> Unit) {
        listeners += listener
    }

    private fun snapshot(manager: ConnectivityManager): NetworkStatus.Reading {
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork)
        val battery = context.getSystemService(BatteryManager::class.java)
        return NetworkStatus.Reading(
            online = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                ?: false,
            metered = capabilities
                ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) != true,
            charging = battery?.isCharging ?: false,
            platformRefused = capabilities == null && manager.activeNetwork != null,
        )
    }
}

public class AndroidMediaLibrary(private val context: Context) : MediaLibrary {
    override suspend fun permission(): MediaPermission {
        val name = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
        return when (context.checkSelfPermission(name)) {
            PackageManager.PERMISSION_GRANTED -> MediaPermission.MEDIA_PERMISSION_GRANTED
            // Android 14's partial access is the same fact as iOS's limited
            // selection, and it gets the same value rather than a fifth one.
            else -> if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
                context.checkSelfPermission(
                    Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
                ) == PackageManager.PERMISSION_GRANTED
            ) {
                MediaPermission.MEDIA_PERMISSION_LIMITED
            } else {
                MediaPermission.MEDIA_PERMISSION_DENIED
            }
        }
    }

    /**
     * The REQUEST belongs to an Activity, not to a library object: Android's
     * permission result arrives through an `ActivityResultLauncher`. So this
     * reads the current grant and the app's own launcher is what asks —
     * `mobile/androidApp` wires it, and a library that pretended to ask would
     * return a stale answer forever.
     */
    override suspend fun requestPermission(): MediaPermission = permission()

    override suspend fun page(afterCursor: String?, limit: Int): MediaLibrary.Page {
        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.SIZE,
            MediaStore.Images.Media.DATE_TAKEN,
        )
        val assets = mutableListOf<MediaLibrary.Asset>()
        // KEYSET, NOT OFFSET: a camera roll grows while it is being read, and
        // an offset page boundary silently repeats or drops.
        val selection = afterCursor?.let { "${MediaStore.Images.Media._ID} > ?" }
        context.contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            projection,
            selection,
            afterCursor?.let { arrayOf(it) },
            "${MediaStore.Images.Media._ID} ASC LIMIT $limit",
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                val id = cursor.getLong(0).toString()
                assets += MediaLibrary.Asset(
                    localId = id,
                    // NO DIGEST HERE (#1025 S4): the core names the bytes. See
                    // `MediaLibrary.Asset`.
                    bytes = cursor.getLong(1),
                    capturedAtIso = java.time.Instant.ofEpochMilli(cursor.getLong(2)).toString(),
                    capturedUtcOffsetMinutes = 0,
                    // A `MediaStore.Images` query returns images and nothing
                    // else, so the kind is not a guess here.
                    kind = MediaLibrary.Kind.PHOTO,
                    // NO INFERRED GROUPING for motion photos, RAW or burst
                    // members (`NATIVE_V0.md:11-19`): they pass through as
                    // original bytes, and a guess here would invent a
                    // relationship the owner never made.
                    captureGroupId = null,
                )
            }
        }
        return MediaLibrary.Page(assets, assets.lastOrNull()?.localId)
    }

    /**
     * The original's bytes, from `ContentResolver` (#1025 S6, D-1025-S7-71).
     *
     * `openInputStream` and not `openFileDescriptor`: the resolver is what
     * applies the grant, so an asset outside Android 14's partial selection
     * refuses HERE rather than handing back a descriptor that reads zero bytes.
     *
     * A refusal answers NULL. `SecurityException` is the revoked or partial
     * grant, `FileNotFoundException` is a row whose file the member deleted
     * between the page and this call, and `IOException` covers a
     * cloud-backed provider that could not produce the file — all three are
     * "this one photograph is not available", which is an ordinary event in a
     * roll that changes under an enumeration and never a reason to end a pass.
     */
    override suspend fun open(localId: String): MediaLibrary.Original? {
        val uri = android.content.ContentUris.withAppendedId(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            localId.toLongOrNull() ?: return null,
        )
        // THE RESOLVER'S OWN TYPE, not a guess off the name: the core has no
        // sniffer (`Staging`), so what travels with the bytes has to be the
        // platform's answer.
        val type = context.contentResolver.getType(uri) ?: "application/octet-stream"
        val stream = try {
            context.contentResolver.openInputStream(uri)
        } catch (refused: SecurityException) {
            null
        } catch (missing: java.io.FileNotFoundException) {
            null
        } catch (failed: java.io.IOException) {
            null
        } ?: return null
        val size = try {
            stream.available().toLong()
        } catch (failed: java.io.IOException) {
            0L
        }
        return object : MediaLibrary.Original {
            override val mediaType: String = type
            override val bytes: Long = size

            override suspend fun read(max: Int): ByteArray {
                val buffer = ByteArray(max)
                // `read` MAY SHORT-READ WITHOUT BEING AT THE END, so a single
                // call whose result is smaller than `max` is not a terminator —
                // only `-1` is. Treating a short read as the end would stage a
                // truncated photograph under a hash the core would then
                // faithfully commit.
                var filled = 0
                while (filled < max) {
                    val read = stream.read(buffer, filled, max - filled)
                    if (read < 0) break
                    filled += read
                }
                return if (filled == 0) ByteArray(0) else buffer.copyOf(filled)
            }

            override suspend fun close() {
                stream.close()
            }
        }
    }

    /**
     * Android publishes no foreground change signal this seam can use.
     *
     * `ContentObserver` on the `MediaStore` uri is the nearest thing and it is
     * not the same fact — it fires for every edit, delete and thumbnail write
     * the whole device makes, and a backup that re-enumerated on each would
     * walk the roll all day. Nothing is lost: the cursor pass is what finds new
     * captures on this platform, and it finds them exactly once.
     */
    override fun onLibraryChanged(listener: () -> Unit): Unit = Unit
}

/** Wave 4. ML Kit is not a dependency yet, and saying so beats a stub. */
public class AndroidOcr : Ocr {
    override suspend fun available(): Boolean = false

    override suspend fun recognise(imagePath: String): List<String> = emptyList()
}

/**
 * `java.security.SecureRandom`, NOT `kotlin.random.Random` (#1025 S5).
 *
 * The platform default is seeded from the kernel's entropy pool; Kotlin's is a
 * `XorWowRandom` seeded from the clock, which on a device that boots into the
 * same second twice is the same key twice.
 */
public class AndroidSecureRandom : SecureRandom {
    private val random = java.security.SecureRandom()

    override fun bytes(count: Int): ByteArray = ByteArray(count).also(random::nextBytes)
}
