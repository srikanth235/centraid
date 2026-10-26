package dev.centraid.android.kit

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.core.v1.Route
import centraid.core.v1.SearchAsk
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * THE ASK ROW AT THE FOOT OF AN APP'S SEARCH ANSWER (#1097, R-1097-30, #1135), whether or not
 * anything matched. The label, the question and the chat scope are Rust's ([SearchAsk]); a tap
 * opens the `chat.ask` page, the route Rust carries in [SearchAsk.route] (or Home's own [route]),
 * handed to [onOpen] for the shell to push. Drawn only where the state holds a row: a term typed since, a
 * denial, or an app that offers none (Locker never does) holds none.
 */
@Composable
public fun SearchAskRow(
    ask: SearchAsk?,
    onOpen: (Route) -> Unit,
    modifier: Modifier = Modifier,
    route: Route? = null,
) {
    if (ask == null) return
    val target = route ?: ask.route ?: return
    Text(
        ask.label,
        style = centraidType("smallStrong"),
        color = centraidColor("link"),
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .clickable { onOpen(target) }
            .padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp)
            .testTag("search-ask-about")
            .semantics { role = Role.Button },
    )
}
