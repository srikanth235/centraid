package dev.centraid.shared.apps.health

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.HealthToday
import centraid.core.v1.HealthTodayMetric
import centraid.core.v1.HealthTodayRequest
import centraid.core.v1.HealthTrendRange
import centraid.core.v1.HealthTrendsRequest
import centraid.core.v1.HealthWorkoutsRequest
import centraid.screen.v1.EmptyState
import centraid.screen.v1.HealthBandTab
import centraid.screen.v1.HealthChip
import centraid.screen.v1.HealthDevice
import centraid.screen.v1.HealthFact
import centraid.screen.v1.HealthHomeChrome
import centraid.screen.v1.HealthHomeData
import centraid.screen.v1.HealthHomeEvent
import centraid.screen.v1.HealthHomeState
import centraid.screen.v1.HealthMetricLine
import centraid.screen.v1.HealthMoreRow
import centraid.screen.v1.HealthRangeBar
import centraid.screen.v1.HealthTodayData
import centraid.screen.v1.HealthTrendRow
import centraid.screen.v1.HealthTrendsData
import centraid.screen.v1.HealthWorkoutSection
import centraid.screen.v1.HealthWorkoutsData
import centraid.screen.v1.Loading
import centraid.screen.v1.SeatState
import centraid.screen.v1.StatusChip
import dev.centraid.design.copy.HealthCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.kit.time.plusDays
import dev.centraid.shared.nav.ScreenIds
import dev.centraid.shared.screen.Step

/**
 * EVERY TABLE A HEALTH HOME READ TOUCHES (#1129): the days, the workouts and their activities, the
 * kinds scheme they are named by, and the store's origin (whether a store is connected).
 */
public val HEALTH_HOME_TABLES: Set<String> = setOf("health_daily", "health_workout", "core_activity", "core_concept", "phone_origin")

/**
 * HEALTH'S HOME (#1129): Today · Trends · Workouts, and More as a sheet. One screen, the tab a
 * parameter (the navigation model's first doctrine), Money's shape.
 *
 * - **Today** is the day's numbers against the member's own 30-day typical and usual range
 *   (R-1129-8: whole days, no "by now"), today's workouts, and a foot that names the store and
 *   no time (R-1129-13).
 * - **Trends** is every metric over 30 days, 90 days or a year against the equal period before.
 * - **Workouts** is every workout, newest first, a kind chip row, a page at a time.
 * - **More** holds "What Health may read" (which says Chat does not read Health, R-1129-11, and
 *   names a chosen type that read nothing or that the OS refused, R-1129-6), "Choose what to
 *   read", and "Stop reading", behind a confirm.
 *
 * Nothing connected: every tab is the kit's empty state with one action, Connect (R-ONBOARD-4).
 * Every read asks `health.today` first, which says whether a store is connected and which types
 * have any data.
 */
public object HealthHomeMachine :
    HealthQueryMachine<HealthHomeState, HealthHomeEvent, HealthHomeData>(ScreenIds.HEALTH_HOME, HEALTH_HOME_TABLES) {
    public const val SCREEN_ID: String = ScreenIds.HEALTH_HOME

    /** Workouts asked for per page, and the most one window holds (the core's page ceiling). */
    public const val PAGE: Int = 50
    public const val MAX_ROWS: Int = 200

    public const val BAND_TODAY: String = "today"
    public const val BAND_TRENDS: String = "trends"
    public const val BAND_WORKOUTS: String = "workouts"
    public const val BAND_MORE: String = "more"

    public const val MORE_READS: String = "reads"
    public const val MORE_CHOOSE: String = "choose"
    public const val MORE_STOP: String = "stop"

    public const val RANGE_DAYS_30: String = "days_30"
    public const val RANGE_DAYS_90: String = "days_90"
    public const val RANGE_YEAR: String = "year"

    override val lens: ContentLens<HealthHomeState, HealthHomeData> = Lens

    override fun blank(): HealthHomeState = HealthHomeState(
        destination = HealthHomeState.Destination.DESTINATION_TODAY,
        sheet = HealthHomeState.Sheet.SHEET_NONE,
        trend_range = HealthHomeState.TrendRange.TREND_RANGE_DAYS_30,
        workouts_shown = PAGE,
        device = HealthDevice(units = HealthDevice.Units.UNITS_METRIC),
    )

    override fun withSeat(screen: HealthHomeState, seat: SeatState): HealthHomeState = screen.copy(seat = seat)

    override fun view(held: HealthHeld<HealthHomeState>, event: HealthHomeEvent): Step<HealthHeld<HealthHomeState>> {
        val screen = held.screen
        return when {
            event.opened != null -> reload(
                held.copy(
                    screen = screen.copy(
                        destination = event.opened.destination
                            .takeUnless { it == HealthHomeState.Destination.DESTINATION_UNSPECIFIED }
                            ?: HealthHomeState.Destination.DESTINATION_TODAY,
                        device = event.opened.device ?: screen.device,
                        sheet = HealthHomeState.Sheet.SHEET_NONE,
                        kind_concept_id = "",
                        workouts_shown = PAGE,
                    ),
                ),
            )
            event.refreshed != null -> read(overRows(held))
            event.band != null -> when (event.band.key) {
                BAND_TODAY -> moveTo(held, HealthHomeState.Destination.DESTINATION_TODAY)
                BAND_TRENDS -> moveTo(held, HealthHomeState.Destination.DESTINATION_TRENDS)
                BAND_WORKOUTS -> moveTo(held, HealthHomeState.Destination.DESTINATION_WORKOUTS)
                BAND_MORE -> Step(held.copy(screen = screen.copy(sheet = HealthHomeState.Sheet.SHEET_MORE)))
                else -> Step(held)
            }
            event.range != null -> {
                val range = when (event.range.key) {
                    RANGE_DAYS_30 -> HealthHomeState.TrendRange.TREND_RANGE_DAYS_30
                    RANGE_DAYS_90 -> HealthHomeState.TrendRange.TREND_RANGE_DAYS_90
                    RANGE_YEAR -> HealthHomeState.TrendRange.TREND_RANGE_YEAR
                    else -> null
                }
                if (range == null || range == screen.trend_range) {
                    Step(held)
                } else {
                    read(held.copy(screen = lens.with(screen.copy(trend_range = range), ReadContent.Loading(firstLoad = true))))
                }
            }
            event.kind_picked != null ->
                if (event.kind_picked.kind_concept_id == screen.kind_concept_id) {
                    Step(held)
                } else {
                    read(
                        held.copy(
                            screen = lens.with(
                                screen.copy(kind_concept_id = event.kind_picked.kind_concept_id, workouts_shown = PAGE),
                                ReadContent.Loading(firstLoad = true),
                            ),
                        ),
                    )
                }
            // A bigger window: the rows on screen stay while the read lands.
            event.show_more != null -> {
                val grown = (screen.workouts_shown + PAGE).coerceAtMost(MAX_ROWS)
                if (grown == screen.workouts_shown) Step(held) else read(overRows(held.copy(screen = screen.copy(workouts_shown = grown))))
            }
            event.sheet_closed != null -> Step(held.copy(screen = screen.copy(sheet = HealthHomeState.Sheet.SHEET_NONE)))
            event.more != null -> Step(
                held.copy(
                    screen = screen.copy(
                        sheet = when (event.more.key) {
                            MORE_READS -> HealthHomeState.Sheet.SHEET_READS
                            MORE_STOP -> HealthHomeState.Sheet.SHEET_STOP
                            // `choose` is the shell's route; the sheet goes behind it.
                            else -> HealthHomeState.Sheet.SHEET_NONE
                        },
                    ),
                ),
            )
            // The shell stops the store (`HealthConnectBridge.stop`); the origin's change re-reads.
            event.stop != null -> Step(held.copy(screen = screen.copy(sheet = HealthHomeState.Sheet.SHEET_NONE)))
            // INTENTS the shell routes: nothing changes here.
            else -> Step(held)
        }
    }

    /** A tab. The same tab again is nothing (the kit's band law). Every tab reads its own query. */
    private fun moveTo(held: HealthHeld<HealthHomeState>, to: HealthHomeState.Destination): Step<HealthHeld<HealthHomeState>> {
        if (to == held.screen.destination) return Step(held)
        val moved = held.copy(screen = held.screen.copy(destination = to, sheet = HealthHomeState.Sheet.SHEET_NONE))
        val data = if (answerFor(moved)) fold(moved) else null
        return if (data != null) {
            Step(moved.copy(screen = lens.with(moved.screen, ReadContent.Data(data))))
        } else {
            read(moved.copy(screen = lens.with(moved.screen, ReadContent.Loading(firstLoad = true))))
        }
    }

    private fun answerFor(held: HealthHeld<HealthHomeState>): Boolean = held.answers.today != null && when (held.screen.destination) {
        HealthHomeState.Destination.DESTINATION_TRENDS -> held.answers.trends?.range == trendRange(held.screen.trend_range)
        HealthHomeState.Destination.DESTINATION_WORKOUTS -> held.answers.workouts != null
        else -> true
    }

    override fun fold(held: HealthHeld<HealthHomeState>): HealthHomeData? {
        val today = held.answers.today ?: return null
        val screen = held.screen
        val day = held.places.today.ifEmpty { today.today }
        val base = HealthHomeData(today = day, day_label = CivilWords.dayMonth(day))
        if (!today.connected) {
            val store = HealthFold.store(HealthFold.device(screen.device))
            return base.copy(
                empty = EmptyState(
                    headline = HealthFold.fill(HealthCopy.CONNECT_EMPTY, "store" to store),
                    action_label = HealthFold.fill(HealthCopy.CONNECT_ACTION, "store" to store),
                ),
            )
        }
        return when (screen.destination) {
            HealthHomeState.Destination.DESTINATION_TRENDS -> base.copy(trends = trends(held) ?: return null)
            HealthHomeState.Destination.DESTINATION_WORKOUTS -> base.copy(workouts = workouts(held, day) ?: return null)
            else -> base.copy(today_data = today(held, today, day))
        }
    }

    // --- Today ---------------------------------------------------------------

    private fun today(held: HealthHeld<HealthHomeState>, answer: HealthToday, day: String): HealthTodayData {
        val units = HealthFold.device(held.screen.device).units
        val lines = HealthMetrics.entries.map { metric ->
            metricLine(metric, answer.metrics.firstOrNull { it.metric == metric.wire }, day, units, hero = metric == HealthMetrics.STEPS)
        }
        val workouts = answer.workouts.map { HealthFold.line(it, held.places.localOf(it.started_at), day, units) }
        return HealthTodayData(
            hero = lines.first(),
            metrics_heading = HealthCopy.TODAY_METRICS_HEADING,
            metrics = lines.drop(1),
            workouts_heading = if (workouts.isEmpty()) "" else HealthCopy.TODAY_WORKOUTS_HEADING,
            workouts = workouts,
            foot = HealthFold.fill(HealthCopy.TODAY_FOOT, "store" to HealthFold.store(HealthFold.device(held.screen.device))),
        )
    }

    /** One metric against the member's own typical (R-1129-8). The bar is drawing, the figures the core's. */
    internal fun metricLine(
        metric: HealthMetrics,
        answer: HealthTodayMetric?,
        today: String,
        units: HealthDevice.Units,
        hero: Boolean,
    ): HealthMetricLine {
        val value = answer?.value_
        val (number, unit) = value?.let { HealthFold.figure(metric, it, units) } ?: ("" to "")
        val whenWords = when {
            value == null -> HealthCopy.WHEN_NOTHING
            metric == HealthMetrics.SLEEP -> HealthCopy.WHEN_LAST_NIGHT
            metric == HealthMetrics.WEIGHT && answer?.day != null && answer.day != today -> CivilWords.relativeDay(answer.day!!, today)
            metric.sum -> HealthCopy.WHEN_SO_FAR
            else -> HealthCopy.WHEN_TODAY
        }
        val typical = answer?.typical
        val low = answer?.low
        val high = answer?.high
        val typicalWords = when {
            typical == null -> ""
            metric == HealthMetrics.RESTING_HR && low != null && high != null -> HealthFold.fill(
                HealthCopy.TYPICAL_RANGE,
                "low" to HealthFold.figure(metric, low, units).first,
                "high" to HealthFold.figure(metric, high, units).first,
            )
            else -> HealthFold.fill(HealthCopy.TYPICAL, "value" to HealthFold.phrase(metric, typical, units))
        }
        val bar = if (low != null && high != null) {
            val scale = HealthFold.scaleOver(maxOf(value ?: 0.0, high))
            HealthRangeBar(
                low_bp = HealthFold.bp(low, scale),
                high_bp = HealthFold.bp(high, scale),
                has_value = value != null,
                value_bp = value?.let { HealthFold.bp(it, scale) } ?: 0,
                start_label = if (hero) "0" else "",
                middle_label = if (hero) HealthCopy.HERO_SCALE_MIDDLE else "",
                end_label = if (hero) HealthFold.figure(metric, scale, units).first else "",
            )
        } else {
            null
        }
        val label = HealthFold.label(metric)
        val spoken = listOf(label, if (number.isEmpty()) "" else listOf(number, unit).filter { it.isNotEmpty() }.joinToString(" "), whenWords, typicalWords)
        return HealthMetricLine(
            metric = metric.key,
            label = label,
            value_ = number,
            unit = unit,
            when_label = whenWords,
            typical = typicalWords,
            bar = bar,
            accessibility_label = spoken.filter { it.isNotEmpty() }.joinToString(", "),
        )
    }

    // --- Trends --------------------------------------------------------------

    private fun trends(held: HealthHeld<HealthHomeState>): HealthTrendsData? {
        val answer = held.answers.trends ?: return null
        if (answer.range != trendRange(held.screen.trend_range)) return null
        val units = HealthFold.device(held.screen.device).units
        val compare = when (held.screen.trend_range) {
            HealthHomeState.TrendRange.TREND_RANGE_DAYS_90 -> HealthCopy.TRENDS_COMPARE_90
            HealthHomeState.TrendRange.TREND_RANGE_YEAR -> HealthCopy.TRENDS_COMPARE_YEAR
            else -> HealthCopy.TRENDS_COMPARE_30
        }
        val rows = answer.trends.mapNotNull { trend ->
            val metric = HealthMetrics.ofWire(trend.metric) ?: return@mapNotNull null
            val average = trend.average ?: return@mapNotNull null
            val (number, unit) = HealthFold.figure(metric, average, units)
            val (delta, sign) = trend.previous?.let { HealthFold.delta(metric, average, it, units) } ?: ("" to 0)
            val values = trend.buckets.mapNotNull { it.value_ }
            val lo = values.minOrNull() ?: average
            val hi = values.maxOrNull() ?: average
            val span = (hi - lo).takeIf { it > 0.0 } ?: 1.0
            fun height(v: Double) = HealthFold.bp(v - lo, span)
            val label = HealthFold.label(metric)
            HealthTrendRow(
                metric = metric.key,
                label = label,
                value_ = number,
                unit = perUnit(metric, unit),
                delta = delta,
                direction = when {
                    delta.isEmpty() -> HealthTrendRow.Direction.DIRECTION_UNSPECIFIED
                    sign > 0 -> HealthTrendRow.Direction.DIRECTION_UP
                    sign < 0 -> HealthTrendRow.Direction.DIRECTION_DOWN
                    else -> HealthTrendRow.Direction.DIRECTION_FLAT
                },
                points_bp = trend.buckets.map { bucket -> bucket.value_?.let(::height) ?: -1 },
                average_bp = height(average.coerceIn(lo, hi)),
                accessibility_label = if (delta.isEmpty()) label else HealthFold.fill(HealthCopy.TREND_SPOKEN, "label" to label, "delta" to delta),
            )
        }
        return HealthTrendsData(
            compare_line = compare,
            rows = rows,
            empty = if (rows.isEmpty()) EmptyState(headline = HealthCopy.TRENDS_EMPTY) else null,
        )
    }

    /** "a day", "kcal a day", "a night", or the unit alone for a reading that is not a total. */
    internal fun perUnit(metric: HealthMetrics, unit: String): String = when {
        metric == HealthMetrics.SLEEP -> HealthCopy.PER_NIGHT
        !metric.sum -> unit
        unit.isEmpty() -> HealthCopy.PER_DAY
        else -> HealthFold.fill(HealthCopy.PER_DAY_UNIT, "unit" to unit)
    }

    private fun trendRange(range: HealthHomeState.TrendRange): HealthTrendRange = when (range) {
        HealthHomeState.TrendRange.TREND_RANGE_DAYS_90 -> HealthTrendRange.HEALTH_TREND_RANGE_DAYS_90
        HealthHomeState.TrendRange.TREND_RANGE_YEAR -> HealthTrendRange.HEALTH_TREND_RANGE_YEAR
        else -> HealthTrendRange.HEALTH_TREND_RANGE_DAYS_30
    }

    // --- Workouts ------------------------------------------------------------

    private fun workouts(held: HealthHeld<HealthHomeState>, today: String): HealthWorkoutsData? {
        val answer = held.answers.workouts ?: return null
        val units = HealthFold.device(held.screen.device).units
        val week = plusDays(today, -WEEK_BACK) ?: today
        val sections = linkedMapOf<String, MutableList<centraid.screen.v1.HealthWorkoutLine>>()
        for (row in answer.workouts) {
            val local = held.places.localOf(row.started_at)
            val day = local.take(DAY)
            val heading = if (day >= week) HealthCopy.SECTION_THIS_WEEK else HealthFold.monthHeading(day, today)
            sections.getOrPut(heading) { mutableListOf() } += HealthFold.line(row, local, today, units)
        }
        val shown = answer.workouts.size
        return HealthWorkoutsData(
            sections = sections.map { (heading, rows) -> HealthWorkoutSection(heading = heading, rows = rows) },
            more = answer.next != null && shown < MAX_ROWS,
            empty = when {
                answer.workouts.isNotEmpty() -> null
                held.screen.kind_concept_id.isNotEmpty() -> EmptyState(headline = HealthCopy.WORKOUTS_KIND_EMPTY)
                else -> EmptyState(headline = HealthCopy.WORKOUTS_EMPTY)
            },
        )
    }

    // --- Chrome --------------------------------------------------------------

    override fun decorate(held: HealthHeld<HealthHomeState>): HealthHomeState {
        val screen = held.screen
        val drawing = lens.content(screen) !is ReadContent.Denied
        val connected = held.answers.today?.connected == true
        val store = HealthFold.store(HealthFold.device(screen.device))
        return screen.copy(
            band = if (drawing) band(screen.destination) else emptyList(),
            chrome = chrome(store),
            chips = if (drawing && connected && screen.destination == HealthHomeState.Destination.DESTINATION_WORKOUTS) chips(held) else emptyList(),
            segments = if (drawing && connected && screen.destination == HealthHomeState.Destination.DESTINATION_TRENDS) segments(screen.trend_range) else emptyList(),
            more_rows = moreRows(connected, store),
            reads_facts = readsFacts(held, store),
        )
    }

    private fun chips(held: HealthHeld<HealthHomeState>): List<HealthChip> {
        val kinds = held.answers.workouts?.kinds.orEmpty()
        val selected = held.screen.kind_concept_id
        return listOf(HealthChip(key = "", label = HealthCopy.KIND_ALL, active = selected.isEmpty())) +
            kinds.map { HealthChip(key = it.kind_concept_id, label = HealthFold.kindChip(it.kind_key, it.kind_label), active = it.kind_concept_id == selected) }
    }

    private fun segments(range: HealthHomeState.TrendRange): List<HealthChip> = listOf(
        HealthChip(key = RANGE_DAYS_30, label = HealthCopy.RANGE_DAYS_30, active = range == HealthHomeState.TrendRange.TREND_RANGE_DAYS_30),
        HealthChip(key = RANGE_DAYS_90, label = HealthCopy.RANGE_DAYS_90, active = range == HealthHomeState.TrendRange.TREND_RANGE_DAYS_90),
        HealthChip(key = RANGE_YEAR, label = HealthCopy.RANGE_YEAR, active = range == HealthHomeState.TrendRange.TREND_RANGE_YEAR),
    )

    private fun moreRows(connected: Boolean, store: String): List<HealthMoreRow> = buildList {
        add(HealthMoreRow(key = MORE_READS, label = HealthCopy.MORE_READS, icon_key = "Shield", tone = StatusChip.Tone.TONE_NEUTRAL))
        add(HealthMoreRow(key = MORE_CHOOSE, label = HealthCopy.MORE_CHOOSE, icon_key = "Sliders", tone = StatusChip.Tone.TONE_NEUTRAL))
        if (connected) {
            add(HealthMoreRow(key = MORE_STOP, label = HealthFold.fill(HealthCopy.MORE_STOP, "store" to store), icon_key = "Stop", tone = StatusChip.Tone.TONE_NET))
        }
    }

    /**
     * "WHAT HEALTH MAY READ": what it reads, that it writes nothing to the store, that Chat does
     * not read Health (R-1129-11), then a line per chosen type the OS refused (Health Connect
     * names them) or, where the OS cannot say (HealthKit), per chosen type that read nothing in
     * the year (R-1129-6).
     */
    private fun readsFacts(held: HealthHeld<HealthHomeState>, store: String): List<HealthFact> = buildList {
        add(HealthFact(label = HealthCopy.READS_FACT_READS, detail = HealthCopy.READS_FACT_READS_VALUE))
        add(HealthFact(label = HealthCopy.READS_FACT_WRITES, detail = HealthFold.fill(HealthCopy.READS_FACT_WRITES_VALUE, "store" to store)))
        add(HealthFact(label = HealthCopy.READS_FACT_CHAT, detail = HealthCopy.READS_FACT_CHAT_VALUE))
        val today = held.answers.today ?: return@buildList
        if (!today.connected) return@buildList
        val device = HealthFold.device(held.screen.device)
        val refused = device.refused.mapNotNull(HealthMetrics::ofKey)
        refused.forEach { metric ->
            add(HealthFact(label = HealthCopy.READS_REFUSED, detail = HealthFold.fill(HealthCopy.READS_REFUSED_VALUE, "type" to HealthFold.label(metric))))
        }
        if (device.store == HealthDevice.Store.STORE_APPLE_HEALTH) {
            val withData = today.metrics_with_data.toSet()
            device.chosen.mapNotNull(HealthMetrics::ofKey).filter { it.wire !in withData && it !in refused }.forEach { metric ->
                add(HealthFact(label = HealthCopy.READS_NOTHING, detail = HealthFold.fill(HealthCopy.READS_NOTHING_VALUE, "type" to HealthFold.label(metric))))
            }
        }
    }

    private fun band(current: HealthHomeState.Destination): List<HealthBandTab> = listOf(
        HealthBandTab(key = BAND_TODAY, label = HealthCopy.BAND_TODAY, icon_key = "Heart", current = current == HealthHomeState.Destination.DESTINATION_TODAY),
        HealthBandTab(key = BAND_TRENDS, label = HealthCopy.BAND_TRENDS, icon_key = "BarChart2", current = current == HealthHomeState.Destination.DESTINATION_TRENDS),
        HealthBandTab(key = BAND_WORKOUTS, label = HealthCopy.BAND_WORKOUTS, icon_key = "Gym", current = current == HealthHomeState.Destination.DESTINATION_WORKOUTS),
        HealthBandTab(key = BAND_MORE, label = HealthCopy.BAND_MORE, icon_key = "MoreHoriz", current = false),
    )

    private fun chrome(store: String): HealthHomeChrome = HealthHomeChrome(
        title = HealthCopy.APP_TITLE,
        retry = HealthCopy.RETRY,
        home = HealthCopy.HOME,
        more_title = HealthCopy.MORE_TITLE,
        reads_title = HealthCopy.READS_TITLE,
        close_label = HealthCopy.CLOSE,
        stop_title = HealthFold.fill(HealthCopy.STOP_TITLE, "store" to store),
        stop_body = HealthFold.fill(HealthCopy.STOP_BODY, "store" to store),
        stop_confirm = HealthCopy.STOP_CONFIRM,
        stop_cancel = HealthCopy.STOP_CANCEL,
        show_more = HealthCopy.SHOW_MORE,
    )

    private const val WEEK_BACK: Int = 6
    private const val DAY: Int = 10

    internal object Lens : ContentLens<HealthHomeState, HealthHomeData> {
        override fun content(state: HealthHomeState): ReadContent<HealthHomeData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: HealthHomeState, content: ReadContent<HealthHomeData>): HealthHomeState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

/** What Home asks: `health.today` always (connected, the types with data), then the tab's own query. */
public object HealthHomeReads : HealthQueries<HealthHomeState, HealthHomeEvent>(
    screenId = HealthHomeMachine.SCREEN_ID,
    tables = HEALTH_HOME_TABLES,
    ask = { held, day ->
        val screen = held.screen
        val today = AppQueryRequest(health_today = HealthTodayRequest(today = day.today, day_start = day.start, day_end = day.end))
        when (screen.destination) {
            HealthHomeState.Destination.DESTINATION_TRENDS -> listOf(
                today,
                AppQueryRequest(
                    health_trends = HealthTrendsRequest(
                        range = when (screen.trend_range) {
                            HealthHomeState.TrendRange.TREND_RANGE_DAYS_90 -> HealthTrendRange.HEALTH_TREND_RANGE_DAYS_90
                            HealthHomeState.TrendRange.TREND_RANGE_YEAR -> HealthTrendRange.HEALTH_TREND_RANGE_YEAR
                            else -> HealthTrendRange.HEALTH_TREND_RANGE_DAYS_30
                        },
                        today = day.today,
                    ),
                ),
            )
            HealthHomeState.Destination.DESTINATION_WORKOUTS -> listOf(
                today,
                AppQueryRequest(
                    health_workouts = HealthWorkoutsRequest(
                        kind_concept_id = screen.kind_concept_id.ifEmpty { null },
                        limit = screen.workouts_shown.coerceIn(1, HealthHomeMachine.MAX_ROWS),
                    ),
                ),
            )
            else -> listOf(today)
        }
    },
)
