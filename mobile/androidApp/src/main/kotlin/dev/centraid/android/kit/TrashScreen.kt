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
import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.TrashListState
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
        status = write?.refusal.orEmpty(),
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
                                OutlineButton(
                                    label = row.restore_label.ifEmpty { SharedCopy.TRASH_RESTORE },
                                    testTag = "trash-restore-${row.id}",
                                    modifier = Modifier.padding(start = 8.dp),
                                ) { onEvent(TrashListEvent(restore = TrashListEvent.RestoreTapped(id = row.id))) }
                                if (row.purge_label.isNotEmpty()) {
                                    OutlineButton(
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

/**
 * THE KIT'S TRASH FROM THE SCREEN RUNTIME (#1135): `<app>.trash`, drawn from
 * `ViewState.trash`. The same page as [TrashListScreen] — the old one stays
 * while an app still passes `TrashListState` — but every word, the back label
 * and the ordering are the view's, so there is no fallback copy here; a pop is
 * the shell's ([onBack]) and a tap is a [TrashEvent].
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
                EmptyStateView(empty.toKit(), onAction = null)
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
            confirm = confirm.toKit(),
            onConfirm = { onEvent(TrashEvent(confirmed = TrashEvent.Confirmed())) },
            onDismiss = { onEvent(TrashEvent(dismissed = TrashEvent.Dismissed())) },
        )
    }
}
