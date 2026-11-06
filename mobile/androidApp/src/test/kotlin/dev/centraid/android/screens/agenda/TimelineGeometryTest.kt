package dev.centraid.android.screens.agenda

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue

class TimelineGeometryTest {
    private val hour = 3_600_000L
    private val hours = (0..23).map { it * hour }

    @Test fun expandedHourMovesOneHourAndResizeUsesTheEndAnchor() {
        val grid = TimelineGeometry(24 * hour, hours, listOf(TimelineSpan(9 * hour, 10 * hour, 192.0)), 64.0)
        assertEquals(192.0, grid.y(10 * hour) - grid.y(9 * hour), 0.001)
        assertEquals(60, grid.delta(9 * hour, grid.y(10 * hour) - grid.y(9 * hour), 15))
        assertEquals(60, grid.delta(10 * hour, grid.y(11 * hour) - grid.y(10 * hour), 15))
        assertEquals(-15, grid.delta(9 * hour, grid.y(9 * hour - 900_000) - grid.y(9 * hour), 15))
        assertEquals(-15, grid.delta(12 * hour, grid.y(12 * hour - 450_000) - grid.y(12 * hour), 15))
        assertEquals(15, grid.delta(12 * hour, grid.y(12 * hour + 450_000) - grid.y(12 * hour), 15))
    }

    @Test fun overlappingBlocksKeepTheirBoundariesAndFitAllText() {
        val first = TimelineSpan(9 * hour + 900_000, 10 * hour + 2_700_000, 240.0)
        val second = TimelineSpan(9 * hour + 2_700_000, 11 * hour + 900_000, 300.0)
        val grid = TimelineGeometry(24 * hour, hours, listOf(first, second), 64.0)
        assertTrue(grid.y(first.end) - grid.y(first.start) >= first.minimumHeight - 0.001)
        assertTrue(grid.y(second.end) - grid.y(second.start) >= second.minimumHeight - 0.001)
        assertTrue(grid.y(first.start) < grid.y(second.start))
        assertEquals(30, grid.delta(first.start, grid.y(first.start + 1_800_000) - grid.y(first.start), 15))
    }
}
