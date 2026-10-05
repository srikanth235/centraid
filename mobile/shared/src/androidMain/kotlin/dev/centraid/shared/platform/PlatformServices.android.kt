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
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import centraid.screen.v1.MediaPermission
import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext

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
 * [AndroidMediaLibrary], `expo-background-task` becomes WorkManager
 * ([AndroidBackgroundTasks]), and `expo-secure-store` becomes the
 * Keystore-backed [AndroidSecureStore].
 */
public actual fun platformServices(): PlatformServices = AndroidPlatform.services()

/**
 * The one piece of global state Android forces, and the loudest possible
 * failure when it is missing.
 *
 * A `Context` cannot be conjured, so the `Application` hands it over once. The
 * error names the call site rather than throwing an NPE three frames deep.
 */
public object AndroidPlatform {
    private var applicationContext: Context? = null

    /**
     * ONE SET OF SERVICES PER PROCESS. [AndroidNetworkStatus] registers a
     * default-network callback when it is built, and Android refuses a
     * process its 101st (`TooManyRequestsException`, fatal): Locker's editor
     * asks for `secureRandom` on every keystroke, and a fresh set per call
     * crashed it mid-typing (#1047 final walk).
     */
    @Volatile private var services: AndroidPlatformServices? = null

    public fun install(context: Context) {
        applicationContext = context.applicationContext
        services = null
    }

    internal fun services(): PlatformServices =
        services ?: synchronized(this) { services ?: AndroidPlatformServices(require()).also { services = it } }

    internal fun require(): Context = applicationContext ?: error(
        "AndroidPlatform.install(context) was never called. Call it from " +
            "CentraidApplication.onCreate() before anything reads " +
            "platformServices() (mobile/androidApp).",
    )
}

public class AndroidPlatformServices(context: Context) : PlatformServices {
    override val secureStore: SecureStore = AndroidSecureStore(context)
    override val syncedSecrets: SyncedSecrets = AndroidSyncedSecrets(context)
    override val backgroundTasks: BackgroundTasks = AndroidBackgroundTasks(context, secureStore)
    override val networkStatus: NetworkStatus = AndroidNetworkStatus(context)
    override val powerAndLink: PowerAndLink = AndroidPowerAndLink(context)
    override val mediaLibrary: MediaLibrary = AndroidMediaLibrary(context)
    override val ocr: Ocr = AndroidOcr()
    override val secureRandom: SecureRandom = AndroidSecureRandom()
    override val clock: DeviceClock = AndroidDeviceClock()
}

/**
 * Secrets under the `centraid.v1.` prefix, sealed with Android Keystore keys
 * into a private `SharedPreferences` file (#1025 S5; the sealing is
 * `docs/decisions.md`'s R-1047-T3, "Android's device-only store without
 * EncryptedSharedPreferences").
 *
 * A PLAIN `SharedPreferences` FILE IS CLEARTEXT — an XML file in the app's data
 * directory, readable by anything that gets the directory (a rooted device, an
 * `adb backup`, a filesystem dump). So nothing is written to it in the clear:
 * [SealedEntries] seals every value with AES-256-GCM, bound to its entry's
 * name, and stores it under an HMAC-SHA256 of that name.
 *
 * BOTH KEYS LIVE IN THE ANDROID KEYSTORE — hardware-backed where the device has
 * a TEE, and never extractable either way — generated on first use under the
 * two aliases below. Neither needs user authentication: the background sync
 * pass reads this device's endpoint key with the screen locked. **All** app
 * data stays excluded from Auto Backup and device-to-device transfer
 * (`docs/mobile-offline.md:240-247`) — the same property `ThisDeviceOnly` buys
 * on the iOS half, since a Keystore key cannot leave the device and a restored
 * file would be undecryptable noise.
 *
 * `EncryptedSharedPreferences`, which stood here, is deprecated with the rest
 * of `androidx.security:security-crypto`. Its file is not read: v0 carries no
 * migration, and a phone that held one starts from an empty store.
 */
public class AndroidSecureStore(private val context: Context) : SecureStore {
    private val preferences by lazy {
        context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
    }

    private val sealing = SealedEntries(
        valueKey = { keystoreKey(VALUE_KEY_ALIAS, KeyProperties.KEY_ALGORITHM_AES) },
        nameKey = { keystoreKey(NAME_KEY_ALIAS, KeyProperties.KEY_ALGORITHM_HMAC_SHA256) },
    )

    override suspend fun read(key: String): String? = withContext(Dispatchers.IO) {
        val name = SecureStore.PREFIX + key
        preferences.getString(sealing.nameOf(name), null)?.let { sealing.open(name, it) }
    }

    override suspend fun write(key: String, value: String) {
        withContext(Dispatchers.IO) {
            val name = SecureStore.PREFIX + key
            val stored = sealing.nameOf(name)
            // AN EMPTY VALUE DELETES (`secure-storage.ts:39-43`). A stored empty
            // string reads back as a credential the app believes it has.
            preferences.edit().apply {
                if (value.isEmpty()) remove(stored) else putString(stored, sealing.seal(name, value))
            }.commit()
        }
    }

    override suspend fun clear() {
        // THE FILE IS THIS STORE'S ALONE, so clearing it is exactly "every item
        // under the prefix" and nothing else's. `commit()` rather than
        // `apply()`: the lifecycle machine names this as an effect of locking,
        // and an effect that has not reached the disk when the process is
        // killed did not happen. The two Keystore keys stay; with no entries
        // they open nothing.
        withContext(Dispatchers.IO) { preferences.edit().clear().commit() }
    }

    private companion object {
        const val FILE_NAME = "centraid-secure-store"

        /**
         * The Keystore entries the file is sealed with. Named rather than
         * defaulted so an owner can see them in `keystore` dumps and so a
         * second store cannot silently share them.
         */
        const val VALUE_KEY_ALIAS = "centraid.v1.secure-store.values"
        const val NAME_KEY_ALIAS = "centraid.v1.secure-store.names"

        private val keyLock = Any()

        /**
         * The Keystore key under [alias], generated on first use. Under a lock,
         * so two first reads cannot each generate one and leave the file sealed
         * under a key the second generation replaced.
         */
        fun keystoreKey(alias: String, algorithm: String): SecretKey = synchronized(keyLock) {
            val keystore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            (keystore.getKey(alias, null) as SecretKey?) ?: KeyGenerator.getInstance(algorithm, ANDROID_KEYSTORE)
                .apply { init(specFor(alias, algorithm)) }
                .generateKey()
        }

        fun specFor(alias: String, algorithm: String): KeyGenParameterSpec =
            if (algorithm == KeyProperties.KEY_ALGORITHM_AES) {
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            } else {
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN).build()
            }

        const val ANDROID_KEYSTORE = "AndroidKeyStore"
    }
}

/**
 * Block Store, and **the sentence that says what it will not do** (#1029 §5).
 *
 * Block Store hands bytes back to a new device during the SETUP WIZARD and at
 * no other time. There is no API that restores them afterwards, so a member who
 * finished setting the phone up and then installed Centraid gets nothing — and
 * on Android the written phrase is therefore the common path, not the fallback.
 * [SyncedSecrets.ANDROID_SENTENCE] is what a member reads, and
 * `restoresAfterSetup = false` is what a screen branches on.
 *
 * `setShouldBackupToCloud(true)` is asked for so the bytes survive a lost phone
 * rather than only a device-to-device transfer; a device with no screen lock
 * refuses it, which is why the answer is read rather than assumed.
 */
public class AndroidSyncedSecrets(private val context: Context) : SyncedSecrets {

    override suspend fun availability(): SyncedSecrets.Availability = try {
        val cloud = Blockstore.getClient(context).isEndToEndEncryptionAvailable.await()
        SyncedSecrets.Availability(
            synchronizing = cloud,
            sentence = SyncedSecrets.ANDROID_SENTENCE,
            // FALSE ON ANDROID, ALWAYS. Not a capability query: it is what the
            // API does, and a build that discovered otherwise would be reading
            // a different API.
            restoresAfterSetup = false,
        )
    } catch (error: Exception) {
        SyncedSecrets.Availability(
            synchronizing = false,
            sentence = SyncedSecrets.UNKNOWN_SENTENCE,
            restoresAfterSetup = false,
        )
    }

    override suspend fun putSeed(seedHex: String): Boolean = try {
        Blockstore.getClient(context).storeBytes(
            StoreBytesData.Builder()
                .setBytes(seedHex.encodeToByteArray())
                .setKey(SyncedSecrets.SEED_KEY)
                .setShouldBackupToCloud(true)
                .build(),
        ).await()
        true
    } catch (error: Exception) {
        false
    }

    override suspend fun seed(): String? = try {
        Blockstore.getClient(context).retrieveBytes(
            RetrieveBytesRequest.Builder()
                .setKeys(listOf(SyncedSecrets.SEED_KEY))
                .build(),
        ).await()
            .blockstoreDataMap[SyncedSecrets.SEED_KEY]
            ?.bytes
            ?.decodeToString()
    } catch (error: Exception) {
        null
    }

    override suspend fun forgetSeed() {
        try {
            Blockstore.getClient(context).deleteBytes(
                com.google.android.gms.auth.blockstore.DeleteBytesRequest.Builder()
                    .setKeys(listOf(SyncedSecrets.SEED_KEY))
                    .build(),
            ).await()
        } catch (error: Exception) {
            // A SEED THAT WOULD NOT DELETE IS NOT AN ERROR A MEMBER CAN ACT ON.
            // The local copy is gone either way, and Block Store's own copy is
            // overwritten by the next `putSeed`.
        }
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

    /**
     * ONE PAGE OF THE ROLL: PHOTOGRAPHS AND VIDEOS (#1025 S6; #1080, the walker).
     *
     * One keyset over `MediaStore.Files` for both media types, on `_ID`.
     * MediaProvider allots `_ID` with `AUTOINCREMENT`, so the keyset finds every
     * item ADDED since the last walk whatever its capture date — the question a
     * change token answers on iOS — and never re-offers one. **The cursor
     * carries the MediaStore version** (API 29+): a rebuilt database numbers its
     * rows again, so a cursor written against another version starts the walk
     * over, and `already_held` makes that walk cheap to the gateway. A cursor a
     * v0 build wrote (a bare `_ID`, over images only) starts over too: the
     * videos below it were never offered.
     *
     * No `LIMIT` in the sort order — Android 11 refuses the token there — so the
     * walk reads one row past the page to learn whether the roll is exhausted.
     */
    override suspend fun page(afterCursor: String?, limit: Int): MediaLibrary.Page {
        val version = storeVersion()
        val after = afterOf(afterCursor, version)
        val projection = arrayOf(
            MediaStore.Files.FileColumns._ID,
            MediaStore.Files.FileColumns.MEDIA_TYPE,
            MediaStore.MediaColumns.SIZE,
            DATE_TAKEN,
            MediaStore.MediaColumns.DATE_ADDED,
        )
        val selection = "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN " +
            "(${MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE}, ${MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO})" +
            " AND ${MediaStore.Files.FileColumns._ID} > ?"
        val assets = mutableListOf<MediaLibrary.Asset>()
        var more = false
        context.contentResolver.query(
            MediaStore.Files.getContentUri(EXTERNAL),
            projection,
            selection,
            arrayOf(after.toString()),
            "${MediaStore.Files.FileColumns._ID} ASC",
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                if (assets.size == limit) {
                    more = true
                    break
                }
                val id = cursor.getLong(0)
                val video = cursor.getInt(1) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
                // DATE_TAKEN is the camera's; an item that never had one (a
                // screenshot on some builds) falls back to when it was added.
                val taken = cursor.getLong(3).takeIf { it > 0L } ?: (cursor.getLong(4) * 1_000L)
                val ref = (if (video) VIDEO_REF else IMAGE_REF) + id
                assets += MediaLibrary.Asset(
                    localId = ref,
                    // NO DIGEST HERE (#1025 S4): the core names the bytes.
                    bytes = cursor.getLong(2),
                    capturedAtIso = java.time.Instant.ofEpochMilli(taken).toString(),
                    capturedUtcOffsetMinutes = 0,
                    kind = if (video) MediaLibrary.Kind.VIDEO else MediaLibrary.Kind.PHOTO,
                    // NO INFERRED GROUPING for motion photos, RAW or burst
                    // members (`NATIVE_V0.md:11-19`): they pass through as
                    // original bytes, and a guess here would invent a
                    // relationship the owner never made.
                    captureGroupId = null,
                    after = cursorOf(version, id),
                )
            }
        }
        return MediaLibrary.Page(
            assets = assets,
            nextCursor = assets.lastOrNull()?.after ?: afterCursor,
            exhausted = !more,
        )
    }

    /**
     * One original's bytes, from `ContentResolver` (#1025 S6; #1080, the walker).
     *
     * **The size is the descriptor's** (`statSize`), never `available()`, which
     * is only what can be read without blocking. **The location is kept**: with
     * `ACCESS_MEDIA_LOCATION` granted (API 29+) the uri asks for the ORIGINAL,
     * so the GPS tags the camera wrote reach the vault byte for byte; without
     * it Android redacts them, and the bytes are still the member's photograph.
     *
     * Android's media store holds what is on the device, so [allowNetwork] has
     * nothing to say here. A refusal is [MediaLibrary.Opened.Gone]:
     * `SecurityException` is the revoked or partial grant, `FileNotFoundException`
     * a row whose file was deleted between the page and this call, and
     * `IOException` a provider that could not produce it — "this one item is
     * not available", never a reason to end a pass.
     */
    override suspend fun open(ref: String, allowNetwork: Boolean): MediaLibrary.Opened {
        val uri = uriOf(ref) ?: return MediaLibrary.Opened.Gone
        // THE RESOLVER'S OWN TYPE, not a guess off the name: the core has no
        // sniffer (`Staging`), so what travels with the bytes has to be the
        // platform's answer.
        val type = context.contentResolver.getType(uri) ?: "application/octet-stream"
        val readable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && keepsLocation()) {
            MediaStore.setRequireOriginal(uri)
        } else {
            uri
        }
        val descriptor = try {
            context.contentResolver.openFileDescriptor(readable, "r")
        } catch (refused: SecurityException) {
            null
        } catch (unsupported: UnsupportedOperationException) {
            null
        } catch (missing: java.io.FileNotFoundException) {
            null
        } catch (failed: java.io.IOException) {
            null
        } ?: return MediaLibrary.Opened.Gone
        // `statSize` IS -1 for a pipe or a socket; zero is "unknown" to the stage door.
        val size = descriptor.statSize.coerceAtLeast(0L)
        val stream = android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor)
        return MediaLibrary.Opened.Ready(
            object : MediaLibrary.Original {
                override val mediaType: String = type
                override val bytes: Long = size

                override suspend fun read(max: Int): ByteArray {
                    val buffer = ByteArray(max)
                    // `read` MAY SHORT-READ WITHOUT BEING AT THE END, so a
                    // single call whose result is smaller than `max` is not a
                    // terminator — only `-1` is.
                    var filled = 0
                    while (filled < max) {
                        val read = stream.read(buffer, filled, max - filled)
                        if (read < 0) break
                        filled += read
                    }
                    return if (filled == 0) ByteArray(0) else buffer.copyOf(filled)
                }

                override suspend fun close() {
                    runCatching { stream.close() }
                }
            },
        )
    }

    /**
     * A derivative drawn by the platform (#1080): `loadThumbnail` (API 29+),
     * upright, scaled to fit the tier's edge, written as JPEG 80 with no
     * metadata. Null below API 29, where the walker stages the original alone.
     */
    override suspend fun render(ref: String, tier: MediaLibrary.Tier): ByteArray? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        val uri = uriOf(ref) ?: return null
        val drawn = try {
            context.contentResolver.loadThumbnail(uri, android.util.Size(tier.longEdge, tier.longEdge), null)
        } catch (failed: java.io.IOException) {
            null
        } catch (refused: SecurityException) {
            null
        } ?: return null
        val longest = maxOf(drawn.width, drawn.height)
        // "CLOSE TO THE REQUESTED SIZE, BUT MAY BE LARGER": fitted here.
        val fitted = if (longest <= tier.longEdge) {
            drawn
        } else {
            val scale = tier.longEdge.toDouble() / longest
            android.graphics.Bitmap.createScaledBitmap(
                drawn,
                (drawn.width * scale).toInt().coerceAtLeast(1),
                (drawn.height * scale).toInt().coerceAtLeast(1),
                true,
            )
        }
        val out = java.io.ByteArrayOutputStream()
        fitted.compress(android.graphics.Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
        return out.toByteArray()
    }

    /** The content uri a ref names; a v0 ref (a bare `_ID`) was always an image. */
    private fun uriOf(ref: String): android.net.Uri? {
        val video = ref.startsWith(VIDEO_REF)
        val id = ref.removePrefix(VIDEO_REF).removePrefix(IMAGE_REF).toLongOrNull() ?: return null
        val base = if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        return android.content.ContentUris.withAppendedId(base, id)
    }

    /** Whether the member let Centraid read where a photograph was taken. */
    private fun keepsLocation(): Boolean =
        context.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** MediaStore's version (API 29+); empty below, where no rebuild can be told apart. */
    private fun storeVersion(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) MediaStore.getVersion(context) else ""

    private fun cursorOf(version: String, id: Long): String = "$VERSIONED|$version|$id"

    /** The `_ID` to walk after: 0 for no cursor, a v0 cursor, or one from another MediaStore version. */
    private fun afterOf(cursor: String?, version: String): Long {
        val parts = cursor?.takeIf { it.startsWith("$VERSIONED|") }?.split('|') ?: return 0L
        if (parts.size != 3 || parts[1] != version) return 0L
        return parts[2].toLongOrNull() ?: 0L
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

    private companion object {
        /** `MediaStore.MediaColumns.DATE_TAKEN`, spelled out: the constant is API 29's. */
        const val DATE_TAKEN = "datetaken"
        const val EXTERNAL = "external"
        const val IMAGE_REF = "image:"
        const val VIDEO_REF = "video:"
        const val VERSIONED = "v"

        /** `crates/media/src/renditions.rs`' quality. */
        const val JPEG_QUALITY = 80
    }
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

/**
 * The device's zone and wall clock (#1046). `TimeZone.getDefault()` is read at
 * every call, not cached: Android updates it when the member crosses a border
 * or changes it in Settings, and a captured value would answer the old one.
 */
public class AndroidDeviceClock : DeviceClock {
    override fun read(): DeviceClock.Reading = DeviceClock.Reading(
        zone = java.util.TimeZone.getDefault().id,
        epochMillis = System.currentTimeMillis(),
    )
}
