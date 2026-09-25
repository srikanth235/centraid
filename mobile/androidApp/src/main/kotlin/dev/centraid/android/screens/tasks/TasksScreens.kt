package dev.centraid.android.screens.tasks

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import centraid.screen.v1.SearchField
import centraid.screen.v1.SectionHead
import centraid.screen.v1.TasksCatchUpEvent
import centraid.screen.v1.TasksCatchUpState
import centraid.screen.v1.TasksHomeEvent
import centraid.screen.v1.TasksHomeState
import centraid.screen.v1.TasksListEvent
import centraid.screen.v1.TasksListState
import centraid.screen.v1.TasksNotice
import centraid.screen.v1.TasksProjectEvent
import centraid.screen.v1.TasksProjectState
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.AppPlace
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.QuietButton
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RoomSearch
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.ShowMoreFooter
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.copy.TasksCopy

/** `tasks.home`: Today · Upcoming · Inbox · Projects in an `AppPlace`; More a sheet. */
@Composable
internal fun TasksHomeScreen(
    state: TasksHomeState,
    onEvent: (TasksHomeEvent) -> Unit,
    onHome: () -> Unit,
) {
    val chrome = state.chrome
    val data = state.data_
    val tabs = state.band.filter { it.key != "more" }
    val hasMore = state.band.any { it.key == "more" }
    AppPlace(
        app = "tasks",
        title = chrome?.title.orEmpty(),
        meta = data?.count_label.orEmpty(),
        trailing = if (state.denied == null && chrome != null) {
            RoomAction("Search", chrome.search_label, "tasks-search") { onEvent(TasksHomeEvent(search_opened = TasksHomeEvent.SearchOpened())) }
        } else {
            null
        },
        search = if (chrome != null) {
            RoomSearch(
                field = state.search ?: SearchField(),
                placeholder = chrome.search_placeholder,
                onTerm = { onEvent(TasksHomeEvent(search_term = TasksHomeEvent.SearchTermChanged(term = it))) },
                onClose = { onEvent(TasksHomeEvent(search_closed = TasksHomeEvent.SearchClosed())) },
                label = chrome.search_label,
                closeLabel = chrome.search_close,
            )
        } else {
            null
        },
        band = if (tabs.isEmpty()) {
            null
        } else {
            {
                AppBand(
                    app = "tasks",
                    tabs = tabs.map { AppBandTab(key = it.key, label = it.label, iconKey = it.icon_key, selected = it.current) },
                    onSelect = { key -> onEvent(TasksHomeEvent(band = TasksHomeEvent.BandPicked(key = key))) },
                    onHome = onHome,
                    onMore = if (hasMore) ({ onEvent(TasksHomeEvent(band = TasksHomeEvent.BandPicked(key = "more"))) }) else null,
                )
            }
        },
    ) {
        Column(Modifier.fillMaxSize()) {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, data, state.denied),
                onRetry = { onEvent(TasksHomeEvent(refreshed = TasksHomeEvent.Refreshed())) },
                retryLabel = chrome?.retry?.ifEmpty { null } ?: dev.centraid.android.kit.KitWords.RETRY,
                skeleton = { RowSkeleton(label = chrome?.loading?.ifEmpty { null } ?: dev.centraid.android.kit.KitWords.OPENING) },
                modifier = Modifier.weight(1f),
            ) { home ->
                val nothing = home.groups.isEmpty() && home.projects.isEmpty()
                val empty = home.empty
                if (nothing && empty != null) {
                    EmptyStateView(empty, onAction = { onEvent(TasksHomeEvent(empty_acted = TasksHomeEvent.EmptyActed())) })
                } else {
                    LazyColumn(Modifier.fillMaxSize()) {
                        val notice = home.notice
                        if (notice != null) {
                            item(key = "notice") {
                                TasksNoticeView(notice) { onEvent(TasksHomeEvent(notice_acted = TasksHomeEvent.NoticeActed())) }
                            }
                        }
                        home.projects.forEach { group ->
                            item(key = "projects-${group.key}") { SectionHeader(SectionHead(title = group.title)) }
                            items(group.rows, key = { "project-${it.id}" }) { row ->
                                CentraidRow(row) { onEvent(TasksHomeEvent(project_picked = TasksHomeEvent.ProjectPicked(project_id = row.id))) }
                            }
                        }
                        taskGroups(
                            home.groups,
                            onCheck = { onEvent(TasksHomeEvent(row_checked = TasksHomeEvent.RowChecked(task_id = it))) },
                            onPick = { onEvent(TasksHomeEvent(row_picked = TasksHomeEvent.RowPicked(task_id = it))) },
                            onVerb = { onEvent(TasksHomeEvent(group_verb = TasksHomeEvent.GroupVerb(key = it))) },
                            onFile = { onEvent(TasksHomeEvent(file_requested = TasksHomeEvent.FileRequested(task_id = it))) },
                            fileVerb = state.chrome?.file_verb.orEmpty(),
                        )
                        item(key = "foot") {
                            Column {
                                if (home.window_label.isNotEmpty()) {
                                    Text(
                                        home.window_label,
                                        style = centraidType("annotLabel"),
                                        color = centraidColor("textFaint"),
                                        modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                                    )
                                }
                                ShowMoreFooter(
                                    visible = home.can_show_more,
                                    loading = false,
                                    label = chrome?.show_more?.ifEmpty { null } ?: dev.centraid.android.kit.KitWords.SHOW_MORE,
                                    onMore = { onEvent(TasksHomeEvent(next_page = TasksHomeEvent.NextPageRequested())) },
                                )
                            }
                        }
                    }
                }
            }
            StatusLine(state.status) { onEvent(TasksHomeEvent(status_acted = TasksHomeEvent.StatusActed())) }
            TasksQuickAddBar(
                quickAdd = state.quick_add,
                placeholder = chrome?.quick_add_placeholder.orEmpty(),
                verb = chrome?.quick_add_verb.orEmpty(),
                onChange = { onEvent(TasksHomeEvent(quick_add_changed = TasksHomeEvent.QuickAddChanged(title = it))) },
                onSubmit = { onEvent(TasksHomeEvent(quick_add_submitted = TasksHomeEvent.QuickAddSubmitted())) },
            )
        }
    }
    TasksHomeSheets(state, onEvent)
}

@Composable
private fun TasksHomeSheets(state: TasksHomeState, onEvent: (TasksHomeEvent) -> Unit) {
    val chrome = state.chrome ?: return
    val close = { onEvent(TasksHomeEvent(sheet_closed = TasksHomeEvent.SheetClosed())) }
    when (state.sheet) {
        TasksHomeState.Sheet.SHEET_MORE -> OptionSheet(
            title = chrome.more_title,
            options = state.more_rows.map { it.option() },
            onPick = { onEvent(TasksHomeEvent(more_row = TasksHomeEvent.MoreRowPicked(key = it))) },
            onDismiss = close,
        )
        TasksHomeState.Sheet.SHEET_READS -> SheetRoom(title = chrome.reads_title, onDismiss = close) {
            chrome.reads_facts.forEach { FieldRow(key = it.label, value = it.detail) }
        }
        TasksHomeState.Sheet.SHEET_FILE -> SheetRoom(title = chrome.file_title, onDismiss = close) {
            state.file_choices.forEach { choice ->
                TasksChoiceRow(choice) { onEvent(TasksHomeEvent(file_chosen = TasksHomeEvent.FileChosen(key = it))) }
            }
        }
        TasksHomeState.Sheet.SHEET_NEW_PROJECT -> SheetRoom(
            title = chrome.new_project_title,
            onDismiss = close,
            primary = if (state.new_project_can_submit) {
                SheetPrimary(chrome.new_project_verb) { onEvent(TasksHomeEvent(new_project_submitted = TasksHomeEvent.NewProjectSubmitted())) }
            } else {
                null
            },
        ) {
            EditableFieldRow(
                key = "",
                value = state.new_project_name,
                reload = state.new_project_name.takeIf { it.isEmpty() },
                placeholder = chrome.new_project_placeholder,
                onEdit = { onEvent(TasksHomeEvent(new_project_name = TasksHomeEvent.NewProjectNameChanged(name = it))) },
                testTag = "tasks-new-project",
            )
        }
        else -> Unit
    }
}

@Composable
internal fun TasksNoticeView(notice: TasksNotice, onAct: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 10.dp)) {
        Text(notice.sentence, style = centraidType("body"), color = centraidColor("text"))
        if (notice.verb_label.isNotEmpty()) {
            QuietButton(notice.verb_label, testTag = "tasks-notice-act", modifier = Modifier.padding(top = 8.dp), onPress = onAct)
        }
    }
}

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
                    LazyColumn(Modifier.fillMaxSize()) {
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
                    LazyColumn(Modifier.fillMaxSize()) {
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
            primary = if (state.new_section_can_submit) {
                SheetPrimary(chrome.add_section_verb) { onEvent(TasksProjectEvent(section_submitted = TasksProjectEvent.SectionSubmitted())) }
            } else {
                null
            },
        ) {
            EditableFieldRow(
                key = "",
                value = state.new_section_name,
                reload = state.new_section_name.takeIf { it.isEmpty() },
                placeholder = chrome.add_section_placeholder,
                onEdit = { onEvent(TasksProjectEvent(section_name = TasksProjectEvent.SectionNameChanged(name = it))) },
                testTag = "tasks-new-section",
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
                    LazyColumn(Modifier.fillMaxSize()) {
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
