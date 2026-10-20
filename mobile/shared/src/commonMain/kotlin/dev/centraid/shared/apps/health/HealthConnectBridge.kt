package dev.centraid.shared.apps.health

import centraid.screen.v1.HealthDevice
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * THE PHONE'S HEALTH FACTS, AS THE SHELL LAST STATED THEM (#1129): which store this phone has,
 * the measurement system the member uses, and the types the member chose on Connect and the OS
 * refused (R-1129-6). **The phone's, never the vault's**: the chosen set lives in the shell's own
 * storage, like a followed folder's access (R-1127-7), and the shell states it here at launch,
 * after Connect and when the locale changes. Every Health bridge stamps it on its screen's
 * `Opened`, so a machine is handed it as data.
 */
public object HealthDevices {
    @kotlin.concurrent.Volatile
    private var device: HealthDevice = HealthDevice(units = HealthDevice.Units.UNITS_METRIC)

    /** What the shell said last. */
    public val current: HealthDevice get() = device

    /** The shell's facts, now. */
    public fun update(device: HealthDevice) {
        this.device = device
    }

    /**
     * The same facts, spelled for a shell that cannot build a Wire message: [store] is
     * `apple-health` or `health-connect`, [metric] the measurement system, [chosen] and [refused]
     * the type keys ([HealthMetrics.key], `workouts`).
     */
    public fun update(store: String, metric: Boolean, chosen: List<String>, refused: List<String>) {
        update(of(store, metric, chosen, refused))
    }

    public fun of(store: String, metric: Boolean, chosen: List<String>, refused: List<String>): HealthDevice = HealthDevice(
        store = when (store) {
            APPLE_HEALTH -> HealthDevice.Store.STORE_APPLE_HEALTH
            HEALTH_CONNECT -> HealthDevice.Store.STORE_HEALTH_CONNECT
            else -> HealthDevice.Store.STORE_UNSPECIFIED
        },
        units = if (metric) HealthDevice.Units.UNITS_METRIC else HealthDevice.Units.UNITS_IMPERIAL,
        chosen = chosen,
        refused = refused,
    )

    public const val APPLE_HEALTH: String = "apple-health"
    public const val HEALTH_CONNECT: String = "health-connect"
}

/**
 * CONNECT AND STOP, BOTH SHELLS (#1129): the two acts a member does with the store. The shell owns
 * the OS's authorization (asked only at the member's Connect tap, read types only, R-1129-7) and
 * the chosen set; this owns what the vault is told.
 *
 * - [connect]: the member chose [chosen] and the OS has answered. The chosen set becomes the
 *   phone's [HealthDevices] fact, the store's origin is written at once (which is what makes
 *   Health followed) and the first pass runs: a year of days and 90 days of workouts.
 * - [stop]: Health stops reading the store. Its links are forgotten and its origin retired;
 *   every day and every workout stays.
 *
 * Nothing `suspend`; call on the main thread. [done] is told on the main thread.
 */
public class HealthConnectBridge(
    private val reader: HealthReader,
    private val clock: DeviceClock = platformServices().clock,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: HomeSession? = null

    public fun attach(session: HomeSession) {
        this.session = session
    }

    /**
     * Connect [store] (`apple-health` or `health-connect`) with the types the member chose; [done]
     * is told whether the vault took the store (true even when the first read found nothing).
     */
    public fun connect(store: String, chosen: List<String>, done: (Boolean) -> Unit) {
        val kind = when (store) {
            HealthDevices.APPLE_HEALTH -> HealthStoreKind.APPLE_HEALTH
            HealthDevices.HEALTH_CONNECT -> HealthStoreKind.HEALTH_CONNECT
            else -> return done(false)
        }
        HealthDevices.update(HealthDevices.current.copy(store = HealthDevices.of(store, true, chosen, emptyList()).store, chosen = chosen))
        val core = session?.shelf?.core() ?: return done(false)
        scope.launch { done(HealthImport.connect(core, kind, reader, clock) != null) }
    }

    /** Stop reading the store; [done] is told whether the vault forgot it all. */
    public fun stop(done: (Boolean) -> Unit) {
        val core = session?.shelf?.core() ?: return done(false)
        scope.launch { done(HealthImport.stop(core)) }
    }
}
