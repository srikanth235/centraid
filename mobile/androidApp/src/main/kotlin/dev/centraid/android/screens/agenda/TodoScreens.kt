package dev.centraid.android.screens.agenda

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import centraid.core.v1.Route
import centraid.core.v1.TodoCatchUpEvent
import centraid.core.v1.TodoCatchUpState
import centraid.core.v1.TodoListEvent
import centraid.core.v1.TodoListState
import centraid.core.v1.TodoProjectEvent
import centraid.core.v1.TodoProjectState
import dev.centraid.android.kit.SectionHead
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.ShowMoreFooter
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/** `agenda.todo_list`: one view (Anytime, All, Logbook, Reminders), pushed. */
@Composable
internal fun TodoListScreen(
    state: TodoListState,
    onEvent: (TodoListEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onBack: () -> Unit,
) {
    val chrome = state.chrome
    PushedPage(title = state.title, parentTitle = chrome?.back.orEmpty(), onBack = onBack) {
        Column(Modifier.fillMaxSize()) {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
                onRetry = { onEvent(TodoListEvent(refreshed = TodoListEvent.Refreshed())) },
                retryLabel = chrome?.retry?.ifEmpty { null } ?: KitWords.RETRY,
                modifier = Modifier.weight(1f),
            ) { list ->
                val empty = list.empty
                if (list.groups.isEmpty() && empty != null) {
                    EmptyStateView(empty, onAction = null)
                } else {
                    LazyColumn(Modifier.fillMaxSize().testTag("tasks-list")) {
                        todoGroups(
                            list.groups,
                            onCheck = { onEvent(TodoListEvent(row_checked = TodoListEvent.RowChecked(task_id = it))) },
                            onOpen = onOpen,
                            onVerb = { },
                        )
                        item(key = "foot") {
                            Column {
                                if (list.window_label.isNotEmpty()) {
                                    Text(list.window_label, style = centraidType("annotLabel"), color = centraidColor("textFaint"), modifier = Modifier.padding(KitGeometry.GUTTER))
                                }
                                ShowMoreFooter(
                                    visible = list.can_show_more,
                                    loading = false,
                                    label = chrome?.show_more?.ifEmpty { null } ?: KitWords.SHOW_MORE,
                                    onMore = { onEvent(TodoListEvent(next_page = TodoListEvent.NextPageRequested())) },
                                )
                            }
                        }
                    }
                }
            }
            StatusLine(state.status) { onEvent(TodoListEvent(status_acted = TodoListEvent.StatusActed())) }
        }
    }
}

/** `agenda.project`: its sections, a quick add that lands in one, Add section, Rename. */
@Composable
internal fun TodoProjectScreen(
    state: TodoProjectState,
    onEvent: (TodoProjectEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onBack: () -> Unit,
) {
    val chrome = state.chrome
    val data = state.data_
    val addSection = data?.add_section_label.orEmpty()
    val rename = data?.rename_label.orEmpty()
    PushedPage(
        title = state.title,
        parentTitle = chrome?.back.orEmpty(),
        onBack = onBack,
        trailing = if (addSection.isNotEmpty()) {
            RoomAction("FolderPlus", addSection, "tasks-add-section") { onEvent(TodoProjectEvent(add_section = TodoProjectEvent.AddSectionRequested())) }
        } else {
            null
        },
    ) {
        Column(Modifier.fillMaxSize()) {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
                onRetry = { onEvent(TodoProjectEvent(refreshed = TodoProjectEvent.Refreshed())) },
                retryLabel = chrome?.retry?.ifEmpty { null } ?: KitWords.RETRY,
                modifier = Modifier.weight(1f),
            ) { project ->
                val empty = project.empty
                if (project.groups.isEmpty() && empty != null) {
                    EmptyStateView(empty, onAction = null)
                } else {
                    LazyColumn(Modifier.fillMaxSize().testTag("tasks-project")) {
                        if (project.count_label.isNotEmpty()) {
                            item(key = "count") {
                                Text(project.count_label, style = centraidType("annotLabel"), color = centraidColor("textSoft"), modifier = Modifier.padding(horizontal = KitGeometry.GUTTER))
                            }
                        }
                        // THE RENAME VERB: the header holds one action (Add section), so this one is a quiet link under it.
                        if (rename.isNotEmpty()) {
                            item(key = "rename") {
                                KitLink(
                                    label = rename,
                                    onClick = { onEvent(TodoProjectEvent(rename = TodoProjectEvent.RenameRequested())) },
                                    modifier = Modifier.testTag("tasks-rename").padding(horizontal = KitGeometry.GUTTER / 2),
                                )
                            }
                        }
                        todoGroups(
                            project.groups,
                            onCheck = { onEvent(TodoProjectEvent(row_checked = TodoProjectEvent.RowChecked(task_id = it))) },
                            onOpen = onOpen,
                            onVerb = { onEvent(TodoProjectEvent(group_verb = TodoProjectEvent.GroupVerb(key = it))) },
                        )
                    }
                }
            }
            StatusLine(state.status) { onEvent(TodoProjectEvent(status_acted = TodoProjectEvent.StatusActed())) }
            TodoQuickAddBar(
                quickAdd = state.quick_add,
                placeholder = chrome?.quick_add_placeholder.orEmpty(),
                verb = chrome?.quick_add_verb.orEmpty(),
                onChange = { onEvent(TodoProjectEvent(quick_add_changed = TodoProjectEvent.QuickAddChanged(title = it))) },
                onSubmit = { onEvent(TodoProjectEvent(quick_add_submitted = TodoProjectEvent.QuickAddSubmitted())) },
            )
        }
    }
    val closeSheet = { onEvent(TodoProjectEvent(sheet_closed = TodoProjectEvent.SheetClosed())) }
    when {
        state.sheet == TodoProjectState.Sheet.SHEET_ADD_SECTION && chrome != null -> SheetRoom(
            title = chrome.add_section_title,
            onDismiss = closeSheet,
            primary = SheetPrimary(chrome.add_section_verb, enabled = state.new_section_can_submit) {
                onEvent(TodoProjectEvent(section_submitted = TodoProjectEvent.SectionSubmitted()))
            },
        ) {
            EditableFieldRow(
                key = "",
                value = state.new_section_name,
                reload = state.new_section_name.takeIf { it.isEmpty() },
                placeholder = chrome.add_section_placeholder,
                onEdit = { onEvent(TodoProjectEvent(section_name = TodoProjectEvent.SectionNameChanged(name = it))) },
                testTag = "tasks-new-section-field",
            )
        }
        state.sheet == TodoProjectState.Sheet.SHEET_RENAME && data != null -> SheetRoom(
            title = data.rename_title,
            onDismiss = closeSheet,
            primary = SheetPrimary(data.rename_verb, enabled = state.rename_can_submit) {
                onEvent(TodoProjectEvent(rename_submitted = TodoProjectEvent.RenameSubmitted()))
            },
        ) {
            // THE FIELD OPENS ON THE PROJECT'S OWN NAME (the machine's `rename_name`) and is typed over.
            EditableFieldRow(
                key = "",
                value = state.rename_name,
                reload = null,
                placeholder = data.rename_placeholder,
                onEdit = { onEvent(TodoProjectEvent(rename_name = TodoProjectEvent.RenameNameChanged(name = it))) },
                testTag = "tasks-rename-field",
            )
        }
    }
}

/** `agenda.catch_up`: the piles, each with Complete all behind a confirm. */
@Composable
internal fun TodoCatchUpScreen(
    state: TodoCatchUpState,
    onEvent: (TodoCatchUpEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onBack: () -> Unit,
) {
    val chrome = state.chrome
    PushedPage(title = chrome?.title.orEmpty(), parentTitle = chrome?.back.orEmpty(), onBack = onBack) {
        Column(Modifier.fillMaxSize()) {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
                onRetry = { onEvent(TodoCatchUpEvent(refreshed = TodoCatchUpEvent.Refreshed())) },
                retryLabel = chrome?.retry?.ifEmpty { null } ?: KitWords.RETRY,
                modifier = Modifier.weight(1f),
            ) { catchUp ->
                val empty = catchUp.empty
                if (catchUp.piles.isEmpty() && empty != null) {
                    EmptyStateView(empty, onAction = null)
                } else {
                    LazyColumn(Modifier.fillMaxSize().testTag("tasks-catch-up")) {
                        if (catchUp.head.isNotEmpty()) {
                            item(key = "head") {
                                Text(catchUp.head, style = centraidType("body"), color = centraidColor("textSoft"), modifier = Modifier.padding(horizontal = KitGeometry.GUTTER))
                            }
                        }
                        catchUp.piles.forEach { pile ->
                            item(key = "pile-${pile.key}") {
                                Column {
                                    SectionHeader(
                                        SectionHead(title = pile.title, verb_label = pile.verb_label),
                                        onVerb = { onEvent(TodoCatchUpEvent(complete_all = TodoCatchUpEvent.CompleteAllTapped(pile = pile.key))) },
                                    )
                                    if (pile.meta.isNotEmpty()) {
                                        Text(pile.meta, style = centraidType("annotLabel"), color = centraidColor("textSoft"), modifier = Modifier.padding(horizontal = KitGeometry.GUTTER))
                                    }
                                }
                            }
                            pile.rows.forEach { row ->
                                item(key = "row-${pile.key}-${row.task_id}") {
                                    TodoRowView(
                                        row,
                                        onCheck = { onEvent(TodoCatchUpEvent(row_checked = TodoCatchUpEvent.RowChecked(task_id = it))) },
                                        onOpen = onOpen,
                                    )
                                }
                            }
                        }
                    }
                }
            }
            StatusLine(state.status) { onEvent(TodoCatchUpEvent(status_acted = TodoCatchUpEvent.StatusActed())) }
        }
    }
    val confirm = state.confirm
    if (confirm != null) {
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(TodoCatchUpEvent(confirmed = TodoCatchUpEvent.Confirmed())) },
            onDismiss = { onEvent(TodoCatchUpEvent(dismissed = TodoCatchUpEvent.Dismissed())) },
            cancelLabel = chrome?.cancel?.ifEmpty { null } ?: KitWords.CANCEL,
        )
    }
}
