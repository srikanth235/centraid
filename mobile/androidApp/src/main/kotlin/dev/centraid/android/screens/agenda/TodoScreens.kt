package dev.centraid.android.screens.agenda

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import centraid.core.v1.QuickAddChipDismissed
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
import dev.centraid.android.kit.CentraidIcon
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
                            menu = chrome?.let {
                                TodoRowMenu(
                                    it,
                                    onFlag = { id, on -> onEvent(TodoListEvent(row_flagged = TodoListEvent.RowFlagged(task_id = id, flagged = on))) },
                                    onDelete = { id -> onEvent(TodoListEvent(row_deleted = TodoListEvent.RowDeleted(task_id = id))) },
                                )
                            },
                        )
                        item(key = "foot") {
                            Column {
                                if (list.subtitle.isNotEmpty()) {
                                    Text(list.subtitle, style = centraidType("small"), color = centraidColor("textSoft"), modifier = Modifier.padding(KitGeometry.GUTTER))
                                }
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
                    val listColor = agendaListColor(project.list_color_key)
                    LazyColumn(Modifier.fillMaxSize().testTag("tasks-project")) {
                        // THE TITLE IN THE LIST'S COLOUR (#1173).
                        listColor?.let { color ->
                            item(key = "title") {
                                Row(Modifier.padding(horizontal = KitGeometry.GUTTER), verticalAlignment = Alignment.CenterVertically) {
                                    // THE LIST'S OWN ICON beside its name (#1173 wave 2).
                                    if (project.icon_key.isNotEmpty()) {
                                        CentraidIcon(project.icon_key, tint = color, size = 24.dp, modifier = Modifier.padding(end = 8.dp))
                                    }
                                    Text(state.title, style = centraidType("title"), color = color)
                                }
                            }
                        }
                        if (project.count_label.isNotEmpty()) {
                            item(key = "count") {
                                Text(project.count_label, style = centraidType("annotLabel"), color = centraidColor("textSoft"), modifier = Modifier.padding(horizontal = KitGeometry.GUTTER))
                            }
                        }
                        // "EDIT LIST" (#1173 wave 2) opens the style sheet: name, colour and icon.
                        if (project.style_label.isNotEmpty()) {
                            item(key = "style") {
                                KitLink(
                                    label = project.style_label,
                                    onClick = { onEvent(TodoProjectEvent(style_requested = TodoProjectEvent.StyleRequested())) },
                                    modifier = Modifier.testTag("tasks-project-edit").padding(horizontal = KitGeometry.GUTTER / 2),
                                )
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
                            menu = chrome?.let {
                                TodoRowMenu(
                                    it,
                                    onFlag = { id, on -> onEvent(TodoProjectEvent(row_flagged = TodoProjectEvent.RowFlagged(task_id = id, flagged = on))) },
                                    onDelete = { id -> onEvent(TodoProjectEvent(row_deleted = TodoProjectEvent.RowDeleted(task_id = id))) },
                                    onMove = { id, before -> onEvent(TodoProjectEvent(row_moved = TodoProjectEvent.RowMoved(task_id = id, before_id = before))) },
                                )
                            },
                        )
                        // "2 completed · Show · Clear", and the rows while shown.
                        val completed = project.completed
                        if (completed != null && completed.count > 0 && chrome != null) {
                            item(key = "completed") {
                                Row(
                                    Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp),
                                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(completed.count_label, style = centraidType("small"), color = centraidColor("textSoft"), modifier = Modifier.weight(1f))
                                    KitLink(
                                        label = if (completed.shown) chrome.hide_completed_verb else chrome.show_completed_verb,
                                        onClick = { onEvent(TodoProjectEvent(completed_toggled = TodoProjectEvent.CompletedToggled())) },
                                        modifier = Modifier.testTag("tasks-completed-toggle"),
                                    )
                                    KitLink(
                                        label = chrome.clear_completed_verb,
                                        onClick = { onEvent(TodoProjectEvent(completed_cleared = TodoProjectEvent.CompletedCleared())) },
                                        modifier = Modifier.testTag("tasks-completed-clear"),
                                    )
                                }
                            }
                            completed.rows.forEach { row ->
                                item(key = "done-${row.task_id}") {
                                    TodoRowView(row, onCheck = { onEvent(TodoProjectEvent(row_checked = TodoProjectEvent.RowChecked(task_id = it))) }, onOpen = onOpen)
                                }
                            }
                        }
                    }
                }
            }
            StatusLine(state.status) { onEvent(TodoProjectEvent(status_acted = TodoProjectEvent.StatusActed())) }
            TodoQuickAddBar(
                quickAdd = state.quick_add,
                placeholder = chrome?.new_reminder.orEmpty(),
                verb = chrome?.quick_add_verb.orEmpty(),
                onChange = { onEvent(TodoProjectEvent(quick_add_changed = TodoProjectEvent.QuickAddChanged(title = it))) },
                onSubmit = { onEvent(TodoProjectEvent(quick_add_submitted = TodoProjectEvent.QuickAddSubmitted())) },
                onTool = { onEvent(TodoProjectEvent(quick_tool = TodoProjectEvent.QuickToolPicked(key = it))) },
                onDue = { onEvent(TodoProjectEvent(quick_due = TodoProjectEvent.QuickDuePicked(key = it))) },
                onTag = { onEvent(TodoProjectEvent(quick_tag = TodoProjectEvent.QuickTagAdded(text = it))) },
                onDismissChip = { onEvent(TodoProjectEvent(quick_add_chip_dismissed = QuickAddChipDismissed())) },
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
        state.sheet == TodoProjectState.Sheet.SHEET_STYLE -> state.style?.let { style ->
            AgendaStyleSheetView(
                style = style,
                onName = { onEvent(TodoProjectEvent(style_name = TodoProjectEvent.StyleNameChanged(name = it))) },
                onColor = { onEvent(TodoProjectEvent(style_color = TodoProjectEvent.StyleColorPicked(key = it))) },
                onIcon = { onEvent(TodoProjectEvent(style_icon = TodoProjectEvent.StyleIconPicked(key = it))) },
                onSubmit = { onEvent(TodoProjectEvent(style_submitted = TodoProjectEvent.StyleSubmitted())) },
                onCancel = closeSheet,
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
