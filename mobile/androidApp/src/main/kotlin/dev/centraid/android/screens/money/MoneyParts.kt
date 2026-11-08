package dev.centraid.android.screens.money

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.selected
import centraid.core.v1.MoneyChoice
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.appAccent
import dev.centraid.android.screens.docs.docsListColor
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.SheetOption
import dev.centraid.design.CentraidScale
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import centraid.core.v1.MoneyFigure
import centraid.core.v1.MoneyHero
import centraid.core.v1.MoneyRow
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.kitSwitchColors
import dev.centraid.android.kit.toneInk
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/*
 * MONEY'S SHARED DRAWING PARTS (#1099; #1135). Every word here is Rust's, an amount
 * included: the view appends it to the state's accessibility words and decides
 * nothing: not a sign, not a tone, not a sum. Nothing here adds two amounts.
 */

/** An amount arrives finished from Rust (`kit::money` is the one formatter); nothing here renders one. */
internal fun money(amount: String): String = amount

/** The state's words, then the finished amount after them. */
internal fun spoken(words: String, amount: String?): String =
    listOf(words, amount.orEmpty()).filter { it.isNotEmpty() }.joinToString(", ")

/** A section label in the kit's group head (12pt capitals). Empty is nothing. */
@Composable
internal fun MoneySection(title: String) {
    if (title.isNotEmpty()) {
        KitText(
            title,
            KitType.Group,
            Surface.meta,
            Modifier.fillMaxWidth().padding(start = KitGeometry.GUTTER + 4.dp, end = KitGeometry.GUTTER, top = 14.dp, bottom = 2.dp).semantics { heading() },
        )
    }
}

/** A quiet sentence under a section. `ink` `net` is the state red. */
@Composable
internal fun MoneyNote(text: String, ink: String = "textSoft") {
    if (text.isEmpty()) return
    KitText(
        text,
        KitType.Meta,
        if (ink == "net") StateColor.Red.text else Surface.meta,
        Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER + 4.dp, vertical = 6.dp),
    )
}

/** A label beside its figure, inked by the figure's own tone. */
@Composable
internal fun MoneyFigureRow(figure: MoneyFigure, modifier: Modifier = Modifier) {
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .padding(horizontal = KitGeometry.GUTTER)
            .clearAndSetSemantics { contentDescription = spoken(figure.label, figure.amount) },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KitText(figure.label, KitType.Row, Surface.body, Modifier.weight(1f), maxLines = 2)
        KitText(figure.amount, KitType.Row, moneyInk(figure.positive, figure.tone), maxLines = 1)
    }
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
    KitText(
        text,
        KitType.Meta,
        Surface.body,
        Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp).semantics { heading() },
    )
}


/**
 * A SHEET OF CHOICES that scrolls: a month, an account, a category, a merge target. Choices that
 * name a group (the category picker) stand in a card per group under its capitals heading, and a
 * category wears its colour as a dot, "No category" the dashed one (iOS `MoneyChoiceSheet`).
 */
@Composable
internal fun MoneyChoiceSheet(
    title: String,
    choices: List<MoneyChoice>,
    tagPrefix: String,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    // A picker of categories: any choice with a colour, and any with a group name.
    val hasDots = choices.any { it.color_key.isNotEmpty() } && choices.any { it.detail.isNotEmpty() }
    if (!hasDots) {
        OptionSheet(
            title = title,
            options = choices.map { SheetOption(key = it.key, label = it.label, detail = it.detail, selected = it.selected) },
            onPick = onPick,
            onDismiss = onDismiss,
        )
        return
    }
    // The choices as runs sharing one group name, in order; the first run is the ungrouped lead.
    val runs = mutableListOf<Pair<String, MutableList<MoneyChoice>>>()
    choices.forEach { choice ->
        val last = runs.lastOrNull()
        if (last != null && last.first == choice.detail) last.second += choice else runs += choice.detail to mutableListOf(choice)
    }
    SheetRoom(title = title, onDismiss = onDismiss) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            runs.forEach { (group, items) ->
                if (group.isNotEmpty()) {
                    KitText(
                        group,
                        KitType.Group,
                        Surface.meta,
                        Modifier.padding(start = KitGeometry.GUTTER + 4.dp, end = KitGeometry.GUTTER, top = 14.dp, bottom = 4.dp).semantics { heading() },
                    )
                }
                Column(
                    Modifier
                        .padding(horizontal = KitGeometry.GUTTER)
                        .clip(RoundedCornerShape(CentraidScale.cardRadius.dp))
                        .background(Surface.sheetCard),
                ) {
                    items.forEachIndexed { index, choice ->
                        if (index > 0) MoneyHairline()
                        MoneyChoiceRow(choice, "$tagPrefix-${choice.key}") { onPick(choice.key) }
                    }
                }
            }
        }
    }
}

/** One choice with its colour dot: a filled dot for a category, the dashed one for "No category". */
@Composable
private fun MoneyChoiceRow(choice: MoneyChoice, testTag: String, onTap: () -> Unit) {
    val meta = Surface.meta
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(onClick = onTap)
            .padding(horizontal = KitGeometry.GUTTER)
            .testTag(testTag)
            .clearAndSetSemantics {
                contentDescription = choice.label
                role = Role.Button
                selected = choice.selected
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (choice.color_key.isEmpty()) {
            Canvas(Modifier.size(10.dp)) {
                drawCircle(meta, style = Stroke(1.2.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4f, 4f))))
            }
        } else {
            Box(Modifier.size(10.dp).clip(CircleShape).background(docsListColor(choice.color_key)))
        }
        KitText(choice.label, KitType.Row, Surface.ink, Modifier.weight(1f), maxLines = 2)
        if (choice.selected) CentraidIcon(iconKey = "Check", tint = appAccent().text, size = 16.dp)
    }
}
