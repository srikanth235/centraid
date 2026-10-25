package dev.centraid.android.screens.words

import dev.centraid.android.kit.SecureWindow
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
import centraid.core.v1.PairLaptopEvent
import centraid.core.v1.PairLaptopState
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
// ([PairScanner], raised by the `ScanCode` effect). The capture duty for the
// shown words is [SecureWindow]'s (FLAG_SECURE while `secure`); a
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

