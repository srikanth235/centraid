package dev.centraid.android.screens.tasks

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import centraid.screen.v1.Autosave
import centraid.screen.v1.SectionHead
import centraid.screen.v1.TasksDetailData
import centraid.screen.v1.TasksDetailEvent
import centraid.screen.v1.TasksDetailState
import centraid.screen.v1.TasksField
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.ChoiceFieldRow
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EditorRoom
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.QuietButton
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.screens.CivilDateDialog
import dev.centraid.android.screens.CivilTimeDialog
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * `tasks.detail` in the kit's `EditorRoom`: title and notes autosave, every
 * other field is one write when it is made, close = done. The typing lives in
 * `EditableFieldRow`, reloaded only from the baseline while CLEAN.
 */
@Composable
internal fun TasksDetailScreen(
    state: TasksDetailState,
    onEvent: (TasksDetailEvent) -> Unit,
    onClose: () -> Unit,
    onDeparted: () -> Unit,
) {
    val gone = state.gone
    EditorRoom(
        title = state.chrome?.title.orEmpty(),
        status = state.autosave,
        onClose = onClose,
        onDeparted = onDeparted,
    ) {
        if (gone != null) {
            EmptyStateView(gone, onAction = onClose)
            return@EditorRoom
        }
        Column(Modifier.weight(1f).fillMaxWidth()) {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
                onRetry = { onEvent(TasksDetailEvent(refreshed = TasksDetailEvent.Refreshed())) },
                skeleton = { RowSkeleton(rows = 6, label = state.chrome?.loading?.ifEmpty { null } ?: KitWords.OPENING) },
                modifier = Modifier.weight(1f),
            ) { data -> TasksDetailBody(state, data, onEvent) }
            StatusLine(state.status) { onEvent(TasksDetailEvent(status_acted = TasksDetailEvent.StatusActed())) }
        }
    }
    val open = state.data_?.fields?.firstOrNull { it.key == state.open_field }
    if (open != null) {
        TasksFieldSheet(open, state.chrome?.add_tag_verb.orEmpty(), onEvent)
    }
    val confirm = state.confirm
    if (confirm != null) {
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(TasksDetailEvent(confirmed = TasksDetailEvent.Confirmed())) },
            onDismiss = { onEvent(TasksDetailEvent(dismissed = TasksDetailEvent.Dismissed())) },
            cancelLabel = state.chrome?.cancel?.ifEmpty { null } ?: KitWords.CANCEL,
        )
    }
}

@Composable
private fun TasksDetailBody(state: TasksDetailState, data: TasksDetailData, onEvent: (TasksDetailEvent) -> Unit) {
    // THE VAULT'S WORDS LAND ONLY WHILE CLEAN: typing never fights a reload.
    val baseline = state.baseline.takeIf { state.autosave?.phase == Autosave.Phase.PHASE_CLEAN }
    val draft = data.draft
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        if (data.parent_task_id.isNotEmpty()) {
            CentraidRow(
                title = data.parent_title,
                testTag = "tasks-parent",
                onTap = { onEvent(TasksDetailEvent(parent_picked = TasksDetailEvent.ParentPicked())) },
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 4.dp)) {
            TaskCheckBox(data.check, data.check_label, enabled = true) { onEvent(TasksDetailEvent(check = TasksDetailEvent.CheckTapped())) }
            EditableFieldRow(
                key = "",
                value = draft?.title.orEmpty(),
                reload = baseline?.title,
                placeholder = data.title_placeholder,
                style = "title",
                onEdit = { onEvent(TasksDetailEvent(title = TasksDetailEvent.TitleChanged(title = it))) },
                testTag = "tasks-detail-title",
            )
        }
        if (data.status_label.isNotEmpty()) {
            Text(data.status_label, style = centraidType("annotLabel"), color = centraidColor("textSoft"), modifier = Modifier.padding(horizontal = KitGeometry.GUTTER))
        }
        EditableFieldRow(
            key = "",
            value = draft?.notes.orEmpty(),
            reload = baseline?.notes,
            placeholder = data.notes_placeholder,
            singleLine = false,
            onEdit = { onEvent(TasksDetailEvent(notes = TasksDetailEvent.NotesChanged(notes = it))) },
            testTag = "tasks-detail-notes",
        )
        data.fields.forEach { field ->
            if (field.enabled) {
                ChoiceFieldRow(
                    key = field.label,
                    value = field.value_,
                    testTag = "tasks-field-${field.key}",
                    onTap = { onEvent(TasksDetailEvent(field_opened = TasksDetailEvent.FieldOpened(field_ = field.key))) },
                )
                if (field.note.isNotEmpty()) FieldNote(field.note)
            } else {
                FieldRow(key = field.label, value = field.value_, note = field.note)
            }
        }
        if (data.subtasks_label.isNotEmpty() || data.subtasks.isNotEmpty()) {
            SectionHeader(SectionHead(title = data.subtasks_label))
        }
        data.subtasks.forEach { row ->
            TaskRowView(
                row,
                onCheck = { onEvent(TasksDetailEvent(subtask_checked = TasksDetailEvent.SubtaskChecked(task_id = it))) },
                onPick = { onEvent(TasksDetailEvent(subtask_picked = TasksDetailEvent.SubtaskPicked(task_id = it))) },
            )
        }
        if (data.can_add_subtask) {
            AddLine(data.add_subtask_placeholder, state.chrome?.add_subtask_verb.orEmpty(), "tasks-add-subtask") {
                onEvent(TasksDetailEvent(subtask_added = TasksDetailEvent.SubtaskAdded(title = it)))
            }
        }
        if (data.subtask_note.isNotEmpty()) FieldNote(data.subtask_note)
        Row(Modifier.padding(KitGeometry.GUTTER)) {
            if (data.can_release && data.release_label.isNotEmpty()) {
                QuietButton(data.release_label, testTag = "tasks-release", modifier = Modifier.padding(end = 8.dp)) {
                    onEvent(TasksDetailEvent(release = TasksDetailEvent.ReleaseRequested()))
                }
            }
            if (data.delete_label.isNotEmpty()) {
                QuietButton(data.delete_label, testTag = "tasks-delete", ink = "net") {
                    onEvent(TasksDetailEvent(delete = TasksDetailEvent.DeleteRequested()))
                }
            }
        }
    }
}

@Composable
private fun FieldNote(note: String) {
    Text(note, style = centraidType("annotLabel"), color = centraidColor("textFaint"), modifier = Modifier.padding(horizontal = KitGeometry.GUTTER))
}

/**
 * A one-line add (a subtask, a tag): typed here, sent on the IME's Done or the
 * state's [verb] ("Add") beside it, then cleared.
 */
@Composable
private fun AddLine(placeholder: String, verb: String, testTag: String, onAdd: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    val submit = {
        if (text.isNotBlank()) onAdd(text)
        text = ""
    }
    Row(
        Modifier.fillMaxWidth().heightIn(min = KitGeometry.ROW_MIN).padding(horizontal = KitGeometry.GUTTER),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (text.isEmpty()) {
                Text(placeholder, style = centraidType("body"), color = centraidColor("textFaint"), modifier = Modifier.clearAndSetSemantics { })
            }
            BasicTextField(
                value = text,
                onValueChange = { text = it },
                singleLine = true,
                textStyle = centraidType("body").copy(color = centraidColor("text")),
                cursorBrush = SolidColor(centraidColor("text")),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submit() }),
                modifier = Modifier.fillMaxWidth().testTag(testTag).semantics { contentDescription = placeholder },
            )
        }
        if (verb.isNotEmpty() && text.isNotBlank()) {
            QuietButton(verb, testTag = "$testTag-verb", modifier = Modifier.padding(start = 8.dp), onPress = submit)
        }
    }
}

/** A field's choices, as a sheet: chips, the OS date or time picker, a tag to add. */
@Composable
private fun TasksFieldSheet(field: TasksField, addVerb: String, onEvent: (TasksDetailEvent) -> Unit) {
    var picking by remember { mutableStateOf("") }
    val close = { onEvent(TasksDetailEvent(field_closed = TasksDetailEvent.FieldClosed())) }
    SheetRoom(title = field.label, onDismiss = close) {
        if (field.note.isNotEmpty()) FieldNote(field.note)
        field.choices.forEach { choice ->
            TasksChoiceRow(choice) { onEvent(TasksDetailEvent(field_choice = TasksDetailEvent.FieldChoice(field_ = field.key, key = it))) }
        }
        // THE PICKER ROW: the state's "Pick a date" / "Pick a time", the
        // current value under it.
        val pickLabel = field.pick_label.ifEmpty { field.value_ }
        val pickDetail = if (field.pick_label.isNotEmpty()) field.value_ else ""
        if (field.pick_date) {
            SheetRow(label = pickLabel, detail = pickDetail, iconKey = "Calendar", testTag = "tasks-pick-date", onTap = { picking = "date" })
        }
        if (field.pick_time) {
            SheetRow(label = pickLabel, detail = pickDetail, iconKey = "Clock", testTag = "tasks-pick-time", onTap = { picking = "time" })
        }
        if (field.add_text) {
            AddLine(field.add_placeholder, addVerb, "tasks-add-tag") { onEvent(TasksDetailEvent(tag_added = TasksDetailEvent.TagAdded(label = it))) }
        }
    }
    when (picking) {
        // A PICK CLOSES THE FIELD ON THE MACHINE'S SAY: the picker opens on
        // the state's own day and time, and sends only the pick.
        "date" -> CivilDateDialog(
            day = field.day,
            onPicked = {
                picking = ""
                onEvent(TasksDetailEvent(date_picked = TasksDetailEvent.DatePicked(day = it)))
            },
            onDismiss = { picking = "" },
        )
        "time" -> CivilTimeDialog(
            time = field.time,
            onPicked = {
                picking = ""
                onEvent(TasksDetailEvent(time_picked = TasksDetailEvent.TimePicked(time = it)))
            },
            onDismiss = { picking = "" },
        )
    }
}
