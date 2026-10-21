package dev.centraid.android.kit

import android.content.Context
import android.content.Intent
import android.icu.util.LocaleData
import android.icu.util.ULocale
import android.os.Build
import androidx.activity.result.contract.ActivityResultContract
import androidx.annotation.ChecksSdkIntAtLeast
import androidx.annotation.RequiresApi
import androidx.core.content.edit
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.aggregate.AggregateMetric
import androidx.health.connect.client.aggregate.AggregationResult
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ElevationGainedRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import dev.centraid.shared.apps.health.HealthDayTotal
import dev.centraid.shared.apps.health.HealthDevices
import dev.centraid.shared.apps.health.HealthImport
import dev.centraid.shared.apps.health.HealthMetrics
import dev.centraid.shared.apps.health.HealthRead
import dev.centraid.shared.apps.health.HealthReader
import dev.centraid.shared.apps.health.HealthStoreKind
import dev.centraid.shared.apps.health.HealthWindow
import dev.centraid.shared.apps.health.PhoneWorkout
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.Period
import java.time.ZoneId
import java.util.Locale
import kotlin.reflect.KClass

/**
 * HEALTH CONNECT → HEALTH, READ ONLY (#1129). Everything the Android shell does with Health
 * Connect lives here: whether it can be reached, which permissions a chosen type needs, the
 * member's chosen set, the phone's facts stated to the screens, and the [HealthReader] the
 * follower and Connect read through.
 *
 * - **Nothing is written to Health Connect** (R-1129-7): the manifest declares `READ_*` health
 *   permissions only and this file calls no insert, update or delete (`HealthConnectReadOnlySpec`
 *   holds both).
 * - **The OS is asked only at the member's Connect tap**, through [contract], for exactly the
 *   chosen types' [permissionsFor] (R-1127-15); a read never asks, and answers null when nothing
 *   was ever granted.
 * - **Below API 26, or while Health Connect is not available, no class of the client is
 *   touched.** Its library says minSdk 26 and the app stays at 24 (an owner setting), so the
 *   manifest admits the library below its floor and [HealthConnectAccess.status] gates every
 *   call: below 26 Health Connect is [HealthConnectAccess.Status.UNAVAILABLE].
 * - **The chosen set is the shell's** (R-1129-6), kept in this app's own preferences and never
 *   in the vault, like a followed folder's access.
 *
 * Built on the application context, so it keeps no activity alive.
 */
internal class AndroidHealth(context: Context) {
    private val context: Context = context.applicationContext
    private val prefs = this.context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val io = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** The reader the follower and Connect hand to the shared engine. */
    val reader: HealthReader = HealthConnectReader(this.context, ::chosen)

    /** Whether Health Connect can be asked anything on this phone, now. */
    fun status(): HealthConnectAccess.Status = HealthConnectAccess.status(context)

    /** The type keys the member chose on Connect, in the order Health lists them; empty before the first Connect. */
    fun chosen(): List<String> {
        val stored = prefs.getStringSet(CHOSEN, null).orEmpty()
        return HealthConnectAccess.KEYS.filter { it in stored }
    }

    /** Keep the member's choice: the shell's, never the vault's (R-1129-6). */
    fun choose(keys: List<String>) {
        prefs.edit { putStringSet(CHOSEN, keys.toSet()) }
    }

    /**
     * STATE THE PHONE'S FACTS to the screens ([HealthDevices]): Health Connect, the locale's
     * measurement system and the chosen set at once, then — off the main thread — which chosen
     * types Health Connect refused. Called when the activity starts, which a locale change also
     * does (the activity is re-made), and after Connect.
     */
    fun state() {
        val chosen = chosen()
        HealthDevices.update(HealthDevices.HEALTH_CONNECT, metric(), chosen, HealthDevices.current.refused.filter { it in chosen })
        if (chosen.isEmpty() || status() != HealthConnectAccess.Status.AVAILABLE) return
        io.launch {
            val granted = HealthConnectAccess.granted(context) ?: return@launch
            HealthDevices.update(HealthDevices.HEALTH_CONNECT, metric(), chosen, HealthConnectAccess.refused(chosen, granted))
        }
    }

    /** The permissions Connect asks for [keys]: each type's read, a workout's figures, and the history read where offered. */
    fun permissionsFor(keys: List<String>): Set<String> = HealthConnectAccess.permissionsFor(context, keys)

    /** What Health Connect has granted, or null when it cannot be asked. Suspends; call off the main thread. */
    suspend fun granted(): Set<String>? = HealthConnectAccess.granted(context)

    /** The permission sheet, as an activity result; below API 26 a contract that grants nothing. */
    fun contract(): ActivityResultContract<Set<String>, Set<String>> = HealthConnectAccess.contract()

    /**
     * THE MEMBER'S MEASUREMENT SYSTEM, for display only (storage is the metric's own unit).
     * ICU's answer on API 28 and up; below it, the three countries that measure in miles and
     * pounds. Only the US system reads as imperial.
     */
    private fun metric(): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        LocaleData.getMeasurementSystem(ULocale.getDefault()) != LocaleData.MeasurementSystem.US
    } else {
        Locale.getDefault().country !in IMPERIAL_COUNTRIES
    }

    private companion object {
        const val PREFS: String = "health"
        const val CHOSEN: String = "chosen"
        val IMPERIAL_COUNTRIES: Set<String> = setOf("US", "LR", "MM")
    }
}

/**
 * WHERE HEALTH CONNECT STANDS ON THIS PHONE AND WHAT A TYPE COSTS IN PERMISSIONS. Every client call
 * goes through [status] first; nothing here loads a client class below API 26.
 */
internal object HealthConnectAccess {
    /** Health Connect's answer to "can you be asked": yes, after an install or an update, or never here. */
    enum class Status { AVAILABLE, INSTALL, UNAVAILABLE }

    /** The client's own floor: below it Health Connect is [Status.UNAVAILABLE] and nothing of it loads. */
    @get:ChecksSdkIntAtLeast(api = Build.VERSION_CODES.O)
    val apiSupported: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O

    /** The type keys a member can choose, in the order Health lists them ([HealthMetrics], then workouts). */
    val KEYS: List<String> = HealthMetrics.entries.map { it.key } + HealthMetrics.WORKOUTS

    private const val PREFIX: String = "android.permission.health."
    const val READ_STEPS: String = PREFIX + "READ_STEPS"
    const val READ_ACTIVE_CALORIES_BURNED: String = PREFIX + "READ_ACTIVE_CALORIES_BURNED"
    const val READ_EXERCISE: String = PREFIX + "READ_EXERCISE"
    const val READ_SLEEP: String = PREFIX + "READ_SLEEP"
    const val READ_RESTING_HEART_RATE: String = PREFIX + "READ_RESTING_HEART_RATE"
    const val READ_WEIGHT: String = PREFIX + "READ_WEIGHT"
    const val READ_DISTANCE: String = PREFIX + "READ_DISTANCE"
    const val READ_HEART_RATE: String = PREFIX + "READ_HEART_RATE"
    const val READ_ELEVATION_GAINED: String = PREFIX + "READ_ELEVATION_GAINED"
    const val READ_HEALTH_DATA_HISTORY: String = PREFIX + "READ_HEALTH_DATA_HISTORY"

    /**
     * THE ONE PERMISSION A TYPE STANDS ON: a type whose permission is not granted is refused
     * (R-1129-6) and not read. Workouts and exercise minutes both stand on exercise sessions.
     */
    val TYPE: Map<String, String> = mapOf(
        HealthMetrics.STEPS.key to READ_STEPS,
        HealthMetrics.SLEEP.key to READ_SLEEP,
        HealthMetrics.ENERGY.key to READ_ACTIVE_CALORIES_BURNED,
        HealthMetrics.EXERCISE.key to READ_EXERCISE,
        HealthMetrics.RESTING_HR.key to READ_RESTING_HEART_RATE,
        HealthMetrics.WEIGHT.key to READ_WEIGHT,
        HealthMetrics.WORKOUTS to READ_EXERCISE,
    )

    /**
     * A WORKOUT'S FIGURES, asked for with workouts and never standing in their way: one not granted
     * leaves that figure out of every workout, and the workout is still read.
     */
    val FIGURES: List<String> = listOf(READ_DISTANCE, READ_ACTIVE_CALORIES_BURNED, READ_HEART_RATE, READ_ELEVATION_GAINED)

    fun status(context: Context): Status {
        if (!apiSupported) return Status.UNAVAILABLE
        return when (runCatching { HealthConnectClient.getSdkStatus(context) }.getOrNull()) {
            HealthConnectClient.SDK_AVAILABLE -> Status.AVAILABLE
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> Status.INSTALL
            else -> Status.UNAVAILABLE
        }
    }

    /**
     * Each chosen type's permission, a workout's figures when workouts are chosen, and the history
     * read when this Health Connect offers it — so the first read reaches the year Health keeps
     * rather than the 30 days before the grant. Read permissions only (R-1129-7).
     */
    fun permissionsFor(context: Context, keys: List<String>): Set<String> {
        val types = keys.mapNotNull { TYPE[it] }
        if (types.isEmpty()) return emptySet()
        return buildSet {
            addAll(types)
            if (HealthMetrics.WORKOUTS in keys) addAll(FIGURES)
            if (historyOffered(context)) add(READ_HEALTH_DATA_HISTORY)
        }
    }

    /** The chosen [keys] whose type permission [granted] lacks, in the order chosen. */
    fun refused(keys: List<String>, granted: Set<String>): List<String> = keys.filter { key -> TYPE[key]?.let { it !in granted } ?: false }

    /** What Health Connect has granted this app, or null when it cannot be asked. */
    suspend fun granted(context: Context): Set<String>? {
        if (!apiSupported || status(context) != Status.AVAILABLE) return null
        return runCatching { HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions() }.getOrNull()
    }

    fun contract(): ActivityResultContract<Set<String>, Set<String>> =
        if (apiSupported) PermissionController.createRequestPermissionResultContract() else NothingGranted

    private fun historyOffered(context: Context): Boolean {
        if (!apiSupported || status(context) != Status.AVAILABLE) return false
        return runCatching {
            HealthConnectClient.getOrCreate(context).features
                .getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY) == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
        }.getOrDefault(false)
    }

    /** Below API 26: no sheet, nothing granted. Never launched — Connect stops at [status] first. */
    private object NothingGranted : ActivityResultContract<Set<String>, Set<String>>() {
        override fun createIntent(context: Context, input: Set<String>): Intent = Intent()

        override fun parseResult(resultCode: Int, intent: Intent?): Set<String> = emptySet()
    }
}

/**
 * THE READER (#1129, `lane-k-api.md` §3): Health Connect's own statistics for the chosen types over
 * the window the engine derived, and every workout since its start. Off the main thread; **null
 * when Health Connect has granted nothing**, and `storePresent = false` when it is not on the phone.
 *
 * - **Days** are the store's own aggregates bucketed by the device's local day
 *   (`aggregateGroupByPeriod` over `totalsFrom..today`), so a watch and a phone counting the same
 *   steps count once: steps, active energy (kcal), exercise minutes (exercise sessions' duration)
 *   and the day's average resting heart rate. **Weight** is the day's last weighing (kg).
 *   **Sleep** is the minutes asleep of the sessions that END on the day — awake stages left out
 *   where a session has stages, and sessions that overlap (two apps saw one night) merged first.
 * - **A metric is all or nothing.** One that fails part-way is left out of the read entirely, so
 *   the engine's zero rule never reads a lost page as a deleted day (R-1129-3, RP-K-3).
 * - **Workouts** are the exercise sessions started at or after `workoutsSince`, each with the
 *   store's id, its `EXERCISE_TYPE_*` name ([ExerciseNames]), its span, and what Health Connect
 *   aggregates over it. A workout whose figures could not be read is left out and the read is
 *   marked incomplete, which removes nothing (R-1129-5).
 */
internal class HealthConnectReader(
    private val context: Context,
    private val chosen: () -> List<String>,
) : HealthReader {
    private val io = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun read(window: HealthWindow, deliver: (HealthRead?) -> Unit) {
        val keys = chosen()
        if (!HealthConnectAccess.apiSupported || HealthConnectAccess.status(context) != HealthConnectAccess.Status.AVAILABLE) {
            return deliver(HealthRead(HealthStoreKind.HEALTH_CONNECT, emptyList(), emptyList(), keys, storePresent = false))
        }
        io.launch {
            // A FAILURE NOBODY PLANNED FOR IS "NOTHING READ": the pass does nothing, never a removal.
            deliver(runCatching { readNow(window, keys) }.getOrNull())
        }
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private suspend fun readNow(window: HealthWindow, keys: List<String>): HealthRead? {
        val client = HealthConnectClient.getOrCreate(context)
        val granted = client.permissionController.getGrantedPermissions()
        if (HealthConnectAccess.TYPE.values.none { it in granted }) return null
        val refused = HealthConnectAccess.refused(keys, granted)
        HealthDevices.update(HealthDevices.current.copy(refused = refused))
        val allowed = keys - refused.toSet()
        val zone = ZoneId.systemDefault()
        val from = LocalDate.parse(window.totalsFrom)
        val today = LocalDate.parse(window.today)
        val days = buildList {
            dailyReads().forEach { (metric, read) ->
                if (metric.key in allowed) {
                    runCatching { daily(client, from, today, read) }.getOrNull()?.forEach { (day, value) ->
                        add(HealthDayTotal(day, metric.key, value))
                    }
                }
            }
            if (HealthMetrics.SLEEP.key in allowed) {
                runCatching { sleep(client, zone, from, today) }.getOrNull()?.let { addAll(it) }
            }
            if (HealthMetrics.WEIGHT.key in allowed) {
                runCatching { weight(client, zone, from, today) }.getOrNull()?.let { addAll(it) }
            }
        }
        val sessions = if (HealthMetrics.WORKOUTS in allowed) {
            runCatching { workouts(client, granted, window.workoutsSince) }.getOrNull() ?: (emptyList<PhoneWorkout>() to false)
        } else {
            emptyList<PhoneWorkout>() to true
        }
        return HealthRead(
            store = HealthStoreKind.HEALTH_CONNECT,
            days = days,
            workouts = sessions.first,
            chosen = keys,
            refused = refused,
            workoutsComplete = sessions.second,
        )
    }

    /** One metric's day totals, bucketed by the device's local day, a season at a time. */
    @RequiresApi(Build.VERSION_CODES.O)
    private suspend fun daily(
        client: HealthConnectClient,
        from: LocalDate,
        today: LocalDate,
        read: DailyRead,
    ): List<Pair<String, Double>> = buildList {
        var start = from
        while (!start.isAfter(today)) {
            val end = minOf(start.plusDays(SLICE_DAYS - 1), today)
            val groups = client.aggregateGroupByPeriod(
                AggregateGroupByPeriodRequest(
                    metrics = setOf(read.metric),
                    timeRangeFilter = TimeRangeFilter.between(start.atStartOfDay(), end.plusDays(1).atStartOfDay()),
                    timeRangeSlicer = Period.ofDays(1),
                ),
            )
            groups.forEach { group -> read.value(group.result)?.let { add(group.startTime.toLocalDate().toString() to it) } }
            start = end.plusDays(1)
        }
    }

    /** Minutes asleep, keyed to the local day each night ends on. */
    @RequiresApi(Build.VERSION_CODES.O)
    private suspend fun sleep(client: HealthConnectClient, zone: ZoneId, from: LocalDate, today: LocalDate): List<HealthDayTotal> {
        // A night that ends on `from` began the evening before it.
        val sessions = readAll(client, SleepSessionRecord::class, from.minusDays(1), today, zone)
        val nights = sessions.map { session ->
            val asleep = if (session.stages.isEmpty()) {
                listOf(session.startTime.toEpochMilli() to session.endTime.toEpochMilli())
            } else {
                session.stages.filter { it.stage !in AWAKE_STAGES }.map { it.startTime.toEpochMilli() to it.endTime.toEpochMilli() }
            }
            SleepNights.Session(session.startTime.toEpochMilli(), session.endTime.toEpochMilli(), asleep)
        }
        val first = from.toString()
        val last = today.toString()
        return SleepNights.minutesByEnd(nights) { end -> Instant.ofEpochMilli(end).atZone(zone).toLocalDate().toString() }
            .filterKeys { it in first..last }
            .map { (day, minutes) -> HealthDayTotal(day, HealthMetrics.SLEEP.key, minutes) }
    }

    /** The last weighing of each local day, in kilograms. */
    @RequiresApi(Build.VERSION_CODES.O)
    private suspend fun weight(client: HealthConnectClient, zone: ZoneId, from: LocalDate, today: LocalDate): List<HealthDayTotal> =
        readAll(client, WeightRecord::class, from, today, zone)
            .groupBy { it.time.atZone(zone).toLocalDate().toString() }
            .mapNotNull { (day, weighings) ->
                weighings.maxByOrNull { it.time }?.let { HealthDayTotal(day, HealthMetrics.WEIGHT.key, it.weight.inKilograms) }
            }

    /**
     * Every exercise session started at or after [since], with what Health Connect aggregates over
     * its span; second is false when one or more could not be read whole.
     */
    @RequiresApi(Build.VERSION_CODES.O)
    private suspend fun workouts(client: HealthConnectClient, granted: Set<String>, since: Long): Pair<List<PhoneWorkout>, Boolean> {
        val sessions = pages(client, ExerciseSessionRecord::class, TimeRangeFilter.after(Instant.ofEpochMilli(since)))
            .filter { it.startTime.toEpochMilli() >= since }
        val metrics: Set<AggregateMetric<*>> = buildSet {
            add(ExerciseSessionRecord.EXERCISE_DURATION_TOTAL)
            if (HealthConnectAccess.READ_DISTANCE in granted) add(DistanceRecord.DISTANCE_TOTAL)
            if (HealthConnectAccess.READ_ACTIVE_CALORIES_BURNED in granted) add(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL)
            if (HealthConnectAccess.READ_HEART_RATE in granted) add(HeartRateRecord.BPM_AVG)
            if (HealthConnectAccess.READ_ELEVATION_GAINED in granted) add(ElevationGainedRecord.ELEVATION_GAINED_TOTAL)
        }
        val labels = mutableMapOf<String, String>()
        var complete = true
        val read = sessions.mapNotNull { session ->
            val figures = runCatching {
                client.aggregate(AggregateRequest(metrics = metrics, timeRangeFilter = TimeRangeFilter.between(session.startTime, session.endTime)))
            }.getOrNull()
            if (figures == null) {
                complete = false
                return@mapNotNull null
            }
            val origin = session.metadata.dataOrigin.packageName
            PhoneWorkout(
                id = session.metadata.id,
                kind = ExerciseNames.name(session.exerciseType),
                startedAt = HealthImport.instantOf(session.startTime.toEpochMilli()),
                endedAt = HealthImport.instantOf(session.endTime.toEpochMilli()),
                movingSec = figures[ExerciseSessionRecord.EXERCISE_DURATION_TOTAL]?.seconds,
                distanceM = figures[DistanceRecord.DISTANCE_TOTAL]?.inMeters,
                energyKcal = figures[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.inKilocalories,
                avgHrBpm = figures[HeartRateRecord.BPM_AVG],
                elevationGainM = figures[ElevationGainedRecord.ELEVATION_GAINED_TOTAL]?.inMeters,
                recordedBy = origin.takeIf { it.isNotEmpty() }?.let { labels.getOrPut(it) { label(it) } },
            )
        }
        return read to complete
    }

    /** The app's own name for [packageName] when the phone will say it, else the package name. */
    private fun label(packageName: String): String = runCatching {
        val pm = context.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
    }.getOrNull()?.takeIf { it.isNotBlank() } ?: packageName

    /** Every record of [type] in the local days [from]..[to], page by page. */
    @RequiresApi(Build.VERSION_CODES.O)
    private suspend fun <T : Record> readAll(client: HealthConnectClient, type: KClass<T>, from: LocalDate, to: LocalDate, zone: ZoneId): List<T> =
        pages(client, type, TimeRangeFilter.between(from.atStartOfDay(zone).toInstant(), to.plusDays(1).atStartOfDay(zone).toInstant()))

    @RequiresApi(Build.VERSION_CODES.O)
    private suspend fun <T : Record> pages(client: HealthConnectClient, type: KClass<T>, range: TimeRangeFilter): List<T> = buildList {
        var token: String? = null
        do {
            val page = client.readRecords(ReadRecordsRequest(recordType = type, timeRangeFilter = range, pageToken = token))
            addAll(page.records)
            token = page.pageToken?.takeIf { it.isNotEmpty() }
        } while (token != null)
    }

    /** One daily metric: what is aggregated, and the day's value in the metric's own unit. */
    private class DailyRead(val metric: AggregateMetric<*>, val value: (AggregationResult) -> Double?)

    private companion object {
        /** A season of days per aggregate call: a year's backfill is a few calls, not one huge one. */
        const val SLICE_DAYS: Long = 92

        const val MS_PER_MINUTE: Double = 60_000.0

        /** The four daily metrics; built per read, past the API gate (they are client classes). */
        @RequiresApi(Build.VERSION_CODES.O)
        fun dailyReads(): List<Pair<HealthMetrics, DailyRead>> =
            listOf(
                HealthMetrics.STEPS to DailyRead(StepsRecord.COUNT_TOTAL) { it[StepsRecord.COUNT_TOTAL]?.toDouble() },
                HealthMetrics.ENERGY to DailyRead(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL) {
                    it[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.inKilocalories
                },
                HealthMetrics.EXERCISE to DailyRead(ExerciseSessionRecord.EXERCISE_DURATION_TOTAL) {
                    it[ExerciseSessionRecord.EXERCISE_DURATION_TOTAL]?.let { duration -> duration.toMillis() / MS_PER_MINUTE }
                },
                HealthMetrics.RESTING_HR to DailyRead(RestingHeartRateRecord.BPM_AVG) { it[RestingHeartRateRecord.BPM_AVG]?.toDouble() },
            )

        /** The stages a member is awake in: out of a night's asleep total. */
        val AWAKE_STAGES: Set<Int> = setOf(
            SleepSessionRecord.STAGE_TYPE_AWAKE,
            SleepSessionRecord.STAGE_TYPE_OUT_OF_BED,
            SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED,
        )
    }
}

/**
 * A NIGHT, FOLDED (#1129). Sessions that overlap are one night however many apps saw it; its asleep
 * time is the union of every asleep span inside it, and it counts on the local day it ends.
 * Plain epoch milliseconds, so it holds no client class.
 */
internal object SleepNights {
    /** One session: its span and its asleep spans (the whole span when it has no stages). */
    data class Session(val start: Long, val end: Long, val asleep: List<Pair<Long, Long>>)

    /** Minutes asleep per day, the day being [dayOf] the end of each night. */
    fun minutesByEnd(sessions: List<Session>, dayOf: (Long) -> String): Map<String, Double> {
        val nights = mutableListOf<MutableList<Session>>()
        var reach = Long.MIN_VALUE
        sessions.sortedBy { it.start }.forEach { session ->
            if (nights.isEmpty() || session.start >= reach) {
                nights += mutableListOf(session)
                reach = session.end
            } else {
                nights.last() += session
                reach = maxOf(reach, session.end)
            }
        }
        val minutes = linkedMapOf<String, Double>()
        nights.forEach { night ->
            val asleep = union(night.flatMap { it.asleep })
            if (asleep > 0) {
                val day = dayOf(night.maxOf { it.end })
                minutes[day] = (minutes[day] ?: 0.0) + asleep / MS_PER_MINUTE
            }
        }
        return minutes
    }

    /** The length of the union of [spans], in milliseconds. */
    private fun union(spans: List<Pair<Long, Long>>): Long {
        var total = 0L
        var open = 0L
        var close = Long.MIN_VALUE
        spans.filter { it.second > it.first }.sortedBy { it.first }.forEach { (start, end) ->
            if (start > close) {
                if (close != Long.MIN_VALUE) total += close - open
                open = start
                close = end
            } else if (end > close) {
                close = end
            }
        }
        if (close != Long.MIN_VALUE) total += close - open
        return total
    }

    private const val MS_PER_MINUTE: Double = 60_000.0
}

/**
 * HEALTH CONNECT'S EXERCISE TYPES BY NAME (#1129): the `ExerciseSessionRecord.EXERCISE_TYPE_*`
 * constant's name is the store's word Health keeps (`HealthKinds.TABLE` maps the ones it seeds);
 * a value this table does not know is the store's "other workout". Spelled out rather than
 * reflected, because a release build's shrinker renames the constants.
 */
internal object ExerciseNames {
    fun name(type: Int): String = NAMES[type] ?: "EXERCISE_TYPE_OTHER_WORKOUT"

    private val NAMES: Map<Int, String> = mapOf(
        ExerciseSessionRecord.EXERCISE_TYPE_OTHER_WORKOUT to "EXERCISE_TYPE_OTHER_WORKOUT",
        ExerciseSessionRecord.EXERCISE_TYPE_BADMINTON to "EXERCISE_TYPE_BADMINTON",
        ExerciseSessionRecord.EXERCISE_TYPE_BASEBALL to "EXERCISE_TYPE_BASEBALL",
        ExerciseSessionRecord.EXERCISE_TYPE_BASKETBALL to "EXERCISE_TYPE_BASKETBALL",
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING to "EXERCISE_TYPE_BIKING",
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY to "EXERCISE_TYPE_BIKING_STATIONARY",
        ExerciseSessionRecord.EXERCISE_TYPE_BOOT_CAMP to "EXERCISE_TYPE_BOOT_CAMP",
        ExerciseSessionRecord.EXERCISE_TYPE_BOXING to "EXERCISE_TYPE_BOXING",
        ExerciseSessionRecord.EXERCISE_TYPE_CALISTHENICS to "EXERCISE_TYPE_CALISTHENICS",
        ExerciseSessionRecord.EXERCISE_TYPE_CRICKET to "EXERCISE_TYPE_CRICKET",
        ExerciseSessionRecord.EXERCISE_TYPE_DANCING to "EXERCISE_TYPE_DANCING",
        ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL to "EXERCISE_TYPE_ELLIPTICAL",
        ExerciseSessionRecord.EXERCISE_TYPE_EXERCISE_CLASS to "EXERCISE_TYPE_EXERCISE_CLASS",
        ExerciseSessionRecord.EXERCISE_TYPE_FENCING to "EXERCISE_TYPE_FENCING",
        ExerciseSessionRecord.EXERCISE_TYPE_FOOTBALL_AMERICAN to "EXERCISE_TYPE_FOOTBALL_AMERICAN",
        ExerciseSessionRecord.EXERCISE_TYPE_FOOTBALL_AUSTRALIAN to "EXERCISE_TYPE_FOOTBALL_AUSTRALIAN",
        ExerciseSessionRecord.EXERCISE_TYPE_FRISBEE_DISC to "EXERCISE_TYPE_FRISBEE_DISC",
        ExerciseSessionRecord.EXERCISE_TYPE_GOLF to "EXERCISE_TYPE_GOLF",
        ExerciseSessionRecord.EXERCISE_TYPE_GUIDED_BREATHING to "EXERCISE_TYPE_GUIDED_BREATHING",
        ExerciseSessionRecord.EXERCISE_TYPE_GYMNASTICS to "EXERCISE_TYPE_GYMNASTICS",
        ExerciseSessionRecord.EXERCISE_TYPE_HANDBALL to "EXERCISE_TYPE_HANDBALL",
        ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING to "EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING",
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING to "EXERCISE_TYPE_HIKING",
        ExerciseSessionRecord.EXERCISE_TYPE_ICE_HOCKEY to "EXERCISE_TYPE_ICE_HOCKEY",
        ExerciseSessionRecord.EXERCISE_TYPE_ICE_SKATING to "EXERCISE_TYPE_ICE_SKATING",
        ExerciseSessionRecord.EXERCISE_TYPE_MARTIAL_ARTS to "EXERCISE_TYPE_MARTIAL_ARTS",
        ExerciseSessionRecord.EXERCISE_TYPE_PADDLING to "EXERCISE_TYPE_PADDLING",
        ExerciseSessionRecord.EXERCISE_TYPE_PARAGLIDING to "EXERCISE_TYPE_PARAGLIDING",
        ExerciseSessionRecord.EXERCISE_TYPE_PILATES to "EXERCISE_TYPE_PILATES",
        ExerciseSessionRecord.EXERCISE_TYPE_RACQUETBALL to "EXERCISE_TYPE_RACQUETBALL",
        ExerciseSessionRecord.EXERCISE_TYPE_ROCK_CLIMBING to "EXERCISE_TYPE_ROCK_CLIMBING",
        ExerciseSessionRecord.EXERCISE_TYPE_ROLLER_HOCKEY to "EXERCISE_TYPE_ROLLER_HOCKEY",
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING to "EXERCISE_TYPE_ROWING",
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE to "EXERCISE_TYPE_ROWING_MACHINE",
        ExerciseSessionRecord.EXERCISE_TYPE_RUGBY to "EXERCISE_TYPE_RUGBY",
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING to "EXERCISE_TYPE_RUNNING",
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL to "EXERCISE_TYPE_RUNNING_TREADMILL",
        ExerciseSessionRecord.EXERCISE_TYPE_SAILING to "EXERCISE_TYPE_SAILING",
        ExerciseSessionRecord.EXERCISE_TYPE_SCUBA_DIVING to "EXERCISE_TYPE_SCUBA_DIVING",
        ExerciseSessionRecord.EXERCISE_TYPE_SKATING to "EXERCISE_TYPE_SKATING",
        ExerciseSessionRecord.EXERCISE_TYPE_SKIING to "EXERCISE_TYPE_SKIING",
        ExerciseSessionRecord.EXERCISE_TYPE_SNOWBOARDING to "EXERCISE_TYPE_SNOWBOARDING",
        ExerciseSessionRecord.EXERCISE_TYPE_SNOWSHOEING to "EXERCISE_TYPE_SNOWSHOEING",
        ExerciseSessionRecord.EXERCISE_TYPE_SOCCER to "EXERCISE_TYPE_SOCCER",
        ExerciseSessionRecord.EXERCISE_TYPE_SOFTBALL to "EXERCISE_TYPE_SOFTBALL",
        ExerciseSessionRecord.EXERCISE_TYPE_SQUASH to "EXERCISE_TYPE_SQUASH",
        ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING to "EXERCISE_TYPE_STAIR_CLIMBING",
        ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING_MACHINE to "EXERCISE_TYPE_STAIR_CLIMBING_MACHINE",
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING to "EXERCISE_TYPE_STRENGTH_TRAINING",
        ExerciseSessionRecord.EXERCISE_TYPE_STRETCHING to "EXERCISE_TYPE_STRETCHING",
        ExerciseSessionRecord.EXERCISE_TYPE_SURFING to "EXERCISE_TYPE_SURFING",
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER to "EXERCISE_TYPE_SWIMMING_OPEN_WATER",
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL to "EXERCISE_TYPE_SWIMMING_POOL",
        ExerciseSessionRecord.EXERCISE_TYPE_TABLE_TENNIS to "EXERCISE_TYPE_TABLE_TENNIS",
        ExerciseSessionRecord.EXERCISE_TYPE_TENNIS to "EXERCISE_TYPE_TENNIS",
        ExerciseSessionRecord.EXERCISE_TYPE_VOLLEYBALL to "EXERCISE_TYPE_VOLLEYBALL",
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING to "EXERCISE_TYPE_WALKING",
        ExerciseSessionRecord.EXERCISE_TYPE_WATER_POLO to "EXERCISE_TYPE_WATER_POLO",
        ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING to "EXERCISE_TYPE_WEIGHTLIFTING",
        ExerciseSessionRecord.EXERCISE_TYPE_WHEELCHAIR to "EXERCISE_TYPE_WHEELCHAIR",
        ExerciseSessionRecord.EXERCISE_TYPE_YOGA to "EXERCISE_TYPE_YOGA",
    )
}
