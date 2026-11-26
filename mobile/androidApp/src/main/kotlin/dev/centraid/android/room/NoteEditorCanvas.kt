package dev.centraid.android.room

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import centraid.core.v1.RoomAutosave
import centraid.core.v1.RoomAutosavePhase
import centraid.core.v1.RoomCanvasEvent
import centraid.core.v1.RoomNoteEdited
import centraid.core.v1.RoomNoteEditor
import centraid.core.v1.RoomNoteMentionSuggest
import centraid.core.v1.RoomNoteTriggered
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.kitBorderedCard
import dev.centraid.android.kit.kitTextStyle

internal class NoteEditorState(
    initialTitle: String,
    initialBody: String,
    initialRev: Long = 0L,
) {
    var title: String = initialTitle
        private set

    var body: String = initialBody
        private set

    var seq: Long = initialRev
        private set

    private var lastSentSeq: Long = initialRev

    fun onEdit(nextTitle: String, nextBody: String): Triple<String, String, Long>? {
        if (nextTitle == title && nextBody == body) return null
        title = nextTitle
        body = nextBody
        seq += 1L
        lastSentSeq = seq
        return Triple(title, body, seq)
    }

    // Adopt Rust's document only when it differs and no local edit above Rust's rev is unsent.
    fun onRustUpdate(remoteTitle: String, remoteBody: String, rev: Long): Boolean {
        if (rev < lastSentSeq) return false
        if (rev > seq) seq = rev
        if (remoteTitle == title && remoteBody == body) return false
        title = remoteTitle
        body = remoteBody
        lastSentSeq = rev
        return true
    }
}

internal data class DetectedNoteTrigger(
    val trigger: String,
    val query: String,
)

internal fun detectNoteTrigger(body: String, cursor: Int): DetectedNoteTrigger? {
    val pos = cursor.coerceIn(0, body.length)
    val prefix = body.substring(0, pos)
    val lineStart = prefix.lastIndexOf('\n') + 1
    val line = prefix.substring(lineStart)

    val wikiIdx = line.lastIndexOf("[[")
    if (wikiIdx >= 0) {
        val after = line.substring(wikiIdx + 2)
        if (!after.contains("]]")) {
            return DetectedNoteTrigger(trigger = "[[", query = after)
        }
    }

    val atIdx = line.lastIndexOf('@')
    if (atIdx >= 0 && (atIdx == 0 || line[atIdx - 1].isWhitespace())) {
        val after = line.substring(atIdx + 1)
        if (!after.contains(' ')) {
            return DetectedNoteTrigger(trigger = "@", query = after)
        }
    }
    return null
}

@Composable
internal fun NoteEditorCanvas(
    editor: RoomNoteEditor,
    onTap: (String) -> Unit,
    onCanvas: (RoomCanvasEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val selectorId = editor.selector_id.ifEmpty { "note_editor" }
    val controller = remember(selectorId) { NoteEditorState(editor.title, editor.body, editor.rev) }
    var titleValue by remember(selectorId) {
        mutableStateOf(TextFieldValue(text = editor.title, selection = TextRange(editor.title.length)))
    }
    var bodyValue by remember(selectorId) {
        mutableStateOf(TextFieldValue(text = editor.body, selection = TextRange(editor.body.length)))
    }
    var lastTrigger by remember(selectorId) { mutableStateOf<DetectedNoteTrigger?>(null) }

    LaunchedEffect(editor.title, editor.body, editor.rev) {
        if (controller.onRustUpdate(editor.title, editor.body, editor.rev)) {
            if (titleValue.text != editor.title) {
                titleValue = TextFieldValue(
                    text = editor.title,
                    selection = TextRange(titleValue.selection.start.coerceAtMost(editor.title.length)),
                )
            }
            if (bodyValue.text != editor.body) {
                bodyValue = TextFieldValue(
                    text = editor.body,
                    selection = TextRange(bodyValue.selection.start.coerceAtMost(editor.body.length)),
                )
            }
        }
    }

    val bodyFocus = remember(selectorId) { FocusRequester() }
    LaunchedEffect(selectorId, editor.focused) {
        if (editor.focused && !editor.read_only) {
            runCatching { bodyFocus.requestFocus() }
        }
    }

    fun emitEdit(nextTitle: String, nextBody: String) {
        controller.onEdit(nextTitle, nextBody)?.let { (t, b, seq) ->
            onCanvas(
                RoomCanvasEvent(
                    selector_id = selectorId,
                    note_edit = RoomNoteEdited(
                        title = t,
                        body = b,
                        seq = seq,
                        base_revision_id = editor.base_revision_id,
                    ),
                ),
            )
        }
    }

    fun checkTrigger(value: TextFieldValue) {
        val detected = detectNoteTrigger(value.text, value.selection.end)
        if (detected != lastTrigger) {
            lastTrigger = detected
            if (detected != null) {
                onCanvas(
                    RoomCanvasEvent(
                        selector_id = selectorId,
                        note_trigger = RoomNoteTriggered(
                            trigger = detected.trigger,
                            query = detected.query,
                        ),
                    ),
                )
            }
        }
    }

    val notesAccent = appAccent("notes")
    val inkColor = Surface.ink
    val metaColor = Surface.meta
    val accentText = notesAccent.text
    val accentTint = notesAccent.tint ?: notesAccent.wash(false)
    val surfaceFill = Surface.fill

    val markdownTransformation = remember(inkColor, metaColor, accentText, accentTint, surfaceFill) {
        MarkdownHighlightTransformation(
            ink = inkColor,
            meta = metaColor,
            accentText = accentText,
            accentTint = accentTint,
            codeBg = surfaceFill,
        )
    }

    Column(
        modifier
            .fillMaxWidth()
            .testTag(selectorId),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        editor.autosave?.let { autosave ->
            NoteAutosaveStrip(autosave = autosave, onTap = onTap)
        }

        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = KitGeometry.GUTTER),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (editor.read_only) {
                if (editor.title.isNotEmpty()) {
                    KitText(
                        text = editor.title,
                        rung = KitType.Hero,
                        color = Surface.ink,
                        modifier = Modifier
                            .testTag("$selectorId-title")
                            .semantics { heading() },
                    )
                }
                NoteReadOnlyBody(body = editor.body)
            } else {
                Box(Modifier.fillMaxWidth()) {
                    if (titleValue.text.isEmpty()) {
                        KitText("Title", KitType.Hero, Surface.meta)
                    }
                    BasicTextField(
                        value = titleValue,
                        onValueChange = { incoming ->
                            titleValue = incoming
                            if (incoming.composition == null) {
                                emitEdit(incoming.text, bodyValue.text)
                            }
                        },
                        singleLine = true,
                        textStyle = kitTextStyle(KitType.Hero).copy(color = Surface.ink),
                        cursorBrush = SolidColor(notesAccent.fill),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("$selectorId-title")
                            .semantics { contentDescription = "Note title" },
                    )
                }

                Box(Modifier.fillMaxWidth().heightIn(min = 140.dp)) {
                    if (bodyValue.text.isEmpty()) {
                        KitText("Start writing…", KitType.Row, Surface.meta)
                    }
                    BasicTextField(
                        value = bodyValue,
                        onValueChange = { incoming ->
                            bodyValue = incoming
                            if (incoming.composition == null) {
                                emitEdit(titleValue.text, incoming.text)
                                checkTrigger(incoming)
                            }
                        },
                        textStyle = kitTextStyle(KitType.Row).copy(color = Surface.ink),
                        cursorBrush = SolidColor(notesAccent.fill),
                        visualTransformation = markdownTransformation,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        modifier = Modifier
                            .fillMaxWidth()
                            .focusRequester(bodyFocus)
                            .testTag("$selectorId-body")
                            .semantics { contentDescription = "Note body" },
                    )
                }
            }
        }

        if (editor.assets.isNotEmpty()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .testTag("$selectorId-assets"),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                editor.assets.forEach { asset ->
                    RoomMediaBlock(media = asset, onTap = onTap)
                }
            }
        }

        val suggest = editor.suggest
        if (!editor.read_only && suggest != null && suggest.candidates.isNotEmpty()) {
            NoteSuggestStrip(suggest = suggest, onTap = onTap)
        }

        if (!editor.read_only) {
            NoteFormattingBar(
                selectorId = selectorId,
                onAction = { action ->
                    val next = applyMarkdownAction(bodyValue, action)
                    bodyValue = next
                    emitEdit(titleValue.text, next.text)
                    checkTrigger(next)
                },
            )
        }
    }
}

@Composable
private fun NoteAutosaveStrip(
    autosave: RoomAutosave,
    onTap: (String) -> Unit,
) {
    if (autosave.label.isEmpty() && autosave.reload_label.isEmpty()) return
    val isAlert = autosave.refused ||
        autosave.phase == RoomAutosavePhase.ROOM_AUTOSAVE_PHASE_REFUSED ||
        autosave.phase == RoomAutosavePhase.ROOM_AUTOSAVE_PHASE_CONFLICT

    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .testTag("note-autosave-strip"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (autosave.label.isNotEmpty()) {
            KitText(
                text = autosave.label,
                rung = KitType.Meta,
                color = if (isAlert) StateColor.Red.text else Surface.meta,
                modifier = Modifier.weight(1f),
            )
        } else {
            Spacer(Modifier.weight(1f))
        }
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
private fun NoteSuggestStrip(
    suggest: RoomNoteMentionSuggest,
    onTap: (String) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .kitBorderedCard()
            .padding(vertical = 4.dp)
            .testTag("note-suggest-strip"),
    ) {
        val header = buildString {
            append(suggest.trigger)
            if (suggest.query.isNotEmpty()) append(suggest.query)
        }
        if (header.isNotEmpty()) {
            KitText(
                text = header,
                rung = KitType.Badge,
                color = Surface.meta,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
            )
        }
        suggest.candidates.forEachIndexed { idx, candidate ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = KitGeometry.ROW_MIN)
                    .clickable(enabled = candidate.selector_id.isNotEmpty()) { onTap(candidate.selector_id) }
                    .padding(horizontal = 12.dp, vertical = 8.dp)
                    .testTag(candidate.selector_id.ifEmpty { "note-suggest-$idx" })
                    .semantics(mergeDescendants = true) { role = Role.Button },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                KitText(candidate.title, KitType.Row, Surface.ink, Modifier.weight(1f), maxLines = 1)
                if (candidate.noun.isNotEmpty()) {
                    KitText(candidate.noun, KitType.Meta, Surface.meta, maxLines = 1)
                }
            }
            if (idx < suggest.candidates.lastIndex) RoomHairline(startIndent = 12.dp)
        }
    }
}

private enum class MarkdownFormatAction(val key: String, val label: String) {
    HEADING("heading", "Heading"),
    CHECKLIST("checklist", "Checklist"),
    BULLET("bullet", "Bullet list"),
    BOLD("bold", "Bold"),
    ITALIC("italic", "Italic"),
    CODE("code", "Code"),
    WIKI_LINK("wiki", "Insert link"),
    MENTION("mention", "Mention person"),
}

@Composable
private fun NoteFormattingBar(
    selectorId: String,
    onAction: (MarkdownFormatAction) -> Unit,
) {
    Column(Modifier.fillMaxWidth().testTag("$selectorId-toolbar")) {
        RoomHairline()
        Row(
            Modifier
                .fillMaxWidth()
                .background(Surface.card)
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 10.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FormatTextKey("H", MarkdownFormatAction.HEADING, "$selectorId-fmt-heading", onAction)
            FormatIconKey("ListChecks", MarkdownFormatAction.CHECKLIST, "$selectorId-fmt-checklist", onAction)
            FormatIconKey("List", MarkdownFormatAction.BULLET, "$selectorId-fmt-bullet", onAction)
            FormatTextKey("B", MarkdownFormatAction.BOLD, "$selectorId-fmt-bold", onAction, bold = true)
            FormatTextKey("I", MarkdownFormatAction.ITALIC, "$selectorId-fmt-italic", onAction, italic = true)
            FormatIconKey("Code", MarkdownFormatAction.CODE, "$selectorId-fmt-code", onAction)
            FormatTextKey("[[", MarkdownFormatAction.WIKI_LINK, "$selectorId-fmt-wiki", onAction)
            FormatTextKey("@", MarkdownFormatAction.MENTION, "$selectorId-fmt-mention", onAction)
        }
    }
}

@Composable
private fun FormatTextKey(
    symbol: String,
    action: MarkdownFormatAction,
    tag: String,
    onAction: (MarkdownFormatAction) -> Unit,
    bold: Boolean = false,
    italic: Boolean = false,
) {
    Box(
        Modifier
            .size(KitGeometry.ROW_MIN)
            .clip(RoundedCornerShape(8.dp))
            .clickable { onAction(action) }
            .testTag(tag)
            .semantics {
                role = Role.Button
                contentDescription = action.label
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = symbol,
            style = kitTextStyle(KitType.Row).copy(
                fontWeight = if (bold) FontWeight.Bold else FontWeight.SemiBold,
                fontStyle = if (italic) FontStyle.Italic else FontStyle.Normal,
            ),
            color = Surface.ink,
        )
    }
}

@Composable
private fun FormatIconKey(
    iconKey: String,
    action: MarkdownFormatAction,
    tag: String,
    onAction: (MarkdownFormatAction) -> Unit,
) {
    Box(
        Modifier
            .size(KitGeometry.ROW_MIN)
            .clip(RoundedCornerShape(8.dp))
            .clickable { onAction(action) }
            .testTag(tag)
            .semantics {
                role = Role.Button
                contentDescription = action.label
            },
        contentAlignment = Alignment.Center,
    ) {
        CentraidIcon(iconKey = iconKey, tint = Surface.ink, size = 18.dp)
    }
}

private fun applyMarkdownAction(current: TextFieldValue, action: MarkdownFormatAction): TextFieldValue {
    val text = current.text
    val start = current.selection.min.coerceIn(0, text.length)
    val end = current.selection.max.coerceIn(start, text.length)
    val selected = text.substring(start, end)

    return when (action) {
        MarkdownFormatAction.HEADING -> insertLinePrefix(text, start, "# ")
        MarkdownFormatAction.CHECKLIST -> insertLinePrefix(text, start, "- [ ] ")
        MarkdownFormatAction.BULLET -> insertLinePrefix(text, start, "- ")
        MarkdownFormatAction.BOLD -> wrapSelection(text, start, end, selected, "**", "**")
        MarkdownFormatAction.ITALIC -> wrapSelection(text, start, end, selected, "*", "*")
        MarkdownFormatAction.CODE -> wrapSelection(text, start, end, selected, "`", "`")
        MarkdownFormatAction.WIKI_LINK -> {
            val inserted = if (selected.isEmpty()) "[[" else "[[$selected]]"
            val updated = text.substring(0, start) + inserted + text.substring(end)
            val cursor = start + inserted.length
            TextFieldValue(updated, TextRange(cursor))
        }
        MarkdownFormatAction.MENTION -> {
            val inserted = "@$selected"
            val updated = text.substring(0, start) + inserted + text.substring(end)
            val cursor = start + inserted.length
            TextFieldValue(updated, TextRange(cursor))
        }
    }
}

private fun insertLinePrefix(text: String, cursor: Int, prefix: String): TextFieldValue {
    val lineStart = text.lastIndexOf('\n', (cursor - 1).coerceAtLeast(0)).let { if (it < 0) 0 else it + 1 }
    val updated = text.substring(0, lineStart) + prefix + text.substring(lineStart)
    return TextFieldValue(updated, TextRange(cursor + prefix.length))
}

private fun wrapSelection(
    text: String,
    start: Int,
    end: Int,
    selected: String,
    open: String,
    close: String,
): TextFieldValue {
    val updated = text.substring(0, start) + open + selected + close + text.substring(end)
    val nextCursor = if (selected.isEmpty()) start + open.length else end + open.length + close.length
    return TextFieldValue(updated, TextRange(nextCursor))
}

@Composable
private fun NoteReadOnlyBody(body: String) {
    val notesAccent = appAccent("notes")
    val lines = body.split("\n")
    Column(
        Modifier
            .fillMaxWidth()
            .testTag("note-readonly-body"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        lines.forEach { rawLine ->
            val trimmed = rawLine.trimStart()
            when {
                trimmed.startsWith("# ") -> {
                    KitText(
                        text = trimmed.removePrefix("# "),
                        rung = KitType.Section,
                        color = Surface.ink,
                        modifier = Modifier.padding(top = 4.dp).semantics { heading() },
                    )
                }
                trimmed.startsWith("## ") -> {
                    KitText(
                        text = trimmed.removePrefix("## "),
                        rung = KitType.Row,
                        color = Surface.ink,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
                trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ") -> {
                    NoteChecklistLine(
                        text = trimmed.drop(6),
                        checked = true,
                        accentFill = notesAccent.fill,
                    )
                }
                trimmed.startsWith("- [ ] ") -> {
                    NoteChecklistLine(
                        text = trimmed.drop(6),
                        checked = false,
                        accentFill = notesAccent.fill,
                    )
                }
                trimmed.startsWith("- ") -> {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        KitText("•", KitType.Row, Surface.meta)
                        Text(
                            text = styleInlineMarkdown(
                                text = trimmed.drop(2),
                                accentText = notesAccent.text,
                                accentTint = notesAccent.tint ?: Surface.fill,
                                codeBg = Surface.fill,
                            ),
                            style = kitTextStyle(KitType.Row),
                            color = Surface.ink,
                        )
                    }
                }
                rawLine.isBlank() -> Spacer(Modifier.size(6.dp))
                else -> {
                    Text(
                        text = styleInlineMarkdown(
                            text = rawLine,
                            accentText = notesAccent.text,
                            accentTint = notesAccent.tint ?: Surface.fill,
                            codeBg = Surface.fill,
                        ),
                        style = kitTextStyle(KitType.Row),
                        color = Surface.ink,
                    )
                }
            }
        }
    }
}

@Composable
private fun NoteChecklistLine(
    text: String,
    checked: Boolean,
    accentFill: Color,
) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            Modifier
                .padding(top = 1.dp)
                .size(22.dp)
                .clip(CircleShape)
                .then(
                    if (checked) {
                        Modifier.background(accentFill)
                    } else {
                        Modifier.border(1.6.dp, Surface.border, CircleShape)
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (checked) {
                CentraidIcon("Check", tint = Color.White, size = 12.dp)
            }
        }
        Text(
            text = text,
            style = kitTextStyle(KitType.Row).copy(
                textDecoration = if (checked) TextDecoration.LineThrough else TextDecoration.None,
            ),
            color = if (checked) Surface.meta else Surface.ink,
            maxLines = 4,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

private fun styleInlineMarkdown(
    text: String,
    accentText: Color,
    accentTint: Color,
    codeBg: Color,
): AnnotatedString = buildAnnotatedString {
    append(text)
    applyMarkdownSpans(text, accentText, accentTint, codeBg)
}

private class MarkdownHighlightTransformation(
    private val ink: Color,
    private val meta: Color,
    private val accentText: Color,
    private val accentTint: Color,
    private val codeBg: Color,
) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        val styled = buildAnnotatedString {
            append(text.text)
            val raw = text.text
            var lineStart = 0
            raw.split("\n").forEach { line ->
                val lineEnd = lineStart + line.length
                if (line.startsWith("# ")) {
                    addStyle(SpanStyle(fontWeight = FontWeight.Bold, color = ink), lineStart, lineEnd)
                } else if (line.startsWith("- [x] ") || line.startsWith("- [X] ")) {
                    addStyle(
                        SpanStyle(color = meta, textDecoration = TextDecoration.LineThrough),
                        lineStart + 6,
                        lineEnd,
                    )
                }
                lineStart = lineEnd + 1
            }
            applyMarkdownSpans(raw, accentText, accentTint, codeBg)
        }
        return TransformedText(styled, OffsetMapping.Identity)
    }
}

private val WIKI_LINK_REGEX = Regex("\\[\\[[^\\]]+\\]\\]")
private val MENTION_REGEX = Regex("(?<=^|\\s)@[\\p{L}\\p{N}_.-]+")
private val BOLD_REGEX = Regex("\\*\\*[^*]+\\*\\*")
private val CODE_REGEX = Regex("`[^`]+`")

private fun AnnotatedString.Builder.applyMarkdownSpans(
    raw: String,
    accentText: Color,
    accentTint: Color,
    codeBg: Color,
) {
    WIKI_LINK_REGEX.findAll(raw).forEach { match ->
        addStyle(
            SpanStyle(color = accentText, background = accentTint, fontWeight = FontWeight.SemiBold),
            match.range.first,
            match.range.last + 1,
        )
    }
    MENTION_REGEX.findAll(raw).forEach { match ->
        addStyle(
            SpanStyle(color = accentText, fontWeight = FontWeight.SemiBold),
            match.range.first,
            match.range.last + 1,
        )
    }
    BOLD_REGEX.findAll(raw).forEach { match ->
        addStyle(
            SpanStyle(fontWeight = FontWeight.Bold),
            match.range.first,
            match.range.last + 1,
        )
    }
    CODE_REGEX.findAll(raw).forEach { match ->
        addStyle(
            SpanStyle(fontFamily = FontFamily.Monospace, background = codeBg),
            match.range.first,
            match.range.last + 1,
        )
    }
}
