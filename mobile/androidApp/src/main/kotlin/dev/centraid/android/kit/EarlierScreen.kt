package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import centraid.core.v1.EarlierEvent
import centraid.core.v1.EarlierRow
import centraid.core.v1.EarlierSecret
import centraid.core.v1.EarlierView
import dev.centraid.android.theme.centraidType

/**
 * EVERY RECORD'S EARLIER VERSIONS, DRAWN ONCE, FROM THE SCREEN RUNTIME (#1185): `<app>.earlier`,
 * drawn from `ViewState.earlier`. The current values wear their tag; every other row says when,
 * the one-line value and a plain "Restore". Every word is the view's; a pop is the shell's
 * ([onBack]) and a tap is an [EarlierEvent].
 *
 * Ids: `earlier-row-<seq>`, `earlier-restore-<seq>`, `earlier-more`, `earlier-status-action`
 * (the iOS twin is `CoreEarlierView.swift`).
 */
@Composable
public fun EarlierScreen(
    view: EarlierView,
    onEvent: (EarlierEvent) -> Unit,
    onBack: () -> Unit,
) {
    PushedPage(
        title = view.title,
        parentTitle = view.back_label,
        onBack = onBack,
        statusLine = {
            StatusLine(view.status, actTag = "earlier-status-action") {
                onEvent(EarlierEvent(status_acted = EarlierEvent.StatusActed()))
            }
        },
    ) {
        ReadStateView(
            content = screenContentOf(view.loading, view.failure, view.data_, view.denied),
            onRetry = { onEvent(EarlierEvent(refreshed = EarlierEvent.Refreshed())) },
        ) { earlier ->
            val empty = earlier.empty
            if (earlier.rows.isEmpty() && empty != null) {
                EmptyStateView(empty, onAction = null)
            } else {
                LazyColumn(Modifier.padding(horizontal = KitGeometry.GUTTER)) {
                    item(key = "rows") {
                        Column(Modifier.padding(top = 4.dp).kitCard()) {
                            earlier.rows.forEach { row -> EarlierRowView(row, onEvent) }
                        }
                    }
                    if (earlier.more_label.isNotEmpty()) {
                        item(key = "more") {
                            Text(
                                earlier.more_label,
                                style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
                                color = Surface.ink,
                                modifier = Modifier
                                    .heightIn(min = KitGeometry.ROW_MIN)
                                    .clickable { onEvent(EarlierEvent(more = EarlierEvent.MoreTapped())) }
                                    .padding(vertical = 12.dp)
                                    .testTag("earlier-more")
                                    .semantics { role = Role.Button },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EarlierRowView(row: EarlierRow, onEvent: (EarlierEvent) -> Unit) {
    val accent = appAccent()
    Column {
        Row(
            Modifier.fillMaxWidth().padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(
                Modifier
                    .weight(1f)
                    .testTag(earlierRowTag(row.seq))
                    .semantics(mergeDescendants = true) {
                        if (row.accessibility_label.isNotEmpty()) contentDescription = row.accessibility_label
                    },
            ) {
                Text(
                    row.label,
                    style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
                    color = Surface.ink,
                    maxLines = 2,
                )
                if (row.value_.isNotEmpty()) KitText(row.value_, KitType.Meta, Surface.meta, maxLines = 1)
            }
            if (earlierShowsCurrentTag(row)) {
                KitText(row.current_label, KitType.Meta, Surface.meta, modifier = Modifier.padding(horizontal = 6.dp))
            } else if (earlierShowsRestore(row)) {
                Text(
                    row.restore_label,
                    style = centraidType("smallStrong"),
                    color = accent.text,
                    modifier = Modifier
                        .heightIn(min = KitGeometry.ROW_MIN)
                        .clickable { onEvent(EarlierEvent(restore = EarlierEvent.RestoreTapped(seq = row.seq))) }
                        .padding(horizontal = 10.dp, vertical = 12.dp)
                        .testTag(earlierRestoreTag(row.seq))
                        .semantics {
                            role = Role.Button
                            if (row.accessibility_label.isNotEmpty()) contentDescription = row.accessibility_label
                        },
                )
            }
        }
        row.secrets.forEach { secret -> EarlierSecretLine(row.seq, secret, onEvent) }
        Spacer(Modifier.fillMaxWidth().height(KitGeometry.HAIRLINE).background(Surface.line))
    }
}

/** One sealed value: `label · masked`, or the value while Rust says `revealed`; never kept here. */
@Composable
private fun EarlierSecretLine(seq: Long, secret: EarlierSecret, onEvent: (EarlierEvent) -> Unit) {
    val accent = appAccent()
    val title = if (secret.revealed) secret.conceal_label else secret.reveal_label
    Row(
        Modifier.fillMaxWidth().padding(start = 14.dp, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KitText(
            "${secret.label} · ${if (secret.revealed) secret.value_ else secret.masked}",
            KitType.Meta,
            Surface.meta,
            maxLines = 1,
            modifier = Modifier
                .weight(1f)
                .semantics {
                    if (secret.accessibility_label.isNotEmpty()) contentDescription = secret.accessibility_label
                },
        )
        if (secret.reveal_label.isNotEmpty() && title.isNotEmpty()) {
            Text(
                title,
                style = centraidType("smallStrong"),
                color = accent.text,
                modifier = Modifier
                    .heightIn(min = KitGeometry.ROW_MIN)
                    .clickable {
                        onEvent(
                            if (secret.revealed) {
                                EarlierEvent(conceal = EarlierEvent.SecretTapped(seq = seq, key = secret.key))
                            } else {
                                EarlierEvent(reveal = EarlierEvent.SecretTapped(seq = seq, key = secret.key))
                            },
                        )
                    }
                    .padding(horizontal = 10.dp, vertical = 12.dp)
                    .testTag("earlier-secret-$seq-${secret.key}")
                    .semantics {
                        role = Role.Button
                        if (secret.accessibility_label.isNotEmpty()) contentDescription = secret.accessibility_label
                    },
            )
        }
    }
}

public fun earlierRowTag(seq: Long): String = "earlier-row-$seq"

public fun earlierRestoreTag(seq: Long): String = "earlier-restore-$seq"

/** The current row wears its tag and never a Restore. */
public fun earlierShowsCurrentTag(row: EarlierRow): Boolean = row.current && row.current_label.isNotEmpty()

/** Every other row restores, when Rust gave the action words. */
public fun earlierShowsRestore(row: EarlierRow): Boolean = !row.current && row.restore_label.isNotEmpty()
