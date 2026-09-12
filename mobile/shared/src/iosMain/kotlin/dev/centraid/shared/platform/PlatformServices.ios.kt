@file:OptIn(ExperimentalForeignApi::class)

package dev.centraid.shared.platform

import centraid.screen.v1.MediaPermission
import kotlinx.cinterop.ExperimentalForeignApi
import platform.BackgroundTasks.BGAppRefreshTaskRequest
import platform.BackgroundTasks.BGTaskScheduler
import platform.Foundation.NSDate
import platform.Foundation.dateWithTimeIntervalSinceNow
import platform.Photos.PHAuthorizationStatusAuthorized
import platform.Photos.PHAuthorizationStatusDenied
import platform.Photos.PHAuthorizationStatusLimited
import platform.Photos.PHAuthorizationStatusNotDetermined
import platform.Photos.PHAuthorizationStatusRestricted
import platform.Photos.PHPhotoLibrary
import platform.UIKit.UIDevice

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
    override val networkStatus: NetworkStatus = IosNetworkStatus()
    override val mediaLibrary: MediaLibrary = IosMediaLibrary()
    override val ocr: Ocr = IosOcr()
}

/**
 * The Keychain, through `NSUserDefaults`? **No** — and the absence is the
 * point.
 *
 * v0 put secrets in `expo-secure-store`, which on iOS is the Keychain with
 * `completeUntilFirstUserAuthentication`, and the biometric app lock stores its
 * gate with `requireAuthentication` (`docs/mobile-offline.md:253`, `:259`). The
 * Keychain's C API (`SecItemAdd`/`SecItemCopyMatching`) needs a cinterop of its
 * own over `Security.framework`, which no machine here can build or verify.
 *
 * So this class is DELIBERATELY UNIMPLEMENTED and says so by failing, not by
 * silently writing a secret somewhere unencrypted. `NSUserDefaults` is a plist
 * in the app container: storing a vault credential there would be the worst
 * possible stand-in, and the owner hand-off in `mobile/README.md` names the
 * Keychain wrapper as the first thing a macOS session writes.
 */
public class IosSecureStore : SecureStore {
    override suspend fun read(key: String): String? = unimplemented()

    override suspend fun write(key: String, value: String): Unit = unimplemented()

    override suspend fun clear(): Unit = unimplemented()

    private fun unimplemented(): Nothing = error(
        "IosSecureStore is not implemented: the Keychain needs a " +
            "Security.framework cinterop that no machine in this repository's CI can " +
            "build. It fails loudly rather than writing a vault credential to " +
            "NSUserDefaults, which is a plist in the app container " +
            "(mobile/README.md -> \"What is an owner hand-off\").",
    )
}

public class IosBackgroundTasks : BackgroundTasks {
    override suspend fun register(): BackgroundTasks.Registration {
        val request = BGAppRefreshTaskRequest(TASK_IDENTIFIER)
        request.earliestBeginDate = NSDate.dateWithTimeIntervalSinceNow(EARLIEST_SECONDS)
        var refusal = ""
        val submitted = try {
            BGTaskScheduler.sharedScheduler.submitTaskRequest(request, null)
        } catch (error: Throwable) {
            refusal = error.message ?: "BGTaskScheduler refused"
            false
        }
        return BackgroundTasks.Registration(
            registered = submitted,
            sentence = if (submitted) {
                "Centraid catches up in the background."
            } else {
                "Background App Refresh is off, so Centraid only catches up when you open it."
            },
            refusal = refusal,
        )
    }

    private companion object {
        /** Declared in `Info.plist`'s `BGTaskSchedulerPermittedIdentifiers`. */
        const val TASK_IDENTIFIER = "dev.centraid.sync-pass"
        const val EARLIEST_SECONDS = 15.0 * 60.0
    }
}

/**
 * Connectivity.
 *
 * `NWPathMonitor` is the real answer and needs a `Network.framework` cinterop.
 * Until that lands this reports [NetworkStatus.Reading.platformRefused], which
 * is a TRUE statement — the platform has not been asked — and which
 * `SeatState.Connectivity.CONNECTIVITY_UNKNOWN_PLATFORM_REFUSED` is the value
 * for. Reporting `online = true` would be a guess, and `WriteGate` treats an
 * unknown answer as not-reachable precisely so a guess here cannot send a write
 * into a void.
 */
public class IosNetworkStatus : NetworkStatus {
    override suspend fun current(): NetworkStatus.Reading = NetworkStatus.Reading(
        online = false,
        metered = true,
        charging = UIDevice.currentDevice.batteryState.toInt() == CHARGING,
        platformRefused = true,
    )

    private companion object {
        /** `UIDeviceBatteryStateCharging`. */
        const val CHARGING = 2
    }
}

public class IosMediaLibrary : MediaLibrary {
    override suspend fun permission(): MediaPermission =
        when (PHPhotoLibrary.authorizationStatus()) {
            PHAuthorizationStatusAuthorized -> MediaPermission.MEDIA_PERMISSION_GRANTED
            // A FIRST-CLASS STATE. Not a denial with fewer photos.
            PHAuthorizationStatusLimited -> MediaPermission.MEDIA_PERMISSION_LIMITED
            PHAuthorizationStatusDenied -> MediaPermission.MEDIA_PERMISSION_DENIED
            PHAuthorizationStatusRestricted -> MediaPermission.MEDIA_PERMISSION_RESTRICTED
            PHAuthorizationStatusNotDetermined -> MediaPermission.MEDIA_PERMISSION_NOT_ASKED
            else -> MediaPermission.MEDIA_PERMISSION_UNSPECIFIED
        }

    /**
     * The prompt is the app's, not a library's: `requestAuthorization` takes a
     * completion handler that must be bridged to a suspension, and the sheet is
     * modal over the app's own window. `mobile/iosApp` asks; this reads.
     */
    override suspend fun requestPermission(): MediaPermission = permission()

    /**
     * Enumeration needs `PHAsset` fetch options, `PHAssetResource` for the
     * bytes and a SHA-256 over a streamed resource — three APIs whose Kotlin
     * bindings this file cannot test. It is the largest single piece of the iOS
     * hand-off and `mobile/README.md` names it as such, with the four v0 rules
     * it must keep (exact SHA-256 as identity, dHash as a hint only, one
     * capture group per Live Photo pair, no inferred grouping for motion
     * photos, RAW or burst members).
     */
    override suspend fun page(afterCursor: String?, limit: Int): MediaLibrary.Page = error(
        "IosMediaLibrary.page is not implemented: it needs PHAsset enumeration and a " +
            "streamed SHA-256 over PHAssetResource, on a machine with an Xcode " +
            "(mobile/README.md -> \"The iOS hand-off\"). Returning an empty page would " +
            "be a camera roll that looks empty.",
    )

}

/** Wave 4. Vision is not wired yet, and saying so beats a stub. */
public class IosOcr : Ocr {
    override suspend fun available(): Boolean = false

    override suspend fun recognise(imagePath: String): List<String> = emptyList()
}
