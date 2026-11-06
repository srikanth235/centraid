package dev.centraid.android.screens.agenda

import kotlin.math.abs
import kotlin.math.floor

/** Measured layout only: Rust supplies civil offsets and the adjustment step. */
internal data class TimelineSpan(val start: Long, val end: Long, val minimumHeight: Double)

internal class TimelineGeometry(
    duration: Long,
    hourOffsets: List<Long>,
    spans: List<TimelineSpan>,
    hourHeight: Double,
) {
    private val times = (listOf(0L, duration) + hourOffsets + spans.flatMap { listOf(it.start, it.end) })
        .distinct().sorted().map(Long::toDouble)
    private val positions: List<Double>
    val height: Double get() = positions.lastOrNull() ?: 0.0

    init {
        val heights = times.zipWithNext { a, b -> (b - a) / 3_600_000.0 * hourHeight }.toMutableList()
        spans.forEach { span ->
            val first = times.indexOf(span.start.toDouble())
            val last = if (span.end > span.start) times.indexOf(span.end.toDouble()) else (first + 1).coerceAtMost(times.lastIndex)
            if (first >= 0 && last > first) {
                val current = (first until last).sumOf { heights[it] }
                val extra = (span.minimumHeight - current).coerceAtLeast(0.0)
                val elapsed = times[last] - times[first]
                for (index in first until last) heights[index] += extra * (times[index + 1] - times[index]) / elapsed
            }
        }
        positions = listOf(0.0) + heights.runningFold(0.0, Double::plus).drop(1)
    }

    fun y(time: Long): Double = interpolate(time.toDouble(), times, positions)

    fun delta(anchor: Long, translation: Double, stepMinutes: Int): Int {
        if (stepMinutes <= 0) return 0
        val moved = interpolate(y(anchor) + translation, positions, times)
        val steps = (moved - anchor) / 60_000.0 / stepMinutes
        val rounded = floor(abs(steps) + 0.5).toInt()
        return (if (steps < 0) -rounded else rounded) * stepMinutes
    }

    private fun interpolate(value: Double, from: List<Double>, to: List<Double>): Double {
        if (from.size < 2) return 0.0
        val index = (from.indexOfFirst { it > value }.let { if (it < 0) from.lastIndex else it } - 1)
            .coerceIn(0, from.lastIndex - 1)
        val fraction = (value - from[index]) / (from[index + 1] - from[index])
        return to[index] + fraction * (to[index + 1] - to[index])
    }
}
