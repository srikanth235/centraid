package dev.centraid.android.screens.health

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import centraid.screen.v1.HealthChartBar
import centraid.screen.v1.HealthConnectState
import centraid.screen.v1.HealthFigure
import centraid.screen.v1.HealthMetricLine
import centraid.screen.v1.HealthRangeBar
import centraid.screen.v1.HealthTrendRow
import centraid.screen.v1.HealthWorkoutLine
import centraid.screen.v1.SectionHead
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/*
 * HEALTH'S SHARED DRAWING PARTS (#1129). Every word, figure and position is the state's: the
 * machines in `shared/.../apps/health` finished them, and a bar's length or a point's height
 * arrives in basis points of its own span. A part draws, and decides nothing — not a unit, not a
 * comparison, not which bar is today's. The identity hue (olive, R-1129-10) is drawn in exactly
 * one place here: the chart bar the state marks `current`.
 */

/** A quiet sentence in the gutter. Empty is nothing. */
@Composable
internal fun HealthNote(text: String, ink: String = "textSoft", style: String = "annotLabel") {
    if (text.isEmpty()) return
    Text(
        text,
        style = centraidType(style),
        color = centraidColor(ink),
        modifier = Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp),
    )
}

/** A section label with the kit's header. Empty is nothing. */
@Composable
internal fun HealthSection(title: String) {
    if (title.isNotEmpty()) SectionHeader(SectionHead(title = title))
}

/** A value and its unit, baseline to baseline: "8,412" "steps". */
@Composable
internal fun HealthValue(value: String, unit: String, style: String) {
    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(value, style = centraidType(style), color = centraidColor("text"))
        if (unit.isNotEmpty()) {
            Text(unit, style = centraidType("body"), color = centraidColor("textSoft"), modifier = Modifier.padding(bottom = 2.dp))
        }
    }
}

/**
 * WHERE A DAY SITS IN THE MEMBER'S USUAL RANGE (R-1129-8): the track, the 25th–75th band, and the
 * day's dot when there is a figure. The hero's bar carries its three labels under it.
 */
@Composable
internal fun HealthRangeBarView(bar: HealthRangeBar, thickness: Dp, dot: Dp) {
    val radius = RoundedCornerShape(thickness / 2)
    Column(Modifier.fillMaxWidth().padding(top = 10.dp)) {
        BoxWithConstraints(Modifier.fillMaxWidth().height(dot), contentAlignment = Alignment.CenterStart) {
            val width = maxWidth
            Box(Modifier.fillMaxWidth().height(thickness).clip(radius).background(centraidColor("bgSunken")))
            val low = fraction(bar.low_bp)
            val high = fraction(bar.high_bp)
            Box(
                Modifier
                    .offset(x = width * low)
                    .width(width * (high - low).coerceAtLeast(0f))
                    .height(thickness)
                    .clip(radius)
                    .background(centraidColor("lineStrong")),
            )
            if (bar.has_value) {
                Box(
                    Modifier
                        .offset(x = (width * fraction(bar.value_bp) - dot / 2).coerceIn(0.dp, width - dot))
                        .size(dot)
                        .clip(CircleShape)
                        .background(centraidColor("text")),
                )
            }
        }
        if (bar.start_label.isNotEmpty() || bar.middle_label.isNotEmpty() || bar.end_label.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                listOf(bar.start_label, bar.middle_label, bar.end_label).forEach {
                    Text(it, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
                }
            }
        }
    }
}

/** TODAY'S HERO: the steps, large, with when they count from and the typical day's bar. */
@Composable
internal fun HealthHero(line: HealthMetricLine, onTap: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onTap)
            .padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp)
            .testTag("health-hero")
            .clearAndSetSemantics {
                contentDescription = line.accessibility_label
                role = Role.Button
            },
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(line.label, style = centraidType("smallStrong"), color = centraidColor("textSoft"))
            Text(line.when_label, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
        }
        HealthValue(line.value_, line.unit, "display")
        if (line.typical.isNotEmpty()) Text(line.typical, style = centraidType("body"), color = centraidColor("textSoft"))
        line.bar?.let { HealthRangeBarView(it, thickness = 8.dp, dot = 14.dp) }
    }
}

/** ONE METRIC AGAINST ITS TYPICAL: name and figure, when and typical, and the range bar. */
@Composable
internal fun HealthMetricRow(line: HealthMetricLine, onTap: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .clickable(onClick = onTap)
            .padding(horizontal = KitGeometry.GUTTER, vertical = 10.dp)
            .testTag("health-metric-${line.metric}")
            .clearAndSetSemantics {
                contentDescription = line.accessibility_label
                role = Role.Button
            },
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
            Text(line.label, style = centraidType("smallStrong"), color = centraidColor("text"), modifier = Modifier.weight(1f))
            HealthValue(line.value_, line.unit, "smallStrong")
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(line.when_label, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
            Text(line.typical, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
        }
        line.bar?.let { HealthRangeBarView(it, thickness = 4.dp, dot = 10.dp) }
    }
}

/** ONE WORKOUT IN A LIST: its kind's glyph, title, figures, and when. */
@Composable
internal fun HealthWorkoutRow(line: HealthWorkoutLine, onTap: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .clickable(onClick = onTap)
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
            .testTag("health-workout-${line.activity_id}")
            .clearAndSetSemantics {
                contentDescription = line.accessibility_label.ifEmpty { line.title }
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(centraidColor("bgSunken")), contentAlignment = Alignment.Center) {
            if (line.icon_key.isNotEmpty()) CentraidIcon(iconKey = line.icon_key, tint = centraidColor("textSoft"), size = 18.dp)
        }
        Column(Modifier.weight(1f)) {
            Text(line.title, style = centraidType("smallStrong"), color = centraidColor("text"))
            if (line.meta.isNotEmpty()) Text(line.meta, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
        }
        Text(line.when_label, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
    }
}

/** ONE TREND: name, the period's figure and its change, and the sparkline with its average. */
@Composable
internal fun HealthTrendRowView(row: HealthTrendRow, onTap: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .clickable(onClick = onTap)
            .padding(horizontal = KitGeometry.GUTTER, vertical = 10.dp)
            .testTag("health-trend-${row.metric}")
            .clearAndSetSemantics {
                contentDescription = row.accessibility_label
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(row.label, style = centraidType("smallStrong"), color = centraidColor("text"))
            HealthValue(row.value_, row.unit, "body")
            if (row.delta.isNotEmpty()) Text(row.delta, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
        }
        Sparkline(row.points_bp, row.average_bp, Modifier.width(120.dp).height(44.dp))
    }
}

/** Points oldest first in basis points of the row's span; -1 is a gap, never a zero. */
@Composable
private fun Sparkline(points: List<Int>, averageBp: Int, modifier: Modifier) {
    val ink = centraidColor("textSoft")
    val mark = centraidColor("text")
    val rule = centraidColor("line")
    Canvas(modifier) {
        if (points.isEmpty()) return@Canvas
        val step = if (points.size > 1) size.width / (points.size - 1) else 0f
        fun at(index: Int, bp: Int) = Offset(step * index, size.height * (1f - bp.coerceIn(0, BP) / BP.toFloat()))
        if (averageBp >= 0) {
            val y = at(0, averageBp).y
            drawLine(rule, Offset(0f, y), Offset(size.width, y), strokeWidth = 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4f, 4f)))
        }
        points.forEachIndexed { index, bp ->
            val next = points.getOrNull(index + 1)
            if (bp >= 0 && next != null && next >= 0) drawLine(ink, at(index, bp), at(index + 1, next), strokeWidth = 1.5.dp.toPx())
        }
        val last = points.indexOfLast { it >= 0 }
        if (last >= 0) drawCircle(mark, radius = 3.dp.toPx(), center = at(last, points[last]))
    }
}

/**
 * ONE METRIC'S CHART: a bar a bucket, the typical line across it, the ticks under it. The bucket
 * today falls in is the one mark in Health's hue; above-typical bars are the stronger ink.
 */
@Composable
internal fun HealthChart(bars: List<HealthChartBar>, hasTypical: Boolean, typicalBp: Int, typicalLabel: String, ticks: List<String>, spoken: String) {
    val radius = RoundedCornerShape((LocalCentraidTokens.current.radii["sm"] ?: 0).dp)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp)
            .testTag("health-chart")
            .clearAndSetSemantics { contentDescription = spoken },
    ) {
        BoxWithConstraints(Modifier.fillMaxWidth().height(CHART_HEIGHT)) {
            val height = maxHeight
            Row(Modifier.fillMaxWidth().fillMaxHeight(), horizontalArrangement = Arrangement.spacedBy(if (bars.size > 14) 2.dp else 6.dp)) {
                bars.forEach { bar ->
                    Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.BottomCenter) {
                        if (bar.has_value) {
                            Box(
                                Modifier
                                    .fillMaxWidth()
                                    .height(height * fraction(bar.height_bp))
                                    .clip(radius)
                                    .background(
                                        centraidColor(
                                            when {
                                                bar.current -> "cOlive"
                                                bar.above_typical -> "textFaint"
                                                else -> "lineStrong"
                                            },
                                        ),
                                    ),
                            )
                        }
                    }
                }
            }
            if (hasTypical) {
                val y = height * (1f - fraction(typicalBp))
                Box(Modifier.fillMaxWidth().offset(y = y).height(1.dp).background(centraidColor("text")))
                if (typicalLabel.isNotEmpty()) {
                    Text(
                        typicalLabel,
                        style = centraidType("annotLabel"),
                        color = centraidColor("textSoft"),
                        modifier = Modifier.align(Alignment.TopEnd).offset(y = (y - 16.dp).coerceAtLeast(0.dp)),
                    )
                }
            }
        }
        if (ticks.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                ticks.forEach { Text(it, style = centraidType("annotLabel"), color = centraidColor("textSoft")) }
            }
        }
    }
}

/** A WORKOUT'S FIGURES, two to a row: the label over the value and its unit. */
@Composable
internal fun HealthFigures(figures: List<HealthFigure>) {
    Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        figures.chunked(2).forEach { pair ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                pair.forEach { figure ->
                    Column(
                        Modifier
                            .weight(1f)
                            .clearAndSetSemantics { contentDescription = listOf(figure.label, figure.value_, figure.unit).filter { it.isNotEmpty() }.joinToString(" ") },
                    ) {
                        Text(figure.label, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
                        HealthValue(figure.value_, figure.unit, "title")
                    }
                }
                if (pair.size == 1) Box(Modifier.weight(1f))
            }
        }
    }
}

/**
 * WHAT HEALTH MAY READ, AS A LIST: the lede and each type with its detail, no switches. Health
 * Connect's rationale page draws this ([HealthRationaleActivity]).
 */
@Composable
internal fun HealthReads(state: HealthConnectState) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).testTag("health-reads")) {
        HealthNote(state.lede, ink = "text", style = "body")
        state.choices.forEach { choice ->
            CentraidRow(title = choice.label, meta = choice.detail, testTag = "health-reads-${choice.key}")
        }
    }
}

private fun fraction(bp: Int): Float = bp.coerceIn(0, BP) / BP.toFloat()

private const val BP: Int = 10_000
private val CHART_HEIGHT: Dp = 160.dp
