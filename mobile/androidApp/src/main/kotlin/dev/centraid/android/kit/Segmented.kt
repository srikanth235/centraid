package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/** One segment of a [KitSegmented]: the machine's id and word, and whether it is the choice. */
public data class KitSegment(val id: String, val label: String, val selected: Boolean)

/**
 * A SEGMENTED CHOICE (#1173): a few short words on a fill, the chosen one raised on a card. At the
 * largest text the segments stack, so no word is cut. Each segment is `<testTag>-<id>`.
 */
@Composable
public fun KitSegmented(
    segments: List<KitSegment>,
    modifier: Modifier = Modifier,
    testTag: String = "kit-segmented",
    onPick: (String) -> Unit,
) {
    val stacked = rememberLargestText()
    Box(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(SEGMENT_TRACK_RADIUS))
            .background(Surface.fill)
            .padding(3.dp)
            .testTag(testTag),
    ) {
        if (stacked) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                segments.forEach { Segment(it, Modifier.fillMaxWidth(), testTag, onPick) }
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                segments.forEach { Segment(it, Modifier.weight(1f), testTag, onPick) }
            }
        }
    }
}

private val SEGMENT_TRACK_RADIUS = 12.dp
private val SEGMENT_RADIUS = 10.dp

@Composable
private fun Segment(segment: KitSegment, modifier: Modifier, testTag: String, onPick: (String) -> Unit) {
    Box(
        modifier
            .heightIn(min = KitGeometry.ROW_MIN)
            .clip(RoundedCornerShape(SEGMENT_RADIUS))
            .then(if (segment.selected) Modifier.background(Surface.card) else Modifier)
            .clickable { onPick(segment.id) }
            .testTag("$testTag-${segment.id}")
            .clearAndSetSemantics {
                contentDescription = segment.label
                role = Role.RadioButton
                selected = segment.selected
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            segment.label,
            style = kitTextStyle(KitType.Row).copy(
                fontWeight = if (segment.selected) FontWeight.SemiBold else FontWeight.Normal,
            ),
            color = if (segment.selected) Surface.ink else Surface.meta,
            textAlign = TextAlign.Center,
            maxLines = 1,
            modifier = Modifier.padding(horizontal = 8.dp),
        )
    }
}
