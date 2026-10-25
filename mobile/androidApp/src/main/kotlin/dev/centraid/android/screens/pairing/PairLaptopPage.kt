package dev.centraid.android.screens.pairing

import androidx.compose.foundation.border
import androidx.compose.foundation.background
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
import androidx.compose.runtime.LaunchedEffect
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
import centraid.core.v1.PairLaptopEvent
import centraid.core.v1.PairLaptopState
import dev.centraid.android.kit.ChoiceStack
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitSpinner
import dev.centraid.android.kit.NoAutofill
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.screens.words.WordsControls
import dev.centraid.android.screens.words.WordsHead
import dev.centraid.android.screens.words.WordsNotice
import dev.centraid.android.screens.words.WordsPage
import dev.centraid.android.screens.words.rememberSentText
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

// PAIR WITH A GATEWAY, DRAWN (#1135) — `pair.laptop` as a Rust screen.
//
// **THIS VIEW DECIDES NOTHING.** Every phase, sentence, label and whether a
// control is enabled arrive in the state. What is the view's is what only a
// platform can do: the paste field's keystrokes. Scan is an intent Rust turns
// into the `ScanCode` effect (`CodeScanDoor`); what it reads goes back to Rust,
// which pairs at once. The code is spent on first use and expires, so pasting
// is allowed and the screen is not shielded.

/**
 * WAITING/FAILED: the scan control, then the paste field; PAIRING: a spinner;
 * PAIRED: the safety number in its 12 groups of 5, to compare with the
 * gateway's terminal; NEEDS_WORDS: the door to the words (`words_label`, the
 * intent `WordsTapped`). [onDone] pops the page once Rust says it is `finished`.
 */
@Composable
internal fun PairLaptopPage(
    state: PairLaptopState,
    onEvent: (PairLaptopEvent) -> Unit,
    onDone: () -> Unit,
) {
    LaunchedEffect(state.finished) { if (state.finished) onDone() }
    NoAutofill()
    WordsPage(testTag = "pair-laptop", description = state.accessibility_label) {
        WordsHead(state.title, state.body)
        if (state.scan_label.isNotEmpty()) {
            OutlineButton(label = state.scan_label, testTag = "pair-scan") {
                onEvent(PairLaptopEvent(scan = PairLaptopEvent.ScanTapped()))
            }
        }
        if (state.payload_label.isNotEmpty()) {
            PayloadField(state.payload_label, state.payload) { text ->
                onEvent(PairLaptopEvent(typed = PairLaptopEvent.PayloadTyped(text = text)))
            }
        }
        if (state.safety_number.isNotEmpty()) {
            // EVERY DIGIT, IN THE GATEWAY'S OWN GROUPS: the comparison is the
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
                Modifier.testTag("pair-progress"),
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
 * THE CODE'S PASTE FIELD: a few monospaced lines, no autocorrect, no capitals,
 * and no autofill. Paste is allowed: the code is one-time.
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
