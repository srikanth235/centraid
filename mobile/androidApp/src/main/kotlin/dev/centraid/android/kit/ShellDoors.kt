package dev.centraid.android.kit

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import centraid.screen.v1.ImportSource
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.copy.AgendaCopy
import dev.centraid.design.copy.PeopleCopy

/**
 * IMPORT WHERE THE PHONE ALREADY HOLDS THE DATA (`EmptyState.import_source`,
 * `AgendaHomeData.import_source`). ONE DOOR, KEYED BY SOURCE: the shell's
 * importers — permission asked at the tap, the phone's store read, the shared
 * importer run on the member's vault — behind one handler. Null when no vault
 * is open, and then the empty state draws its own action.
 *
 * The door is only ever called with a source [importLabel] names: a screen
 * reads the label first, and an empty label is "this shell cannot read that".
 */
public val LocalPhoneImport: ProvidableCompositionLocal<((ImportSource) -> Unit)?> = staticCompositionLocalOf { null }

/**
 * THE IMPORT'S VERB FOR [source], or "" WHERE ANDROID HAS NOTHING TO READ:
 * Contacts and Calendar are the phone's own stores; Android has no system
 * reminders, so a Reminders source draws the app's own action instead.
 */
public fun importLabel(source: ImportSource): String = when (source) {
    ImportSource.IMPORT_SOURCE_CONTACTS -> PeopleCopy.IMPORT_CONTACTS
    ImportSource.IMPORT_SOURCE_CALENDAR -> AgendaCopy.IMPORT_CALENDAR
    else -> ""
}

/**
 * THE SHELL'S BANNER, one sentence and at most one verb: what a shell-level
 * act did (an import's progress and outcome). It stays until its verb is tapped — DESIGN.md
 * has no toast — and an empty [action] (an import still running) has no verb.
 */
@Composable
public fun ShellBanner(
    sentence: String,
    action: String,
    tag: String,
    onAct: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp)
            .clip(RoundedCornerShape(KitGeometry.RADIUS))
            .border(KitGeometry.HAIRLINE, centraidColor("line"), RoundedCornerShape(KitGeometry.RADIUS))
            .padding(start = 12.dp, end = 4.dp)
            .testTag("$tag-banner"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            sentence,
            style = centraidType("small"),
            color = centraidColor("text"),
            modifier = Modifier.weight(1f).padding(vertical = 8.dp),
        )
        if (action.isNotEmpty()) {
            Text(
                action,
                style = centraidType("control"),
                color = centraidColor("link"),
                modifier = Modifier
                    .heightIn(min = KitGeometry.ROW_MIN)
                    .clip(RoundedCornerShape(KitGeometry.RADIUS))
                    .clickable(role = Role.Button, onClick = onAct)
                    .padding(horizontal = 8.dp, vertical = 12.dp)
                    .testTag("$tag-done"),
            )
        }
    }
}
