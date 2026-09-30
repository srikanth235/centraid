package dev.centraid.android.kit

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.unit.dp
import centraid.screen.v1.Confirm
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * THE CONFIRM (K5): a [SheetRoom] carrying the machine's finished `Confirm` —
 * the title names the noun, the body is the one full sentence DESIGN.md
 * allows a destructive confirm, and the one act is the primary. Destructive
 * is the outlined `net` button. Dismissing is the grabber, the scrim or
 * [cancelLabel]; each sends [onDismiss].
 */
@Composable
public fun ConfirmSheet(
    confirm: Confirm,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    cancelLabel: String = KitWords.CANCEL,
) {
    SheetRoom(
        title = confirm.title,
        onDismiss = onDismiss,
        primary = SheetPrimary(
            label = confirm.confirm_label,
            destructive = confirm.destructive,
            testTag = "confirm-primary",
            onPress = onConfirm,
        ),
    ) {
        if (confirm.body.isNotEmpty()) {
            Text(
                confirm.body,
                style = centraidType("body"),
                color = centraidColor("textSoft"),
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp),
            )
        }
        Text(
            cancelLabel,
            style = centraidType("control"),
            color = centraidColor("textSoft"),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .clickable(onClick = onDismiss)
                .padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp)
                .testTag("confirm-cancel")
                .clearAndSetSemantics {
                    contentDescription = cancelLabel
                    role = Role.Button
                },
        )
    }
}

/**
 * ONE ROW OF A SHEET: an optional catalog mark, the label, an optional detail
 * under it. [destructive] draws the words in `net`. [selected] draws a check,
 * for a choice sheet.
 */
@Composable
public fun SheetRow(
    label: String,
    onTap: () -> Unit,
    modifier: Modifier = Modifier,
    iconKey: String? = null,
    detail: String = "",
    destructive: Boolean = false,
    selected: Boolean = false,
    testTag: String = "sheet-row",
) {
    val ink = centraidColor(if (destructive) "net" else "text")
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(onClick = onTap)
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
            .testTag(testTag)
            .clearAndSetSemantics {
                contentDescription = if (detail.isEmpty()) label else "$label, $detail"
                role = Role.Button
                this.selected = selected
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (iconKey != null) {
            CentraidIcon(
                iconKey = iconKey,
                tint = if (destructive) ink else centraidColor("textSoft"),
                size = 18.dp,
                modifier = Modifier.padding(end = 12.dp),
            )
        }
        Column(Modifier.weight(1f)) {
            Text(label, style = centraidType("body"), color = ink)
            if (detail.isNotEmpty()) {
                Text(detail, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
            }
        }
        if (selected) CentraidIcon(iconKey = "Check", tint = centraidColor("text"), size = 16.dp)
    }
}

/** One option of an [OptionSheet]. */
public data class SheetOption(
    val key: String,
    val label: String,
    val iconKey: String? = null,
    val detail: String = "",
    val selected: Boolean = false,
    val destructive: Boolean = false,
)

/**
 * A CHOICE IS A SHEET (#1015 D4: content pushes, choices sheet): a titled
 * [SheetRoom] of [SheetRow]s. Picking sends [onPick]; the machine closes it.
 */
@Composable
public fun OptionSheet(
    title: String,
    options: List<SheetOption>,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
    status: String = "",
) {
    SheetRoom(title = title, onDismiss = onDismiss, status = status) {
        options.forEach { option ->
            SheetRow(
                label = option.label,
                iconKey = option.iconKey,
                detail = option.detail,
                destructive = option.destructive,
                selected = option.selected,
                testTag = "sheet-option-${option.key}",
                onTap = { onPick(option.key) },
            )
        }
    }
}
