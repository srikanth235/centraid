package dev.centraid.android.kit

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.TrashListState
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.SharedCopy

/**
 * EVERY APP'S TRASH, DRAWN ONCE (K5; the kit `TrashMachine`, #1015 D1).
 *
 * One parameterised screen (law 2): the state carries `app_id`, the rows carry
 * their own "Delete forever" label (empty when the app has no destroy path),
 * and the data carries "Empty trash" (empty when there is nothing to empty or
 * no command to do it). The title, the back label and each row's "Restore"
 * are the state's words (the copy file's only while the state is still empty).
 * A `PushedPage` back to the state's `back_label`; the one trailing
 * action is Empty trash; a confirm is the machine's `Confirm` in a
 * [ConfirmSheet]; a refused write is the page's status line.
 */
@Composable
public fun TrashListScreen(
    state: TrashListState,
    onEvent: (TrashListEvent) -> Unit,
    onBack: () -> Unit,
    parentTitle: String = "",
) {
    val data = state.data_
    val emptyLabel = data?.empty_label.orEmpty()
    val write = state.write
    PushedPage(
        title = state.title.ifEmpty { SharedCopy.TRASH_TITLE },
        parentTitle = state.back_label.ifEmpty { parentTitle },
        onBack = onBack,
        trailing = if (emptyLabel.isNotEmpty()) {
            RoomAction("Trash", emptyLabel, "trash-empty") {
                onEvent(TrashListEvent(empty = TrashListEvent.EmptyTapped()))
            }
        } else {
            null
        },
        status = if (write?.phase == WriteState.Phase.PHASE_REFUSED) write.failure?.sentence.orEmpty() else "",
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(TrashListEvent(refreshed = TrashListEvent.Refreshed())) },
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
                                QuietButton(
                                    label = row.restore_label.ifEmpty { SharedCopy.TRASH_RESTORE },
                                    testTag = "trash-restore-${row.id}",
                                    modifier = Modifier.padding(start = 8.dp),
                                ) { onEvent(TrashListEvent(restore = TrashListEvent.RestoreTapped(id = row.id))) }
                                if (row.purge_label.isNotEmpty()) {
                                    QuietButton(
                                        label = row.purge_label,
                                        testTag = "trash-purge-${row.id}",
                                        ink = "net",
                                        modifier = Modifier.padding(start = 8.dp),
                                    ) { onEvent(TrashListEvent(purge = TrashListEvent.PurgeTapped(id = row.id))) }
                                }
                            }
                        }
                    }
                    item(key = "foot") {
                        ShowMoreFooter(
                            visible = trash.next_cursor != null,
                            loading = state.first_page_pending,
                            onMore = { onEvent(TrashListEvent(next_page = TrashListEvent.NextPageRequested())) },
                        )
                    }
                }
            }
        }
    }
    val confirm = state.confirm
    if (confirm != null) {
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(TrashListEvent(confirmed = TrashListEvent.Confirmed())) },
            onDismiss = { onEvent(TrashListEvent(dismissed = TrashListEvent.Dismissed())) },
        )
    }
}
