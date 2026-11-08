package dev.centraid.android.screens.agenda

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.graphics.Color
import dev.centraid.android.kit.appAccent
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import centraid.core.v1.AgendaChoice
import centraid.core.v1.AgendaCustomRepeatSheet
import centraid.core.v1.AgendaEditorChrome
import centraid.core.v1.AgendaEditorData
import centraid.core.v1.AgendaEditorEvent
import centraid.core.v1.AgendaEditorState
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitSegment
import dev.centraid.android.kit.KitSegmented
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.Surface
import dev.centraid.android.screens.CivilDateDialog
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * THE EVENT EDITOR'S WAVE 2 SHEETS (#1173): a place (with a search and a clear row), the second
 * alert, availability, the zone (with a search) and travel time, each a titled sheet of the machine's
 * choices, and the Custom repeat sheet. A pick is sent and the machine closes the sheet; every word
 * and every selected mark is the state's.
 */
@Composable
internal fun AgendaEventDetailSheets(
    state: AgendaEditorState,
    chrome: AgendaEditorChrome,
    data: AgendaEditorData,
    onEvent: (AgendaEditorEvent) -> Unit,
) {
    val close = { onEvent(AgendaEditorEvent(sheet_closed = AgendaEditorEvent.SheetClosed())) }
    when (state.sheet) {
        AgendaEditorState.Sheet.SHEET_LOCATION -> ChoiceSheet(
            title = chrome.field_location,
            choices = data.places,
            tagPrefix = "agenda-editor-place",
            onPick = { onEvent(AgendaEditorEvent(place = AgendaEditorEvent.PlacePicked(key = it))) },
            onDismiss = close,
            search = SheetSearch(chrome.place_search_placeholder, data.place_query, "agenda-editor-place-search") {
                onEvent(AgendaEditorEvent(place_search = AgendaEditorEvent.PlaceSearched(text = it)))
            },
            // "No location" clears a chosen place.
            clear = if (data.show_clear_location) {
                SheetClear(chrome.clear_location, "agenda-editor-place-clear") {
                    onEvent(AgendaEditorEvent(place_cleared = AgendaEditorEvent.PlaceCleared()))
                }
            } else {
                null
            },
        )
        AgendaEditorState.Sheet.SHEET_SECOND_REMINDER -> ChoiceSheet(
            title = data.second_reminder_label.ifEmpty { chrome.field_second_alert },
            choices = data.second_reminders,
            tagPrefix = "agenda-editor-second-reminder",
            onPick = { onEvent(AgendaEditorEvent(second_reminder = AgendaEditorEvent.SecondReminderPicked(key = it))) },
            onDismiss = close,
        )
        AgendaEditorState.Sheet.SHEET_AVAILABILITY -> ChoiceSheet(
            title = chrome.field_availability,
            choices = data.availabilities,
            tagPrefix = "agenda-editor-availability",
            onPick = { onEvent(AgendaEditorEvent(availability = AgendaEditorEvent.AvailabilityPicked(key = it))) },
            onDismiss = close,
        )
        AgendaEditorState.Sheet.SHEET_ZONE -> ChoiceSheet(
            title = chrome.field_zone,
            choices = data.zones,
            tagPrefix = "agenda-editor-zone",
            onPick = { onEvent(AgendaEditorEvent(zone = AgendaEditorEvent.ZonePicked(key = it))) },
            onDismiss = close,
            search = SheetSearch(chrome.zone_search_placeholder, data.zone_query, "agenda-editor-zone-search") {
                onEvent(AgendaEditorEvent(zone_search = AgendaEditorEvent.ZoneSearched(text = it)))
            },
        )
        AgendaEditorState.Sheet.SHEET_TRAVEL -> ChoiceSheet(
            title = chrome.field_travel,
            choices = data.travels,
            tagPrefix = "agenda-editor-travel",
            onPick = { onEvent(AgendaEditorEvent(travel = AgendaEditorEvent.TravelPicked(key = it))) },
            onDismiss = close,
        )
        AgendaEditorState.Sheet.SHEET_CUSTOM_REPEAT -> data.custom_repeat?.let { custom ->
            CustomRepeatSheetView(chrome.custom_repeat_title, custom, onEvent, close)
        }
        else -> Unit
    }
}

/** A sheet's search field: its placeholder, the term the machine holds, the selector and what typing sends. */
private class SheetSearch(val placeholder: String, val query: String, val testTag: String, val onType: (String) -> Unit)

/** A sheet's clear row ("No location"). */
private class SheetClear(val label: String, val testTag: String, val onTap: () -> Unit)

/**
 * A SHEET OF CHOICES with an optional search over it and an optional clear row. Each row is
 * `<tagPrefix>-<key>`; the chosen one carries its check. The list scrolls inside the sheet.
 */
@Composable
private fun ChoiceSheet(
    title: String,
    choices: List<AgendaChoice>,
    tagPrefix: String,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
    search: SheetSearch? = null,
    clear: SheetClear? = null,
) {
    SheetRoom(title = title, onDismiss = onDismiss, expanded = search != null) {
        if (search != null) {
            EditableFieldRow(
                key = "",
                value = search.query,
                reload = null,
                placeholder = search.placeholder,
                onEdit = search.onType,
                testTag = search.testTag,
            )
        }
        Column(Modifier.fillMaxWidth().heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
            if (clear != null) SheetRow(label = clear.label, testTag = clear.testTag, onTap = clear.onTap)
            choices.forEach { choice ->
                SheetRow(
                    label = choice.label,
                    selected = choice.selected,
                    testTag = "$tagPrefix-${choice.key}",
                    onTap = { onPick(choice.key) },
                )
            }
        }
    }
}

/**
 * THE CUSTOM REPEAT SHEET: the controls the `show_*` flags name, a summary sentence that re-derives
 * on every change, the refusal sentence while the rule is not whole, and Done (armed by `can_apply`).
 * A rule this sheet cannot represent is read only: its summary and a verb that starts a fresh rule.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun CustomRepeatSheetView(
    fallbackTitle: String,
    custom: AgendaCustomRepeatSheet,
    onEvent: (AgendaEditorEvent) -> Unit,
    onDismiss: () -> Unit,
) {
    var pickingUntil by remember { mutableStateOf(false) }
    SheetRoom(
        title = custom.title.ifEmpty { fallbackTitle },
        onDismiss = onDismiss,
        expanded = true,
        primary = if (custom.read_only) {
            null
        } else {
            SheetPrimary(custom.done_label, testTag = "agenda-editor-custom-done", enabled = custom.can_apply) {
                onEvent(AgendaEditorEvent(custom_applied = AgendaEditorEvent.CustomApplied()))
            }
        },
    ) {
        Column(Modifier.fillMaxWidth().heightIn(max = 560.dp).verticalScroll(rememberScrollState())) {
            if (custom.read_only) {
                if (custom.summary.isNotEmpty()) {
                    Text(
                        custom.summary,
                        style = centraidType("body"),
                        color = centraidColor("text"),
                        modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp).testTag("agenda-editor-custom-summary"),
                    )
                }
                if (custom.replace_label.isNotEmpty()) {
                    OutlineButton(custom.replace_label, testTag = "agenda-editor-custom-replace", modifier = Modifier.padding(KitGeometry.GUTTER)) {
                        onEvent(AgendaEditorEvent(custom_replace = AgendaEditorEvent.CustomReplaceTapped()))
                    }
                }
                return@Column
            }
            Eyebrow(custom.frequency_label)
            KitSegmented(
                segments = custom.frequencies.map { KitSegment(id = it.key, label = it.label, selected = it.selected) },
                testTag = "agenda-editor-custom-freq",
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp),
                onPick = { onEvent(AgendaEditorEvent(custom_freq = AgendaEditorEvent.CustomFreqPicked(key = it))) },
            )
            // "Every 2 weeks": the stepper's words around a number field.
            NumberRow(
                before = custom.interval_label,
                value = custom.interval,
                after = custom.unit_label,
                testTag = "agenda-editor-custom-interval",
            ) { onEvent(AgendaEditorEvent(custom_interval = AgendaEditorEvent.CustomIntervalChanged(interval = it))) }
            if (custom.show_weekdays) {
                Eyebrow(custom.weekdays_label)
                // THE WEEK IN ONE ROW: seven equal keys, the picked ones filled.
                Row(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    custom.weekdays.forEach { choice ->
                        val shape = RoundedCornerShape(KitGeometry.RADIUS)
                        Box(
                            Modifier
                                .weight(1f)
                                .heightIn(min = KitGeometry.ROW_MIN)
                                .clip(shape)
                                .background(if (choice.selected) appAccent().fill else Surface.fill, shape)
                                .clickable { onEvent(AgendaEditorEvent(custom_weekday = AgendaEditorEvent.CustomWeekdayToggled(key = choice.key))) }
                                .testTag("agenda-editor-custom-weekday-${choice.key}")
                                .clearAndSetSemantics {
                                    contentDescription = choice.accessibility_label.ifEmpty { choice.label }
                                    role = Role.Checkbox
                                    selected = choice.selected
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                choice.label,
                                style = centraidType(if (choice.selected) "smallStrong" else "small"),
                                color = if (choice.selected) Color.White else centraidColor("text"),
                                maxLines = 1,
                            )
                        }
                    }
                }
            }
            if (custom.show_month_modes) {
                KitSegmented(
                    segments = custom.month_modes.map { KitSegment(id = it.key, label = it.label, selected = it.selected) },
                    testTag = "agenda-editor-custom-month-mode",
                    modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp),
                    onPick = { onEvent(AgendaEditorEvent(custom_month_mode = AgendaEditorEvent.CustomMonthModePicked(key = it))) },
                )
            }
            if (custom.show_month_days) {
                Eyebrow(custom.month_days_label)
                Chips(custom.month_days, "agenda-editor-custom-month-day") {
                    onEvent(AgendaEditorEvent(custom_month_day = AgendaEditorEvent.CustomMonthDayToggled(key = it)))
                }
            }
            if (custom.show_nth) {
                Chips(custom.ordinals, "agenda-editor-custom-ordinal") {
                    onEvent(AgendaEditorEvent(custom_ordinal = AgendaEditorEvent.CustomOrdinalPicked(key = it)))
                }
                Chips(custom.nth_weekdays, "agenda-editor-custom-nth-weekday") {
                    onEvent(AgendaEditorEvent(custom_nth_weekday = AgendaEditorEvent.CustomNthWeekdayPicked(key = it)))
                }
            }
            Eyebrow(custom.ends_label)
            KitSegmented(
                segments = custom.end_modes.map { KitSegment(id = it.key, label = it.label, selected = it.selected) },
                testTag = "agenda-editor-custom-end",
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp),
                onPick = { onEvent(AgendaEditorEvent(custom_end = AgendaEditorEvent.CustomEndPicked(key = it))) },
            )
            if (custom.show_until) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = KitGeometry.ROW_MIN)
                        .clickable { pickingUntil = true }
                        .padding(horizontal = KitGeometry.GUTTER)
                        .testTag("agenda-editor-custom-until")
                        .clearAndSetSemantics {
                            contentDescription = listOf(custom.until_day_label, custom.until_day).filter { it.isNotEmpty() }.joinToString(", ")
                            role = Role.Button
                        },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(custom.until_day_label, style = centraidType("body"), color = centraidColor("text"))
                }
            }
            if (custom.show_count) {
                NumberRow(
                    before = "",
                    value = custom.count,
                    after = custom.count_label,
                    testTag = "agenda-editor-custom-count",
                ) { onEvent(AgendaEditorEvent(custom_count = AgendaEditorEvent.CustomCountChanged(count = it))) }
            }
            // THE BOARD'S ORDER: the rule's sentence after its controls.
            if (custom.summary.isNotEmpty()) {
                Text(
                    custom.summary,
                    style = centraidType("body"),
                    color = centraidColor("text"),
                    modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp).testTag("agenda-editor-custom-summary"),
                )
            }
            if (custom.error.isNotEmpty()) {
                Text(
                    custom.error,
                    style = centraidType("annotLabel"),
                    color = centraidColor("textFaint"),
                    modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp).testTag("agenda-editor-custom-error"),
                )
            }
        }
    }
    if (pickingUntil) {
        CivilDateDialog(custom.until_day, onDismiss = { pickingUntil = false }, onPicked = { day ->
            pickingUntil = false
            onEvent(AgendaEditorEvent(custom_until = AgendaEditorEvent.CustomUntilChanged(day = day)))
        })
    }
}

@Composable
private fun Eyebrow(text: String) {
    if (text.isEmpty()) return
    Text(text, style = centraidType("eyebrow"), color = centraidColor("textSoft"), modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp))
}

/** A row of toggle chips, `<tagPrefix>-<key>`; each is a checkbox the machine marks. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Chips(choices: List<AgendaChoice>, tagPrefix: String, onTap: (String) -> Unit) {
    FlowRow(
        Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        choices.forEach { choice ->
            Row(
                Modifier
                    .heightIn(min = KitGeometry.ROW_MIN)
                    .widthIn(min = KitGeometry.ROW_MIN)
                    .clip(CircleShape)
                    .background(if (choice.selected) Surface.card else Surface.fill, CircleShape)
                    .clickable { onTap(choice.key) }
                    .padding(horizontal = 12.dp)
                    .testTag("$tagPrefix-${choice.key}")
                    .clearAndSetSemantics {
                        contentDescription = choice.accessibility_label.ifEmpty { choice.label }
                        role = Role.Checkbox
                        selected = choice.selected
                    },
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(choice.label, style = centraidType("small"), color = centraidColor(if (choice.selected) "text" else "textSoft"), maxLines = 1)
            }
        }
    }
}

/**
 * A WHOLE NUMBER BETWEEN ITS WORDS ("Every" 2 "weeks"). The member's typing is held here and sent
 * only when it is a number of one or more; the machine's value replaces it when it differs and the
 * field is not being typed in.
 */
@Composable
private fun NumberRow(before: String, value: Int, after: String, testTag: String, onChange: (Int) -> Unit) {
    var text by remember(value) { mutableStateOf(value.toString()) }
    Row(
        Modifier.fillMaxWidth().heightIn(min = KitGeometry.ROW_MIN).padding(horizontal = KitGeometry.GUTTER),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (before.isNotEmpty()) Text(before, style = centraidType("body"), color = centraidColor("textSoft"))
        BasicTextField(
            value = text,
            onValueChange = { next ->
                val digits = next.filter { it.isDigit() }.take(MAX_DIGITS)
                text = digits
                digits.toIntOrNull()?.takeIf { it >= 1 && it != value }?.let(onChange)
            },
            singleLine = true,
            textStyle = centraidType("body").copy(color = centraidColor("text")),
            cursorBrush = SolidColor(centraidColor("text")),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier
                .widthIn(min = 48.dp)
                .clip(RoundedCornerShape(KitGeometry.RADIUS))
                .background(Surface.fill)
                .padding(horizontal = 12.dp, vertical = 10.dp)
                .testTag(testTag)
                .semantics { contentDescription = listOf(before, after).filter { it.isNotEmpty() }.joinToString(" ") },
        )
        if (after.isNotEmpty()) Text(after, style = centraidType("body"), color = centraidColor("textSoft"))
    }
}

private const val MAX_DIGITS: Int = 4
