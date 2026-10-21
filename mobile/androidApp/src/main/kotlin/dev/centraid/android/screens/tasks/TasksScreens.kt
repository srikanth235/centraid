package dev.centraid.android.screens.tasks

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import centraid.screen.v1.SectionHead
import centraid.screen.v1.TasksCatchUpEvent
import centraid.screen.v1.TasksCatchUpState
import centraid.screen.v1.TasksListEvent
import centraid.screen.v1.TasksListState
import centraid.screen.v1.TasksProjectEvent
import centraid.screen.v1.TasksProjectState
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.KitGeometry
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
import dev.centraid.design.copy.TasksCopy

/** `tasks.list`: one view (Anytime, All, Logbook, Reminders), pushed. */
@Composable
internal fun TasksListScreen(state: TasksListState, onEvent: (TasksListEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    PushedPage(title = state.title, parentTitle = chrome?.back?.ifEmpty { null } ?: TasksCopy.APP_TITLE, onBack = onBack) {
        Column(Modifier.fillMaxSize()) {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
                onRetry = { onEvent(TasksListEvent(refreshed = TasksListEvent.Refreshed())) },
                modifier = Modifier.weight(1f),
            ) { list ->
                val empty = list.empty
                if (list.groups.isEmpty() && empty != null) {
                    EmptyStateView(empty, onAction = null)
                } else {
                    LazyColumn(Modifier.fillMaxSize().testTag("tasks-list")) {
                        taskGroups(
                            list.groups,
                            onCheck = { onEvent(TasksListEvent(row_checked = TasksListEvent.RowChecked(task_id = it))) },
                            onPick = { onEvent(TasksListEvent(row_picked = TasksListEvent.RowPicked(task_id = it))) },
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
                                    onMore = { onEvent(TasksListEvent(next_page = TasksListEvent.NextPageRequested())) },
                                )
                            }
                        }
                    }
                }
            }
            StatusLine(state.status) { onEvent(TasksListEvent(status_acted = TasksListEvent.StatusActed())) }
        }
    }
}

/** `tasks.project`: its sections, a quick add that lands in one, Add section. */
@Composable
internal fun TasksProjectScreen(state: TasksProjectState, onEvent: (TasksProjectEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    val addSection = state.data_?.add_section_label.orEmpty()
    PushedPage(
        title = state.title,
        parentTitle = chrome?.back?.ifEmpty { null } ?: TasksCopy.APP_TITLE,
        onBack = onBack,
        trailing = if (addSection.isNotEmpty()) {
            RoomAction("FolderPlus", addSection, "tasks-add-section") { onEvent(TasksProjectEvent(add_section = TasksProjectEvent.AddSectionRequested())) }
        } else {
            null
        },
    ) {
        Column(Modifier.fillMaxSize()) {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
                onRetry = { onEvent(TasksProjectEvent(refreshed = TasksProjectEvent.Refreshed())) },
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
                        taskGroups(
                            project.groups,
                            onCheck = { onEvent(TasksProjectEvent(row_checked = TasksProjectEvent.RowChecked(task_id = it))) },
                            onPick = { onEvent(TasksProjectEvent(row_picked = TasksProjectEvent.RowPicked(task_id = it))) },
                            onVerb = { onEvent(TasksProjectEvent(group_verb = TasksProjectEvent.GroupVerb(key = it))) },
                        )
                    }
                }
            }
            StatusLine(state.status) { onEvent(TasksProjectEvent(status_acted = TasksProjectEvent.StatusActed())) }
            TasksQuickAddBar(
                quickAdd = state.quick_add,
                placeholder = chrome?.quick_add_placeholder.orEmpty(),
                verb = chrome?.quick_add_verb.orEmpty(),
                onChange = { onEvent(TasksProjectEvent(quick_add_changed = TasksProjectEvent.QuickAddChanged(title = it))) },
                onSubmit = { onEvent(TasksProjectEvent(quick_add_submitted = TasksProjectEvent.QuickAddSubmitted())) },
            )
        }
    }
    if (state.sheet == TasksProjectState.Sheet.SHEET_ADD_SECTION && chrome != null) {
        SheetRoom(
            title = chrome.add_section_title,
            onDismiss = { onEvent(TasksProjectEvent(sheet_closed = TasksProjectEvent.SheetClosed())) },
            primary = SheetPrimary(chrome.add_section_verb, enabled = state.new_section_can_submit) {
                onEvent(TasksProjectEvent(section_submitted = TasksProjectEvent.SectionSubmitted()))
            },
        ) {
            EditableFieldRow(
                key = "",
                value = state.new_section_name,
                reload = state.new_section_name.takeIf { it.isEmpty() },
                placeholder = chrome.add_section_placeholder,
                onEdit = { onEvent(TasksProjectEvent(section_name = TasksProjectEvent.SectionNameChanged(name = it))) },
                testTag = "tasks-new-section-field",
            )
        }
    }
}

/** `tasks.catch_up`: the piles, each with Complete all behind a confirm. */
@Composable
internal fun TasksCatchUpScreen(state: TasksCatchUpState, onEvent: (TasksCatchUpEvent) -> Unit, onBack: () -> Unit) {
    PushedPage(title = state.chrome?.title.orEmpty(), parentTitle = state.chrome?.back?.ifEmpty { null } ?: TasksCopy.APP_TITLE, onBack = onBack) {
        Column(Modifier.fillMaxSize()) {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
                onRetry = { onEvent(TasksCatchUpEvent(refreshed = TasksCatchUpEvent.Refreshed())) },
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
                                        SectionHead(title = pile.title, verb_label = if (pile.verb_enabled) pile.verb_label else ""),
                                        onVerb = { onEvent(TasksCatchUpEvent(complete_all = TasksCatchUpEvent.CompleteAllTapped(pile = pile.key))) },
                                    )
                                    if (pile.meta.isNotEmpty()) {
                                        Text(pile.meta, style = centraidType("annotLabel"), color = centraidColor("textSoft"), modifier = Modifier.padding(horizontal = KitGeometry.GUTTER))
                                    }
                                }
                            }
                            pile.rows.forEach { row ->
                                item(key = "row-${pile.key}-${row.task_id}") {
                                    TaskRowView(
                                        row,
                                        onCheck = { onEvent(TasksCatchUpEvent(row_checked = TasksCatchUpEvent.RowChecked(task_id = it))) },
                                        onPick = { onEvent(TasksCatchUpEvent(row_picked = TasksCatchUpEvent.RowPicked(task_id = it))) },
                                    )
                                }
                            }
                        }
                    }
                }
            }
            StatusLine(state.status) { onEvent(TasksCatchUpEvent(status_acted = TasksCatchUpEvent.StatusActed())) }
        }
    }
    val confirm = state.confirm
    if (confirm != null) {
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(TasksCatchUpEvent(confirmed = TasksCatchUpEvent.Confirmed())) },
            onDismiss = { onEvent(TasksCatchUpEvent(dismissed = TasksCatchUpEvent.Dismissed())) },
            cancelLabel = state.chrome?.cancel?.ifEmpty { null } ?: dev.centraid.android.kit.KitWords.CANCEL,
        )
    }
}
