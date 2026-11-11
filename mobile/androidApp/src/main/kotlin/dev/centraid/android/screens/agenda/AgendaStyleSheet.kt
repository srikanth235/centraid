package dev.centraid.android.screens.agenda

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.unit.dp
import centraid.core.v1.AgendaStyleSheet
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.SheetOutline
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * THE STYLE SHEET (#1173 wave 2): one sheet for a new list, an edited list, a new calendar and an
 * edited calendar. The core holds the draft; this draws the name field, the eight palette swatches
 * and the icon grid, and sends each pick. Colours are `[list]` palette keys looked up through the
 * generated colour resources, icons are catalogue keys; every word is the sheet's.
 */
@Composable
internal fun AgendaStyleSheetView(
    style: AgendaStyleSheet,
    onName: (String) -> Unit,
    onColor: (String) -> Unit,
    onIcon: (String) -> Unit,
    onSubmit: () -> Unit,
    onCancel: () -> Unit,
    // "Move to trash" on the sheet that edits a calendar the vault may remove (the state carries the
    // word, or none): null where the host has no such verb.
    onTrash: (() -> Unit)? = null,
) {
    SheetRoom(
        title = style.title,
        onDismiss = onCancel,
        expanded = true,
        primary = SheetPrimary(style.submit_label, testTag = "agenda-style-submit", enabled = style.can_submit, onPress = onSubmit),
        outlines = listOfNotNull(
            onTrash?.takeIf { style.delete_label.isNotEmpty() }?.let { trash ->
                SheetOutline(style.delete_label, testTag = "agenda-style-trash", ink = "net", onPress = trash)
            },
            SheetOutline(style.cancel_label, testTag = "agenda-style-cancel", link = true, onPress = onCancel),
        ),
    ) {
        Column(Modifier.fillMaxWidth().heightIn(max = 520.dp).verticalScroll(rememberScrollState())) {
            EditableFieldRow(
                key = "",
                value = style.name,
                reload = style.name,
                placeholder = style.name_placeholder,
                onEdit = onName,
                testTag = "agenda-style-name",
            )
            // THE PREVIEW: the chosen colour and icon as the list will wear them.
            Box(
                Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp).size(44.dp).clip(CircleShape)
                    .background(agendaListColor(style.color_key) ?: centraidColor("textFaint")),
                contentAlignment = Alignment.Center,
            ) {
                if (style.icon_key.isNotEmpty()) CentraidIcon(style.icon_key, tint = Color.White, size = 22.dp)
            }
            Text(
                style.color_label,
                style = centraidType("eyebrow"),
                color = centraidColor("textSoft"),
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp),
            )
            // THE BOARD'S GRID: eight to a row, each cell a 44dp target.
            Row(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER)) {
                style.colors.forEach { swatch ->
                    Box(
                        Modifier
                            .weight(1f)
                            .heightIn(min = KitGeometry.ROW_MIN)
                            .clip(CircleShape)
                            .clickable { onColor(swatch.key) }
                            .testTag("agenda-style-color-${swatch.key}")
                            .clearAndSetSemantics {
                                contentDescription = swatch.label
                                role = Role.RadioButton
                                selected = swatch.selected
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(
                            Modifier
                                .size(28.dp)
                                .clip(CircleShape)
                                .background(agendaListColor(swatch.key) ?: centraidColor("textFaint"))
                                .then(if (swatch.selected) Modifier.border(3.dp, centraidColor("text"), CircleShape) else Modifier),
                        )
                    }
                }
            }
            Text(
                style.icon_label,
                style = centraidType("eyebrow"),
                color = centraidColor("textSoft"),
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
            )
            Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER)) {
              style.icons.chunked(8).forEach { rowIcons ->
                Row(Modifier.fillMaxWidth()) {
                  rowIcons.forEach { icon ->
                    Box(
                        Modifier
                            .weight(1f)
                            .heightIn(min = KitGeometry.ROW_MIN)
                            .clip(CircleShape)
                            .then(if (icon.selected) Modifier.background(centraidColor("bgSunken"), CircleShape) else Modifier)
                            .clickable { onIcon(icon.key) }
                            .testTag("agenda-style-icon-${icon.key}")
                            .clearAndSetSemantics {
                                contentDescription = icon.label
                                role = Role.RadioButton
                                selected = icon.selected
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        CentraidIcon(icon.key, tint = centraidColor(if (icon.selected) "text" else "textSoft"), size = 22.dp, solid = icon.selected)
                    }
                  }
                  repeat(8 - rowIcons.size) { Box(Modifier.weight(1f)) }
                }
              }
            }
            // "No icon" clears it: an empty key.
            Box(Modifier.padding(horizontal = KitGeometry.GUTTER)) {
                StyleChip(style.no_icon_label, "agenda-style-icon-none", style.no_icon_selected) { onIcon("") }
            }
        }
    }
}

@Composable
private fun StyleChip(label: String, testTag: String, selected: Boolean, onTap: () -> Unit) {
    Box(
        Modifier
            .heightIn(min = KitGeometry.ROW_MIN)
            .clip(CircleShape)
            .then(if (selected) Modifier.background(centraidColor("bgSunken"), CircleShape) else Modifier)
            .clickable(onClick = onTap)
            .padding(horizontal = 12.dp)
            .testTag(testTag)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.RadioButton
                this.selected = selected
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = centraidType("small"), color = centraidColor(if (selected) "text" else "textSoft"))
    }
}
