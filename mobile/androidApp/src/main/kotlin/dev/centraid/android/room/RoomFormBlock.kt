package dev.centraid.android.room

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import centraid.core.v1.RoomAutosave
import centraid.core.v1.RoomAutosavePhase
import centraid.core.v1.RoomChange
import centraid.core.v1.RoomExplicitSave
import centraid.core.v1.RoomField
import centraid.core.v1.RoomFilePick
import centraid.core.v1.RoomForm
import centraid.core.v1.RoomItemPick
import centraid.core.v1.RoomMoment
import centraid.core.v1.RoomMomentKind
import centraid.core.v1.RoomMoney
import centraid.core.v1.RoomRepeat
import centraid.core.v1.RoomSecret
import centraid.core.v1.RoomToggle
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ChoiceStack
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.kitCard
import dev.centraid.android.kit.kitSwitchColors
import dev.centraid.android.kit.kitTextStyle
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

@Composable
internal fun RoomFormBlock(
    form: RoomForm,
    onTap: (String) -> Unit,
    onChange: (RoomChange) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .testTag("block-form"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        form.fields.forEach { field ->
            RoomFieldView(field = field, onTap = onTap, onChange = onChange)
        }
        form.repeats.forEach { repeat ->
            RoomRepeatView(repeat = repeat, onTap = onTap, onChange = onChange)
        }
        form.autosave?.let { autosave ->
            RoomAutosaveBar(autosave = autosave, onTap = onTap)
        }
        form.explicit?.let { explicit ->
            RoomExplicitSaveBar(explicit = explicit, onTap = onTap)
        }
    }
}

@Composable
internal fun RoomFieldView(
    field: RoomField,
    onTap: (String) -> Unit,
    onChange: (RoomChange) -> Unit,
    modifier: Modifier = Modifier,
) {
    when {
        field.text != null -> RoomTextField(
            field = field,
            text = field.text!!,
            onChange = onChange,
            onTap = onTap,
            modifier = modifier,
        )
        field.money != null -> RoomMoneyField(
            field = field,
            money = field.money!!,
            onChange = onChange,
            modifier = modifier,
        )
        field.moment != null -> RoomMomentField(
            field = field,
            moment = field.moment!!,
            onChange = onChange,
            modifier = modifier,
        )
        field.choice != null -> RoomChoiceBlock(
            choice = field.choice!!,
            onChange = onChange,
            modifier = modifier,
        )
        field.toggle != null -> RoomToggleField(
            field = field,
            toggle = field.toggle!!,
            onChange = onChange,
            modifier = modifier,
        )
        field.item != null -> RoomItemPickField(
            field = field,
            item = field.item!!,
            onTap = onTap,
            modifier = modifier,
        )
        field.file_ != null -> RoomFilePickField(
            field = field,
            file = field.file_!!,
            onTap = onTap,
            modifier = modifier,
        )
        field.secret != null -> RoomSecretField(
            field = field,
            secret = field.secret!!,
            onTap = onTap,
            onChange = onChange,
            modifier = modifier,
        )
    }
}

@Composable
private fun RoomMoneyField(
    field: RoomField,
    money: RoomMoney,
    onChange: (RoomChange) -> Unit,
    modifier: Modifier = Modifier,
) {
    var seq by remember(field.selector_id) { mutableLongStateOf(0L) }
    var rawDigits by remember(field.selector_id, money.minor) {
        mutableStateOf(if (money.minor == 0L) "" else money.minor.toString())
    }
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Column(modifier.fillMaxWidth().testTag(field.selector_id), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (field.label.isNotEmpty()) {
            KitText(field.label, KitType.Meta, Surface.meta)
        }
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .clip(shape)
                .background(Surface.card)
                .border(KitGeometry.HAIRLINE, if (field.error.isNotEmpty()) StateColor.Red.text else Surface.border, shape)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            KitText(money.display, KitType.Section, Surface.ink, Modifier.weight(1f))
            BasicTextField(
                value = rawDigits,
                onValueChange = { next ->
                    val filtered = next.filter { it.isDigit() || it == '-' }
                    if (filtered != rawDigits) {
                        rawDigits = filtered
                        val parsed = filtered.toLongOrNull() ?: 0L
                        seq += 1L
                        onChange(RoomChange(selector_id = field.selector_id, seq = seq, integer = parsed))
                    }
                },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                textStyle = kitTextStyle(KitType.Meta).copy(color = Surface.meta),
                cursorBrush = SolidColor(Surface.ink),
                modifier = Modifier
                    .testTag("${field.selector_id}-keypad")
                    .semantics { contentDescription = field.label.ifEmpty { money.currency } },
            )
        }
        if (field.error.isNotEmpty()) {
            KitText(field.error, KitType.Meta, StateColor.Red.text)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RoomMomentField(
    field: RoomField,
    moment: RoomMoment,
    onChange: (RoomChange) -> Unit,
    modifier: Modifier = Modifier,
) {
    var seq by remember(field.selector_id) { mutableLongStateOf(0L) }
    var showDate by remember { mutableStateOf(false) }
    var showTime by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(KitGeometry.RADIUS)

    Column(modifier.fillMaxWidth().testTag(field.selector_id), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (field.label.isNotEmpty()) {
            KitText(field.label, KitType.Meta, Surface.meta)
        }
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .clip(shape)
                .background(Surface.card)
                .border(KitGeometry.HAIRLINE, Surface.border, shape)
                .clickable {
                    if (moment.kind == RoomMomentKind.ROOM_MOMENT_KIND_TIME) showTime = true else showDate = true
                }
                .padding(horizontal = 12.dp, vertical = 10.dp)
                .semantics { role = Role.Button },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            KitText(
                moment.display.ifEmpty { field.hint },
                KitType.Row,
                if (moment.display.isNotEmpty()) Surface.ink else Surface.meta,
                Modifier.weight(1f),
            )
            if (moment.clearable && moment.value_.isNotEmpty()) {
                IconKey("X", KitWords.DISMISS, "${field.selector_id}-clear", bordered = false) {
                    seq += 1L
                    onChange(RoomChange(selector_id = field.selector_id, seq = seq, moment = ""))
                }
            }
        }
        if (field.error.isNotEmpty()) {
            KitText(field.error, KitType.Meta, StateColor.Red.text)
        }
    }

    if (showDate) {
        val state = rememberDatePickerState()
        DatePickerDialog(
            onDismissRequest = { showDate = false },
            confirmButton = {
                KitLink(KitWords.DONE, onClick = {
                    showDate = false
                    state.selectedDateMillis?.let { millis ->
                        val formatted = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply {
                            timeZone = TimeZone.getTimeZone("UTC")
                        }.format(Date(millis))
                        seq += 1L
                        onChange(RoomChange(selector_id = field.selector_id, seq = seq, moment = formatted))
                    }
                    if (moment.kind == RoomMomentKind.ROOM_MOMENT_KIND_DAY_TIME) showTime = true
                })
            },
            dismissButton = {
                KitLink(KitWords.CANCEL, onClick = { showDate = false })
            },
        ) {
            DatePicker(state = state)
        }
    }

    if (showTime) {
        val timeState = rememberTimePickerState()
        SheetRoom(title = field.label, onDismiss = { showTime = false }) {
            Column(Modifier.fillMaxWidth().padding(KitGeometry.GUTTER), horizontalAlignment = Alignment.CenterHorizontally) {
                TimePicker(state = timeState)
                InkButton(KitWords.DONE, modifier = Modifier.padding(top = 12.dp)) {
                    showTime = false
                    val hm = "%02d:%02d".format(Locale.ROOT, timeState.hour, timeState.minute)
                    val combined = if (moment.kind == RoomMomentKind.ROOM_MOMENT_KIND_DAY_TIME && moment.value_.length >= 10) {
                        "${moment.value_.take(10)}T$hm"
                    } else {
                        hm
                    }
                    seq += 1L
                    onChange(RoomChange(selector_id = field.selector_id, seq = seq, moment = combined))
                }
            }
        }
    }
}

@Composable
private fun RoomToggleField(
    field: RoomField,
    toggle: RoomToggle,
    onChange: (RoomChange) -> Unit,
    modifier: Modifier = Modifier,
) {
    var seq by remember(field.selector_id) { mutableLongStateOf(0L) }
    Row(
        modifier
            .fillMaxWidth()
            .kitCard()
            .heightIn(min = KitGeometry.ROW_MIN)
            .padding(horizontal = 14.dp, vertical = 6.dp)
            .testTag(field.selector_id),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            KitText(field.label, KitType.Row, Surface.ink)
            if (field.hint.isNotEmpty()) {
                KitText(field.hint, KitType.Meta, Surface.meta)
            }
        }
        Switch(
            checked = toggle.on,
            onCheckedChange = { next ->
                seq += 1L
                onChange(RoomChange(selector_id = field.selector_id, seq = seq, flag = next))
            },
            colors = kitSwitchColors(),
            modifier = Modifier.testTag("${field.selector_id}-switch"),
        )
    }
}

@Composable
private fun RoomItemPickField(
    field: RoomField,
    item: RoomItemPick,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth().testTag(field.selector_id), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (field.label.isNotEmpty()) KitText(field.label, KitType.Meta, Surface.meta)
        Row(
            Modifier
                .fillMaxWidth()
                .kitCard()
                .heightIn(min = KitGeometry.ROW_MIN)
                .clickable { onTap(field.selector_id) }
                .padding(horizontal = 14.dp, vertical = 10.dp)
                .semantics { role = Role.Button },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            KitText(
                item.display.ifEmpty { field.hint.ifEmpty { item.noun } },
                KitType.Row,
                if (item.display.isNotEmpty()) Surface.ink else Surface.meta,
                Modifier.weight(1f),
            )
            if (item.clear_selector_id.isNotEmpty() && item.display.isNotEmpty()) {
                IconKey("X", KitWords.DISMISS, item.clear_selector_id, bordered = false) {
                    onTap(item.clear_selector_id)
                }
            } else {
                CentraidIcon("ChevronRight", tint = Surface.meta, size = 16.dp)
            }
        }
    }
}

@Composable
private fun RoomFilePickField(
    field: RoomField,
    file: RoomFilePick,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth().testTag(field.selector_id), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (field.label.isNotEmpty()) KitText(field.label, KitType.Meta, Surface.meta)
        Row(
            Modifier
                .fillMaxWidth()
                .kitCard()
                .heightIn(min = KitGeometry.ROW_MIN)
                .clickable { onTap(field.selector_id) }
                .padding(horizontal = 14.dp, vertical = 10.dp)
                .semantics { role = Role.Button },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            KitText(
                file.display.ifEmpty { field.hint },
                KitType.Row,
                if (file.display.isNotEmpty()) Surface.ink else Surface.meta,
                Modifier.weight(1f),
            )
            if (file.clear_selector_id.isNotEmpty() && file.display.isNotEmpty()) {
                IconKey("X", KitWords.DISMISS, file.clear_selector_id, bordered = false) {
                    onTap(file.clear_selector_id)
                }
            } else {
                CentraidIcon("ChevronRight", tint = Surface.meta, size = 16.dp)
            }
        }
    }
}

@Composable
private fun RoomSecretField(
    field: RoomField,
    secret: RoomSecret,
    onTap: (String) -> Unit,
    onChange: (RoomChange) -> Unit,
    modifier: Modifier = Modifier,
) {
    var seq by remember(field.selector_id) { mutableLongStateOf(0L) }
    var text by remember(field.selector_id, secret.value_) { mutableStateOf(secret.value_) }
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Column(modifier.fillMaxWidth().testTag(field.selector_id), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (field.label.isNotEmpty()) KitText(field.label, KitType.Meta, Surface.meta)
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .clip(shape)
                .background(Surface.card)
                .border(KitGeometry.HAIRLINE, Surface.border, shape)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (secret.masked) {
                Text(
                    "••••••",
                    style = kitTextStyle(KitType.Row).copy(fontFamily = FontFamily.Monospace),
                    color = Surface.ink,
                    modifier = Modifier.weight(1f),
                )
            } else {
                BasicTextField(
                    value = text,
                    onValueChange = { next ->
                        text = next
                        seq += 1L
                        onChange(RoomChange(selector_id = field.selector_id, seq = seq, text = next))
                    },
                    singleLine = true,
                    textStyle = kitTextStyle(KitType.Row).copy(
                        fontFamily = FontFamily.Monospace,
                        color = Surface.ink,
                    ),
                    cursorBrush = SolidColor(Surface.ink),
                    modifier = Modifier.weight(1f).testTag("${field.selector_id}-secret-input"),
                )
            }
            if (secret.reveal_selector_id.isNotEmpty()) {
                KitLink(
                    label = if (secret.masked) KitWords.OPEN else KitWords.DISMISS,
                    onClick = { onTap(secret.reveal_selector_id) },
                    dense = true,
                    modifier = Modifier.testTag(secret.reveal_selector_id),
                )
            }
        }
    }
}

@Composable
private fun RoomRepeatView(
    repeat: RoomRepeat,
    onTap: (String) -> Unit,
    onChange: (RoomChange) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().testTag(repeat.selector_id.ifEmpty { "block-repeat" }),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (repeat.label.isNotEmpty()) {
            KitText(repeat.label, KitType.Group, Surface.meta, Modifier.semantics { heading() })
        }
        repeat.rows.forEach { group ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .kitCard()
                    .padding(12.dp)
                    .testTag(group.selector_id.ifEmpty { "repeat-row" }),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                group.fields.forEach { field ->
                    RoomFieldView(field = field, onTap = onTap, onChange = onChange)
                }
                if (group.remove_selector_id.isNotEmpty()) {
                    KitLink(
                        label = KitWords.DELETE,
                        onClick = { onTap(group.remove_selector_id) },
                        dense = true,
                        modifier = Modifier.testTag(group.remove_selector_id),
                    )
                }
            }
        }
        repeat.add?.let { action ->
            OutlineButton(
                label = action.label.ifEmpty { "+" },
                testTag = action.selector_id.ifEmpty { "repeat-add" },
                onPress = { onTap(action.selector_id) },
            )
        }
    }
}

@Composable
private fun RoomAutosaveBar(
    autosave: RoomAutosave,
    onTap: (String) -> Unit,
) {
    val color = when {
        autosave.refused || autosave.phase == RoomAutosavePhase.ROOM_AUTOSAVE_PHASE_REFUSED ||
            autosave.phase == RoomAutosavePhase.ROOM_AUTOSAVE_PHASE_CONFLICT -> StateColor.Red.text
        else -> Surface.meta
    }
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("form-autosave"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KitText(autosave.label, KitType.Meta, color, Modifier.weight(1f))
        if (autosave.reload_label.isNotEmpty() && autosave.reload_selector_id.isNotEmpty()) {
            KitLink(
                label = autosave.reload_label,
                onClick = { onTap(autosave.reload_selector_id) },
                dense = true,
                modifier = Modifier.testTag(autosave.reload_selector_id),
            )
        }
    }
}

@Composable
private fun RoomExplicitSaveBar(
    explicit: RoomExplicitSave,
    onTap: (String) -> Unit,
) {
    ChoiceStack(Modifier.fillMaxWidth().padding(top = 8.dp).testTag("form-explicit")) {
        InkButton(
            label = explicit.save_label.ifEmpty { KitWords.SAVE },
            enabled = explicit.save_enabled,
            testTag = explicit.save_selector_id.ifEmpty { "form-save" },
            onPress = { onTap(explicit.save_selector_id) },
        )
        if (explicit.cancel_label.isNotEmpty()) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = KitGeometry.ROW_MIN)
                    .clickable { onTap(explicit.cancel_selector_id) }
                    .testTag(explicit.cancel_selector_id.ifEmpty { "form-cancel" })
                    .semantics { role = Role.Button },
                contentAlignment = Alignment.Center,
            ) {
                KitText(explicit.cancel_label, KitType.Row, Surface.ink)
            }
        }
    }
}
