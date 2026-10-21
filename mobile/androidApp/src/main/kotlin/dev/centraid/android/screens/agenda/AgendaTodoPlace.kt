package dev.centraid.android.screens.agenda

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import centraid.screen.v1.AgendaHomeEvent
import centraid.screen.v1.AgendaHomeState
import centraid.screen.v1.AgendaTodo
import centraid.screen.v1.SectionHead
import centraid.screen.v1.TasksChrome
import centraid.screen.v1.TasksNotice
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.ShowMoreFooter
import dev.centraid.android.screens.tasks.TasksChoiceRow
import dev.centraid.android.screens.tasks.taskGroups
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/** The id prefix every task row on Agenda carries: `agenda-task-row-<id>`, its box `agenda-task-row-check-<id>`. */
internal const val AGENDA_TASK_ROW: String = "agenda-task-row"

/**
 * WHAT A TASK ROW ON AGENDA SENDS (#1128, R-1128-2): its box checks it off in
 * place, a tap opens it, a long press offers "Move to project", and a group's
 * quiet verb (Overdue's "Reschedule") sends its key. [fileVerb] is the
 * machine's word for the long press (`TasksChrome.file_verb`); a row offers
 * filing only when the row says so (`can_file`) and the verb is not empty.
 * Day, Schedule, To-do and a search's hits draw the same rows, so they share
 * one set of events.
 */
internal class AgendaTaskActions(
    val onCheck: (String) -> Unit,
    val onPick: (String) -> Unit,
    val onFile: (String) -> Unit,
    val onVerb: (String) -> Unit,
    val fileVerb: String,
)

internal fun agendaTaskActions(words: TasksChrome, onEvent: (AgendaHomeEvent) -> Unit): AgendaTaskActions =
    AgendaTaskActions(
        onCheck = { onEvent(AgendaHomeEvent(task_checked = AgendaHomeEvent.TaskChecked(task_id = it))) },
        onPick = { onEvent(AgendaHomeEvent(task_picked = AgendaHomeEvent.TaskPicked(task_id = it))) },
        onFile = { onEvent(AgendaHomeEvent(file_requested = AgendaHomeEvent.FileRequested(task_id = it))) },
        onVerb = { onEvent(AgendaHomeEvent(group_verb = AgendaHomeEvent.GroupVerb(key = it))) },
        fileVerb = words.file_verb,
    )

/**
 * TO-DO (#1128, R-1128-1): the Inbox's groups, then the projects by area, in
 * one list; the quick-add bar and the status line are the home's (they dock
 * under every place's list). Every word is the machine's: the groups and rows
 * are `TasksRowGroup`s, the projects `ListRow`s under an area's head, the
 * counts and the window sentence finished.
 *
 * **EMPTY** draws the machine's `empty` (day one's words, or "all done" with
 * the phone's reminders offered — Android has no reminders to read, so the
 * state's own action stands). The new-project verb is drawn at the foot of the
 * list WHATEVER IT HOLDS (the sheet is reachable always); under an empty state
 * that already carries it as its action, it is not drawn twice.
 */
@Composable
internal fun AgendaTodoPlace(
    todo: AgendaTodo,
    words: TasksChrome,
    actions: AgendaTaskActions,
    onEvent: (AgendaHomeEvent) -> Unit,
) {
    val empty = todo.empty
    val openNewProject = {
        onEvent(AgendaHomeEvent(sheet_opened = AgendaHomeEvent.SheetOpened(sheet = AgendaHomeState.Sheet.SHEET_NEW_PROJECT)))
    }
    if (todo.groups.isEmpty() && todo.projects.isEmpty() && empty != null) {
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                EmptyStateView(
                    empty,
                    onAction = if (empty.action_label.isNotEmpty()) {
                        { onEvent(AgendaHomeEvent(todo_empty_acted = AgendaHomeEvent.TodoEmptyActed())) }
                    } else {
                        null
                    },
                )
            }
            if (empty.action_label.isEmpty() && todo.new_project_label.isNotEmpty()) {
                KitLink(
                    label = todo.new_project_label,
                    onClick = openNewProject,
                    modifier = Modifier.testTag("agenda-new-project").padding(horizontal = 8.dp),
                )
            }
        }
        return
    }
    LazyColumn(Modifier.fillMaxSize().testTag("agenda-todo-list")) {
        taskGroups(
            todo.groups,
            onCheck = actions.onCheck,
            onPick = actions.onPick,
            onVerb = actions.onVerb,
            onFile = actions.onFile,
            fileVerb = actions.fileVerb,
            idPrefix = AGENDA_TASK_ROW,
        )
        todo.projects.forEach { group ->
            item(key = "projects-${group.key}") { SectionHeader(SectionHead(title = group.title)) }
            items(group.rows, key = { "project-${it.id}" }) { row ->
                Box(Modifier.testTag("agenda-project-${row.id}")) {
                    CentraidRow(row) { onEvent(AgendaHomeEvent(project_picked = AgendaHomeEvent.ProjectPicked(project_id = row.id))) }
                }
            }
        }
        item(key = "foot") {
            Column {
                if (todo.window_label.isNotEmpty()) {
                    Text(
                        todo.window_label,
                        style = centraidType("annotLabel"),
                        color = centraidColor("textFaint"),
                        modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                    )
                }
                ShowMoreFooter(
                    visible = todo.can_show_more,
                    loading = false,
                    label = words.show_more,
                    onMore = { onEvent(AgendaHomeEvent(next_page = AgendaHomeEvent.NextPageRequested())) },
                )
                if (todo.new_project_label.isNotEmpty()) {
                    KitLink(
                        label = todo.new_project_label,
                        onClick = openNewProject,
                        modifier = Modifier.testTag("agenda-new-project").padding(horizontal = 8.dp),
                    )
                }
            }
        }
    }
}

/**
 * THE ABSENCE NOTICE (#1128, R-1128-3): one sentence and at most one verb, over
 * Day on today. The words and the verb are the notice's own; the verb sends
 * `NoticeActed` and `AgendaRouting` pushes Catch up.
 */
@Composable
internal fun AgendaNoticeView(notice: TasksNotice, onAct: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 10.dp)) {
        Text(notice.sentence, style = centraidType("body"), color = centraidColor("text"))
        if (notice.verb_label.isNotEmpty()) {
            OutlineButton(notice.verb_label, testTag = "agenda-notice-verb", modifier = Modifier.padding(top = 8.dp), onPress = onAct)
        }
    }
}

/**
 * THE TWO TASK SHEETS (#1128): the filing sheet a long press on a task opens
 * (Inbox, projects and their sections, the task's own place selected) and the
 * new-project name sheet. Either can be up over any place — a dated task is
 * filed from Day — so the home draws them wherever the machine says
 * `sheet`. A disabled choice is drawn dimmed and says so.
 */
@Composable
internal fun AgendaTaskSheet(state: AgendaHomeState, words: TasksChrome, onEvent: (AgendaHomeEvent) -> Unit) {
    val close = { onEvent(AgendaHomeEvent(sheet_closed = AgendaHomeEvent.SheetClosed())) }
    when (state.sheet) {
        AgendaHomeState.Sheet.SHEET_FILE -> SheetRoom(title = words.file_title, onDismiss = close) {
            state.file_choices.forEach { choice ->
                TasksChoiceRow(choice) { onEvent(AgendaHomeEvent(file_chosen = AgendaHomeEvent.FileChosen(key = it))) }
            }
        }
        AgendaHomeState.Sheet.SHEET_NEW_PROJECT -> SheetRoom(
            title = words.new_project_title,
            onDismiss = close,
            primary = SheetPrimary(words.new_project_verb, enabled = state.new_project_can_submit) {
                onEvent(AgendaHomeEvent(new_project_submitted = AgendaHomeEvent.NewProjectSubmitted()))
            },
        ) {
            EditableFieldRow(
                key = "",
                value = state.new_project_name,
                reload = state.new_project_name.takeIf { it.isEmpty() },
                placeholder = words.new_project_placeholder,
                onEdit = { onEvent(AgendaHomeEvent(new_project_name = AgendaHomeEvent.NewProjectNameChanged(name = it))) },
                testTag = "tasks-new-project-field",
            )
        }
        else -> Unit
    }
}
