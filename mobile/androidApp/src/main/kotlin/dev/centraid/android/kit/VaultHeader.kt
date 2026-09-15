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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import centraid.screen.v1.VaultLockup
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry
import dev.centraid.shared.shell.TransferRuleChoice

/**
 * WHERE A VAULT STANDS, in a member's words — the ONE wording table, shared by
 * the header and the switcher (#1025 S7-9).
 *
 * It is a function rather than a `when` typed into each drawing site because
 * the header's second line and the switcher's caption are two renderings of the
 * SAME `State`, and two tables are two places the same fact can be worded
 * differently. The iOS shell states the identical table; the two shells
 * must read the same, so a change here is a change there.
 *
 * **"Online" is a PAST-TENSE FACT.** [VaultLockup.State.STATE_ONLINE] says the
 * last pass REACHED the gateway and finished; nothing on this screen probes
 * anything, so "connected" would promise a live link this state has not checked.
 * "Synced" is what it may say, and it is what it says.
 *
 * EXHAUSTIVE and with no `else`, deliberately: a fourth case added to `State`
 * must fail to compile here rather than fall quietly into somebody else's
 * sentence, which is the failure this line is recovering from.
 *
 * `STATE_UNSPECIFIED` is the proto zero and is NEVER EMITTED — a lockup
 * carrying it is one nobody filled in — so it draws NOTHING. Pairing is not in
 * this table at all: pairing is an ACTION, a vault the device holds has by
 * definition been paired, and "unpaired" is a state of the DEVICE (zero vaults
 * held, which is the pair flow) and never of a vault. `Link` spent two waves
 * claiming otherwise.
 */
public fun stateLine(state: VaultLockup.State): String = when (state) {
    VaultLockup.State.STATE_UNSPECIFIED -> ""
    VaultLockup.State.STATE_SYNCING -> "syncing"
    VaultLockup.State.STATE_ONLINE -> "synced"
    VaultLockup.State.STATE_OFFLINE -> "offline"
}

/**
 * THE TWO FACTS TRUE ON EVERY ROUTE: which vault, and how it stands
 * (#1020, wave A; v0 `screens/home/VaultHeader.tsx`).
 *
 * No greeting. **The mark IS the vault switch** — there is no chevron beside it,
 * because a lockup that is not pressable and a control that is are two
 * affordances for one act. The second line is mono and says where this vault
 * stands IN PLACE, never as a banner: none of those states is an incident.
 *
 * **It says the VAULT's state and never a gateway's name (#1025).** This drew
 * `gateway_name`, a field no layer on any side ever wrote, so a device that had
 * paired, synced and was holding its rows read "not connected to a gateway" for
 * two waves. Nothing in the pairing exchange names a gateway — a device pairs
 * with a VAULT — so there was no name to fill in and [VaultLockup.State] is the
 * fact that can be told.
 *
 * Exactly the band's two verbs beside it, never a third.
 */
@Composable
public fun VaultHeader(
    vault: VaultLockup?,
    onSwitchVault: () -> Unit,
    modifier: Modifier = Modifier,
    /**
     * Open the transfer-rules sheet (#1025 S4). Defaulted so a preview and a
     * fixture render this header without one.
     */
    onDownloadSettings: () -> Unit = {},
) {
    // No name is a REAL STATE; never render a blank lockup.
    val name = vault?.vault_name?.trim().orEmpty().ifEmpty { "No vault yet" }
    val line = stateLine(vault?.state ?: VaultLockup.State.STATE_UNSPECIFIED)
    // THE MEMBER'S OWN RULE, SAID IN PLACE (#1025 S4, D-1025-S7-61). A grid of
    // thumbnails with no full-size files is a DECISION and not a failure, and a
    // header that says nothing is how a working byte plane looks broken. A
    // SECOND line beside the state and not a replacement: a device can be
    // perfectly current and still be waiting for Wi-Fi to bring the
    // photographs.
    val withheld = vault?.originals_withheld ?: 0
    val waiting = when {
        withheld <= 0 -> ""
        withheld == 1 -> "1 original waiting for Wi-Fi"
        else -> "$withheld originals waiting for Wi-Fi"
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
                    contentDescription =
                        listOf(name, line, waiting).filter { it.isNotEmpty() }
                            .joinToString(", ") + ". Switch vault" 
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
                if (line.isNotEmpty()) {
                    Text(
                        line,
                        style = centraidType("mono"),
                        color = centraidColor("textFaint"),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (waiting.isNotEmpty()) {
                    Text(
                        waiting,
                        style = centraidType("mono"),
                        color = centraidColor("textFaint"),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.testTag("home-originals-waiting"),
                    )
                }
            }
        }
        // THE DOOR TO THE TRANSFER RULES (#1025 S4). Beside the line that
        // reports them rather than buried in settings: a member reads
        // "12 originals waiting for Wi-Fi" and the next thing they want is the
        // control that decided it.
        if (waiting.isNotEmpty()) {
            Box(Modifier.clickable(onClick = onDownloadSettings).testTag("home-transfer-rules")) {
                HeaderAction(iconKey = "Settings", spoken = "Download settings")
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

/**
 * THE MEMBER'S TRANSFER RULE, AS A SHEET (#1025 S4, D-1025-S7-60).
 *
 * Three choices, each a plain SENTENCE rather than a label — a member deciding
 * how their phone spends money is owed something they can act on, and "Wi-Fi
 * only" is a label that does not say what it governs. The sentences come from
 * the shell's own copy source in `commonMain` (`TransferRule`, through
 * `HomeBridge.transferRuleChoices`), so this shell and iOS cannot word the
 * same choice two ways.
 *
 * **It sets the rule and starts nothing.** A member who has just chosen to
 * spend less must not be answered by a pass that spends; the new rule governs
 * the next window.
 */
@Composable
public fun TransferRulesSheet(
    choices: List<TransferRuleChoice>,
    selected: String,
    onPick: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier.padding(CentraidGeometry.PAGE_MARGIN.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            "Downloads",
            style = centraidType("title"),
            color = centraidColor("text"),
        )
        Text(
            "This is set for this phone, not for one vault. Thumbnails always arrive.",
            style = centraidType("small"),
            color = centraidColor("textSoft"),
        )
        choices.forEach { choice ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp)
                    .clickable { onPick(choice.stored) }
                    .testTag("transfer-rule-" + choice.stored)
                    .semantics(mergeDescendants = true) {
                        contentDescription = choice.sentence
                        if (choice.stored == selected) selected()
                    },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                RadioButton(
                    // THE SELECTION IS THE STORE'S ANSWER, not the tap: an
                    // unknown word settles to the conservative default, and a
                    // tick on a row the next launch would not tick is worse
                    // than a tap that appears to do nothing.
                    selected = choice.stored == selected,
                    onClick = { onPick(choice.stored) },
                )
                Text(
                    choice.sentence,
                    style = centraidType("small"),
                    color = centraidColor("text"),
                )
            }
        }
    }
}
