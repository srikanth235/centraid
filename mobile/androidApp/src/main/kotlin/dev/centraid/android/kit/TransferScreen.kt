package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import centraid.core.v1.TransferEvent
import centraid.core.v1.TransferView

/**
 * THE KIT'S TRANSFER PAGE, DRAWN FROM THE SCREEN RUNTIME (#1173): Notes' Markdown and People's
 * vCards, in and out. Every word is the view's (the lede, the headline, the rows and the buttons);
 * a tap on a row or a button is a [TransferEvent] carrying its key, and a pop is the shell's.
 */
@Composable
public fun TransferScreen(
    view: TransferView,
    onEvent: (TransferEvent) -> Unit,
    onBack: () -> Unit,
) {
    PushedPage(
        title = view.title,
        parentTitle = view.back_label,
        onBack = onBack,
        status = view.status?.sentence.orEmpty(),
    ) {
        LazyColumn(Modifier.padding(horizontal = KitGeometry.GUTTER)) {
            item(key = "lede") {
                Column(Modifier.padding(top = 4.dp, bottom = 14.dp)) {
                    KitText(view.lede, KitType.Row, Surface.meta)
                    if (view.headline.isNotEmpty()) {
                        KitText(
                            view.headline,
                            KitType.Row,
                            Surface.ink,
                            modifier = Modifier.padding(top = 14.dp).testTag("transfer-headline"),
                        )
                    }
                }
            }
            if (view.rows.isNotEmpty()) {
                item(key = "rows") {
                    Column(Modifier.kitCard()) {
                        view.rows.forEach { row -> TransferRow(row, view.busy, onEvent) }
                    }
                }
            }
            view.actions.forEach { action ->
                item(key = "action-${action.key}") {
                    val enabled = action.enabled && !view.busy
                    if (action.primary) {
                        KitPillButton(
                            label = action.label,
                            onPress = { onEvent(TransferEvent(key = action.key)) },
                            modifier = Modifier.padding(top = 14.dp),
                            testTag = "transfer-${action.key}",
                            enabled = enabled,
                        )
                    } else {
                        Text(
                            action.label,
                            style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
                            color = appAccent().text,
                            modifier = Modifier
                                .heightIn(min = KitGeometry.ROW_MIN)
                                .clickable(enabled = enabled) { onEvent(TransferEvent(key = action.key)) }
                                .padding(vertical = 12.dp)
                                .testTag("transfer-${action.key}")
                                .semantics { role = Role.Button },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TransferRow(row: centraid.core.v1.TransferRow, busy: Boolean, onEvent: (TransferEvent) -> Unit) {
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .then(
                    if (row.tappable && !busy) Modifier.clickable { onEvent(TransferEvent(key = row.key)) } else Modifier,
                )
                .padding(horizontal = 14.dp, vertical = 10.dp)
                .testTag("transfer-row-${row.key}")
                .semantics(mergeDescendants = true) { contentDescription = row.accessibility_label },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (row.icon_key.isNotEmpty()) KitTile(row.icon_key, Modifier.padding(end = 12.dp), size = 30.dp)
            KitText(row.label, KitType.Row, Surface.ink, modifier = Modifier.weight(1f))
            if (row.value_.isNotEmpty()) KitText(row.value_, KitType.Row, Surface.meta)
            if (row.tappable) CentraidIcon("ChevronRight", Surface.meta, size = 14.dp, modifier = Modifier.padding(start = 8.dp))
        }
        Spacer(Modifier.fillMaxWidth().height(KitGeometry.HAIRLINE).background(Surface.line))
    }
}
