package dev.centraid.android.screens.health

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import centraid.core.v1.HealthChartBar
import centraid.core.v1.HealthFigure
import centraid.core.v1.HealthHighlight
import centraid.core.v1.HealthMetricData
import centraid.core.v1.HealthMetricLine
import centraid.core.v1.HealthTrendRow
import centraid.core.v1.HealthWorkoutLine
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.kitCard
import dev.centraid.android.kit.kitTextStyle
import dev.centraid.android.theme.LocalCentraidTokens

/*
 * HEALTH'S SHARED DRAWING PARTS (#1129, #1135, #1173). Every word, figure and position is the
 * state's: Rust (`crates/screens/src/health`) finished them, and a bar's length or a point's height
 * arrives in basis points of its own span. A part draws, and decides nothing, not a unit, not a
 * comparison, not which bar is today's. INSIDE HEALTH EVERY METRIC WEARS THE HEALTH COLOUR
 * (`appAccent("health")`): a heart rate is not red and exercise is not green, because red and
 * green mean a state. The one green line is the one the core marks `good`.
 */

/** A quiet sentence in the gutter. Empty is nothing. */
@Composable
internal fun HealthNote(text: String) {
    if (text.isEmpty()) return
    KitText(
        text,
        KitType.Meta,
        Surface.meta,
        Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp),
    )
}

/** A section heading in the kit's section rung. Empty is nothing. */
@Composable
internal fun HealthSection(title: String, note: String = "") {
    if (title.isEmpty()) return
    Row(
        Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER + 4.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        KitText(title, KitType.Section, Surface.ink, Modifier.weight(1f))
        if (note.isNotEmpty()) KitText(note, KitType.Meta, Surface.meta)
    }
}

/** A figure and its unit, baseline to baseline. */
@Composable
private fun HealthFigureText(value: String, unit: String, size: Int, unitColor: Color = Surface.meta) {
    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(value, style = kitTextStyle(KitType.Row).copy(fontSize = size.sp, fontWeight = FontWeight.Bold), color = Surface.ink)
        if (unit.isNotEmpty()) KitText(unit, KitType.Meta, unitColor, Modifier.padding(bottom = 2.dp))
    }
}

/** Seven days as bars: today's the Health colour, the rest its pale tint; a gap (-1) draws no bar. */
@Composable
private fun HealthSparkBars(points: List<Int>, spoken: String) {
    val accent = appAccent("health")
    Row(
        Modifier.height(40.dp).clearAndSetSemantics { contentDescription = spoken },
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        points.forEachIndexed { index, point ->
            if (point < 0) {
                Spacer(Modifier.width(7.dp))
            } else {
                Box(
                    Modifier
                        .width(7.dp)
                        .height((40 * fraction(point)).dp.coerceAtLeast(3.dp))
                        .clip(CircleShape)
                        .background(if (index == points.lastIndex) accent.fill else accent.fill.copy(alpha = 0.25f)),
                )
            }
        }
    }
}

/**
 * ONE PINNED METRIC: its mark and name in the Health colour, the figure, and the typical under it.
 * A wide card carries when and the sparkline; the rest sit two to a row. The whole card opens the
 * metric's page.
 */
@Composable
internal fun HealthPinnedCard(line: HealthMetricLine, tag: String, onTap: () -> Unit) {
    val accent = appAccent("health")
    Column(
        Modifier
            .fillMaxWidth()
            .kitCard()
            .clickable(onClick = onTap)
            .padding(horizontal = 14.dp, vertical = 12.dp)
            .testTag(tag)
            .clearAndSetSemantics {
                contentDescription = line.accessibility_label
                role = Role.Button
            },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            CentraidIcon(iconKey = line.icon_key, tint = accent.text, size = if (line.wide) 16.dp else 14.dp)
            KitText(line.label, KitType.Meta, accent.text, Modifier.weight(1f), maxLines = 1)
            if (line.wide) KitText(line.when_label, KitType.Meta, Surface.meta)
        }
        if (line.wide) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    HealthFigureText(line.value_, line.unit, 28)
                    if (line.typical.isNotEmpty()) {
                        KitText(line.typical, KitType.Meta, if (line.good) StateColor.Green.text else Surface.meta)
                    }
                }
                HealthSparkBars(line.spark_bp, line.spark_label)
            }
        } else {
            HealthFigureText(line.value_, line.unit, 22)
            KitText(line.typical.ifEmpty { line.when_label }, KitType.Meta, Surface.meta)
        }
    }
}

/** ONE HIGHLIGHT: the Health colour's mark in a pale chip and the sentence, its middle in bold. */
@Composable
internal fun HealthHighlightCard(highlight: HealthHighlight, onTap: () -> Unit) {
    val accent = appAccent("health")
    val sentence = buildAnnotatedString {
        append(highlight.lead)
        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(highlight.emphasis) }
        append(highlight.tail)
    }
    Row(
        Modifier
            .fillMaxWidth()
            .kitCard()
            .clickable(onClick = onTap)
            .padding(horizontal = 14.dp, vertical = 12.dp)
            .testTag("health-highlight-${highlight.metric}")
            .clearAndSetSemantics {
                contentDescription = highlight.accessibility_label
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.size(32.dp).clip(CircleShape).background(accent.wash(false)), contentAlignment = Alignment.Center) {
            CentraidIcon(iconKey = "BarChart2", tint = accent.text, size = 16.dp)
        }
        Text(sentence, style = kitTextStyle(KitType.Row), color = Surface.ink, modifier = Modifier.weight(1f))
    }
}

/** ONE WORKOUT IN A LIST: its kind's glyph in the Health colour, title, figures, and when. */
@Composable
internal fun HealthWorkoutRow(line: HealthWorkoutLine, onTap: () -> Unit) {
    val accent = appAccent("health")
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
        Box(Modifier.size(40.dp).clip(CircleShape).background(accent.wash(false)), contentAlignment = Alignment.Center) {
            if (line.icon_key.isNotEmpty()) CentraidIcon(iconKey = line.icon_key, tint = accent.text, size = 18.dp)
        }
        Column(Modifier.weight(1f)) {
            KitText(line.title, KitType.Row, Surface.ink, maxLines = 1)
            if (line.meta.isNotEmpty()) KitText(line.meta, KitType.Meta, Surface.meta, maxLines = 1)
        }
        KitText(line.when_label, KitType.Meta, Surface.meta)
    }
}

/** ONE TREND: name, the period's figure and its change, and the sparkline with its average. */
@Composable
internal fun HealthTrendRowView(row: HealthTrendRow, onTap: () -> Unit) {
    val accent = appAccent("health")
    Row(
        Modifier
            .fillMaxWidth()
            .kitCard()
            .clickable(onClick = onTap)
            .padding(horizontal = 14.dp, vertical = 12.dp)
            .testTag("health-trend-${row.metric}")
            .clearAndSetSemantics {
                contentDescription = row.accessibility_label
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            KitText(row.label, KitType.Row, accent.text)
            HealthFigureText(row.value_, row.unit, 22)
            if (row.delta.isNotEmpty()) KitText(row.delta, KitType.Meta, Surface.meta)
        }
        Sparkline(row.points_bp, row.average_bp, Modifier.width(120.dp).height(44.dp))
    }
}

/** Points oldest first in basis points of the row's span; -1 is a gap, never a zero. */
@Composable
private fun Sparkline(points: List<Int>, averageBp: Int, modifier: Modifier) {
    val accent = appAccent("health")
    val rule = Surface.border
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
            if (bp >= 0 && next != null && next >= 0) drawLine(accent.text, at(index, bp), at(index + 1, next), strokeWidth = 2.dp.toPx())
        }
        val last = points.indexOfLast { it >= 0 }
        if (last >= 0) drawCircle(accent.fill, radius = 3.dp.toPx(), center = at(last, points[last]))
    }
}

/**
 * ONE METRIC'S CHART: a bar a bucket, the typical line (and the usual range as a pale band) across
 * it, the ticks under it. THE CURRENT BUCKET, AND THE BAR UNDER A FINGER, WEAR THE HEALTH COLOUR;
 * the rest are its pale tint. The finger's place is the chart's own state (a drag is never an event
 * a frame); the bar under it shows the core's callout.
 */
@Composable
internal fun HealthChart(data: HealthMetricData) {
    val accent = appAccent("health")
    val bars: List<HealthChartBar> = data.bars
    var scrubbed by remember(bars.size) { mutableStateOf<Int?>(null) }
    val radius = RoundedCornerShape((LocalCentraidTokens.current.radii["sm"] ?: 0).dp)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp)
            .testTag("health-metric-chart")
            .clearAndSetSemantics { contentDescription = data.chart_label },
    ) {
        BoxWithConstraints(
            Modifier
                .fillMaxWidth()
                .height(CHART_HEIGHT)
                .pointerInput(bars.size) {
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        val slot = size.width / bars.size.coerceAtLeast(1).toFloat()
                        fun indexOf(x: Float) = (x / slot).toInt().coerceIn(0, (bars.size - 1).coerceAtLeast(0))
                        scrubbed = indexOf(down.position.x)
                        do {
                            val event = awaitPointerEvent()
                            event.changes.firstOrNull()?.let { scrubbed = indexOf(it.position.x) }
                        } while (event.changes.any { it.pressed })
                        scrubbed = null
                    }
                },
        ) {
            val height = maxHeight
            val width = maxWidth
            if (data.has_typical_range) {
                val top = height * (1f - fraction(data.typical_high_bp))
                val bottom = height * (1f - fraction(data.typical_low_bp))
                Box(
                    Modifier
                        .fillMaxWidth()
                        .offset(y = top)
                        .height((bottom - top).coerceAtLeast(2.dp))
                        .background(accent.fill.copy(alpha = 0.08f)),
                )
            }
            Row(Modifier.fillMaxWidth().fillMaxHeight(), horizontalArrangement = Arrangement.spacedBy(if (bars.size > 14) 3.dp else 8.dp)) {
                bars.forEachIndexed { index, bar ->
                    Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.BottomCenter) {
                        if (bar.has_value) {
                            val lit = bar.current || scrubbed == index
                            Box(
                                Modifier
                                    .fillMaxWidth()
                                    .height((height * fraction(bar.height_bp)).coerceAtLeast(2.dp))
                                    .clip(radius)
                                    .background(if (lit) accent.fill else accent.fill.copy(alpha = 0.28f)),
                            )
                        }
                    }
                }
            }
            if (data.has_typical) {
                val y = height * (1f - fraction(data.typical_bp))
                Box(Modifier.fillMaxWidth().offset(y = y).height(1.5.dp).background(accent.text))
                if (data.typical_label.isNotEmpty()) {
                    KitText(
                        data.typical_label,
                        KitType.Meta,
                        accent.text,
                        Modifier.align(Alignment.TopEnd).offset(y = (y - 18.dp).coerceAtLeast(0.dp)),
                    )
                }
            }
            val index = scrubbed
            if (index != null && index in bars.indices && bars[index].callout.isNotEmpty()) {
                val slot = width / bars.size
                val barTop = height * (1f - fraction(bars[index].height_bp))
                val centre = slot * (index + 0.5f)
                Text(
                    bars[index].callout,
                    style = kitTextStyle(KitType.Meta).copy(fontWeight = FontWeight.SemiBold),
                    color = Color.White,
                    softWrap = false,
                    modifier = Modifier
                        .offset(x = (centre - 70.dp).coerceIn(0.dp, (width - 140.dp).coerceAtLeast(0.dp)), y = (barTop - 30.dp).coerceAtLeast(0.dp))
                        .clip(CircleShape)
                        .background(Surface.ink.copy(alpha = 0.92f))
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                )
            }
        }
        if (data.ticks.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                data.ticks.forEach { KitText(it, KitType.Meta, Surface.meta, maxLines = 1) }
            }
        }
    }
}

/** ONE FACT: a label and its figure on one line, in a bordered card's rows. */
@Composable
internal fun HealthFactRow(label: String, detail: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .clearAndSetSemantics { contentDescription = "$label, $detail" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KitText(label, KitType.Row, Surface.ink, Modifier.weight(1f))
        KitText(detail, KitType.Row, Surface.meta)
    }
}

/** A WORKOUT'S FIGURE: the label over the value and its unit, in a card. */
@Composable
internal fun HealthFigureCard(figure: HealthFigure) {
    Column(
        Modifier
            .fillMaxWidth()
            .kitCard()
            .padding(14.dp)
            .clearAndSetSemantics { contentDescription = listOf(figure.label, figure.value_, figure.unit).filter { it.isNotEmpty() }.joinToString(" ") },
    ) {
        KitText(figure.label, KitType.Meta, Surface.meta)
        HealthFigureText(figure.value_, figure.unit, 28)
    }
}

private fun fraction(bp: Int): Float = bp.coerceIn(0, BP) / BP.toFloat()

private const val BP: Int = 10_000
private val CHART_HEIGHT: Dp = 200.dp
