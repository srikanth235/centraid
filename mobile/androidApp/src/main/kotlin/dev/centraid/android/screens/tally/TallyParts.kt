package dev.centraid.android.screens.tally

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import centraid.screen.v1.Money
import centraid.screen.v1.SectionHead
import centraid.screen.v1.TallyFigure
import centraid.screen.v1.TallyHero
import centraid.screen.v1.TallyLedgerRow
import centraid.screen.v1.TallyTone
import centraid.screen.v1.TallyTransferRow
import centraid.screen.v1.WriteState
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.hueColor
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.android.theme.formatMoney

/*
 * TALLY'S SHARED DRAWING PARTS (#1046). Every word here is the state's; the
 * view renders money with `formatMoney` at the state's own exponent and
 * appends it after the state's accessibility words, and decides nothing.
 */

/** Money as the vault says to render it; absent is nothing. */
internal fun money(amount: Money?): String = amount?.let(::formatMoney).orEmpty()

/** A figure's ink: `net` on what you owe, soft on level, ink otherwise — never a green. */
internal fun toneInk(tone: TallyTone): String = when (tone) {
    TallyTone.TALLY_TONE_OWE -> "net"
    TallyTone.TALLY_TONE_LEVEL -> "textSoft"
    else -> "text"
}

/** The state's words, then the rendered money after them. */
internal fun spoken(words: String, amount: Money?): String {
    val rendered = money(amount)
    return listOf(words, rendered).filter { it.isNotEmpty() }.joinToString(", ")
}

/** A write refusal's sentence, for a room's status host. */
internal fun refusal(write: WriteState?): String =
    if (write?.phase == WriteState.Phase.PHASE_REFUSED) write.failure?.sentence.orEmpty() else ""

/**
 * THE HERO (README - Tally §5): one display figure per currency — never summed
 * across currencies — its label, and the sentence that says where it came from.
 */
@Composable
internal fun TallyHeroView(hero: TallyHero?) {
    if (hero == null) return
    Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp).testTag("tally-hero")) {
        if (hero.label.isNotEmpty()) {
            Text(
                hero.label,
                style = centraidType("smallStrong"),
                color = centraidColor("textSoft"),
                modifier = Modifier.semantics { heading() },
            )
        }
        hero.lines.forEach { line -> FigureLine(line) }
        if (hero.sub.isNotEmpty()) {
            Text(
                hero.sub,
                style = centraidType("body"),
                color = centraidColor("textSoft"),
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

@Composable
private fun FigureLine(figure: TallyFigure) {
    Column(
        Modifier.padding(top = 4.dp).clearAndSetSemantics { contentDescription = spoken(figure.label, figure.amount) },
    ) {
        Text(money(figure.amount), style = centraidType("display"), color = centraidColor(toneInk(figure.tone)))
        if (figure.label.isNotEmpty()) {
            Text(figure.label, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
        }
    }
}

/**
 * A GROUP'S MARK: the glyph the member gave it ("🏔️") when the state carries
 * one, else its catalog icon in the group's hue, on a sunken 36dp tile. The
 * row's own words already name the group, so the mark says nothing.
 */
@Composable
internal fun TallyGroupMark(glyph: String, iconKey: String, hue: String, modifier: Modifier = Modifier) {
    Box(
        modifier
            .size(36.dp)
            .clip(RoundedCornerShape(KitGeometry.RADIUS))
            .background(centraidColor("bgSunken"))
            .clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        if (glyph.isNotEmpty()) {
            Text(glyph, fontSize = 20.sp)
        } else if (iconKey.isNotEmpty()) {
            CentraidIcon(iconKey = iconKey, tint = hueColor(hue), size = 20.dp)
        }
    }
}

/** A section label with the kit's header. Empty is nothing. */
@Composable
internal fun TallySection(title: String) {
    if (title.isNotEmpty()) SectionHeader(SectionHead(title = title))
}

/** THE LEDGER ROW: the one row, the member's share as its figure. */
@Composable
internal fun TallyLedgerLine(row: TallyLedgerRow, onTap: () -> Unit) {
    val figure = row.yours
    val amount = figure?.amount ?: row.amount
    CentraidRow(
        title = row.title,
        meta = row.meta,
        trailing = money(amount),
        trailingNote = figure?.label.orEmpty(),
        hueKey = row.payer?.hue.orEmpty(),
        a11y = spoken(row.accessibility_label, amount),
        testTag = "tally-row-${row.row_key}",
        onTap = if (row.expense_id.isNotEmpty()) onTap else null,
    )
}

/** A transfer (settle-up suggestion or a simplified payment). */
@Composable
internal fun TallyTransferLine(row: TallyTransferRow, onTap: (() -> Unit)?) {
    CentraidRow(
        title = row.line,
        meta = row.meta,
        trailing = money(row.amount),
        hueKey = row.from?.hue.orEmpty(),
        a11y = spoken(row.accessibility_label, row.amount),
        testTag = "tally-transfer-${row.key}",
        onTap = onTap,
    )
}

/** A quiet sentence under a section. */
@Composable
internal fun TallyNote(text: String, ink: String = "textSoft") {
    if (text.isEmpty()) return
    Text(
        text,
        style = centraidType("annotLabel"),
        color = centraidColor(ink),
        modifier = Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp),
    )
}

/** A category's proportion (README - Tally §5: optional proportion bar), from the state's permille. */
@Composable
internal fun ShareBar(permille: Int) {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .height(4.dp)
            .clip(RoundedCornerShape(2.dp))
            .background(centraidColor("bgSunken"))
            .clearAndSetSemantics { },
    ) {
        Box(
            Modifier
                .fillMaxWidth(permille.coerceIn(0, 1000) / 1000f)
                .height(4.dp)
                .background(centraidColor("textSoft")),
        )
    }
}
