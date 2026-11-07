package dev.centraid.android.screens.money

import androidx.compose.foundation.background
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

