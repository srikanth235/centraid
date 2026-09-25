package dev.centraid.android.screens.notes

import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import centraid.screen.v1.NotesHistoryEvent
import centraid.screen.v1.NotesHistoryState
import centraid.screen.v1.NotesJournalEvent
import centraid.screen.v1.NotesJournalState
import centraid.screen.v1.NotesLinkPickerEvent
import centraid.screen.v1.NotesLinkPickerState
import centraid.screen.v1.NotesNotebooksEvent
import centraid.screen.v1.NotesNotebooksState
import centraid.screen.v1.SearchField
import centraid.screen.v1.WriteState
import dev.centraid.android.kit.AppPlace
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.CentraidSearchField
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.FailureView
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.QuietButton
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.ScreenContent
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.screenContentOf
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import dev.centraid.android.kit.KitGeometry

/**
 * NOTEBOOKS (#1029 app port): the Unfiled row and every notebook with its
 * count, a create sheet, More (Trash) as a sheet. A notebook pick is the
 * route's (a library filtered to it).
 */
@Composable
public fun NotesNotebooksScreen(
    state: NotesNotebooksState,
    onEvent: (NotesNotebooksEvent) -> Unit,
    onHome: () -> Unit,
) {
    val chrome = state.chrome
    val write = state.write
    AppPlace(
        app = "notes",
        title = chrome?.title.orEmpty(),
        trailing = chrome?.let {
            RoomAction("FolderPlus", it.new_notebook, "notes-new-notebook") {
                onEvent(NotesNotebooksEvent(create_opened = NotesNotebooksEvent.CreateOpened()))
            }
        },
        status = if (write?.phase == WriteState.Phase.PHASE_REFUSED && !state.creating) write.failure?.sentence.orEmpty() else "",
        band = { NotesBandView(state.band, { key -> onEvent(NotesNotebooksEvent(band = NotesNotebooksEvent.BandPicked(key))) }, onHome) },
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(NotesNotebooksEvent(refreshed = NotesNotebooksEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty(),
            skeleton = { RowSkeleton(meta = false, label = chrome?.loading.orEmpty()) },
        ) { data ->
            LazyColumn(Modifier.testTag("notes-notebooks")) {
                items(data.rows, key = { it.id }) { row ->
                    CentraidRow(row) {
                        onEvent(NotesNotebooksEvent(notebook_picked = NotesNotebooksEvent.NotebookPicked(row.id, row.title)))
                    }
                }
                val empty = data.empty
                if (empty != null) {
                    item(key = "empty") {
                        EmptyStateView(empty, onAction = { onEvent(NotesNotebooksEvent(create_opened = NotesNotebooksEvent.CreateOpened())) })
                    }
                }
            }
        }
    }
    if (state.creating && chrome != null) {
        SheetRoom(
            title = chrome.new_notebook,
            onDismiss = { onEvent(NotesNotebooksEvent(create_dismissed = NotesNotebooksEvent.CreateDismissed())) },
            status = if (write?.phase == WriteState.Phase.PHASE_REFUSED) write.failure?.sentence.orEmpty() else "",
            primary = if (state.create_enabled) {
                SheetPrimary(chrome.create, testTag = "notes-notebook-create") {
                    onEvent(NotesNotebooksEvent(create_confirmed = NotesNotebooksEvent.CreateConfirmed()))
                }
            } else {
                null
            },
        ) {
            EditableFieldRow(
                key = "",
                value = state.draft_name,
                reload = true,
                placeholder = chrome.name_placeholder,
                testTag = "notes-notebook-name",
                onEdit = { onEvent(NotesNotebooksEvent(name = NotesNotebooksEvent.NameEdited(it))) },
            )
            SheetRow(chrome.cancel, testTag = "notes-notebook-cancel", onTap = {
                onEvent(NotesNotebooksEvent(create_dismissed = NotesNotebooksEvent.CreateDismissed()))
            })
        }
    }
    if (state.more_open) {
        MoreTrashSheet(
            title = state.chrome?.more_title.orEmpty(),
            label = state.trash_label,
            onTrash = { onEvent(NotesNotebooksEvent(trash_opened = NotesNotebooksEvent.TrashOpened())) },
            onDismiss = { onEvent(NotesNotebooksEvent(more_closed = NotesNotebooksEvent.MoreClosed())) },
        )
    }
}

/** More on Notebooks and Journal: one row, Trash. */
@Composable
private fun MoreTrashSheet(title: String, label: String, onTrash: () -> Unit, onDismiss: () -> Unit) {
    SheetRoom(title = title.ifEmpty { dev.centraid.design.copy.NotesCopy.MORE_TITLE }, onDismiss = onDismiss) {
        SheetRow(label, iconKey = "Trash", testTag = "notes-more-trash", onTap = onTrash)
    }
}

/**
 * THE JOURNAL (#1029 app port): the core's local days as sections, each
 * entry a row; a new entry today is an intent the route answers.
 */
@Composable
public fun NotesJournalScreen(
    state: NotesJournalState,
    onEvent: (NotesJournalEvent) -> Unit,
    onHome: () -> Unit,
) {
    val chrome = state.chrome
    val today = state.data_?.today.orEmpty()
    AppPlace(
        app = "notes",
        title = chrome?.title.orEmpty(),
        meta = chrome?.origin.orEmpty(),
        trailing = chrome?.let {
            RoomAction("Plus", it.new_entry, "notes-new-entry") {
                onEvent(NotesJournalEvent(new_entry = NotesJournalEvent.NewEntryRequested(today)))
            }
        },
        band = { NotesBandView(state.band, { key -> onEvent(NotesJournalEvent(band = NotesJournalEvent.BandPicked(key))) }, onHome) },
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(NotesJournalEvent(refreshed = NotesJournalEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty(),
            skeleton = { RowSkeleton(label = chrome?.loading.orEmpty()) },
        ) { data ->
            val empty = data.empty
            if (data.days.isEmpty() && empty != null) {
                EmptyStateView(empty, onAction = { onEvent(NotesJournalEvent(new_entry = NotesJournalEvent.NewEntryRequested(data.today))) })
            } else {
                LazyColumn(Modifier.testTag("notes-journal")) {
                    data.days.forEach { day ->
                        day.head?.let { head -> item(key = "d-" + day.day) { SectionHeader(head) } }
                        items(day.rows, key = { day.day + "-" + it.id }) { row ->
                            CentraidRow(row) {
                                onEvent(NotesJournalEvent(entry_picked = NotesJournalEvent.EntryPicked(row.id, row.title)))
                            }
                        }
                    }
                    if (data.truncated && data.window_end_verb.isNotEmpty()) {
                        item(key = "window") {
                            QuietButton(
                                data.window_end_verb,
                                testTag = "notes-journal-widen",
                                modifier = Modifier.padding(KitGeometry.GUTTER),
                            ) { onEvent(NotesJournalEvent(window_widened = NotesJournalEvent.WindowWidened())) }
                        }
                    }
                }
            }
        }
    }
    if (state.more_open) {
        MoreTrashSheet(
            title = state.chrome?.more_title.orEmpty(),
            label = state.trash_label,
            onTrash = { onEvent(NotesJournalEvent(trash_opened = NotesJournalEvent.TrashOpened())) },
            onDismiss = { onEvent(NotesJournalEvent(more_closed = NotesJournalEvent.MoreClosed())) },
        )
    }
}

/**
 * ONE NOTE'S HISTORY (#1029 app port): a `PushedPage` back to the note, each
 * version a row with Restore; the current one has none.
 */
@Composable
public fun NotesHistoryScreen(
    state: NotesHistoryState,
    onEvent: (NotesHistoryEvent) -> Unit,
    parentTitle: String,
    onBack: () -> Unit,
) {
    val chrome = state.chrome
    val write = state.write
    PushedPage(
        title = chrome?.title.orEmpty(),
        parentTitle = parentTitle,
        onBack = onBack,
        status = if (write?.phase == WriteState.Phase.PHASE_REFUSED) write.failure?.sentence.orEmpty() else "",
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(NotesHistoryEvent(refreshed = NotesHistoryEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty(),
            skeleton = { RowSkeleton(label = chrome?.loading.orEmpty()) },
        ) { data ->
            val empty = data.empty
            if (data.rows.isEmpty() && empty != null) {
                EmptyStateView(empty, onAction = null)
            } else {
                LazyColumn(Modifier.testTag("notes-history")) {
                    items(data.rows, key = { it.content_id }) { row ->
                        CentraidRow(
                            title = row.label,
                            meta = row.preview,
                            pending = row.content_id == state.restoring_content_id,
                            testTag = "notes-version-${row.content_id}",
                        ) {
                            if (row.restore_label.isNotEmpty() && !row.current) {
                                QuietButton(
                                    row.restore_label,
                                    testTag = "notes-restore-${row.content_id}",
                                    modifier = Modifier.padding(start = 8.dp),
                                ) { onEvent(NotesHistoryEvent(restore = NotesHistoryEvent.RestoreTapped(row.content_id))) }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * THE POWERBOX (#1029 app port): a choices sheet over the editor, its own
 * search field, targets grouped by domain. A pick and a dismissal are the
 * route's to forward to the editor.
 */
@Composable
public fun NotesLinkPickerSheet(
    state: NotesLinkPickerState,
    onEvent: (NotesLinkPickerEvent) -> Unit,
) {
    val chrome = state.chrome
    val dismiss = { onEvent(NotesLinkPickerEvent(dismissed = NotesLinkPickerEvent.Dismissed())) }
    SheetRoom(title = chrome?.title.orEmpty(), onDismiss = dismiss, status = chrome?.foot.orEmpty()) {
        CentraidSearchField(
            field = SearchField(open_ = true, term = state.term),
            placeholder = chrome?.search_placeholder.orEmpty(),
            label = chrome?.search_placeholder.orEmpty(),
            closeLabel = chrome?.close.orEmpty(),
            onTerm = { term -> onEvent(NotesLinkPickerEvent(term = NotesLinkPickerEvent.TermChanged(term))) },
            onClose = dismiss,
            testTag = "notes-link-search",
        )
        when (val content = screenContentOf(state.loading, state.failure, state.data_, state.denied)) {
            is ScreenContent.Loading -> RowSkeleton(rows = 4, label = chrome?.loading.orEmpty())
            is ScreenContent.Failure -> FailureView(content.sentence, content.remedy, onRetry = null)
            is ScreenContent.Gate -> Quiet(content.denied.title)
            is ScreenContent.Data -> {
                val data = content.value
                val empty = data.empty
                if (data.domains.isEmpty() && empty != null) {
                    Quiet(listOf(empty.headline, empty.body).filter { it.isNotEmpty() }.joinToString(" "))
                }
                LazyColumn(Modifier.testTag("notes-link-targets")) {
                    data.domains.forEachIndexed { index, domain ->
                        domain.head?.let { head -> item(key = "h-$index") { SectionHeader(head) } }
                        items(domain.rows, key = { "$index-" + it.entity + it.id }) { target ->
                            CentraidRow(
                                title = target.title,
                                meta = target.subtitle,
                                a11y = target.accessibility_label,
                                testTag = "notes-link-${target.id}",
                                onTap = { onEvent(NotesLinkPickerEvent(picked = NotesLinkPickerEvent.TargetPicked(target))) },
                            )
                        }
                    }
                }
            }
        }
    }
}
