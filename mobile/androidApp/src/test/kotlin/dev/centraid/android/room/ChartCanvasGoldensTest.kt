package dev.centraid.android.room

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.unit.dp
import centraid.core.v1.RoomBlock
import centraid.core.v1.RoomCanvasEvent
import centraid.core.v1.RoomChart
import centraid.core.v1.RoomChartMark
import centraid.core.v1.RoomChartPoint
import centraid.core.v1.RoomChartRule
import centraid.core.v1.RoomChartSeries
import centraid.core.v1.RoomChartTick
import centraid.core.v1.RoomTone
import com.github.takahirom.roborazzi.captureRoboImage
import dev.centraid.android.kit.LocalAppAccentId
import dev.centraid.android.kit.Surface
import dev.centraid.android.theme.CentraidTheme
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w390dp-h844dp-xxhdpi")
class ChartCanvasGoldensTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private var dark by mutableStateOf(false)
    private var appAccentId by mutableStateOf("")
    private var generation by mutableIntStateOf(0)
    private var body by mutableStateOf<@Composable () -> Unit>({})

    private fun mountHost() {
        rule.setContent {
            CentraidTheme(dark = dark) {
                CompositionLocalProvider(LocalAppAccentId provides appAccentId) {
                    androidx.compose.runtime.key(generation) { body() }
                }
            }
        }
    }

    private fun captureChart(
        name: String,
        accentId: String,
        isDark: Boolean,
        chart: RoomChart,
    ) {
        rule.runOnIdle {
            dark = isDark
            appAccentId = accentId
            generation += 1
            body = {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .background(Surface.page)
                        .padding(vertical = 8.dp)
                        .testTag("golden-root"),
                ) {
                    RoomBlockView(
                        block = RoomBlock(chart = chart),
                        onTap = {},
                        onChange = {},
                        onCanvas = {},
                    )
                }
            }
        }
        rule.waitForIdle()
        val path = "$BLOCK_GOLDENS_DIR/$name.png"
        File(path).parentFile?.mkdirs()
        rule.onNodeWithTag("golden-root").captureRoboImage(filePath = path)
    }

    @Test
    fun chartGoldensLightAndDark() {
        mountHost()

        val spending = moneySpendingChart()
        captureChart("chart_money_spending_bar_light", "money", isDark = false, chart = spending)
        captureChart("chart_money_spending_bar_dark", "money", isDark = true, chart = spending)

        val cashFlow = moneyCashFlowChart()
        captureChart("chart_money_cashflow_area_light", "money", isDark = false, chart = cashFlow)
        captureChart("chart_money_cashflow_area_dark", "money", isDark = true, chart = cashFlow)

        val healthTrend = healthTrendBandChart()
        captureChart("chart_health_trend_band_light", "health", isDark = false, chart = healthTrend)
        captureChart("chart_health_trend_band_dark", "health", isDark = true, chart = healthTrend)

        val scrubReadout = healthScrubReadoutChart()
        captureChart("chart_scrub_readout_light", "health", isDark = false, chart = scrubReadout)
        captureChart("chart_scrub_readout_dark", "health", isDark = true, chart = scrubReadout)
    }

    @Test
    fun scrubEmitsCanvasEventAndExposesSummaryAccessibility() {
        val events = mutableListOf<RoomCanvasEvent>()
        val chart = healthScrubReadoutChart(readoutPointId = "")

        rule.setContent {
            CentraidTheme(dark = false) {
                CompositionLocalProvider(LocalAppAccentId provides "health") {
                    RoomBlockView(
                        block = RoomBlock(chart = chart),
                        onTap = {},
                        onChange = {},
                        onCanvas = { events.add(it) },
                    )
                }
            }
        }
        rule.waitForIdle()

        val node = rule.onNodeWithTag(chart.selector_id)
        val semantics = node.fetchSemanticsNode()
        val descriptions = semantics.config[SemanticsProperties.ContentDescription]
        assertTrue(
            "Expected chart summary in contentDescription, got $descriptions",
            descriptions.any { it.contains(chart.summary) },
        )

        node.performTouchInput {
            click(Offset(width * 0.5f, height * 0.5f))
        }
        rule.waitForIdle()
        assertTrue("Expected tap scrub event", events.isNotEmpty())
        assertEquals(chart.selector_id, events.last().selector_id)
        assertTrue(
            "Expected non-empty scrubbed point id",
            events.last().chart_scrub?.point_id.orEmpty().isNotEmpty(),
        )
        rule.onNodeWithTag("chart-readout", useUnmergedTree = true).assertIsDisplayed()

        val countAfterTap = events.size
        node.performTouchInput {
            swipeRight(startX = width * 0.12f, endX = width * 0.92f)
        }
        rule.waitForIdle()
        assertTrue(
            "Expected drag scrub to emit point updates",
            events.size > countAfterTap,
        )
        assertEquals("day-sun", events.last().chart_scrub?.point_id)
    }

    @Test
    fun emptyChartDisplaysEmptySentence() {
        val emptyChart = RoomChart(
            selector_id = "chart/empty",
            summary = "No spending recorded in October",
            empty_sentence = "No spending recorded yet.",
        )
        rule.setContent {
            CentraidTheme(dark = false) {
                RoomBlockView(
                    block = RoomBlock(chart = emptyChart),
                    onTap = {},
                    onChange = {},
                    onCanvas = {},
                )
            }
        }
        rule.waitForIdle()
        rule.onNodeWithText("No spending recorded yet.").assertIsDisplayed()
    }

    private fun moneySpendingChart(): RoomChart = RoomChart(
        selector_id = "chart/money/spending",
        summary = "October spending by week: ₹68,420 across four weeks, peaking in week 3.",
        series = listOf(
            RoomChartSeries(
                id = "groceries",
                label = "Groceries",
                hue_key = "petrol",
                mark = RoomChartMark.ROOM_CHART_MARK_BAR,
                stack = "spend",
                points = listOf(
                    RoomChartPoint(id = "w1-g", x = 1.0, y = 4800.0, x_label = "1–7 Oct", y_label = "₹4,800"),
                    RoomChartPoint(id = "w2-g", x = 2.0, y = 5600.0, x_label = "8–14 Oct", y_label = "₹5,600"),
                    RoomChartPoint(id = "w3-g", x = 3.0, y = 4400.0, x_label = "15–21 Oct", y_label = "₹4,400"),
                    RoomChartPoint(id = "w4-g", x = 4.0, y = 3400.0, x_label = "22–28 Oct", y_label = "₹3,400"),
                ),
            ),
            RoomChartSeries(
                id = "eating-out",
                label = "Eating out",
                hue_key = "blue",
                mark = RoomChartMark.ROOM_CHART_MARK_BAR,
                stack = "spend",
                points = listOf(
                    RoomChartPoint(id = "w1-e", x = 1.0, y = 4100.0, x_label = "1–7 Oct", y_label = "₹4,100"),
                    RoomChartPoint(id = "w2-e", x = 2.0, y = 1600.0, x_label = "8–14 Oct", y_label = "₹1,600"),
                    RoomChartPoint(id = "w3-e", x = 3.0, y = 7350.0, x_label = "15–21 Oct", y_label = "₹7,350"),
                    RoomChartPoint(id = "w4-e", x = 4.0, y = 1800.0, x_label = "22–28 Oct", y_label = "₹1,800"),
                ),
            ),
            RoomChartSeries(
                id = "bills",
                label = "Bills",
                hue_key = "mustard",
                mark = RoomChartMark.ROOM_CHART_MARK_BAR,
                stack = "spend",
                points = listOf(
                    RoomChartPoint(id = "w1-b", x = 1.0, y = 3200.0, x_label = "1–7 Oct", y_label = "₹3,200"),
                    RoomChartPoint(id = "w2-b", x = 2.0, y = 4600.0, x_label = "8–14 Oct", y_label = "₹4,600"),
                    RoomChartPoint(id = "w3-b", x = 3.0, y = 6200.0, x_label = "15–21 Oct", y_label = "₹6,200"),
                    RoomChartPoint(id = "w4-b", x = 4.0, y = 2600.0, x_label = "22–28 Oct", y_label = "₹2,600"),
                ),
            ),
            RoomChartSeries(
                id = "other",
                label = "Other",
                hue_key = "graphite",
                mark = RoomChartMark.ROOM_CHART_MARK_BAR,
                stack = "spend",
                points = listOf(
                    RoomChartPoint(id = "w1-o", x = 1.0, y = 2900.0, x_label = "1–7 Oct", y_label = "₹2,900"),
                    RoomChartPoint(id = "w2-o", x = 2.0, y = 1800.0, x_label = "8–14 Oct", y_label = "₹1,800"),
                    RoomChartPoint(id = "w3-o", x = 3.0, y = 3090.0, x_label = "15–21 Oct", y_label = "₹3,090"),
                    RoomChartPoint(id = "w4-o", x = 4.0, y = 2100.0, x_label = "22–28 Oct", y_label = "₹2,100"),
                ),
            ),
        ),
        x_ticks = listOf(
            RoomChartTick(at = 1.0, label = "1–7"),
            RoomChartTick(at = 2.0, label = "8–14"),
            RoomChartTick(at = 3.0, label = "15–21"),
            RoomChartTick(at = 4.0, label = "22–28"),
        ),
        y_ticks = listOf(
            RoomChartTick(at = 0.0, label = "₹0"),
            RoomChartTick(at = 10000.0, label = "₹10k"),
            RoomChartTick(at = 20000.0, label = "₹20k"),
        ),
        rules = listOf(
            RoomChartRule(at = 15000.0, label = "planned pace", tone = RoomTone.ROOM_TONE_NEUTRAL),
        ),
    )

    private fun moneyCashFlowChart(): RoomChart = RoomChart(
        selector_id = "chart/money/cashflow",
        summary = "Cash flow from July to October: net positive every month.",
        series = listOf(
            RoomChartSeries(
                id = "inflow",
                label = "In",
                hue_key = "income",
                mark = RoomChartMark.ROOM_CHART_MARK_AREA,
                points = listOf(
                    RoomChartPoint(id = "in-jul", x = 1.0, y = 2400.0, x_label = "Jul", y_label = "$2,400"),
                    RoomChartPoint(id = "in-aug", x = 2.0, y = 2550.0, x_label = "Aug", y_label = "$2,550"),
                    RoomChartPoint(id = "in-sep", x = 3.0, y = 2400.0, x_label = "Sep", y_label = "$2,400"),
                    RoomChartPoint(id = "in-oct", x = 4.0, y = 2800.0, x_label = "Oct", y_label = "$2,800"),
                ),
            ),
            RoomChartSeries(
                id = "outflow",
                label = "Out",
                hue_key = "expense",
                mark = RoomChartMark.ROOM_CHART_MARK_LINE,
                points = listOf(
                    RoomChartPoint(id = "out-jul", x = 1.0, y = 1720.0, x_label = "Jul", y_label = "$1,720"),
                    RoomChartPoint(id = "out-aug", x = 2.0, y = 1980.0, x_label = "Aug", y_label = "$1,980"),
                    RoomChartPoint(id = "out-sep", x = 3.0, y = 1640.0, x_label = "Sep", y_label = "$1,640"),
                    RoomChartPoint(id = "out-oct", x = 4.0, y = 1510.0, x_label = "Oct", y_label = "$1,510"),
                ),
            ),
        ),
        x_ticks = listOf(
            RoomChartTick(at = 1.0, label = "Jul"),
            RoomChartTick(at = 2.0, label = "Aug"),
            RoomChartTick(at = 3.0, label = "Sep"),
            RoomChartTick(at = 4.0, label = "Oct"),
        ),
        y_ticks = listOf(
            RoomChartTick(at = 0.0, label = "$0"),
            RoomChartTick(at = 1500.0, label = "$1.5k"),
            RoomChartTick(at = 3000.0, label = "$3k"),
        ),
        rules = listOf(
            RoomChartRule(at = 2000.0, label = "target", tone = RoomTone.ROOM_TONE_WARNING),
        ),
    )

    private fun healthTrendBandChart(): RoomChart = RoomChart(
        selector_id = "chart/health/rhr",
        summary = "Resting heart rate over 7 days averaged 58 bpm within typical range.",
        series = listOf(
            RoomChartSeries(
                id = "rhr-trend",
                label = "Resting HR",
                hue_key = "health",
                mark = RoomChartMark.ROOM_CHART_MARK_LINE,
                points = listOf(
                    RoomChartPoint(id = "rhr-1", x = 1.0, y = 59.0, y_low = 54.0, y_high = 63.0, x_label = "Mon", y_label = "59 bpm"),
                    RoomChartPoint(id = "rhr-2", x = 2.0, y = 57.0, y_low = 53.0, y_high = 62.0, x_label = "Tue", y_label = "57 bpm"),
                    RoomChartPoint(id = "rhr-3", x = 3.0, y = 60.0, y_low = 54.0, y_high = 64.0, x_label = "Wed", y_label = "60 bpm"),
                    RoomChartPoint(id = "rhr-4", x = 4.0, y = 56.0, y_low = 52.0, y_high = 61.0, x_label = "Thu", y_label = "56 bpm"),
                    RoomChartPoint(id = "rhr-5", x = 5.0, y = 58.0, y_low = 53.0, y_high = 62.0, x_label = "Fri", y_label = "58 bpm"),
                    RoomChartPoint(id = "rhr-6", x = 6.0, y = 55.0, y_low = 52.0, y_high = 60.0, x_label = "Sat", y_label = "55 bpm"),
                    RoomChartPoint(id = "rhr-7", x = 7.0, y = 57.0, y_low = 53.0, y_high = 62.0, x_label = "Sun", y_label = "57 bpm"),
                ),
            ),
            RoomChartSeries(
                id = "rhr-dots",
                label = "",
                hue_key = "health",
                mark = RoomChartMark.ROOM_CHART_MARK_POINT,
                points = listOf(
                    RoomChartPoint(id = "rhr-1", x = 1.0, y = 59.0, x_label = "Mon", y_label = "59 bpm"),
                    RoomChartPoint(id = "rhr-2", x = 2.0, y = 57.0, x_label = "Tue", y_label = "57 bpm"),
                    RoomChartPoint(id = "rhr-3", x = 3.0, y = 60.0, x_label = "Wed", y_label = "60 bpm"),
                    RoomChartPoint(id = "rhr-4", x = 4.0, y = 56.0, x_label = "Thu", y_label = "56 bpm"),
                    RoomChartPoint(id = "rhr-5", x = 5.0, y = 58.0, x_label = "Fri", y_label = "58 bpm"),
                    RoomChartPoint(id = "rhr-6", x = 6.0, y = 55.0, x_label = "Sat", y_label = "55 bpm"),
                    RoomChartPoint(id = "rhr-7", x = 7.0, y = 57.0, x_label = "Sun", y_label = "57 bpm"),
                ),
            ),
        ),
        x_ticks = listOf(
            RoomChartTick(at = 1.0, label = "M"),
            RoomChartTick(at = 2.0, label = "T"),
            RoomChartTick(at = 3.0, label = "W"),
            RoomChartTick(at = 4.0, label = "T"),
            RoomChartTick(at = 5.0, label = "F"),
            RoomChartTick(at = 6.0, label = "S"),
            RoomChartTick(at = 7.0, label = "S"),
        ),
        y_ticks = listOf(
            RoomChartTick(at = 50.0, label = "50"),
            RoomChartTick(at = 58.0, label = "58"),
            RoomChartTick(at = 66.0, label = "66"),
        ),
        rules = listOf(
            RoomChartRule(at = 58.0, label = "typical", tone = RoomTone.ROOM_TONE_ACCENT),
        ),
    )

    private fun healthScrubReadoutChart(readoutPointId: String = "day-thu"): RoomChart = RoomChart(
        selector_id = "chart/health/steps",
        summary = "Steps this week: daily average 8,432, best day Thu 30 Oct with 11,204 steps.",
        series = listOf(
            RoomChartSeries(
                id = "steps",
                label = "Steps",
                hue_key = "health",
                mark = RoomChartMark.ROOM_CHART_MARK_BAR,
                points = listOf(
                    RoomChartPoint(id = "day-mon", x = 1.0, y = 7400.0, y_low = 6400.0, y_high = 8800.0, x_label = "Mon 27 Oct", y_label = "7,400"),
                    RoomChartPoint(id = "day-tue", x = 2.0, y = 9300.0, y_low = 6400.0, y_high = 8800.0, x_label = "Tue 28 Oct", y_label = "9,300"),
                    RoomChartPoint(id = "day-wed", x = 3.0, y = 6100.0, y_low = 6400.0, y_high = 8800.0, x_label = "Wed 29 Oct", y_label = "6,100"),
                    RoomChartPoint(id = "day-thu", x = 4.0, y = 11204.0, y_low = 6400.0, y_high = 8800.0, x_label = "Thu 30 Oct", y_label = "11,204", a11y_label = "Thursday 30 October, 11,204 steps"),
                    RoomChartPoint(id = "day-fri", x = 5.0, y = 8200.0, y_low = 6400.0, y_high = 8800.0, x_label = "Fri 31 Oct", y_label = "8,200"),
                    RoomChartPoint(id = "day-sat", x = 6.0, y = 6600.0, y_low = 6400.0, y_high = 8800.0, x_label = "Sat 1 Nov", y_label = "6,600"),
                    RoomChartPoint(id = "day-sun", x = 7.0, y = 8700.0, y_low = 6400.0, y_high = 8800.0, x_label = "Sun 2 Nov", y_label = "8,700"),
                ),
            ),
        ),
        x_ticks = listOf(
            RoomChartTick(at = 1.0, label = "M"),
            RoomChartTick(at = 2.0, label = "T"),
            RoomChartTick(at = 3.0, label = "W"),
            RoomChartTick(at = 4.0, label = "T"),
            RoomChartTick(at = 5.0, label = "F"),
            RoomChartTick(at = 6.0, label = "S"),
            RoomChartTick(at = 7.0, label = "S"),
        ),
        rules = listOf(
            RoomChartRule(at = 7600.0, label = "typical", tone = RoomTone.ROOM_TONE_ACCENT),
        ),
        readout_point_id = readoutPointId,
    )

    private companion object {
        const val BLOCK_GOLDENS_DIR = "src/test/snapshots/blocks"
    }
}
