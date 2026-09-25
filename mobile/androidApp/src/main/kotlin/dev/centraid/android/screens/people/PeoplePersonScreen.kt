package dev.centraid.android.screens.people

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import centraid.screen.v1.PeopleKindChoice
import centraid.screen.v1.PeoplePersonData
import centraid.screen.v1.PeoplePersonEvent
import centraid.screen.v1.PeoplePersonSheet
import centraid.screen.v1.PeoplePersonState
import centraid.screen.v1.PeopleSheetFrame
import centraid.screen.v1.WriteState
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.FailureView
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.KitGeometry
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
import dev.centraid.android.kit.StatusChipView
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

private typealias Which = PeoplePersonEvent.SheetOpened.Which

/**
 * ONE PERSON (#1029 app port): a `PushedPage` back to People. Facts,
 * channels, dates, notes and the touch log, each section's verb opening its
 * write sheet; the confirm is the machine's `Confirm`. `ChannelTapped` and
 * `EditRequested` are intents the route answers (the OS for a channel, the
 * editor for Edit); `done` is the route's pop.
 */
@Composable
public fun PeoplePersonScreen(
    state: PeoplePersonState,
    onEvent: (PeoplePersonEvent) -> Unit,
    onBack: () -> Unit,
) {
    val chrome = state.chrome
    val data = state.data_
    val write = state.write
    fun open(which: Which) = onEvent(PeoplePersonEvent(sheet_opened = PeoplePersonEvent.SheetOpened(which)))
    PushedPage(
        title = data?.name ?: state.name_hint,
        parentTitle = chrome?.back.orEmpty(),
        onBack = onBack,
        trailing = if (data != null) {
            RoomAction("Star", data.star_label, "people-person-star") {
                onEvent(PeoplePersonEvent(star = PeoplePersonEvent.StarToggled()))
            }
        } else {
            null
        },
        status = when {
            write?.phase == WriteState.Phase.PHASE_REFUSED -> write.failure?.sentence.orEmpty()
            else -> state.status
        },
    ) {
        val gone = state.gone
        if (gone != null) {
            EmptyStateView(gone, onAction = null)
        } else {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, data, state.denied),
                onRetry = { onEvent(PeoplePersonEvent(refreshed = PeoplePersonEvent.Refreshed())) },
                retryLabel = chrome?.retry.orEmpty(),
                skeleton = { RowSkeleton(label = chrome?.loading.orEmpty()) },
            ) { person -> PersonBody(person, state, onEvent, ::open) }
        }
    }

    state.sheet?.let { sheet -> PersonSheet(sheet, onEvent) }
    state.confirm?.let { confirm ->
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(PeoplePersonEvent(confirmed = PeoplePersonEvent.Confirmed())) },
            onDismiss = { onEvent(PeoplePersonEvent(dismissed = PeoplePersonEvent.Dismissed())) },
        )
    }
}

@Composable
private fun PersonBody(
    person: PeoplePersonData,
    state: PeoplePersonState,
    onEvent: (PeoplePersonEvent) -> Unit,
    open: (Which) -> Unit,
) {
    val chrome = state.chrome
    LazyColumn(Modifier.testTag("people-person")) {
        item(key = "head") {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Avatar(person.avatar, size = 48)
                Column(Modifier.weight(1f).padding(start = 12.dp)) {
                    if (person.role.isNotEmpty()) {
                        Text(person.role, style = centraidType("body"), color = centraidColor("text"))
                    }
                    if (person.cadence_line.isNotEmpty()) {
                        Text(person.cadence_line, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
                    }
                }
                person.due_chip?.let { StatusChipView(it) }
            }
        }
        if (chrome != null) {
            item(key = "acts") {
                Row(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)) {
                    QuietButton(chrome.log_touch, testTag = "people-log-touch") { open(Which.WHICH_LOG_TOUCH) }
                    QuietButton(chrome.edit, testTag = "people-edit", modifier = Modifier.padding(start = 8.dp)) {
                        onEvent(PeoplePersonEvent(edit = PeoplePersonEvent.EditRequested()))
                    }
                }
            }
        }
        items(person.facts, key = { "f-" + it.label }) { fact -> FieldRow(fact.label, fact.value_) }

        person.channels_head?.let { head ->
            item(key = "channels-head") { SectionHeader(head) { open(Which.WHICH_CHANNEL) } }
        }
        if (person.channels.isEmpty() && person.channels_empty.isNotEmpty()) {
            item(key = "channels-empty") { Quiet(person.channels_empty) }
        }
        items(person.channels, key = { "c-" + it.channel_id }) { channel ->
            CentraidRow(
                title = channel.value_,
                meta = listOf(channel.kind_label, channel.label, channel.preferred_label, channel.duplicate_note)
                    .filter { it.isNotEmpty() }
                    .joinToString(" · "),
                testTag = "people-channel-${channel.channel_id}",
                onTap = { onEvent(PeoplePersonEvent(channel = PeoplePersonEvent.ChannelTapped(channel.channel_id))) },
            ) {
                if (channel.action_label.isNotEmpty()) {
                    QuietButton(
                        channel.action_label,
                        testTag = "people-channel-act-${channel.channel_id}",
                        modifier = Modifier.padding(start = 8.dp),
                    ) { onEvent(PeoplePersonEvent(channel = PeoplePersonEvent.ChannelTapped(channel.channel_id))) }
                }
                if (channel.remove_label.isNotEmpty()) {
                    QuietButton(
                        channel.remove_label,
                        testTag = "people-channel-remove-${channel.channel_id}",
                        ink = "net",
                        modifier = Modifier.padding(start = 8.dp),
                    ) {
                        onEvent(PeoplePersonEvent(remove_channel = PeoplePersonEvent.RemoveChannelTapped(channel.channel_id)))
                    }
                }
            }
        }

        person.dates_head?.let { head -> item(key = "dates-head") { SectionHeader(head) { open(Which.WHICH_DATE) } } }
        if (person.dates.isEmpty() && person.dates_empty.isNotEmpty()) {
            item(key = "dates-empty") { Quiet(person.dates_empty) }
        }
        items(person.dates, key = { "d-" + it.date_id }) { date ->
            CentraidRow(
                title = date.label,
                meta = listOf(date.day_label, date.when_label, date.reminder_label).filter { it.isNotEmpty() }.joinToString(" · "),
                testTag = "people-date-${date.date_id}",
            ) {
                if (date.toggle_label.isNotEmpty()) {
                    QuietButton(
                        date.toggle_label,
                        testTag = "people-reminder-${date.date_id}",
                        modifier = Modifier.padding(start = 8.dp),
                    ) { onEvent(PeoplePersonEvent(reminder = PeoplePersonEvent.ReminderToggled(date.date_id))) }
                }
            }
        }

        person.notes_head?.let { head -> item(key = "notes-head") { SectionHeader(head) { open(Which.WHICH_NOTE) } } }
        if (person.notes.isEmpty() && person.notes_empty.isNotEmpty()) {
            item(key = "notes-empty") { Quiet(person.notes_empty) }
        }
        items(person.notes, key = { "n-" + it.annotation_id }) { note ->
            CentraidRow(title = note.text, meta = note.when_label, testTag = "people-note-${note.annotation_id}")
        }

        person.touches_head?.let { head ->
            item(key = "touches-head") { SectionHeader(head) { open(Which.WHICH_LOG_TOUCH) } }
        }
        if (person.touches.isEmpty() && person.touches_empty.isNotEmpty()) {
            item(key = "touches-empty") { Quiet(person.touches_empty) }
        }
        items(person.touches, key = { "t-" + it.interaction_id }) { touch ->
            CentraidRow(
                title = listOf(touch.kind_label, touch.text).filter { it.isNotEmpty() }.joinToString(" · "),
                meta = touch.when_label,
                a11y = touch.accessibility_label,
                testTag = "people-touch-${touch.interaction_id}",
            )
        }

        if (chrome != null) {
            item(key = "foot") {
                Column(Modifier.padding(top = 16.dp, bottom = 24.dp)) {
                    SheetRow(chrome.merge, iconKey = "dupe", testTag = "people-merge", onTap = { open(Which.WHICH_MERGE) })
                    SheetRow(
                        chrome.move_to_trash,
                        iconKey = "Trash",
                        destructive = true,
                        testTag = "people-trash",
                        onTap = { onEvent(PeoplePersonEvent(trash_tapped = PeoplePersonEvent.TrashTapped())) },
                    )
                }
            }
        }
    }
}

@Composable
private fun Quiet(sentence: String) {
    Text(
        sentence,
        style = centraidType("annotLabel"),
        color = centraidColor("textSoft"),
        modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
    )
}

/** The four write sheets and the merge choices: each one a `SheetRoom` over its frame. */
@Composable
private fun PersonSheet(sheet: PeoplePersonSheet, onEvent: (PeoplePersonEvent) -> Unit) {
    val close = { onEvent(PeoplePersonEvent(sheet_closed = PeoplePersonEvent.SheetClosed())) }
    val text = { value: String -> onEvent(PeoplePersonEvent(text = PeoplePersonEvent.TextChanged(value))) }
    val second = { value: String -> onEvent(PeoplePersonEvent(second_text = PeoplePersonEvent.SecondTextChanged(value))) }
    val flag = { onEvent(PeoplePersonEvent(flag = PeoplePersonEvent.FlagToggled())) }
    val kind = { key: String -> onEvent(PeoplePersonEvent(kind_picked = PeoplePersonEvent.KindPicked(key))) }
    sheet.log_touch?.let { s ->
        FramedSheet(s.frame, onEvent) {
            Kinds(s.kinds, kind)
            // THE SHEET'S IDENTITY is the reload: a fresh sheet takes the machine's words once.
            EditableFieldRow(
                key = s.note_label,
                value = s.note,
                reload = s.frame?.title,
                placeholder = s.note_placeholder,
                singleLine = false,
                testTag = "people-sheet-note",
                onEdit = text,
            )
            if (s.hint.isNotEmpty()) Quiet(s.hint)
        }
    }
    sheet.note?.let { s ->
        FramedSheet(s.frame, onEvent) {
            EditableFieldRow(
                key = "",
                value = s.text,
                reload = s.frame?.title,
                placeholder = s.placeholder,
                singleLine = false,
                testTag = "people-sheet-text",
                onEdit = text,
            )
        }
    }
    sheet.date?.let { s ->
        FramedSheet(s.frame, onEvent) {
            EditableFieldRow(
                key = s.label_field,
                value = s.label,
                reload = s.frame?.title,
                testTag = "people-sheet-date-label",
                onEdit = text,
            )
            EditableFieldRow(
                key = s.month_day_field,
                value = s.month_day,
                reload = s.frame?.title,
                placeholder = s.month_day_placeholder,
                testTag = "people-sheet-month-day",
                onEdit = second,
            )
            if (s.month_day_invalid.isNotEmpty()) {
                Text(
                    s.month_day_invalid,
                    style = centraidType("annotLabel"),
                    color = centraidColor("net"),
                    modifier = Modifier.padding(horizontal = KitGeometry.GUTTER),
                )
            }
            SheetRow(s.reminder_label, selected = s.reminder_on, testTag = "people-sheet-reminder", onTap = flag)
        }
    }
    sheet.channel?.let { s ->
        FramedSheet(s.frame, onEvent) {
            Kinds(s.kinds, kind)
            EditableFieldRow(
                key = s.value_field,
                value = s.value_,
                reload = s.frame?.title,
                testTag = "people-sheet-channel-value",
                onEdit = text,
            )
            EditableFieldRow(
                key = s.label_field,
                value = s.label,
                reload = s.frame?.title,
                testTag = "people-sheet-channel-label",
                onEdit = second,
            )
            SheetRow(s.preferred_label, selected = s.preferred, testTag = "people-sheet-preferred", onTap = flag)
        }
    }
    sheet.merge?.let { s ->
        SheetRoom(title = s.title, onDismiss = close) {
            if (s.body.isNotEmpty()) Quiet(s.body)
            when (val content = screenContentOf(s.loading, s.failure, s.choices)) {
                is ScreenContent.Loading -> RowSkeleton(rows = 3)
                is ScreenContent.Failure -> FailureView(content.sentence, content.remedy, onRetry = null)
                is ScreenContent.Gate -> Unit
                is ScreenContent.Data -> {
                    val empty = content.value.empty
                    if (content.value.choices.isEmpty() && empty != null) {
                        Quiet(empty.headline)
                    }
                    content.value.choices.forEach { choice ->
                        CentraidRow(
                            title = choice.name,
                            meta = choice.role,
                            hueKey = choice.avatar?.hue_key.orEmpty(),
                            testTag = "people-merge-${choice.party_id}",
                            onTap = { onEvent(PeoplePersonEvent(merge_picked = PeoplePersonEvent.MergePicked(choice.party_id))) },
                        )
                    }
                }
            }
            SheetRow(s.cancel_label, testTag = "people-merge-cancel", onTap = close)
        }
    }
}

@Composable
private fun FramedSheet(
    frame: PeopleSheetFrame?,
    onEvent: (PeoplePersonEvent) -> Unit,
    content: @Composable () -> Unit,
) {
    val f = frame ?: PeopleSheetFrame()
    SheetRoom(
        title = f.title,
        onDismiss = { onEvent(PeoplePersonEvent(sheet_closed = PeoplePersonEvent.SheetClosed())) },
        status = f.failure?.sentence.orEmpty(),
        // THE ONE INK BUTTON is drawn only while the machine says it can act.
        primary = if (f.submit_enabled && !f.sending) {
            SheetPrimary(label = f.submit_label, testTag = "people-sheet-submit") {
                onEvent(PeoplePersonEvent(submitted = PeoplePersonEvent.SheetSubmitted()))
            }
        } else {
            null
        },
    ) { content() }
}

@Composable
private fun Kinds(kinds: List<PeopleKindChoice>, onPick: (String) -> Unit) {
    kinds.forEach { choice ->
        SheetRow(choice.label, selected = choice.selected, testTag = "people-kind-${choice.key}", onTap = { onPick(choice.key) })
    }
}
