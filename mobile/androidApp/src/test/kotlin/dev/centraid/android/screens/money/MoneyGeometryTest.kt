package dev.centraid.android.screens.money

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * MONEY'S ARITHMETIC, ON THE JVM WITH NO DEVICE (#1152): the bar a basis-point
 * count draws, the month order under the chart, the chart's one spoken label
 * and the three figures of a category line. The composables hold none of it.
 */
class MoneyGeometryTest {
    @Test
    fun aBarIsAShareOfThePlotByTheStatesBasisPoints() {
        val plot = MoneyGeometry.PLOT_HEIGHT
        assertEquals(plot, MoneyGeometry.barHeight(MoneyGeometry.BASIS), 0.0001f)
        assertEquals(plot / 2, MoneyGeometry.barHeight(5_000), 0.0001f)
        assertEquals(plot * 0.1234f, MoneyGeometry.barHeight(1_234), 0.001f)
        // The scale is the state's, so a custom plot scales the same share.
        assertEquals(50f, MoneyGeometry.barHeight(2_500, plot = 200f), 0.0001f)
    }

    @Test
    fun aBarOutsideTheScaleIsClampedAndNeverVanishes() {
        assertEquals(MoneyGeometry.PLOT_HEIGHT, MoneyGeometry.barHeight(25_000), 0.0001f)
        assertEquals(MoneyGeometry.MIN_BAR, MoneyGeometry.barHeight(0), 0.0001f)
        assertEquals(MoneyGeometry.MIN_BAR, MoneyGeometry.barHeight(-40), 0.0001f)
        // One basis point of a 132dp plot is 0.0132dp: the stub holds.
        assertEquals(MoneyGeometry.MIN_BAR, MoneyGeometry.barHeight(1), 0.0001f)
        assertTrue(MoneyGeometry.barHeight(200) > MoneyGeometry.MIN_BAR)
    }

    @Test
    fun theMonthTableRunsNewestFirstAndTheChartIsLeftAlone() {
        val oldestFirst = listOf("2026-08", "2026-09", "2026-10")
        assertEquals(listOf("2026-10", "2026-09", "2026-08"), MoneyGeometry.newestFirst(oldestFirst))
        // A view over the list: the chart's own oldest-to-newest order is not disturbed.
        assertEquals(listOf("2026-08", "2026-09", "2026-10"), oldestFirst)
        assertEquals(emptyList<String>(), MoneyGeometry.newestFirst(emptyList<String>()))
    }

    @Test
    fun theChartHasOneSpokenLabelOfEveryMonth() {
        assertEquals(
            "Aug, +\$40.00. Sep, -\$12.00",
            MoneyGeometry.chartSummary(listOf("Aug, +\$40.00", "Sep, -\$12.00")),
        )
        assertEquals("", MoneyGeometry.chartSummary(emptyList()))
    }

    @Test
    fun aLineWithAPlanDrawsAllThreeAndOneWithoutDrawsDashes() {
        assertEquals(
            MoneyGeometry.CategoryFigures(planned = "\$300.00", spent = "\$120.00", left = "\$180.00"),
            MoneyGeometry.categoryFigures(true, "\$300.00", "\$120.00", "\$180.00"),
        )
        assertEquals(
            MoneyGeometry.CategoryFigures(planned = "—", spent = "\$75.00", left = "—"),
            MoneyGeometry.categoryFigures(false, "\$0.00", "\$75.00", "\$0.00"),
        )
    }

    @Test
    fun theNeedsRowJoinsEachCurrencyInTheStatesOrder() {
        assertEquals("\$12.00", MoneyGeometry.needsAmounts(listOf("\$12.00")))
        assertEquals("\$12.00 · €5.00", MoneyGeometry.needsAmounts(listOf("\$12.00", "€5.00")))
        assertEquals("", MoneyGeometry.needsAmounts(emptyList()))
    }
}
