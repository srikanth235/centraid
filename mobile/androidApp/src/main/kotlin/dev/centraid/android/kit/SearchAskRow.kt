package dev.centraid.android.kit

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.core.v1.SearchAsk
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * THE SHELL'S "ASK THE ASSISTANT" DOOR, or null where there is none (previews). A search reaches
 * Chat through it and never through a view's own routing (#1097, R-1097-30): the activity
 * provides it, selects the Chat tab and sends `ChatEvent.asked{scope, question}`.
 */
public val LocalAskChat: ProvidableCompositionLocal<((SearchAsk) -> Unit)?> = compositionLocalOf { null }

/**
 * THE ASK ROW AT THE FOOT OF AN APP'S SEARCH ANSWER (#1097, R-1097-30, #1135), whether or not
 * anything matched. The label, the question and the chat scope are Rust's ([SearchAsk]); this
 * only draws the label and hands the whole row to the shell. Drawn only where the state holds a
 * row: a term typed since, a denial, or an app that offers none (Locker never does) holds none.
 */
@Composable
public fun SearchAskRow(ask: SearchAsk?, modifier: Modifier = Modifier) {
    val open = LocalAskChat.current
    if (ask == null || open == null) return
    Text(
        ask.label,
        style = centraidType("smallStrong"),
        color = centraidColor("link"),
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .clickable { open(ask) }
            .padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp)
            .testTag("search-ask-about")
            .semantics { role = Role.Button },
    )
}
