package dev.centraid.android.screens.locker

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.screen.v1.LockerExportEvent
import centraid.screen.v1.LockerExportState
import centraid.screen.v1.LockerImportEvent
import centraid.screen.v1.LockerImportState
import centraid.screen.v1.SectionHead
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.QuietButton
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.StatusChipView
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * `locker.export` (#1047 T2; the handoff's `locker/export`): the lede in the
 * net register, what leaves, the format, where it goes, and Write the file.
 * THE VIEW DECIDES NOTHING AND NEVER SEES THE FILE: the confirm is the
 * machine's, the owner check is the route's (the lock wall's seam), and the
 * file goes from the bridge to the route's save sheet and nowhere else.
 */
@Composable
internal fun LockerExportScreen(state: LockerExportState, onEvent: (LockerExportEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    PushedPage(
        title = chrome?.title.orEmpty(),
        parentTitle = chrome?.back_label.orEmpty(),
        onBack = onBack,
        statusLine = { StatusLine(state.status) {} },
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(LockerExportEvent(refreshed = LockerExportEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) { export ->
            LazyColumn(Modifier.fillMaxSize().testTag("locker-export")) {
                item(key = "lede") {
                    Text(
                        export.lede,
                        style = centraidType("body"),
                        color = centraidColor("net"),
                        modifier = Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp).testTag("locker-export-lede"),
                    )
                }
                item(key = "what") { FieldRow(export.what_label, export.what_value, note = export.leaves_out) }
                item(key = "format") {
                    Column(Modifier.padding(top = 8.dp)) {
                        Text(
                            export.format_label,
                            style = centraidType("eyebrow"),
                            color = centraidColor("textSoft"),
                            modifier = Modifier.padding(horizontal = KitGeometry.GUTTER),
                        )
                        LockerChoices(export.formats, "locker-export-format") { key ->
                            onEvent(LockerExportEvent(format = LockerExportEvent.FormatPicked(key = key)))
                        }
                        LockerNote(export.format_note)
                    }
                }
                item(key = "where") { FieldRow(export.where_label, export.where_value, note = export.where_note) }
                item(key = "commit") {
                    if (export.commit_label.isNotEmpty()) {
                        InkButton(
                            label = export.commit_label,
                            testTag = "locker-export-commit",
                            modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp),
                        ) { onEvent(LockerExportEvent(commit = LockerExportEvent.CommitTapped())) }
                    }
                    LockerNote(export.commit_note)
                }
            }
        }
    }
    state.confirm?.let { confirm ->
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(LockerExportEvent(confirmed = LockerExportEvent.Confirmed())) },
            onDismiss = { onEvent(LockerExportEvent(dismissed = LockerExportEvent.Dismissed())) },
        )
    }
}

/**
 * `locker.import` (#1047 T2; the handoff's `locker/import`): the file, the
 * verdicts, the plan row by row, and Add or Discard. Choose is an intent the
 * route answers with the Storage Access Framework's picker.
 */
@Composable
internal fun LockerImportScreen(state: LockerImportState, onEvent: (LockerImportEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    PushedPage(
        title = chrome?.title.orEmpty(),
        parentTitle = chrome?.back_label.orEmpty(),
        onBack = onBack,
        statusLine = { StatusLine(state.status) {} },
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(LockerImportEvent(refreshed = LockerImportEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) { plan ->
            LazyColumn(Modifier.fillMaxSize().testTag("locker-import")) {
                item(key = "lede") { LockerNote(plan.lede) }
                item(key = "file") {
                    FieldRow(plan.file_label, plan.file_value, note = plan.file_note)
                    if (plan.choose_label.isNotEmpty()) {
                        QuietButton(
                            plan.choose_label,
                            testTag = "locker-import-choose",
                            modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                        ) { onEvent(LockerImportEvent(choose = LockerImportEvent.ChooseTapped())) }
                    }
                }
                if (plan.verdicts.isNotEmpty()) {
                    item(key = "verdicts-head") { SectionHeader(SectionHead(title = plan.verdicts_label)) }
                    items(plan.verdicts, key = { "v-" + it.label }) { verdict -> FieldRow(verdict.label, verdict.detail) }
                }
                plan.empty?.let { empty -> item(key = "empty") { EmptyStateView(empty, onAction = null) } }
                if (plan.rows_label.isNotEmpty()) {
                    item(key = "rows-head") {
                        SectionHeader(SectionHead(title = plan.rows_label))
                        LockerNote(plan.counts)
                    }
                    items(plan.rows, key = { it.key }) { row ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
                                .testTag("locker-import-${row.key}")
                                .clearAndSetSemantics { contentDescription = row.accessibility_label },
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(row.title, style = centraidType("body"), color = centraidColor("text"), maxLines = 1)
                                Text(row.meta, style = centraidType("annotLabel"), color = centraidColor("textSoft"), maxLines = 2)
                            }
                            row.chip?.let { StatusChipView(it) }
                        }
                    }
                }
                item(key = "acts") {
                    if (plan.publish_label.isNotEmpty()) {
                        InkButton(
                            label = plan.publish_label,
                            testTag = "locker-import-publish",
                            modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp),
                        ) { onEvent(LockerImportEvent(publish = LockerImportEvent.PublishTapped())) }
                        LockerNote(plan.publish_note)
                    }
                    if (plan.discard_label.isNotEmpty()) {
                        QuietButton(
                            plan.discard_label,
                            testTag = "locker-import-discard",
                            modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp).semantics { },
                        ) { onEvent(LockerImportEvent(discard = LockerImportEvent.DiscardTapped())) }
                    }
                }
            }
        }
    }
}
