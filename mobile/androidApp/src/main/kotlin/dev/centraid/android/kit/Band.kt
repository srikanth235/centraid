package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry
import dev.centraid.shared.shell.BandPolicy

/**
 * THE BAND — invariant 1 (#1020, wave A; v0 `screens/home/HomeBand.tsx`).
 *
 * One band, never app-themed, never scrolled away, frame destinations only.
 * [BandPolicy] decides which destinations and in what order; this file draws
 * them and names the one that was pressed. Where a press GOES is the
 * navigator's, which is why nothing here routes.
 *
 * **NO ACTIVE BAR, NO TINTED CHIP, NO BADGE.** Selection is carried by the
 * label's weight and ink alone: `band` (400) in `textSoft` when it is not the
 * current place, `control` (600) in full ink when it is. A pill, a dot or a
 * count would each be a second thing to read in a strip that exists to be read
 * at a glance.
 */
@Composable
public fun HomeBand(
    active: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .fillMaxWidth()
            // THE BAND FLOATS (§G), never a flush bar. Its ground is the page's
            // elevated surface — not `bg`, because a page colour does not
            // float, and not `bgChrome`, which sinks on dark — and its edge is
            // `lineStrong`, never the lighter `line`.
            .padding(
                start = BandPolicy.BAND_INSET.dp,
                end = BandPolicy.BAND_INSET.dp,
                top = BandPolicy.BAND_TOP_GAP.dp,
                bottom = BandPolicy.BAND_INSET.dp,
            )
            .clip(RoundedCornerShape(BandPolicy.BAND_RADIUS.dp))
            .background(centraidColor("bgElev"))
            .border(
                CentraidGeometry.HAIRLINE.dp,
                centraidColor("lineStrong"),
                RoundedCornerShape(BandPolicy.BAND_RADIUS.dp),
            )
            .padding(horizontal = 4.dp)
            .testTag("home-band"),
    ) {
        BandPolicy.bandTabs().forEach { place ->
            BandTab(
                iconKey = place.iconKey,
                label = place.short,
                // SPEAK WHAT IS PAINTED. v0's band once spoke one noun for
                // "Needs you" and painted another, so two members got two names
                // for one place.
                spoken = place.short + if (place.id == active) ", current place" else "",
                selected = place.id == active,
                testTag = "home-band-${place.id}",
                onPress = { onSelect(place.id) },
                modifier = Modifier.weight(1f),
            )
        }
        // More is NOT a place — a "···" in a bordered square, outside the loop,
        // because it opens a sheet and a destination mark would promise a
        // destination.
        BandTab(
            iconKey = null,
            label = "More",
            spoken = "All apps and places",
            selected = false,
            testTag = "home-band-more",
            onPress = { onSelect("more") },
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun BandTab(
    iconKey: String?,
    label: String,
    spoken: String,
    selected: Boolean,
    testTag: String,
    onPress: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .heightIn(min = BandPolicy.BAND_TAB_MIN_HEIGHT.dp)
            .clickable(onClick = onPress)
            // The gutter is on the TAB and not the label, so the 44pt target is
            // unchanged by it.
            .padding(top = 7.dp, bottom = 3.dp, start = 4.dp, end = 4.dp)
            .testTag(testTag)
            .semantics { contentDescription = spoken },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier.size(BandPolicy.BAND_MARK_SIZE.dp),
            contentAlignment = Alignment.Center,
        ) {
            if (iconKey != null) {
                CentraidIcon(
                    iconKey = iconKey,
                    // Inactive is `textFaint` — never the label's token, never
                    // an app's hue. The band carries no identity at all.
                    tint = if (selected) centraidColor("text") else centraidColor("textFaint"),
                    size = BandPolicy.BAND_ICON_SIZE.dp,
                )
            } else {
                Box(
                    Modifier
                        .size(26.dp)
                        .clip(RoundedCornerShape(7.dp))
                        .border(
                            CentraidGeometry.HAIRLINE.dp,
                            centraidColor("lineStrong"),
                            RoundedCornerShape(7.dp),
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("···", style = centraidType("mono"), color = centraidColor("textSoft"))
                }
            }
        }
        Text(
            label,
            // The same 11/15 rung either way, so a tap cannot reflow the strip.
            style = centraidType(if (selected) "control" else "band"),
            color = if (selected) centraidColor("text") else centraidColor("textSoft"),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(top = 3.dp),
        )
    }
}
