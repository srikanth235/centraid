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
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import centraid.core.v1.BackupCheckAction
import centraid.core.v1.BackupCheckEvent
import centraid.core.v1.BackupCheckRow
import centraid.core.v1.BackupCheckState
import centraid.core.v1.BackupCheckTone

/**
 * CHECK MY BACKUP (#1188, B6): a page pushed from Backup's Recovery section. Every word and the
 * bar's fraction are the view's: the intro, one block per device (what was found, then how), the
 * determinate bar while a check runs, and the status line at the foot. A tap is a
 * [BackupCheckEvent]; a pop is the shell's. Same selector ids as the SwiftUI page.
 */
@Composable
public fun BackupCheckScreen(
    state: BackupCheckState,
    onEvent: (BackupCheckEvent) -> Unit,
    onBack: () -> Unit,
) {
    PushedPage(
        title = state.title,
        parentTitle = state.back_label,
        onBack = onBack,
        statusLine = { StatusLine(state.status) },
    ) {
        LazyColumn(Modifier.padding(horizontal = KitGeometry.GUTTER)) {
            item(key = "intro") {
                Column(Modifier.padding(top = 4.dp, bottom = 14.dp)) {
                    KitText(state.intro, KitType.Row, Surface.meta, modifier = Modifier.testTag("backup-check-intro"))
                }
            }
            if (state.heading.isNotEmpty()) {
                item(key = "heading") {
                    KitText(
                        state.heading,
                        KitType.Row,
                        Surface.meta,
                        modifier = Modifier.padding(bottom = 6.dp).testTag("backup-check-heading"),
                    )
                }
            }
            if (state.rows.isNotEmpty()) {
                item(key = "rows") {
                    Column(Modifier.kitCard()) {
                        state.rows.forEach { row -> CheckRow(row) }
                        if (state.running) {
                            KitProgressBar(
                                fraction = state.fraction,
                                modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp).testTag("backup-check-bar"),
                            )
                        }
                    }
                }
            }
            if (state.action != BackupCheckAction.BACKUP_CHECK_ACTION_NONE && state.action_label.isNotEmpty()) {
                item(key = "action") {
                    val stop = state.action == BackupCheckAction.BACKUP_CHECK_ACTION_STOP
                    KitPillButton(
                        label = state.action_label,
                        onPress = {
                            onEvent(
                                if (stop) {
                                    BackupCheckEvent(stop = BackupCheckEvent.Stop())
                                } else {
                                    BackupCheckEvent(start = BackupCheckEvent.Start())
                                },
                            )
                        },
                        modifier = Modifier.padding(top = 14.dp),
                        testTag = if (stop) "backup-check-stop" else "backup-check-start",
                    )
                }
            }
            if (state.back_up_now_label.isNotEmpty()) {
                item(key = "back-up-now") {
                    Text(
                        state.back_up_now_label,
                        style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
                        color = appAccent().text,
                        modifier = Modifier
                            .heightIn(min = KitGeometry.ROW_MIN)
                            .clickable { onEvent(BackupCheckEvent(back_up_now = BackupCheckEvent.BackUpNow())) }
                            .padding(vertical = 12.dp)
                            .testTag("backup-check-back-up-now")
                            .semantics { role = Role.Button },
                    )
                }
            }
        }
    }
}

@Composable
private fun CheckRow(row: BackupCheckRow) {
    val ink = when (row.tone) {
        BackupCheckTone.BACKUP_CHECK_TONE_BAD -> StateColor.Red.text
        BackupCheckTone.BACKUP_CHECK_TONE_OK -> Surface.ink
        else -> Surface.meta
    }
    Column {
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .padding(horizontal = 14.dp, vertical = 10.dp)
                .testTag("backup-check-row-${row.gateway_id}")
                .semantics(mergeDescendants = true) {
                    contentDescription = listOf(row.name, row.line, row.detail).filter { it.isNotEmpty() }.joinToString(". ")
                },
        ) {
            KitText(row.name, KitType.Row, Surface.ink)
            if (row.line.isNotEmpty()) KitText(row.line, KitType.Row, ink)
            if (row.detail.isNotEmpty()) KitText(row.detail, KitType.Row, Surface.meta)
        }
        Spacer(Modifier.fillMaxWidth().height(KitGeometry.HAIRLINE).background(Surface.line))
    }
}
