package dev.centraid.android.screens.agenda

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
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
import centraid.core.v1.AgendaHomeEvent
import centraid.core.v1.AgendaHomeState
import centraid.core.v1.AgendaTodo
import centraid.core.v1.Route
import centraid.core.v1.TodoChrome
import centraid.core.v1.TodoNotice
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.SectionHead
import dev.centraid.android.kit.kitTextStyle
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.ShowMoreFooter
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/** The id prefix every task row on Agenda carries: `agenda-task-row-<id>`, its box `agenda-task-row-check-<id>`. */
internal const val AGENDA_TASK_ROW: String = "agenda-task-row"

/**
 * WHAT A TASK ROW ON AGENDA DOES (#1128, R-1128-2): its box checks it off in
 * place (an event), a tap opens it (the row's own route, pushed by the shell),
 * a swipe reveals Details, Flag and Delete (events; "Move to project" is a screen-reader action), and a group's quiet verb
 * (Overdue's "Reschedule") opens Catch up: the verb's key names the page and
 * the home's `catch_up` route is where it goes. [fileVerb] is the machine's
 * word for the long press (`TodoChrome.file_verb`); a row offers filing only
 * when the row says so (`can_file`) and the verb is not empty. Day, Schedule,
 * To-do and a search's hits draw the same rows, so they share one set of acts.
 */
internal class AgendaTaskActions(
    val onCheck: (String) -> Unit,
    val onOpen: (Route) -> Unit,
    val onFile: (String) -> Unit,
    val onVerb: (String) -> Unit,
    val fileVerb: String,
    val menu: TodoRowMenu? = null,
)

internal fun agendaTaskActions(
    words: TodoChrome,
    catchUp: Route?,
    onEvent: (AgendaHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
): AgendaTaskActions =
    AgendaTaskActions(
        onCheck = { onEvent(AgendaHomeEvent(task_checked = AgendaHomeEvent.TaskChecked(task_id = it))) },
        onOpen = onOpen,
        onFile = { onEvent(AgendaHomeEvent(file_requested = AgendaHomeEvent.FileRequested(task_id = it))) },
        onVerb = { key -> if (key == CATCH_UP) catchUp?.let(onOpen) },
        fileVerb = words.file_verb,
        menu = TodoRowMenu(
            words,
            onFlag = { id, on -> onEvent(AgendaHomeEvent(task_flagged = AgendaHomeEvent.TaskFlagged(task_id = id, flagged = on))) },
            onDelete = { id -> onEvent(AgendaHomeEvent(task_deleted = AgendaHomeEvent.TaskDeleted(task_id = id))) },
        ),
    )

/** The verb key (`TodoRowGroup.verb_key`, `TodoNotice.verb_key`) that opens Catch up. */
internal const val CATCH_UP: String = "catch_up"

/**
 * TO-DO (#1128, R-1128-1): the Inbox's groups, then the projects by area, in
 * one list; the quick-add bar and the status line are the home's (they dock
 * under every place's list). Every word is the machine's: the groups and rows
 * are `TodoRowGroup`s, the projects `ListRow`s under an area's head, the
 * counts and the window sentence finished. A project row and a task row open
 * by the `route` they carry.
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
    words: TodoChrome,
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
        // THE REMINDERS HOME (#1173): the smart-list cards, then My Lists.
        if (todo.smart_lists.isNotEmpty()) {
            item(key = "smart") { AgendaSmartLists(todo.smart_lists, actions.onOpen) }
        }
        if (todo.my_lists_title.isNotEmpty() && todo.projects.isNotEmpty()) {
            item(key = "my-lists") {
                Text(
                    todo.my_lists_title,
                    style = kitTextStyle(KitType.Section),
                    color = centraidColor("text"),
                    modifier = Modifier.padding(start = KitGeometry.GUTTER, top = 12.dp),
                )
            }
        }
        todoGroups(
            todo.groups,
            onCheck = actions.onCheck,
            onOpen = actions.onOpen,
            onVerb = actions.onVerb,
            onFile = actions.onFile,
            fileVerb = actions.fileVerb,
            idPrefix = AGENDA_TASK_ROW,
            menu = actions.menu,
        )
        todo.projects.forEach { group ->
            item(key = "projects-${group.key}") { SectionHeader(SectionHead(title = group.title)) }
            items(group.rows, key = { "project-${it.row?.id}" }) { project ->
                project.row?.let { row ->
                    // A LIST IS ITS COLOUR AND ITS OPEN COUNT (#1173).
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = KitGeometry.ROW_MIN)
                            .clickable { project.route?.let(actions.onOpen) }
                            .padding(horizontal = KitGeometry.GUTTER)
                            .testTag("agenda-project-${row.id}")
                            .clearAndSetSemantics { contentDescription = row.accessibility_label },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        val listColor = agendaListColor(project.list_color_key) ?: centraidColor("textFaint")
                        // A LIST'S OWN ICON (#1173 wave 2) replaces the dot, in the list's colour.
                        if (project.icon_key.isNotEmpty()) {
                            CentraidIcon(project.icon_key, tint = listColor, size = 18.dp)
                        } else {
                            Box(Modifier.size(12.dp).clip(CircleShape).background(listColor))
                        }
                        Text(row.title, style = centraidType("body"), color = centraidColor("text"), modifier = Modifier.weight(1f).padding(start = 12.dp))
                        Text(project.count, style = centraidType("body"), color = centraidColor("textSoft"))
                    }
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
                        label = todo.add_list_label.ifEmpty { todo.new_project_label },
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
 * Day on today. The words and the verb are the notice's own; the verb pushes
 * the home's `catch_up` route.
 */
@Composable
internal fun AgendaNoticeView(notice: TodoNotice, onAct: () -> Unit) {
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
internal fun AgendaTaskSheet(state: AgendaHomeState, words: TodoChrome, onEvent: (AgendaHomeEvent) -> Unit) {
    val close = { onEvent(AgendaHomeEvent(sheet_closed = AgendaHomeEvent.SheetClosed())) }
    when (state.sheet) {
        AgendaHomeState.Sheet.SHEET_FILE -> SheetRoom(title = words.file_title, onDismiss = close) {
            state.file_choices.forEach { choice ->
                TodoChoiceRow(choice) { onEvent(AgendaHomeEvent(file_chosen = AgendaHomeEvent.FileChosen(key = it))) }
            }
        }
        AgendaHomeState.Sheet.SHEET_NEW_PROJECT,
        AgendaHomeState.Sheet.SHEET_NEW_CALENDAR,
        AgendaHomeState.Sheet.SHEET_EDIT_CALENDAR,
        -> state.style?.let { style ->
            // ONE STYLE SHEET for a new list and a new or edited calendar (#1173 wave 2).
            AgendaStyleSheetView(
                style = style,
                onName = { onEvent(AgendaHomeEvent(style_name = AgendaHomeEvent.StyleNameChanged(name = it))) },
                onColor = { onEvent(AgendaHomeEvent(style_color = AgendaHomeEvent.StyleColorPicked(key = it))) },
                onIcon = { onEvent(AgendaHomeEvent(style_icon = AgendaHomeEvent.StyleIconPicked(key = it))) },
                onSubmit = { onEvent(AgendaHomeEvent(style_submitted = AgendaHomeEvent.StyleSubmitted())) },
                onCancel = close,
            )
        }
        else -> Unit
    }
}
