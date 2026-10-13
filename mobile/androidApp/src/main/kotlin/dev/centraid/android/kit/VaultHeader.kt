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
import centraid.screen.v1.BackupLine
import centraid.screen.v1.VaultLockup
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidDark
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry
import dev.centraid.design.copy.PhotosCopy
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.shell.Appearance
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
 * **"On this phone", never "synced" or "connected".** [VaultLockup.State.STATE_ONLINE]
 * says the vault is here and whole — the phone is the vault. "Connected"
 * would promise a live link this state has not checked, and "synced" claimed
 * a backup over a vault that was never paired (#1047 walk); what a gateway
 * holds is the backup's status to say (`BackupLine.status`, drawn in its place on Home, #1080).
 *
 * EXHAUSTIVE and with no `else`, deliberately: a case added to `State` must
 * fail to compile here rather than fall quietly into somebody else's sentence,
 * which is the failure this line is recovering from. `STATE_SYNCING` and
 * `STATE_OFFLINE` left with the pass they described (#1029 §1, W5); the case
 * that took their place is the FREEZE.
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
    VaultLockup.State.STATE_ONLINE -> PhotosCopy.VAULT_ONLINE
    // THE VAULT MOVED TO THE MEMBER'S OTHER PHONE (#1029 F1, W5). A STATE and
    // not an incident: it is drawn in place under the vault's name like the
    // other one, in the same mono line, because a banner would make a
    // deliberate hand-over look like a fault. The COUNT of what this phone is
    // still holding rides beside it in `VaultLockup.frozen_line`.
    VaultLockup.State.STATE_FROZEN -> PhotosCopy.VAULT_MOVED
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
 * One trailing verb, and only when there is something to say: Settings, the
 * door to the transfer rules, drawn beside the originals-waiting line. A key
 * with no destination is not drawn (DESIGN.md, HomeRoom).
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
    /**
     * THE VAULT'S BACKUP, said as the second line (R-ONBOARD-11):
     * `BackupLine.status` in place of "on this phone". Null — an example, or a
     * preview — keeps the vault's own state line. A vault that MOVED keeps its
     * own line too: that is the fact.
     */
    backup: BackupLine? = null,
    /** The status line's door: the Backup tab. */
    onOpenBackup: () -> Unit = {},
    /**
     * HOME'S SEARCH (R-CHROME-6): a framed key at the lockup's trailing edge,
     * the one way into search over every app but Locker. Null draws none.
     */
    onSearch: (() -> Unit)? = null,
    searchLabel: String = "",
    /** THE APPEARANCE KEY (R-CHROME-7), right of search: one tap flips light and dark. */
    onAppearance: (() -> Unit)? = null,
) {
    // No name is a REAL STATE; never render a blank lockup.
    val name = vault?.vault_name?.trim().orEmpty().ifEmpty { PhotosCopy.VAULT_NONE_YET }
    val line = stateLine(vault?.state ?: VaultLockup.State.STATE_UNSPECIFIED)
    val status = backup?.status.orEmpty().takeIf { vault?.state != VaultLockup.State.STATE_FROZEN }.orEmpty()
    val loud = backup?.tone == BackupLine.Tone.TONE_ATTENTION || backup?.tone == BackupLine.Tone.TONE_URGENT
    // THE MEMBER'S OWN RULE, SAID IN PLACE (#1025 S4, D-1025-S7-61). A grid of
    // thumbnails with no full-size files is a DECISION and not a failure, and a
    // header that says nothing is how a working byte plane looks broken. A
    // SECOND line beside the state and not a replacement: a device can be
    // perfectly current and still be waiting for Wi-Fi to bring the
    // photographs.
    val withheld = vault?.originals_withheld ?: 0
    val waiting = when {
        withheld <= 0 -> ""
        withheld == 1 -> PhotosCopy.TRANSFER_ORIGINAL_WAITING_ONE
        else -> PhotosCopy.TRANSFER_ORIGINAL_WAITING_MANY.replace("{count}", "$withheld")
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
                // The label REPLACES the lines for assistive tech, so a screen
                // reader hears one sentence rather than a name and an orphan
                // line. The backup status is a door of its own, below.
                .semantics(mergeDescendants = true) {
                    contentDescription =
                        listOf(name, if (status.isEmpty()) line else "", waiting).filter { it.isNotEmpty() }
                            .joinToString(", ") + ". Switch vault"
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
                                contentDescription = status + ". " + SharedCopy.BACKUP_STATUS_OPEN
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
                                        centraidColor(if (backup?.tone == BackupLine.Tone.TONE_URGENT) "danger" else "attention"),
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
                    label = "Download settings",
                    testTag = "home-transfer-rules",
                    onPress = onDownloadSettings,
                )
            }
            if (onSearch != null) {
                IconKey(iconKey = "Search", label = searchLabel, testTag = "home-search-open", onPress = onSearch)
            }
            if (onAppearance != null) {
                val key = Appearance.key(dark = centraidDark())
                IconKey(iconKey = key.iconKey, label = key.label, testTag = "home-appearance", onPress = onAppearance)
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
 *
 * A choice is a sheet of [SheetRow]s (#1015 D4); the chosen one is ticked.
 */
@Composable
public fun TransferRulesSheet(
    choices: List<TransferRuleChoice>,
    selected: String,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    SheetRoom(title = PhotosCopy.TRANSFER_TITLE, onDismiss = onDismiss) {
        Text(
            PhotosCopy.TRANSFER_SUBTITLE,
            style = centraidType("small"),
            color = centraidColor("textSoft"),
            modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp),
        )
        choices.forEach { choice ->
            SheetRow(
                label = choice.sentence,
                // THE SELECTION IS THE STORE'S ANSWER, not the tap: an
                // unknown word settles to the conservative default, and a
                // tick on a row the next launch would not tick is worse
                // than a tap that appears to do nothing.
                selected = choice.stored == selected,
                testTag = "transfer-rule-" + choice.stored,
                onTap = { onPick(choice.stored) },
            )
        }
    }
}
