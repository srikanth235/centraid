package dev.centraid.shared.platform

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.provider.MediaStore
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import centraid.screen.v1.MediaPermission
import java.security.MessageDigest
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
}

/**
 * Secrets under the `centraid.v1.` prefix, in credential-encrypted storage.
 *
 * v0 put them in `expo-secure-store`, which on Android is a Keystore-wrapped
 * `SharedPreferences`. The prefix is carried over so a device that migrates
 * finds its own secrets, and the file lives in `noBackupFilesDir`'s sibling
 * preferences namespace with **all** app data excluded from Auto Backup and
 * device-to-device transfer (`docs/mobile-offline.md:240-247`).
 */
public class AndroidSecureStore(private val context: Context) : SecureStore {
    private val preferences by lazy {
        context.getSharedPreferences("centraid-secure", Context.MODE_PRIVATE)
    }

    override suspend fun read(key: String): String? =
        preferences.getString(SecureStore.PREFIX + key, null)

    override suspend fun write(key: String, value: String) {
        val name = SecureStore.PREFIX + key
        // AN EMPTY VALUE DELETES (`secure-storage.ts:39-43`).
        preferences.edit().apply { if (value.isEmpty()) remove(name) else putString(name, value) }
            .commit()
    }

    override suspend fun clear() {
        preferences.edit().clear().commit()
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
    override suspend fun current(): NetworkStatus.Reading {
        val manager = context.getSystemService(ConnectivityManager::class.java)
            ?: return NetworkStatus.Reading(
                online = false,
                metered = true,
                charging = false,
                // THE PLATFORM WOULD NOT SAY. Not the same as offline.
                platformRefused = true,
            )
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
                    // EXACT SHA-256 IS IDENTITY. Computed over the bytes, never
                    // derived from the id or the date — two devices that
                    // imported one photo must agree.
                    sha256 = sha256Of(id),
                    bytes = cursor.getLong(1),
                    capturedAtIso = java.time.Instant.ofEpochMilli(cursor.getLong(2)).toString(),
                    capturedUtcOffsetMinutes = 0,
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

    private fun sha256Of(id: String): String {
        val uri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI.buildUpon()
            .appendPath(id)
            .build()
        val digest = MessageDigest.getInstance("SHA-256")
        context.contentResolver.openInputStream(uri)?.use { stream ->
            val buffer = ByteArray(1 shl 16)
            while (true) {
                val read = stream.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { byte -> "%02x".format(byte) }
    }
}

/** Wave 4. ML Kit is not a dependency yet, and saying so beats a stub. */
public class AndroidOcr : Ocr {
    override suspend fun available(): Boolean = false

    override suspend fun recognise(imagePath: String): List<String> = emptyList()
}
