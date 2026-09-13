package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import centraid.screen.v1.VaultLockup
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry

/**
 * THE TWO FACTS TRUE ON EVERY ROUTE: which vault, which gateway
 * (#1020, wave A; v0 `screens/home/VaultHeader.tsx`).
 *
 * No greeting. **The mark IS the vault switch** — there is no chevron beside it,
 * because a lockup that is not pressable and a control that is are two
 * affordances for one act. The gateway line is mono and says offline IN PLACE,
 * never as a banner: offline is not an incident.
 *
 * Exactly the band's two verbs beside it, never a third.
 */
@Composable
public fun VaultHeader(
    vault: VaultLockup?,
    onSwitchVault: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // No name is a REAL STATE; never render a blank lockup.
    val name = vault?.vault_name?.trim().orEmpty().ifEmpty { "No vault yet" }
    val gateway = vault?.gateway_name?.trim().orEmpty()
    val line = when {
        gateway.isEmpty() -> "not connected to a gateway"
        vault?.offline == true -> "$gateway · offline"
        else -> gateway
    }
    val hue = vaultHue(vault?.color)
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp)
            .padding(top = 12.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            Modifier
                .weight(1f)
                .clickable(onClick = onSwitchVault)
                .testTag("home-vault-switch")
                // The label REPLACES the two lines for assistive tech, so a
                // screen reader hears one sentence rather than a name and an
                // orphan line.
                .semantics(mergeDescendants = true) {
                    contentDescription = "$name on $line. Switch vault"
                },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                Modifier
                    .size(30.dp)
                    // A static control rung, not the chip ratio — that is for
                    // app marks.
                    .clip(RoundedCornerShape(7.dp))
                    .background(hue.ground),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    name.take(1).uppercase(),
                    style = centraidType("smallStrong"),
                    color = hue.ink,
                )
            }
            Column(Modifier.weight(1f)) {
                Text(
                    name,
                    style = centraidType("smallStrong"),
                    color = centraidColor("text"),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    line,
                    style = centraidType("mono"),
                    color = centraidColor("textFaint"),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        // BOUNDED, never borderless.
        HeaderAction(iconKey = "Search", spoken = "Search everything")
        // Outlined here; filled only inside the band.
        HeaderAction(iconKey = "NewChat", spoken = "New chat")
    }
}

@Composable
private fun HeaderAction(iconKey: String, spoken: String) {
    Box(
        Modifier
            .size(34.dp)
            .clip(RoundedCornerShape(7.dp))
            .border(
                CentraidGeometry.HAIRLINE.dp,
                centraidColor("lineStrong"),
                RoundedCornerShape(7.dp),
            )
            .semantics { contentDescription = spoken },
        contentAlignment = Alignment.Center,
    ) {
        CentraidIcon(iconKey = iconKey, tint = centraidColor("textSoft"), size = 16.dp)
    }
}

/**
 * The route's own name and the ONE control the row carries.
 *
 * Search belongs to the lockup and All apps to the band's More tab, so the title
 * row carries Settings alone — which in v0 had no door from Home at all and sat
 * behind All apps, a sheet a member on the springboard has no reason to open.
 */
@Composable
public fun HomeTitleRow(modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp)
                .padding(bottom = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "Home",
                style = centraidType("title"),
                color = centraidColor("text"),
                modifier = Modifier.weight(1f),
            )
            Box(
                Modifier
                    .sizeIn(minWidth = 44.dp, minHeight = 44.dp)
                    .testTag("home-settings")
                    .semantics { contentDescription = "Settings" },
                contentAlignment = Alignment.Center,
            ) {
                CentraidIcon(iconKey = "Settings", tint = centraidColor("text"), size = 22.dp)
            }
        }
        Box(
            Modifier
                .fillMaxWidth()
                .height(CentraidGeometry.HAIRLINE.dp)
                .background(centraidColor("line")),
        )
    }
}

/**
 * A vault's own hue, and the one wash that is not emitted.
 *
 * Every APP hue is resolved and composited by
 * `contracts/tools/export-native-catalog.ts`, because the eight apps are known
 * at build time. A vault's colour is the MEMBER's, chosen at runtime, so it
 * cannot be in that table — and this is the one place the blend is computed
 * rather than read. It uses the same tint share the emitter uses, from the same
 * table, so the two cannot drift apart. A vault with no colour takes ink, never
 * a default hue: an invented identity is still invented when it is only a
 * colour.
 */
@Composable
private fun vaultHue(color: String?): VaultMark {
    val parsed = parseHex(color)
        ?: return VaultMark(centraidColor("bgSunken"), centraidColor("text"))
    val share = if (isSystemInDarkTheme()) {
        CentraidGeometry.ICON_CHIP_TINT_DARK
    } else {
        CentraidGeometry.ICON_CHIP_TINT_LIGHT
    }
    val page = centraidColor("bg")
    // An OPAQUE composite, not a translucent overlay: what sits behind a lockup
    // changes with the route, and opacity over an unknown ground is a guess.
    return VaultMark(
        ground = Color(
            red = parsed.red * share.toFloat() + page.red * (1f - share.toFloat()),
            green = parsed.green * share.toFloat() + page.green * (1f - share.toFloat()),
            blue = parsed.blue * share.toFloat() + page.blue * (1f - share.toFloat()),
        ),
        ink = parsed,
    )
}

private data class VaultMark(val ground: Color, val ink: Color)

private fun parseHex(value: String?): Color? {
    val hex = value?.trim()?.removePrefix("#") ?: return null
    if (hex.length != 6 || hex.any { it.digitToIntOrNull(16) == null }) return null
    val scanned = hex.toLong(16)
    return Color(
        red = ((scanned shr 16) and 0xFF).toInt() / 255f,
        green = ((scanned shr 8) and 0xFF).toInt() / 255f,
        blue = (scanned and 0xFF).toInt() / 255f,
    )
}
