package dev.centraid.android.screens.words

import dev.centraid.android.kit.SecureWindow
import android.os.Build
import android.text.InputType
import android.view.inputmethod.EditorInfo
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.kitCard
import dev.centraid.android.kit.kitTextStyle
import dev.centraid.android.theme.centraidDark
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
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentDataType
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
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
import centraid.core.v1.WordsEndpointTyped
import centraid.core.v1.RestoredVaultLine
import centraid.core.v1.WordsSuggestionPicked
import centraid.core.v1.WordCell
import centraid.core.v1.WordEntry
import centraid.core.v1.WordsWordTyped
import centraid.core.v1.WordsEnterEvent
import centraid.core.v1.WordsEnterState
import centraid.core.v1.WordsMakeEvent
import centraid.core.v1.WordsMakeState
import centraid.core.v1.WordsNameTyped
import centraid.core.v1.WordsOwnToggled
import centraid.core.v1.WordsPrimary
import centraid.core.v1.WordsRestoreTapped
import centraid.core.v1.WordsRetry
import centraid.core.v1.WordsSaveCopy
import centraid.core.v1.WordsSecondary
import centraid.core.v1.WordsUseWords
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ChoiceStack
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry
import dev.centraid.android.kit.KitSpinner
import dev.centraid.android.kit.NoAutofill
import dev.centraid.android.theme.LocalCentraidTokens

// THE 24 WORDS, DRAWN (#1047 E3). Two screens over the shared machines:
// `words.make` and `words.enter`, drawn from Rust's view state.
//
// **THESE VIEWS DECIDE NOTHING.** Every phase, every word a member reads, when
// the primary control opens and what a verdict says arrive in the state; the
// views draw it and forward events. What is theirs is what only a view can
// do — `screen.proto`'s three platform duties for the words:
//
// 1. Capture: `FLAG_SECURE` on every window the words are drawn in, set and
//    cleared with `secure` (`kit/SecureWindow.kt`, counted with any other
//    holder of the activity's window).
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
//    sees no field here: `ContentDataType.None` on every field.

// ---------------------------------------------------------------------------
// words.make — make a vault, and its 24 words
// ---------------------------------------------------------------------------

@Composable
internal fun VaultWordsScreen(state: WordsMakeState, onEvent: (WordsMakeEvent) -> Unit) {
    SecureWindow(state.secure)
    NoAutofill()
    WordsPage(
        testTag = "words-make",
        description = state.accessibility_label,
        closeLabel = state.secondary_label,
        closeTag = "words-make-secondary",
        onClose = { onEvent(WordsMakeEvent(secondary = WordsSecondary())) },
        footer = {
            if (state.save_label.isNotEmpty() && state.words.isNotEmpty()) {
                WordsTonalButton(state.save_label, testTag = "words-save-copy", iconKey = "Share") {
                    onEvent(WordsMakeEvent(save_copy = WordsSaveCopy()))
                }
            }
            // THE PRIMARY AND RESTORING ARE ALTERNATIVES: one ink button.
            if (state.primary_label.isNotEmpty()) {
                InkButton(
                    label = state.primary_label,
                    testTag = "words-make-primary",
                    enabled = state.primary_enabled,
                ) { onEvent(WordsMakeEvent(primary = WordsPrimary())) }
            }
            if (state.restore_label.isNotEmpty()) {
                val restore = { onEvent(WordsMakeEvent(restore = WordsRestoreTapped())) }
                if (state.primary_label.isEmpty()) {
                    InkButton(label = state.restore_label, testTag = "words-make-restore", onPress = restore)
                } else {
                    WordsTonalButton(state.restore_label, testTag = "words-make-restore", onPress = restore)
                }
            }
        },
    ) {
        WordsHead(state.title, state.body)
        // CHOOSE (R-1047-E18): the vault's name, and whether it gets its own
        // recovery key.
        if (state.name_label.isNotEmpty()) {
            EndpointField(
                label = state.name_label,
                value = state.name,
                enabled = true,
                name = true,
                onEdit = { text -> onEvent(WordsMakeEvent(name = WordsNameTyped(text = text))) },
            )
        }
        if (state.own_label.isNotEmpty()) {
            WordsCheckbox(state.own_label, state.own_on, testTag = "words-make-own") { on ->
                onEvent(WordsMakeEvent(own = WordsOwnToggled(on = on)))
            }
        }
        if (state.words.isNotEmpty()) ShownWords(state.words)
        // WHERE THE KEY IS KEPT, in the platform's own words: something the member should act
        // on (Save a copy), so it is amber.
        if (state.custody.isNotEmpty()) WordsCallout(state.custody, StateColor.Amber, testTag = "words-custody")
        WordsNotice(state.notice)
        if (state.phase == WordsMakeState.Phase.PHASE_CHECKING || state.phase == WordsMakeState.Phase.PHASE_MAKING) {
            Box(Modifier.fillMaxWidth().testTag("words-making"), contentAlignment = Alignment.Center) {
                KitSpinner()
            }
        }
    }
}

/**
 * A CHECKBOX on the words screens: the make flow's "Give this vault its own
 * recovery key" (`WordsMakeState.own_label`).
 */
@Composable
private fun WordsCheckbox(label: String, on: Boolean, testTag: String, onToggle: (Boolean) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
            .toggleable(value = on, role = Role.Checkbox, onValueChange = onToggle)
            .testTag(testTag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier
                .size(22.dp)
                .background(if (on) centraidColor("text") else Color.Transparent, RoundedCornerShape((LocalCentraidTokens.current.radii["sm"] ?: 0).dp))
                .border(1.5.dp, centraidColor(if (on) "text" else "lineStrong"), RoundedCornerShape((LocalCentraidTokens.current.radii["sm"] ?: 0).dp)),
            contentAlignment = Alignment.Center,
        ) {
            if (on) CentraidIcon(iconKey = "Check", tint = centraidColor("textInv"), size = 13.dp)
        }
        KitText(label, KitType.Row, Surface.ink)
    }
}

/**
 * THE WORDS, SHOWN ONCE: numbered across three columns, each a white chip. Plain `Text` outside
 * any `SelectionContainer` — nothing here can be selected, so nothing here can reach the
 * clipboard.
 */
@Composable
internal fun ShownWords(cells: List<WordCell>) {
    Column(
        Modifier.fillMaxWidth().testTag("words-shown"),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (row in cells.chunked(WORD_COLUMNS)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (cell in row) {
                    Row(
                        Modifier
                            .weight(1f)
                            .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
                            .wordsBox()
                            .padding(horizontal = 10.dp)
                            .testTag("words-word-${cell.position}")
                            .clearAndSetSemantics { contentDescription = cell.accessibility_label },
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("${cell.position}", style = centraidType("mono"), color = Surface.meta)
                        Text(
                            cell.word,
                            style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
                            color = Surface.ink,
                            maxLines = 1,
                        )
                    }
                }
                // A short last row keeps its cells the same width as the rows above it.
                repeat(WORD_COLUMNS - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

/** The columns the words sit in, numbered across. */
private const val WORD_COLUMNS = 3

// ---------------------------------------------------------------------------
// words.enter — type the words back
// ---------------------------------------------------------------------------

@Composable
internal fun WordsEntryScreen(
    state: WordsEnterState,
    onEvent: (WordsEnterEvent) -> Unit,
    onScan: () -> Unit = {},
    onPhoto: () -> Unit = {},
) {
    val working = state.phase == WordsEnterState.Phase.PHASE_WORKING
    val held = state.held_found.isNotEmpty()
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
        if (state.phase == WordsEnterState.Phase.PHASE_ENTERING && !placed) {
            placed = true
            focus = 1
        }
        if (state.phase != WordsEnterState.Phase.PHASE_ENTERING) {
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
    val scan = { if (state.scan_camera) onScan() else onPhoto() }
    WordsPage(
        testTag = "words-enter",
        description = state.accessibility_label,
        closeLabel = state.secondary_label,
        closeTag = "words-enter-secondary",
        onClose = {
            leaveFields()
            onEvent(WordsEnterEvent(secondary = WordsSecondary()))
        },
        footer = {
            // LEAVE THE HELD SEED for the grid: a link, then the scan, then the verb.
            if (state.words_label.isNotEmpty()) {
                WordsLink(state.words_label, testTag = "words-use-words") {
                    onEvent(WordsEnterEvent(use_words = WordsUseWords()))
                }
            }
            if (state.scan_label.isNotEmpty() && held) {
                WordsTonalButton(state.scan_label, testTag = "words-scan", iconKey = "Maximize", enabled = !working, onPress = scan)
            }
            if (state.retry_label.isNotEmpty()) {
                WordsTonalButton(state.retry_label, testTag = "words-retry") {
                    onEvent(WordsEnterEvent(retry = WordsRetry()))
                }
            }
            if (state.primary_label.isNotEmpty()) {
                InkButton(
                    label = state.primary_label,
                    testTag = "words-enter-primary",
                    enabled = state.primary_enabled,
                ) {
                    leaveFields()
                    onEvent(WordsEnterEvent(primary = WordsPrimary()))
                }
            }
        },
    ) {
        // THE RESULT OF A RESTORE has its own head: a round mark over a centred title.
        val done = state.phase == WordsEnterState.Phase.PHASE_DONE
        if (done && (state.restored.isNotEmpty() || state.stayed.isNotEmpty())) {
            WordsResultHead(if (state.stayed.isEmpty()) "Check" else "Refresh", state.title, state.body)
        } else {
            WordsHead(state.title, state.body)
        }
        // A HELD KEY IS ALREADY HERE: say so, and where it came from.
        if (held) WordsHeldCard(state.held_found, state.held_place)
        if (state.cells.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (row in state.cells.chunked(WORD_COLUMNS)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (cell in row) {
                            Box(Modifier.weight(1f)) {
                                EntryCell(
                                    cell = cell,
                                    enabled = !working,
                                    requester = requesters.getOrPut(cell.position) { FocusRequester() },
                                    onEdit = { text ->
                                        onEvent(WordsEnterEvent(typed = WordsWordTyped(position = cell.position, text = text)))
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
                                    onNext = { moveTo(cell.position + 1) },
                                    last = cell.position == state.cells.size,
                                )
                            }
                        }
                        repeat(WORD_COLUMNS - row.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
            // THE LIST WORDS THE FOCUSED CELL'S PREFIX COULD BE, each a tap that sends
            // `WordsSuggestionPicked`: one row under the grid, for the cell being typed in.
            val suggesting = state.cells.firstOrNull { it.position == focus && it.suggestions.isNotEmpty() }
                ?: state.cells.firstOrNull { it.suggestions.isNotEmpty() }
            if (suggesting != null && !working) {
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    for (word in suggesting.suggestions) {
                        Box(
                            Modifier
                                .heightIn(min = CentraidGeometry.TARGET_MIN_FINE.dp)
                                .clip(CircleShape)
                                .background(Surface.card)
                                .border(KitGeometry.HAIRLINE, Surface.border, CircleShape)
                                .clickable {
                                    onEvent(WordsEnterEvent(picked = WordsSuggestionPicked(position = suggesting.position, word = word)))
                                    moveTo(suggesting.position + 1)
                                }
                                .padding(horizontal = 12.dp)
                                .testTag("words-suggestion-${suggesting.position}-$word")
                                .semantics { role = Role.Button },
                            contentAlignment = Alignment.Center,
                        ) {
                            KitText(word, KitType.Meta, Surface.ink)
                        }
                    }
                }
            }
        }
        WordsNotice(state.notice)
        if (state.endpoint_label.isNotEmpty()) {
            EndpointField(
                label = state.endpoint_label,
                value = state.endpoint,
                enabled = !working,
                placeholder = state.endpoint_placeholder,
                mono = held,
                onEdit = { text -> onEvent(WordsEnterEvent(endpoint = WordsEndpointTyped(text = text))) },
                // THE CODE IS SCANNED AS WELL AS PASTED, as pairing's is: the camera, or the
                // photo picker where there is none (`scan_camera`). Beside the field while the
                // words are typed; a held restore has the room for a full-width one below.
                trailing = if (state.scan_label.isNotEmpty() && !held) {
                    { WordsScanSquare(state.scan_label, enabled = !working, onPress = scan) }
                } else {
                    null
                },
            )
        }
        // A HELD RESTORE NAMES the vaults on their own words it will also
        // bring back (R-1047-E18).
        if (state.held_keys_label.isNotEmpty()) {
            Column(
                Modifier.testTag("words-held-keys"),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                KitText(state.held_keys_label, KitType.Meta, Surface.meta)
                WordsHeldKeys(state.held_keys)
            }
        }
        if (state.progress.isNotEmpty()) {
            Row(
                Modifier.testTag("words-progress").semantics(mergeDescendants = true) { },
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                KitSpinner(state.progress)
            }
        }
        // WHAT CAME BACK AND WHAT STAYED, one card.
        if (state.restored.isNotEmpty() || state.stayed.isNotEmpty()) {
            WordsResultCard(state.restored, state.stayed)
        }
    }
}

/**
 * One of the 24 cells: its number inside a white box, the field, and a mark on the edge: red for
 * a word that is not on the list, the shell's teal for the cell being typed in.
 */
@Composable
private fun EntryCell(
    cell: WordEntry,
    enabled: Boolean,
    requester: FocusRequester,
    onEdit: (String) -> Unit,
    onNext: () -> Unit,
    last: Boolean,
) {
    WordField(
        number = cell.position,
        value = cell.typed,
        placeholder = cell.prompt,
        unknown = cell.mark == WordEntry.Mark.MARK_UNKNOWN,
        spoken = cell.accessibility_label.ifEmpty { cell.prompt },
        testTag = "words-cell-${cell.position}",
        requester = requester,
        enabled = enabled,
        last = last,
        onEdit = onEdit,
        onNext = onNext,
    )
}

/** The card that says a recovery key is already on this phone, and where it came from. */
@Composable
private fun WordsHeldCard(found: String, place: String) {
    val accent = appAccent()
    Row(
        Modifier
            .fillMaxWidth()
            .kitCard()
            .padding(12.dp)
            .testTag("words-held-found")
            .semantics(mergeDescendants = true) { },
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(44.dp).wordsBox(fill = accent.wash(centraidDark()), border = null),
            contentAlignment = Alignment.Center,
        ) {
            CentraidIcon(iconKey = "Key", tint = accent.text, size = 20.dp)
        }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(found, style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold), color = Surface.ink)
            if (place.isNotEmpty()) KitText(place, KitType.Meta, Surface.meta)
        }
    }
}

/** The vaults on their own recovery key, one white card of rows: an initial, then the name. */
@Composable
private fun WordsHeldKeys(names: List<String>) {
    Column(Modifier.fillMaxWidth().kitCard()) {
        for ((at, name) in names.withIndex()) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier.size(32.dp).wordsBox(fill = Surface.fill, border = null).clearAndSetSemantics { },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        name.take(1).uppercase(),
                        style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
                        color = Surface.ink,
                    )
                }
                KitText(name, KitType.Row, Surface.ink)
            }
            if (at < names.size - 1) Box(Modifier.fillMaxWidth().height(KitGeometry.HAIRLINE).background(Surface.line))
        }
    }
}

/**
 * The result of a restore: a round mark over a centred title. A restore with a vault that stayed
 * wears the refresh mark, one that brought everything back the check.
 */
@Composable
private fun WordsResultHead(iconKey: String, title: String, lead: String) {
    val accent = appAccent()
    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier.size(60.dp).clip(CircleShape).background(accent.wash(centraidDark())).clearAndSetSemantics { },
            contentAlignment = Alignment.Center,
        ) {
            CentraidIcon(iconKey = iconKey, tint = accent.text, size = 26.dp)
        }
        Text(
            title,
            style = kitTextStyle(KitType.Title),
            color = Surface.ink,
            textAlign = TextAlign.Center,
            modifier = Modifier.testTag("words-title").semantics { heading() },
        )
        if (lead.isNotEmpty()) {
            Text(lead, style = kitTextStyle(KitType.Row), color = Surface.body, modifier = Modifier.fillMaxWidth())
        }
    }
}

/**
 * WHAT CAME BACK AND WHAT STAYED (`restored`, `stayed`): one white card. Each restored vault is a
 * check, its line, and its safety number large and grouped so it can be read against the backup
 * device's; each vault that stayed with the other phone is the machine's sentence behind an amber
 * mark — "not yet, and not wrong", since the vault is safe where it is
 * (product-intuition/references/design-behaviour.md § Colour).
 */
@Composable
private fun WordsResultCard(restored: List<RestoredVaultLine>, stayed: List<String>) {
    Column(Modifier.fillMaxWidth().kitCard()) {
        for ((index, line) in restored.withIndex()) {
            ResultRow(first = index == 0, mark = { WordsResultMark(StateColor.Green, "Check") }) {
                Column(
                    Modifier.testTag("words-restored-$index").semantics(mergeDescendants = true) { },
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    KitText(line.line, KitType.Row, Surface.ink)
                    if (line.safety_number.isNotEmpty()) {
                        Text(
                            line.safety_number,
                            style = centraidType("display"),
                            color = Surface.ink,
                            modifier = Modifier.testTag("words-safety-number"),
                        )
                        KitText(line.safety_label, KitType.Meta, Surface.meta)
                    }
                }
            }
        }
        for ((index, line) in stayed.withIndex()) {
            ResultRow(first = restored.isEmpty() && index == 0, mark = { WordsResultMark(StateColor.Amber, "AlertCircle") }) {
                Text(
                    line,
                    style = kitTextStyle(KitType.Row),
                    color = Surface.ink,
                    modifier = Modifier.testTag("words-stayed-$index").semantics(mergeDescendants = true) { },
                )
            }
        }
    }
}

@Composable
private fun ResultRow(first: Boolean, mark: @Composable () -> Unit, content: @Composable () -> Unit) {
    if (!first) Box(Modifier.fillMaxWidth().height(KitGeometry.HAIRLINE).background(Surface.line))
    Row(
        Modifier.fillMaxWidth().padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        mark()
        Box(Modifier.weight(1f)) { content() }
    }
}

/** A round state mark on a pale ground: a check for a vault that is back, a bang for one that stayed. */
@Composable
private fun WordsResultMark(state: StateColor, iconKey: String) {
    Box(
        Modifier.size(28.dp).clip(CircleShape).background(state.tint).clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        CentraidIcon(iconKey = iconKey, tint = state.text, size = 14.dp)
    }
}

/**
 * The pairing code, for a restore that cannot find the backup device on its own. Not a word: an
 * ordinary URL field, but it still learns nothing and offers no autofill, since it sits on the
 * same shielded screen. The vault's name (R-1047-E18) is the same box.
 */
@Composable
private fun EndpointField(
    label: String,
    value: String,
    enabled: Boolean,
    /** A vault's name (R-1047-E18): words capitalised, plain text, its own tag. */
    name: Boolean = false,
    /** What the empty field says ("Pairing code"). */
    placeholder: String = "",
    /** The code is monospaced where it is shown whole, as a held restore does. */
    mono: Boolean = false,
    /** A control beside the field: the scan key. */
    trailing: (@Composable () -> Unit)? = null,
    onEdit: (String) -> Unit,
) {
    val text = rememberSentText(value)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        KitText(label, KitType.Meta, Surface.meta, modifier = Modifier.clearAndSetSemantics { })
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = WORDS_FIELD_MIN)
                    .wordsBox()
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
                            capitalization = if (name) KeyboardCapitalization.Words else KeyboardCapitalization.None,
                            autoCorrectEnabled = false,
                            keyboardType = if (name) KeyboardType.Text else KeyboardType.Uri,
                            imeAction = ImeAction.Done,
                        ),
                        textStyle = (if (mono) centraidType("mono") else kitTextStyle(KitType.Row)).copy(color = Surface.ink),
                        cursorBrush = SolidColor(Surface.ink),
                        decorationBox = { field ->
                            if (text.first.value.text.isEmpty() && placeholder.isNotEmpty()) {
                                KitText(placeholder, KitType.Row, Surface.meta)
                            }
                            field()
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag(if (name) "words-make-name" else "words-endpoint")
                            .semantics {
                                contentDescription = label
                                contentDataType = ContentDataType.None
                            },
                    )
                }
            }
            trailing?.invoke()
        }
    }
}

// ---------------------------------------------------------------------------
// shared parts
// ---------------------------------------------------------------------------

/**
 * THE WORDS PAGES' FRAME: a round X at the top leading edge (the screen's own leave control,
 * `secondary_label`, spoken as its label), the content scrolling and riding above the keyboard,
 * and the answers pinned at the foot. With no leave control and no answers it is just the page
 * (pairing's page is drawn this way).
 */
@Composable
internal fun WordsPage(
    testTag: String,
    description: String,
    closeLabel: String = "",
    closeTag: String = "",
    onClose: () -> Unit = {},
    footer: (@Composable ColumnScope.() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Surface.page)
            .imePadding()
            .testTag(testTag)
            .semantics { if (description.isNotEmpty()) contentDescription = description },
    ) {
        if (closeLabel.isNotEmpty()) {
            Box(
                Modifier
                    .padding(start = CentraidGeometry.PAGE_MARGIN.dp, top = 8.dp)
                    .size(KitGeometry.ROW_MIN)
                    .clip(CircleShape)
                    .background(Surface.card)
                    .border(KitGeometry.HAIRLINE, Surface.border, CircleShape)
                    .clickable(onClick = onClose)
                    .testTag(closeTag)
                    .semantics {
                        role = Role.Button
                        contentDescription = closeLabel
                    },
                contentAlignment = Alignment.Center,
            ) {
                CentraidIcon(iconKey = "X", tint = Surface.ink, size = 16.dp)
            }
        }
        Column(
            Modifier
                .weight(1f, fill = footer != null)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            content()
        }
        if (footer != null) {
            Column(
                Modifier.padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                footer()
            }
        }
    }
}

@Composable
internal fun WordsHead(title: String, lead: String) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (title.isNotEmpty()) {
            Text(
                title,
                style = kitTextStyle(KitType.Title),
                color = Surface.ink,
                modifier = Modifier.testTag("words-title").semantics { heading() },
            )
        }
        if (lead.isNotEmpty()) Text(lead, style = kitTextStyle(KitType.Row), color = Surface.body)
    }
}

/**
 * A SENTENCE ABOUT A STATE on a pale ground of that state's colour, with its mark: a red one for
 * what went wrong, an amber one for what the member should do.
 */
@Composable
internal fun WordsCallout(text: String, state: StateColor, testTag: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .wordsBox(fill = state.tint, border = null)
            .padding(12.dp)
            .testTag(testTag)
            .semantics(mergeDescendants = true) { },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        CentraidIcon(iconKey = "AlertCircle", tint = state.text, size = 18.dp, modifier = Modifier.padding(top = 1.dp).clearAndSetSemantics { })
        Text(text, style = kitTextStyle(KitType.Row), color = state.text)
    }
}

@Composable
internal fun WordsNotice(notice: String) {
    if (notice.isEmpty()) return
    WordsCallout(notice, StateColor.Red, testTag = "words-notice")
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
    // NOTHING DRAWN WHEN THERE IS NOTHING TO DRAW: an empty column would still
    // spend its top padding and a gap in whatever holds it.
    if (primary.isEmpty() && secondary.isEmpty()) return
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (primary.isNotEmpty()) {
            InkButton(
                label = primary,
                testTag = "$prefix-primary",
                enabled = primaryEnabled,
                onPress = onPrimary,
            )
        }
        if (secondary.isNotEmpty()) WordsLink(secondary, testTag = "$prefix-secondary", onPress = onSecondary)
    }
}

/** A VERB THAT READS AS WORDS, in the shell's teal, centred. */
@Composable
internal fun WordsLink(label: String, testTag: String, onPress: () -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
            .clickable(onClick = onPress)
            .testTag(testTag)
            .semantics { role = Role.Button },
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold), color = appAccent().text)
    }
}

/**
 * A SECOND VERB IN THE SHELL'S TINT: the shell's teal over its own pale ground, full width,
 * beside the one ink button ("Save a copy", "Scan QR code", "Try again").
 */
@Composable
internal fun WordsTonalButton(
    label: String,
    testTag: String,
    iconKey: String = "",
    enabled: Boolean = true,
    onPress: () -> Unit,
) {
    val accent = appAccent()
    val ink = if (enabled) accent.text else Surface.meta
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .clip(CircleShape)
            .background(accent.wash(centraidDark()))
            .clickable(enabled = enabled, onClick = onPress)
            .testTag(testTag)
            .semantics {
                role = Role.Button
                if (!enabled) disabled()
            },
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (iconKey.isNotEmpty()) CentraidIcon(iconKey = iconKey, tint = ink, size = 16.dp)
        Text(label, style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold), color = ink)
    }
}

/** THE SCAN CONTROL BESIDE THE CODE'S FIELD: a square tonal key with the viewfinder, its words spoken, not drawn. */
@Composable
private fun WordsScanSquare(label: String, enabled: Boolean, onPress: () -> Unit) {
    val accent = appAccent()
    Box(
        Modifier
            .size(WORDS_FIELD_MIN)
            .wordsBox(fill = accent.wash(centraidDark()), border = null)
            .clickable(enabled = enabled, onClick = onPress)
            .testTag("words-scan")
            .semantics {
                role = Role.Button
                contentDescription = label
            },
        contentAlignment = Alignment.Center,
    ) {
        CentraidIcon(iconKey = "Maximize", tint = accent.text, size = 20.dp)
    }
}

/** The height of a words field: a row and a little more, so a typed code is never cramped. */
private val WORDS_FIELD_MIN = 52.dp

/**
 * A BOX OF THE WORDS PAGES: the control radius from the token scale, white by default with a
 * hairline edge; a pale ground (a state, a tint) passes its fill and no edge.
 */
@Composable
private fun Modifier.wordsBox(
    fill: Color = Surface.card,
    border: Color? = Surface.border,
    width: Dp = KitGeometry.HAIRLINE,
): Modifier {
    val shape = RoundedCornerShape((LocalCentraidTokens.current.radii["lg"] ?: 0).dp)
    return clip(shape).background(fill).then(if (border != null) Modifier.border(width, border, shape) else Modifier)
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
    number: Int,
    value: String,
    placeholder: String,
    unknown: Boolean,
    spoken: String,
    testTag: String,
    requester: FocusRequester,
    onEdit: (String) -> Unit,
    onNext: () -> Unit,
    last: Boolean,
    enabled: Boolean = true,
) {
    val text = rememberSentText(value)
    var focused by remember { mutableStateOf(false) }
    val accent = appAccent()
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
            .wordsBox(
                border = when {
                    unknown -> StateColor.Red.text
                    focused -> accent.text
                    else -> Surface.border
                },
                width = if (unknown || focused) 1.5.dp else KitGeometry.HAIRLINE,
            )
            .padding(horizontal = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("$number", style = centraidType("mono"), color = Surface.meta, modifier = Modifier.clearAndSetSemantics { })
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
                    textStyle = kitTextStyle(KitType.Row).copy(color = Surface.ink),
                    cursorBrush = SolidColor(Surface.ink),
                    decorationBox = { field ->
                        if (text.first.value.text.isEmpty() && placeholder.isNotEmpty()) {
                            KitText(placeholder, KitType.Row, Surface.meta, maxLines = 1)
                        }
                        field()
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(requester)
                        .onFocusChanged { focused = it.isFocused }
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
