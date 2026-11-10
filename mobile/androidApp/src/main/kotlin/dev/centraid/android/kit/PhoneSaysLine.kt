package dev.centraid.android.kit

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import centraid.core.v1.PhoneSays
import centraid.core.v1.PhoneSaysTake
import centraid.core.v1.PhoneSaysTaken

/**
 * WHAT THE PHONE SAYS (#1183): the one quiet line a followed row's detail page draws where the
 * member's value differs from the phone's: Rust's `lead` in the secondary text style and a plain
 * words-only action in the app's accent, a 44dp target, with no border, fill, icon or badge. The
 * same composable draws it on the person, event, document and workout pages; every word is Rust's
 * and a tap hands the line's own take back unchanged, as the page's `PhoneSaysTaken` ([onTake]). A line that is absent
 * or has no words draws nothing and reserves no space.
 *
 * Ids: `phone-says-<field>[-<item>]` on the line and `phone-says-take-<field>[-<item>]` on the
 * action (the iOS twin is `PhoneSaysLine.swift`).
 */
@Composable
public fun PhoneSaysLine(
    line: PhoneSays?,
    onTake: (PhoneSaysTaken) -> Unit,
    modifier: Modifier = Modifier,
    centered: Boolean = false,
) {
    if (!phoneSaysDrawn(line)) return
    val ids = phoneSaysIds(line!!.take)
    val accent = appAccent()
    Row(
        modifier.fillMaxWidth().testTag(ids.line),
        horizontalArrangement = if (centered) {
            Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally)
        } else {
            Arrangement.spacedBy(12.dp)
        },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KitText(
            line.lead,
            KitType.Meta,
            Surface.meta,
            modifier = if (centered) Modifier.weight(1f, fill = false) else Modifier.weight(1f),
        )
        Text(
            line.action_label,
            style = kitTextStyle(KitType.Meta).copy(fontWeight = FontWeight.SemiBold),
            color = accent.text,
            modifier = Modifier
                .heightIn(min = KitGeometry.ROW_MIN)
                .widthIn(min = KitGeometry.ROW_MIN)
                .clickable(role = Role.Button) { onTake(PhoneSaysTaken(take = line.take)) }
                .padding(vertical = 12.dp)
                .semantics { contentDescription = line.accessibility_label.ifEmpty { line.action_label } }
                .testTag(ids.take),
        )
    }
}

/** True when the line has words to draw; an absent or empty one draws nothing. */
public fun phoneSaysDrawn(line: PhoneSays?): Boolean =
    line != null && line.lead.isNotEmpty() && line.action_label.isNotEmpty()

/** The two selector ids of a line, from the field and item its take names. */
public data class PhoneSaysIds(val line: String, val take: String)

public fun phoneSaysIds(take: PhoneSaysTake?): PhoneSaysIds {
    val key = listOfNotNull(take?.field?.takeIf { it.isNotEmpty() }, take?.item_key?.takeIf { it.isNotEmpty() })
        .joinToString("-")
    val suffix = if (key.isEmpty()) "" else "-$key"
    return PhoneSaysIds(line = "phone-says$suffix", take = "phone-says-take$suffix")
}
