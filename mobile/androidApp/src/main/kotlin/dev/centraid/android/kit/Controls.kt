package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.SwitchColors
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.shared.shell.BandPolicy

/** A radius off the token scale (`sm`, `pill`, ...). A literal radius is a finding. */
@Composable
private fun controlRadius(name: String) =
    RoundedCornerShape((LocalCentraidTokens.current.radii[name] ?: 0).dp)

/**
 * A CHIP: a filter or a choice among several. A capsule 32dp tall inside a 44dp
 * target, so the thumb has room and the page does not look like a toolbar.
 *
 * SELECTED IS NEVER ACCENT. Accent is the ink button's alone ("the one thing to
 * do"); a chosen filter is a place, not an act, so it is said by a `bgSunken`
 * ground, a `lineStrong` edge and the `smallStrong` step of the label.
 * Unselected sits on `bg` with a `line` edge in `textSoft`. A disabled chip
 * goes to the `textDisabled` ink on the leaf, never a faded container.
 *
 * [count] is the optional figure after the label (`annotLabel`, `textFaint`);
 * [chevron] marks a chip that opens a menu or a sheet instead of toggling.
 */
@Composable
public fun KitChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    count: String = "",
    chevron: Boolean = false,
    enabled: Boolean = true,
) {
    val shape = controlRadius("pill")
    val ink = when {
        !enabled -> centraidColor("textDisabled")
        selected -> centraidColor("text")
        else -> centraidColor("textSoft")
    }
    Box(
        modifier
            .heightIn(min = KitGeometry.ROW_MIN)
            .clip(shape)
            .clickable(enabled = enabled, onClick = onClick)
            .semantics(mergeDescendants = true) {
                role = Role.Button
                this.selected = selected
            },
        contentAlignment = Alignment.Center,
    ) {
        Row(
            Modifier
                .height(32.dp)
                .clip(shape)
                .background(centraidColor(if (selected) "bgSunken" else "bg"), shape)
                .border(KitGeometry.HAIRLINE, centraidColor(if (selected) "lineStrong" else "line"), shape)
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                label,
                style = centraidType(if (selected) "smallStrong" else "small"),
                color = ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (count.isNotEmpty()) {
                Text(
                    count,
                    style = centraidType("annotLabel"),
                    color = if (enabled) centraidColor("textFaint") else centraidColor("textDisabled"),
                    maxLines = 1,
                )
            }
            if (chevron) {
                CentraidIcon(iconKey = "ChevronDown", tint = ink, size = 10.dp)
            }
        }
    }
}

/**
 * A SEGMENTED CONTROL: one of two to four views, in the band plate's grammar
 * (Band.kt) so a view switch and a place switch read as the same family. A
 * `bgElev` plate on a `lineStrong` edge, the held `band` -> `control` pair for
 * the label, and a rule under the lit one. [options] are (key, label) pairs.
 */
@Composable
public fun KitSegmented(
    options: List<Pair<String, String>>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(BandPolicy.BAND_RADIUS.dp)
    Row(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(centraidColor("bgElev"))
            .border(KitGeometry.HAIRLINE, centraidColor("lineStrong"), shape)
            .padding(BandPolicy.BAND_PLATE_PAD.dp)
            .semantics { role = Role.Tab },
    ) {
        options.forEach { (key, label) ->
            val lit = key == selected
            Column(
                Modifier
                    .weight(1f)
                    .heightIn(min = 36.dp)
                    .bandPress({ onSelect(key) })
                    .padding(horizontal = 4.dp, vertical = 6.dp)
                    .testTag("kit-segment-$key")
                    .semantics {
                        role = Role.Tab
                        this.selected = lit
                    },
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    label,
                    // THE HELD PAIR: one rung, two weights, no reflow.
                    style = centraidType(if (lit) "control" else "band", scales = false),
                    color = centraidColor(if (lit) "text" else "textSoft"),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                )
                Box(
                    Modifier
                        .padding(top = 3.dp)
                        .size(width = 20.dp, height = 2.dp)
                        .clip(RoundedCornerShape(1.dp))
                        .background(if (lit) centraidColor("text") else androidx.compose.ui.graphics.Color.Transparent),
                )
            }
        }
    }
}

/**
 * A STEPPER: previous / next as two framed icon keys, 8dp apart. A key that
 * cannot move is left in place and does nothing, so the pair never reflows.
 */
@Composable
public fun KitStepper(
    previousLabel: String,
    nextLabel: String,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    modifier: Modifier = Modifier,
    canPrevious: Boolean = true,
    canNext: Boolean = true,
    previousTag: String = "kit-stepper-previous",
    nextTag: String = "kit-stepper-next",
) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        IconKey(
            iconKey = "ChevronLeft",
            label = previousLabel,
            testTag = previousTag,
            onPress = { if (canPrevious) onPrevious() },
        )
        IconKey(
            iconKey = "ChevronRight",
            label = nextLabel,
            testTag = nextTag,
            onPress = { if (canNext) onNext() },
        )
    }
}

/**
 * A LINK: a verb that reads as words. `link` ink, no border, no fill. A 44dp
 * target always; `annotLabelOn` inside a dense row, `smallStrong` standing
 * alone. Press feedback is the platform default, as on a section header's verb.
 */
@Composable
public fun KitLink(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    dense: Boolean = false,
    enabled: Boolean = true,
) {
    Box(
        modifier
            .heightIn(min = KitGeometry.ROW_MIN)
            .widthIn(min = KitGeometry.ROW_MIN)
            .clip(RoundedCornerShape(KitGeometry.RADIUS))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 8.dp)
            .semantics { role = Role.Button },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = centraidType(if (dense) "annotLabelOn" else "smallStrong"),
            color = centraidColor(if (enabled) "link" else "textDisabled"),
        )
    }
}

/**
 * A CHECK BOX: a 20dp box (`sm` radius) in a 44dp target. Off is a 1.5dp
 * `lineStrong` outline; on is an `accent` fill with an `onAccent` check.
 * [label] is the whole spoken description (the box says nothing itself).
 */
@Composable
public fun KitCheckBox(
    checked: Boolean,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = controlRadius("sm")
    Box(
        modifier
            .size(KitGeometry.ROW_MIN)
            .clip(RoundedCornerShape(KitGeometry.RADIUS))
            .clickable(onClick = onClick)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Checkbox
                toggleableState = if (checked) ToggleableState.On else ToggleableState.Off
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(20.dp)
                .clip(shape)
                .then(
                    if (checked) {
                        Modifier.background(centraidColor("accent"), shape)
                    } else {
                        Modifier.border(1.5.dp, centraidColor("lineStrong"), shape)
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (checked) {
                CentraidIcon(iconKey = "Check", tint = centraidColor("onAccent"), size = 14.dp)
            }
        }
    }
}

/**
 * THE SWITCH'S COLOURS: `accent` when on, a `bgSunken` track with a
 * `lineStrong` edge when off. A disabled switch goes to `textDisabled`.
 */
@Composable
public fun kitSwitchColors(): SwitchColors = SwitchDefaults.colors(
    checkedThumbColor = centraidColor("onAccent"),
    checkedTrackColor = centraidColor("accent"),
    checkedBorderColor = centraidColor("accent"),
    uncheckedThumbColor = centraidColor("textSoft"),
    uncheckedTrackColor = centraidColor("bgSunken"),
    uncheckedBorderColor = centraidColor("lineStrong"),
    disabledCheckedThumbColor = centraidColor("bg"),
    disabledCheckedTrackColor = centraidColor("textDisabled"),
    disabledCheckedBorderColor = centraidColor("textDisabled"),
    disabledUncheckedThumbColor = centraidColor("textDisabled"),
    disabledUncheckedTrackColor = centraidColor("bgSunken"),
    disabledUncheckedBorderColor = centraidColor("line"),
)

/**
 * A WRITE OR A TRANSFER IN FLIGHT: a 20dp ring (2dp stroke) in `textSoft`, with
 * an optional [label] beside it in `small` `textSoft`. Loading a screen is a
 * skeleton (`ReadState`) — a spinner cannot say what shape is coming, so it is
 * reserved for work with no shape to draw: a save running, a download starting.
 * [label] is also the content description; a bare ring says nothing to
 * TalkBack, so it is named.
 */
@Composable
public fun KitSpinner(label: String = "", modifier: Modifier = Modifier) {
    SpinnerRow(label, modifier, ring = "textSoft", words = "textSoft")
}

/**
 * THE SPINNER ON THE PHOTO STAGE: [KitSpinner]'s ring and label in the stage's
 * own inks, `onStage` for the ring and `onStageSoft` for the label, so a
 * download under a photograph reads on its dark ground.
 */
@Composable
public fun StageSpinner(label: String = "", modifier: Modifier = Modifier) {
    SpinnerRow(label, modifier, ring = "onStage", words = "onStageSoft")
}

@Composable
private fun SpinnerRow(label: String, modifier: Modifier, ring: String, words: String) {
    Row(
        modifier.clearAndSetSemantics { if (label.isNotEmpty()) contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        CircularProgressIndicator(
            modifier = Modifier.size(20.dp),
            strokeWidth = 2.dp,
            color = centraidColor(ring),
            trackColor = androidx.compose.ui.graphics.Color.Transparent,
        )
        if (label.isNotEmpty()) {
            Text(label, style = centraidType("small"), color = centraidColor(words))
        }
    }
}

/**
 * HOW FAR A TRANSFER HAS GOT, WHEN ANYONE CAN SAY: a 2dp rule on the `sm` rung,
 * `accent` on `bgSunken`. [fraction] is clamped to 0..1; when nobody can say
 * how far, draw [KitSpinner], never a bar stuck at zero. [ink] re-inks the
 * fill for a bar that sits in a status line (`textSoft`), where accent would
 * make a quiet line shout; [onStage] re-inks the whole bar for the photo stage
 * (`onStage` on `onStageSoft`).
 */
@Composable
public fun KitProgressBar(
    fraction: Float,
    modifier: Modifier = Modifier,
    ink: String = "accent",
    onStage: Boolean = false,
) {
    val clamped = fraction.coerceIn(0f, 1f)
    val shape = controlRadius("sm")
    Box(
        modifier
            .fillMaxWidth()
            .height(2.dp)
            .clip(shape)
            .background(centraidColor(if (onStage) "onStageSoft" else "bgSunken"))
            .semantics { progressBarRangeInfo = ProgressBarRangeInfo(clamped, 0f..1f) },
    ) {
        Box(
            Modifier
                .fillMaxHeight()
                .fillMaxWidth(clamped)
                .background(centraidColor(if (onStage) "onStage" else ink)),
        )
    }
}

/**
 * THE STAGE'S ICON KEY: a 44dp target around a 24dp glyph in `onStage`, with no
 * plate — it floats over a photograph, where a plate would be a second ground.
 * Disabled goes to `onStageSoft` on the glyph (never a faded container) and the
 * key is still drawn. Press feedback is the platform default, as on [KitLink];
 * [label] is the whole spoken description.
 */
@Composable
public fun StageKey(
    iconKey: String,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Box(
        modifier
            .size(KitGeometry.ROW_MIN)
            .clip(controlRadius("pill"))
            .clickable(enabled = enabled, onClick = onClick)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
                if (!enabled) disabled()
            },
        contentAlignment = Alignment.Center,
    ) {
        CentraidIcon(
            iconKey = iconKey,
            tint = centraidColor(if (enabled) "onStage" else "onStageSoft"),
            size = 24.dp,
        )
    }
}

/**
 * A WORD ON THE STAGE ("Leave", "Load the original"): `onStage` ink on the
 * stage's ground, no plate, a 44dp target. [KitLink] is `link` ink, which is
 * paper's and does not read over a photograph; this is its stage twin, as
 * [StageKey] is [IconKey]'s.
 */
@Composable
public fun StageVerb(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier
            .defaultMinSize(minWidth = 44.dp, minHeight = 44.dp)
            .clip(controlRadius("pill"))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp)
            .semantics { role = Role.Button },
        contentAlignment = Alignment.Center,
    ) {
        Text(text = label, color = centraidColor("onStage"), style = centraidType("smallStrong"))
    }
}
