package dev.centraid.android.session

import androidx.health.connect.client.aggregate.AggregationResult
import androidx.health.connect.client.aggregate.AggregationResultGroupedByPeriod
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.metadata.DataOrigin
import centraid.core.v1.ShellStoreRead
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime

class HealthFollowReaderTest {
    @Test
    fun selectedTypesAndBackgroundPermissionAreRequestedPrecisely() {
        val permissions = HealthFollowReader.permissions(
            ShellStoreRead(system = "health", chosen = listOf("steps"), ask_background = true),
        )
        assertEquals(
            setOf(
                HealthPermission.getReadPermission(StepsRecord::class),
                HealthPermission.getReadPermission(androidx.health.connect.client.records.ExerciseSessionRecord::class),
                HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND,
            ),
            permissions,
        )
        assertTrue(HealthPermission.getReadPermission(androidx.health.connect.client.records.WeightRecord::class) !in permissions)
    }

    @Test
    fun groupedDailyTotalsUseLocalCalendarDaysAcrossDstAndMultipleSources() {
        val first = period("2026-03-08T00:00:00", 1200)
        val second = period("2026-03-09T00:00:00", 800)
        val totals = HealthFollowReader.dailyValues(listOf(first, second))
        assertEquals(mapOf("steps" to "2026-03-08" to 1200.0, "steps" to "2026-03-09" to 800.0), totals)
    }

    private fun period(start: String, steps: Long) = AggregationResultGroupedByPeriod(
        AggregationResult(
            longValues = mapOf(StepsRecord.COUNT_TOTAL.metricKey to steps),
            doubleValues = emptyMap(),
            dataOrigins = setOf(DataOrigin("wearable-a"), DataOrigin("wearable-b")),
        ),
        LocalDateTime.parse(start),
        LocalDateTime.parse(start).plusDays(1),
        false,
    )
}
