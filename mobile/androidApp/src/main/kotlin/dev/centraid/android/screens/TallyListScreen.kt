package dev.centraid.android.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import centraid.screen.v1.Money
import centraid.screen.v1.TallyListEvent
import centraid.screen.v1.TallyListState
import dev.centraid.android.theme.formatMoney

/**
 * The Tally list (#1020, D-1020-E3).
 *
 * **THREE BRANCHES, NEVER TWO.** `loading`, `failure`, `data` — and the
 * `failure` branch renders a sentence, not an empty list. A Compose `when` over
 * a nullable would have been the two-branch shape the read law exists to
 * forbid.
 *
 * The view owns nothing: every tap is a `TallyListEvent` forwarded to the
 * machine, and every pixel comes from a finished state.
 */
@Composable
public fun TallyListScreen(
    state: TallyListState,
    onEvent: (TallyListEvent) -> Unit,
    onBandChange: (TallyListState.Destination) -> Unit,
) {
    Column(modifier = Modifier.padding(16.dp)) {
        Row {
            // A BAND IS A PARAMETER: three buttons, one screen.
            TallyListState.Destination.entries
                .filter { it != TallyListState.Destination.DESTINATION_UNSPECIFIED }
                .forEach { band ->
                    TextButton(onClick = { onBandChange(band) }) {
                        Text(text = bandLabel(band))
                    }
                }
            IconButton(
                onClick = { onEvent(TallyListEvent(refreshed = TallyListEvent.Refreshed())) },
            ) {
                Icon(
                    imageVector = refreshIcon(),
                    // AN ICON-ONLY CONTROL CARRIES A DESCRIPTION.
                    // `NativeAccessibilityLintSpec` in `:shared`'s jvmTest
                    // fails the build when one does not.
                    contentDescription = "Refresh",
                )
            }
        }

        if (state.recurring_materialisation_withheld) {
            // WITHHELD, NOT QUEUED. The sentence is the screen's answer.
            Text(text = "Centraid adds recurring expenses when it can reach your gateway.")
        }

        when {
            state.loading != null ->
                if (state.loading.first_load) {
                    CircularProgressIndicator()
                } else {
                    Text(text = "Refreshing")
                }

            state.failure != null -> Column {
                Text(text = state.failure.sentence)
                if (state.failure.remedy.isNotEmpty()) Text(text = state.failure.remedy)
            }

            state.data_ != null -> {
                val rows = state.data_.rows
                if (rows.isEmpty()) {
                    // AN EMPTY LEDGER IS ITS OWN SENTENCE, and a different one
                    // from any failure above.
                    Text(text = "Nothing here yet.")
                } else {
                    LazyColumn {
                        items(rows) { row ->
                            Row {
                                Text(text = row.description)
                                Text(text = formatMoney(row.amount ?: Money()))
                                if (row.expense_id in state.pending_expense_ids) {
                                    Text(text = "Saving")
                                }
                            }
                        }
                    }
                    state.data_.next_cursor?.let { cursor ->
                        TextButton(
                            onClick = {
                                onEvent(
                                    TallyListEvent(
                                        next_page = TallyListEvent.NextPageRequested(cursor),
                                    ),
                                )
                            },
                        ) { Text(text = "Show more") }
                    }
                }
            }
        }
    }
}

private fun bandLabel(band: TallyListState.Destination): String = when (band) {
    TallyListState.Destination.DESTINATION_ACTIVITY -> "Activity"
    TallyListState.Destination.DESTINATION_BALANCES -> "Balances"
    TallyListState.Destination.DESTINATION_GROUPS -> "Groups"
    TallyListState.Destination.DESTINATION_UNSPECIFIED -> ""
}

/**
 * The refresh glyph, from the CORE icon set only.
 *
 * `material-icons-extended` is a multi-megabyte dependency and
 * `contracts/ledgers/library-size.json` is down-only, so every icon this app
 * uses comes from the core set that ships with Material 3. When wave 4 lands
 * the design system's own icon set this function is the one place that changes.
 */
private fun refreshIcon(): ImageVector = Icons.Filled.Refresh
