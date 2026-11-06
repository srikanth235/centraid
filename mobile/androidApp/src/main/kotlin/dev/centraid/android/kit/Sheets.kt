package dev.centraid.android.kit

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import dev.centraid.design.CentraidScale
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
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.unit.dp
import centraid.core.v1.Confirm
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * THE CONFIRM (K5): a [SheetRoom] carrying the machine's finished `Confirm` —
 * the title names the noun, the body is the one full sentence product-intuition/references/design-behaviour.md § Wording
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
    confirmTag: String = "confirm-primary",
) {
    SheetRoom(
        title = confirm.title,
        onDismiss = onDismiss,
        primary = SheetPrimary(
            label = confirm.confirm_label,
            destructive = confirm.destructive,
            testTag = confirmTag,
            onPress = onConfirm,
        ),
    ) {
        if (confirm.body.isNotEmpty()) {
            Text(
                confirm.body,
                style = kitTextStyle(KitType.Row),
                color = Surface.body,
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp),
            )
        }
        Text(
            cancelLabel,
            style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
            color = Surface.meta,
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
 * A REFUSAL TOLD IN A SHEET, NOT A DIALOG (product-intuition/references/design-behaviour.md § Controls):
 * the act that was refused as the title, the sentence saying what happened and
 * what to do, and one way out, the outline [doneLabel]. The grabber, the scrim
 * and back are the same as Done.
 */
@Composable
public fun NoticeSheet(
    title: String,
    sentence: String,
    doneLabel: String,
    onDone: () -> Unit,
) {
    SheetRoom(
        title = title,
        onDismiss = onDone,
        outlines = listOf(SheetOutline(label = doneLabel, testTag = "notice-done", onPress = onDone)),
    ) {
        Text(
            sentence,
            style = kitTextStyle(KitType.Row),
            color = Surface.body,
            modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp),
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
    enabled: Boolean = true,
) {
    val ink = when {
        !enabled -> Surface.meta
        destructive -> StateColor.Red.text
        else -> Surface.ink
    }
    val line = Surface.sheetLine
    val accent = appAccent()
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 52.dp)
                .clickable(enabled = enabled, onClick = onTap)
                .padding(horizontal = 12.dp, vertical = 6.dp)
                .testTag(testTag)
                .clearAndSetSemantics {
                    contentDescription = if (detail.isEmpty()) label else "$label, $detail"
                    role = Role.Button
                    if (!enabled) disabled()
                    this.selected = selected
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (iconKey != null) {
                // THE MARK IS A SMALL TILE in the app's fill with a white glyph; a destructive
                // row's is the state's red.
                KitTile(
                    iconKey,
                    Modifier.padding(end = 12.dp),
                    size = 32.dp,
                    fill = if (destructive) StateColor.Red.fill else null,
                )
            }
            Column(Modifier.weight(1f)) {
                KitText(label, KitType.Row, ink)
                if (detail.isNotEmpty()) KitText(detail, KitType.Meta, Surface.meta)
            }
            if (selected) CentraidIcon(iconKey = "Check", tint = accent.text, size = 16.dp)
        }
        Spacer(Modifier.padding(start = if (iconKey != null) 56.dp else 12.dp).fillMaxWidth().height(KitGeometry.HAIRLINE).background(line))
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
        // THE ROWS ARE ONE CARD ON THE SHEET (#1173); the last row's hairline falls outside the clip.
        Column(
            Modifier
                .padding(horizontal = KitGeometry.GUTTER)
                .clip(RoundedCornerShape(CentraidScale.cardRadius.dp))
                .background(Surface.sheetCard),
        ) {
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
}
