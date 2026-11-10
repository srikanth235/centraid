package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import centraid.core.v1.TrashEvent
import centraid.core.v1.TrashView
import dev.centraid.android.theme.centraidType

/**
 * EVERY APP'S TRASH, DRAWN ONCE, FROM THE SCREEN RUNTIME (#1135): `<app>.trash`,
 * drawn from `ViewState.trash`. Every word, the back label and the ordering are
 * the view's, so there is no fallback copy here; a pop is the shell's ([onBack])
 * and a tap is a [TrashEvent].
 */
@Composable
public fun TrashScreen(
    view: TrashView,
    onEvent: (TrashEvent) -> Unit,
    onBack: () -> Unit,
) {
    val data = view.data_
    PushedPage(
        title = view.title,
        parentTitle = view.back_label,
        onBack = onBack,
        statusLine = {
            StatusLine(view.status, actTag = "trash-status-action") {
                onEvent(TrashEvent(status_acted = TrashEvent.StatusActed()))
            }
        },
        meta = data?.count_label.orEmpty(),
    ) {
        ReadStateView(
            content = screenContentOf(view.loading, view.failure, view.data_, view.denied),
            onRetry = { onEvent(TrashEvent(refreshed = TrashEvent.Refreshed())) },
        ) { trash ->
            val empty = trash.empty
            if (trash.rows.isEmpty() && empty != null) {
                EmptyStateView(empty, onAction = null)
            } else {
                LazyColumn(Modifier.padding(horizontal = KitGeometry.GUTTER)) {
                    item(key = "rows") {
                        // THE ROWS ARE ONE CARD (#1173); the last hairline falls outside the clip.
                        Column(Modifier.padding(top = 4.dp).kitCard()) {
                            trash.rows.forEach { row -> TrashRow(row, onEvent) }
                        }
                    }
                    if (trash.empty_label.isNotEmpty()) {
                        item(key = "empty-all") {
                            Text(
                                trash.empty_label,
                                style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
                                color = StateColor.Red.text,
                                modifier = Modifier
                                    .heightIn(min = KitGeometry.ROW_MIN)
                                    .clickable { onEvent(TrashEvent(empty = TrashEvent.EmptyTapped())) }
                                    .padding(vertical = 12.dp)
                                    .testTag("trash-empty")
                                    .semantics { role = Role.Button },
                            )
                        }
                    }
                }
            }
        }
    }
    val confirm = view.confirm
    if (confirm != null) {
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(TrashEvent(confirmed = TrashEvent.Confirmed())) },
            onDismiss = { onEvent(TrashEvent(dismissed = TrashEvent.Dismissed())) },
        )
    }
}

@Composable
private fun TrashRow(row: centraid.core.v1.TrashRow, onEvent: (TrashEvent) -> Unit) {
    val accent = appAccent()
    Column {
        Row(
            // THE BOARD'S ROW: 10 above and below, 14 before the tile, 6 after the bin.
            Modifier.fillMaxWidth().padding(start = 14.dp, end = 6.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (row.icon_key.isNotEmpty()) KitTile(row.icon_key, Modifier.padding(end = 12.dp), size = 30.dp)
            Column(
                Modifier.weight(1f).testTag("trash-row-${row.id}").semantics(mergeDescendants = true) { },
            ) {
                KitText(row.title, KitType.Row, Surface.ink, maxLines = 2)
                if (row.meta.isNotEmpty()) KitText(row.meta, KitType.Meta, Surface.meta, maxLines = 2)
            }
            Text(
                row.restore_label,
                style = centraidType("smallStrong"),
                color = accent.text,
                modifier = Modifier
                    .heightIn(min = KitGeometry.ROW_MIN)
                    .clickable { onEvent(TrashEvent(restore = TrashEvent.RestoreTapped(id = row.id))) }
                    .padding(horizontal = 10.dp, vertical = 12.dp)
                    .testTag("trash-restore-${row.id}")
                    .semantics { role = Role.Button },
            )
            if (row.purge_label.isNotEmpty()) {
                Box(
                    Modifier
                        .size(KitGeometry.ROW_MIN)
                        .clickable { onEvent(TrashEvent(purge = TrashEvent.PurgeTapped(id = row.id))) }
                        .testTag("trash-purge-${row.id}")
                        .clearAndSetSemantics {
                            contentDescription = row.purge_label
                            role = Role.Button
                        },
                    contentAlignment = Alignment.Center,
                ) { CentraidIcon("Trash", StateColor.Red.text, size = 16.dp) }
            }
        }
        Spacer(Modifier.fillMaxWidth().height(KitGeometry.HAIRLINE).background(Surface.line))
    }
}
