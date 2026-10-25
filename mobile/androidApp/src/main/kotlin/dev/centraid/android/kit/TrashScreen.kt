package dev.centraid.android.kit

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import centraid.core.v1.TrashEvent
import centraid.core.v1.TrashView

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
    val emptyLabel = data?.empty_label.orEmpty()
    PushedPage(
        title = view.title,
        parentTitle = view.back_label,
        onBack = onBack,
        trailing = if (emptyLabel.isNotEmpty()) {
            RoomAction("Trash", emptyLabel, "trash-empty") {
                onEvent(TrashEvent(empty = TrashEvent.EmptyTapped()))
            }
        } else {
            null
        },
        status = view.status?.sentence.orEmpty(),
    ) {
        ReadStateView(
            content = screenContentOf(view.loading, view.failure, view.data_, view.denied),
            onRetry = { onEvent(TrashEvent(refreshed = TrashEvent.Refreshed())) },
        ) { trash ->
            val empty = trash.empty
            if (trash.rows.isEmpty() && empty != null) {
                EmptyStateView(empty, onAction = null)
            } else {
                LazyColumn {
                    items(trash.rows, key = { it.id }) { row ->
                        CentraidRow(
                            title = row.title,
                            meta = row.meta,
                            testTag = "trash-row-${row.id}",
                        ) {
                            Row {
                                OutlineButton(
                                    label = row.restore_label,
                                    testTag = "trash-restore-${row.id}",
                                    modifier = Modifier.padding(start = 8.dp),
                                ) { onEvent(TrashEvent(restore = TrashEvent.RestoreTapped(id = row.id))) }
                                if (row.purge_label.isNotEmpty()) {
                                    OutlineButton(
                                        label = row.purge_label,
                                        testTag = "trash-purge-${row.id}",
                                        ink = "net",
                                        modifier = Modifier.padding(start = 8.dp),
                                    ) { onEvent(TrashEvent(purge = TrashEvent.PurgeTapped(id = row.id))) }
                                }
                            }
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
