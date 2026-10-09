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
import platform.darwin.dispatch_async
import platform.darwin.dispatch_get_main_queue
import platform.Foundation.NSData
import platform.Foundation.setHTTPMethod
import platform.Foundation.setValue
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
import platform.UIKit.UIApplication
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
public actual fun platformServices(): PlatformServices = processServices

/**
 * ONE PER PROCESS, as on Android (#1047 walk): a caller asks on every
 * keystroke (Locker's `secureRandom`), and each instance starts its own
 * network path monitor that nothing ever cancels.
 */
private val processServices: IosPlatformServices by lazy { IosPlatformServices() }

public class IosPlatformServices : PlatformServices {
    override val secureStore: SecureStore = IosSecureStore()
    override val backgroundTasks: BackgroundTasks = IosBackgroundTasks()
    override val syncedSecrets: SyncedSecrets = IosSyncedSecrets()
    private val network = IosNetworkStatus()
    override val networkStatus: NetworkStatus = network
    // THE SAME PATH MONITOR, so a pass and the seat line never read two
    // different answers about one link.
    override val powerAndLink: PowerAndLink = IosPowerAndLink(network)
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

    /**
     * Submit both requests and say what iOS granted. **Both are submitted
     * independently** — iOS grants them independently, and `&&` once meant a
     * refused refresh left the processing request never asked for at all.
     */
    override suspend fun register(): BackgroundTasks.Registration = submitBoth()

    override fun resubmit() {
        submitBoth()
    }

    /** No earliest date: iOS may run the processing window as soon as it likes. */
    override fun nudge() {
        submit(processingRequest(earliest = false), PROCESSING_IDENTIFIER)
    }

    /**
     * "BACK UP NOW" KEEPS THE SCREEN AWAKE (#1080, the shells): a locked phone
     * suspends the app, and the background session moves only what was handed
     * off. UIKit's flag, so it is set on the main queue.
     */
    override fun backlog(start: Boolean) {
        dispatch_async(dispatch_get_main_queue()) {
            UIApplication.sharedApplication.idleTimerDisabled = start
        }
    }

    private fun submitBoth(): BackgroundTasks.Registration {
        val refresh = BGAppRefreshTaskRequest(REFRESH_IDENTIFIER)
        refresh.earliestBeginDate = NSDate.dateWithTimeIntervalSinceNow(EARLIEST_SECONDS)
        val refreshRefusal = submit(refresh, REFRESH_IDENTIFIER)
        val processingRefusal = submit(processingRequest(earliest = true), PROCESSING_IDENTIFIER)
        val refreshTaken = refreshRefusal == null
        val processingTaken = processingRefusal == null
        // WHICH ONE WAS REFUSED IS WHAT A MEMBER IS OWED: a phone that will
        // prepare and seal but not settle early, or the reverse, is a
        // different product to use.
        return BackgroundTasks.Registration(
            registered = refreshTaken || processingTaken,
            sentence = when {
                refreshTaken && processingTaken -> "Centraid catches up in the background."
                processingTaken ->
                    "Centraid backs up in the background. It only catches up on changes when " +
                        "you open it."
                refreshTaken ->
                    "Centraid catches up on changes in the background. It only prepares new " +
                        "backups when you open it."
                else ->
                    "Background App Refresh is off, so Centraid only catches up when you open it."
            },
            refusal = listOfNotNull(refreshRefusal, processingRefusal).joinToString("; "),
        )
    }

    /**
     * THE LONG WINDOW: prepare and settle (#1080, the shells). Hashing and
     * sealing a camera roll is minutes of CPU, so it waits for the charger,
     * and it is pointless without a network to settle against. The bytes
     * themselves move in the background `URLSession`, which needs neither.
     */
    private fun processingRequest(earliest: Boolean): BGProcessingTaskRequest {
        val processing = BGProcessingTaskRequest(PROCESSING_IDENTIFIER)
        if (earliest) processing.earliestBeginDate = NSDate.dateWithTimeIntervalSinceNow(EARLIEST_SECONDS)
        processing.requiresNetworkConnectivity = true
        processing.requiresExternalPower = true
        return processing
    }

    /** Null when iOS took it; the refusal's words when it threw. */
    private fun submit(request: BGTaskRequest, which: String): String? = try {
        BGTaskScheduler.sharedScheduler.submitTaskRequest(request, null)
        null
    } catch (error: Throwable) {
        "$which: ${error.message ?: "refused"}"
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
         * The long one: prepare (hash and seal into the spool) and settle. A
         * refresh task gets ~30 seconds and only settles; `BGProcessingTask` is
         * the class iOS provides for minutes of work that can wait for a
         * charger. The name is kept because the bundle declares it.
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

    /** The last path's answer, or null when the monitor has not called back yet. */
    internal fun meteredNow(): Boolean? = if (lastOnline == null) null else lastMetered

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

/**
 * The link and the charger, synchronously (#1080, `DrainRequest`). The link is
 * [IosNetworkStatus]'s last path — null before the monitor first called back —
 * and the charger is `UIDevice`'s battery state, whose monitoring that class
 * turns on. `Full` counts: the phone is on external power.
 */
public class IosPowerAndLink(private val network: IosNetworkStatus) : PowerAndLink {
    override fun metered(): Boolean? = network.meteredNow()

    override fun charging(): Boolean? = when (UIDevice.currentDevice.batteryState) {
        UIDeviceBatteryState.UIDeviceBatteryStateCharging,
        UIDeviceBatteryState.UIDeviceBatteryStateFull,
        -> true
        UIDeviceBatteryState.UIDeviceBatteryStateUnplugged -> false
        else -> null
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
        registerObserverIfAllowed()
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
     * ONE PAGE OF THE CAMERA ROLL (#1025 S6, D-1025-S7-70; #1080, the walker).
     *
     * ## Two walks, one cursor
     *
     * **The first walk is a keyset on `creationDate`**, from the oldest
     * photograph up, and it carries the change token taken when it STARTED
     * (`k|<token>|<millis>|<localIdentifier>`). **Every walk after it is that
     * token's**: the assets ADDED since, in the order Photos recorded them
     * (`t|<token>|<offered>`). A keyset alone missed every asset that arrives
     * with an old capture date — an AirDropped photograph from last year sorts
     * behind the cursor and was never offered — and the token is what Photos
     * keeps for exactly this question. An edit after the walk is not
     * re-offered: the asset is backed up as it was, and marked edited only if
     * it already was. A token Photos
     * will no longer answer for (it expired while the app was not opened)
     * starts the first walk again, and `already_held` makes that walk cheap to
     * the gateway.
     *
     * A cursor a v0 build wrote (`<millis>|<localIdentifier>`, no token)
     * finishes its keyset and then takes the token of that moment.
     *
     * ## The keyset, and the two things that make it not an offset
     *
     * The date alone is not unique — a burst fires ten frames inside one
     * second — so the identifier is the tiebreak. **The predicate is `>=`, not
     * `>`, and the overlap is skipped in Kotlin**: `localIdentifier` is not a
     * key `NSPredicate` over `PHAsset` accepts, so the second half of the
     * keyset is applied one layer out. **An asset with NO `creationDate` reads
     * as `distantPast`**, where Photos' ascending sort puts it too.
     *
     * ## One asset, its resources
     *
     * A Live Photo is ONE asset with two resources: the still and its paired
     * movie, whose ref carries the [PAIRED_VIDEO] suffix. Burst members
     * and RAW get no grouping: grouping on `burstIdentifier` would invent a
     * relationship the owner never made (`NATIVE_V0.md:11-19`).
     */
    override suspend fun page(afterCursor: String?, limit: Int): MediaLibrary.Page {
        val tokenWalk = afterCursor?.takeIf { it.startsWith(TOKEN_WALK + FIELD) }?.split(FIELD)
        if (tokenWalk != null && tokenWalk.size == 3) {
            val offered = tokenWalk[2].toIntOrNull() ?: 0
            return changedPage(tokenWalk[1], offered, limit) ?: keysetPage(null, ChangeTokens.current(), limit)
        }
        val keyset = afterCursor?.takeIf { it.startsWith(KEYSET_WALK + FIELD) }?.split(FIELD, limit = 4)
        if (keyset != null && keyset.size == 4) {
            val from = keyset[2].toLongOrNull()?.let { Cursor(it, keyset[3]) }
            return keysetPage(from, keyset[1].ifEmpty { null }, limit)
        }
        // A v0 CURSOR, or none: the first walk, from its start or from where v0 was.
        val legacy = Cursor.parse(afterCursor)
        return keysetPage(legacy, if (legacy == null) ChangeTokens.current() else null, limit)
    }

    /** The first walk: `creationDate` keyset, carrying the token it started under. */
    private fun keysetPage(from: Cursor?, token: String?, limit: Int): MediaLibrary.Page {
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
            assets += describe(asset, cursor, after = keysetCursor(token, cursor))
        }
        val exhausted = index >= total
        return MediaLibrary.Page(
            assets = assets,
            // THE END OF THE FIRST WALK HANDS OVER TO ITS TOKEN, taken when it
            // started, so nothing added during the walk is missed.
            nextCursor = if (exhausted) {
                (token ?: ChangeTokens.current())?.let { "$TOKEN_WALK$FIELD$it${FIELD}0" }
                    ?: assets.lastOrNull()?.after
            } else {
                assets.lastOrNull()?.after
            },
            exhausted = exhausted,
        )
    }

    /** Every walk after the first: the assets added since [token], [offered] of them already offered. */
    private fun changedPage(token: String, offered: Int, limit: Int): MediaLibrary.Page? {
        val (added, newest) = ChangeTokens.insertedSince(token) ?: return null
        val window = added.drop(offered).take(limit)
        val found = PHAsset.fetchAssetsWithLocalIdentifiers(window, null)
        val byId = (0 until found.count.toInt())
            .mapNotNull { found.objectAtIndex(it.convert()) as? PHAsset }
            .associateBy { it.localIdentifier }
        val assets = window.mapIndexedNotNull { at, id ->
            // ADDED, THEN DELETED inside the window: nothing to offer.
            val asset = byId[id] ?: return@mapIndexedNotNull null
            describe(
                asset,
                Cursor(epochMillisOf(asset), id),
                after = "$TOKEN_WALK$FIELD$token$FIELD${offered + at + 1}",
            )
        }
        val exhausted = offered + window.size >= added.size
        return MediaLibrary.Page(
            assets = assets,
            // CAUGHT UP: the next walk is from the newest change seen.
            nextCursor = if (exhausted) {
                "$TOKEN_WALK$FIELD${newest ?: token}${FIELD}0"
            } else {
                "$TOKEN_WALK$FIELD$token$FIELD${offered + window.size}"
            },
            exhausted = exhausted,
        )
    }

    private fun keysetCursor(token: String?, cursor: Cursor): String =
        if (token == null) cursor.encode() else "$KEYSET_WALK$FIELD$token$FIELD${cursor.encode()}"

    /**
     * One resource's bytes, streamed from Photos (#1080 ruling 6; see
     * [streamResource]). [ref] is an asset's local identifier for its ORIGINAL,
     * or with the [PAIRED_VIDEO] suffix for a Live Photo's movie.
     */
    override suspend fun open(ref: String, allowNetwork: Boolean): MediaLibrary.Opened {
        val paired = ref.endsWith(PAIRED_VIDEO)
        val identifier = if (paired) ref.removeSuffix(PAIRED_VIDEO) else ref
        val asset = PHAsset.fetchAssetsWithLocalIdentifiers(listOf(identifier), null)
            .firstObject as? PHAsset ?: return MediaLibrary.Opened.Gone
        val resources = PHAssetResource.assetResourcesForAsset(asset)
            .filterIsInstance<PHAssetResource>()
        val resource = (if (paired) pairedVideoOf(resources) else originalOf(resources))
            ?: return MediaLibrary.Opened.Gone
        return streamResource(resource, mimeOf(resource.uniformTypeIdentifier), allowNetwork)
    }

    /** A derivative of [ref]'s asset, drawn by Photos from the current edit. See [renderAsset]. */
    override suspend fun render(ref: String, tier: MediaLibrary.Tier): ByteArray? {
        val asset = PHAsset.fetchAssetsWithLocalIdentifiers(listOf(ref.removeSuffix(PAIRED_VIDEO)), null)
            .firstObject as? PHAsset ?: return null
        return renderAsset(asset, tier.longEdge)
    }

    /**
     * `PHPhotoLibraryChangeObserver`, while the app is on screen (#1025 S6).
     *
     * The observer is registered ONCE and the listeners are a list, because
     * `PHPhotoLibrary.registerChangeObserver` retains what it is handed and
     * unregistering is the app's to do at teardown; one observer per listener
     * would be one retained object per screen that ever opened.
     *
     * It reports THAT the library changed and never what changed: the cursor —
     * the change token, after the first walk — is the durable answer, so this
     * is a nudge to run the pass and nothing more.
     */
    override fun onLibraryChanged(listener: () -> Unit) {
        libraryListeners += listener
        registerObserverIfAllowed()
    }

    /**
     * **REGISTERING AN OBSERVER IS AN ACCESS, NOT A SUBSCRIPTION.** With the
     * status still `notDetermined`, `registerChangeObserver` presents the
     * system's photo prompt itself — which is how a phone with no vault yet
     * asked for the camera roll at first launch, over the screen that exists to
     * make one. The observer therefore waits for an answer that lets the app
     * read: it is registered here when one is already held, and again from
     * [requestPermission] when the member grants it from the Photos screen's
     * own button. A grant given in Settings restarts the app, which lands here.
     */
    private fun registerObserverIfAllowed() {
        if (observer != null) return
        val status = PHPhotoLibrary.authorizationStatusForAccessLevel(PHAccessLevelReadWrite)
        if (status != PHAuthorizationStatusAuthorized && status != PHAuthorizationStatusLimited) return
        val watcher = LibraryWatcher { libraryListeners.forEach { it() } }
        observer = watcher
        PHPhotoLibrary.sharedPhotoLibrary().registerChangeObserver(watcher)
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

    /** One `PHAsset` as this interface describes it, with its resources. See [page]. */
    private fun describe(asset: PHAsset, cursor: Cursor, after: String): MediaLibrary.Asset {
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
            // produce a value that never merges anything (D-1025-S7-50).
            perceptualHash = null,
            // ONLY A LIVE PHOTO. Burst members, motion photos and RAW pairs get
            // null, which is the interface's own rule.
            captureGroupId = if (live) asset.localIdentifier else null,
            resources = buildList {
                add(MediaLibrary.Resource(MediaLibrary.Resource.Role.ORIGINAL, asset.localIdentifier))
                if (live) {
                    add(MediaLibrary.Resource(MediaLibrary.Resource.Role.PAIRED_VIDEO, asset.localIdentifier + PAIRED_VIDEO))
                }
            },
            after = after,
            // THE NEXT EDIT REPLACES AN EDITED ASSET'S BYTES (A20).
            edited = asset.hasAdjustments,
        )
    }

    /**
     * THE CURRENT RENDITION (#1080 A20, the ruling for v1).
     *
     * `…FullSizePhoto` and `…FullSizeVideo` are what an EDIT produces and are
     * preferred when present: on an edited asset the member's photograph is
     * the rendered one. Otherwise `PHAssetResourceTypePhoto` and `…Video` —
     * what the camera wrote, the RAW itself for a ProRAW capture. An edited
     * asset is marked ([MediaLibrary.Asset.edited], `StageBegin.os_edited`),
     * because the next edit replaces these bytes: the core never offers it for
     * deletion, so nothing is lost. Backing up the camera original and the
     * edit's adjustment data beside it is an owner question.
     */
    private fun originalOf(resources: List<PHAssetResource>): PHAssetResource? =
        resources.firstOrNull {
            it.type == PHAssetResourceTypeFullSizePhoto || it.type == PHAssetResourceTypeFullSizeVideo
        } ?: resources.firstOrNull {
            it.type == PHAssetResourceTypePhoto || it.type == PHAssetResourceTypeVideo
        }

    /** A Live Photo's movie half, as rendered when the asset was edited. */
    private fun pairedVideoOf(resources: List<PHAssetResource>): PHAssetResource? =
        resources.firstOrNull { it.type == PHAssetResourceTypeFullSizePairedVideo }
            ?: resources.firstOrNull { it.type == PHAssetResourceTypePairedVideo }

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
     * **`PHAsset` publishes no capture time zone.** The shutter's own offset
     * lives in the EXIF `OffsetTimeOriginal` tag inside the original's bytes.
     * Zero, and never the READER'S current offset: a phone that stamped
     * `NSTimeZone.local` onto an import would move every photograph in the
     * roll into whatever zone the member happened to be standing in. Filed as
     * an owner question on #1025.
     */
    private fun offsetMinutesOf(asset: PHAsset): Int = 0

    /** RFC 3339 in UTC, which is what `media.add_asset.captured_at` takes. */
    private fun isoOf(epochMillis: Long): String {
        val formatter = NSDateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'"
        formatter.timeZone = NSTimeZone.timeZoneForSecondsFromGMT(0)
        // POSIX, NOT THE MEMBER'S LOCALE. A device set to a Buddhist or Islamic
        // calendar formats `yyyy` as 2568 or 1447.
        formatter.locale = NSLocale.localeWithLocaleIdentifier("en_US_POSIX")
        return formatter.stringFromDate(
            NSDate.dateWithTimeIntervalSince1970(epochMillis.toDouble() / 1_000.0),
        )
    }

    /**
     * `<epoch millis>|<localIdentifier>`; see [page].
     *
     * `internal` rather than `private` so `iosTest` can drive the round trip.
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
                // makes cheap; a guessed date would SKIP them.
                val millis = encoded.substring(0, at).toLongOrNull() ?: return null
                return Cursor(millis, encoded.substring(at + 1))
            }
        }
    }

    internal companion object Types {
        /** A resource's uniform type as a MIME type. `internal` so `iosTest` can prove the table. */
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

        /** The cursor's field separator. */
        const val FIELD = "|"

        /** A cursor of the first walk, carrying the token it started under. */
        const val KEYSET_WALK = "k"

        /** A cursor of every walk after: the token, and how many of its additions were offered. */
        const val TOKEN_WALK = "t"

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
internal fun NSData.toByteArray(): ByteArray {
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
        utcOffsetMinutes = (NSTimeZone.localTimeZone.secondsFromGMTForDate(NSDate()) / 60L).toInt(),
    )
}
