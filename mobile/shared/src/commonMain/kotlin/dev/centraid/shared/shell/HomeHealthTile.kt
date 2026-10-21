package dev.centraid.shared.shell

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.HealthMetric
import centraid.core.v1.HealthToday
import centraid.core.v1.HealthTodayRequest
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.TileBody
import centraid.screen.v1.TileStatus
import dev.centraid.design.copy.HealthCopy
import dev.centraid.shared.kit.groupedDigits
import dev.centraid.shared.platform.DeviceClock
import kotlin.math.roundToLong

/**
 * HOME'S HEALTH TILE (#1129): today's steps and last night's sleep, from `health.today`. It
 * states the device's zone and the core places today in it, as every Health read does: the
 * store's days are the phone's.
 *
 * No store connected is `EMPTY`, and the tile says what to do. A connected store with nothing
 * today is CONTENT with no figure: a day with no row is not a day of no steps, so the tile never
 * draws a zero it was not told.
 */
public object HomeHealthTile {
    public const val APP_ID: String = "health"

    /** The tables whose changes move this tile: the days, and the store's origin (connected or not). */
    public val TABLES: Set<String> = setOf("health_daily", "phone_origin")

    /** The one request, in the device's zone. */
    public fun request(clock: DeviceClock): AppQueryRequest =
        AppQueryRequest(health_today = HealthTodayRequest(tz = clock.read().zone))

    /** The tile, out of one answer. */
    public fun arrived(answer: HealthToday): HomeEvent {
        if (!answer.connected) {
            return HomeEvent(tile = HomeEvent.TileArrived(app_id = APP_ID, status = TileStatus.TILE_STATUS_EMPTY))
        }
        fun today(metric: HealthMetric) = answer.metrics.firstOrNull { it.metric == metric && it.day == answer.today }?.value_
        val steps = today(HealthMetric.HEALTH_METRIC_STEPS)
        val sleep = today(HealthMetric.HEALTH_METRIC_SLEEP_MIN)
        return HomeEvent(
            tile = HomeEvent.TileArrived(
                app_id = APP_ID,
                status = TileStatus.TILE_STATUS_CONTENT,
                body = TileBody(
                    health = TileBody.HealthTile(
                        figure = steps?.let { groupedDigits(it.roundToLong()) }.orEmpty(),
                        caption = if (steps == null) HealthCopy.WHEN_NOTHING else HealthCopy.TILE_CAPTION,
                        line = sleep?.let { HealthCopy.TILE_SLEPT.replace("{duration}", duration(it)) }.orEmpty(),
                    ),
                ),
            ),
        )
    }

    /** Minutes asleep, as Health says them (`7 h 12 m`). */
    private fun duration(minutes: Double): String {
        val total = minutes.roundToLong().coerceAtLeast(0L)
        val hours = total / MINUTES_PER_HOUR
        val rest = (total % MINUTES_PER_HOUR).toString()
        return if (hours == 0L) {
            HealthCopy.DURATION_MINUTES.replace("{m}", rest)
        } else {
            HealthCopy.DURATION_HOURS.replace("{h}", hours.toString()).replace("{m}", rest)
        }
    }

    private const val MINUTES_PER_HOUR: Long = 60L
}
