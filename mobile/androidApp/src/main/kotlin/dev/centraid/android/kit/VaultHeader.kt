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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import centraid.core.v1.HomeBar
import centraid.core.v1.HomeTone
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidDark
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry

/**
 * THE TWO FACTS TRUE ON EVERY ROUTE: which vault, and how it stands
 * (#1020, wave A; v0 `screens/home/VaultHeader.tsx`).
 *
 * No greeting. **The mark IS the vault switch** — there is no chevron beside it,
 * because a lockup that is not pressable and a control that is are two
 * affordances for one act. The second line is mono and says where this vault
 * stands IN PLACE, never as a banner: none of those states is an incident.
 *
 * **EVERY WORD IS RUST'S** (#1135): the name, the mark's letter, the state line
 * ("On this phone", "Moved to your other phone"), the originals-waiting line, the
 * backup status, the keys' labels and what a screen reader says all arrive
 * finished in [HomeBar]. This file chooses ink, type and geometry and nothing else.
 *
 * One trailing verb, and only when there is something to say: Settings, the
 * door to the transfer rules, drawn beside the originals-waiting line. A key
 * with no destination is not drawn (DESIGN.md, HomeRoom).
 */
@Composable
public fun VaultHeader(
    bar: HomeBar,
    onSwitchVault: () -> Unit,
    modifier: Modifier = Modifier,
    /**
     * Open the transfer-rules sheet (#1025 S4). Defaulted so a preview and a
     * fixture render this header without one.
     */
    onDownloadSettings: () -> Unit = {},
    /** The status line's door: the Backup tab. */
    onOpenBackup: () -> Unit = {},
    /**
     * HOME'S SEARCH (R-CHROME-6): a framed key at the lockup's trailing edge,
     * the one way into search over every app. Null draws none.
     */
    onSearch: (() -> Unit)? = null,
    /** THE APPEARANCE KEY (R-CHROME-7), right of search: one tap flips light and dark. */
    onAppearance: (() -> Unit)? = null,
) {
    val vault = bar.vault
    val name = vault?.name.orEmpty()
    val line = vault?.state_line.orEmpty()
    // THE BACKUP'S STATUS stands in the line only for a vault that has not moved
    // (Rust drops the line for one that has).
    val backup = bar.backup
    val status = backup?.status.orEmpty()
    val loud = backup?.tone == HomeTone.HOME_TONE_ATTENTION || backup?.tone == HomeTone.HOME_TONE_URGENT
    // THE MEMBER'S OWN RULE, SAID IN PLACE (#1025 S4, D-1025-S7-61). A grid of
    // thumbnails with no full-size files is a DECISION and not a failure, and a
    // header that says nothing is how a working byte plane looks broken. A
    // SECOND line beside the state and not a replacement: a device can be
    // perfectly current and still be waiting for Wi-Fi to bring the
    // photographs.
    val waiting = vault?.originals_line.orEmpty()
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
                // The label REPLACES the lines for assistive tech, so a screen
                // reader hears one sentence rather than a name and an orphan
                // line. The backup status is a door of its own, below.
                .semantics(mergeDescendants = true) {
                    contentDescription = bar.switch_label
                },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                Modifier
                    .size(30.dp)
                    // The control rung from the token scale, not the chip
                    // ratio — that is for app marks.
                    .clip(RoundedCornerShape((LocalCentraidTokens.current.radii["md"] ?: 0).dp))
                    .background(hue.ground),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    vault?.initial.orEmpty(),
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
                if (status.isNotEmpty()) {
                    // THE BACKUP STATUS (R-ONBOARD-11): a dot in the tone's
                    // colour when it wants the member, then the few words, in
                    // the same mono line the state line was; the Backup tab's
                    // door (iOS `VaultHeader.statusLine`).
                    Row(
                        Modifier
                            .heightIn(min = 18.dp)
                            .clickable(onClick = onOpenBackup)
                            .testTag("home-backup-status")
                            .semantics(mergeDescendants = true) {
                                contentDescription = bar.backup_open_label
                            },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        if (loud) {
                            Box(
                                Modifier
                                    .size(6.dp)
                                    .clip(CircleShape)
                                    .background(
                                        centraidColor(if (backup?.tone == HomeTone.HOME_TONE_URGENT) "danger" else "attention"),
                                    ),
                            )
                        }
                        Text(
                            status,
                            style = centraidType("mono"),
                            color = centraidColor(if (loud) "text" else "textFaint"),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                } else if (line.isNotEmpty()) {
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
        // THE TRAILING KEYS AS ONE GROUP: their 44dp targets touch, so the
        // 36dp plates stand 8dp apart and read as a pair, not as two
        // strays across the lockup's 12dp rhythm. The last plate's edge sits
        // on the page margin: the target overhangs by its inset, (44 - 36) / 2.
        Row(Modifier.offset(x = 4.dp)) {
            // THE DOOR TO THE TRANSFER RULES (#1025 S4). Beside the line that
            // reports them rather than buried in settings: a member reads
            // "12 originals waiting for Wi-Fi" and the next thing they want is the
            // control that decided it.
            if (waiting.isNotEmpty()) {
                IconKey(
                    iconKey = "Settings",
                    label = bar.transfer_rules_label,
                    testTag = "home-transfer-rules",
                    onPress = onDownloadSettings,
                )
            }
            if (onSearch != null) {
                IconKey(iconKey = "Search", label = bar.search_label, testTag = "home-search-open", onPress = onSearch)
            }
            if (onAppearance != null) {
                IconKey(iconKey = bar.appearance_icon, label = bar.appearance_label, testTag = "home-appearance", onPress = onAppearance)
            }
        }
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
    val share = if (centraidDark()) {
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
