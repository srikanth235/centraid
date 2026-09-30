package dev.centraid.android.screens.words

import android.os.Build
import android.text.InputType
import android.view.inputmethod.EditorInfo
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentDataType
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.platform.InterceptPlatformTextInput
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalTextToolbar
import androidx.compose.ui.platform.PlatformTextInputMethodRequest
import androidx.compose.ui.platform.TextToolbar
import androidx.compose.ui.platform.TextToolbarStatus
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDataType
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import centraid.screen.v1.RestoredVaultLine
import centraid.screen.v1.VaultWordsEvent
import centraid.screen.v1.VaultWordsState
import centraid.screen.v1.WordAsk
import centraid.screen.v1.WordCell
import centraid.screen.v1.WordEntry
import centraid.screen.v1.WordsEntryEvent
import centraid.screen.v1.WordsEntryState
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry

// THE 24 WORDS, DRAWN (#1047 E3). Two screens over the shared machines:
// `words.make` (`VaultWordsBridge`) and `words.enter` (`WordsEntryBridge`).
//
// **THESE VIEWS DECIDE NOTHING.** Every phase, every word a member reads, when
// the primary control opens and what a verdict says arrive in the state; the
// views draw it and forward events. What is theirs is what only a view can
// do — `screen.proto`'s three platform duties for the words:
//
// 1. Capture: `FLAG_SECURE` on every window the words are drawn in, set and
//    cleared with `secure` (`WordsSheets`: the activity's window and the
//    sheet's own dialog window, which does not inherit a flag set later).
// 2. No clipboard: a shown word is plain `Text` with no `SelectionContainer`,
//    so it cannot be selected or copied; a word field ([WordField]) has no
//    text toolbar (no Paste, Copy, Cut or Select all) and a clipboard that
//    reads as empty and takes nothing, so neither a long press nor a hardware
//    Ctrl+V moves the phrase through it.
// 3. No learning: autocorrect off, no capitalisation, the ASCII keyboard, and
//    `IME_FLAG_NO_PERSONALIZED_LEARNING`, `TYPE_TEXT_FLAG_NO_SUGGESTIONS` and
//    the visible-password variation on the `EditorInfo` — which Compose's
//    `KeyboardOptions` cannot express, so [NoLearning] adds them where the
//    input connection is made. Autofill
//    sees no field here: `ContentDataType.None` on every field, and the
//    sheet's view is excluded from the autofill structure (`WordsSheets`).

// ---------------------------------------------------------------------------
// words.make — make a vault, and its 24 words
// ---------------------------------------------------------------------------

@Composable
internal fun VaultWordsScreen(state: VaultWordsState, onEvent: (VaultWordsEvent) -> Unit) {
    val requesters = remember { mutableMapOf<Int, FocusRequester>() }
    var focus by remember { mutableStateOf<Int?>(null) }
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val leaveFields = {
        focus = null
        // HIDE FIRST: the controller hides through the field's input
        // session, which the cleared focus ends.
        keyboard?.hide()
        focusManager.clearFocus()
    }
    // CONFIRM opens with the keyboard on the first word asked.
    LaunchedEffect(state.phase) {
        focus = if (state.phase == VaultWordsState.Phase.PHASE_CONFIRM) state.asks.firstOrNull()?.position else null
    }
    FocusOn(focus, requesters)
    WordsPage(testTag = "words-make", description = state.accessibility_label) {
        WordsHead(state.title, state.body)
        if (state.words.isNotEmpty()) ShownWords(state.words)
        if (state.custody.isNotEmpty()) {
            Text(
                state.custody,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                modifier = Modifier.testTag("words-custody"),
            )
        }
        for (ask in state.asks) {
            val position = ask.position
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    ask.prompt,
                    style = centraidType("annotLabel"),
                    color = centraidColor("textSoft"),
                    modifier = Modifier.clearAndSetSemantics { },
                )
                WordField(
                    value = ask.typed,
                    tone = askTone(ask.mark),
                    spoken = ask.prompt,
                    testTag = "words-ask-$position",
                    requester = requesters.getOrPut(position) { FocusRequester() },
                    last = state.asks.lastOrNull()?.position == position,
                    onEdit = { text ->
                        onEvent(VaultWordsEvent(typed = VaultWordsEvent.WordTyped(position = position, text = text)))
                    },
                    onNext = {
                        val later = state.asks.map { it.position }.firstOrNull { it > position }
                        if (later == null) leaveFields() else focus = later
                    },
                )
            }
        }
        WordsNotice(state.notice)
        if (state.phase == VaultWordsState.Phase.PHASE_CHECKING || state.phase == VaultWordsState.Phase.PHASE_MAKING) {
            Box(Modifier.fillMaxWidth().testTag("words-making"), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = centraidColor("textSoft"), modifier = Modifier.size(28.dp))
            }
        }
        WordsControls(
            primary = state.primary_label,
            primaryEnabled = state.primary_enabled,
            secondary = state.secondary_label,
            prefix = "words-make",
            onPrimary = {
                leaveFields()
                onEvent(VaultWordsEvent(primary = VaultWordsEvent.Primary()))
            },
            onSecondary = { onEvent(VaultWordsEvent(secondary = VaultWordsEvent.Secondary())) },
        )
        if (state.restore_label.isNotEmpty()) {
            InkButton(label = state.restore_label, testTag = "words-make-restore") {
                onEvent(VaultWordsEvent(restore = VaultWordsEvent.RestoreTapped()))
            }
        }
    }
}

private fun askTone(mark: WordAsk.Mark): String = when (mark) {
    WordAsk.Mark.MARK_RIGHT -> "success"
    WordAsk.Mark.MARK_WRONG -> "net"
    else -> "lineStrong"
}

/**
 * THE WORDS, SHOWN ONCE: numbered, in two columns, in order down each column.
 * Plain `Text` outside any `SelectionContainer` — nothing here can be selected,
 * so nothing here can reach the clipboard.
 */
@Composable
internal fun ShownWords(cells: List<WordCell>) {
    val half = (cells.size + 1) / 2
    Row(
        Modifier
            .fillMaxWidth()
            .background(centraidColor("bgSunken"), RoundedCornerShape(KitGeometry.RADIUS))
            .padding(16.dp)
            .testTag("words-shown"),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        for (column in listOf(cells.take(half), cells.drop(half))) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                for (cell in column) {
                    Row(
                        Modifier
                            .testTag("words-word-${cell.position}")
                            .clearAndSetSemantics { contentDescription = cell.accessibility_label },
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "${cell.position}",
                            style = centraidType("mono"),
                            color = centraidColor("textFaint"),
                            modifier = Modifier.widthIn(min = 22.dp),
                        )
                        Text(cell.word, style = centraidType("bodyStrong"), color = centraidColor("text"))
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// words.enter — type the words back
// ---------------------------------------------------------------------------

@Composable
internal fun WordsEntryScreen(state: WordsEntryState, onEvent: (WordsEntryEvent) -> Unit) {
    val working = state.phase == WordsEntryState.Phase.PHASE_WORKING
    val requesters = remember { mutableMapOf<Int, FocusRequester>() }
    var focus by remember { mutableStateOf<Int?>(null) }
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    // OUT OF THE FIELDS, AND THE KEYBOARD PUT AWAY: a cleared focus alone
    // leaves it up over a sheet (its own window).
    val leaveFields = {
        // HIDE FIRST: the controller hides through the field's input
        // session, which the cleared focus ends.
        keyboard?.hide()
        focusManager.clearFocus()
    }
    // THE KEYBOARD GOES TO WORD 1 ONCE, when the screen first opens for
    // entry — not again when a verdict brings it back from WORKING, which
    // would pull the member away from the notice to the top of the page.
    var placed by remember { mutableStateOf(false) }
    LaunchedEffect(state.phase) {
        if (state.phase == WordsEntryState.Phase.PHASE_ENTERING && !placed) {
            placed = true
            focus = 1
        }
        if (state.phase != WordsEntryState.Phase.PHASE_ENTERING) {
            focus = null
            leaveFields()
        }
    }
    FocusOn(focus, requesters)
    val moveTo = { next: Int ->
        if (next <= state.cells.size) {
            focus = next
            runCatching { requesters[next]?.requestFocus() }
        } else {
            focus = null
            leaveFields()
        }
    }
    WordsPage(testTag = "words-enter", description = state.accessibility_label) {
        WordsHead(state.title, state.body)
        if (state.cells.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (cell in state.cells) {
                    EntryCell(
                        cell = cell,
                        enabled = !working,
                        requester = requesters.getOrPut(cell.position) { FocusRequester() },
                        onEdit = { text ->
                            onEvent(WordsEntryEvent(typed = WordsEntryEvent.WordTyped(position = cell.position, text = text)))
                            // A SPACE IS HOW A MEMBER MOVES ON: the keyboard goes
                            // at once — in this callback, not after a recomposition
                            // or the machine's answer — to the cell the next letter
                            // belongs in, so it lands where the member is looking.
                            // That is the cell after the last word when the text
                            // ends in a space, and the last word's own cell when
                            // it does not (letters typed before the move landed).
                            // The machine spreads the words; the cells follow it.
                            if (text.any { it.isWhitespace() }) {
                                val words = text.split(Regex("\\s+")).count { it.isNotEmpty() }
                                val open = if (text.last().isWhitespace()) 0 else 1
                                moveTo(cell.position + maxOf(words - open, 1))
                            }
                        },
                        onPick = { word ->
                            onEvent(WordsEntryEvent(picked = WordsEntryEvent.SuggestionPicked(position = cell.position, word = word)))
                            moveTo(cell.position + 1)
                        },
                        onNext = { moveTo(cell.position + 1) },
                        last = cell.position == state.cells.size,
                    )
                }
            }
        }
        if (state.endpoint_label.isNotEmpty()) {
            EndpointField(
                label = state.endpoint_label,
                value = state.endpoint,
                enabled = !working,
                onEdit = { text -> onEvent(WordsEntryEvent(endpoint = WordsEntryEvent.EndpointTyped(text = text))) },
            )
        }
        WordsNotice(state.notice)
        if (state.progress.isNotEmpty()) {
            Row(
                Modifier.testTag("words-progress").semantics(mergeDescendants = true) { },
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(color = centraidColor("textSoft"), modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                Text(state.progress, style = centraidType("small"), color = centraidColor("textSoft"))
            }
        }
        for ((index, line) in state.restored.withIndex()) RestoredLine(line, index)
        for ((index, line) in state.stayed.withIndex()) StayedLine(line, index)
        if (state.retry_label.isNotEmpty()) {
            StayedRetry(state.retry_label) { onEvent(WordsEntryEvent(retry = WordsEntryEvent.Retry())) }
        }
        WordsControls(
            primary = state.primary_label,
            primaryEnabled = state.primary_enabled,
            secondary = state.secondary_label,
            prefix = "words-enter",
            onPrimary = {
                leaveFields()
                onEvent(WordsEntryEvent(primary = WordsEntryEvent.Primary()))
            },
            onSecondary = {
                leaveFields()
                onEvent(WordsEntryEvent(secondary = WordsEntryEvent.Secondary()))
            },
        )
    }
}

/**
 * One of the 24 cells: its number, the field, and the list words its prefix
 * could be — each a tap that sends `SuggestionPicked`.
 */
@Composable
private fun EntryCell(
    cell: WordEntry,
    enabled: Boolean,
    requester: FocusRequester,
    onEdit: (String) -> Unit,
    onPick: (String) -> Unit,
    onNext: () -> Unit,
    last: Boolean,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "${cell.position}",
                style = centraidType("mono"),
                color = centraidColor("textFaint"),
                modifier = Modifier.widthIn(min = 24.dp).clearAndSetSemantics { },
            )
            Box(Modifier.weight(1f)) {
                WordField(
                    value = cell.typed,
                    tone = when (cell.mark) {
                        WordEntry.Mark.MARK_KNOWN -> "success"
                        WordEntry.Mark.MARK_UNKNOWN -> "attention"
                        else -> "lineStrong"
                    },
                    spoken = cell.accessibility_label.ifEmpty { cell.prompt },
                    testTag = "words-cell-${cell.position}",
                    requester = requester,
                    enabled = enabled,
                    last = last,
                    onEdit = onEdit,
                    onNext = onNext,
                )
            }
        }
        if (cell.suggestions.isNotEmpty() && enabled) {
            Row(
                Modifier
                    .padding(start = 34.dp)
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (word in cell.suggestions) {
                    Box(
                        Modifier
                            .heightIn(min = CentraidGeometry.TARGET_MIN_FINE.dp)
                            .background(centraidColor("bgSunken"), CircleShape)
                            .clickable { onPick(word) }
                            .padding(horizontal = 12.dp)
                            .testTag("words-suggestion-${cell.position}-$word")
                            .semantics { role = Role.Button },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(word, style = centraidType("small"), color = centraidColor("text"))
                    }
                }
            }
        }
    }
}

/**
 * The laptop's address, for a restore that cannot find it on its own. Not a
 * word: an ordinary URL field, but it still learns nothing and offers no
 * autofill, since it sits on the same shielded screen.
 */
@Composable
private fun EndpointField(label: String, value: String, enabled: Boolean, onEdit: (String) -> Unit) {
    val text = rememberSentText(value)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = centraidType("small"), color = centraidColor("textSoft"), modifier = Modifier.clearAndSetSemantics { })
        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .border(KitGeometry.HAIRLINE, centraidColor("lineStrong"), RoundedCornerShape(KitGeometry.RADIUS))
                .padding(horizontal = 12.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            NoLearning {
                BasicTextField(
                    value = text.first.value,
                    onValueChange = { next ->
                        val changed = next.text != text.first.value.text
                        text.first.value = next
                        if (changed) {
                            text.second(next.text)
                            onEdit(next.text)
                        }
                    },
                    enabled = enabled,
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Uri,
                        imeAction = ImeAction.Done,
                    ),
                    textStyle = centraidType("body").copy(color = centraidColor("text")),
                    cursorBrush = SolidColor(centraidColor("text")),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("words-endpoint")
                        .semantics {
                            contentDescription = label
                            contentDataType = ContentDataType.None
                        },
                )
            }
        }
    }
}

/**
 * One restored vault: its line, and its safety number large and grouped so it
 * can be read against the laptop's.
 */
@Composable
private fun RestoredLine(line: RestoredVaultLine, index: Int) {
    Column(
        Modifier.testTag("words-restored-$index").semantics(mergeDescendants = true) { },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(line.line, style = centraidType("bodyStrong"), color = centraidColor("text"))
        if (line.safety_number.isNotEmpty()) {
            Text(
                line.safety_number,
                style = centraidType("display"),
                color = centraidColor("text"),
                modifier = Modifier.testTag("words-safety-number"),
            )
            Text(line.safety_label, style = centraidType("small"), color = centraidColor("textSoft"))
        }
    }
}

/**
 * One vault that stayed with the other phone (`WordsEntryState.stayed`,
 * R-1047-R5): the machine's sentence behind a `seam` rule — "not yet, and not
 * wrong" (DESIGN.md), since the vault is safe where it is. The retry under the
 * list is [StayedRetry].
 */
@Composable
private fun StayedLine(line: String, index: Int) {
    Row(
        Modifier
            .height(IntrinsicSize.Min)
            .testTag("words-stayed-$index")
            .semantics(mergeDescendants = true) { },
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(centraidColor("seam")))
        Text(line, style = centraidType("body"), color = centraidColor("text"))
    }
}

/**
 * `retry_label`'s control (R-1047-R6): ask the laptop again for the vaults
 * that stayed. A link-weight text button, like [WordsControls]' secondary; the
 * label and when it shows are the machine's.
 */
@Composable
private fun StayedRetry(label: String, onRetry: () -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
            .clickable(onClick = onRetry)
            .testTag("words-retry")
            .semantics { role = Role.Button },
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(label, style = centraidType("smallStrong"), color = centraidColor("link"))
    }
}

// ---------------------------------------------------------------------------
// shared parts
// ---------------------------------------------------------------------------

/** The sheet's page: a scrolling column that rides above the keyboard. */
@Composable
internal fun WordsPage(testTag: String, description: String, content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp, vertical = 24.dp)
            .testTag(testTag)
            .semantics { if (description.isNotEmpty()) contentDescription = description },
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        content()
    }
}

@Composable
internal fun WordsHead(title: String, lead: String) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (title.isNotEmpty()) {
            Text(
                title,
                style = centraidType("title"),
                color = centraidColor("text"),
                modifier = Modifier.testTag("words-title").semantics { heading() },
            )
        }
        if (lead.isNotEmpty()) Text(lead, style = centraidType("body"), color = centraidColor("textSoft"))
    }
}

@Composable
internal fun WordsNotice(notice: String) {
    if (notice.isEmpty()) return
    Text(notice, style = centraidType("small"), color = centraidColor("net"), modifier = Modifier.testTag("words-notice"))
}

@Composable
internal fun WordsControls(
    primary: String,
    primaryEnabled: Boolean,
    secondary: String,
    prefix: String,
    onPrimary: () -> Unit,
    onSecondary: () -> Unit,
) {
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (primary.isNotEmpty()) {
            InkButton(
                label = primary,
                testTag = "$prefix-primary",
                modifier = Modifier
                    .alpha(if (primaryEnabled) 1f else 0.4f)
                    .semantics { if (!primaryEnabled) disabled() },
                onPress = { if (primaryEnabled) onPrimary() },
            )
        }
        if (secondary.isNotEmpty()) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
                    .clickable(onClick = onSecondary)
                    .testTag("$prefix-secondary")
                    .semantics { role = Role.Button },
                contentAlignment = Alignment.Center,
            ) {
                Text(secondary, style = centraidType("smallStrong"), color = centraidColor("link"))
            }
        }
    }
}

/** Moves the keyboard to [focus]'s field once it is drawn. */
@Composable
private fun FocusOn(focus: Int?, requesters: Map<Int, FocusRequester>) {
    LaunchedEffect(focus) {
        val target = focus ?: return@LaunchedEffect
        runCatching { requesters[target]?.requestFocus() }
    }
}

// ---------------------------------------------------------------------------
// the word field (duties 2 and 3)
// ---------------------------------------------------------------------------

/**
 * A FIELD FOR ONE WORD, with nothing a keyboard could learn from and no menu
 * that could paste or copy.
 *
 * The keystrokes live in the field (a round trip per key loses letters), and
 * each change goes over as the screen's edit event. The field ADOPTS the
 * machine's value only when it is something the field did not send: a picked
 * suggestion, or the words a space ran on into this cell.
 */
@Composable
private fun WordField(
    value: String,
    tone: String,
    spoken: String,
    testTag: String,
    requester: FocusRequester,
    onEdit: (String) -> Unit,
    onNext: () -> Unit,
    last: Boolean,
    enabled: Boolean = true,
) {
    val text = rememberSentText(value)
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
            .border(1.5.dp, centraidColor(tone), RoundedCornerShape(KitGeometry.RADIUS))
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        NoClipboard {
            NoLearning(word = true) {
                BasicTextField(
                    value = text.first.value,
                    onValueChange = { next ->
                        val changed = next.text != text.first.value.text
                        text.first.value = next
                        if (changed) {
                            text.second(next.text)
                            onEdit(next.text)
                        }
                    },
                    enabled = enabled,
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Ascii,
                        imeAction = if (last) ImeAction.Done else ImeAction.Next,
                    ),
                    keyboardActions = KeyboardActions(onNext = { onNext() }, onDone = { onNext() }),
                    visualTransformation = VisualTransformation.None,
                    textStyle = centraidType("body").copy(color = centraidColor("text")),
                    cursorBrush = SolidColor(centraidColor("text")),
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(requester)
                        .testTag(testTag)
                        .semantics {
                            contentDescription = spoken
                            // NOT AN AUTOFILL FIELD: no service fills a word or
                            // is offered one to save.
                            contentDataType = ContentDataType.None
                        },
                )
            }
        }
    }
}

/**
 * THE MACHINE'S VALUE, ADOPTED ONLY WHEN THE FIELD DID NOT SEND IT. Every value
 * this field sent is remembered, so an answer that merely echoes one of them
 * (late or not) never overwrites what is typed now.
 *
 * EXCEPT AFTER A SPACE. Text with whitespace in it is words the machine will
 * spread, so its answer for this cell (the first word alone) is expected to
 * differ from what was sent — and may equal a value sent earlier ("steel" on
 * the way to "steel v"). Sending such text forgets the earlier values, so that
 * answer is adopted.
 */
@Composable
internal fun rememberSentText(value: String): Pair<MutableState<TextFieldValue>, (String) -> Unit> {
    val text = remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
    val sent = remember { mutableSetOf(value) }
    if (value != text.value.text && value !in sent) {
        text.value = TextFieldValue(value, TextRange(value.length))
        sent.clear()
        sent.add(value)
    }
    return text to { next: String ->
        if (next.any { it.isWhitespace() }) sent.clear()
        sent.add(next)
    }
}

/**
 * NO TEXT TOOLBAR AND AN EMPTY, DEAF CLIPBOARD for [content]: a long press
 * offers no Paste, Copy, Cut or Select all, and a hardware Ctrl+V/Ctrl+C reads
 * nothing and writes nothing.
 */
@Composable
private fun NoClipboard(content: @Composable () -> Unit) {
    val real = LocalClipboard.current
    val deaf = remember(real) {
        object : Clipboard {
            override suspend fun getClipEntry(): ClipEntry? = null

            override suspend fun setClipEntry(clipEntry: ClipEntry?) = Unit

            override val nativeClipboard: android.content.ClipboardManager get() = real.nativeClipboard
        }
    }
    CompositionLocalProvider(LocalTextToolbar provides NoTextToolbar, LocalClipboard provides deaf) {
        content()
    }
}

private object NoTextToolbar : TextToolbar {
    override val status: TextToolbarStatus get() = TextToolbarStatus.Hidden

    override fun hide() = Unit

    override fun showMenu(
        rect: Rect,
        onCopyRequested: (() -> Unit)?,
        onPasteRequested: (() -> Unit)?,
        onCutRequested: (() -> Unit)?,
        onSelectAllRequested: (() -> Unit)?,
    ) = Unit
}

/**
 * THE KEYBOARD LEARNS NOTHING HERE. `KeyboardOptions` has no way to say
 * `IME_FLAG_NO_PERSONALIZED_LEARNING`, so the input connection's `EditorInfo`
 * gets it where it is made, with `TYPE_TEXT_FLAG_NO_SUGGESTIONS` (the screen
 * draws its own list-word suggestions from the core).
 *
 * A WORD FIELD IS ALSO A VISIBLE-PASSWORD FIELD ([word]). Gboard treats
 * `NO_SUGGESTIONS` as a hint: on a plain text field it still draws its
 * suggestion strip and takes glide typing, which puts the keyboard's own guess
 * of a word on screen and into the cell (seen on the emulator walk). The
 * `TYPE_TEXT_VARIATION_VISIBLE_PASSWORD` variation is the one every keyboard
 * reads as "no strip, no glide, no learning" while the field still shows what
 * is typed — and autofill never sees it, since the sheet's view is excluded.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun NoLearning(word: Boolean = false, content: @Composable () -> Unit) {
    InterceptPlatformTextInput(
        interceptor = { request, next ->
            val quiet = PlatformTextInputMethodRequest { info ->
                val connection = request.createInputConnection(info)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    info.imeOptions = info.imeOptions or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
                }
                if (info.inputType and InputType.TYPE_MASK_CLASS == InputType.TYPE_CLASS_TEXT) {
                    info.inputType = info.inputType or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                    if (word) {
                        info.inputType = (info.inputType and InputType.TYPE_MASK_VARIATION.inv()) or
                            InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                    }
                }
                connection
            }
            next.startInputMethod(quiet)
        },
        content = content,
    )
}
