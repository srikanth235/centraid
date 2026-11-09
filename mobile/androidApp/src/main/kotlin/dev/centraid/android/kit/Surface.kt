package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import dev.centraid.design.CentraidGeometry
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.centraid.android.R
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidScale

/**
 * THE REDESIGN'S SURFACES AND STATE COLOURS (#1173), from the generated `centraid_*` resources.
 *
 * Two page colours: [page] for a page of cards and [plainPage] for a plain list. In dark there
 * is one page colour, so both resolve to it. Cards are white ([card]) with the card radius;
 * Material 3 Expressive draws elevation as tone, so nothing here casts a shadow. A sheet sits one
 * level up in dark ([sheet], with [sheetCard] on it). The scheme is the member's own choice, not
 * only the phone's (see [centraidResource]).
 */
public object Surface {
    public val page: Color @Composable get() = centraidResource(R.color.centraid_surface_page)
    public val plainPage: Color @Composable get() = centraidResource(R.color.centraid_surface_plain_page)
    public val card: Color @Composable get() = centraidResource(R.color.centraid_surface_card)
    public val sheet: Color @Composable get() = centraidResource(R.color.centraid_surface_sheet)
    public val sheetCard: Color @Composable get() = centraidResource(R.color.centraid_surface_sheet_card)
    /** The hairline between rows on a sheet's card. */
    public val sheetLine: Color @Composable get() = Surface.line
    public val fill: Color @Composable get() = centraidResource(R.color.centraid_surface_fill)
    public val line: Color @Composable get() = centraidResource(R.color.centraid_surface_line)
    public val border: Color @Composable get() = centraidResource(R.color.centraid_surface_border)

    /** Ink under a white letter or glyph; it keeps its ink in dark. */
    public val tile: Color @Composable get() = centraidResource(R.color.centraid_surface_tile)
    public val ink: Color @Composable get() = centraidResource(R.color.centraid_text_ink)
    public val body: Color @Composable get() = centraidResource(R.color.centraid_text_body)
    public val meta: Color @Composable get() = centraidResource(R.color.centraid_text_meta)
}

/**
 * A STATE, and only a state: red, amber and green appear in words and badges to say overdue,
 * pending or done, never as decoration. [text] is the word's colour on the page or a card,
 * [fill] a solid under white glyphs, [tint] the pale ground of a badge.
 */
public enum class StateColor {
    Red, Amber, Green;

    public val text: Color
        @Composable get() = centraidResource(
            when (this) {
                Red -> R.color.centraid_state_red_text
                Amber -> R.color.centraid_state_amber_text
                Green -> R.color.centraid_state_green_text
            },
        )

    public val fill: Color
        @Composable get() = centraidResource(
            when (this) {
                Red -> R.color.centraid_state_red
                Amber -> R.color.centraid_state_amber
                Green -> R.color.centraid_state_green
            },
        )

    public val tint: Color
        @Composable get() = centraidResource(
            when (this) {
                Red -> R.color.centraid_state_red_tint
                Amber -> R.color.centraid_state_amber_tint
                Green -> R.color.centraid_state_green_tint
            },
        )
}

/**
 * THE TYPE SCALE (#1173): titles 34 bold, the centred heroes' title 24 bold, sections 20, rows 16, meta 13, plus the 12pt group head
 * and the 11pt badge, both in capitals. Sizes and weights are the generated [CentraidScale]; the
 * face is the shell's own, so a weight with no file of its own draws at the nearest face that
 * has one (700 draws at the semibold file). The size follows the font scale, capped at the root.
 */
public enum class KitType(
    internal val size: Float,
    internal val weight: Int,
    public val caps: Boolean,
) {
    Title(CentraidScale.titleSize, CentraidScale.titleWeight, CentraidScale.titleCaps),
    Hero(CentraidScale.heroSize, CentraidScale.heroWeight, CentraidScale.heroCaps),
    Section(CentraidScale.sectionSize, CentraidScale.sectionWeight, CentraidScale.sectionCaps),
    Row(CentraidScale.rowSize, CentraidScale.rowWeight, CentraidScale.rowCaps),
    Meta(CentraidScale.metaSize, CentraidScale.metaWeight, CentraidScale.metaCaps),
    Group(CentraidScale.groupSize, CentraidScale.groupWeight, CentraidScale.groupCaps),
    Badge(CentraidScale.badgeSize, CentraidScale.badgeWeight, CentraidScale.badgeCaps),
}

/** The text style of a rung of the scale, on the shell's face. */
@Composable
@ReadOnlyComposable
public fun kitTextStyle(rung: KitType): TextStyle {
    // The face and its leading come from an existing role of the same weight, so the line box and
    // the font family stay the shell's; the size and weight are the scale's.
    val base = centraidType(if (rung.weight >= 600) "control" else "body")
    val lineFactor = if (rung == KitType.Title || rung == KitType.Hero || rung == KitType.Section) 1.18f else 1.32f
    return base.copy(
        fontFamily = base.fontFamily ?: FontFamily.Default,
        fontSize = rung.size.sp,
        lineHeight = (rung.size * lineFactor).sp,
        fontWeight = FontWeight(if (rung.weight >= 600) 600 else 400),
    )
}

/** Text drawn in a rung of the scale: its capitals when the rung says so. */
@Composable
public fun KitText(
    text: String,
    rung: KitType,
    color: Color,
    modifier: Modifier = Modifier,
    maxLines: Int = Int.MAX_VALUE,
) {
    Text(
        text = if (rung.caps) text.uppercase() else text,
        style = kitTextStyle(rung),
        color = color,
        modifier = modifier,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
    )
}

/** A white card on a card page: the card radius, no shadow, no border. */
@Composable
public fun Modifier.kitCard(): Modifier =
    clip(RoundedCornerShape(CentraidScale.cardRadius.dp)).background(Surface.card)

/** A card on a plain list page, where its white needs an edge to be read. */
@Composable
public fun Modifier.kitBorderedCard(): Modifier {
    val shape = RoundedCornerShape(CentraidScale.cardRadius.dp)
    return clip(shape).background(Surface.card).border(1.dp, Surface.border, shape)
}

/**
 * ONE BADGE SHAPE (#1173): 11pt capitals on a pale tint, in the state's colour. The same
 * composable draws "Compromised", "Overdue" and "Pending" everywhere.
 */
@Composable
public fun KitBadge(label: String, state: StateColor, modifier: Modifier = Modifier) {
    KitText(
        text = label,
        rung = KitType.Badge,
        color = state.text,
        maxLines = 1,
        modifier = modifier
            .clip(RoundedCornerShape(KitBadgeRadius))
            .background(state.tint)
            .padding(horizontal = 6.dp, vertical = 3.dp),
    )
}

/** The badge corner, shared by the state badges and the plain chip. */
internal val KitBadgeRadius = 6.dp

/**
 * A SMALL GLYPH TILE: a white glyph on a solid fill, the radius a ratio of the side so every size
 * keeps one shape. The default fill is the app's; a destructive row passes the state's.
 */
@Composable
public fun KitTile(iconKey: String, modifier: Modifier = Modifier, size: Dp = 32.dp, fill: Color? = null) {
    val shape = RoundedCornerShape((size.value * CentraidGeometry.ICON_CHIP_RADIUS_RATIO).dp)
    Box(
        modifier.size(size).clip(shape).background(fill ?: appAccent().fill).clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        CentraidIcon(iconKey = iconKey, tint = Color.White, size = (size.value * 0.5f).dp)
    }
}

/**
 * A PILL THAT HUGS ITS LABEL, in the app's fill under a white label: an empty state's one action,
 * a permission's "Allow". The full-width one is [InkButton].
 */
@Composable
public fun KitPillButton(
    label: String,
    onPress: () -> Unit,
    modifier: Modifier = Modifier,
    testTag: String = "kit-pill",
    enabled: Boolean = true,
) {
    Box(
        modifier
            .heightIn(min = KitGeometry.ROW_MIN)
            .clip(RoundedCornerShape(percent = 50))
            .background(if (enabled) appAccent().fill else Surface.fill)
            .clickable(enabled = enabled, onClick = onPress)
            .padding(horizontal = 20.dp)
            .testTag(testTag)
            .semantics {
                role = Role.Button
                if (!enabled) disabled()
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
            color = if (enabled) Color.White else Surface.meta,
            maxLines = 1,
        )
    }
}
