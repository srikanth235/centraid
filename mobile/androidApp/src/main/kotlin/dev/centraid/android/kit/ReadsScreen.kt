package dev.centraid.android.kit

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.core.v1.ReadsView
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * THE KIT'S "WHAT <APP> MAY READ" (owner, 2026-11-19), drawn once from `ViewState.reads`: Notes,
 * Docs, Money and People open it from their More sheet by the Shield row, as Calendar, Reminders
 * and Health open theirs. Every word is the view's; the page sends nothing and a pop is the shell's
 * ([onBack]).
 */
@Composable
public fun ReadsScreen(view: ReadsView, onBack: () -> Unit) {
    PushedPage(title = view.title, parentTitle = view.back_label, onBack = onBack, app = view.app_id) {
        LazyColumn(Modifier.fillMaxWidth().testTag("${view.app_id}-reads")) {
            items(view.facts, key = { it.label }) { fact ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
                        .semantics(mergeDescendants = true) { },
                ) {
                    Text(fact.label, style = centraidType("smallStrong"), color = centraidColor("text"))
                    Text(fact.detail, style = centraidType("small"), color = centraidColor("textSoft"))
                }
            }
        }
    }
}
