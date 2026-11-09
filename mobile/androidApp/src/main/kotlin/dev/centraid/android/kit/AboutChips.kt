package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import centraid.core.v1.NotesAboutChip
import centraid.core.v1.Route
import androidx.compose.foundation.layout.Arrangement

/**
 * WHAT A NOTE IS ABOUT, as chips (#1173): "About · Maya", each a quiet pill that opens the subject
 * in its own app. Rust makes the words and the route. On a card the chips are read-only (the
 * card's own tap opens the note); over a note ([onOpen] set) they are buttons.
 */
@Composable
public fun AboutChips(chips: List<NotesAboutChip>, modifier: Modifier = Modifier, onOpen: ((Route) -> Unit)? = null) {
    if (chips.isEmpty()) return
    val accent = appAccent()
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        chips.forEach { chip ->
            val face = Modifier
                .clip(RoundedCornerShape(percent = 50))
                .background(accent.fill.copy(alpha = 0.12f))
            val tappable = if (onOpen != null) {
                face.clickable { chip.route?.let(onOpen) }.testTag("about-chip-${chip.id}")
                    .semantics { role = Role.Button; contentDescription = chip.accessibility_label }
            } else {
                face
            }
            Text(
                chip.label,
                style = kitTextStyle(KitType.Meta).copy(fontWeight = FontWeight.SemiBold),
                color = accent.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = tappable.padding(horizontal = 8.dp, vertical = 3.dp),
            )
        }
    }
}
