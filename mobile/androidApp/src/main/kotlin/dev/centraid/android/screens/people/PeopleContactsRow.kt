package dev.centraid.android.screens.people

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.core.v1.PeopleContactsRow
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.rememberLargestText
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitTile
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.theme.centraidType

/**
 * THE PHONE CONTACTS ROW of People's More (#1173): whether People follows the address book
 * (On / Paused / Off / No access), how many and when it last looked, and the one action that fits
 * (Pause, Resume, Turn on, or Settings when the phone said no). Rust decides every word.
 */
@Composable
internal fun PeopleContactsRowView(row: PeopleContactsRow, onAction: () -> Unit) {
    val accent = appAccent()
    // THE ACTION UNDER THE WORDS at the largest text (#1202).
    val stackedAction = rememberLargestText()
    val action: @Composable () -> Unit = {
        Text(
            row.action_label,
            style = centraidType("smallStrong"),
            color = accent.text,
            modifier = Modifier
                .heightIn(min = KitGeometry.ROW_MIN)
                .clickable(onClick = onAction)
                .padding(horizontal = 10.dp, vertical = 12.dp)
                .testTag("people-contacts-action")
                .semantics { role = Role.Button },
        )
    }
    Row(
        Modifier.fillMaxWidth().heightIn(min = KitGeometry.ROW_MIN).padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp)
            .testTag("people-contacts-row"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KitTile("Users", Modifier.padding(end = 12.dp), size = 32.dp)
        Column(Modifier.weight(1f).semantics(mergeDescendants = true) { contentDescription = row.accessibility_label }) {
            // THE STATE WRAPS AS A WORD (#1202): beside the title "Off" stacked O/f/f.
            @OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
            androidx.compose.foundation.layout.FlowRow(verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center) {
                KitText(row.title, KitType.Row, Surface.ink)
                KitText(
                    row.state_label,
                    KitType.Meta,
                    if (row.state == PeopleContactsRow.State.STATE_DENIED) StateColor.Red.text else accent.text,
                    modifier = Modifier.padding(start = 6.dp),
                )
            }
            if (row.detail.isNotEmpty()) KitText(row.detail, KitType.Meta, Surface.meta, maxLines = if (stackedAction) 6 else 2)
            if (stackedAction) action()
        }
        if (!stackedAction) action()
    }
}
