package dev.centraid.android.screens.words

import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import centraid.screen.v1.PairLaptopEvent
import centraid.screen.v1.PairLaptopState
import centraid.screen.v1.WordsShowEvent
import centraid.screen.v1.WordsShowState
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.QuietButton
import dev.centraid.android.screens.locker.LockerSeam
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

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
 * ASK's primary is an INTENT: [onVerify] runs the owner check and the shell
 * answers `Verified` or `VerifyFailed`. This view never sends `Primary` from
 * ASK.
 */
@Composable
internal fun WordsShowScreen(
    state: WordsShowState,
    onEvent: (WordsShowEvent) -> Unit,
    onVerify: (String) -> Unit,
) {
    WordsPage(testTag = "words-show", description = state.accessibility_label) {
        WordsHead(state.title, state.body)
        if (state.words.isNotEmpty()) ShownWords(state.words)
        WordsNotice(state.notice)
        if (state.phase == WordsShowState.Phase.PHASE_LOADING) {
            Box(Modifier.fillMaxWidth().testTag("words-show-loading"), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = centraidColor("textSoft"), modifier = Modifier.size(28.dp))
            }
        }
        WordsControls(
            primary = state.primary_label,
            primaryEnabled = state.primary_label.isNotEmpty(),
            secondary = state.secondary_label,
            prefix = "words-show",
            onPrimary = {
                if (state.phase == WordsShowState.Phase.PHASE_ASK) {
                    onVerify(state.verify_reason)
                } else {
                    onEvent(WordsShowEvent(primary = WordsShowEvent.Primary()))
                }
            },
            onSecondary = { onEvent(WordsShowEvent(secondary = WordsShowEvent.Secondary())) },
        )
    }
}

/**
 * THE PHONE'S OWNER CHECK (R-1047-E10, Q-1047-12's presence posture): the
 * strong biometric with the device credential as its fallback, through
 * Locker's own authenticator table. [onAnswer] is called exactly once: true on
 * success; false on a terminal error or cancel — and a phone with no lock set
 * answers the prompt with `ERROR_NO_DEVICE_CREDENTIAL`, which is a failed
 * check, never a pass. A single unrecognised touch is not an answer: the
 * prompt stays up and says so itself.
 */
internal fun ownerCheck(activity: FragmentActivity?, reason: String, onAnswer: (Boolean) -> Unit) {
    if (activity == null || reason.isEmpty()) {
        onAnswer(false)
        return
    }
    val callback = object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onAnswer(true)

        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = onAnswer(false)
    }
    val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle(reason)
        // NO NEGATIVE BUTTON: `DEVICE_CREDENTIAL` forbids one.
        .setAllowedAuthenticators(LockerSeam.authenticators())
        .build()
    val raised = runCatching {
        BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback).authenticate(info)
    }
    if (raised.isFailure) onAnswer(false)
}

// ---------------------------------------------------------------------------
// pair.laptop — pair this phone's vault with the member's laptop
// ---------------------------------------------------------------------------

/**
 * WAITING/FAILED: the paste field and, when the phone has a camera, the scan
 * control; PAIRING: a spinner; PAIRED: the safety number in its 12 groups of
 * 5, to compare with the laptop's terminal (W15-D5); NEEDS_WORDS: the door to
 * the words (`words_label`, the intent `WordsTapped` — `WordsSheets` opens the
 * re-key). The ticket is spent on first use and expires, so pasting is
 * allowed and the screen is not shielded (`screen.proto`). [onScan] is the
 * shell's camera, opened after `ScanTapped` is forwarded.
 */
@Composable
internal fun PairLaptopScreen(
    state: PairLaptopState,
    onEvent: (PairLaptopEvent) -> Unit,
    onScan: () -> Unit,
) {
    WordsPage(testTag = "pair-laptop", description = state.accessibility_label) {
        WordsHead(state.title, state.body)
        if (state.payload_label.isNotEmpty()) {
            PayloadField(state.payload_label, state.payload) { text ->
                onEvent(PairLaptopEvent(typed = PairLaptopEvent.PayloadTyped(text = text)))
            }
        }
        if (state.scan_label.isNotEmpty()) {
            QuietButton(label = state.scan_label, testTag = "pair-scan") {
                onEvent(PairLaptopEvent(scan = PairLaptopEvent.ScanTapped()))
                onScan()
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
        if (state.words_label.isNotEmpty()) {
            QuietButton(label = state.words_label, testTag = "pair-words") {
                onEvent(PairLaptopEvent(words = PairLaptopEvent.WordsTapped()))
            }
        }
        if (state.progress.isNotEmpty()) {
            Row(
                Modifier.testTag("pair-progress").semantics(mergeDescendants = true) { },
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(color = centraidColor("textSoft"), modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                Text(state.progress, style = centraidType("small"), color = centraidColor("textSoft"))
            }
        }
        WordsControls(
            primary = state.primary_label,
            primaryEnabled = state.primary_enabled,
            secondary = state.secondary_label,
            prefix = "pair",
            onPrimary = { onEvent(PairLaptopEvent(primary = PairLaptopEvent.Primary())) },
            onSecondary = { onEvent(PairLaptopEvent(secondary = PairLaptopEvent.Secondary())) },
        )
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
