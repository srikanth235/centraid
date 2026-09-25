@file:OptIn(ExperimentalForeignApi::class)

package dev.centraid.shared.platform

import centraid.screen.v1.MediaPermission
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.alloc
import kotlinx.cinterop.convert
import kotlinx.cinterop.cstr
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.readBytes
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.usePinned
import kotlinx.cinterop.value
import kotlin.coroutines.resume
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import platform.BackgroundTasks.BGAppRefreshTaskRequest
import platform.BackgroundTasks.BGProcessingTaskRequest
import platform.BackgroundTasks.BGTaskRequest
import platform.BackgroundTasks.BGTaskScheduler
import platform.CoreFoundation.CFDataCreate
import platform.CoreFoundation.CFDataGetBytePtr
import platform.CoreFoundation.CFDataGetLength
import platform.CoreFoundation.CFDictionaryCreateMutable
import platform.CoreFoundation.CFDictionarySetValue
import platform.CoreFoundation.CFMutableDictionaryRef
import platform.CoreFoundation.CFRelease
import platform.CoreFoundation.CFStringCreateWithCString
import platform.CoreFoundation.CFStringRef
import platform.CoreFoundation.CFDataRef
import platform.CoreFoundation.CFTypeRefVar
import platform.CoreFoundation.kCFAllocatorDefault
import platform.CoreFoundation.kCFBooleanTrue
import platform.CoreFoundation.kCFTypeDictionaryKeyCallBacks
import platform.CoreFoundation.kCFStringEncodingUTF8
import platform.CoreFoundation.kCFTypeDictionaryValueCallBacks
import platform.Foundation.NSDate
import platform.Foundation.localTimeZone
import platform.Foundation.NSLog
import platform.Foundation.dateWithTimeIntervalSinceNow
import platform.Network.nw_path_get_status
import platform.Network.nw_path_is_constrained
import platform.Network.nw_path_is_expensive
import platform.Network.nw_path_monitor_create
import platform.Network.nw_path_monitor_set_queue
import platform.Network.nw_path_monitor_set_update_handler
import platform.Network.nw_path_monitor_start
import platform.Network.nw_path_status_satisfied
import platform.Security.SecItemAdd
import platform.Security.SecRandomCopyBytes
import platform.Security.kSecRandomDefault
import platform.darwin.OSStatus
import platform.Security.SecItemCopyMatching
import platform.Security.SecItemDelete
import platform.Security.errSecSuccess
import platform.Security.kSecAttrAccessible
import platform.Security.kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
import platform.Security.kSecAttrAccount
import platform.Security.kSecAttrService
import platform.Security.kSecClass
import platform.Security.kSecClassGenericPassword
import platform.Security.kSecMatchLimit
import platform.Security.kSecMatchLimitOne
import platform.Security.kSecAttrSynchronizable
import platform.Security.kSecAttrAccessibleAfterFirstUnlock
import platform.Security.kSecReturnData
import platform.Security.kSecValueData
import platform.darwin.dispatch_get_main_queue
import platform.Foundation.NSData
import platform.Foundation.NSFileHandle
import platform.Foundation.NSFileManager
import platform.Foundation.NSFileSize
import platform.Foundation.NSNumber
import platform.Foundation.NSTemporaryDirectory
import platform.Foundation.NSURL
import platform.Foundation.NSUUID
import platform.Foundation.setHTTPMethod
import platform.Foundation.setValue
import platform.Foundation.closeFile
import platform.Foundation.fileHandleForReadingAtPath
import platform.Foundation.NSDateFormatter
import platform.Foundation.NSLocale
import platform.Foundation.NSPredicate
import platform.Foundation.NSSortDescriptor
import platform.Foundation.NSTimeZone
import platform.Foundation.dateWithTimeIntervalSince1970
import platform.Foundation.localeWithLocaleIdentifier
import platform.Foundation.timeIntervalSince1970
import platform.Foundation.timeZoneForSecondsFromGMT
import platform.UniformTypeIdentifiers.UTType
import platform.darwin.NSObject
import platform.Photos.PHAccessLevelReadWrite
import platform.Photos.PHAsset
import platform.Photos.PHAssetMediaSubtypePhotoLive
import platform.Photos.PHAssetMediaTypeVideo
import platform.Photos.PHAssetResource
import platform.Photos.PHAssetResourceManager
import platform.Photos.PHAssetResourceRequestOptions
import platform.Photos.PHAssetResourceTypeFullSizePairedVideo
import platform.Photos.PHAssetResourceTypeFullSizePhoto
import platform.Photos.PHAssetResourceTypeFullSizeVideo
import platform.Photos.PHAssetResourceTypePairedVideo
import platform.Photos.PHAssetResourceTypePhoto
import platform.Photos.PHAssetResourceTypeVideo
import platform.Photos.PHChange
import platform.Photos.PHFetchOptions
import platform.Photos.PHPhotoLibraryChangeObserverProtocol
import platform.Photos.PHAuthorizationStatusAuthorized
import platform.Photos.PHAuthorizationStatusDenied
import platform.Photos.PHAuthorizationStatusLimited
import platform.Photos.PHAuthorizationStatusNotDetermined
import platform.Photos.PHAuthorizationStatusRestricted
import platform.Photos.PHPhotoLibrary
import platform.UIKit.UIDevice
import platform.UIKit.UIDeviceBatteryState

/**
 * iOS's platform services (#1020, D-1020-E4).
 *
 * **NOT COMPILED IN CI TODAY**, for the same reason as
 * `mobile/core/src/iosMain`: Kotlin/Native's iOS targets need a macOS host.
 * `mobile/README.md` carries the command, and the receipt records the risk
 * rather than a green.
 *
 * Two shapes here are iOS's and not a translation of Android's:
 *
 * * **`PHAuthorizationStatusLimited` is a first-class state**, not a
 *   degraded-denied. It is the value `MediaPermission.MEDIA_PERMISSION_LIMITED`
 *   exists for, and the grid says "the photos you selected" rather than "no
 *   access".
 * * **`BGTaskScheduler` refuses by throwing**, and the refusal is the answer a
 *   member reads: "Background App Refresh is off" (`docs/mobile-offline.md:214`).
 */
public actual fun platformServices(): PlatformServices = IosPlatformServices()

public class IosPlatformServices : PlatformServices {
    override val secureStore: SecureStore = IosSecureStore()
    override val backgroundTasks: BackgroundTasks = IosBackgroundTasks()
    override val syncedSecrets: SyncedSecrets = IosSyncedSecrets()
    override val networkStatus: NetworkStatus = IosNetworkStatus()
    override val mediaLibrary: MediaLibrary = IosMediaLibrary()
    override val ocr: Ocr = IosOcr()
    override val secureRandom: SecureRandom = IosSecureRandom()
    override val clock: DeviceClock = IosDeviceClock()
}

/**
 * The Keychain, `kSecClassGenericPassword` (#1025 S5).
 *
 * THE CINTEROP THE OLD COMMENT ASKED FOR ALREADY SHIPS. This class threw, and
 * said the Keychain "needs a Security.framework cinterop that no machine in
 * this repository's CI can build". That was wrong on its face: Kotlin/Native
 * distributes `platform.Security` as a DEFAULT platform library for every Apple
 * target, so `SecItemAdd`, `SecItemCopyMatching` and `SecItemDelete` are
 * resolvable by the same compiler that was already compiling the file — no
 * hand-written `.def` and no extra machine. The claim was never checked, and
 * `:shared:compileKotlinIosSimulatorArm64` falsifies it in one run.
 *
 * v0 put secrets in `expo-secure-store`, which on iOS is the Keychain with
 * `completeUntilFirstUserAuthentication` (`docs/mobile-offline.md:253`).
 *
 * **`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, and both halves are
 * load-bearing.** `AfterFirstUnlock` is v0's accessibility, and it is what lets
 * a background sync pass read the seat credential while the screen is locked;
 * `WhenUnlocked` would make every pass after the first lock fail. The
 * `ThisDeviceOnly` suffix is what keeps the item out of the iCloud Keychain AND
 * out of an encrypted iTunes/Finder backup, so a vault credential cannot ride a
 * restore onto a second device that the owner never enrolled — which would hand
 * a seat's identity to a device the seat ledger has never seen
 * (`docs/identifiers.md`, `docs/enrollment.md`).
 *
 * The accessibility is set on the ADD alone — see [write]. The two rules in
 * [SecureStore]'s own comment are kept here verbatim: an empty
 * [write] DELETES, and [clear] drops every item under [SecureStore.PREFIX].
 * [SecureStore.PREFIX] is the `kSecAttrService`, which is what makes [clear] a
 * single `SecItemDelete` over a class+service query rather than an enumeration.
 */
public class IosSecureStore : SecureStore {
    override suspend fun read(key: String): String? = memScoped {
        val found = alloc<CFTypeRefVar>()
        val status = keychainQuery(account(key)) { query ->
            CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue)
            CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne)
            SecItemCopyMatching(query, found.ptr)
        }
        if (status != errSecSuccess) return@memScoped null
        val data: CFDataRef = found.value?.reinterpret() ?: return@memScoped null
        try {
            val bytes = CFDataGetBytePtr(data) ?: return@memScoped null
            bytes.readBytes(CFDataGetLength(data).toInt()).decodeToString()
        } finally {
            // `SecItemCopyMatching` RETURNS A +1 REFERENCE. Without this every
            // read leaves the secret's bytes in the heap for the life of the
            // process, which for a vault credential is the whole point of not
            // keeping it in one.
            CFRelease(data)
        }
    }

    override suspend fun write(key: String, value: String) {
        val account = account(key)
        // DELETE FIRST, ALWAYS. `SecItemAdd` answers `errSecDuplicateItem`
        // rather than replacing, so an overwrite that skipped this would keep
        // answering the FIRST secret ever written under the key.
        keychainQuery(account) { query -> SecItemDelete(query) }
        // AN EMPTY VALUE DELETES (`secure-storage.ts:39-43`). A stored empty
        // string reads back as a credential the app believes it has.
        if (value.isEmpty()) return
        val bytes = value.encodeToByteArray()
        val data = bytes.usePinned { pinned ->
            CFDataCreate(
                kCFAllocatorDefault,
                pinned.addressOf(0).reinterpret(),
                bytes.size.convert(),
            )
        }
        try {
            val status = keychainQuery(account) { query ->
                CFDictionarySetValue(query, kSecValueData, data)
                // ONLY ON THE ADD. `kSecAttrAccessible` is a matching attribute
                // as well as a stored one, so putting it in the read and delete
                // queries would make them miss any item an earlier build wrote
                // with a different accessibility — and `clear()` would leave
                // exactly the stale credential it exists to remove.
                CFDictionarySetValue(
                    query,
                    kSecAttrAccessible,
                    kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                )
                SecItemAdd(query, null)
            }
            // A WRITE THAT FAILED MUST NOT BE SILENT (#1025 S7-13).
            //
            // This status was discarded, and what it discarded was the only
            // signal that something the shell had to keep had not been kept.
            // The shape it produced then was the worst one in the product:
            // `Enrolments` minted this device's endpoint secret, the gateway
            // enrolled its public half, the store kept nothing, and the next
            // open minted a different key — so the device dialled its own
            // gateway as a stranger. That plane is deleted (#1029 §1) and this
            // line is not: the store still holds `Shelf.FOREGROUND_KEY` and the
            // member's transfer rule, and a silent failure is still a silent
            // failure. It is what W5's restore credentials will land on.
            //
            // It is a log and not a throw: a member cannot act on it, and a
            // store that threw would take out a launch over a preference as
            // readily as over a key.
            if (status != errSecSuccess) {
                NSLog("centraid: the secure store refused a write (OSStatus %d)", status)
            }
        } finally {
            data?.let { CFRelease(it) }
        }
    }

    override suspend fun clear() {
        // NO ACCOUNT IN THE QUERY, so it matches every item of this class under
        // the service — which is every key this store has ever written, because
        // the service IS the prefix. `SecItemDelete` deletes all the matches,
        // not the first.
        keychainQuery(account = null) { query -> SecItemDelete(query) }
    }

    /** Namespaced with v0's prefix so a migrating device finds its own secrets. */
    private fun account(key: String): String = SecureStore.PREFIX + key

    /**
     * A `kSecClassGenericPassword` query, built once and released once.
     *
     * `CFDictionaryCreateMutable` over CoreFoundation values rather than a
     * bridged `NSDictionary`: the `kSec*` keys are `CFStringRef` globals, and
     * bridging them into an Objective-C dictionary would transfer an ownership
     * the process does not hold over a constant.
     */
    private inline fun keychainQuery(
        account: String?,
        build: (CFMutableDictionaryRef?) -> OSStatus,
    ): OSStatus {
        val query = CFDictionaryCreateMutable(
            kCFAllocatorDefault,
            0,
            kCFTypeDictionaryKeyCallBacks.ptr,
            kCFTypeDictionaryValueCallBacks.ptr,
        )
        val service = cfString(SecureStore.PREFIX)
        val accountRef = account?.let { cfString(it) }
        try {
            CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword)
            CFDictionarySetValue(query, kSecAttrService, service)
            accountRef?.let { CFDictionarySetValue(query, kSecAttrAccount, it) }
            return build(query)
        } finally {
            accountRef?.let { CFRelease(it) }
            service?.let { CFRelease(it) }
            query?.let { CFRelease(it) }
        }
    }

    private fun cfString(value: String): CFStringRef? = memScoped {
        CFStringCreateWithCString(kCFAllocatorDefault, value.cstr.ptr, kCFStringEncodingUTF8)
    }
}

public class IosBackgroundTasks : BackgroundTasks {

    override suspend fun register(): BackgroundTasks.Registration {
        val refresh = BGAppRefreshTaskRequest(REFRESH_IDENTIFIER)
        refresh.earliestBeginDate = NSDate.dateWithTimeIntervalSinceNow(EARLIEST_SECONDS)
        // THE LONG ONE, for uploading a generation. A refresh task's budget is
        // seconds; a `BGProcessingTask` gets minutes, and asks for a network
        // rather than a charger — a member who never charges overnight still
        // gets backed up, which is exactly the member most likely to lose a
        // phone.
        val processing = BGProcessingTaskRequest(PROCESSING_IDENTIFIER)
        processing.earliestBeginDate = NSDate.dateWithTimeIntervalSinceNow(EARLIEST_SECONDS)
        processing.requiresNetworkConnectivity = true
        processing.requiresExternalPower = false
        // BOTH ARE SUBMITTED, AND THE COMMENT USED TO LIE ABOUT THAT
        // (#1029 W18-6). What stood here was
        // `submit(refresh) && submit(processing)` under a comment reading
        // "BOTH OR NEITHER" — and `&&` short-circuits, so a refused refresh
        // meant the processing request was never submitted **at all**. That is
        // not "neither": it is "the first was refused and the second was never
        // asked", and the processing task is the one that uploads bytes. iOS
        // grants the two independently, so a phone whose refresh is refused may
        // still be granted a processing window.
        var refusal = ""
        fun submit(request: BGTaskRequest, which: String): Boolean = try {
            BGTaskScheduler.sharedScheduler.submitTaskRequest(request, null)
        } catch (error: Throwable) {
            refusal = listOf(refusal, "$which: ${error.message ?: "refused"}")
                .filter { it.isNotEmpty() }
                .joinToString("; ")
            false
        }
        val refreshTaken = submit(refresh, REFRESH_IDENTIFIER)
        val processingTaken = submit(processing, PROCESSING_IDENTIFIER)
        // WHICH ONE WAS REFUSED IS WHAT A MEMBER IS OWED. "Background App
        // Refresh is off" is the whole truth only when NEITHER was taken; a
        // phone that will upload but not catch up early, or the reverse, is a
        // different product to use and saying so is the difference between a
        // member who understands their backup and one who does not.
        return BackgroundTasks.Registration(
            registered = refreshTaken || processingTaken,
            sentence = when {
                refreshTaken && processingTaken -> "Centraid catches up in the background."
                processingTaken ->
                    "Centraid backs up in the background. It only catches up on changes when " +
                        "you open it."
                refreshTaken ->
                    "Centraid catches up on changes in the background. It only uploads when " +
                        "you open it."
                else ->
                    "Background App Refresh is off, so Centraid only catches up when you open it."
            },
            refusal = refusal,
        )
    }

    internal companion object {
        /**
         * **EVERY ONE OF THESE IS IN `Info.plist`'s
         * `BGTaskSchedulerPermittedIdentifiers`, AND THAT IS NOT A STYLE RULE.**
         *
         * `BGTaskScheduler` raises an `NSInternalInconsistencyException` when an
         * identifier is registered or submitted that the bundle does not
         * declare — the app does not fail the task, it TERMINATES. A member
         * whose phone kills Centraid on launch has no backup and no way to tell
         * anyone why, so the list below and the plist array are one fact kept
         * in two files, and `mobile/iosApp/Resources/Info.plist` names this
         * companion in its own comment.
         */
        const val REFRESH_IDENTIFIER = "dev.centraid.sync-pass"

        /**
         * The long one. A refresh task gets ~30 seconds; uploading a
         * generation does not fit in that, and `BGProcessingTask` is the class
         * iOS provides for work that needs minutes and can wait for a charger.
         */
        const val PROCESSING_IDENTIFIER = "dev.centraid.upload-pass"

        /** Both ids, for the registration and for the test that pins the plist. */
        val PERMITTED_IDENTIFIERS: List<String> =
            listOf(REFRESH_IDENTIFIER, PROCESSING_IDENTIFIER)

        const val EARLIEST_SECONDS = 15.0 * 60.0
    }
}

/**
 * The iCloud Keychain item that carries the seed, and **nothing else**
 * (#1029 §5, W5B-3).
 *
 * [IosSecureStore] pins every item `…ThisDeviceOnly`, deliberately, so a seat
 * credential cannot ride a restore onto a device nobody enrolled. This class is
 * the one exception in the product: `kSecAttrSynchronizable` true, and
 * `kSecAttrAccessibleAfterFirstUnlock` WITHOUT the `ThisDeviceOnly` suffix —
 * the two go together, and an item marked synchronizable with a device-only
 * accessibility is simply refused by the Keychain.
 *
 * It is a different service string from [SecureStore.PREFIX] on purpose: it
 * makes [IosSecureStore.clear]'s single class-plus-service delete incapable of
 * reaching the seed, and it makes the synchronizable set one item that an
 * operator can see rather than a flag on one row in a larger table.
 *
 * F5 holds: what synchronises is the seed, which is upstream of every
 * vault-derived key. Losing it loses everything anyway, so it adds no exposure
 * the phrase on a member's shelf does not already carry — and syncing anything
 * DERIVED from it would.
 */
public class IosSyncedSecrets : SyncedSecrets {

    override suspend fun availability(): SyncedSecrets.Availability {
        // THE KEYCHAIN WILL NOT ANSWER "is iCloud Keychain on" DIRECTLY, and
        // there is no API that does. What can be observed is whether a
        // synchronizable item round-trips, which is the same question asked in
        // the only way iOS answers it.
        val probe = "probe"
        val stored = write(PROBE_KEY, probe)
        val readBack = if (stored) read(PROBE_KEY) else null
        delete(PROBE_KEY)
        val synchronizing = readBack == probe
        return SyncedSecrets.Availability(
            synchronizing = synchronizing,
            sentence = if (synchronizing) {
                SyncedSecrets.IOS_SENTENCE
            } else {
                SyncedSecrets.IOS_OFF_SENTENCE
            },
            // TRUE ON iOS, and this is the half Android cannot match: an iCloud
            // Keychain item comes back whenever the member signs in, not only
            // during a setup wizard.
            restoresAfterSetup = true,
        )
    }

    override suspend fun putSeed(seedHex: String): Boolean =
        write(SyncedSecrets.SEED_KEY, seedHex)

    override suspend fun seed(): String? = read(SyncedSecrets.SEED_KEY)

    override suspend fun forgetSeed() {
        delete(SyncedSecrets.SEED_KEY)
    }

    private fun read(key: String): String? = memScoped {
        val found = alloc<CFTypeRefVar>()
        val status = syncedQuery(key) { query ->
            CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue)
            CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne)
            SecItemCopyMatching(query, found.ptr)
        }
        if (status != errSecSuccess) return@memScoped null
        val data: CFDataRef = found.value?.reinterpret() ?: return@memScoped null
        try {
            val bytes = CFDataGetBytePtr(data) ?: return@memScoped null
            bytes.readBytes(CFDataGetLength(data).toInt()).decodeToString()
        } finally {
            CFRelease(data)
        }
    }

    private fun write(key: String, value: String): Boolean {
        // REPLACE, NEVER TWO. A second seed under one key is a phone that
        // restores to whichever the Keychain happened to answer with.
        delete(key)
        val bytes = value.encodeToByteArray()
        val status = bytes.usePinned { pinned ->
            val data = CFDataCreate(
                kCFAllocatorDefault,
                pinned.addressOf(0).reinterpret(),
                bytes.size.convert(),
            )
            try {
                syncedQuery(key) { query ->
                    CFDictionarySetValue(query, kSecValueData, data)
                    CFDictionarySetValue(
                        query,
                        kSecAttrAccessible,
                        kSecAttrAccessibleAfterFirstUnlock,
                    )
                    SecItemAdd(query, null)
                }
            } finally {
                data?.let { CFRelease(it) }
            }
        }
        return status == errSecSuccess
    }

    private fun delete(key: String) {
        syncedQuery(key) { query -> SecItemDelete(query) }
    }

    private inline fun syncedQuery(key: String, build: (CFMutableDictionaryRef?) -> OSStatus): OSStatus {
        val query = CFDictionaryCreateMutable(
            kCFAllocatorDefault,
            0,
            kCFTypeDictionaryKeyCallBacks.ptr,
            kCFTypeDictionaryValueCallBacks.ptr,
        )
        val service = cfString(SERVICE)
        val account = cfString(key)
        try {
            CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword)
            service?.let { CFDictionarySetValue(query, kSecAttrService, it) }
            account?.let { CFDictionarySetValue(query, kSecAttrAccount, it) }
            // THE ONE ATTRIBUTE THIS CLASS EXISTS FOR.
            CFDictionarySetValue(query, kSecAttrSynchronizable, kCFBooleanTrue)
            return build(query)
        } finally {
            account?.let { CFRelease(it) }
            service?.let { CFRelease(it) }
            query?.let { CFRelease(it) }
        }
    }

    private fun cfString(value: String): CFStringRef? = memScoped {
        CFStringCreateWithCString(kCFAllocatorDefault, value.cstr.ptr, kCFStringEncodingUTF8)
    }

    private companion object {
        /**
         * A DIFFERENT SERVICE FROM [SecureStore.PREFIX], so that store's
         * class-plus-service `clear` cannot reach the seed and this one item is
         * the whole of what synchronises.
         */
        const val SERVICE = "centraid.v1.synced."
        const val PROBE_KEY = "availability-probe"
    }
}

/**
 * Connectivity, over `NWPathMonitor` (#1025 S5).
 *
 * THE CINTEROP THIS ALSO ASKED FOR ALREADY SHIPS: `platform.Network` is a
 * default Kotlin/Native platform library, exactly like `platform.Security`.
 * Before this, `current()` returned a hard-coded
 * `online = false, platformRefused = true`, and because the write gate of the
 * day treated an unknown answer as not-reachable, EVERY write on iOS was
 * refused forever. A
 * placeholder that is a true statement about an unasked platform stops being
 * true the moment it is the only thing the platform is ever asked.
 *
 * `platformRefused` is now reserved for the one case that earns it: the monitor
 * did not call back inside [PATH_TIMEOUT_MS]. A satisfied path is `online`, an
 * unsatisfied path is offline — a FACT, not a refusal — and
 * `SeatState.Connectivity` keeps the three apart.
 *
 * **`metered` is expensive OR constrained.** `nw_path_is_expensive` is cellular
 * and personal hotspot; `nw_path_is_constrained` is Low Data Mode, which the
 * owner turned on to mean the same thing. Reading only the first would run a
 * full sync pass over a link the owner explicitly narrowed.
 */
public class IosNetworkStatus : NetworkStatus {
    private val listeners = mutableListOf<(NetworkStatus.Reading) -> Unit>()
    private val firstPath = CompletableDeferred<Unit>()
    private var lastOnline: Boolean? = null
    private var lastMetered: Boolean = true

    init {
        // BATTERY MONITORING HAS TO BE TURNED ON, AND NOTHING TURNED IT ON
        // (#1025 S5). `batteryState` is documented to answer
        // `UIDeviceBatteryStateUnknown` until `isBatteryMonitoringEnabled` is
        // set, so `charging` below was permanently false and the
        // charger-gated pass could never run. The previous comment called
        // enabling it "a hand-off and not a thing to switch on inside a read" —
        // it is not a read, it is this object's construction, which is the
        // right place for a per-process flag that costs nothing to set twice.
        UIDevice.currentDevice.batteryMonitoringEnabled = true
        // ONE MONITOR FOR THE PROCESS (#1025, R-SHELL-4). The previous shape
        // started and cancelled a monitor around each `current()` call, so a
        // path that moved between reads was a fact nobody heard — airplane
        // mode off did not reopen the tail. The monitor is a stream; we keep
        // it.
        val monitor = nw_path_monitor_create()
        nw_path_monitor_set_update_handler(monitor) { path ->
            val online = nw_path_get_status(path) == nw_path_status_satisfied
            val metered = nw_path_is_expensive(path) || nw_path_is_constrained(path)
            lastOnline = online
            lastMetered = metered
            if (!firstPath.isCompleted) firstPath.complete(Unit)
            val reading = reading(online, metered)
            listeners.toList().forEach { it(reading) }
        }
        nw_path_monitor_set_queue(monitor, dispatch_get_main_queue())
        nw_path_monitor_start(monitor)
    }

    override suspend fun current(): NetworkStatus.Reading {
        val online = lastOnline
        if (online != null) return reading(online, lastMetered)
        withTimeoutOrNull(PATH_TIMEOUT_MS) { firstPath.await() }
        val arrived = lastOnline
            ?: return NetworkStatus.Reading(
                online = false,
                metered = true,
                charging = charging(),
                // THE PLATFORM WOULD NOT SAY — the monitor never called back.
                // Not the same as offline, and the only case that earns this.
                platformRefused = true,
            )
        return reading(arrived, lastMetered)
    }

    override fun onChange(listener: (NetworkStatus.Reading) -> Unit) {
        listeners += listener
    }

    private fun reading(online: Boolean, metered: Boolean): NetworkStatus.Reading =
        NetworkStatus.Reading(
            online = online,
            metered = metered,
            charging = charging(),
            platformRefused = false,
        )

    private fun charging(): Boolean =
        UIDevice.currentDevice.batteryState ==
            UIDeviceBatteryState.UIDeviceBatteryStateCharging

    private companion object {
        /**
         * `NWPathMonitor` answers from a cached path almost immediately; this
         * bounds the one case where it does not, so a connectivity read cannot
         * hang a lifecycle transition.
         */
        const val PATH_TIMEOUT_MS = 2_000L
    }
}

public class IosMediaLibrary : MediaLibrary {
    override suspend fun permission(): MediaPermission =
        when (PHPhotoLibrary.authorizationStatusForAccessLevel(PHAccessLevelReadWrite)) {
            PHAuthorizationStatusAuthorized -> MediaPermission.MEDIA_PERMISSION_GRANTED
            // A FIRST-CLASS STATE. Not a denial with fewer photos.
            PHAuthorizationStatusLimited -> MediaPermission.MEDIA_PERMISSION_LIMITED
            PHAuthorizationStatusDenied -> MediaPermission.MEDIA_PERMISSION_DENIED
            PHAuthorizationStatusRestricted -> MediaPermission.MEDIA_PERMISSION_RESTRICTED
            PHAuthorizationStatusNotDetermined -> MediaPermission.MEDIA_PERMISSION_NOT_ASKED
            else -> MediaPermission.MEDIA_PERMISSION_UNSPECIFIED
        }

    /**
     * ASK, AND WAIT FOR THE ANSWER (#1025 S6, D-1025-S7-72).
     *
     * This used to return [permission] with a comment saying "the prompt is the
     * app's, not a library's" — and that was wrong in a way that mattered:
     * `PHPhotoLibrary.requestAuthorization` is a CLASS method that presents its
     * own sheet over the key window, so `shared` can call it and no
     * `UIViewController` is owed. What the old shape produced was a screen with
     * an "Allow photo access" button that read the current status, found
     * `notDetermined`, wrote `notDetermined` back, and drew the same button
     * again — a member could press it for ever and never see the system prompt.
     *
     * **`PHAccessLevelReadWrite`, and nothing narrower.** `.addOnly` cannot
     * enumerate at all, so an app that asked for it would be granted, and then
     * find an empty roll with a `GRANTED` status on the screen.
     *
     * The result is bridged through the completion handler rather than polled:
     * `authorizationStatus` immediately after the call still answers the OLD
     * value, because the sheet has not been answered yet.
     */
    override suspend fun requestPermission(): MediaPermission {
        val status = suspendCancellableCoroutine { continuation ->
            PHPhotoLibrary.requestAuthorizationForAccessLevel(PHAccessLevelReadWrite) { answer ->
                if (continuation.isActive) continuation.resume(answer)
            }
        }
        return when (status) {
            PHAuthorizationStatusAuthorized -> MediaPermission.MEDIA_PERMISSION_GRANTED
            PHAuthorizationStatusLimited -> MediaPermission.MEDIA_PERMISSION_LIMITED
            PHAuthorizationStatusDenied -> MediaPermission.MEDIA_PERMISSION_DENIED
            PHAuthorizationStatusRestricted -> MediaPermission.MEDIA_PERMISSION_RESTRICTED
            PHAuthorizationStatusNotDetermined -> MediaPermission.MEDIA_PERMISSION_NOT_ASKED
            else -> MediaPermission.MEDIA_PERMISSION_UNSPECIFIED
        }
    }

    /**
     * ONE PAGE OF THE CAMERA ROLL, KEYSET ON `creationDate` (#1025 S6,
     * D-1025-S7-70).
     *
     * This threw `"not implemented"` and a phone could therefore never upload a
     * photograph: the product was read-only on iPhone, which is the wrong way
     * round for the device photographs come FROM.
     *
     * ## The cursor, and the two things that make it not an offset
     *
     * `<creationDate as epoch milliseconds>|<localIdentifier>`. The date alone
     * is not unique — a burst fires ten frames inside one second and the
     * simulator's seeded library gives several assets the SAME instant — so the
     * identifier is the tiebreak, and without it a page boundary that landed
     * inside a burst would repeat or drop its members for ever.
     *
     * **The predicate is `>=`, not `>`, and the overlap is skipped in Kotlin.**
     * `NSPredicate` over `PHAsset` supports a small, fixed set of keys and
     * `localIdentifier` is NOT one of them — Photos raises rather than
     * answering — so the second half of the keyset cannot be expressed to the
     * fetch at all. Asking for `>=` and dropping everything up to and including
     * the cursor's identifier is the same walk with the tiebreak applied one
     * layer out. The cost is bounded by the size of one same-instant group.
     *
     * **An asset with NO `creationDate` reads as `distantPast`.** Photos sorts
     * nil first under an ascending sort, so that is where the epoch floor puts
     * it too and the walk agrees with the fetch. It is a fixed set — a new
     * capture always carries a date — so it is offered on the first pass and
     * then sits behind the cursor like anything else. A keyset that ignored the
     * nil would silently drop every undated asset, which is the trap
     * `docs/photos/README.md` records the vault library hitting from the other
     * side.
     *
     * ## A Live Photo is TWO assets here
     *
     * `PHAssetMediaSubtypePhotoLive` is one `PHAsset` carrying two resources.
     * The interface's own rule is that a pair is "one thing to a grid and two
     * things to an uploader", so both are emitted, sharing one
     * [MediaLibrary.Asset.captureGroupId] — and the movie's [localId] carries
     * the [PAIRED_VIDEO] suffix, which is what [open] reads to know WHICH
     * resource of the asset it was asked for.
     *
     * **Burst members and RAW get no grouping.** A burst member is its own
     * `PHAsset` and `burstIdentifier` is deliberately not read: grouping on it
     * would invent a relationship the owner never made (`NATIVE_V0.md:11-19`).
     * A RAW+JPEG capture is one asset with two resources and only the PRIMARY
     * one is staged — the RAW itself for a ProRAW capture, because that is what
     * `PHAssetResourceTypePhoto` is on such an asset.
     */
    override suspend fun page(afterCursor: String?, limit: Int): MediaLibrary.Page {
        val from = Cursor.parse(afterCursor)
        val options = PHFetchOptions()
        options.sortDescriptors = listOf(
            NSSortDescriptor.sortDescriptorWithKey(CREATION_DATE, ascending = true),
        )
        if (from != null) {
            options.predicate = NSPredicate.predicateWithFormat(
                "creationDate >= %@",
                NSDate.dateWithTimeIntervalSince1970(from.epochMillis.toDouble() / 1_000.0),
            )
        }
        // FETCHED, THEN WALKED BY INDEX — and the index is into THIS fetch, not
        // into the library. `PHFetchResult` is a lazy, snapshot-backed cursor,
        // so reading `limit` of them costs `limit` reads and not a roll.
        val fetched = PHAsset.fetchAssetsWithOptions(options)
        val total = fetched.count.toInt()
        val assets = mutableListOf<MediaLibrary.Asset>()
        var index = 0
        var passed = from == null
        var last: Cursor? = null
        while (index < total && assets.size < limit) {
            val asset = fetched.objectAtIndex(index.convert()) as? PHAsset
            index += 1
            if (asset == null) continue
            val cursor = Cursor(epochMillisOf(asset), asset.localIdentifier)
            if (!passed) {
                // THE OVERLAP THE PREDICATE COULD NOT EXPRESS. Everything up to
                // AND INCLUDING the cursor's own identifier has been offered.
                if (cursor.localId == from?.localId) passed = true
                continue
            }
            assets += describe(asset, cursor)
            last = cursor
        }
        return MediaLibrary.Page(
            assets = assets,
            // NULL AT THE END OF THE ROLL, and that is what stops the walk. A
            // cursor handed back on an exhausted fetch would make every
            // subsequent pass re-fetch the tail to learn the same thing.
            nextCursor = if (index < total) last?.encode() else null,
        )
    }

    /**
     * The bytes of one original, streamed (#1025 S6, D-1025-S7-71).
     *
     * ## Why this goes through a temporary FILE, and not a channel
     *
     * The first version piped `PHAssetResourceManager.requestDataForAssetResource`
     * — a PUSH api — into a rendezvous `Channel` and declared
     * `byteSize = 0`, because **`PHAssetResource` publishes no size**. On the
     * simulator, every single photograph was then refused with "Centraid could
     * not read its own request", and the reason is in `Staging`'s own comment,
     * which the first version had misread: the declared length is "the
     * allocation AND the BOUND". `Staging.begin(0)` makes the core reserve
     * nothing and refuse the first chunk that arrives — `the chunks carry more
     * bytes than the 0 declared` — so a zero declaration is not "unknown", it
     * is "empty", and the whole upload path was dead on arrival.
     *
     * The declared size therefore has to be REAL, and Photos will not state one.
     * `writeData(for:toFile:options:)` is the documented way to get the
     * resource's bytes somewhere they can be measured: the file is written once,
     * `NSFileManager` states its exact length, and the stream is an
     * `NSFileHandle` read a chunk at a time. That also deletes the backpressure
     * problem rather than solving it — there is no second thread to throttle,
     * no `runBlocking` inside a Photos callback, and nothing to leak if a stage
     * refuses half way.
     *
     * The cost is one temporary copy of the original on disk, which is what
     * every uploader on this platform pays; it lives in `NSTemporaryDirectory`
     * and [Original.close] removes it on every path.
     *
     * **`networkAccessAllowed`**, so an asset whose original lives in iCloud is
     * downloaded rather than refused. That is the ordinary state of a roll on a
     * phone with Optimise Storage on, and without it the backup would silently
     * only ever carry what happened to be resident.
     *
     * Null when Photos has no resource to give, or will not write one: an
     * identifier the member deleted between the page and here, one outside a
     * LIMITED selection, or an iCloud original with no network. **Not an
     * error** — a roll changes under an enumeration.
     */
    override suspend fun open(localId: String): MediaLibrary.Original? {
        val paired = localId.endsWith(PAIRED_VIDEO)
        val identifier = if (paired) localId.removeSuffix(PAIRED_VIDEO) else localId
        val asset = PHAsset.fetchAssetsWithLocalIdentifiers(listOf(identifier), null)
            .firstObject as? PHAsset ?: return null
        val resources = PHAssetResource.assetResourcesForAsset(asset)
            .filterIsInstance<PHAssetResource>()
        val resource = (if (paired) resources.firstOrNull(::isPairedVideo) else primaryOf(resources))
            ?: return null

        // A PATH NOBODY ELSE CAN COLLIDE WITH. Two passes must never share one,
        // and `localIdentifier` carries slashes, so it is not a file name.
        val path = NSTemporaryDirectory() + "centraid-stage-" + NSUUID().UUIDString()
        val options = PHAssetResourceRequestOptions()
        options.networkAccessAllowed = true
        val failure = suspendCancellableCoroutine { continuation ->
            PHAssetResourceManager.defaultManager().writeDataForAssetResource(
                resource,
                NSURL.fileURLWithPath(path),
                options,
            ) { error ->
                if (continuation.isActive) continuation.resume(error?.localizedDescription)
            }
        }
        if (failure != null) {
            NSFileManager.defaultManager.removeItemAtPath(path, null)
            return null
        }
        val handle = NSFileHandle.fileHandleForReadingAtPath(path) ?: run {
            NSFileManager.defaultManager.removeItemAtPath(path, null)
            return null
        }
        val size = (
            NSFileManager.defaultManager.attributesOfItemAtPath(path, null)
                ?.get(NSFileSize) as? NSNumber
            )?.longLongValue ?: 0L
        return ResourceStream(
            mediaType = mimeOf(resource.uniformTypeIdentifier),
            bytes = size,
            handle = handle,
            path = path,
        )
    }

    /**
     * `PHPhotoLibraryChangeObserver`, while the app is on screen (#1025 S6).
     *
     * The observer is registered ONCE and the listeners are a list, because
     * `PHPhotoLibrary.registerChangeObserver` retains what it is handed and
     * unregistering is the app's to do at teardown; one observer per listener
     * would be one retained object per screen that ever opened.
     *
     * It reports THAT the library changed and never what changed. A
     * `PHChange` can say which assets moved, and reading it would be a second
     * opinion about what is new — the cursor is the first and the durable one,
     * so this is a nudge to run the pass and nothing more.
     */
    override fun onLibraryChanged(listener: () -> Unit) {
        libraryListeners += listener
        if (observer == null) {
            val watcher = LibraryWatcher { libraryListeners.forEach { it() } }
            observer = watcher
            PHPhotoLibrary.sharedPhotoLibrary().registerChangeObserver(watcher)
        }
    }

    private val libraryListeners = mutableListOf<() -> Unit>()
    private var observer: LibraryWatcher? = null

    private class LibraryWatcher(
        private val onChange: () -> Unit,
    ) : NSObject(), PHPhotoLibraryChangeObserverProtocol {
        override fun photoLibraryDidChange(changeInstance: PHChange) {
            onChange()
        }
    }

    /**
     * One `PHAsset` as this interface describes it, plus its paired movie when
     * it has one. See [page] for why a Live Photo is two rows.
     */
    private fun describe(asset: PHAsset, cursor: Cursor): MediaLibrary.Asset {
        val live = (asset.mediaSubtypes and PHAssetMediaSubtypePhotoLive) != 0uL
        return MediaLibrary.Asset(
            localId = asset.localIdentifier,
            bytes = 0L,
            capturedAtIso = isoOf(cursor.epochMillis),
            capturedUtcOffsetMinutes = offsetMinutesOf(asset),
            kind = if (asset.mediaType == PHAssetMediaTypeVideo) {
                MediaLibrary.Kind.VIDEO
            } else {
                MediaLibrary.Kind.PHOTO
            },
            // NO dHASH ON THIS SIDE. The field is a duplicates hint and
            // computing one means decoding every original on the phone to
            // produce a value that never merges anything — the gateway derives
            // it at commit, where the bytes already are (D-1025-S7-50).
            perceptualHash = null,
            // ONLY A LIVE PHOTO. Burst members, motion photos and RAW pairs get
            // null, which is the interface's own rule.
            captureGroupId = if (live) asset.localIdentifier else null,
        )
    }

    /**
     * The resource whose bytes ARE the original.
     *
     * `PHAssetResourceTypePhoto` and `…Video` are the originals;
     * `…FullSizePhoto` and `…FullSizeVideo` are what an EDIT produces and are
     * preferred when present, because on an edited asset the original is the
     * pre-edit frame and the member's photograph is the rendered one. Anything
     * else — adjustment data, a paired video, a thumbnail — is not an original
     * and is never the answer here.
     */
    private fun primaryOf(resources: List<PHAssetResource>): PHAssetResource? =
        resources.firstOrNull {
            it.type == PHAssetResourceTypeFullSizePhoto ||
                it.type == PHAssetResourceTypeFullSizeVideo
        } ?: resources.firstOrNull {
            it.type == PHAssetResourceTypePhoto || it.type == PHAssetResourceTypeVideo
        }

    private fun isPairedVideo(resource: PHAssetResource): Boolean =
        resource.type == PHAssetResourceTypePairedVideo ||
            resource.type == PHAssetResourceTypeFullSizePairedVideo

    /** `creationDate` as epoch milliseconds, with nil reading as the floor. */
    private fun epochMillisOf(asset: PHAsset): Long {
        val date = asset.creationDate ?: return 0L
        val seconds = date.timeIntervalSince1970
        // NEGATIVE IS REAL — a scanned photograph dated 1965 — and it is still
        // ordered correctly by the same comparison. Only nil takes the floor.
        return (seconds * 1_000.0).toLong()
    }

    /**
     * The capture-local offset, in minutes — and it is ALWAYS ZERO here.
     *
     * **`PHAsset` publishes no capture time zone.** There is no `timeZone`
     * property on it at any deployment target; the shutter's own offset lives
     * in the EXIF `OffsetTimeOriginal` tag inside the original's bytes, which
     * is on the gateway's side of the staging door and not the phone's.
     *
     * Zero, and never the READER'S current offset. A phone that stamped
     * `NSTimeZone.local` onto an import would move every photograph in the roll
     * into whatever zone the member happened to be standing in when they
     * paired — a whole library re-dated by where it was uploaded. Zero means
     * "UTC, and nobody has said otherwise", which `captured_at` already is.
     *
     * Filed rather than papered over: reading the tag off the staged bytes is
     * the gateway's to do, beside the orientation it already reads
     * (D-1025-S7-51), and it is an owner question on #1025.
     */
    private fun offsetMinutesOf(asset: PHAsset): Int = 0

    /** RFC 3339 in UTC, which is what `media.add_asset.captured_at` takes. */
    private fun isoOf(epochMillis: Long): String {
        val formatter = NSDateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'"
        formatter.timeZone = NSTimeZone.timeZoneForSecondsFromGMT(0)
        // POSIX, NOT THE MEMBER'S LOCALE. A device set to a Buddhist or Islamic
        // calendar formats `yyyy` as 2568 or 1447, and the row would carry a
        // timestamp no parser on the gateway accepts.
        formatter.locale = NSLocale.localeWithLocaleIdentifier("en_US_POSIX")
        return formatter.stringFromDate(
            NSDate.dateWithTimeIntervalSince1970(epochMillis.toDouble() / 1_000.0),
        )
    }

    /**
     * `<epoch millis>|<localIdentifier>`; see [page].
     *
     * `internal` rather than `private` so `iosTest` can drive the round trip.
     * The durable cursor is the one piece of this class a relaunch depends on,
     * and it is the one piece that can be proved without a photo library.
     */
    internal data class Cursor(val epochMillis: Long, val localId: String) {
        fun encode(): String = "$epochMillis$SEPARATOR$localId"

        companion object {
            const val SEPARATOR: Char = '|'

            fun parse(encoded: String?): Cursor? {
                if (encoded.isNullOrEmpty()) return null
                val at = encoded.indexOf(SEPARATOR)
                if (at < 0) return null
                // A CURSOR THIS CLASS DID NOT WRITE STARTS THE WALK AGAIN
                // rather than being guessed at. Starting again re-offers
                // photographs the core already holds, which `already_held`
                // makes cheap; a guessed date would SKIP them, which nothing
                // makes cheap.
                val millis = encoded.substring(0, at).toLongOrNull() ?: return null
                return Cursor(millis, encoded.substring(at + 1))
            }
        }
    }

    /**
     * One original, open as a file. See [open] for why it is a file.
     */
    private class ResourceStream(
        override val mediaType: String,
        /**
         * THE EXACT LENGTH, off the filesystem, and it is load-bearing.
         *
         * `Staging` takes this as the core's allocation AND its bound: a chunk
         * that would carry the running total past it is refused. A zero here is
         * what made every upload fail before the temp file existed.
         */
        override val bytes: Long,
        private val handle: NSFileHandle,
        private val path: String,
    ) : MediaLibrary.Original {
        override suspend fun read(max: Int): ByteArray {
            // `readDataUpToLength` ANSWERS SHORT AT THE END and empty past it,
            // which is exactly the contract `Staging` reads against.
            val data = handle.readDataUpToLength(max.convert(), null) ?: return ByteArray(0)
            return data.toByteArray()
        }

        /**
         * CLOSE CANNOT THROW, and an earlier version of this class crashed the
         * app because it did.
         *
         * `close()` is called from the `finally` of `CameraRoll.offer`, so
         * anything it raises escapes the pass, escapes the coroutine and takes
         * the process down — which is what happened the first time a member
         * pressed "Import now" on a real device.
         *
         * **The file is removed on every path.** A pass over a roll that left
         * its temporaries behind would fill a member's disk with a second copy
         * of their camera roll, and the screen would then honestly report that
         * the device is out of space.
         */
        override suspend fun close() {
            runCatching { handle.closeFile() }
            runCatching { NSFileManager.defaultManager.removeItemAtPath(path, null) }
        }
    }

    internal companion object Types {
        /** See [ResourceStream]. `internal` so `iosTest` can prove the table. */
        internal fun mimeOf(identifier: String?): String {
                val uti = identifier ?: return "application/octet-stream"
                UTType.typeWithIdentifier(uti)?.preferredMIMEType()?.let { return it }
                return when (uti) {
                    "public.heic", "public.heif" -> "image/heic"
                    "public.jpeg" -> "image/jpeg"
                    "public.png" -> "image/png"
                    "com.compuserve.gif" -> "image/gif"
                    "com.apple.quicktime-movie" -> "video/quicktime"
                    "public.mpeg-4" -> "video/mp4"
                    else -> "application/octet-stream"
                }
        }

        const val CREATION_DATE = "creationDate"

        /**
         * The suffix that names a Live Photo's MOVIE half.
         *
         * `#` cannot occur in a `PHAsset` local identifier, which is
         * `<UUID>/L0/001`, so the suffix cannot collide with an identifier
         * Photos minted.
         */
        const val PAIRED_VIDEO = "#pairedVideo"
    }
}

/**
 * `NSData` as Kotlin bytes, COPIED (#1025 S6).
 *
 * The copy is not avoidable and not a waste: `PHAssetResourceManager` hands the
 * data handler an `NSData` it owns and may reuse the moment the handler
 * returns, so a `ByteArray` that pointed into it would read whatever Photos put
 * there next — which for a staged photograph is a hash of somebody else's
 * bytes, committed as the member's.
 */
private fun NSData.toByteArray(): ByteArray {
    val size = length.toInt()
    if (size == 0) return ByteArray(0)
    val out = ByteArray(size)
    out.usePinned { pinned -> platform.posix.memcpy(pinned.addressOf(0), bytes, length) }
    return out
}

/** Wave 4. Vision is not wired yet, and saying so beats a stub. */
public class IosOcr : Ocr {
    override suspend fun available(): Boolean = false

    override suspend fun recognise(imagePath: String): List<String> = emptyList()
}

/**
 * `SecRandomCopyBytes`, the system CSPRNG (#1025 S5).
 *
 * **IT THROWS ON A NON-ZERO RETURN.** `SecRandomCopyBytes` leaves the buffer
 * untouched when it fails, so handing it back would hand back the zeroes the
 * `ByteArray` was allocated with — and a zeroed endpoint secret key is a key
 * every device that hit the same failure would share.
 */
public class IosSecureRandom : SecureRandom {
    override fun bytes(count: Int): ByteArray {
        val out = ByteArray(count)
        if (count == 0) return out
        val status = out.usePinned { pinned ->
            SecRandomCopyBytes(kSecRandomDefault, count.convert(), pinned.addressOf(0))
        }
        check(status == errSecSuccess) {
            "SecRandomCopyBytes refused ($status). A zeroed buffer is not a key."
        }
        return out
    }
}

/**
 * The device's zone and wall clock (#1046).
 *
 * `localTimeZone` and not `systemTimeZone`: the local zone TRACKS the system's
 * — a border crossed with the app open moves it — where `systemTimeZone` is
 * cached until somebody calls `resetSystemTimeZone`. Read at every call.
 */
public class IosDeviceClock : DeviceClock {
    override fun read(): DeviceClock.Reading = DeviceClock.Reading(
        zone = NSTimeZone.localTimeZone.name,
        epochMillis = (NSDate().timeIntervalSince1970 * 1_000.0).toLong(),
    )
}
