package dev.centraid.android.room

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import centraid.core.v1.RoomChange
import centraid.core.v1.RoomField
import centraid.core.v1.RoomText
import centraid.core.v1.RoomTextKind
import dev.centraid.android.kit.KitChip
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.kitTextStyle

internal class RoomTextState(initial: String, initialRev: Long = 0L) {
    var value: String = initial
        private set

    var seq: Long = initialRev
        private set

    private var lastSentSeq: Long = initialRev

    fun onEdit(next: String, maxChars: Int = 0): Pair<String, Long>? {
        val bounded = if (maxChars > 0 && next.length > maxChars) next.take(maxChars) else next
        if (bounded == value) return null
        value = bounded
        seq += 1L
        lastSentSeq = seq
        return bounded to seq
    }

    // Adopt Rust's value only when it differs and no local edit above Rust's rev is unsent.
    fun onRustUpdate(remoteValue: String, rev: Long): Boolean {
        if (rev < lastSentSeq) return false
        if (rev > seq) seq = rev
        if (remoteValue == value) return false
        value = remoteValue
        lastSentSeq = rev
        return true
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun RoomTextField(
    field: RoomField,
    text: RoomText,
    onChange: (RoomChange) -> Unit,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val controller = remember(field.selector_id) { RoomTextState(text.value_, text.rev) }
    var fieldValue by remember(field.selector_id) {
        mutableStateOf(TextFieldValue(text = text.value_, selection = TextRange(text.value_.length)))
    }
    LaunchedEffect(text.value_, text.rev) {
        if (controller.onRustUpdate(text.value_, text.rev)) {
            fieldValue = TextFieldValue(text = text.value_, selection = TextRange(text.value_.length))
        }
    }
    val focusRequester = remember(field.selector_id) { FocusRequester() }
    LaunchedEffect(field.selector_id, field.focused) {
        if (field.focused) {
            runCatching { focusRequester.requestFocus() }
        }
    }

    val multiline = text.kind == RoomTextKind.ROOM_TEXT_KIND_PARAGRAPH
    val keyboardOptions = when (text.kind) {
        RoomTextKind.ROOM_TEXT_KIND_EMAIL -> KeyboardOptions(
            keyboardType = KeyboardType.Email,
            capitalization = KeyboardCapitalization.None,
            autoCorrectEnabled = false,
        )
        RoomTextKind.ROOM_TEXT_KIND_PHONE -> KeyboardOptions(keyboardType = KeyboardType.Phone)
        RoomTextKind.ROOM_TEXT_KIND_URL -> KeyboardOptions(
            keyboardType = KeyboardType.Uri,
            capitalization = KeyboardCapitalization.None,
            autoCorrectEnabled = false,
        )
        RoomTextKind.ROOM_TEXT_KIND_NUMBER -> KeyboardOptions(keyboardType = KeyboardType.Number)
        RoomTextKind.ROOM_TEXT_KIND_PARAGRAPH -> KeyboardOptions(capitalization = KeyboardCapitalization.Sentences)
        else -> KeyboardOptions(capitalization = KeyboardCapitalization.Sentences)
    }

    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    val borderColor = if (field.error.isNotEmpty()) StateColor.Red.text else Surface.border

    Column(
        modifier = modifier
            .fillMaxWidth()
            .testTag(field.selector_id),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (field.label.isNotEmpty()) {
            KitText(field.label, KitType.Meta, Surface.meta)
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = if (multiline) 96.dp else KitGeometry.ROW_MIN)
                .clip(shape)
                .background(Surface.card)
                .border(KitGeometry.HAIRLINE, borderColor, shape)
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            if (fieldValue.text.isEmpty() && field.hint.isNotEmpty()) {
                KitText(field.hint, KitType.Row, Surface.meta)
            }
            BasicTextField(
                value = fieldValue,
                onValueChange = { incoming ->
                    val max = text.max_chars
                    val nextText = if (max > 0 && incoming.text.length > max) incoming.text.take(max) else incoming.text
                    val clamped = if (nextText == incoming.text) incoming else incoming.copy(
                        text = nextText,
                        selection = TextRange(
                            incoming.selection.start.coerceAtMost(nextText.length),
                            incoming.selection.end.coerceAtMost(nextText.length),
                        ),
                    )
                    fieldValue = clamped
                    // Emit only when composition is absent (committed edit).
                    if (clamped.composition == null) {
                        controller.onEdit(clamped.text, max)?.let { (committed, seq) ->
                            onChange(
                                RoomChange(
                                    selector_id = field.selector_id,
                                    seq = seq,
                                    text = committed,
                                ),
                            )
                        }
                    }
                },
                singleLine = !multiline,
                textStyle = kitTextStyle(KitType.Row).copy(color = Surface.ink),
                cursorBrush = SolidColor(Surface.ink),
                keyboardOptions = keyboardOptions,
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focusRequester)
                    .testTag("${field.selector_id}-input")
                    .semantics {
                        if (field.label.isNotEmpty()) contentDescription = field.label
                        if (field.error.isNotEmpty()) error(field.error)
                    },
            )
        }
        if (text.chips.isNotEmpty()) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                text.chips.forEach { chip ->
                    KitChip(
                        label = chip.label,
                        selected = true,
                        onClick = {
                            if (chip.remove_selector_id.isNotEmpty()) onTap(chip.remove_selector_id)
                        },
                        modifier = Modifier.testTag(chip.remove_selector_id.ifEmpty { "chip-${chip.label}" }),
                    )
                }
            }
        }
        if (field.error.isNotEmpty()) {
            Text(
                field.error,
                style = kitTextStyle(KitType.Meta),
                color = StateColor.Red.text,
                modifier = Modifier.testTag("${field.selector_id}-error"),
            )
        }
    }
}
