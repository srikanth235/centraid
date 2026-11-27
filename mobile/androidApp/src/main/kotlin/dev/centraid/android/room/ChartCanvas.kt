package dev.centraid.android.room

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import centraid.core.v1.RoomCanvasEvent
import centraid.core.v1.RoomChart
import centraid.core.v1.RoomChartMark
import centraid.core.v1.RoomChartPoint
import centraid.core.v1.RoomChartRule
import centraid.core.v1.RoomChartScrubbed
import centraid.core.v1.RoomChartSeries
import centraid.core.v1.RoomTone
import dev.centraid.android.R
import dev.centraid.android.kit.HoldGridText
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.centraidResource
import dev.centraid.android.kit.kitCard
import dev.centraid.android.kit.kitTextStyle
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private data class ChartDomain(
    val xMin: Double,
    val xMax: Double,
    val yMin: Double,
    val yMax: Double,
    val hasBars: Boolean,
    val xStep: Double,
) {
    fun xFraction(x: Double): Float {
        val span = xMax - xMin
        if (span <= 0.0) return 0.5f
        return ((x - xMin) / span).toFloat().coerceIn(0f, 1f)
    }

    fun yFraction(y: Double): Float {
        val span = yMax - yMin
        if (span <= 0.0) return 0.5f
        return ((y - yMin) / span).toFloat().coerceIn(0f, 1f)
    }
}

private data class ActivePointHit(
    val seriesIndex: Int,
    val point: RoomChartPoint,
    val yDisplay: Double,
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ChartCanvas(
    chart: RoomChart,
    onCanvas: (RoomCanvasEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val hasData = chart.series.any { it.points.isNotEmpty() }
    var activePointId by remember(chart.selector_id, chart.readout_point_id) {
        mutableStateOf(chart.readout_point_id)
    }

    val seriesColors = chart.series.mapIndexed { index, series ->
        resolveSeriesColor(series.hue_key, index)
    }
    val ruleColors = chart.rules.map { resolveRuleColor(it.tone) }
    val domain = remember(chart) { computeDomain(chart) }
    val activeHit = remember(chart, activePointId) { findActivePoint(chart, activePointId) }

    val spokenSummary = remember(chart.summary, chart.empty_sentence, activeHit) {
        val base = chart.summary.ifEmpty { chart.empty_sentence }
        val pointSpoken = activeHit?.point?.let { pt ->
            pt.a11y_label.ifEmpty { formatReadoutLabel(pt) }
        }.orEmpty()
        when {
            base.isNotEmpty() && pointSpoken.isNotEmpty() -> "$base. $pointSpoken"
            base.isNotEmpty() -> base
            else -> pointSpoken
        }
    }

    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .kitCard()
            .padding(16.dp)
            .testTag(chart.selector_id.ifEmpty { "block-chart" })
            .semantics(mergeDescendants = true) {
                if (spokenSummary.isNotEmpty()) contentDescription = spokenSummary
            },
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (!hasData) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(140.dp),
                contentAlignment = Alignment.Center,
            ) {
                KitText(
                    text = chart.empty_sentence.ifEmpty { chart.summary },
                    rung = KitType.Meta,
                    color = Surface.meta,
                )
            }
            return@Column
        }

        val namedSeries = chart.series.mapIndexedNotNull { idx, s ->
            if (s.label.isNotEmpty()) idx to s.label else null
        }
        if (namedSeries.size > 1) {
            HoldGridText {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    namedSeries.forEach { (idx, label) ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Box(
                                Modifier
                                    .size(8.dp)
                                    .clip(CircleShape)
                                    .background(seriesColors[idx]),
                            )
                            KitText(label, KitType.Meta, Surface.meta, maxLines = 1)
                        }
                    }
                }
            }
        }

        val hasYTicks = chart.y_ticks.isNotEmpty()
        val yAxisWidth = if (hasYTicks) 48.dp else 0.dp
        val yAxisGap = if (hasYTicks) 6.dp else 0.dp
        val plotHeight = 196.dp
        val xAxisHeight = if (chart.x_ticks.isNotEmpty()) 22.dp else 0.dp

        val emitScrub: (String) -> Unit = { pointId ->
            if (pointId.isNotEmpty() && pointId != activePointId) {
                activePointId = pointId
                if (chart.selector_id.isNotEmpty()) {
                    onCanvas(
                        RoomCanvasEvent(
                            selector_id = chart.selector_id,
                            chart_scrub = RoomChartScrubbed(point_id = pointId),
                        ),
                    )
                }
            }
        }

        val gridLineColor = Surface.line
        val guideColor = Surface.border
        val cardColor = Surface.card
        val inkColor = Surface.ink
        val metaColor = Surface.meta

        Column(Modifier.fillMaxWidth()) {
            if (activeHit != null) {
                val readoutLabel = formatReadoutLabel(activeHit.point)
                if (readoutLabel.isNotEmpty()) {
                    BoxWithConstraints(
                        Modifier
                            .fillMaxWidth()
                            .padding(start = yAxisWidth + yAxisGap, bottom = 6.dp)
                            .height(26.dp),
                    ) {
                        val density = LocalDensity.current
                        val maxWidthPx = with(density) { maxWidth.toPx() }
                        val insetPx = with(density) { plotHorizontalInset(domain).toPx() }
                        val usableWidth = (maxWidthPx - insetPx * 2f).coerceAtLeast(1f)
                        val anchorX = insetPx + domain.xFraction(activeHit.point.x) * usableWidth
                        var pillWidthPx by remember { mutableStateOf(0) }
                        val pillX = (anchorX - pillWidthPx / 2f)
                            .roundToInt()
                            .coerceIn(0, (maxWidthPx.roundToInt() - pillWidthPx).coerceAtLeast(0))

                        Box(
                            Modifier
                                .offset { IntOffset(pillX, 0) }
                                .onSizeChanged { pillWidthPx = it.width }
                                .clip(RoundedCornerShape(8.dp))
                                .background(inkColor)
                                .padding(horizontal = 8.dp, vertical = 4.dp)
                                .testTag("chart-readout"),
                        ) {
                            HoldGridText {
                                Text(
                                    text = readoutLabel,
                                    style = kitTextStyle(KitType.Meta).copy(fontWeight = FontWeight.SemiBold),
                                    color = cardColor,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }

            Row(Modifier.fillMaxWidth()) {
                if (hasYTicks) {
                    BoxWithConstraints(
                        Modifier
                            .width(yAxisWidth)
                            .height(plotHeight),
                    ) {
                        val density = LocalDensity.current
                        val heightPx = with(density) { plotHeight.toPx() }
                        val vPadPx = with(density) { 8.dp.toPx() }
                        val usableH = (heightPx - vPadPx * 2f).coerceAtLeast(1f)
                        HoldGridText {
                            chart.y_ticks.forEach { tick ->
                                val yPx = vPadPx + (1f - domain.yFraction(tick.at)) * usableH
                                val yOffset = (yPx - with(density) { 8.dp.toPx() })
                                    .roundToInt()
                                    .coerceIn(0, (heightPx - with(density) { 16.dp.toPx() }).roundToInt().coerceAtLeast(0))
                                Text(
                                    text = tick.label,
                                    style = kitTextStyle(KitType.Meta),
                                    color = metaColor,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    textAlign = TextAlign.End,
                                    modifier = Modifier
                                        .width(yAxisWidth)
                                        .offset { IntOffset(0, yOffset) },
                                )
                            }
                        }
                    }
                    Spacer(Modifier.width(yAxisGap))
                }

                BoxWithConstraints(
                    Modifier
                        .weight(1f)
                        .height(plotHeight)
                        .pointerInput(chart, domain) {
                            detectTapGestures { offset ->
                                val hit = findNearestPoint(
                                    chart = chart,
                                    domain = domain,
                                    touchX = offset.x,
                                    touchY = offset.y,
                                    widthPx = size.width.toFloat(),
                                    heightPx = size.height.toFloat(),
                                    insetPx = plotHorizontalInset(domain).toPx(),
                                    vPadPx = 8.dp.toPx(),
                                )
                                hit?.let(emitScrub)
                            }
                        }
                        .pointerInput(chart, domain) {
                            detectHorizontalDragGestures { change, _ ->
                                change.consume()
                                val hit = findNearestPoint(
                                    chart = chart,
                                    domain = domain,
                                    touchX = change.position.x,
                                    touchY = change.position.y,
                                    widthPx = size.width.toFloat(),
                                    heightPx = size.height.toFloat(),
                                    insetPx = plotHorizontalInset(domain).toPx(),
                                    vPadPx = 8.dp.toPx(),
                                )
                                hit?.let(emitScrub)
                            }
                        },
                ) {
                    val density = LocalDensity.current
                    val heightPx = with(density) { plotHeight.toPx() }
                    val vPadPx = with(density) { 8.dp.toPx() }
                    val usableH = (heightPx - vPadPx * 2f).coerceAtLeast(1f)

                    Canvas(Modifier.fillMaxSize()) {
                        val insetPx = plotHorizontalInset(domain).toPx()
                        val usableW = (size.width - insetPx * 2f).coerceAtLeast(1f)
                        val vPad = 8.dp.toPx()
                        val plotH = (size.height - vPad * 2f).coerceAtLeast(1f)

                        fun xOf(x: Double): Float = insetPx + domain.xFraction(x) * usableW
                        fun yOf(y: Double): Float = vPad + (1f - domain.yFraction(y)) * plotH

                        chart.y_ticks.forEach { tick ->
                            val y = yOf(tick.at)
                            drawLine(
                                color = gridLineColor,
                                start = Offset(0f, y),
                                end = Offset(size.width, y),
                                strokeWidth = 1.dp.toPx(),
                            )
                        }

                        drawRangeBands(chart.series, seriesColors, ::xOf, ::yOf)
                        drawReferenceRules(chart.rules, ruleColors, ::yOf)
                        drawBarSeries(
                            seriesList = chart.series,
                            seriesColors = seriesColors,
                            domain = domain,
                            activePointId = activePointId,
                            inkColor = inkColor,
                            usableW = usableW,
                            xOf = ::xOf,
                            yOf = ::yOf,
                        )
                        drawAreaAndLineSeries(
                            seriesList = chart.series,
                            seriesColors = seriesColors,
                            domain = domain,
                            xOf = ::xOf,
                            yOf = ::yOf,
                        )
                        drawPointSeries(
                            seriesList = chart.series,
                            seriesColors = seriesColors,
                            cardColor = cardColor,
                            xOf = ::xOf,
                            yOf = ::yOf,
                        )

                        if (activeHit != null) {
                            val ax = xOf(activeHit.point.x)
                            val ay = yOf(activeHit.yDisplay)
                            val activeSeries = chart.series.getOrNull(activeHit.seriesIndex)
                            val activeColor = seriesColors.getOrElse(activeHit.seriesIndex) { inkColor }
                            if (activeSeries?.mark != RoomChartMark.ROOM_CHART_MARK_BAR) {
                                drawLine(
                                    color = guideColor,
                                    start = Offset(ax, vPad),
                                    end = Offset(ax, size.height - vPad),
                                    strokeWidth = 1.dp.toPx(),
                                )
                                drawCircle(
                                    color = cardColor,
                                    radius = 6.5.dp.toPx(),
                                    center = Offset(ax, ay),
                                )
                                drawCircle(
                                    color = activeColor,
                                    radius = 4.5.dp.toPx(),
                                    center = Offset(ax, ay),
                                )
                            }
                        }
                    }

                    HoldGridText {
                        chart.rules.forEachIndexed { idx, rule ->
                            if (rule.label.isNotEmpty()) {
                                val yPx = vPadPx + (1f - domain.yFraction(rule.at)) * usableH
                                val labelY = (yPx - with(density) { 17.dp.toPx() })
                                    .roundToInt()
                                    .coerceIn(0, (heightPx - with(density) { 16.dp.toPx() }).roundToInt().coerceAtLeast(0))
                                Text(
                                    text = rule.label,
                                    style = kitTextStyle(KitType.Badge),
                                    color = ruleColors[idx],
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier
                                        .align(Alignment.TopEnd)
                                        .offset { IntOffset(0, labelY) },
                                )
                            }
                        }
                    }
                }
            }

            if (chart.x_ticks.isNotEmpty()) {
                BoxWithConstraints(
                    Modifier
                        .fillMaxWidth()
                        .padding(start = yAxisWidth + yAxisGap, top = 4.dp)
                        .height(xAxisHeight),
                ) {
                    val density = LocalDensity.current
                    val widthPx = with(density) { maxWidth.toPx() }
                    val insetPx = with(density) { plotHorizontalInset(domain).toPx() }
                    val usableW = (widthPx - insetPx * 2f).coerceAtLeast(1f)
                    val maxSlotPx = (insetPx * 2f).coerceAtLeast(with(density) { 36.dp.toPx() })
                    val labelSlotW = (widthPx / chart.x_ticks.size.coerceAtLeast(1)).coerceAtMost(maxSlotPx)

                    HoldGridText {
                        chart.x_ticks.forEach { tick ->
                            val cx = insetPx + domain.xFraction(tick.at) * usableW
                            val xOffset = (cx - labelSlotW / 2f)
                                .roundToInt()
                                .coerceIn(0, (widthPx - labelSlotW).roundToInt().coerceAtLeast(0))
                            val isActiveTick = activeHit != null && abs(activeHit.point.x - tick.at) < 1e-6
                            Text(
                                text = tick.label,
                                style = kitTextStyle(KitType.Meta).copy(
                                    fontWeight = if (isActiveTick) FontWeight.SemiBold else FontWeight.Normal,
                                ),
                                color = if (isActiveTick) inkColor else metaColor,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                textAlign = TextAlign.Center,
                                modifier = Modifier
                                    .width(with(density) { labelSlotW.toDp() })
                                    .offset { IntOffset(xOffset, 0) },
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun plotHorizontalInset(domain: ChartDomain) =
    if (domain.hasBars) 20.dp else 16.dp

private fun DrawScope.drawRangeBands(
    seriesList: List<RoomChartSeries>,
    seriesColors: List<Color>,
    xOf: (Double) -> Float,
    yOf: (Double) -> Float,
) {
    seriesList.forEachIndexed { idx, series ->
        val bandPoints = series.points.filter { it.y_high > it.y_low }.sortedBy { it.x }
        if (bandPoints.isEmpty()) return@forEachIndexed
        val fill = seriesColors[idx].copy(alpha = 0.14f)
        if (bandPoints.size == 1) {
            val pt = bandPoints.first()
            val cx = xOf(pt.x)
            val top = yOf(pt.y_high)
            val bottom = yOf(pt.y_low)
            val w = 10.dp.toPx()
            drawRoundRect(
                color = fill,
                topLeft = Offset(cx - w / 2f, top),
                size = Size(w, (bottom - top).coerceAtLeast(2.dp.toPx())),
                cornerRadius = CornerRadius(4.dp.toPx(), 4.dp.toPx()),
            )
            return@forEachIndexed
        }
        val path = Path().apply {
            val first = bandPoints.first()
            moveTo(xOf(first.x), yOf(first.y_high))
            for (i in 1 until bandPoints.size) {
                val p = bandPoints[i]
                lineTo(xOf(p.x), yOf(p.y_high))
            }
            for (i in bandPoints.lastIndex downTo 0) {
                val p = bandPoints[i]
                lineTo(xOf(p.x), yOf(p.y_low))
            }
            close()
        }
        drawPath(path = path, color = fill)
    }
}

private fun DrawScope.drawReferenceRules(
    rules: List<RoomChartRule>,
    ruleColors: List<Color>,
    yOf: (Double) -> Float,
) {
    val dash = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx()), 0f)
    rules.forEachIndexed { idx, rule ->
        val y = yOf(rule.at)
        drawLine(
            color = ruleColors[idx],
            start = Offset(0f, y),
            end = Offset(size.width, y),
            strokeWidth = 1.5.dp.toPx(),
            pathEffect = dash,
        )
    }
}

private fun DrawScope.drawBarSeries(
    seriesList: List<RoomChartSeries>,
    seriesColors: List<Color>,
    domain: ChartDomain,
    activePointId: String,
    inkColor: Color,
    usableW: Float,
    xOf: (Double) -> Float,
    yOf: (Double) -> Float,
) {
    val barSeries = seriesList.mapIndexedNotNull { idx, s ->
        if (s.mark == RoomChartMark.ROOM_CHART_MARK_BAR) idx to s else null
    }
    if (barSeries.isEmpty()) return

    val distinctX = barSeries.flatMap { (_, s) -> s.points.map { it.x } }.distinct().sorted()
    val slotCount = max(distinctX.size, 1)
    val slotPitch = if (slotCount > 1) usableW / (slotCount - 1).coerceAtLeast(1) else usableW

    // Group bar series into slots: series sharing a non-empty `stack` share one slot.
    val slotKeys = mutableListOf<String>()
    val seriesSlotIndex = mutableMapOf<Int, Int>()
    barSeries.forEach { (idx, s) ->
        val key = if (s.stack.isNotEmpty()) "stack:${s.stack}" else "single:$idx"
        val existing = slotKeys.indexOf(key)
        val slot = if (existing >= 0) existing else {
            slotKeys.add(key)
            slotKeys.lastIndex
        }
        seriesSlotIndex[idx] = slot
    }

    val groupCount = slotKeys.size.coerceAtLeast(1)
    val maxGroupWidth = (slotPitch * 0.68f).coerceIn(8.dp.toPx(), 44.dp.toPx())
    val gapPx = if (groupCount > 1) 2.dp.toPx() else 0f
    val barWidth = ((maxGroupWidth - gapPx * (groupCount - 1)) / groupCount)
        .coerceIn(4.dp.toPx(), 32.dp.toPx())
    val totalGroupWidth = barWidth * groupCount + gapPx * (groupCount - 1)
    val corner = CornerRadius(4.dp.toPx(), 4.dp.toPx())
    val singleUnstackedSeries = barSeries.size == 1 && barSeries.first().second.stack.isEmpty()

    // Track positive/negative stack baselines per (slot, x).
    val posBase = mutableMapOf<Pair<Int, Double>, Double>()
    val negBase = mutableMapOf<Pair<Int, Double>, Double>()
    val activeBarBounds = mutableMapOf<Pair<Int, Double>, Pair<Float, Float>>()

    barSeries.forEach { (idx, series) ->
        val slot = seriesSlotIndex[idx] ?: 0
        val color = seriesColors[idx]
        val offsetFromCenter = -totalGroupWidth / 2f + slot * (barWidth + gapPx)

        series.points.forEach { pt ->
            val key = slot to pt.x
            val startVal: Double
            val endVal: Double
            if (series.stack.isNotEmpty()) {
                if (pt.y >= 0.0) {
                    startVal = posBase[key] ?: 0.0
                    endVal = startVal + pt.y
                    posBase[key] = endVal
                } else {
                    startVal = negBase[key] ?: 0.0
                    endVal = startVal + pt.y
                    negBase[key] = endVal
                }
            } else {
                startVal = 0.0
                endVal = pt.y
            }

            val topY = min(yOf(startVal), yOf(endVal))
            val bottomY = max(yOf(startVal), yOf(endVal))
            val left = xOf(pt.x) + offsetFromCenter
            val height = (bottomY - topY).coerceAtLeast(2.dp.toPx())

            val isSelected = activePointId.isNotEmpty() && pt.id == activePointId
            val barColor = if (singleUnstackedSeries && activePointId.isNotEmpty() && !isSelected) {
                color.copy(alpha = 0.35f)
            } else {
                color
            }

            drawRoundRect(
                color = barColor,
                topLeft = Offset(left, topY),
                size = Size(barWidth, height),
                cornerRadius = corner,
            )

            if (isSelected && !singleUnstackedSeries) {
                val prev = activeBarBounds[key]
                activeBarBounds[key] = if (prev == null) {
                    topY to bottomY
                } else {
                    min(prev.first, topY) to max(prev.second, bottomY)
                }
            }
        }
    }

    activeBarBounds.forEach { (key, bounds) ->
        val (slot, x) = key
        val offsetFromCenter = -totalGroupWidth / 2f + slot * (barWidth + gapPx)
        val left = xOf(x) + offsetFromCenter
        val pad = 2.dp.toPx()
        drawRoundRect(
            color = inkColor,
            topLeft = Offset(left - pad, bounds.first - pad),
            size = Size(barWidth + pad * 2f, (bounds.second - bounds.first) + pad * 2f),
            cornerRadius = CornerRadius(6.dp.toPx(), 6.dp.toPx()),
            style = Stroke(width = 2.dp.toPx()),
        )
    }
}

private fun DrawScope.drawAreaAndLineSeries(
    seriesList: List<RoomChartSeries>,
    seriesColors: List<Color>,
    domain: ChartDomain,
    xOf: (Double) -> Float,
    yOf: (Double) -> Float,
) {
    val baselineY = yOf(0.0.coerceIn(domain.yMin, domain.yMax))
    val strokeWidth = 2.25.dp.toPx()

    seriesList.forEachIndexed { idx, series ->
        if (series.mark != RoomChartMark.ROOM_CHART_MARK_AREA && series.mark != RoomChartMark.ROOM_CHART_MARK_LINE) {
            return@forEachIndexed
        }
        val pts = series.points.sortedBy { it.x }
        if (pts.isEmpty()) return@forEachIndexed
        val color = seriesColors[idx]

        if (pts.size == 1) {
            val pt = pts.first()
            drawCircle(color = color, radius = 4.dp.toPx(), center = Offset(xOf(pt.x), yOf(pt.y)))
            return@forEachIndexed
        }

        val linePath = Path().apply {
            moveTo(xOf(pts.first().x), yOf(pts.first().y))
            for (i in 1 until pts.size) {
                lineTo(xOf(pts[i].x), yOf(pts[i].y))
            }
        }

        if (series.mark == RoomChartMark.ROOM_CHART_MARK_AREA) {
            val areaPath = Path().apply {
                addPath(linePath)
                lineTo(xOf(pts.last().x), baselineY)
                lineTo(xOf(pts.first().x), baselineY)
                close()
            }
            drawPath(
                path = areaPath,
                brush = Brush.verticalGradient(
                    colors = listOf(color.copy(alpha = 0.28f), color.copy(alpha = 0.03f)),
                    startY = 0f,
                    endY = size.height,
                ),
            )
        }

        drawPath(
            path = linePath,
            color = color,
            style = Stroke(
                width = strokeWidth,
                cap = StrokeCap.Round,
                join = StrokeJoin.Round,
            ),
        )
    }
}

private fun DrawScope.drawPointSeries(
    seriesList: List<RoomChartSeries>,
    seriesColors: List<Color>,
    cardColor: Color,
    xOf: (Double) -> Float,
    yOf: (Double) -> Float,
) {
    val radius = 4.dp.toPx()
    val halo = 5.5.dp.toPx()
    seriesList.forEachIndexed { idx, series ->
        if (series.mark != RoomChartMark.ROOM_CHART_MARK_POINT) return@forEachIndexed
        val color = seriesColors[idx]
        series.points.forEach { pt ->
            val center = Offset(xOf(pt.x), yOf(pt.y))
            drawCircle(color = cardColor, radius = halo, center = center)
            drawCircle(color = color, radius = radius, center = center)
        }
    }
}

private fun computeDomain(chart: RoomChart): ChartDomain {
    val xs = mutableListOf<Double>()
    val ys = mutableListOf<Double>()
    var hasBars = false
    var anchorsZero = false

    val stackedPos = mutableMapOf<Pair<String, Double>, Double>()
    val stackedNeg = mutableMapOf<Pair<String, Double>, Double>()

    chart.series.forEach { series ->
        if (series.mark == RoomChartMark.ROOM_CHART_MARK_BAR) {
            hasBars = true
            anchorsZero = true
        }
        if (series.mark == RoomChartMark.ROOM_CHART_MARK_AREA) {
            anchorsZero = true
        }
        series.points.forEach { pt ->
            xs.add(pt.x)
            if (series.mark == RoomChartMark.ROOM_CHART_MARK_BAR && series.stack.isNotEmpty()) {
                val key = series.stack to pt.x
                if (pt.y >= 0.0) {
                    val sum = (stackedPos[key] ?: 0.0) + pt.y
                    stackedPos[key] = sum
                    ys.add(sum)
                } else {
                    val sum = (stackedNeg[key] ?: 0.0) + pt.y
                    stackedNeg[key] = sum
                    ys.add(sum)
                }
            } else {
                ys.add(pt.y)
            }
            if (pt.y_high > pt.y_low) {
                ys.add(pt.y_low)
                ys.add(pt.y_high)
            }
        }
    }
    chart.x_ticks.forEach { xs.add(it.at) }
    chart.y_ticks.forEach { ys.add(it.at) }
    chart.rules.forEach { ys.add(it.at) }
    if (anchorsZero) ys.add(0.0)

    var xMin = xs.minOrNull() ?: 0.0
    var xMax = xs.maxOrNull() ?: 1.0
    val sortedDistinctX = xs.distinct().sorted()
    val xStep = if (sortedDistinctX.size >= 2) {
        (1 until sortedDistinctX.size).minOf { sortedDistinctX[it] - sortedDistinctX[it - 1] }
    } else {
        1.0
    }
    if (xMin == xMax) {
        xMin -= 0.5
        xMax += 0.5
    }

    var yMin = ys.minOrNull() ?: 0.0
    var yMax = ys.maxOrNull() ?: 1.0
    if (yMin == yMax) {
        if (yMax > 0.0) {
            yMin = 0.0
            yMax *= 1.15
        } else {
            yMin -= 1.0
            yMax += 1.0
        }
    } else if (chart.y_ticks.isEmpty()) {
        val pad = (yMax - yMin) * 0.08
        yMax += pad
        if (!anchorsZero || yMin < 0.0) {
            yMin -= pad
        }
    }

    return ChartDomain(
        xMin = xMin,
        xMax = xMax,
        yMin = yMin,
        yMax = yMax,
        hasBars = hasBars,
        xStep = xStep,
    )
}

private fun findActivePoint(chart: RoomChart, pointId: String): ActivePointHit? {
    if (pointId.isEmpty()) return null
    val stackedPos = mutableMapOf<Pair<String, Double>, Double>()
    val stackedNeg = mutableMapOf<Pair<String, Double>, Double>()
    chart.series.forEachIndexed { idx, series ->
        series.points.forEach { pt ->
            val yDisp = if (series.mark == RoomChartMark.ROOM_CHART_MARK_BAR && series.stack.isNotEmpty()) {
                val key = series.stack to pt.x
                if (pt.y >= 0.0) {
                    val sum = (stackedPos[key] ?: 0.0) + pt.y
                    stackedPos[key] = sum
                    sum
                } else {
                    val sum = (stackedNeg[key] ?: 0.0) + pt.y
                    stackedNeg[key] = sum
                    sum
                }
            } else {
                pt.y
            }
            if (pt.id == pointId) {
                return ActivePointHit(seriesIndex = idx, point = pt, yDisplay = yDisp)
            }
        }
    }
    return null
}

private fun findNearestPoint(
    chart: RoomChart,
    domain: ChartDomain,
    touchX: Float,
    touchY: Float,
    widthPx: Float,
    heightPx: Float,
    insetPx: Float,
    vPadPx: Float,
): String? {
    val usableW = (widthPx - insetPx * 2f).coerceAtLeast(1f)
    val usableH = (heightPx - vPadPx * 2f).coerceAtLeast(1f)
    var bestId: String? = null
    var bestDx = Float.MAX_VALUE
    var bestDy = Float.MAX_VALUE

    chart.series.forEach { series ->
        series.points.forEach { pt ->
            if (pt.id.isEmpty()) return@forEach
            val px = insetPx + domain.xFraction(pt.x) * usableW
            val py = vPadPx + (1f - domain.yFraction(pt.y)) * usableH
            val dx = abs(px - touchX)
            val dy = abs(py - touchY)
            if (dx < bestDx - 1f || (abs(dx - bestDx) <= 1f && dy < bestDy)) {
                bestDx = dx
                bestDy = dy
                bestId = pt.id
            }
        }
    }
    return bestId
}

private fun formatReadoutLabel(point: RoomChartPoint): String = when {
    point.x_label.isNotEmpty() && point.y_label.isNotEmpty() -> "${point.x_label} · ${point.y_label}"
    point.y_label.isNotEmpty() -> point.y_label
    else -> point.x_label
}

@Composable
private fun resolveRuleColor(tone: RoomTone): Color = when (tone) {
    RoomTone.ROOM_TONE_ACCENT -> appAccent().text
    RoomTone.ROOM_TONE_WARNING, RoomTone.ROOM_TONE_SEAM -> StateColor.Amber.text
    RoomTone.ROOM_TONE_NET -> StateColor.Green.text
    else -> Surface.meta
}

@Composable
private fun resolveSeriesColor(hueKey: String, index: Int): Color = when (hueKey.lowercase()) {
    "blue" -> centraidResource(R.color.centraid_list_blue)
    "graphite" -> centraidResource(R.color.centraid_list_graphite)
    "indigo" -> centraidResource(R.color.centraid_list_indigo)
    "mustard" -> centraidResource(R.color.centraid_list_mustard)
    "orchid" -> centraidResource(R.color.centraid_list_orchid)
    "petrol" -> centraidResource(R.color.centraid_list_petrol)
    "raspberry" -> centraidResource(R.color.centraid_list_raspberry)
    "violet" -> centraidResource(R.color.centraid_list_violet)
    "calendar" -> appAccent("calendar").fill
    "docs" -> appAccent("docs").fill
    "health" -> appAccent("health").fill
    "locker" -> appAccent("locker").fill
    "money" -> appAccent("money").fill
    "notes" -> appAccent("notes").fill
    "people" -> appAccent("people").fill
    "photos" -> appAccent("photos").fill
    "reminders" -> appAccent("reminders").fill
    "green", "income" -> StateColor.Green.fill
    "red", "expense", "net" -> StateColor.Red.fill
    "amber", "warning" -> StateColor.Amber.fill
    else -> when (index % 6) {
        0 -> appAccent().fill
        1 -> centraidResource(R.color.centraid_list_petrol)
        2 -> centraidResource(R.color.centraid_list_blue)
        3 -> centraidResource(R.color.centraid_list_mustard)
        4 -> centraidResource(R.color.centraid_list_violet)
        else -> centraidResource(R.color.centraid_list_graphite)
    }
}
