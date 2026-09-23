package dev.centraid.android.kit

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.unit.Dp
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
            )
            .bandFloor()
            .clip(RoundedCornerShape(BandPolicy.BAND_RADIUS.dp))
            .background(centraidColor("bgElev"))
            .border(
                CentraidGeometry.HAIRLINE.dp,
                centraidColor("lineStrong"),
                RoundedCornerShape(BandPolicy.BAND_RADIUS.dp),
            )
            .padding(BandPolicy.BAND_PLATE_PAD.dp)
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
        // More is NOT a place — three dots in a bordered square, outside the
        // loop, because it opens a sheet and a destination mark would promise a
        // destination. The SQUARE carries that argument, not the mark inside
        // it, which is why `bordered` is its own flag and not an absent icon:
        // More draws the catalog's `more` silhouette through the very same
        // `CentraidIcon` the places use, at the same size, stroke and ink.
        //
        // It was a literal "···" until Instrument Sans was bundled: the face
        // sets MIDDLE DOT with sidebearings tight enough that three of them
        // fuse into one dash at the band's 11pt rung. A glyph whose shape
        // depends on which face happens to be loaded is not a mark; the catalog
        // path is.
        BandTab(
            iconKey = "more",
            bordered = true,
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
    iconKey: String,
    label: String,
    spoken: String,
    selected: Boolean,
    testTag: String,
    onPress: () -> Unit,
    modifier: Modifier = Modifier,
    // The bordered square is More's alone — it says "this opens a sheet", so
    // giving one to a place would promise a sheet the place does not open.
    bordered: Boolean = false,
) {
    Column(
        modifier
            .heightIn(min = BandPolicy.BAND_TAB_MIN_HEIGHT.dp)
            .bandPress(onPress)
            // The gutter is on the TAB and not the label, so the 44pt target is
            // unchanged by it.
            .padding(
                top = BandPolicy.BAND_TAB_TOP.dp,
                bottom = BandPolicy.BAND_TAB_BOTTOM.dp,
                start = 4.dp,
                end = 4.dp,
            )
            .testTag(testTag)
            .semantics { contentDescription = spoken },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier.size(BandPolicy.BAND_MARK_SIZE.dp),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                if (bordered) {
                    Modifier
                        .size(BandPolicy.BAND_MARK_SIZE.dp)
                        .clip(RoundedCornerShape(7.dp))
                        .border(
                            CentraidGeometry.HAIRLINE.dp,
                            centraidColor("lineStrong"),
                            RoundedCornerShape(7.dp),
                        )
                } else {
                    Modifier
                },
                contentAlignment = Alignment.Center,
            ) {
                CentraidIcon(
                    iconKey = iconKey,
                    // Inactive is `textFaint` — never the label's token, never
                    // an app's hue. The band carries no identity at all.
                    tint = if (selected) centraidColor("text") else centraidColor("textFaint"),
                    size = BandPolicy.BAND_ICON_SIZE.dp,
                )
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
            modifier = Modifier.fillMaxWidth().padding(top = BandPolicy.BAND_LABEL_GAP.dp),
        )
    }
}

/**
 * THE BAND'S FLOOR: the plate `BAND_FLOOR` from the screen's bottom edge, as the
 * system bar sits — not stacked on top of the navigation bar's inset.
 *
 * The screen is laid out inside `safeDrawingPadding`, whose bottom on a phone
 * with gesture navigation is the handle's zone. Where that zone is taller than
 * the floor the plate is moved DOWN into it by the difference (an offset, so
 * nothing re-lays out); where it is shorter — three-button navigation keeps
 * its buttons clear by a taller inset, and none at all is zero — the plate is
 * padded up to the floor.
 */
@Composable
internal fun Modifier.bandFloor(): Modifier {
    val navigation = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val floor = BandPolicy.BAND_FLOOR.dp
    return if (navigation >= floor) {
        this.offset(y = minOf(navigation - floor, floor))
    } else {
        this.padding(bottom = floor - navigation)
    }
}

/**
 * THE BAND'S PRESS: `bgPress` under the finger on the pill rung, and no
 * ripple — a ground and not a splash, a scale or an opacity, which DESIGN.md
 * refuses. The tab stays where it was and only its floor answers.
 */
@Composable
internal fun Modifier.bandPress(onPress: () -> Unit, resting: androidx.compose.ui.graphics.Color? = null): Modifier {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val ground = when {
        pressed -> centraidColor("bgPress")
        resting != null -> resting
        else -> androidx.compose.ui.graphics.Color.Transparent
    }
    return this
        .clip(RoundedCornerShape(BandPolicy.BAND_RADIUS.dp))
        .background(ground)
        .clickable(interactionSource = interaction, indication = null, onClick = onPress)
}

/** One of an app band's destinations, as the band draws it. */
public data class AppBandTab(
    val key: String,
    val label: String,
    val iconKey: String,
    val selected: Boolean,
)

/** The state-change curve, `--ease` at `--dur-1`. */
private val STATE_CHANGE = tween<Dp>(
    durationMillis = CentraidGeometry.DURATION_ONE.toInt(),
    easing = CubicBezierEasing(0.3f, 0f, 0.4f, 1f),
)

/**
 * AN APP'S BAND — the `AppPlace` room's band, the Compose twin of iOS's
 * `AppBand` in `Band.swift` (which carries the full argument).
 *
 * Two plates: the HOME CIRCLE on the page colour, because home is the one
 * thing an app may not take away (#883), and one plate of the app's own
 * destinations beside it. The lit tab is said three ways at once — the held
 * pair (`band` → `control`), the ink step, and a mark-wide rule inside the
 * plate that slides from tab to tab on the state-change curve. A change of
 * place is one selection tick. More is a tab in the plate when the app has a
 * More sheet, and absent when it has none.
 */
@Composable
public fun AppBand(
    app: String,
    tabs: List<AppBandTab>,
    onSelect: (String) -> Unit,
    onHome: () -> Unit,
    modifier: Modifier = Modifier,
    onMore: (() -> Unit)? = null,
) {
    val lit = tabs.indexOfFirst { it.selected }
    val haptics = LocalHapticFeedback.current
    val first = remember { booleanArrayOf(true) }
    LaunchedEffect(lit) {
        // THE TICK IS FOR A CHANGE, not for arriving: the first composition is
        // the band appearing, and a buzz on every screen entry is noise.
        if (first[0]) first[0] = false else haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
    }
    val height = BandPolicy.BAND_HEIGHT.dp
    Row(
        modifier
            .fillMaxWidth()
            .padding(
                start = BandPolicy.BAND_INSET.dp,
                end = BandPolicy.BAND_INSET.dp,
                top = BandPolicy.BAND_TOP_GAP.dp,
            )
            .bandFloor()
            .testTag("$app-band"),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // A CIRCLE, as wide as the plate is tall.
        Box(
            Modifier
                .size(height)
                .bandPress(onHome, resting = centraidColor("bg"))
                .border(CentraidGeometry.HAIRLINE.dp, centraidColor("lineStrong"), CircleShape)
                .testTag("$app-band-home")
                .semantics {
                    contentDescription = "Home"
                    role = Role.Button
                },
            contentAlignment = Alignment.Center,
        ) {
            CentraidIcon(
                iconKey = "Home",
                tint = centraidColor("textSoft"),
                size = BandPolicy.BAND_ICON_SIZE.dp,
            )
        }
        val count = tabs.size + if (onMore != null) 1 else 0
        BoxWithConstraints(
            Modifier
                .weight(1f)
                .height(height)
                .clip(RoundedCornerShape(BandPolicy.BAND_RADIUS.dp))
                .background(centraidColor("bgElev"))
                .border(
                    CentraidGeometry.HAIRLINE.dp,
                    centraidColor("lineStrong"),
                    RoundedCornerShape(BandPolicy.BAND_RADIUS.dp),
                ),
        ) {
            val pad = BandPolicy.BAND_PLATE_PAD.dp
            val tabWidth = (maxWidth - pad * 2) / maxOf(count, 1)
            Row(Modifier.fillMaxHeight().padding(pad)) {
                tabs.forEach { tab ->
                    AppBandTabView(
                        iconKey = tab.iconKey,
                        label = tab.label,
                        selected = tab.selected,
                        testTag = "$app-band-${tab.key}",
                        onPress = { onSelect(tab.key) },
                        modifier = Modifier.weight(1f),
                    )
                }
                if (onMore != null) {
                    AppBandTabView(
                        iconKey = "MoreVert",
                        label = "More",
                        selected = false,
                        testTag = "$app-band-more",
                        onPress = onMore,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
            // THE RULE: one mark, sliding, inside the plate and clear of its
            // hairline, as wide as the mark it stands over.
            if (lit >= 0) {
                val mark = BandPolicy.BAND_MARK_SIZE.dp
                val x by animateDpAsState(
                    targetValue = pad + tabWidth * lit + (tabWidth - mark) / 2,
                    animationSpec = STATE_CHANGE,
                    label = "band-rule",
                )
                Box(
                    Modifier
                        .offset(x = x, y = pad + CentraidGeometry.HAIRLINE.dp)
                        .size(width = mark, height = 2.dp)
                        .clip(CircleShape)
                        .background(centraidColor("text")),
                )
            }
        }
    }
}

@Composable
private fun AppBandTabView(
    iconKey: String,
    label: String,
    selected: Boolean,
    testTag: String,
    onPress: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxHeight()
            .bandPress(onPress)
            .padding(top = BandPolicy.BAND_TAB_TOP.dp, bottom = BandPolicy.BAND_TAB_BOTTOM.dp)
            .testTag(testTag)
            .semantics {
                contentDescription = label + if (selected) ", current place" else ""
                role = Role.Tab
                this.selected = selected
            },
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CentraidIcon(
            iconKey = iconKey,
            // Inactive is `textFaint`, as on the Home band: the lit mark is the
            // one ink shape in the strip.
            tint = if (selected) centraidColor("text") else centraidColor("textFaint"),
            size = BandPolicy.BAND_ICON_SIZE.dp,
        )
        Text(
            label,
            // THE HELD PAIR: one rung, two weights, no reflow.
            style = centraidType(if (selected) "control" else "band"),
            color = if (selected) centraidColor("text") else centraidColor("textSoft"),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(top = BandPolicy.BAND_LABEL_GAP.dp),
        )
    }
}
