package dev.centraid.android.screens.agenda

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.input.ImeAction
import centraid.core.v1.AgendaEditorChrome
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.KitSegment
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.hueColor
import dev.centraid.design.CentraidScale
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.core.v1.AgendaChoice
import centraid.core.v1.AgendaDraft
import centraid.core.v1.AgendaEditorData
import centraid.core.v1.AgendaEditorEvent
import centraid.core.v1.AgendaEditorState
import dev.centraid.android.kit.ChoiceFieldRow
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EditorRoom
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitSegmented
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.kit.kitSwitchColors
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.screens.CivilDateDialog
import dev.centraid.android.screens.CivilTimeDialog
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * `agenda.editor`: create or edit one occurrence. Not an autosave editor —
 * the draft is the machine's and Save is one write, so the close key and the
 * back gesture forward `LeaveRequested` and the shell pops only on
 * `dismissed`. The day and time pickers read and write the draft's civil
 * strings; every label is the state's.
 */
@Composable
internal fun AgendaEditorScreen(
    state: AgendaEditorState,
    onEvent: (AgendaEditorEvent) -> Unit,
) {
    val chrome = state.chrome
    val data = state.data_
    val leave = { onEvent(AgendaEditorEvent(leave = AgendaEditorEvent.LeaveRequested())) }
    EditorRoom(
        title = data?.heading.orEmpty(),
        status = null,
        onClose = leave,
        onDeparted = {},
        closeLabel = chrome?.close?.ifEmpty { null } ?: KitWords.DONE,
        trailing = if (data?.can_save == true && chrome != null) {
            RoomAction("Check", chrome.save, "agenda-editor-save") { onEvent(AgendaEditorEvent(save = AgendaEditorEvent.SaveTapped())) }
        } else {
            null
        },
    ) {
        val gone = state.gone
        if (gone != null) {
            GoneCard(gone, leave)
            return@EditorRoom
        }
        StatusLine(state.status?.sentence.orEmpty())
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, data, state.denied),
            onRetry = { onEvent(AgendaEditorEvent(refreshed = AgendaEditorEvent.Refreshed())) },
            retryLabel = chrome?.retry?.ifEmpty { null } ?: KitWords.RETRY,
            skeleton = { RowSkeleton(rows = 6, label = chrome?.loading?.ifEmpty { null } ?: KitWords.OPENING) },
            modifier = Modifier.weight(1f),
        ) { editor -> EditorBody(state, editor, onEvent) }
    }
    EditorSheets(state, onEvent)
    val confirm = state.confirm
    if (confirm != null) {
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(AgendaEditorEvent(confirmed = AgendaEditorEvent.Confirmed())) },
            onDismiss = { onEvent(AgendaEditorEvent(confirm_dismissed = AgendaEditorEvent.ConfirmDismissed())) },
            cancelLabel = chrome?.keep_editing?.ifEmpty { null } ?: KitWords.CANCEL,
        )
    }
}

@Composable
private fun EditorBody(state: AgendaEditorState, data: AgendaEditorData, onEvent: (AgendaEditorEvent) -> Unit) {
    val chrome = state.chrome ?: return
    val draft = data.draft ?: AgendaDraft()
    // THE MACHINE'S WORDS LAND ONLY WHILE NOTHING IS TYPED: a clean draft is
    // the vault's (or the defaults'), so a re-read may replace it.
    val clean = !data.dirty
    var picking by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).testTag("agenda-editor")) {
        // THE ADD SHEET'S SWITCH (#1128): only a create has one, and the
        // machine says which side is lit and what each is called.
        if (data.kinds.isNotEmpty()) {
            KitSegmented(
                options = data.kinds.map { it.kind.value.toString() to it.label },
                selected = data.kinds.firstOrNull { it.selected }?.kind?.value?.toString().orEmpty(),
                onSelect = { key ->
                    data.kinds.firstOrNull { it.kind.value.toString() == key }?.let {
                        onEvent(AgendaEditorEvent(kind_picked = AgendaEditorEvent.KindPicked(kind = it.kind)))
                    }
                },
                modifier = Modifier
                    .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
                    .semantics { contentDescription = chrome.kind_label }
                    .testTag("agenda-editor-kind"),
            )
        }
        EditableFieldRow(
            key = chrome.field_title,
            value = draft.title,
            reload = if (clean) draft.title else null,
            placeholder = chrome.title_placeholder,
            style = "title",
            onEdit = { onEvent(AgendaEditorEvent(title = AgendaEditorEvent.TitleChanged(text = it))) },
            testTag = "agenda-editor-title",
        )
        AllDayRow(chrome.field_all_day, draft.all_day) {
            onEvent(AgendaEditorEvent(all_day = AgendaEditorEvent.AllDayToggled(on = it)))
        }
        WhenRow(
            key = data.start_field_label,
            day = data.start_day_label.ifEmpty { data.start_label },
            time = data.start_time_label,
            pickDate = chrome.pick_date,
            pickTime = chrome.pick_time,
            testTag = "agenda-editor-start",
            onDay = { picking = "start-day" },
            onTime = { picking = "start-time" },
        )
        // THE NEW TASK SHEET (#1173): Notes, the List row, then "More details", which opens priority,
        // repeat and tags. Every word is the machine's.
        if (data.show_task_fields) {
            EditableFieldRow(
                key = chrome.field_notes,
                value = draft.notes,
                reload = if (clean) draft.notes else null,
                placeholder = chrome.notes_placeholder,
                singleLine = false,
                onEdit = { onEvent(AgendaEditorEvent(notes = AgendaEditorEvent.NotesChanged(text = it))) },
                testTag = "agenda-editor-notes",
            )
            TaskListRow(chrome.field_list, data.list_label, data.list_hue_key) {
                onEvent(AgendaEditorEvent(sheet_opened = AgendaEditorEvent.SheetOpened(sheet = AgendaEditorState.Sheet.SHEET_LIST)))
            }
            ChoiceFieldRow(chrome.field_more_details, data.more_details_summary, testTag = "agenda-editor-more-details", onTap = {
                onEvent(AgendaEditorEvent(more_details = AgendaEditorEvent.MoreDetailsToggled()))
            })
            if (data.more_details_open) MoreDetails(chrome, data, draft, onEvent)
        }
        // A TASK IS A TITLE AND A DUE DAY: the event's fields are not drawn.
        if (data.show_event_fields) {
            WhenRow(
                key = chrome.field_ends,
                day = data.end_day_label.ifEmpty { data.end_label },
                time = data.end_time_label,
                pickDate = chrome.pick_date,
                pickTime = chrome.pick_time,
                testTag = "agenda-editor-end",
                onDay = { picking = "end-day" },
                onTime = { picking = "end-time" },
            )
            ChoiceFieldRow(chrome.field_calendar, data.calendar_label, testTag = "agenda-editor-calendar", onTap = {
                onEvent(AgendaEditorEvent(sheet_opened = AgendaEditorEvent.SheetOpened(sheet = AgendaEditorState.Sheet.SHEET_CALENDAR)))
            })
            ChoiceFieldRow(chrome.field_guests, data.guests_label, testTag = "agenda-editor-guests", onTap = {
                onEvent(AgendaEditorEvent(sheet_opened = AgendaEditorEvent.SheetOpened(sheet = AgendaEditorState.Sheet.SHEET_GUESTS)))
            })
            if (data.repeats.isNotEmpty()) {
                ChoiceFieldRow(chrome.field_repeat, data.repeat_label, testTag = "agenda-editor-repeat", onTap = {
                    onEvent(AgendaEditorEvent(sheet_opened = AgendaEditorEvent.SheetOpened(sheet = AgendaEditorState.Sheet.SHEET_REPEAT)))
                })
                if (data.repeat_note.isNotEmpty()) Note(data.repeat_note)
            } else {
                FieldRow(key = chrome.field_repeat, value = data.repeat_label, note = data.repeat_note)
            }
            ChoiceFieldRow(chrome.field_reminder, data.reminder_label, testTag = "agenda-editor-reminder", onTap = {
                onEvent(AgendaEditorEvent(sheet_opened = AgendaEditorEvent.SheetOpened(sheet = AgendaEditorState.Sheet.SHEET_REMINDER)))
            })
            EditableFieldRow(
                key = chrome.field_link,
                value = draft.link,
                reload = if (clean) draft.link else null,
                placeholder = chrome.link_placeholder,
                onEdit = { onEvent(AgendaEditorEvent(link = AgendaEditorEvent.LinkChanged(text = it))) },
                testTag = "agenda-editor-link",
            )
            EditableFieldRow(
                key = chrome.field_notes,
                value = draft.notes,
                reload = if (clean) draft.notes else null,
                placeholder = chrome.notes_placeholder,
                singleLine = false,
                onEdit = { onEvent(AgendaEditorEvent(notes = AgendaEditorEvent.NotesChanged(text = it))) },
                testTag = "agenda-editor-notes",
            )
        }
        if (data.blocked_reason.isNotEmpty()) Note(data.blocked_reason)
        if (data.show_skip && data.skip_label.isNotEmpty()) {
            OutlineButton(data.skip_label, testTag = "agenda-editor-skip", ink = "net", modifier = Modifier.padding(KitGeometry.GUTTER)) {
                onEvent(AgendaEditorEvent(skip = AgendaEditorEvent.SkipTapped()))
            }
        }
        if (data.foot_note.isNotEmpty()) Note(data.foot_note)
    }
    // THE DAY AND THE TIME ARE TWO PICKERS: each pick sends the pair it moves.
    when (picking) {
        "start-day" -> CivilDateDialog(draft.start_day, onDismiss = { picking = "" }, onPicked = { day ->
            onEvent(AgendaEditorEvent(start = AgendaEditorEvent.StartChanged(day = day, time = draft.start_time)))
            picking = ""
        })
        "start-time" -> CivilTimeDialog(draft.start_time, onDismiss = { picking = "" }, onPicked = { time ->
            onEvent(AgendaEditorEvent(start = AgendaEditorEvent.StartChanged(day = state.data_?.draft?.start_day ?: draft.start_day, time = time)))
            picking = ""
        })
        "end-day" -> CivilDateDialog(draft.end_day, onDismiss = { picking = "" }, onPicked = { day ->
            onEvent(AgendaEditorEvent(end = AgendaEditorEvent.EndChanged(day = day, time = draft.end_time)))
            picking = ""
        })
        "end-time" -> CivilTimeDialog(draft.end_time, onDismiss = { picking = "" }, onPicked = { time ->
            onEvent(AgendaEditorEvent(end = AgendaEditorEvent.EndChanged(day = state.data_?.draft?.end_day ?: draft.end_day, time = time)))
            picking = ""
        })
    }
}

/**
 * A BOUND OF THE EVENT: its key, then the day and (for a timed event) the time
 * as two targets, each opening its own platform picker. The state's words are
 * the values; "Pick a date" / "Pick a time" say what a tap does.
 */
@Composable
private fun WhenRow(
    key: String,
    day: String,
    time: String,
    pickDate: String,
    pickTime: String,
    testTag: String,
    onDay: () -> Unit,
    onTime: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .padding(start = KitGeometry.GUTTER, end = 8.dp)
            .testTag(testTag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(key, style = centraidType("body"), color = centraidColor("textSoft"), modifier = Modifier.weight(1f))
        PickTarget(day, listOf(key, day, pickDate).filter { it.isNotEmpty() }.joinToString(", "), "$testTag-day", onDay)
        if (time.isNotEmpty()) {
            PickTarget(time, listOf(key, time, pickTime).filter { it.isNotEmpty() }.joinToString(", "), "$testTag-time", onTime)
        }
    }
}

@Composable
private fun PickTarget(value: String, spoken: String, testTag: String, onTap: () -> Unit) {
    Text(
        value,
        style = centraidType("body"),
        color = centraidColor("text"),
        maxLines = 1,
        modifier = Modifier
            .heightIn(min = KitGeometry.ROW_MIN)
            .clickable(onClick = onTap)
            .padding(horizontal = 8.dp, vertical = 12.dp)
            .testTag(testTag)
            .clearAndSetSemantics {
                contentDescription = spoken
                role = Role.Button
            },
    )
}

@Composable
private fun AllDayRow(label: String, on: Boolean, onToggle: (Boolean) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .toggleable(value = on, role = Role.Switch, onValueChange = onToggle)
            .padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)
            .testTag("agenda-editor-all-day"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = centraidType("body"), color = centraidColor("textSoft"), modifier = Modifier.weight(1f))
        Switch(checked = on, onCheckedChange = null, colors = kitSwitchColors())
    }
}

/** THE TASK'S LIST: the key, the list's dot and name; a tap opens the list sheet. */
@Composable
private fun TaskListRow(key: String, value: String, hueKey: String, onTap: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .clickable(onClick = onTap)
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
            .testTag("agenda-editor-list")
            .clearAndSetSemantics {
                contentDescription = "$key, $value"
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(key, style = centraidType("body"), color = centraidColor("textSoft"), modifier = Modifier.weight(1f))
        if (hueKey.isNotEmpty()) {
            Box(Modifier.padding(end = 8.dp).size(10.dp).clip(CircleShape).background(hueColor(hueKey)))
        }
        Text(value, style = centraidType("body"), color = centraidColor("text"))
        CentraidIcon(iconKey = "ChevronRight", tint = centraidColor("textFaint"), size = 16.dp, modifier = Modifier.padding(start = 6.dp))
    }
}

/** MORE DETAILS, open: Priority as connected buttons, Repeat, and Tags as removable chips over a field. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MoreDetails(chrome: AgendaEditorChrome, data: AgendaEditorData, draft: AgendaDraft, onEvent: (AgendaEditorEvent) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(chrome.field_priority, style = centraidType("eyebrow"), color = centraidColor("textSoft"), modifier = Modifier.padding(horizontal = KitGeometry.GUTTER))
        KitSegmented(
            segments = data.priorities.map { KitSegment(id = it.key, label = it.label, selected = it.selected) },
            testTag = "agenda-editor-priority",
            modifier = Modifier
                .padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp)
                .semantics { contentDescription = data.priority_label },
            onPick = { onEvent(AgendaEditorEvent(priority = AgendaEditorEvent.PriorityPicked(key = it))) },
        )
        if (data.repeats.isNotEmpty()) {
            ChoiceFieldRow(chrome.field_repeat, data.repeat_label, testTag = "agenda-editor-repeat", onTap = {
                onEvent(AgendaEditorEvent(sheet_opened = AgendaEditorEvent.SheetOpened(sheet = AgendaEditorState.Sheet.SHEET_REPEAT)))
            })
        }
        Text(chrome.field_tags, style = centraidType("eyebrow"), color = centraidColor("textSoft"), modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp))
        if (draft.tags.isNotEmpty()) {
            FlowRow(
                Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                draft.tags.forEach { tag ->
                    TagChip(tag) { onEvent(AgendaEditorEvent(tag_removed = AgendaEditorEvent.TagRemoved(text = tag))) }
                }
            }
        }
        TagField(chrome.tag_placeholder) { onEvent(AgendaEditorEvent(tag_added = AgendaEditorEvent.TagAdded(text = it))) }
    }
}

/** An input chip: the tag as typed and a close mark; a tap removes it. */
@Composable
private fun TagChip(text: String, onRemove: () -> Unit) {
    Row(
        Modifier
            .heightIn(min = KitGeometry.ROW_MIN)
            .clip(CircleShape)
            .clickable(onClick = onRemove)
            .testTag("agenda-editor-tag-$text")
            .clearAndSetSemantics {
                contentDescription = text
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier
                .height(32.dp)
                .clip(CircleShape)
                .background(centraidColor("bgSunken"), CircleShape)
                .border(KitGeometry.HAIRLINE, centraidColor("lineStrong"), CircleShape)
                .padding(start = 12.dp, end = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(text, style = centraidType("small"), color = centraidColor("text"), maxLines = 1)
            CentraidIcon(iconKey = "X", tint = centraidColor("textSoft"), size = 12.dp)
        }
    }
}

/** The tag field: typed here, added on the keyboard's Done, then cleared. */
@Composable
private fun TagField(placeholder: String, onAdd: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    Box(
        Modifier.fillMaxWidth().heightIn(min = KitGeometry.ROW_MIN).padding(horizontal = KitGeometry.GUTTER),
        contentAlignment = Alignment.CenterStart,
    ) {
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
            keyboardActions = KeyboardActions(onDone = {
                if (text.isNotBlank()) onAdd(text.trim())
                text = ""
            }),
            modifier = Modifier.fillMaxWidth().testTag("agenda-editor-tag-field").semantics { contentDescription = placeholder },
        )
    }
}

/** The list sheet: Inbox, then the projects A to Z, each with its dot; the machine closes it. */
@Composable
private fun ListSheet(title: String, lists: List<AgendaChoice>, listKey: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    SheetRoom(title = title, onDismiss = onDismiss) {
        Column(
            Modifier
                .padding(horizontal = KitGeometry.GUTTER)
                .clip(RoundedCornerShape(CentraidScale.cardRadius.dp))
                .background(Surface.sheetCard),
        ) {
            lists.forEach { choice ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 52.dp)
                        .clickable { onPick(choice.key) }
                        .padding(horizontal = 12.dp, vertical = 6.dp)
                        .testTag("agenda-editor-list-${choice.key}")
                        .clearAndSetSemantics {
                            contentDescription = choice.accessibility_label.ifEmpty { choice.label }
                            role = Role.Button
                            selected = choice.selected || choice.key == listKey
                        },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (choice.hue_key.isNotEmpty()) {
                        Box(Modifier.padding(end = 12.dp).size(10.dp).clip(CircleShape).background(hueColor(choice.hue_key)))
                    }
                    KitText(choice.label, KitType.Row, Surface.ink, Modifier.weight(1f))
                    if (choice.selected || choice.key == listKey) CentraidIcon(iconKey = "Check", tint = centraidColor("text"), size = 16.dp)
                }
            }
        }
    }
}

@Composable
private fun Note(text: String) {
    Text(text, style = centraidType("annotLabel"), color = centraidColor("textFaint"), modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp))
}

@Composable
private fun EditorSheets(state: AgendaEditorState, onEvent: (AgendaEditorEvent) -> Unit) {
    val chrome = state.chrome ?: return
    val data = state.data_ ?: return
    val close = { onEvent(AgendaEditorEvent(sheet_closed = AgendaEditorEvent.SheetClosed())) }
    fun options(choices: List<AgendaChoice>) = choices.map { SheetOption(key = it.key, label = it.label, selected = it.selected) }
    when (state.sheet) {
        AgendaEditorState.Sheet.SHEET_CALENDAR -> OptionSheet(chrome.field_calendar, options(data.calendars), onPick = {
            onEvent(AgendaEditorEvent(calendar = AgendaEditorEvent.CalendarPicked(calendar_id = it)))
        }, onDismiss = close)
        AgendaEditorState.Sheet.SHEET_GUESTS -> OptionSheet(chrome.field_guests, options(data.guests), onPick = {
            onEvent(AgendaEditorEvent(guest = AgendaEditorEvent.GuestToggled(party_id = it)))
        }, onDismiss = close)
        AgendaEditorState.Sheet.SHEET_REPEAT -> OptionSheet(chrome.field_repeat, options(data.repeats), onPick = {
            onEvent(AgendaEditorEvent(repeat = AgendaEditorEvent.RepeatPicked(key = it)))
        }, onDismiss = close)
        AgendaEditorState.Sheet.SHEET_REMINDER -> OptionSheet(chrome.field_reminder, options(data.reminders), onPick = {
            onEvent(AgendaEditorEvent(reminder = AgendaEditorEvent.ReminderPicked(key = it)))
        }, onDismiss = close)
        AgendaEditorState.Sheet.SHEET_LIST -> ListSheet(chrome.field_list, data.lists, data.draft?.list_key.orEmpty(), onPick = {
            onEvent(AgendaEditorEvent(list = AgendaEditorEvent.ListPicked(key = it)))
        }, onDismiss = close)
        AgendaEditorState.Sheet.SHEET_SCOPE -> ScopeSheet(
            title = chrome.scope_title,
            body = chrome.scope_question,
            scopes = data.scopes,
            commit = if (data.scope_armed) chrome.save else "",
            destructive = false,
            keep = chrome.keep_editing,
            onPick = { onEvent(AgendaEditorEvent(scope = AgendaEditorEvent.ScopePicked(scope = it.scope))) },
            onCommit = { onEvent(AgendaEditorEvent(save = AgendaEditorEvent.SaveTapped())) },
            onDismiss = close,
        )
        else -> Unit
    }
}
