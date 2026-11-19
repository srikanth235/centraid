package dev.centraid.android.screens.money

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import centraid.core.v1.MoneyCashflowMonth
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.rememberLargestText
import dev.centraid.android.kit.HoldGridText
import dev.centraid.android.kit.toneInk
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/*
 * MONEY'S CASH-FLOW CHART (#1152), drawn as iOS draws it (`MoneyParts.swift`):
 * a pair of bars per month, the key under it, and the month table. The bars are
 * the state's own heights; the order and the heights come from [MoneyGeometry].
 */

/**
 * THE CASH-FLOW CHART: a pair of bars per month, In and Out, from the state's
 * own heights (`in_bp` and `out_bp`, basis points of the series' largest side;
 * nothing is measured here). A month that is not over is outlined, never
 * filled, so it cannot be read as a whole month. The chart is one accessibility
 * node: its label is [summary], every month's own words joined.
 */
@Composable
internal fun MoneyCashflowChart(months: List<MoneyCashflowMonth>, summary: String) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .padding(top = 8.dp)
            .clearAndSetSemantics { contentDescription = summary },
    ) {
        Row(
            Modifier.fillMaxWidth().height(MoneyGeometry.PLOT_HEIGHT.dp),
            horizontalArrangement = Arrangement.spacedBy(MONTH_GAP),
            verticalAlignment = Alignment.Bottom,
        ) {
            months.forEach { month ->
                Row(
                    Modifier.weight(1f),
                    horizontalArrangement = Arrangement.spacedBy(BAR_GAP, Alignment.CenterHorizontally),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    CashflowBar(month.in_bp, ink = centraidColor("textSoft"), partial = month.partial)
                    CashflowBar(month.out_bp, ink = centraidColor("textGhost"), partial = month.partial)
                }
            }
        }
        MoneyHairline(inset = 0.dp)
        // THE AXIS WORDS HOLD AT 1.3 (#1202): a column per month cannot grow with the font.
        HoldGridText {
            Row(
                Modifier.fillMaxWidth().padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(MONTH_GAP),
            ) {
                months.forEach { month ->
                    Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                        FitText(
                            month.label,
                            role = "eyebrow",
                            ink = centraidColor(if (month.partial) "text" else "textFaint"),
                            minScale = LABEL_MIN_SCALE,
                            align = TextAlign.Center,
                        )
                    }
                }
            }
        }
    }
}

/** One bar: filled, or only outlined while its month is not over. */
@Composable
private fun CashflowBar(basisPoints: Int, ink: Color, partial: Boolean) {
    val shape = moneyRadius("sm")
    Box(
        Modifier
            .width(MoneyGeometry.BAR_WIDTH.dp)
            .height(MoneyGeometry.barHeight(basisPoints).dp)
            .then(
                if (partial) {
                    Modifier.border(MoneyGeometry.PARTIAL_STROKE.dp, ink, shape)
                } else {
                    Modifier.background(ink, shape)
                },
            ),
    )
}

/** THE CHART'S KEY: a swatch and its word, from copy the state's rows already use. */
@Composable
internal fun MoneyLegend(incoming: String, outgoing: String, partial: String) {
    val frame = Modifier
        .fillMaxWidth()
        .padding(horizontal = KitGeometry.GUTTER)
        .padding(top = 8.dp)
        .clearAndSetSemantics { }
    val items: @Composable () -> Unit = {
        LegendItem(incoming, filled = true, ink = centraidColor("textSoft"))
        LegendItem(outgoing, filled = true, ink = centraidColor("textGhost"))
        LegendItem(partial, filled = false, ink = centraidColor("textSoft"))
    }
    // ONE KEY PER LINE at the largest text (#1202): in a row "month not over" wrapped a word at a time.
    if (rememberLargestText()) {
        Column(frame, verticalArrangement = Arrangement.spacedBy(6.dp)) { items() }
    } else {
        Row(frame, horizontalArrangement = Arrangement.spacedBy(16.dp)) { items() }
    }
}

@Composable
private fun LegendItem(text: String, filled: Boolean, ink: Color) {
    // EVERY SWATCH IS DRAWN, as iOS's key draws them: the words are Rust's copy and a blank one is
    // Rust's to fill, never a reason for this view to drop the item (the key is hidden from
    // TalkBack either way, so a bare swatch says nothing it should be spoken for).
    val shape = moneyRadius("sm")
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier
                .size(SWATCH)
                .then(
                    if (filled) {
                        Modifier.background(ink, shape)
                    } else {
                        Modifier.border(MoneyGeometry.PARTIAL_STROKE.dp, ink, shape)
                    },
                ),
        )
        Text(
            text,
            style = centraidType("annotLabel"),
            color = centraidColor("textSoft"),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * A MONTH'S ROW in the table under the chart: its name over its meta, then In,
 * Out and Net as three columns. A month that is not over reads in the soft ink.
 */
@Composable
internal fun MoneyMonthRow(month: MoneyCashflowMonth, testTag: String, labels: List<String> = emptyList()) {
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = MONTH_ROW_MIN)
            .testTag(testTag)
            .clearAndSetSemantics { contentDescription = month.accessibility_label },
    ) {
        MoneyHairline()
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = MONTH_ROW_MIN)
                .padding(horizontal = KitGeometry.GUTTER),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    month.label,
                    style = centraidType("body"),
                    color = centraidColor(if (month.partial) "textSoft" else "text"),
                )
                if (rememberLargestText()) {
                    // THE FIGURES UNDER THE MONTH, each whole on its line with its word (#1202): three
                    // columns left each amount a few letters wide and cut it.
                    val words = labels.ifEmpty { listOf("", "", "") }
                    listOf(
                        words.getOrElse(0) { "" } to (month.incoming to "text"),
                        words.getOrElse(1) { "" } to (month.outgoing to "text"),
                        words.getOrElse(2) { "" } to (month.net to null),
                    ).forEach { (word, figure) ->
                        Row(Modifier.fillMaxWidth().padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(word, style = centraidType("annotLabel"), color = centraidColor("textSoft"), modifier = Modifier.weight(1f))
                            Text(
                                money(figure.first),
                                style = centraidType("annotLabel"),
                                color = if (figure.second == null) toneInk(month.net_tone, neutral = "text") else centraidColor("text"),
                                textAlign = TextAlign.End,
                            )
                        }
                    }
                }
                if (month.meta.isNotEmpty()) {
                    Text(
                        month.meta,
                        style = centraidType("annotLabel"),
                        color = centraidColor("textFaint"),
                        maxLines = if (rememberLargestText()) Int.MAX_VALUE else 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (!rememberLargestText()) {
                MoneyColumnFigure(money(month.incoming), ink = centraidColor("text"))
                MoneyColumnFigure(money(month.outgoing), ink = centraidColor("text"))
                MoneyColumnFigure(money(month.net), ink = toneInk(month.net_tone, neutral = "text"))
            }
        }
    }
}

private val MONTH_GAP = 4.dp
private val BAR_GAP = 2.dp
private val SWATCH = 10.dp
private val MONTH_ROW_MIN = 48.dp
private const val LABEL_MIN_SCALE: Float = 0.7f
