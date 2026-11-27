package dev.centraid.android.session

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.aggregate.AggregationResultGroupedByPeriod
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import centraid.core.v1.FollowGrant
import centraid.core.v1.ShellStoreRead
import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime
import java.time.Period
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import org.json.JSONArray
import org.json.JSONObject

/** Read-only Health Connect adapter. Every snapshot is incomplete because the phone cannot prove
 * that every selected record type is readable; denied types are carried to core explicitly. */
internal object HealthFollowReader {
    private const val HEALTH_CONNECT_PROVIDER = "com.google.android.apps.healthdata"
    private val allMetrics = setOf(
        "steps", "active_energy_kcal", "exercise_min", "sleep_min", "resting_hr_bpm", "weight_kg",
    )

    data class Result(val grant: FollowGrant, val inputJson: String)

    fun available(context: Context): Boolean =
        HealthConnectClient.getSdkStatus(context, HEALTH_CONNECT_PROVIDER) == HealthConnectClient.SDK_AVAILABLE

    suspend fun granted(context: Context): Set<String>? {
        if (!available(context)) return null
        return runCatching { HealthConnectClient.getOrCreate(context, HEALTH_CONNECT_PROVIDER).permissionController.getGrantedPermissions() }
            .getOrNull()
    }

    fun permissions(read: ShellStoreRead): Set<String> {
        val chosen = read.chosen.toSet().ifEmpty { allMetrics }
        val types = linkedSetOf<String>()
        types += HealthPermission.getReadPermission(ExerciseSessionRecord::class)
        if ("steps" in chosen) types += HealthPermission.getReadPermission(StepsRecord::class)
        if ("active_energy_kcal" in chosen) types += HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class)
        if ("exercise_min" in chosen) types += HealthPermission.getReadPermission(ExerciseSessionRecord::class)
        if ("sleep_min" in chosen) types += HealthPermission.getReadPermission(SleepSessionRecord::class)
        if ("resting_hr_bpm" in chosen) types += HealthPermission.getReadPermission(RestingHeartRateRecord::class)
        if ("weight_kg" in chosen) types += HealthPermission.getReadPermission(WeightRecord::class)
        if (read.ask_background) types += HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND
        return types
    }

    fun refusedTypes(read: ShellStoreRead, granted: Set<String>): List<String> {
        val chosen = read.chosen.toSet().ifEmpty { allMetrics }
        val names = linkedMapOf(
            "workouts" to HealthPermission.getReadPermission(ExerciseSessionRecord::class),
            "steps" to HealthPermission.getReadPermission(StepsRecord::class),
            "active_energy_kcal" to HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
            "exercise_min" to HealthPermission.getReadPermission(ExerciseSessionRecord::class),
            "sleep_min" to HealthPermission.getReadPermission(SleepSessionRecord::class),
            "resting_hr_bpm" to HealthPermission.getReadPermission(RestingHeartRateRecord::class),
            "weight_kg" to HealthPermission.getReadPermission(WeightRecord::class),
        )
        return names.filter { (name, permission) ->
            (name == "workouts" || name in chosen) && permission !in granted
        }.keys.toList()
    }

    fun backgroundRefused(read: ShellStoreRead, granted: Set<String>): Boolean =
        read.ask_background && HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND !in granted

    suspend fun read(context: Context, read: ShellStoreRead, granted: Set<String>): Result {
        if (!available(context)) {
            return Result(FollowGrant.FOLLOW_GRANT_UNAVAILABLE, "")
        }
        val requested = permissions(read)
        val refused = requested - granted
        val contentPermissions = requested - HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND
        if (granted.intersect(contentPermissions).isEmpty()) {
            return Result(FollowGrant.FOLLOW_GRANT_REFUSED, "")
        }
        val client = HealthConnectClient.getOrCreate(context, HEALTH_CONNECT_PROVIDER)
        val now = Instant.now()
        val from = now.minus(Duration.ofDays(read.days_back.toLong().coerceAtLeast(1)))
        val workoutFrom = if (read.workouts_since_ms > 0) Instant.ofEpochMilli(read.workouts_since_ms) else now.minus(Duration.ofDays(90))
        val zone = ZoneId.systemDefault()
        val chosen = read.chosen.toSet().ifEmpty { allMetrics }
        val workouts = JSONArray()
        val gone = JSONArray()
        val readings = JSONArray()
        val recordTypes = recordTypes(chosen, granted)
        val nextCursor: String
        val deltaRecords: List<Record>
        if (read.cursor.isNotEmpty()) {
            val delta = changes(client, read.cursor)
            if (delta.expired) {
                nextCursor = client.getChangesToken(ChangesTokenRequest(recordTypes = recordTypes))
                deltaRecords = readAll<ExerciseSessionRecord>(client, workoutFrom, now)
                // Expired cursors require a complete replacement; preserve rows through complete=false.
            } else {
                nextCursor = delta.token
                deltaRecords = delta.upserts
                delta.deleted.forEach(gone::put)
            }
        } else {
            nextCursor = client.getChangesToken(ChangesTokenRequest(recordTypes = recordTypes))
            deltaRecords = if (HealthPermission.getReadPermission(ExerciseSessionRecord::class) in granted) {
                readAll<ExerciseSessionRecord>(client, workoutFrom, now)
            } else emptyList()
        }
        if (HealthPermission.getReadPermission(ExerciseSessionRecord::class) in granted) {
            deltaRecords.filterIsInstance<ExerciseSessionRecord>()
                .filter { !it.startTime.isBefore(workoutFrom) && !it.startTime.isAfter(now) }
                .forEach { record ->
                val type = ExerciseSessionRecord.EXERCISE_TYPE_INT_TO_STRING_MAP[record.exerciseType]
                    ?: "workout-${record.exerciseType}"
                val fields = JSONObject()
                    .put("kind", type)
                    .put("starts", record.startTime.toString())
                    .put("ends", record.endTime.toString())
                    .put("recorded_by", record.metadata.dataOrigin.packageName)
                    .put("moving_s", Duration.between(record.startTime, record.endTime).toMillis() / 1000.0)
                workouts.put(JSONObject().put("external_id", record.metadata.id).put("fields", fields))
            }
        }

        val daily = dailyTotals(client, chosen, granted, from, now, zone)
        if ("weight_kg" in chosen && HealthPermission.getReadPermission(WeightRecord::class) in granted) {
            readAll<WeightRecord>(client, from, now).forEach { record ->
                readings.put(JSONObject()
                    .put("external_id", record.metadata.id)
                    .put("fields", JSONObject()
                        .put("metric", "weight_kg")
                        .put("at", record.time.toString())
                        .put("value", record.weight.inKilograms)))
            }
        }
        val days = JSONArray()
        daily.forEach { (key, value) ->
            days.put(JSONObject().put("day", key.second).put("metric", key.first).put("value", value))
        }

        val originWorkouts = JSONObject().put("ref", "health-connect:workouts").put("label", "Health Connect")
        if (read.cursor.isNotEmpty()) originWorkouts.put("cursor", read.cursor)
        val input = JSONObject()
            .put("workouts", JSONObject()
                .put("origin", originWorkouts.put("cursor", nextCursor))
                .put("records", workouts)
                .put("complete", false)
                .put("gone", gone))
            .put("readings", JSONObject()
                .put("origin", JSONObject().put("ref", "health-connect:readings").put("label", "Health Connect"))
                .put("records", readings)
                .put("complete", false))
            .put("totals", JSONObject()
                .put("origin", JSONObject().put("system", "health").put("ref", "health-connect:totals"))
                .put("days", days))
        val grant = if (refused.isEmpty()) FollowGrant.FOLLOW_GRANT_GRANTED else FollowGrant.FOLLOW_GRANT_LIMITED
        return Result(grant, input.toString())
    }

    private suspend inline fun <reified T : Record> readAll(
        client: HealthConnectClient,
        start: Instant,
        end: Instant,
    ): List<T> {
        val records = mutableListOf<T>()
        var token: String? = null
        do {
            val page = client.readRecords(
                ReadRecordsRequest(
                    recordType = T::class,
                    timeRangeFilter = TimeRangeFilter.between(start, end),
                    pageSize = 1_000,
                    pageToken = token,
                ),
            )
            records += page.records
            token = page.pageToken
        } while (token != null)
        return records
    }

    private suspend fun dailyTotals(
        client: HealthConnectClient,
        chosen: Set<String>,
        granted: Set<String>,
        start: Instant,
        end: Instant,
        zone: ZoneId,
    ): Map<Pair<String, String>, Double> {
        val metrics = linkedSetOf<androidx.health.connect.client.aggregate.AggregateMetric<*>>()
        if ("steps" in chosen && HealthPermission.getReadPermission(StepsRecord::class) in granted) {
            metrics += StepsRecord.COUNT_TOTAL
        }
        if ("active_energy_kcal" in chosen && HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class) in granted) {
            metrics += ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL
        }
        if ("exercise_min" in chosen && HealthPermission.getReadPermission(ExerciseSessionRecord::class) in granted) {
            metrics += ExerciseSessionRecord.EXERCISE_DURATION_TOTAL
        }
        if ("sleep_min" in chosen && HealthPermission.getReadPermission(SleepSessionRecord::class) in granted) {
            metrics += SleepSessionRecord.SLEEP_DURATION_TOTAL
        }
        if ("resting_hr_bpm" in chosen && HealthPermission.getReadPermission(RestingHeartRateRecord::class) in granted) {
            metrics += RestingHeartRateRecord.BPM_AVG
        }
        if (metrics.isEmpty()) return emptyMap()
        val localStart = start.atZone(zone).toLocalDate().atStartOfDay()
        val localEnd = end.atZone(zone).toLocalDateTime()
        val groups = client.aggregateGroupByPeriod(
            AggregateGroupByPeriodRequest(
                metrics = metrics,
                timeRangeFilter = TimeRangeFilter.between(localStart, localEnd),
                timeRangeSlicer = Period.ofDays(1),
            ),
        )
        return dailyValues(groups)
    }

    private data class Delta(val token: String, val upserts: List<Record>, val deleted: List<String>, val expired: Boolean)

    private suspend fun changes(client: HealthConnectClient, cursor: String): Delta {
        var token = cursor
        val upserts = mutableListOf<Record>()
        val deleted = mutableListOf<String>()
        while (true) {
            val response = client.getChanges(token)
            if (response.changesTokenExpired) return Delta("", emptyList(), emptyList(), expired = true)
            response.changes.forEach { change ->
                when (change) {
                    is UpsertionChange -> upserts += change.record
                    is DeletionChange -> deleted += change.recordId
                }
            }
            token = response.nextChangesToken
            if (!response.hasMore) break
        }
        return Delta(token, upserts, deleted, expired = false)
    }

    private fun recordTypes(chosen: Set<String>, granted: Set<String>): Set<kotlin.reflect.KClass<out Record>> = buildSet {
        if (HealthPermission.getReadPermission(ExerciseSessionRecord::class) in granted) add(ExerciseSessionRecord::class)
        if ("steps" in chosen && HealthPermission.getReadPermission(StepsRecord::class) in granted) add(StepsRecord::class)
        if ("active_energy_kcal" in chosen && HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class) in granted) add(ActiveCaloriesBurnedRecord::class)
        if ("sleep_min" in chosen && HealthPermission.getReadPermission(SleepSessionRecord::class) in granted) add(SleepSessionRecord::class)
        if ("resting_hr_bpm" in chosen && HealthPermission.getReadPermission(RestingHeartRateRecord::class) in granted) add(RestingHeartRateRecord::class)
        if ("weight_kg" in chosen && HealthPermission.getReadPermission(WeightRecord::class) in granted) add(WeightRecord::class)
    }

    internal fun dailyValues(groups: List<AggregationResultGroupedByPeriod>): Map<Pair<String, String>, Double> {
        val totals = linkedMapOf<Pair<String, String>, Double>()
        for (group in groups) {
            val day = group.startTime.toLocalDate().format(DateTimeFormatter.ISO_LOCAL_DATE)
            group.result.get(StepsRecord.COUNT_TOTAL)?.let { totals["steps" to day] = it.toDouble() }
            group.result.get(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL)?.let {
                totals["active_energy_kcal" to day] = it.inKilocalories
            }
            group.result.get(ExerciseSessionRecord.EXERCISE_DURATION_TOTAL)?.let {
                totals["exercise_min" to day] = it.toMillis() / 60_000.0
            }
            group.result.get(SleepSessionRecord.SLEEP_DURATION_TOTAL)?.let {
                totals["sleep_min" to day] = it.toMillis() / 60_000.0
            }
            group.result.get(RestingHeartRateRecord.BPM_AVG)?.let {
                totals["resting_hr_bpm" to day] = it.toDouble()
            }
        }
        return totals
    }

    private fun dayKey(at: Instant, zone: ZoneId): String = at.atZone(zone).toLocalDate()
        .format(DateTimeFormatter.ISO_LOCAL_DATE)
}
