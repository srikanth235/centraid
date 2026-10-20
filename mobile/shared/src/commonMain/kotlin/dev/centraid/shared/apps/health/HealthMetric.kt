package dev.centraid.shared.apps.health

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.HealthBucket
import centraid.core.v1.HealthRange
import centraid.core.v1.HealthSeries
import centraid.core.v1.HealthSeriesRequest
import centraid.screen.v1.EmptyState
import centraid.screen.v1.HealthChartBar
import centraid.screen.v1.HealthChip
import centraid.screen.v1.HealthDevice
import centraid.screen.v1.HealthFact
import centraid.screen.v1.HealthMetricData
import centraid.screen.v1.HealthMetricEvent
import centraid.screen.v1.HealthMetricState
import centraid.screen.v1.HealthPageChrome
import centraid.screen.v1.Loading
import centraid.screen.v1.SeatState
import dev.centraid.design.copy.HealthCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.nav.ScreenIds
import dev.centraid.shared.screen.Step

/**
 * ONE METRIC OVER A WEEK, A MONTH OR A YEAR (#1129), opened from a Today or a Trends row: the
 * period's per-day average against the member's typical, the chart's buckets with the typical
 * line across them, and the facts. Every figure is `health.series`'s (R-1129-12); the identity hue
 * marks only the bucket today falls in (R-1129-10).
 */
public object HealthMetricMachine :
    HealthQueryMachine<HealthMetricState, HealthMetricEvent, HealthMetricData>(ScreenIds.HEALTH_METRIC, setOf("health_daily")) {
    public const val SCREEN_ID: String = ScreenIds.HEALTH_METRIC

    public const val RANGE_WEEK: String = "week"
    public const val RANGE_MONTH: String = "month"
    public const val RANGE_YEAR: String = "year"

    override val lens: ContentLens<HealthMetricState, HealthMetricData> = Lens

    override fun blank(): HealthMetricState = HealthMetricState(
        metric = HealthMetrics.STEPS.key,
        range = HealthMetricState.Range.RANGE_WEEK,
        device = HealthDevice(units = HealthDevice.Units.UNITS_METRIC),
    )

    override fun withSeat(screen: HealthMetricState, seat: SeatState): HealthMetricState = screen.copy(seat = seat)

    override fun view(held: HealthHeld<HealthMetricState>, event: HealthMetricEvent): Step<HealthHeld<HealthMetricState>> {
        val screen = held.screen
        return when {
            event.opened != null -> reload(
                held.copy(
                    screen = screen.copy(
                        metric = HealthMetrics.ofKey(event.opened.metric)?.key ?: HealthMetrics.STEPS.key,
                        range = event.opened.range.takeUnless { it == HealthMetricState.Range.RANGE_UNSPECIFIED }
                            ?: HealthMetricState.Range.RANGE_WEEK,
                        chrome = HealthPageChrome(back_label = event.opened.parent.ifEmpty { HealthCopy.APP_TITLE }),
                        device = event.opened.device ?: screen.device,
                    ),
                ),
            )
            event.refreshed != null -> read(overRows(held))
            event.range != null -> {
                val range = when (event.range.key) {
                    RANGE_WEEK -> HealthMetricState.Range.RANGE_WEEK
                    RANGE_MONTH -> HealthMetricState.Range.RANGE_MONTH
                    RANGE_YEAR -> HealthMetricState.Range.RANGE_YEAR
                    else -> null
                }
                if (range == null || range == screen.range) Step(held) else reload(held.copy(screen = screen.copy(range = range)))
            }
            else -> Step(held)
        }
    }

    internal fun wire(range: HealthMetricState.Range): HealthRange = when (range) {
        HealthMetricState.Range.RANGE_MONTH -> HealthRange.HEALTH_RANGE_MONTH
        HealthMetricState.Range.RANGE_YEAR -> HealthRange.HEALTH_RANGE_YEAR
        else -> HealthRange.HEALTH_RANGE_WEEK
    }

    override fun fold(held: HealthHeld<HealthMetricState>): HealthMetricData? {
        val answer = held.answers.series ?: return null
        val screen = held.screen
        val metric = HealthMetrics.ofKey(screen.metric) ?: return null
        if (answer.metric != metric.wire || answer.range != wire(screen.range)) return null
        val units = HealthFold.device(screen.device).units
        val year = screen.range == HealthMetricState.Range.RANGE_YEAR
        val caption = caption(screen.range, answer.buckets)
        if (answer.buckets.none { it.value_ != null }) {
            return HealthMetricData(caption = caption, empty = EmptyState(headline = HealthCopy.METRIC_EMPTY))
        }
        val average = answer.average
        val (number, unit) = average?.let { HealthFold.figure(metric, it, units) } ?: ("" to "")
        val typical = answer.typical
        val versus = if (average != null && typical != null) {
            val (diff, sign) = HealthFold.delta(metric, average, typical, units)
            when {
                sign > 0 -> HealthFold.fill(if (year) HealthCopy.VERSUS_YEAR_ABOVE else HealthCopy.VERSUS_ABOVE, "diff" to diff.drop(1))
                sign < 0 -> HealthFold.fill(if (year) HealthCopy.VERSUS_YEAR_BELOW else HealthCopy.VERSUS_BELOW, "diff" to diff.drop(1))
                else -> if (year) HealthCopy.VERSUS_YEAR_ABOUT else HealthCopy.VERSUS_ABOUT
            }
        } else {
            ""
        }
        // A BAR'S HEIGHT IS DRAWING: the tallest of the buckets and the typical line is the chart's top.
        val top = HealthFold.scaleOver(maxOf(answer.buckets.mapNotNull { it.value_ }.maxOrNull() ?: 0.0, typical ?: 0.0))
        val bars = answer.buckets.mapIndexed { index, bucket ->
            val value = bucket.value_
            HealthChartBar(
                has_value = value != null,
                height_bp = value?.let { HealthFold.bp(it, top) } ?: 0,
                current = index == answer.buckets.lastIndex,
                above_typical = value != null && typical != null && value > typical,
                accessibility_label = listOf(bucketWords(screen.range, bucket), value?.let { HealthFold.phrase(metric, it, units) }.orEmpty())
                    .filter { it.isNotEmpty() }.joinToString(", "),
            )
        }
        val averageWords = listOf(number, perUnit(metric, unit)).filter { it.isNotEmpty() }.joinToString(" ")
        return HealthMetricData(
            caption = caption,
            average = number,
            average_unit = perUnit(metric, unit),
            versus = versus,
            bars = bars,
            has_typical = typical != null,
            typical_bp = typical?.let { HealthFold.bp(it, top) } ?: 0,
            typical_label = HealthCopy.TYPICAL_LINE,
            ticks = ticks(screen.range, answer.buckets),
            facts = facts(metric, answer, year, units),
            foot = foot(metric, HealthFold.store(HealthFold.device(screen.device))),
            chart_label = HealthFold.fill(HealthCopy.CHART_SPOKEN, "caption" to caption, "average" to averageWords),
        )
    }

    private fun perUnit(metric: HealthMetrics, unit: String): String = HealthHomeMachine.perUnit(metric, unit)

    private fun facts(metric: HealthMetrics, answer: HealthSeries, year: Boolean, units: HealthDevice.Units): List<HealthFact> = buildList {
        answer.best?.let { best ->
            val lowest = metric == HealthMetrics.RESTING_HR
            val label = when {
                year && lowest -> HealthCopy.FACT_LOWEST_MONTH
                year -> HealthCopy.FACT_BEST_MONTH
                lowest -> HealthCopy.FACT_LOWEST_DAY
                else -> HealthCopy.FACT_BEST_DAY
            }
            val at = if (year) monthOf(best.start) else CivilWords.dated(best.start)
            best.value_?.let { add(HealthFact(label = label, detail = "$at · ${HealthFold.phrase(metric, it, units)}")) }
        }
        answer.total?.let { total ->
            val words = if (metric == HealthMetrics.STEPS) "${HealthFold.phrase(metric, total, units)} ${HealthCopy.UNIT_STEPS}" else HealthFold.phrase(metric, total, units)
            add(HealthFact(label = HealthCopy.FACT_TOTAL, detail = words))
        }
        if (answer.typical != null && answer.counted > 0) {
            add(
                HealthFact(
                    label = if (year) HealthCopy.FACT_ABOVE_MONTHS else HealthCopy.FACT_ABOVE_DAYS,
                    detail = HealthFold.fill(HealthCopy.FACT_COUNT, "n" to answer.above_typical.toString(), "m" to answer.counted.toString()),
                ),
            )
        }
    }

    private fun foot(metric: HealthMetrics, store: String): String = when (metric) {
        HealthMetrics.SLEEP -> HealthCopy.METRIC_FOOT_SLEEP
        HealthMetrics.RESTING_HR -> HealthFold.fill(HealthCopy.METRIC_FOOT_HEART, "store" to store)
        HealthMetrics.WEIGHT -> HealthCopy.METRIC_FOOT_WEIGHT
        else -> HealthFold.fill(HealthCopy.METRIC_FOOT_DAY, "store" to store)
    }

    private fun monthOf(day: String): String = day.drop(MONTH_AT).take(2).toIntOrNull()?.let(CivilWords::monthName).orEmpty()

    /** "Wed 14 – Tue 20 October", "Last 30 days", "November – October". */
    private fun caption(range: HealthMetricState.Range, buckets: List<HealthBucket>): String {
        val first = buckets.firstOrNull() ?: return ""
        val last = buckets.last()
        return when (range) {
            HealthMetricState.Range.RANGE_MONTH -> HealthCopy.CAPTION_MONTH
            HealthMetricState.Range.RANGE_YEAR -> "${monthOf(first.start)} – ${monthOf(last.start)}"
            else -> "${CivilWords.dated(first.start)} – ${CivilWords.dayMonth(last.end)}"
        }
    }

    private fun bucketWords(range: HealthMetricState.Range, bucket: HealthBucket): String =
        if (range == HealthMetricState.Range.RANGE_YEAR) monthOf(bucket.start) else CivilWords.dayMonth(bucket.start)

    /**
     * Under the chart: weekday initials for a week, a date a week for a month, a month a quarter for
     * a year. **Marked back from the bucket today falls in**, at one even step, so the last tick is
     * today's and no two ticks are ever closer than the step (counting forwards from the first bucket
     * and then adding today put two dates a day apart). Oldest first.
     */
    internal fun ticks(range: HealthMetricState.Range, buckets: List<HealthBucket>): List<String> = when (range) {
        HealthMetricState.Range.RANGE_MONTH -> back(buckets, WEEK).map { HealthFold.shortDate(it.start) }
        HealthMetricState.Range.RANGE_YEAR -> back(buckets, QUARTER).map { monthOf(it.start).take(3) }
        else -> buckets.map { CivilWords.weekdayShort(it.start).take(1) }
    }

    /** Every [step]th bucket counting back from the last, oldest first. */
    private fun back(buckets: List<HealthBucket>, step: Int): List<HealthBucket> =
        (buckets.lastIndex downTo 0 step step).reversed().map { buckets[it] }

    private const val MONTH_AT: Int = 5
    private const val WEEK: Int = 7
    private const val QUARTER: Int = 3

    internal object Lens : ContentLens<HealthMetricState, HealthMetricData> {
        override fun content(state: HealthMetricState): ReadContent<HealthMetricData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: HealthMetricState, content: ReadContent<HealthMetricData>): HealthMetricState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }

    override fun decorate(held: HealthHeld<HealthMetricState>): HealthMetricState {
        val screen = held.screen
        val metric = HealthMetrics.ofKey(screen.metric) ?: HealthMetrics.STEPS
        return screen.copy(
            chrome = (screen.chrome ?: HealthPageChrome()).copy(title = HealthFold.label(metric), retry = HealthCopy.RETRY),
            segments = listOf(
                HealthChip(key = RANGE_WEEK, label = HealthCopy.RANGE_WEEK, active = screen.range == HealthMetricState.Range.RANGE_WEEK),
                HealthChip(key = RANGE_MONTH, label = HealthCopy.RANGE_MONTH, active = screen.range == HealthMetricState.Range.RANGE_MONTH),
                HealthChip(key = RANGE_YEAR, label = HealthCopy.RANGE_YEAR, active = screen.range == HealthMetricState.Range.RANGE_YEAR),
            ),
        )
    }
}

/** What a metric page asks: its series, over the range in view. */
public object HealthMetricReads : HealthQueries<HealthMetricState, HealthMetricEvent>(
    screenId = HealthMetricMachine.SCREEN_ID,
    tables = setOf("health_daily"),
    ask = { held, day ->
        val metric = HealthMetrics.ofKey(held.screen.metric)
        if (metric == null) {
            null
        } else {
            listOf(
                AppQueryRequest(
                    health_series = HealthSeriesRequest(metric = metric.wire, range = HealthMetricMachine.wire(held.screen.range), today = day.today),
                ),
            )
        }
    },
)
