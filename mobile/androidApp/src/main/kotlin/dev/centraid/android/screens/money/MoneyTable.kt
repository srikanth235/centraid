package dev.centraid.android.screens.money

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import centraid.core.v1.MoneyCategoryLine
import centraid.core.v1.MoneyFigure
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.toneInk
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry

/*
 * MONEY'S TABLES (#1152): figures laid across the page, the category table with
 * its column heads, and the Needs row. The drawing is iOS's (`MoneyParts.swift`);
 * every word and every amount is Rust's, and the arithmetic lives in
 * [MoneyGeometry] where a JVM test reads it.
 */

/** A radius from the token scale, as a shape: `sm` for a bar, `lg` for a plate. */
@Composable
internal fun moneyRadius(role: String): RoundedCornerShape =
    RoundedCornerShape((LocalCentraidTokens.current.radii[role] ?: 0).dp)

/**
 * ONE LINE OF A FIGURE THAT SHRINKS BEFORE IT WRAPS OR CLIPS: an amount is
 * never cut short, so it steps down toward [minScale] of its role's size.
 * [tabular] keeps the digits one width, so a column of amounts lines up.
 */
@Composable
internal fun FitText(
    text: String,
    role: String,
    ink: Color,
    minScale: Float,
    modifier: Modifier = Modifier,
    align: TextAlign = TextAlign.Start,
    tabular: Boolean = false,
) {
    val base = centraidType(role)
    BasicText(
        text,
        modifier = modifier,
        style = base.copy(
            color = ink,
            textAlign = align,
            fontFeatureSettings = if (tabular) TABULAR else null,
        ),
        maxLines = 1,
        softWrap = false,
        autoSize = TextAutoSize.StepBased(minFontSize = base.fontSize * minScale, maxFontSize = base.fontSize),
    )
}

/** A hairline across the top of its box, inset at the start as the kit's rows draw it. */
@Composable
internal fun MoneyHairline(inset: Dp = KitGeometry.GUTTER) {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(start = inset)
            .height(CentraidGeometry.HAIRLINE.dp)
            .background(centraidColor("line")),
    )
}

/**
 * FIGURES SIDE BY SIDE, each a label over its value: the hero's Planned and
 * Left, and In, Out and Net. The state decides the figures and their tones;
 * this lays them across the page instead of down it.
 */
@Composable
internal fun MoneyFigureColumns(figures: List<MoneyFigure>, inset: Dp = KitGeometry.GUTTER) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = inset, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        figures.forEach { figure ->
            Column(
                Modifier
                    .weight(1f)
                    .clearAndSetSemantics { contentDescription = spoken(figure.label, figure.amount) },
            ) {
                Text(figure.label, style = centraidType("annotLabel"), color = centraidColor("textFaint"))
                FitText(
                    money(figure.amount),
                    role = "smallStrong",
                    ink = toneInk(figure.tone, neutral = "text"),
                    minScale = FIGURE_MIN_SCALE,
                    tabular = true,
                )
            }
        }
    }
}

/** THE IN / OUT / NET CARD: the same three figures on a raised plate. */
@Composable
internal fun MoneyFigureCard(figures: List<MoneyFigure>) {
    val plate = moneyRadius("lg")
    Box(
        Modifier
            .fillMaxWidth()
            .padding(start = KitGeometry.GUTTER, end = KitGeometry.GUTTER, top = 12.dp)
            .clip(plate)
            .background(centraidColor("bgElev"), plate)
            .padding(vertical = 6.dp),
    ) {
        MoneyFigureColumns(figures, inset = CARD_INSET)
    }
}

/** THE CATEGORY TABLE'S HEADER: the same three columns every line draws, from the table's own heads. */
@Composable
internal fun MoneyCategoryHeader(planned: String, spent: String, left: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = KitGeometry.GUTTER, end = KitGeometry.GUTTER, top = 16.dp, bottom = 4.dp)
            .clearAndSetSemantics { },
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Spacer(Modifier.weight(1f))
        listOf(planned, spent, left).forEach { head ->
            Text(
                head,
                style = centraidType("annotLabel"),
                color = centraidColor("textFaint"),
                textAlign = TextAlign.End,
                maxLines = 1,
                modifier = Modifier.width(MoneyGeometry.COLUMN_WIDTH.dp),
            )
        }
    }
}

/**
 * ONE CATEGORY, PLANNED · SPENT · LEFT across the page. A line with no plan
 * draws a dash for planned and left, because it has nothing to compare to; a
 * line over plan is `net` ink on its left column, the figure's own minus sign
 * being the second channel.
 */
@Composable
internal fun MoneyCategoryRow(line: MoneyCategoryLine, accessibility: String, testTag: String, onTap: () -> Unit) {
    val figures = MoneyGeometry.categoryFigures(line.has_plan, money(line.planned), money(line.spent), money(line.left))
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = CATEGORY_ROW_MIN)
            .clickable(onClick = onTap)
            .testTag(testTag)
            .clearAndSetSemantics {
                contentDescription = accessibility
                role = Role.Button
            },
    ) {
        MoneyHairline()
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = CATEGORY_ROW_MIN)
                .padding(horizontal = KitGeometry.GUTTER),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                line.label,
                style = centraidType("body"),
                color = centraidColor("text"),
                maxLines = 2,
                modifier = Modifier.weight(1f),
            )
            MoneyColumnFigure(figures.planned, ink = centraidColor("textSoft"))
            MoneyColumnFigure(figures.spent, ink = centraidColor("text"))
            MoneyColumnFigure(figures.left, ink = centraidColor(if (line.over) "net" else "textSoft"), strong = line.over)
        }
    }
}

/**
 * "NEEDS A CATEGORY · 4" AND WHAT IT COMES TO, ONE ROW. The seam ink says it is
 * owed attention; a tap sends the category filter that lists exactly these rows,
 * and the key it sends is the state's own `needs_key`: none is spelled here.
 */
@Composable
internal fun MoneyNeedsRow(label: String, figures: List<MoneyFigure>, onTap: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .clickable(onClick = onTap)
            .padding(horizontal = KitGeometry.GUTTER)
            .testTag("money-needs-category")
            .clearAndSetSemantics {
                contentDescription = spoken(label, figures.firstOrNull()?.amount)
                role = Role.Button
            },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            style = centraidType("annotLabelOn"),
            color = centraidColor("seam"),
            modifier = Modifier.weight(1f),
        )
        Text(
            MoneyGeometry.needsAmounts(figures.map { money(it.amount) }),
            style = centraidType("annotLabel").copy(fontFeatureSettings = TABULAR),
            color = centraidColor("textSoft"),
            maxLines = 1,
        )
        CentraidIcon("ChevronRight", tint = centraidColor("textGhost"), size = NEEDS_CHEVRON)
    }
}

/** One right-aligned figure in a fixed column. */
@Composable
internal fun MoneyColumnFigure(text: String, ink: Color, strong: Boolean = false) {
    FitText(
        text,
        role = if (strong) "annotLabelOn" else "annotLabel",
        ink = ink,
        minScale = COLUMN_MIN_SCALE,
        modifier = Modifier.width(MoneyGeometry.COLUMN_WIDTH.dp),
        align = TextAlign.End,
        tabular = true,
    )
}

private val CARD_INSET: Dp = 16.dp
private val CATEGORY_ROW_MIN: Dp = 46.dp
private val NEEDS_CHEVRON: Dp = 15.dp
private const val FIGURE_MIN_SCALE: Float = 0.8f
private const val COLUMN_MIN_SCALE: Float = 0.75f
private const val TABULAR: String = "tnum"
