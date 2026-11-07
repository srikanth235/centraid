package dev.centraid.android.screens.money

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import centraid.core.v1.MoneyBar
import centraid.core.v1.MoneyBars
import centraid.core.v1.MoneyCategoryLine
import centraid.core.v1.MoneyDaySection
import centraid.core.v1.MoneyHero
import centraid.core.v1.MoneyInOutNet
import centraid.core.v1.MoneyRestLine
import centraid.core.v1.MoneyRow
import centraid.core.v1.StatusChip
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.StatusChipView
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.kitCard
import dev.centraid.android.screens.docs.docsListColor
import dev.centraid.android.theme.centraidDark
import dev.centraid.design.CentraidGeometry
import dev.centraid.design.CentraidScale

/*
 * MONEY'S CARDS (#1173): the pieces Activity and Spending are drawn from, on the kit. The state
 * carries every word, figure, colour key and length (as basis points); nothing here computes a
 * figure or spells a sentence. A list colour is a key of the one palette (`color_key`, set by
 * Rust). The SwiftUI twin is `MoneyCards.swift`.
 */

/**
 * The ink a figure is drawn in: money in is the state green, a state tone its state colour,
 * otherwise plain ink. Money out is ink, never red.
 */
@Composable
internal fun moneyInk(positive: Boolean, tone: StatusChip.Tone): Color = when {
    positive -> StateColor.Green.text
    tone == StatusChip.Tone.TONE_NET -> StateColor.Red.text
    tone == StatusChip.Tone.TONE_SEAM || tone == StatusChip.Tone.TONE_WARNING -> Surface.meta
    else -> Surface.ink
}

/** A white card on a card page, its rows laid out with no gaps between. */
@Composable
internal fun MoneyCardStack(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Column(modifier.fillMaxWidth().kitCard()) { content() }
}

// --- The month's overview card -------------------------------------------------------------

/** SPENT AND LEFT AGAINST THE TARGET, then In, Out and Net, in one card. */
@Composable
internal fun MoneyOverviewCard(hero: MoneyHero, daysLeft: String, inOut: MoneyInOutNet?) {
    Column(Modifier.fillMaxWidth().kitCard().padding(16.dp)) {
        Column(
            Modifier.semantics(mergeDescendants = true) {}.testTag("money-hero"),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            KitText(hero.spent_label, KitType.Meta, Surface.meta)
            KitText(hero.spent, KitType.Title, if (hero.over) StateColor.Red.text else Surface.ink, maxLines = 1)
            if (hero.has_bar) {
                MoneyPlanBar(hero.fill_bp, hero.tick_bp, hero.over, hero.accessibility_label, Modifier.padding(top = 6.dp))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                KitText(
                    hero.figures.joinToString(" · ") { "${it.label} ${it.amount}" },
                    KitType.Meta,
                    Surface.body,
                    Modifier.weight(1f),
                    maxLines = 2,
                )
                KitText(daysLeft, KitType.Meta, Surface.meta, maxLines = 1)
            }
        }
        if (inOut != null && inOut.figures.isNotEmpty()) {
            Box(Modifier.padding(vertical = 12.dp)) { MoneyHairline(0.dp) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                inOut.figures.forEach { figure ->
                    Column(
                        Modifier.weight(1f).clearAndSetSemantics { contentDescription = spoken(figure.label, figure.amount) },
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        KitText(figure.label, KitType.Meta, Surface.meta)
                        KitText(figure.amount, KitType.Row, moneyInk(figure.positive, figure.tone), maxLines = 1)
                    }
                }
            }
        }
    }
}

/** A plan bar from the state's basis points: the fill in the app's colour (red over plan), a tick for the day. */
@Composable
internal fun MoneyPlanBar(fillBp: Int, tickBp: Int, over: Boolean, spoken: String, modifier: Modifier = Modifier) {
    val fill = if (over) StateColor.Red.fill else appAccent().fill
    val track = Surface.fill
    val ink = Surface.ink
    Canvas(
        modifier.fillMaxWidth().height(10.dp).clearAndSetSemantics { contentDescription = spoken },
    ) {
        val radius = size.height / 2
        drawRoundRect(track, size = size, cornerRadius = androidx.compose.ui.geometry.CornerRadius(radius))
        val filled = size.width * fillBp.coerceIn(0, 10_000) / 10_000f
        if (filled > 0f) {
            drawRoundRect(fill, size = androidx.compose.ui.geometry.Size(filled, size.height), cornerRadius = androidx.compose.ui.geometry.CornerRadius(radius))
        }
        if (tickBp > 0) {
            val x = (size.width * tickBp.coerceIn(0, 10_000) / 10_000f).coerceAtMost(size.width - 2.dp.toPx())
            drawRect(ink, topLeft = Offset(x, 0f), size = androidx.compose.ui.geometry.Size(2.dp.toPx(), size.height))
        }
    }
}

// --- The review banner ---------------------------------------------------------------------

/** ROWS THAT NEED A CATEGORY: the count in its badge, the title, and the word that opens them. */
@Composable
internal fun MoneyReviewBanner(count: String, title: String, review: String, spokenLabel: String, onTap: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .clip(RoundedCornerShape(CentraidScale.cardRadius.dp))
            .background(StateColor.Amber.tint)
            .clickable(onClick = onTap)
            .padding(horizontal = 16.dp)
            .testTag("money-needs-category")
            .semantics(mergeDescendants = true) {
                contentDescription = spokenLabel
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier.size(26.dp).clip(CircleShape).background(StateColor.Amber.fill),
            contentAlignment = Alignment.Center,
        ) { KitText(count, KitType.Meta, Color.White, maxLines = 1) }
        KitText(title, KitType.Row, Surface.ink, Modifier.weight(1f), maxLines = 2)
        KitText(review, KitType.Row, StateColor.Amber.text, maxLines = 1)
    }
}

// --- Day groups and rows -------------------------------------------------------------------

/** A DAY'S HEADING AND WHAT IT CAME TO: "Today" and "-₹2,450" (money in is green). */
@Composable
internal fun MoneyDayHeading(section: MoneyDaySection) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 4.dp).padding(top = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KitText(
            section.heading,
            KitType.Row,
            Surface.ink,
            Modifier.weight(1f).semantics { heading() },
            maxLines = 1,
        )
        if (section.total.isNotEmpty()) {
            KitText(
                section.total,
                KitType.Meta,
                if (section.total_positive) StateColor.Green.text else Surface.meta,
                Modifier.semantics { contentDescription = spoken(section.heading, section.total) },
                maxLines = 1,
            )
        }
    }
}

/** THE TRANSACTION ROW: a tile, the name over its meta line, the signed amount and any badge. */
@Composable
internal fun MoneyTxnRow(row: MoneyRow, onTap: (() -> Unit)?) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .let { if (onTap != null) it.clickable(onClick = onTap) else it }
            .padding(horizontal = 16.dp, vertical = 10.dp)
            .testTag("money-row-${row.txn_id}")
            .semantics(mergeDescendants = true) {
                contentDescription = spoken(row.accessibility_label, row.amount)
                if (onTap != null) role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        MoneyTile(row)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            KitText(row.title, KitType.Row, if (row.dimmed) Surface.meta else Surface.ink, maxLines = 2)
            if (row.meta.isNotEmpty()) KitText(row.meta, KitType.Meta, Surface.meta, maxLines = 2)
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            KitText(
                row.amount,
                KitType.Row,
                moneyInk(row.positive, row.amount_tone),
                maxLines = 1,
            )
            if (row.category_label.isNotEmpty()) KitText(row.category_label, KitType.Meta, Surface.meta, maxLines = 1)
            row.chips.forEach { StatusChipView(it) }
        }
    }
}

/** The tile at a row's start: the category's colour as a pale ground with its first letter, a swap glyph for a transfer. */
@Composable
internal fun MoneyTile(row: MoneyRow) {
    val shape = RoundedCornerShape((36 * CentraidGeometry.ICON_CHIP_RADIUS_RATIO).dp)
    val ground = when {
        row.tile_icon.isNotEmpty() || row.color_key.isEmpty() -> Surface.fill
        else -> docsListColor(row.color_key).copy(alpha = (if (centraidDark()) CentraidGeometry.ICON_CHIP_TINT_DARK else CentraidGeometry.ICON_CHIP_TINT_LIGHT).toFloat())
    }
    Box(
        Modifier.size(36.dp).clip(shape).background(ground).clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        if (row.tile_icon.isNotEmpty()) {
            CentraidIcon(iconKey = row.tile_icon, tint = Surface.meta, size = 18.dp)
        } else {
            KitText(row.initial, KitType.Row, if (row.color_key.isEmpty()) Surface.body else Surface.ink, maxLines = 1)
        }
    }
}

// --- Spending ------------------------------------------------------------------------------

private val ChartHeight = 132.dp

/**
 * THE SPENDING CHART: stacked bars, one per week or day, each cut by category. The state gives
 * every height as basis points of the tallest bar (or of the plan's pace), every colour as a
 * list-palette key and the words under it; a tap picks a bar and the caption follows.
 */
@Composable
internal fun MoneyBarsChart(bars: MoneyBars, onPick: (Int) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.fillMaxWidth().height(ChartHeight + 22.dp)) {
            Row(
                Modifier.fillMaxWidth().fillMaxHeight(),
                horizontalArrangement = Arrangement.spacedBy(if (bars.bars.size > 8) 3.dp else 10.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                bars.bars.forEachIndexed { index, bar ->
                    BarColumn(index, bar, Modifier.weight(1f), onPick)
                }
            }
            if (bars.pace_bp > 0) {
                val paceInk = Surface.meta
                val paceLabel = bars.pace_label
                Column(
                    Modifier
                        .fillMaxWidth()
                        .offset(y = (ChartHeight - ChartHeight * bars.pace_bp / 10_000f) - 14.dp)
                        .clearAndSetSemantics { },
                ) {
                    KitText(paceLabel, KitType.Meta, paceInk, Modifier.fillMaxWidth().padding(start = 120.dp), maxLines = 1)
                    Canvas(Modifier.fillMaxWidth().height(1.dp)) {
                        drawLine(
                            paceInk,
                            Offset(0f, 0f),
                            Offset(size.width, 0f),
                            strokeWidth = 1.dp.toPx(),
                            pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 6.dp.toPx())),
                        )
                    }
                }
            }
        }
        if (bars.caption.isNotEmpty()) {
            KitText(bars.caption, KitType.Meta, Surface.body, Modifier.testTag("money-bars-caption"))
        }
    }
}

@Composable
private fun BarColumn(index: Int, bar: MoneyBar, modifier: Modifier, onPick: (Int) -> Unit) {
    val ink = Surface.ink
    val dash = Surface.border
    Column(
        modifier
            .clickable { onPick(index) }
            .testTag("money-bar-$index")
            .semantics(mergeDescendants = true) {
                contentDescription = bar.accessibility_label
                role = Role.Button
                selected = bar.selected
            },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.fillMaxWidth().height(ChartHeight), contentAlignment = Alignment.BottomCenter) {
            if (bar.upcoming) {
                val outline = ChartHeight * 0.34f
                Canvas(Modifier.fillMaxWidth().height(outline)) {
                    drawRoundRect(
                        dash,
                        cornerRadius = androidx.compose.ui.geometry.CornerRadius(6.dp.toPx()),
                        style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f))),
                    )
                }
            } else {
                val height = ChartHeight * bar.height_bp.coerceIn(0, 10_000) / 10_000f
                Column(Modifier.fillMaxWidth().height(height).clip(moneyRadius("sm"))) {
                    bar.segments.asReversed().forEach { segment ->
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .height(height * segment.share_bp.coerceIn(0, 10_000) / 10_000f)
                                .background(docsListColor(segment.color_key)),
                        )
                    }
                }
            }
            if (bar.selected) {
                val selectedHeight = if (bar.upcoming) ChartHeight * 0.34f else ChartHeight * bar.height_bp.coerceIn(0, 10_000) / 10_000f
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(selectedHeight.coerceAtLeast(8.dp) + 4.dp)
                        .border(BorderStroke(2.dp, ink), moneyRadius("md")),
                )
            }
        }
        KitText(
            bar.label,
            KitType.Meta,
            if (bar.selected) Surface.ink else Surface.meta,
            Modifier.height(16.dp),
            maxLines = 1,
        )
    }
}

/** ONE CATEGORY: its dot, what it spent, the bar of its plan and the sentence under it. */
@Composable
internal fun MoneyCategoryProgressRow(line: MoneyCategoryLine, onTap: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onTap)
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .testTag("money-category-${line.route?.money_target?.category_id}")
            .semantics(mergeDescendants = true) {
                contentDescription = line.accessibility_label
                role = Role.Button
            },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(docsListColor(line.color_key)))
            KitText(line.label, KitType.Row, Surface.ink, Modifier.weight(1f), maxLines = 2)
            KitText(line.spent, KitType.Row, Surface.ink, maxLines = 1)
        }
        if (line.has_plan) {
            val fill = if (line.over) StateColor.Red.fill else docsListColor(line.color_key)
            Box(Modifier.fillMaxWidth().height(6.dp).clip(CircleShape).background(Surface.fill)) {
                Box(Modifier.fillMaxHeight().fillMaxWidth(line.progress_bp.coerceIn(0, 10_000) / 10_000f).background(fill))
            }
        }
        KitText(line.caption, KitType.Meta, if (line.over) StateColor.Red.text else Surface.meta, maxLines = 2)
    }
}

/** "4 more categories" and "No category": a line under the categories that is not one of them. */
@Composable
internal fun MoneyRestRow(line: MoneyRestLine, pending: Boolean, testTag: String, onTap: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .background(if (pending) StateColor.Amber.tint else Color.Transparent)
            .clickable(onClick = onTap)
            .padding(horizontal = 16.dp)
            .testTag(testTag)
            .semantics(mergeDescendants = true) {
                contentDescription = line.accessibility_label
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (line.color_key.isEmpty()) {
            val meta = Surface.meta
            Canvas(Modifier.size(10.dp)) {
                drawCircle(meta, style = Stroke(1.2.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4f, 4f))))
            }
        } else {
            Box(Modifier.size(10.dp).clip(CircleShape).background(docsListColor(line.color_key)))
        }
        KitText(line.label, KitType.Row, Surface.ink, Modifier.weight(1f), maxLines = 1)
        KitText(line.amount, KitType.Row, Surface.ink, maxLines = 1)
    }
}

// --- The pages under Activity ----------------------------------------------------------------

/** A white card on a page of cards with the page margin: rows inside draw their own gutter. */
@Composable
internal fun MoneyPageCard(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp).kitCard()) { content() }
}

/** The figures of a summary side by side on one card, each a label over its value. */
@Composable
internal fun MoneyFigureCard(figures: List<centraid.core.v1.MoneyFigure>) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp).kitCard().padding(16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        figures.forEach { figure ->
            Column(
                Modifier.weight(1f).clearAndSetSemantics { contentDescription = spoken(figure.label, figure.amount) },
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                KitText(figure.label, KitType.Meta, Surface.meta, maxLines = 3)
                KitText(figure.amount, KitType.Row, moneyInk(figure.positive, figure.tone), maxLines = 1)
            }
        }
    }
}

/** A full-width secondary verb on a pale ground of the app's colour ("Apply to earlier rows"). */
@Composable
internal fun MoneyTintedButton(label: String, testTag: String, onClick: () -> Unit) {
    val accent = appAccent()
    Box(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
            .heightIn(min = 52.dp)
            .clip(RoundedCornerShape(percent = 50))
            .background(accent.wash(centraidDark()))
            .clickable(onClick = onClick)
            .testTag(testTag)
            .semantics { role = Role.Button },
        contentAlignment = Alignment.Center,
    ) {
        KitText(label, KitType.Row, accent.text, maxLines = 1)
    }
}
