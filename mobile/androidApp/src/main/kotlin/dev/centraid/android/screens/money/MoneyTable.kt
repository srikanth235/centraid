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
