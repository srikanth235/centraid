package dev.centraid.shared.apps.health

import centraid.screen.v1.HealthDevice
import dev.centraid.core.CentraidCore
import dev.centraid.design.copy.HealthCopy
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.sync.phone.GoneChoice
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneFollowPass
import dev.centraid.shared.sync.phone.PhoneFollowReads
import dev.centraid.shared.sync.phone.PhoneFollowSource
import dev.centraid.shared.sync.phone.PhoneSource

/** WHICH HEALTH STORE THIS PHONE HAS: one origin each (R-1129-2). */
public enum class HealthStoreKind(public val origin: String, public val label: String) {
    APPLE_HEALTH("store:apple-health", HealthCopy.STORE_APPLE_HEALTH),
    HEALTH_CONNECT("store:health-connect", HealthCopy.STORE_HEALTH_CONNECT),
    ;

    public companion object {
        public fun of(store: HealthDevice.Store): HealthStoreKind? = when (store) {
            HealthDevice.Store.STORE_APPLE_HEALTH -> APPLE_HEALTH
            HealthDevice.Store.STORE_HEALTH_CONNECT -> HEALTH_CONNECT
            else -> null
        }
    }
}

/**
 * ONE DAY'S TOTAL AS THE STORE STATES IT: [day] the store's own day in the device's zone (a night
 * of sleep is keyed to the day the member woke), [metric] a [HealthMetrics.key], [value] in the
 * metric's own unit — the store's statistics, so a watch and a phone counting the same steps
 * count once.
 */
public data class HealthDayTotal(
    public val day: String,
    public val metric: String,
    public val value: Double,
)

/**
 * ONE WORKOUT AS THE STORE HOLDS IT.
 *
 * @property id the store's own id for it (HealthKit's `HKWorkout.uuid`, Health Connect's record
 *   id): it means something on this phone only, so it is followed as `local:<id>` (R-1127-10)
 *   and a new phone re-adopts by kind and start minute instead.
 * @property kind the store's word for the kind, whole ([HealthKinds]).
 * @property startedAt and [endedAt] UTC instants, `YYYY-MM-DDTHH:MM:SS[.sss]Z`.
 */
public data class PhoneWorkout(
    public val id: String,
    public val kind: String,
    public val startedAt: String,
    public val endedAt: String,
    public val movingSec: Long? = null,
    public val distanceM: Double? = null,
    public val energyKcal: Double? = null,
    public val avgHrBpm: Long? = null,
    public val elevationGainM: Double? = null,
    public val recordedBy: String? = null,
)

/**
 * WHAT THE SHELL READ OF THE HEALTH STORE over a [HealthWindow], for the types the member chose
 * (R-1129-6). Nothing is ever written to the store (R-1129-7).
 *
 * @property days every day total the store has in [HealthWindow.totalsFrom]..today, chosen
 *   metrics only; a day the store has nothing for is absent, never a zero.
 * @property workouts every workout started since [HealthWindow.workoutsSince].
 * @property chosen the types the member chose, by key ([HealthMetrics.key], `workouts`).
 * @property refused the chosen types the OS refused (Health Connect names them; HealthKit cannot,
 *   so iOS leaves this empty).
 * @property workoutsComplete false when the workout read may have missed some (a query that
 *   failed part-way). **An empty workout read is incomplete regardless** (R-1129-5): iOS hides a
 *   revoked read, so "no workouts" may mean "not allowed", and nothing is removed for it.
 * @property storePresent false when the store is not on the phone at all (Health Connect
 *   uninstalled): the store's origin is then gone, and the member is asked about its workouts.
 */
public data class HealthRead(
    public val store: HealthStoreKind,
    public val days: List<HealthDayTotal>,
    public val workouts: List<PhoneWorkout>,
    public val chosen: List<String>,
    public val refused: List<String> = emptyList(),
    public val workoutsComplete: Boolean = true,
    public val storePresent: Boolean = true,
)

/**
 * THE WINDOW A PASS READS (R-1129-4), derived from what the vault holds and never stored.
 *
 * @property today the phone's day.
 * @property totalsFrom the first day whose totals are read, `YYYY-MM-DD`.
 * @property workoutsFrom the first day whose workouts are read.
 * @property workoutsSince the instant [workoutsFrom] begins on this phone, epoch milliseconds: a
 *   reader asks for workouts that started at or after it.
 */
public data class HealthWindow(
    public val today: String,
    public val totalsFrom: String,
    public val workoutsFrom: String,
    public val workoutsSince: Long,
    public val held: List<HealthDayTotal> = emptyList(),
)

/** THE SHELL'S HEALTH READER: HealthKit's statistics collection and workout queries, Health Connect's aggregate and `ExerciseSessionRecord`. */
public interface HealthReader {
    /**
     * Read the chosen types over [window] and hand them to [deliver], off the main thread; **null
     * when access was never granted**. A following pass never asks the OS for permission: only
     * the member's Connect tap does (R-1127-15). Read only — the share set is empty (R-1129-7).
     */
    public fun read(window: HealthWindow, deliver: (HealthRead?) -> Unit)
}

/** THE HEALTH STORE → HEALTH, FOLLOWED (#1129): the shell hands this to the follower with its [reader]. */
public class HealthFollow(
    private val reader: HealthReader,
    private val clock: DeviceClock = platformServices().clock,
) : PhoneFollowSource {
    override val source: PhoneSource = PhoneSource.HEALTH

    override fun bind(core: CentraidCore): PhoneFollowPass = object : PhoneFollowPass {
        override suspend fun imported(): Boolean? = PhoneFollowReads.imported(core, PhoneSource.HEALTH)

        override suspend fun run(): List<OriginGone>? = HealthImport.pass(core, reader, clock)?.gone

        override suspend fun resolve(gone: OriginGone, keep: Boolean) {
            HealthImport.resolveGone(core, gone.originId, if (keep) GoneChoice.KEEP else GoneChoice.TRASH, gone.seenBefore.ifEmpty { null })
        }
    }
}
