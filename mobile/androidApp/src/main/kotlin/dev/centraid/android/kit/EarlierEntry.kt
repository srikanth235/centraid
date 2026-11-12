package dev.centraid.android.kit

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.core.v1.EarlierEntry
import centraid.core.v1.OriginLine
import centraid.core.v1.Route

/** The selector id of the entry row. */
public const val EARLIER_ENTRY_TAG: String = "earlier-entry"

/**
 * THE ENTRY TO A RECORD'S EARLIER VERSIONS (#1185): one row in a white card at the foot of a
 * detail page, "Earlier versions   2 ›". Every word is Rust's ([EarlierEntry]); a tap hands the
 * entry's own `route` to [onOpen], like any row that opens a page. An absent entry, or one with
 * no label, draws nothing and reserves no space.
 *
 * A detail page embeds it as a LazyColumn item: `EarlierEntryCard(state.earlier, onOpen)`.
 * The iOS twin is `EarlierEntry.swift`.
 */
@Composable
public fun EarlierEntryCard(
    entry: EarlierEntry?,
    onOpen: (Route) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (!earlierEntryDrawn(entry)) return
    val shown = entry!!
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 10.dp)
            .kitCard()
            .heightIn(min = 48.dp)
            .clickable { shown.route?.let(onOpen) }
            .padding(horizontal = 14.dp)
            .testTag(EARLIER_ENTRY_TAG)
            .clearAndSetSemantics {
                contentDescription = shown.accessibility_label.ifEmpty { shown.label }
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KitText(shown.label, KitType.Row, Surface.ink, modifier = Modifier.weight(1f))
        KitText(shown.count_label, KitType.Row, Surface.meta, modifier = Modifier.padding(end = 8.dp))
        CentraidIcon("ChevronRight", Surface.meta, size = 14.dp)
    }
}

/** True when the entry has words to draw; an absent or empty one draws nothing. */
public fun earlierEntryDrawn(entry: EarlierEntry?): Boolean = entry != null && entry.label.isNotEmpty()

/** The selector id of the where-from line. */
public const val ORIGIN_LINE_TAG: String = "origin-line"

/**
 * WHERE IT CAME FROM (#1185): one quiet line under the Earlier versions entry of a detail page,
 * "From contacts.vcf". Every word is Rust's ([OriginLine]); it is not a row and takes no tap. An
 * absent line, or one with no text (a typed item), draws nothing and reserves no space.
 *
 * A detail page embeds it right after the entry: `OriginLineView(state.origin)`.
 * The iOS twin is `OriginLineView` in `EarlierEntry.swift`.
 */
@Composable
public fun OriginLineView(
    line: OriginLine?,
    modifier: Modifier = Modifier,
) {
    if (!originLineDrawn(line)) return
    val shown = line!!
    KitText(
        shown.text,
        KitType.Meta,
        Surface.meta,
        modifier = modifier
            .fillMaxWidth()
            .padding(start = KitGeometry.GUTTER + 14.dp, end = KitGeometry.GUTTER + 14.dp, top = 8.dp)
            .testTag(ORIGIN_LINE_TAG)
            .semantics { contentDescription = shown.accessibility_label.ifEmpty { shown.text } },
    )
}

/** True when the line has words to draw; an absent or empty one draws nothing. */
public fun originLineDrawn(line: OriginLine?): Boolean = line != null && line.text.isNotEmpty()
