package dev.centraid.android.screens.words

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentDataType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDataType
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import centraid.screen.v1.PairLaptopEvent
import centraid.screen.v1.PairLaptopState
import centraid.core.v1.WordsPrimary
import centraid.core.v1.WordsSaveCopy
import centraid.core.v1.WordsSecondary
import centraid.core.v1.WordsShowEvent
import centraid.core.v1.WordsShowState
import dev.centraid.android.kit.ChoiceStack
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitSpinner
import dev.centraid.android.kit.NoAutofill
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.android.kit.RowSkeleton

// THE MORE SHEET'S TWO CUSTODY SCREENS, DRAWN (#1047 E6): `words.show`
// (`WordsShowBridge`) and `pair.laptop` (`PairLaptopBridge`). The Android twins
// of iOS `WordsShowView` and `PairLaptopView`.
//
// **THESE VIEWS DECIDE NOTHING.** Every phase, sentence, label and whether a
// control is enabled arrive in the state. What is theirs is what only a
// platform can do: the owner check behind words.show's ASK primary
// ([ownerCheck]), and the camera behind pair.laptop's `ScanTapped`
// ([PairScanner], shown by `WordsSheets`). The capture duty for the shown
// words is `WordsSheets`' (FLAG_SECURE on both windows while `secure`); a
// shown word is plain `Text` with no `SelectionContainer`, so it cannot be
// copied.

// ---------------------------------------------------------------------------
// words.show — the 24 words again, from the More sheet
// ---------------------------------------------------------------------------

/**
 * The owner check is Rust's (the generic `OwnerCheck` effect, which the screen
 * effects perform); while `check_now` nothing is drawn, and after a failed
 * check ASK is drawn and its primary asks again.
 */
@Composable
internal fun WordsShowScreen(
    state: WordsShowState,
    onEvent: (WordsShowEvent) -> Unit,
) {
    if (state.check_now) return
    SecureWindow(state.secure)
    NoAutofill()
    WordsPage(testTag = "words-show", description = state.accessibility_label) {
        WordsHead(state.title, state.body)
        if (state.words.isNotEmpty()) ShownWords(state.words)
        if (state.save_label.isNotEmpty() && state.words.isNotEmpty()) {
            SaveCopyButton(state.save_label) { onEvent(WordsShowEvent(save_copy = WordsSaveCopy())) }
        }
        WordsNotice(state.notice)
        if (state.phase == WordsShowState.Phase.PHASE_LOADING) {
            Box(Modifier.fillMaxWidth().testTag("words-show-loading"), contentAlignment = Alignment.Center) {
                RowSkeleton(rows = 2, meta = false)
            }
        }
        WordsControls(
            primary = state.primary_label,
            primaryEnabled = state.primary_label.isNotEmpty(),
            secondary = state.secondary_label,
            prefix = "words-show",
            onPrimary = { onEvent(WordsShowEvent(primary = WordsPrimary())) },
            onSecondary = { onEvent(WordsShowEvent(secondary = WordsSecondary())) },
        )
    }
}

// ---------------------------------------------------------------------------
// pair.laptop — pair this phone's vault with the member's laptop
// ---------------------------------------------------------------------------

/**
 * WAITING/FAILED: the scan control, then the paste field; PAIRING: a spinner; PAIRED: the safety number in its 12 groups of
 * 5, to compare with the laptop's terminal (W15-D5); NEEDS_WORDS: the door to
 * the words (`words_label`, the intent `WordsTapped` — `WordsSheets` opens the
 * re-key). The ticket is spent on first use and expires, so pasting is
 * allowed and the screen is not shielded (`screen.proto`). [onScan] is the
 * shell's camera, opened after `ScanTapped` is forwarded; [onPhoto] its photo
 * picker, which Scan opens instead on a phone with no camera.
 */
@Composable
internal fun PairLaptopScreen(
    state: PairLaptopState,
    onEvent: (PairLaptopEvent) -> Unit,
    onScan: () -> Unit,
    onPhoto: () -> Unit,
) {
    WordsPage(testTag = "pair-laptop", description = state.accessibility_label) {
        WordsHead(state.title, state.body)
        // SCAN FIRST, ON EVERY PHONE: the camera, or the photo picker where
        // there is none (`scan_camera`).
        if (state.scan_label.isNotEmpty()) {
            OutlineButton(label = state.scan_label, testTag = "pair-scan") {
                onEvent(PairLaptopEvent(scan = PairLaptopEvent.ScanTapped()))
                if (state.scan_camera) onScan() else onPhoto()
            }
        }
        if (state.payload_label.isNotEmpty()) {
            PayloadField(state.payload_label, state.payload) { text ->
                onEvent(PairLaptopEvent(typed = PairLaptopEvent.PayloadTyped(text = text)))
            }
        }
        if (state.safety_number.isNotEmpty()) {
            // EVERY DIGIT, IN THE LAPTOP'S OWN GROUPS: the comparison is the
            // member's, so it is drawn to be read, and never shortened.
            Text(
                state.safety_number,
                style = centraidType("mono"),
                color = centraidColor("text"),
                modifier = Modifier
                    .fillMaxWidth()
                    .background(centraidColor("bgSunken"), RoundedCornerShape(KitGeometry.RADIUS))
                    .padding(16.dp)
                    .testTag("pair-safety-number"),
            )
        }
        WordsNotice(state.notice)
        if (state.progress.isNotEmpty()) {
            Row(
                Modifier.testTag("pair-progress").semantics(mergeDescendants = true) { },
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                KitSpinner(state.progress)
            }
        }
        // THE WORDS DOOR AND THE PRIMARY ARE ALTERNATIVES: one stack.
        ChoiceStack {
            WordsControls(
                primary = state.primary_label,
                primaryEnabled = state.primary_enabled,
                secondary = state.secondary_label,
                prefix = "pair",
                onPrimary = { onEvent(PairLaptopEvent(primary = PairLaptopEvent.Primary())) },
                onSecondary = { onEvent(PairLaptopEvent(secondary = PairLaptopEvent.Secondary())) },
            )
            if (state.words_label.isNotEmpty()) {
                OutlineButton(label = state.words_label, testTag = "pair-words") {
                    onEvent(PairLaptopEvent(words = PairLaptopEvent.WordsTapped()))
                }
            }
        }
    }
}

/**
 * THE TICKET'S PASTE FIELD: a few monospaced lines, no autocorrect, no
 * capitals, and no autofill — `ContentDataType.None` here, and the sheet's
 * view is excluded from the autofill structure (`WordsSheets`' `NoAutofill`).
 * Paste is allowed: the ticket is one-time.
 */
@Composable
private fun PayloadField(label: String, value: String, onEdit: (String) -> Unit) {
    val text = rememberSentText(value)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = centraidType("small"), color = centraidColor("textSoft"), modifier = Modifier.clearAndSetSemantics { })
        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .border(KitGeometry.HAIRLINE, centraidColor("lineStrong"), RoundedCornerShape(KitGeometry.RADIUS))
                .padding(10.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
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
                minLines = 2,
                maxLines = 5,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Ascii,
                    imeAction = ImeAction.Default,
                ),
                textStyle = centraidType("mono").copy(color = centraidColor("text")),
                cursorBrush = SolidColor(centraidColor("text")),
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("pair-payload")
                    .semantics {
                        contentDescription = label
                        contentDataType = ContentDataType.None
                    },
            )
        }
    }
}
