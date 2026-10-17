package dev.centraid.android.screens.money

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.unit.dp
import centraid.screen.v1.Money
import centraid.screen.v1.MoneyFigure
import centraid.screen.v1.MoneyHero
import centraid.screen.v1.MoneyRow
import centraid.screen.v1.SectionHead
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.kitSwitchColors
import dev.centraid.android.kit.toneInk
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.android.theme.formatMoney

/*
 * MONEY'S SHARED DRAWING PARTS (#1099). Every word here is the state's; the view
 * renders an amount with `formatMoney` at the state's own exponent, appends it
 * to the state's accessibility words, and decides nothing: not a sign, not a
 * tone, not a sum. Nothing here adds two amounts.
 */

/** Money as the vault says to render it; absent is nothing. */
internal fun money(amount: Money?): String = amount?.let(::formatMoney).orEmpty()

/** The state's words, then the rendered money after them. */
internal fun spoken(words: String, amount: Money?): String =
    listOf(words, money(amount)).filter { it.isNotEmpty() }.joinToString(", ")

/** A section label with the kit's header. Empty is nothing. */
@Composable
internal fun MoneySection(title: String) {
    if (title.isNotEmpty()) SectionHeader(SectionHead(title = title))
}

/** A quiet sentence under a section. */
@Composable
internal fun MoneyNote(text: String, ink: String = "textSoft") {
    if (text.isEmpty()) return
    Text(
        text,
        style = centraidType("annotLabel"),
        color = centraidColor(ink),
        modifier = Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp),
    )
}

/** A label beside its figure, inked by the figure's own tone. */
@Composable
internal fun MoneyFigureRow(figure: MoneyFigure, modifier: Modifier = Modifier) {
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 36.dp)
            .padding(horizontal = KitGeometry.GUTTER)
            .clearAndSetSemantics { contentDescription = spoken(figure.label, figure.amount) },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(figure.label, style = centraidType("body"), color = centraidColor("textSoft"), modifier = Modifier.weight(1f))
        Text(
            money(figure.amount),
            style = centraidType("mono"),
            color = toneInk(figure.tone, neutral = "text"),
        )
    }
}

/**
 * THE HERO: one display figure per currency, the sentence under it, and the
 * bar when a plan is set. The bar is spent against plan; the tick is how far
 * through the month today falls. Over plan reads as the `net` ink and the
 * figures' own minus sign: colour is the second channel.
 */
@Composable
internal fun MoneyHeroView(hero: MoneyHero) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp)
            .testTag("money-hero")
            .semantics(mergeDescendants = true) { },
    ) {
        Text(
            money(hero.spent),
            style = centraidType("display"),
            color = centraidColor(if (hero.over) "net" else "text"),
            modifier = Modifier.clearAndSetSemantics { contentDescription = spoken(hero.spent_label, hero.spent) },
        )
        Text(hero.spent_label, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
        if (hero.has_bar) {
            MoneyBar(hero.fill_bp, hero.tick_bp, hero.over, hero.accessibility_label)
        }
    }
    hero.figures.forEach { MoneyFigureRow(it) }
}

/** A plan bar from the state's basis points: the fill, and a tick for the day. */
@Composable
internal fun MoneyBar(fillBp: Int, tickBp: Int, over: Boolean, spokenWords: String) {
    val radius = RoundedCornerShape((LocalCentraidTokens.current.radii["sm"] ?: 0).dp)
    Box(
        Modifier
            .fillMaxWidth()
            .padding(top = 10.dp)
            .height(6.dp)
            .clip(radius)
            .background(centraidColor("bgSunken"))
            .clearAndSetSemantics { contentDescription = spokenWords },
    ) {
        Box(
            Modifier
                .fillMaxWidth(fillBp.coerceIn(0, BP) / BP.toFloat())
                .height(6.dp)
                .background(centraidColor(if (over) "net" else "textSoft")),
        )
        if (tickBp > 0) {
            Row(Modifier.fillMaxWidth().height(6.dp)) {
                Box(Modifier.fillMaxWidth(tickBp.coerceIn(0, BP) / BP.toFloat()).height(6.dp))
                Box(Modifier.height(6.dp).fillMaxWidth(TICK_WIDTH).background(centraidColor("text")))
            }
        }
    }
}

/** THE TRANSACTION ROW: the one row, the signed amount as its figure. */
@Composable
internal fun MoneyRowView(row: MoneyRow, onTap: (() -> Unit)?) {
    CentraidRow(
        title = row.title,
        meta = listOf(row.category_label, row.meta).filter { it.isNotEmpty() }.joinToString(" · "),
        trailing = money(row.amount),
        trailingTone = row.amount_tone,
        chips = row.chips,
        dimmed = row.dimmed,
        a11y = spoken(row.accessibility_label, row.amount),
        testTag = "money-row-${row.txn_id}",
        onTap = onTap,
    )
}

/** A switch row: the state's label and whether it is on. The toggle is an event the screen forwards. */
@Composable
internal fun MoneyToggleRow(label: String, checked: Boolean, testTag: String, onToggle: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .clip(RoundedCornerShape(KitGeometry.RADIUS))
            .clickable(onClick = onToggle)
            .padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)
            .testTag(testTag)
            .semantics(mergeDescendants = true) {
                role = Role.Switch
                toggleableState = if (checked) ToggleableState.On else ToggleableState.Off
                contentDescription = label
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = centraidType("body"), color = centraidColor("text"), modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = null, colors = kitSwitchColors())
    }
}

/** A heading for a block inside a sheet or a page. */
@Composable
internal fun MoneyHeading(text: String) {
    if (text.isEmpty()) return
    Text(
        text,
        style = centraidType("smallStrong"),
        color = centraidColor("textSoft"),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
            .semantics { heading() },
    )
}

private const val BP: Int = 10_000
private const val TICK_WIDTH: Float = 0.006f
