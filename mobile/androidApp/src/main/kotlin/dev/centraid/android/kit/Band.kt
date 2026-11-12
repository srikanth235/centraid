package dev.centraid.android.kit


import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import dev.centraid.android.theme.centraidColor
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
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Shape
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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry
import centraid.core.v1.ShellBandTab

/**
 * THE BAND — invariant 1 (#1020, wave A; v0 `screens/home/HomeBand.tsx`).
 *
 * One band, never app-themed, never scrolled away, frame destinations only.
 * Rust (`Navigation.band`, #1135) decides which places, in what order, their
 * words and which one is lit; this file draws them and names the one that was
 * pressed. Where a press GOES is the navigator's, which is why nothing here routes.
 *
 * **NO ACTIVE BAR, NO TINTED CHIP, NO BADGE.** Selection is carried by the
 * label's weight and ink alone: `band` (400) in `textSoft` when it is not the
 * current place, `control` (600) in full ink when it is. A pill, a dot or a
 * count would each be a second thing to read in a strip that exists to be read
 * at a glance.
 */
@Composable
public fun HomeBand(
    tabs: List<ShellBandTab>,
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
            .background(Surface.card)
            .border(
                CentraidGeometry.HAIRLINE.dp,
                Surface.border,
                RoundedCornerShape(BandPolicy.BAND_RADIUS.dp),
            )
            .padding(BandPolicy.BAND_PLATE_PAD.dp)
            .testTag("home-band"),
    ) {
        tabs.forEach { place ->
            BandTab(
                iconKey = place.icon_key,
                label = place.label,
                // SPEAK WHAT IS PAINTED, and which place is the current one:
                // both are Rust's words.
                spoken = place.spoken,
                selected = place.selected,
                testTag = "home-band-${place.tab}",
                onPress = { onSelect(place.tab) },
                modifier = Modifier.weight(1f),
            )
        }
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
                            Surface.border,
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
                    tint = if (selected) Surface.ink else Surface.meta,
                    size = BandPolicy.BAND_ICON_SIZE.dp,
                )
            }
        }
        Text(
            label,
            // The same 11/15 rung either way, so a tap cannot reflow the strip,
            // and it HOLDS at every font scale: `control` scales elsewhere, so the
            // active half says `scales = false`.
            style = centraidType(if (selected) "control" else "band", scales = false),
            color = if (selected) Surface.ink else Surface.meta,
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
 * THE BAND'S GROUND, ONCE FOR EVERY BAND: Material 3 Expressive's floating pill — a SOLID tonal
 * surface, not glass. The plate is `bgElev` (raised paper, this theme's nearest token to Material's
 * surfaceContainer) at full opacity, on the shape's own rounded corners, lifted by a soft shadow
 * ([BandPolicy.BAND_ELEVATION]). Nothing is translucent and nothing is blurred: what the page
 * scrolls under the band is hidden by the plate, and shows only around it. iOS draws the same
 * controls as real Liquid Glass (`BandGround`); parity is the same behaviour, words and ids, not
 * the same pixels.
 *
 * Callers must not clip before this, which would cut the shadow off; clip after it when a child
 * needs the shape (a ripple, a press ground).
 *
 * Under high-contrast text ([rememberHighTextContrast]) the plate keeps its tone and takes the
 * hairline edge back (`lineStrong`) — the nearest thing Android has to iOS's Reduce Transparency
 * and Increase Contrast, which it has no setting for — and [bandStrip] puts the page colour back
 * under the strip.
 */
@Composable
internal fun Modifier.bandGround(shape: Shape): Modifier {
    val plate = this
        .shadow(BandPolicy.BAND_ELEVATION.dp, shape, clip = false)
        .background(Surface.card, shape)
    return if (rememberHighTextContrast()) {
        plate.border(CentraidGeometry.HAIRLINE.dp, Surface.border, shape)
    } else {
        plate
    }
}

/**
 * WHAT THE BAND STANDS ON: nothing, so what scrolls beneath shows around the floating plates; the
 * page colour under high-contrast text, so the strip is the slab it was.
 */
@Composable
internal fun Modifier.bandStrip(): Modifier =
    if (rememberHighTextContrast()) this.background(Surface.page) else this

/**
 * THE BAND'S PRESS: `bgPress` under the finger on the pill rung, and no
 * ripple — a ground and not a splash, a scale or an opacity, which design/behaviour.md § Controls
 * refuses. The tab stays where it was and only its floor answers.
 */
@Composable
internal fun Modifier.bandPress(onPress: () -> Unit): Modifier {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val ground = if (pressed) Surface.fill else androidx.compose.ui.graphics.Color.Transparent
    return this
        .clip(RoundedCornerShape(BandPolicy.BAND_RADIUS.dp))
        .background(ground)
        .clickable(interactionSource = interaction, indication = null, onClick = onPress)
}

/**
 * THE BAND'S SEARCH KEY, as an `AppPlace` hands it to the band it draws: the words a screen reader
 * says for it and the open. Absent where the app has no search (the Compose twin of iOS's
 * `BandSearchKey`).
 */
public class BandSearchKey(public val label: String, public val onOpen: () -> Unit)

/** The app's search for the band to draw as its trailing key; null draws none. */
public val LocalBandSearchKey: ProvidableCompositionLocal<BandSearchKey?> = compositionLocalOf { null }

/** One of an app band's destinations, as the band draws it. */
public data class AppBandTab(
    val key: String,
    val label: String,
    val iconKey: String,
    val selected: Boolean,
)

/** One segment of a band's segmented control: the machine's key, its word, whether it is lit. */
public data class BandSegment(val id: String, val label: String, val selected: Boolean)

/** The state-change curve, `--ease` at `--dur-1`. */
private val STATE_CHANGE = tween<Dp>(
    durationMillis = CentraidGeometry.DURATION_ONE,
    easing = CubicBezierEasing(0.3f, 0f, 0.4f, 1f),
)

/**
 * AN APP'S BAND — the `AppPlace` room's band, the Compose twin of iOS's
 * `AppBand` in `Band.swift` (which carries the full argument).
 *
 * Two plates and a key at each end: the HOME CIRCLE on the page colour, because home is the one
 * thing an app may not take away (#883), one plate of the app's own destinations beside it and,
 * where the app has search, the round SEARCH KEY at the trailing edge ([LocalBandSearchKey]). The lit tab is said three ways at once — the held
 * pair (`band` → `control`), the ink step, and a mark-wide rule inside the
 * plate that slides from tab to tab on the state-change curve. A change of
 * place is one selection tick. More is a tab in the plate when the app has a
 * More sheet, and absent when it has none.
 *
 * Both plates are solid tonal floating pills ([bandGround]) and what the page scrolls runs under
 * the band (`AppPlace`), showing around the pills.
 */
@Composable
public fun AppBand(
    app: String,
    tabs: List<AppBandTab>,
    onSelect: (String) -> Unit,
    onHome: () -> Unit,
    modifier: Modifier = Modifier,
    onMore: (() -> Unit)? = null,
    /**
     * A segmented control the page asks the band to carry (Photos' Years · Months · All). Empty is
     * none, and the plate of places is what the band draws. With some, the places FOLD into one
     * leading key and the control stands between that key and the search key; the key brings the
     * plate back, and a pick of a place puts the control back (the twin of iOS's `AppBand`).
     */
    segments: List<BandSegment> = emptyList(),
    onSegment: (String) -> Unit = {},
    /**
     * The places are behind a lock (a locked Locker): drawn in the disabled ink with no place lit,
     * and still pressable — a press is the member's way to start the unlock.
     */
    locked: Boolean = false,
) {
    var placesOpen by remember { mutableStateOf(false) }
    val folded = segments.isNotEmpty() && !placesOpen
    val lit = if (locked) -1 else tabs.indexOfFirst { it.selected }
    val searchKey = LocalBandSearchKey.current
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
        BandKey(
            iconKey = "Home",
            spoken = KitWords.BAND_HOME,
            testTag = "$app-band-home",
            onPress = onHome,
            alone = !folded && tabs.isEmpty() && onMore == null && searchKey == null,
        )
        val count = tabs.size + if (onMore != null) 1 else 0
        val plate = RoundedCornerShape(BandPolicy.BAND_RADIUS.dp)
        if (folded) {
            // THE PLACES, FOLDED: one key for where the member is, the same circle as Home and
            // search, and the segments in the middle.
            BandKey(
                iconKey = tabs.getOrNull(lit)?.iconKey ?: tabs.firstOrNull()?.iconKey ?: "Image",
                spoken = tabs.getOrNull(lit)?.label ?: tabs.firstOrNull()?.label.orEmpty(),
                testTag = "$app-band-places",
                onPress = { placesOpen = true },
            )
            BandSegmented(segments, onSegment, Modifier.weight(1f))
        } else BoxWithConstraints(
            Modifier
                .weight(1f)
                .height(height)
                .bandGround(plate),
        ) {
            val pad = BandPolicy.BAND_PLATE_PAD.dp
            val tabWidth = (maxWidth - pad * 2) / maxOf(count, 1)
            Row(Modifier.fillMaxHeight().padding(pad)) {
                tabs.forEach { tab ->
                    AppBandTabView(
                        iconKey = tab.iconKey,
                        label = tab.label,
                        selected = tab.selected && !locked,
                        locked = locked,
                        testTag = "$app-band-${tab.key}",
                        onPress = {
                            placesOpen = false
                            onSelect(tab.key)
                        },
                        modifier = Modifier.weight(1f),
                    )
                }
                if (onMore != null) {
                    AppBandTabView(
                        iconKey = "MoreHoriz",
                        label = KitWords.BAND_MORE,
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
                    animationSpec = motion(STATE_CHANGE),
                    label = "band-rule",
                )
                Box(
                    Modifier
                        .offset(x = x, y = pad + CentraidGeometry.HAIRLINE.dp)
                        .size(width = mark, height = 2.dp)
                        .clip(CircleShape)
                        .background(Surface.ink),
                )
            }
        }
        // THE APP'S SEARCH, at the trailing end: the Home circle's twin (same size, same pill), with
        // the magnifier Home's own search key wears. An app with no search slot hands none, and draws
        // none. One id on every app, because the key is the kit's and not the app's.
        if (searchKey != null) {
            BandKey(
                iconKey = "Search",
                spoken = searchKey.label,
                testTag = "band-search",
                onPress = searchKey.onOpen,
            )
        }
    }
}

/**
 * THE BAND'S SEGMENTED CONTROL: a plate of words between the folded place key and the search key,
 * the plate's own height and ground, each segment at least 44dp wide. The lit one takes the held
 * pair (`band` to `control`, one rung, so a press reflows nothing) and the selected ground,
 * `bgSunken`, never an accent. Each segment's test tag is its `id`.
 */
@Composable
internal fun BandSegmented(
    segments: List<BandSegment>,
    onPick: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val plate = RoundedCornerShape(BandPolicy.BAND_RADIUS.dp)
    Row(
        modifier
            .height(BandPolicy.BAND_HEIGHT.dp)
            .bandGround(plate)
            .padding(BandPolicy.BAND_PLATE_PAD.dp),
    ) {
        segments.forEach { segment ->
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .clip(plate)
                    .background(if (segment.selected) Surface.fill else androidx.compose.ui.graphics.Color.Transparent)
                    .clickable { onPick(segment.id) }
                    .testTag(segment.id)
                    .semantics {
                        contentDescription = segment.label
                        role = Role.Tab
                        selected = segment.selected
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    segment.label,
                    style = centraidType(if (segment.selected) "control" else "band", scales = false),
                    color = if (segment.selected) Surface.ink else Surface.meta,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/**
 * A ROUND KEY ON THE BAND: Home at the leading end and the app's search at the trailing end are
 * this one composable — as wide as the plate is tall, on the same tonal pill ([bandGround]), and
 * `bgPress` while held like every other press on the band.
 */
@Composable
internal fun BandKey(iconKey: String, spoken: String, testTag: String, onPress: () -> Unit, alone: Boolean = false) {
    Box(
        Modifier
            .size(BandPolicy.BAND_HEIGHT.dp)
            .bandGround(CircleShape)
            // A key standing alone (a locked Locker) wears the board's faint hairline too.
            .then(if (alone) Modifier.border(CentraidGeometry.HAIRLINE.dp, Surface.border, CircleShape) else Modifier)
            .bandPress(onPress)
            .testTag(testTag)
            .semantics {
                contentDescription = spoken
                role = Role.Button
            },
        contentAlignment = Alignment.Center,
    ) {
        CentraidIcon(
            iconKey = iconKey,
            tint = Surface.meta,
            size = BandPolicy.BAND_ICON_SIZE.dp,
        )
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
    locked: Boolean = false,
) {
    val ink = if (locked) centraidColor("textDisabled") else if (selected) Surface.ink else Surface.meta
    Column(
        modifier
            .fillMaxHeight()
            .bandPress(onPress)
            .padding(top = BandPolicy.BAND_TAB_TOP.dp, bottom = BandPolicy.BAND_TAB_BOTTOM.dp)
            .testTag(testTag)
            .semantics {
                contentDescription = label + if (selected) ", " + KitWords.BAND_CURRENT else ""
                role = Role.Tab
                this.selected = selected
            },
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CentraidIcon(
            iconKey = iconKey,
            // Inactive is `textFaint`, as on the Home band: the lit mark is the
            // one ink shape in the strip.
            tint = ink,
            size = BandPolicy.BAND_ICON_SIZE.dp,
        )
        Text(
            label,
            // THE HELD PAIR: one rung, two weights, no reflow — and it holds at
            // every font scale (`control` scales elsewhere).
            style = centraidType(if (selected) "control" else "band", scales = false),
            color = ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(top = BandPolicy.BAND_LABEL_GAP.dp),
        )
    }
}
