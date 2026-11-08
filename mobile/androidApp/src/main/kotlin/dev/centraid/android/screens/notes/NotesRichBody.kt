package dev.centraid.android.screens.notes

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.IntOffset
import dev.centraid.android.kit.CentraidIcon
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import centraid.core.v1.NotesEditorSelection
import centraid.core.v1.NotesLinkChip
import centraid.core.v1.NotesLinkChipKind
import centraid.core.v1.NotesLinkResolution
import centraid.core.v1.NotesRichBlock
import centraid.core.v1.NotesRichBlockKind
import centraid.core.v1.NotesRichSpan
import centraid.core.v1.NotesRichStyle
import centraid.core.v1.NotesRichText
import centraid.core.v1.NotesTextRange
import dev.centraid.android.kit.AppAccent
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.TypedText
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.kitTextStyle
import dev.centraid.android.theme.centraidDark

/** A core edit is on its way back: the body field may take the core's body while it has the keyboard. */
internal class CoreEditPending {
    var value: Boolean = false
}

/**
 * THE NOTE'S BODY, DRAWN FROM RUST'S SPANS (#1173).
 *
 * A `BasicTextField` over the Markdown body whose look is [rich]: the core's blocks and spans, in
 * UTF-16 code units, which is a Kotlin `String` index, so a range is applied with no conversion.
 * The look is a [VisualTransformation] with the identity offset map: no character is added or
 * removed to draw it, so every offset the core holds stays the text's. Nothing here parses
 * Markdown and nothing here words anything; the shell sends the member's gestures back as events:
 *
 * - a checklist circle drawn where the line's `[ ]` is, a real toggle laid over it
 *   (`checklist_toggled`);
 * - a link chip, a real button laid over its words: a resolved note opens by the chip's route,
 *   anything else is `link_opened` and the core answers;
 * - Return at a collapsed caret, which the field does not take: it is `return_pressed`, and the
 *   core answers with the body and a `selection` applied once per `seq`.
 *
 * THE SPANS ARE OF A BODY THE CORE HEARD: between a keystroke and the state that follows it the
 * text is not `body_length` long, and the body is drawn plain (the proto's own rule) with no marks.
 */
@Composable
internal fun NotesRichBody(
    value: String,
    rich: NotesRichText?,
    selection: NotesEditorSelection?,
    follows: Boolean,
    pending: CoreEditPending,
    placeholder: String,
    onEdit: (String) -> Unit,
    onFocus: (Boolean) -> Unit,
    onReturn: (Int) -> Unit,
    onToggle: (Int) -> Unit,
    onLink: (NotesLinkChip, Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val typed = remember { TypedText(value) }
    var field by remember { mutableStateOf(TextFieldValue(value)) }
    // THE MACHINE'S BODY replaces the typed one only when the machine made it (a checklist tap,
    // Return, Undo, a pick, a load) and never as an echo of the typing.
    typed.answer(value, shown = field.text, open = follows)?.let { adopted ->
        pending.value = false
        field = TextFieldValue(adopted, TextRange(field.selection.start.coerceAtMost(adopted.length)))
    }
    // THE CARET, ONCE PER `seq`, after the body it belongs to.
    val applied = remember { longArrayOf(selection?.seq ?: 0L) }
    if (selection != null && selection.seq > applied[0]) {
        applied[0] = selection.seq
        field = field.copy(selection = TextRange(selection.caret.coerceAtMost(field.text.length)))
    }

    val accent = appAccent()
    val palette = NotesRichPalette(
        ink = Surface.ink,
        body = Surface.body,
        faint = Surface.meta,
        accentText = accent.text,
        chipGround = accent.wash(centraidDark()),
        codeGround = Surface.fill,
        missing = StateColor.Red.text,
    )
    val drawn = if (rich != null && rich.body_length == field.text.length) rich else null
    val transformation = remember(drawn, palette) {
        VisualTransformation { text ->
            TransformedText(if (drawn == null) text else styled(text.text, drawn, palette), OffsetMapping.Identity)
        }
    }
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val density = LocalDensity.current
    val rowStyle = kitTextStyle(KitType.Row)

    Box(modifier.fillMaxWidth()) {
        BasicTextField(
            value = field,
            onValueChange = { next ->
                val before = field
                // RETURN AT A CARET IS THE CORE'S EDIT (a new list line, or the list ended): a lone
                // newline typed at a collapsed caret is not applied. A paste, or Return over a
                // selection, is an ordinary edit of the words.
                val at = before.selection.start
                if (next.composition == null && before.selection.collapsed && next.selection.collapsed &&
                    next.text.length == before.text.length + 1 && next.selection.start == at + 1 &&
                    next.text[at] == '\n' && next.text.removeRange(at, at + 1) == before.text
                ) {
                    onReturn(at)
                } else {
                    field = next
                    if (next.text != before.text && typed.edited(next.text)) {
                        pending.value = false
                        onEdit(next.text)
                    }
                }
            },
            textStyle = rowStyle.copy(color = Surface.ink),
            cursorBrush = SolidColor(Surface.ink),
            visualTransformation = transformation,
            onTextLayout = { layout = it },
            modifier = Modifier
                .fillMaxWidth()
                .onFocusChanged { onFocus(it.isFocused) }
                .testTag("notes-body")
                .semantics { contentDescription = placeholder },
            decorationBox = { inner ->
                Box {
                    if (field.text.isEmpty() && placeholder.isNotEmpty()) {
                        KitText(placeholder, KitType.Row, Surface.meta)
                    }
                    inner()
                }
            },
        )
        val result = layout
        if (drawn != null && result != null && result.layoutInput.text.length == field.text.length) {
            val gap = KitGeometry.ROW_MIN
            drawn.blocks.take(MARK_LIMIT).forEach { block ->
                if (block.kind != NotesRichBlockKind.NOTES_RICH_BLOCK_KIND_CHECKLIST) return@forEach
                val marker = block.marker ?: return@forEach
                val box = result.span(marker.start, marker.end) ?: return@forEach
                val side = minOf(box.width, box.height)
                val reachPx = with(density) { gap.toPx() }
                val width = maxOf(box.width, reachPx)
                val inset = box.center.x - width / 2
                val label = block.accessibility_label
                Box(
                    Modifier
                        .offset { IntOffset(inset.toInt(), box.top.toInt()) }
                        .size(with(density) { width.toDp() }, with(density) { box.height.toDp() })
                        .toggleable(value = block.checked, role = Role.Checkbox, onValueChange = { onToggle(marker.start) })
                        .semantics { stateDescription = label }
                        .testTag("notes-check-${marker.start}"),
                ) {
                    NotesCheckCircle(block.checked, side, accent)
                }
            }
            drawn.spans.take(MARK_LIMIT).forEach { span ->
                val chip = span.chip ?: return@forEach
                if (span.style != NotesRichStyle.NOTES_RICH_STYLE_LINK) return@forEach
                val range = span.range ?: return@forEach
                val box = result.span(range.start, range.end) ?: return@forEach
                Box(
                    Modifier
                        .offset { IntOffset(box.topLeft.x.toInt(), box.top.toInt()) }
                        .size(with(density) { box.width.toDp() }, with(density) { box.height.toDp() })
                        .clickable { onLink(chip, range.start) }
                        .semantics {
                            contentDescription = chip.accessibility_label
                            role = Role.Button
                        }
                        .testTag("notes-chip-${range.start}"),
                ) {
                    if (chip.kind == NotesLinkChipKind.NOTES_LINK_CHIP_KIND_NOTE && range.end - range.start > 4) {
                        CentraidIcon(
                            "FileText",
                            tint = when (chip.resolution) {
                                NotesLinkResolution.NOTES_LINK_RESOLUTION_TRASHED -> palette.faint
                                NotesLinkResolution.NOTES_LINK_RESOLUTION_MISSING -> palette.missing
                                else -> palette.accentText
                            },
                            size = CHIP_ICON.dp,
                            modifier = Modifier.align(Alignment.CenterStart),
                        )
                    }
                }
            }
        }
    }
}

/** A chip's icon and the space after it, in sp: the second hidden bracket carries both. */
private const val CHIP_ICON = 13f
private const val CHIP_ICON_GAP = 4f

/** The most marks laid over a very large note: past them the words are drawn as text. */
private const val MARK_LIMIT = 400

/** A CHECKLIST CIRCLE: the app's fill under a white tick once done, a ring while not. Drawn, not a control. */
@Composable
private fun NotesCheckCircle(checked: Boolean, side: Float, accent: AppAccent) {
    val ring = Surface.meta
    Canvas(Modifier.fillMaxSize()) {
        val center = Offset(size.width / 2, size.height / 2)
        val stroke = KitGeometry.HAIRLINE.toPx() * 1.5f
        if (checked) {
            drawCircle(accent.fill, radius = side / 2, center = center)
            val tick = Path().apply {
                moveTo(center.x - side * 0.22f, center.y + side * 0.02f)
                lineTo(center.x - side * 0.07f, center.y + side * 0.17f)
                lineTo(center.x + side * 0.22f, center.y - side * 0.16f)
            }
            drawPath(tick, Color.White, style = Stroke(width = stroke * 1.5f, cap = StrokeCap.Round, join = StrokeJoin.Round))
        } else {
            drawCircle(ring, radius = side / 2 - stroke / 2, center = center, style = Stroke(width = stroke))
        }
    }
}

/** The bounds, on one line, of the characters [start, end): the first line when it wraps. */
private fun TextLayoutResult.span(start: Int, end: Int): Rect? {
    val length = layoutInput.text.length
    if (start < 0 || end <= start || end > length) return null
    val line = getLineForOffset(start)
    val last = minOf(end - 1, getLineEnd(line, visibleEnd = false) - 1).coerceAtLeast(start)
    val first = getBoundingBox(start)
    val tail = getBoundingBox(last)
    return Rect(first.topLeft.x, first.top, tail.right, first.bottom)
}

/** The body's colours, all from the kit. */
private data class NotesRichPalette(
    val ink: Color,
    val body: Color,
    val faint: Color,
    val accentText: Color,
    val chipGround: Color,
    val codeGround: Color,
    val missing: Color,
)

private fun NotesTextRange?.within(length: Int): IntRange? {
    val range = this ?: return null
    return if (range.start <= range.end && range.end <= length) range.start until range.end else null
}

/** The body with the core's blocks and spans as styles; the text is the same, character for character. */
private fun styled(text: String, rich: NotesRichText, palette: NotesRichPalette): AnnotatedString = buildAnnotatedString {
    append(text)
    val length = text.length
    fun style(style: SpanStyle, range: IntRange?) {
        if (range != null && !range.isEmpty()) addStyle(style, range.first, range.last + 1)
    }
    rich.blocks.forEach { block -> styleBlock(block, length, palette, ::style) }
    rich.spans.forEach { span -> styleSpan(span, length, palette, ::style) }
}

private fun styleBlock(
    block: NotesRichBlock,
    length: Int,
    palette: NotesRichPalette,
    style: (SpanStyle, IntRange?) -> Unit,
) {
    val line = block.range.within(length) ?: return
    val marker = block.marker.within(length)
    val content = block.content.within(length)
    when (block.kind) {
        NotesRichBlockKind.NOTES_RICH_BLOCK_KIND_HEADING -> {
            // Heading 1 and 2 take the section rung, the rest the row's semibold.
            val size = if (block.level <= 2) KitType.Section.size else KitType.Row.size
            style(SpanStyle(fontSize = size.sp, fontWeight = FontWeight.SemiBold), line)
            style(SpanStyle(color = palette.faint), marker)
        }
        NotesRichBlockKind.NOTES_RICH_BLOCK_KIND_CHECKLIST -> {
            if (marker == null) return
            // The lead (an indent, the dash) and the `[ ]` are drawn clear: the circle stands where
            // the `[ ]` is, and the words follow after a gap.
            style(SpanStyle(color = Color.Transparent), line.first..marker.last)
            val after = marker.last + 1
            if (after <= line.last) style(SpanStyle(letterSpacing = (KitType.Row.size / 2).sp), after..after)
            if (block.checked) {
                style(
                    SpanStyle(color = palette.faint, textDecoration = TextDecoration.LineThrough),
                    content,
                )
            }
        }
        NotesRichBlockKind.NOTES_RICH_BLOCK_KIND_BULLET -> style(SpanStyle(color = palette.accentText), marker)
        NotesRichBlockKind.NOTES_RICH_BLOCK_KIND_QUOTE -> {
            style(SpanStyle(color = palette.faint), marker)
            style(SpanStyle(color = palette.body), content)
        }
        else -> Unit
    }
}

private fun styleSpan(
    span: NotesRichSpan,
    length: Int,
    palette: NotesRichPalette,
    style: (SpanStyle, IntRange?) -> Unit,
) {
    val at = span.range.within(length) ?: return
    when (span.style) {
        NotesRichStyle.NOTES_RICH_STYLE_EMPHASIS -> style(SpanStyle(fontStyle = FontStyle.Italic), at)
        NotesRichStyle.NOTES_RICH_STYLE_STRONG -> style(SpanStyle(fontWeight = FontWeight.SemiBold), at)
        NotesRichStyle.NOTES_RICH_STYLE_STRIKE -> style(SpanStyle(textDecoration = TextDecoration.LineThrough), at)
        NotesRichStyle.NOTES_RICH_STYLE_CODE ->
            style(SpanStyle(fontFamily = FontFamily.Monospace, background = palette.codeGround), at)
        NotesRichStyle.NOTES_RICH_STYLE_SYNTAX -> style(SpanStyle(color = palette.faint), at)
        NotesRichStyle.NOTES_RICH_STYLE_LINK -> {
            val chip = span.chip ?: return
            when {
                chip.kind == NotesLinkChipKind.NOTES_LINK_CHIP_KIND_URL ->
                    style(SpanStyle(color = palette.accentText, textDecoration = TextDecoration.Underline), at)
                chip.resolution == NotesLinkResolution.NOTES_LINK_RESOLUTION_TRASHED ->
                    style(SpanStyle(color = palette.faint, textDecoration = TextDecoration.LineThrough), at)
                chip.resolution == NotesLinkResolution.NOTES_LINK_RESOLUTION_MISSING ->
                    style(SpanStyle(color = palette.missing), at)
                else -> style(
                    SpanStyle(color = palette.accentText, background = palette.chipGround, fontWeight = FontWeight.SemiBold),
                    at,
                )
            }
            // THE BRACKETS ARE HIDDEN, NEVER DELETED (#1173): `[[` and `]]` stay in the text so every
            // offset the core holds is still the text's; they are drawn clear at a hair's size, and
            // the second `[` carries the width of the chip's icon, which the mark draws there.
            if (chip.kind == NotesLinkChipKind.NOTES_LINK_CHIP_KIND_NOTE && at.last - at.first + 1 > 4) {
                val hair = SpanStyle(color = Color.Transparent, fontSize = 1.sp)
                style(hair, at.first..at.first + 1)
                style(hair, at.last - 1..at.last)
                style(SpanStyle(letterSpacing = (CHIP_ICON + CHIP_ICON_GAP).sp), at.first + 1..at.first + 1)
            }
        }
        else -> Unit
    }
}
