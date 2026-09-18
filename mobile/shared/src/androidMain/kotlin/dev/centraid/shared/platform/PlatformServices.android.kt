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
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import centraid.screen.v1.MediaPermission
import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit
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
    override val backgroundTransfers: BackgroundTransfers = AndroidBackgroundTransfers(context)
    override val syncedSecrets: SyncedSecrets = AndroidSyncedSecrets(context)
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

/**
 * **THE PASS THE OS RUNS, AND IT IS A CONCRETE CLASS** (#1029 W5B-2).
 *
 * What stood here scheduled `PeriodicWorkRequestBuilder<androidx.work.Worker>`
 * — the ABSTRACT base class. WorkManager instantiates a worker reflectively by
 * name and `androidx.work.Worker` has no runnable body, so that request could
 * never run: it was accepted, it appeared in `WorkManager`'s own diagnostics as
 * enqueued, and every execution failed inside the framework. A registration
 * that reports success and can never do the work is worse than no registration,
 * because the member is told Centraid catches up in the background.
 *
 * A `CoroutineWorker` rather than a `Worker`: the pass is suspending all the
 * way down (the ABI door, the gateway client, the spool), and a `Worker` would
 * mean blocking a WorkManager thread on a network round trip.
 *
 * ## WHAT IT ACTUALLY DOES IS INSTALLED, NOT HARD-CODED
 *
 * [SyncPass.install] is what the shell calls at launch. This class owns being
 * runnable, being retried and reporting a verdict; it does not own what a pass
 * IS — that would put the sync policy inside an Android class where no JVM test
 * can reach it.
 *
 * A pass with nothing installed is `Result.success()` and not a failure: an app
 * that has not finished launching has nothing to catch up on, and a failure
 * would make WorkManager back off the schedule for a reason that is not real.
 */
public class CentraidSyncWorker(
    context: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(context, parameters) {

    override suspend fun doWork(): Result {
        val pass = SyncPass.installed ?: return Result.success()
        return try {
            if (pass()) Result.success() else Result.retry()
        } catch (error: Exception) {
            // RETRY, NOT FAILURE. `Result.failure()` takes the work out of the
            // queue for good, and a phone that lost its network mid-pass would
            // never back up again until the app was opened.
            Result.retry()
        }
    }
}

/** The pass body, installed by the shell at launch. See [CentraidSyncWorker]. */
public object SyncPass {
    internal var installed: (suspend () -> Boolean)? = null
        private set

    /** Install the body. Replacing it is how a test drives one. */
    public fun install(pass: suspend () -> Boolean) {
        installed = pass
    }
}

public class AndroidBackgroundTasks(private val context: Context) : BackgroundTasks {

    override suspend fun register(): BackgroundTasks.Registration = try {
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            WORK_NAME,
            // **UPDATE, NOT KEEP, AND THAT IS THE MIGRATION.** The unique name
            // is unchanged — a rename would orphan whatever a shipped build
            // scheduled under the old one — but every device that ran the
            // previous build has an unrunnable `androidx.work.Worker` enqueued
            // under it, and `KEEP` would keep exactly that. `UPDATE` replaces
            // the request in place, keeping the work's id and its schedule.
            ExistingPeriodicWorkPolicy.UPDATE,
            PeriodicWorkRequestBuilder<CentraidSyncWorker>(15, TimeUnit.MINUTES)
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

    internal companion object {
        /**
         * v0's name, kept. Nothing scheduled under it is orphaned by this
         * change — see the `UPDATE` above, which is what migrates it.
         */
        const val WORK_NAME = "centraid-sync-pass"
    }
}

/**
 * One object, uploaded by WorkManager from the spool file (#1029 W5B-2).
 *
 * Expedited is deliberately NOT asked for: an upload is not urgent, expedited
 * quota is small and shared, and a pass that spent it would be taking it from
 * something a member is waiting on.
 */
public class CentraidUploadWorker(
    context: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(context, parameters) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val url = inputData.getString(KEY_URL) ?: return@withContext Result.failure()
        val path = inputData.getString(KEY_PATH) ?: return@withContext Result.failure()
        val names = inputData.getStringArray(KEY_HEADER_NAMES).orEmpty()
        val values = inputData.getStringArray(KEY_HEADER_VALUES).orEmpty()
        val file = File(path)
        if (!file.exists()) {
            // THE SPOOL FILE IS GONE. Not a retry: a vault that was reset, or a
            // generation already committed, and re-running would fail forever.
            return@withContext Result.success()
        }
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "PUT"
            connection.doOutput = true
            // STREAMED, so a 16 MiB object never sits in this process's heap.
            connection.setFixedLengthStreamingMode(file.length())
            names.zip(values).forEach { (name, value) ->
                connection.setRequestProperty(name, value)
            }
            file.inputStream().use { source ->
                connection.outputStream.use { sink -> source.copyTo(sink) }
            }
            when (connection.responseCode) {
                in 200..299 -> Result.success()
                // A REFUSAL IS NOT A RETRY. The gateway said no — a spent quota,
                // an expired target, a moved vault — and repeating the request
                // would spend a member's battery to earn the same answer. The
                // next foreground pass re-declares.
                in 400..499 -> Result.failure()
                else -> Result.retry()
            }
        } catch (error: java.io.IOException) {
            Result.retry()
        } finally {
            connection.disconnect()
        }
    }

    internal companion object {
        const val KEY_URL = "url"
        const val KEY_PATH = "path"
        const val KEY_HEADER_NAMES = "header-names"
        const val KEY_HEADER_VALUES = "header-values"
    }
}

public class AndroidBackgroundTransfers(private val context: Context) : BackgroundTransfers {

    override suspend fun enqueue(
        uploads: List<BackgroundTransfers.Upload>,
    ): BackgroundTransfers.Enqueued = try {
        val manager = WorkManager.getInstance(context)
        uploads.forEach { upload ->
            manager.enqueueUniqueWork(
                // UNIQUE BY OBJECT NAME, and `KEEP`: an object's name is the
                // hash of its bytes, so two requests for one name are one
                // upload. A pass that ran twice must not pay for it twice.
                uploadWorkName(upload.objectName),
                ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<CentraidUploadWorker>()
                    .setConstraints(
                        Constraints.Builder()
                            .setRequiredNetworkType(NetworkType.CONNECTED)
                            .build(),
                    )
                    .setInputData(
                        workDataOf(
                            CentraidUploadWorker.KEY_URL to upload.url,
                            CentraidUploadWorker.KEY_PATH to upload.spoolPath,
                            CentraidUploadWorker.KEY_HEADER_NAMES to
                                upload.headers.map { it.first }.toTypedArray(),
                            CentraidUploadWorker.KEY_HEADER_VALUES to
                                upload.headers.map { it.second }.toTypedArray(),
                        ),
                    )
                    .build(),
            )
        }
        BackgroundTransfers.Enqueued(
            accepted = uploads.size,
            sentence = BackgroundTransfers.ANDROID_UNMETERED_SENTENCE,
        )
    } catch (error: IllegalStateException) {
        BackgroundTransfers.Enqueued(
            accepted = 0,
            sentence = "Centraid cannot upload in the background on this device.",
            refusal = error.message ?: "WorkManager refused",
        )
    }

    override suspend fun inFlight(): List<String> = WorkManager.getInstance(context)
        .getWorkInfosByTag(CentraidUploadWorker::class.java.name)
        .get()
        .filter { !it.state.isFinished }
        .flatMap { info -> info.tags.filter { it.startsWith(UPLOAD_PREFIX) } }
        .map { it.removePrefix(UPLOAD_PREFIX) }

    override suspend fun cancelAll() {
        WorkManager.getInstance(context).cancelAllWorkByTag(CentraidUploadWorker::class.java.name)
    }

    private companion object {
        const val UPLOAD_PREFIX = "centraid-upload-"

        fun uploadWorkName(objectName: String): String = UPLOAD_PREFIX + objectName
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
