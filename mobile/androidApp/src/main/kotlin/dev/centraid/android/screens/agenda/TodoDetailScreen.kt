package dev.centraid.android.screens.agenda

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Switch
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.kitSwitchColors
import dev.centraid.design.CentraidScale
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
import centraid.core.v1.Autosave
import centraid.core.v1.PhoneSaysTaken
import centraid.core.v1.Route
import dev.centraid.android.kit.EarlierEntryCard
import centraid.core.v1.TodoDetailData
import centraid.core.v1.TodoDetailEvent
import centraid.core.v1.TodoDetailState
import centraid.core.v1.TodoField
import dev.centraid.android.kit.SectionHead
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.ChoiceFieldRow
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EditorRoom
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.PhoneSaysLine
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
 * `agenda.task` in the kit's `EditorRoom`: title and notes autosave, every
 * other field is one write when it is made, close = done. The typing lives in
 * `EditableFieldRow`, reloaded from the draft only while CLEAN. The flush on
 * leaving is Rust's (`Left`), so the room needs no departure hook here.
 */
@Composable
internal fun TodoDetailScreen(
    state: TodoDetailState,
    onEvent: (TodoDetailEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onClose: () -> Unit,
    onPhoneSays: (PhoneSaysTaken) -> Unit,
) {
    val gone = state.gone
    EditorRoom(
        title = state.chrome?.title.orEmpty(),
        status = state.autosave,
        onClose = onClose,
        onDeparted = {},
    ) {
        if (gone != null) {
            EmptyStateView(gone, onAction = onClose)
            return@EditorRoom
        }
        Column(Modifier.weight(1f).fillMaxWidth()) {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
                onRetry = { onEvent(TodoDetailEvent(refreshed = TodoDetailEvent.Refreshed())) },
                skeleton = { RowSkeleton(rows = 6, label = state.chrome?.loading?.ifEmpty { null } ?: KitWords.OPENING) },
                modifier = Modifier.weight(1f),
            ) { data -> TodoDetailBody(state, data, onEvent, onOpen, onPhoneSays) }
            StatusLine(state.status) { onEvent(TodoDetailEvent(status_acted = TodoDetailEvent.StatusActed())) }
        }
    }
    val open = state.data_?.fields?.firstOrNull { it.key == state.open_field }
    if (open != null) {
        TodoFieldSheet(open, state.chrome?.add_tag_verb.orEmpty(), onEvent)
    }
    // THE CUSTOM REPEAT SHEET: the editor's own, over this task's rule; Done is Rust's.
    state.data_?.custom_repeat?.let { custom ->
        CustomRepeatSheetView(
            fallbackTitle = "",
            custom = custom,
            onEvent = { onEvent(TodoDetailEvent(custom_repeat = it)) },
            onDismiss = { onEvent(TodoDetailEvent(field_closed = TodoDetailEvent.FieldClosed())) },
        )
    }
    val confirm = state.confirm
    if (confirm != null) {
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(TodoDetailEvent(confirmed = TodoDetailEvent.Confirmed())) },
            onDismiss = { onEvent(TodoDetailEvent(dismissed = TodoDetailEvent.Dismissed())) },
            cancelLabel = state.chrome?.cancel?.ifEmpty { null } ?: KitWords.CANCEL,
        )
    }
}

@Composable
private fun TodoDetailBody(
    state: TodoDetailState,
    data: TodoDetailData,
    onEvent: (TodoDetailEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onPhoneSays: (PhoneSaysTaken) -> Unit,
) {
    // THE VAULT'S WORDS LAND ONLY WHILE CLEAN: typing never fights a reload.
    val clean = state.autosave?.phase == Autosave.Phase.PHASE_CLEAN
    val draft = data.draft
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        // THE PARENT LINK is a route the shell pushes; a top-level task has none.
        data.parent_route?.let { parent ->
            CentraidRow(
                title = data.parent_title,
                testTag = "tasks-parent",
                onTap = { onOpen(parent) },
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 4.dp)) {
            TodoCheckBox(data.check, data.check_label) { onEvent(TodoDetailEvent(check = TodoDetailEvent.CheckTapped())) }
            EditableFieldRow(
                key = "",
                value = draft?.title.orEmpty(),
                reload = draft?.title?.takeIf { clean },
                placeholder = data.title_placeholder,
                style = "title",
                onEdit = { onEvent(TodoDetailEvent(title = TodoDetailEvent.TitleChanged(title = it))) },
                testTag = "tasks-title-field",
            )
        }
        if (data.status_label.isNotEmpty()) {
            Text(data.status_label, style = centraidType("annotLabel"), color = centraidColor("textSoft"), modifier = Modifier.padding(horizontal = KitGeometry.GUTTER))
        }
        EditableFieldRow(
            key = "",
            value = draft?.notes.orEmpty(),
            reload = draft?.notes?.takeIf { clean },
            placeholder = data.notes_placeholder,
            singleLine = false,
            onEdit = { onEvent(TodoDetailEvent(notes = TodoDetailEvent.NotesChanged(notes = it))) },
            testTag = "tasks-detail-notes",
        )
        // WHAT THE PHONE'S REMINDERS SAY DIFFERENTLY (#1185), each with its "Use phone's".
        state.phone_says.forEach { PhoneSaysLine(it, onPhoneSays) }
        // THE TASK'S ADDRESS (#1173 wave 2): as stored, with the verb that hands it to the phone.
        data.link?.let { link ->
            Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp).testTag("agenda-detail-link")) {
                Text(link.label, style = centraidType("eyebrow"), color = centraidColor("textSoft"))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(link.url, style = centraidType("body"), color = centraidColor("text"), maxLines = 2, modifier = Modifier.weight(1f))
                    KitLink(
                        label = link.open_label,
                        onClick = { onEvent(TodoDetailEvent(open_link = TodoDetailEvent.OpenLinkTapped())) },
                        modifier = Modifier
                            .testTag("agenda-detail-link-open")
                            .semantics { contentDescription = link.accessibility_label.ifEmpty { link.open_label } },
                    )
                }
            }
        }
        // THE GROUPED CARDS (#1173): a field with a `group` opens a card under that heading and the fields
        // after it (with none) continue it; fields before the first heading stand on the page.
        val blocks = mutableListOf<List<TodoField>>()
        data.fields.forEach { field ->
            if (field.group.isNotEmpty() || blocks.isEmpty()) blocks.add(listOf(field)) else blocks[blocks.lastIndex] = blocks.last() + field
        }
        blocks.forEach { block ->
            val head = block.first()
            if (head.group.isEmpty()) {
                block.forEach { TodoFieldRow(it, onEvent) }
            } else {
                Text(
                    head.group,
                    style = centraidType("eyebrow"),
                    color = centraidColor("textSoft"),
                    modifier = Modifier.padding(start = KitGeometry.GUTTER, end = KitGeometry.GUTTER, top = 16.dp, bottom = 6.dp),
                )
                val shape = RoundedCornerShape(CentraidScale.cardRadius.dp)
                Column(
                    Modifier
                        .padding(horizontal = KitGeometry.GUTTER)
                        .fillMaxWidth()
                        .clip(shape)
                        .background(Surface.card)
                        .border(KitGeometry.HAIRLINE, Surface.border, shape)
                        .testTag("tasks-detail-group-${head.key}"),
                ) {
                    block.forEach { TodoFieldRow(it, onEvent) }
                }
            }
        }
        data.attachments?.let { section ->
            AgendaAttachmentsView(
                section = section,
                prefix = "agenda-detail",
                onEvent = { onEvent(TodoDetailEvent(attachment = it)) },
                onOpen = onOpen,
            )
        }
        if (data.subtasks_label.isNotEmpty() || data.subtasks.isNotEmpty()) {
            SectionHeader(SectionHead(title = data.subtasks_label))
        }
        data.subtasks.forEach { row ->
            TodoRowView(
                row,
                onCheck = { onEvent(TodoDetailEvent(subtask_checked = TodoDetailEvent.SubtaskChecked(task_id = it))) },
                onOpen = onOpen,
            )
        }
        if (data.can_add_subtask) {
            AddLine(data.add_subtask_placeholder, state.chrome?.add_subtask_verb.orEmpty(), "tasks-add-subtask") {
                onEvent(TodoDetailEvent(subtask_added = TodoDetailEvent.SubtaskAdded(title = it)))
            }
        }
        if (data.subtask_note.isNotEmpty()) FieldNote(data.subtask_note)
        // EVERY RECORD KEEPS ITS EARLIER VALUES (#1185): the last content row, above the foot actions.
        EarlierEntryCard(state.earlier, onOpen)
        dev.centraid.android.kit.OriginLineView(state.origin)
        Row(Modifier.padding(KitGeometry.GUTTER)) {
            if (data.can_release && data.release_label.isNotEmpty()) {
                OutlineButton(data.release_label, testTag = "tasks-release", modifier = Modifier.padding(end = 8.dp)) {
                    onEvent(TodoDetailEvent(release = TodoDetailEvent.ReleaseRequested()))
                }
            }
            if (data.share_label.isNotEmpty()) {
                OutlineButton(data.share_label, testTag = "tasks-share", modifier = Modifier.padding(end = 8.dp)) {
                    onEvent(TodoDetailEvent(share_requested = TodoDetailEvent.ShareRequested()))
                }
            }
            if (data.delete_label.isNotEmpty()) {
                OutlineButton(data.delete_label, testTag = "tasks-delete", ink = "net") {
                    onEvent(TodoDetailEvent(delete = TodoDetailEvent.DeleteRequested()))
                }
            }
        }
    }
}

/** One field: a switch row for a `toggle`, else the choice row that opens its sheet (or a plain row while it takes no edit). */
@Composable
private fun TodoFieldRow(field: TodoField, onEvent: (TodoDetailEvent) -> Unit) {
    if (field.toggle) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .toggleable(
                    value = field.on,
                    enabled = field.enabled,
                    role = Role.Switch,
                    onValueChange = { next ->
                        onEvent(TodoDetailEvent(field_choice = TodoDetailEvent.FieldChoice(field_ = field.key, key = if (next) "on" else "off")))
                    },
                )
                .padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)
                .testTag("tasks-field-${field.key}"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(field.label, style = centraidType("body"), color = centraidColor("textSoft"), modifier = Modifier.weight(1f))
            Switch(checked = field.on, onCheckedChange = null, enabled = field.enabled, colors = kitSwitchColors())
        }
        if (field.note.isNotEmpty()) FieldNote(field.note)
    } else if (field.enabled) {
        ChoiceFieldRow(
            key = field.label,
            value = field.value_,
            testTag = "tasks-field-${field.key}",
            onTap = { onEvent(TodoDetailEvent(field_opened = TodoDetailEvent.FieldOpened(field_ = field.key))) },
        )
        if (field.note.isNotEmpty()) FieldNote(field.note)
    } else {
        FieldRow(key = field.label, value = field.value_, note = field.note)
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
            OutlineButton(verb, testTag = "$testTag-verb", modifier = Modifier.padding(start = 8.dp), onPress = submit)
        }
    }
}

/** A field's choices, as a sheet: chips, the OS date or time picker, a tag to add. */
@Composable
private fun TodoFieldSheet(field: TodoField, addVerb: String, onEvent: (TodoDetailEvent) -> Unit) {
    var picking by remember { mutableStateOf("") }
    val close = { onEvent(TodoDetailEvent(field_closed = TodoDetailEvent.FieldClosed())) }
    SheetRoom(title = field.label, onDismiss = close) {
        if (field.note.isNotEmpty()) FieldNote(field.note)
        field.choices.forEach { choice ->
            TodoChoiceRow(choice) { onEvent(TodoDetailEvent(field_choice = TodoDetailEvent.FieldChoice(field_ = field.key, key = it))) }
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
            AddLine(field.add_placeholder, addVerb, "tasks-add-tag") { onEvent(TodoDetailEvent(tag_added = TodoDetailEvent.TagAdded(label = it))) }
        }
    }
    when (picking) {
        // A PICK CLOSES THE FIELD ON THE MACHINE'S SAY: the picker opens on
        // the state's own day and time, and sends only the pick.
        "date" -> CivilDateDialog(
            day = field.day,
            onPicked = {
                picking = ""
                onEvent(TodoDetailEvent(date_picked = TodoDetailEvent.DatePicked(day = it)))
            },
            onDismiss = { picking = "" },
        )
        "time" -> CivilTimeDialog(
            time = field.time,
            onPicked = {
                picking = ""
                onEvent(TodoDetailEvent(time_picked = TodoDetailEvent.TimePicked(time = it)))
            },
            onDismiss = { picking = "" },
        )
    }
}
