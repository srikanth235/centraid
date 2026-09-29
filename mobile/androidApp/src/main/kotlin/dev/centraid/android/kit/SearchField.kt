package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import centraid.screen.v1.SearchField
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * THE SEARCH FIELD (K5; lifted from Agenda's, which lifted it from Photos').
 *
 * Search is not a destination: it opens on the current surface, under the
 * header, and closing it clears the term (the kit `SearchLaw`). The one local
 * value is the text while the IME holds it; it reports each change, and
 * follows the machine only when the machine says something that is not an echo
 * of the typing ([rememberFollowedText]) — a clear, never a late echo.
 */
@Composable
public fun CentraidSearchField(
    field: SearchField,
    placeholder: String,
    onTerm: (String) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    label: String = KitWords.SEARCH,
    closeLabel: String = KitWords.CLOSE_SEARCH,
    testTag: String = "kit-search",
) {
    val editor = rememberFollowedText(field.term)
    val typed = editor.text.value
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
            .heightIn(min = KitGeometry.ROW_MIN)
            .clip(shape)
            .background(centraidColor("bgSunken"))
            .border(KitGeometry.HAIRLINE, centraidColor("line"), shape)
            .padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CentraidIcon(
            iconKey = "Search",
            tint = centraidColor("textFaint"),
            size = 16.dp,
            modifier = Modifier.clearAndSetSemantics { },
        )
        Box(Modifier.weight(1f).padding(horizontal = 8.dp)) {
            if (typed.isEmpty()) {
                Text(
                    placeholder,
                    style = centraidType("body"),
                    color = centraidColor("textFaint"),
                    modifier = Modifier.clearAndSetSemantics { },
                )
            }
            BasicTextField(
                value = typed,
                onValueChange = { next -> if (editor.edited(next)) onTerm(next) },
                singleLine = true,
                textStyle = centraidType("body").copy(color = centraidColor("text")),
                cursorBrush = SolidColor(centraidColor("text")),
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    imeAction = ImeAction.Search,
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focus)
                    .testTag("$testTag-field")
                    .semantics { contentDescription = label },
            )
        }
        IconKey("X", closeLabel, "$testTag-close", bordered = false, onPress = onClose)
    }
}
