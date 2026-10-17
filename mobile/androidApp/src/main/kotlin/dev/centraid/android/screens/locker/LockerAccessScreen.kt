package dev.centraid.android.screens.locker

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import centraid.screen.v1.LockerAccessEvent
import centraid.screen.v1.LockerAccessState
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * `locker.access` (Q-1047-21; the handoff's `locker/access`): the whole
 * Locker's access history — every unlock, reveal, copy, one-time code and
 * export, newest first — pushed from the More sheet's Access history row.
 *
 * THE VIEW DECIDES NOTHING, AND THERE IS NOTHING TO CONCEAL. The page is
 * read-only: one lede, the machine's rows — the item page's own history rows
 * ([LockerFieldView]), each now also naming the item — and a note. A row names
 * the act, the item and the minute and never a value, so no verb is drawn. The
 * route covers it with the lock wall and the activity's `FLAG_SECURE` like
 * every Locker page, because an item's title is inside Locker.
 */
@Composable
internal fun LockerAccessScreen(state: LockerAccessState, onEvent: (LockerAccessEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    PushedPage(
        title = chrome?.title.orEmpty(),
        parentTitle = chrome?.back_label.orEmpty(),
        onBack = onBack,
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(LockerAccessEvent(refreshed = LockerAccessEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) { access ->
            LazyColumn(Modifier.fillMaxSize().testTag("locker-access")) {
                item(key = "lede") {
                    Text(
                        access.lede,
                        style = centraidType("body"),
                        color = centraidColor("textSoft"),
                        modifier = Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp).testTag("locker-access-lede"),
                    )
                }
                val history = access.history
                if (history != null) {
                    // THE ITEM PAGE'S ROW, with no verb to offer: a history is read.
                    items(history.rows, key = { "access-" + it.key }) { row -> LockerFieldView(row) { } }
                    if (history.note.isNotEmpty()) item(key = "note") { LockerNote(history.note) }
                }
            }
        }
    }
}
