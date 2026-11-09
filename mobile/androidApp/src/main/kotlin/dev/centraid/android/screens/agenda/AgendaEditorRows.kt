package dev.centraid.android.screens.agenda

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import centraid.core.v1.AgendaRowTile
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitTile
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.kitCard
import dev.centraid.android.kit.rememberEditorText
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

// THE EVENT EDITOR'S ROWS ON THE BOARD (#1173, `EventEditorRows`): two rounded cards, each row a
// colour tile, its label, its value and a chevron. The glyph and the colour of every tile come from
// Rust (`AgendaEditorChrome.tiles`, by the row's key); these composables only lay them out.

/** The tile Rust names for an event row, by its key; null draws none. */
internal fun List<AgendaRowTile>.tileOf(key: String): AgendaRowTile? = firstOrNull { it.key == key }

/** A rounded card the rows sit in: the card colour and radius, rows divided by a hairline. */
@Composable
internal fun AgendaGroupCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .padding(top = 12.dp)
            .kitCard(),
        content = content,
    )
}

/** The hairline under a card row, inset to the label's start. */
@Composable
private fun RowDivider(inset: Dp) {
    Box(Modifier.fillMaxWidth().padding(start = inset).heightIn(min = KitGeometry.HAIRLINE).background(Surface.line))
}

/** The 30dp tile of a card row, or nothing when Rust names none. */
@Composable
private fun RowTile(tile: AgendaRowTile?) {
    if (tile != null && tile.icon_key.isNotEmpty()) {
        KitTile(tile.icon_key, size = 30.dp, fill = agendaTokenColor(tile.color_key))
    }
}

private val TILE_INSET = 56.dp

/** A card row whose value is a choice: tile, label, value, chevron. A tap opens the sheet. */
@Composable
internal fun AgendaTileChoiceRow(
    key: String,
    value: String,
    tile: AgendaRowTile?,
    testTag: String,
    divider: Boolean = true,
    onTap: () -> Unit,
) {
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .clickable(onClick = onTap)
                .padding(horizontal = 14.dp, vertical = 7.dp)
                .testTag(testTag)
                .clearAndSetSemantics {
                    contentDescription = "$key, $value"
                    role = Role.Button
                },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            RowTile(tile)
            Text(key, style = centraidType("body"), color = Surface.ink, modifier = Modifier.weight(1f))
            Text(value, style = centraidType("body"), color = Surface.meta, maxLines = 1)
            CentraidIcon(iconKey = "ChevronRight", tint = centraidColor("textFaint"), size = 14.dp)
        }
        if (divider) RowDivider(TILE_INSET)
    }
}

/** A start or an end: tile, label, then the day and the time as the two taps that open the pickers. */
@Composable
internal fun AgendaTileWhenRow(
    key: String,
    tile: AgendaRowTile?,
    testTag: String,
    divider: Boolean = true,
    faces: @Composable () -> Unit,
) {
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .padding(start = 14.dp, end = 6.dp, top = 4.dp, bottom = 4.dp)
                .testTag(testTag),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            RowTile(tile)
            Text(key, style = centraidType("body"), color = Surface.ink, modifier = Modifier.weight(1f))
            faces()
        }
        if (divider) RowDivider(TILE_INSET)
    }
}

/** A card row the member types into (the joining link): tile, label, then the field at the end. */
@Composable
internal fun AgendaTileFieldRow(
    key: String,
    value: String,
    reload: Any?,
    placeholder: String,
    tile: AgendaRowTile?,
    testTag: String,
    divider: Boolean = true,
    onEdit: (String) -> Unit,
) {
    val editor = rememberEditorText(value, reload)
    val text = editor.text
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .padding(horizontal = 14.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            RowTile(tile)
            Text(key, style = centraidType("body"), color = Surface.ink)
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
                if (text.value.isEmpty() && placeholder.isNotEmpty()) {
                    Text(
                        placeholder,
                        style = centraidType("body"),
                        color = centraidColor("textFaint"),
                        textAlign = TextAlign.End,
                        modifier = Modifier.fillMaxWidth().clearAndSetSemantics { },
                    )
                }
                BasicTextField(
                    value = text.value,
                    onValueChange = { next -> if (editor.edited(next)) onEdit(next) },
                    singleLine = true,
                    textStyle = centraidType("body").copy(color = Surface.meta, textAlign = TextAlign.End),
                    cursorBrush = SolidColor(Surface.ink),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag(testTag)
                        .semantics { contentDescription = key },
                )
            }
        }
        if (divider) RowDivider(TILE_INSET)
    }
}

/** A fact on the event page: the label left in soft ink, the value right; one row of the facts card. */
@Composable
internal fun AgendaFactRow(label: String, value: String, divider: Boolean = true) {
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .padding(horizontal = 14.dp, vertical = 10.dp)
                .semantics(mergeDescendants = true) { },
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Text(label, style = centraidType("body"), color = Surface.meta)
            Text(
                value,
                style = centraidType("body"),
                color = Surface.ink,
                textAlign = TextAlign.End,
                modifier = Modifier.weight(1f),
            )
        }
        if (divider) RowDivider(14.dp)
    }
}
