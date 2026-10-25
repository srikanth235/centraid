package dev.centraid.android.screens

import dev.centraid.android.kit.LocalShellLine
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import centraid.core.v1.Failure
import centraid.core.v1.HomeData
import centraid.core.v1.HomeEvent
import centraid.core.v1.HomeSpringboard
import centraid.core.v1.HomeState
import centraid.core.v1.HomeStatus
import centraid.core.v1.HomeTile
import centraid.core.v1.HomeTileBody
import centraid.core.v1.HomeTileStatus
import centraid.core.v1.HomeTone
import centraid.core.v1.HomeVault
import centraid.core.v1.HomeVaultAsk
import centraid.core.v1.HomeVaultSheet
import centraid.core.v1.HomeVaultState
import centraid.core.v1.Route
import centraid.core.v1.ShellBand
import centraid.core.v1.ShellBandTab
import centraid.screen.v1.Confirm
import dev.centraid.android.kit.AppMark
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.ContentImage
import dev.centraid.android.kit.HomeBand
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.VaultHeader
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidDark
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidCatalog
import dev.centraid.design.CentraidGeometry
// TRANSITIONAL (lane H2 deletes it with the Backup tab): the one place Home still
// words a place Rust does not own yet.
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.shell.HomeWords

/**
 * Home, the graded springboard (#1020, wave A; #1135).
 *
 * **THIS VIEW DECIDES NOTHING.** Home is a Rust screen (`crates/screens/src/shell`):
 * the `springboard`, `grid_rows`, every tile's count, noun, spoken label and route,
 * the lockup's words, the switcher's sentences and the band all arrive finished in
 * [HomeState] and `Navigation.band`. That is what lets this file and
 * `HomeView.swift` draw the same Home: not discipline, but the absence of anywhere
 * for the two to disagree. A tap that opens a page sends the route the view carried
 * ([onOpen]); this file names no destination.
 *
 * **THREE BRANCHES, NEVER TWO**, as on every other screen — and the third one
 * matters more here than anywhere else. A Home that could not load renders a
 * sentence; it does not render an empty springboard, which would be eight empty
 * apps invented out of one failure.
 *
 * **EVERY VALUE HERE IS A TOKEN OR A STATED GEOMETRY.** The card's ground, its
 * one hairline, the tile floor, the mosaic's bleed and every type rung come from
 * the emitted table or from the constants below, which carry v0's own names and
 * reasons — the two shells were drawn from one `packages/design`, and a number
 * typed into a view is a number nobody chose.
 */
@Composable
public fun HomeScreen(
    state: HomeState,
    /** The band Rust framed this root with, or null before it says. */
    band: ShellBand?,
    /** The runtime's tabs: a band place in this set is selected by Rust, any other is hosted natively. */
    runtimeTabs: Set<String>,
    onEvent: (HomeEvent) -> Unit,
    /** Push a route a row or the search key carried. */
    onOpen: (Route) -> Unit,
    /** A press on a band place Rust owns: the runtime selects the tab. */
    onSelectTab: (String) -> Unit,
    /**
     * Open the transfer-rules sheet (#1025 S4). Defaulted so a preview renders
     * this screen without one.
     */
    onDownloadSettings: () -> Unit = {},
    // TRANSITIONAL (lane H2 registers a Rust `backup` tab and deletes these four):
    // the Backup tab is still hosted natively, drawn in place of the springboard.
    /** Open the native Backup tab. */
    onOpenBackup: () -> Unit = {},
    /** Whether the native Backup tab is drawn in place of the springboard. */
    backupShown: Boolean = false,
    /** The band's Home, pressed on the Backup tab. */
    onOpenHome: () -> Unit = {},
    /** The Backup tab's screen; Rust's `backup.home` is pushed as a page now, so Home passes none. */
    backupTab: @Composable () -> Unit = {},
) {
    // BACK ON THE BACKUP TAB returns to Home, as the band's Home does.
    BackHandler(enabled = backupShown) { onOpenHome() }
    val bar = state.bar
    val failure = state.failure
    // BARE PAPER UNTIL THE LOCKUP LANDS. The shelf says it holds a vault a
    // moment before the session tells Home that vault, and Home drawn in that
    // moment said "No vault yet" for a frame between first launch and the
    // springboard — a flicker. A shelf that holds a vault always has one
    // in front, so the empty lockup is only ever that moment (and a phone that
    // holds none is a failure, below).
    if (bar?.vault?.vault_id.isNullOrEmpty() && failure == null) {
        Box(Modifier.fillMaxSize().background(centraidColor("bg")))
        return
    }
    // THE BACKUP LINE'S DOOR: the runtime's tab once Rust owns it, the native one until then.
    val hasBackupTab = "backup" in runtimeTabs
    val openBackup = {
        if (hasBackupTab) onEvent(HomeEvent(backup = HomeEvent.BackupPressed())) else onOpenBackup()
    }
    val search: () -> Unit = { bar?.search_route?.let(onOpen) }
    val appearance: () -> Unit = { onEvent(HomeEvent(appearance = HomeEvent.AppearancePressed())) }
    Column(
        Modifier
            .fillMaxSize()
            .background(centraidColor("bg")),
    ) {
        // THE LOCKUP FIRST, ALWAYS. It is chrome for every route, and it is
        // drawn above the three-branch switch on purpose: a Home that failed to
        // read still has to say which vault failed.
        if (bar != null) {
            VaultHeader(
                bar = bar,
                onSwitchVault = { onEvent(HomeEvent(vault = HomeEvent.VaultPressed())) },
                onDownloadSettings = onDownloadSettings,
                // THE LOCKUP'S SECOND LINE IS THE BACKUP'S STATUS (R-ONBOARD-11),
                // and its door. Nothing between it and the grid: no backup
                // sentence, no "Home" title (the band says where the member is),
                // no settings gear.
                onOpenBackup = openBackup,
                // HOME'S SEARCH KEY (R-CHROME-6), at the lockup's trailing edge;
                // a tap pushes the search over every app. Not on the
                // Backup tab, which is the backup's and not the springboard's.
                onSearch = search.takeIf { !backupShown },
                onAppearance = appearance.takeIf { !backupShown },
            )
        }
        // THE BACKUP TAB DRAWS IN PLACE OF THE SPRINGBOARD, as Chat does on
        // iOS, under the vault's lockup: the backup it describes is that
        // vault's, and the band stays where it is.
        if (backupShown) {
            Box(Modifier.weight(1f)) { backupTab() }
            LocalShellLine.current?.invoke()
            Band(band, runtimeTabs, backupShown, onOpenBackup, onOpenHome, onSelectTab)
            return@Column
        }
        StatusRibbon(state.status, onEvent, hasBackupTab, onOpenBackup)
        val data = state.data_
        // THE PAGE TAKES THE SLACK, THE BAND TAKES ITS OWN HEIGHT. The band is
        // never scrolled away, so it is a sibling of the scrolling page and not
        // a part of it, and nothing subtracts its height from the page because
        // it is a flex peer.
        Box(Modifier.weight(1f)) {
            when {
                failure != null -> FailureBody(failure)
                data == null -> SpringboardGrid(HomeData(), state.loading_label, onOpen)
                data.springboard == HomeSpringboard.HOME_SPRINGBOARD_FIRST_RUN ->
                    DayOne(data, state.loading_label, onOpen)
                else -> SpringboardGrid(data, state.loading_label, onOpen)
            }
        }
        // THE IMPORT'S LINE, on the band (DESIGN.md's one status line).
        LocalShellLine.current?.invoke()
        Band(band, runtimeTabs, backupShown, onOpenBackup, onOpenHome, onSelectTab)
    }
    // THE SWITCHER IS A SHEET and never a destination. It is a sibling of the
    // column above rather than a child of it, because a sheet inside a
    // scrolling page would scroll.
    val sheet = state.sheet
    if (sheet != null) VaultSheet(sheet, onEvent)
}

/**
 * THE BAND, Rust's places and (until lane H2 registers a Rust `backup` tab) the
 * native Backup place beside them. A press on a place the runtime holds selects
 * that tab; the Home place pressed on the native Backup tab returns to Home.
 */
@Composable
internal fun Band(
    band: ShellBand?,
    runtimeTabs: Set<String>,
    backupShown: Boolean,
    onOpenBackup: () -> Unit,
    onOpenHome: () -> Unit,
    onSelectTab: (String) -> Unit,
) {
    val rust = band?.tabs.orEmpty().map { tab ->
        // The native Backup tab has the lit place while it is drawn.
        if (backupShown && tab.selected) tab.copy(selected = false, spoken = tab.label) else tab
    }
    val native = if (rust.any { it.tab == "backup" }) {
        emptyList()
    } else {
        listOf(
            ShellBandTab(
                tab = "backup",
                label = HomeWords.BAND_BACKUP,
                spoken = HomeWords.BAND_BACKUP_SPOKEN +
                    if (backupShown) ", " + SharedCopy.BAND_CURRENT_SPOKEN else "",
                icon_key = "Backup",
                selected = backupShown,
            ),
        )
    }
    HomeBand(
        tabs = rust + native,
        onSelect = { tab ->
            when {
                tab == "home" && backupShown -> onOpenHome()
                tab in runtimeTabs -> onSelectTab(tab)
                tab == "backup" -> onOpenBackup()
            }
        },
    )
}

/**
 * THE VAULT SWITCHER (#1020, wave A).
 *
 * It lists EVERY vault the device holds, the open one included and ticked. A
 * switcher that listed only the others would never show a member where they
 * already are, which is the fact most of them opened it to check.
 *
 * Dismissing sends `sheet_closed`, which shuts the sheet and changes no vault.
 * Every sentence, the roster's order and each row's second line (the header's own
 * wording, finished by Rust) arrive in [HomeVaultSheet].
 *
 * **EVERY ROW CAN BE FORGOTTEN.** Forgetting DELETES the vault: the file, its
 * byte store and its sidecars. That is why it is one tap behind a dialog that
 * NAMES the vault rather than a bare icon — a destructive act that a mis-hit
 * thumb can complete is a destructive act that will be completed by mis-hit
 * thumbs. The question is Rust's (`sheet.ask`); this draws it.
 */
@Composable
private fun VaultSheet(sheet: HomeVaultSheet, onEvent: (HomeEvent) -> Unit) {
    SheetRoom(
        title = sheet.title,
        onDismiss = { onEvent(HomeEvent(sheet_closed = HomeEvent.SheetClosed())) },
    ) {
        Column(Modifier.fillMaxWidth().testTag("home-vault-sheet")) {
            // ZERO VAULTS NEVER REACHES THIS SHEET: a device that holds none
            // opens onto `FirstLaunchScreen` instead of Home (`MainActivity`),
            // which is where "make" and "restore" live now.
            if (sheet.one_line.isNotEmpty()) {
                Text(
                    text = sheet.one_line,
                    style = centraidType("small"),
                    color = centraidColor("textSoft"),
                    modifier = Modifier.padding(horizontal = PAGE_MARGIN),
                )
            }
            for (vault in sheet.vaults) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onEvent(HomeEvent(vault_picked = HomeEvent.VaultPicked(vault_id = vault.vault_id))) }
                        .heightIn(min = 48.dp)
                        .padding(horizontal = PAGE_MARGIN)
                        .testTag("vault-row-${vault.vault_id}"),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        text = vault.initial,
                        style = centraidType("smallStrong"),
                        color = centraidColor("text"),
                        modifier = Modifier
                            .size(30.dp)
                            .clip(controlShape())
                            .background(centraidColor("bgSunken"))
                            .padding(top = 6.dp),
                    )
                    Column(Modifier.weight(1f)) {
                        Text(
                            text = vault.name,
                            style = centraidType("smallStrong"),
                            color = centraidColor("text"),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        // The same sentence the lockup draws: Rust words one
                        // state once. An empty line draws nothing, so the row is
                        // a name alone rather than a name over a blank caption.
                        if (vault.state_line.isNotEmpty()) {
                            Text(
                                text = vault.state_line,
                                style = centraidType("mono"),
                                color = centraidColor("textFaint"),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    // THE TICK IS THE WHOLE POINT of listing the open one.
                    if (vault.vault_id == sheet.active_vault_id) {
                        CentraidIcon(
                            iconKey = "Check",
                            tint = centraidColor("link"),
                            size = 18.dp,
                            modifier = Modifier.semantics { contentDescription = sheet.current_label },
                        )
                    }
                    // RENAME, beside Forget and with its own target for the
                    // same reason. A vault that moved is read-only: no rename.
                    if (vault.state != HomeVaultState.HOME_VAULT_STATE_FROZEN) {
                        IconKey(
                            iconKey = "Pencil",
                            label = sheet.rename_label,
                            testTag = "vault-rename-${vault.vault_id}",
                            bordered = false,
                        ) { onEvent(HomeEvent(rename_asked = HomeEvent.RenameAsked(vault_id = vault.vault_id))) }
                    }
                    // OUTSIDE the row's own `clickable`, with its own 44dp
                    // target: a forget that shared the row's tap area would be
                    // a switch and a deletion behind one gesture.
                    IconKey(
                        iconKey = "Trash",
                        label = vault.accessibility_label.let { "${sheet.forget_label} $it" },
                        testTag = "vault-forget-${vault.vault_id}",
                        bordered = false,
                    ) { onEvent(HomeEvent(forget_asked = HomeEvent.ForgetAsked(vault_id = vault.vault_id))) }
                }
            }
            // MAKING AND RESTORING A VAULT LIVE HERE (R-ONBOARD-11): this is
            // the sheet about the vaults this phone holds, and Home has no
            // settings gear to hide them behind.
            Box(
                Modifier
                    .padding(horizontal = PAGE_MARGIN, vertical = 8.dp)
                    .fillMaxWidth()
                    .height(CentraidGeometry.HAIRLINE.dp)
                    .background(centraidColor("line")),
            )
            SwitcherAction(sheet.make_label, "Plus", "vault-found-button") {
                onEvent(HomeEvent(make = HomeEvent.MakePressed()))
            }
            SwitcherAction(sheet.restore_label, "Refresh", "vault-restore-button") {
                onEvent(HomeEvent(restore = HomeEvent.RestorePressed()))
            }
            if (sheet.status_line.isNotEmpty()) {
                Text(
                    sheet.status_line,
                    style = centraidType("small"),
                    color = centraidColor("textSoft"),
                    modifier = Modifier.padding(horizontal = PAGE_MARGIN, vertical = 8.dp).testTag("vault-status"),
                )
            }
        }
    }
    val ask = sheet.ask
    val rename = ask?.rename
    if (rename != null) RenameSheet(rename, onEvent)
    val forget = ask?.forget
    if (forget != null) {
        // IT NAMES THE VAULT. A confirmation that says "this vault" in a
        // sheet listing several is a confirmation that confirms nothing.
        ConfirmSheet(
            confirm = Confirm(
                title = forget.title,
                body = forget.body,
                confirm_label = forget.confirm_label,
                destructive = true,
            ),
            // Rust shuts the sheet and asks the shelf; nothing here sequences it.
            onConfirm = { onEvent(HomeEvent(ask_confirmed = HomeEvent.AskConfirmed())) },
            onDismiss = { onEvent(HomeEvent(ask_dismissed = HomeEvent.AskDismissed())) },
            cancelLabel = forget.cancel_label,
            confirmTag = "vault-forget-confirm",
        )
    }
}

/** The rename step: the field starts on the vault's own name, so a small fix is a small edit. */
@Composable
private fun RenameSheet(rename: HomeVaultAsk.Rename, onEvent: (HomeEvent) -> Unit) {
    // THE TEXT IS HELD HERE WHILE THE IME HAS IT and reported on every change:
    // a field that took its value from the round trip would jump its cursor.
    var typed by remember(rename.vault_id) { mutableStateOf(rename.name) }
    SheetRoom(
        title = rename.title,
        onDismiss = { onEvent(HomeEvent(ask_dismissed = HomeEvent.AskDismissed())) },
        // A BLANK NAME IS NOT A RENAME: the one act is drawn, but cannot be
        // pressed until there is a name to save (Rust says so in `can_save`).
        primary = SheetPrimary(
            label = rename.save_label,
            testTag = "vault-rename-save",
            enabled = rename.can_save,
        ) { onEvent(HomeEvent(ask_confirmed = HomeEvent.AskConfirmed())) },
    ) {
        androidx.compose.material3.OutlinedTextField(
            value = typed,
            onValueChange = {
                typed = it
                onEvent(HomeEvent(rename_typed = HomeEvent.RenameTyped(name = it)))
            },
            label = { Text(rename.field_label) },
            singleLine = true,
            modifier = Modifier
                .fillMaxWidth()
                .imePadding()
                .padding(horizontal = PAGE_MARGIN)
                .testTag("vault-rename-field"),
        )
        if (rename.failure.isNotEmpty()) {
            Text(
                rename.failure,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                modifier = Modifier.padding(horizontal = PAGE_MARGIN, vertical = 8.dp),
            )
        }
    }
}

/** The control rung from the token scale (`radii.md`), never a typed number. */
@Composable
private fun controlShape() = RoundedCornerShape((LocalCentraidTokens.current.radii["md"] ?: 0).dp)

/** One of the switcher's two acts: a mark and a label, a full-width row. */
@Composable
private fun SwitcherAction(label: String, iconKey: String, testTag: String, onPress: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onPress)
            .heightIn(min = 48.dp)
            .padding(horizontal = PAGE_MARGIN)
            .testTag(testTag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier
                .size(30.dp)
                .border(CentraidGeometry.HAIRLINE.dp, centraidColor("lineStrong"), controlShape()),
            contentAlignment = Alignment.Center,
        ) {
            CentraidIcon(iconKey = iconKey, tint = centraidColor("text"), size = 18.dp)
        }
        Text(label, style = centraidType("smallStrong"), color = centraidColor("text"))
    }
}

/**
 * The vault at a glance, and how it stands on this device.
 *
 * The ONLY feedback channel on this screen — no spinner, no toast, no badge, no
 * red dot. `QUIET` is deliberately ignorable and earns no rule; the other two
 * earn one rule and one action, never a filled warning plate. Its action is a
 * door: a press sends `status` and Rust says where it goes.
 */
@Composable
private fun StatusRibbon(
    status: HomeStatus?,
    onEvent: (HomeEvent) -> Unit,
    hasBackupTab: Boolean,
    onOpenBackup: () -> Unit,
) {
    // A RIBBON WITH NOTHING TO SAY IS NOT DRAWN: since All apps left it
    // (R-ONBOARD-11) it carries nothing else, and an empty band above the grid
    // reads as something that failed to render.
    if (status == null || (status.copy.isEmpty() && status.action.isEmpty())) return
    val loud = status.tone != HomeTone.HOME_TONE_QUIET
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = if (loud) 40.dp else 32.dp)
            .clickable(enabled = status.action.isNotEmpty()) {
                // UNTIL RUST REGISTERS A BACKUP TAB the native place is the only door.
                if (status.destination == HomeStatus.Destination.DESTINATION_BACKUP && !hasBackupTab) {
                    onOpenBackup()
                } else {
                    onEvent(HomeEvent(status = HomeEvent.StatusPressed()))
                }
            }
            .padding(horizontal = PAGE_MARGIN)
            .testTag("home-status")
            .semantics {
                contentDescription = status.accessibility_label
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (loud) {
            // ONE RULE in the tone's colour, and nothing else. A filled plate
            // behind a sentence is a second chrome.
            Box(
                Modifier
                    .width(2.dp)
                    .height(24.dp)
                    .background(
                        if (status.tone == HomeTone.HOME_TONE_URGENT) {
                            centraidColor("danger")
                        } else {
                            centraidColor("attention")
                        },
                    ),
            )
        }
        Text(
            text = status.copy,
            style = centraidType(if (loud) "small" else "mono"),
            color = if (loud) centraidColor("text") else centraidColor("textFaint"),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (status.action.isNotEmpty()) {
            Text(
                text = status.action,
                style = centraidType("control"),
                color = centraidColor("link"),
                textDecoration = TextDecoration.Underline,
            )
        }
    }
}

/**
 * A Home that could not load at all.
 *
 * Distinct from every tile being unreadable: that Home loaded and could not read
 * its apps, and still shows them. This one has no grid, because inventing eight
 * empty apps out of one failure is the defect the read law forbids.
 */
@Composable
private fun FailureBody(failure: Failure) {
    Column(
        Modifier
            .padding(PAGE_MARGIN)
            .testTag("home-failure"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(failure.sentence, style = centraidType("small"), color = centraidColor("text"))
        // Present only when there is something a member can do.
        if (failure.remedy.isNotEmpty()) {
            Text(
                failure.remedy,
                style = centraidType("mono"),
                color = centraidColor("textFaint"),
            )
        }
    }
}

// ── the grid's stated geometry, with v0's names and v0's reasons ───────────

/** `R.margin.m` — the phone's page margin, emitted beside the tokens. */
private val PAGE_MARGIN = CentraidGeometry.PAGE_MARGIN.dp

/** A FLOOR, never a height: a fixed height slices bodies at 150% text. */
private val TILE_MIN_HEIGHT = 152.dp

/** `R.gap.m`. The mosaic's bleed cancels exactly this, which is why it is one name. */
private val TILE_PAD = 12.dp

/** The gutter between slots — v0's two 4pt half-gutters, added up. */
private val TILE_GAP = 8.dp

/** The container rung. */
private val TILE_RADIUS = 12.dp

/** The one sub-control rung, for a detail nested inside a control. */
private val SUB_RADIUS = 4.dp

/** The control rung. */
private val CONTROL_RADIUS = 7.dp

/** One row, fixed count — only the cell CONTENTS change, never the count. */
private const val MOSAIC_SLOTS = 4

/**
 * A FLOOR AND NOT A HEIGHT. `mosaicCss` is `flex:1;min-height:0` over
 * `grid-auto-rows:1fr`, so the strip STRETCHES into whatever the card's 152
 * floor leaves over and this is only the rung below which it will not go. It is
 * STATED rather than derived for the reason it always was: a percentage-width
 * cell has no intrinsic height of its own and can resolve to zero.
 */
private val MOSAIC_CELL_HEIGHT = 88.dp

private val HAIRLINE = CentraidGeometry.HAIRLINE.dp

/**
 * THE HUE KEY'S SPELLING IN THE EMITTED TABLE, and nothing more.
 *
 * Rust (`crates/screens/src/shell/tiles.rs`) decides WHICH of the eight a face gets and puts
 * the answer on the wire; this is the eight-row spelling that turns that key
 * into a `NativeTheme` role, and `HomeView.swift` carries the same eight. It is
 * a map and not `"c" + key.replaceFirstChar(…)` because the string form would
 * hand any key at all to `centraidColor`, which fails loudly and correctly for
 * a role that does not exist — the wrong failure for a launcher tile drawing
 * whatever a producer sent. `PartyHueWheelSpec` asserts every key here has a
 * role in `NATIVE_COLOR_ROLES` and that both view trees name all eight.
 */
private val PARTY_HUE_ROLES: Map<String, String> = mapOf(
    "rose" to "cRose",
    "amber" to "cAmber",
    "ochre" to "cOchre",
    "forest" to "cForest",
    "teal" to "cTeal",
    "slate" to "cSlate",
    "indigo" to "cIndigo",
    "violet" to "cViolet",
)

/**
 * A NEGATIVE MARGIN, which Compose has no token for.
 *
 * The mosaic bleeds to the card's edge, so it must be [amount] wider than its
 * parent's content box on each side and shifted left by the same. Compose
 * refuses negative padding, so the child is measured against widened
 * constraints and placed at the offset — the standard idiom, spelled once here
 * rather than at the call site.
 *
 * [toFloor] is the THIRD margin of the same rule — `mosaicCss` is
 * `margin: R.gap.s -R.gap.m -R.gap.m`, so the strip cancels the card's bottom
 * padding exactly as it cancels its sides. Downward there is nothing to
 * offset: the child is measured [amount] TALLER than the slot it was given and
 * the slot is reported back unchanged, so it draws past its own bottom and the
 * card's `clip` is what shapes it. The reference drops this half in the
 * waiting state (`grey ? '0' : '-' + R.gap.m`) because the sentence under the
 * strip needs the 12 back, and a line of type bled past the card's edge is
 * clipped rather than merely tight.
 */
private fun Modifier.bleed(amount: Dp, toFloor: Boolean): Modifier = this
    .layout { measurable, constraints ->
        val extra = amount.roundToPx() * 2
        val down = if (toFloor) amount.roundToPx() else 0
        val widened = constraints.copy(
            maxWidth = constraints.maxWidth + extra,
            minWidth = (constraints.minWidth + extra).coerceAtMost(constraints.maxWidth + extra),
            maxHeight = if (constraints.maxHeight == Constraints.Infinity) {
                constraints.maxHeight
            } else {
                constraints.maxHeight + down
            },
            minHeight = if (constraints.minHeight == 0) 0 else constraints.minHeight + down,
        )
        val placeable = measurable.measure(widened)
        layout(placeable.width, (placeable.height - down).coerceAtLeast(0)) {
            placeable.place(0, 0)
        }
    }
    .offset(x = -amount)

@Composable
private fun SpringboardGrid(data: HomeData, loading: String, onOpen: (Route) -> Unit) {
    // WHICH tiles are drawn and in WHICH rows both arrive decided: `grid_rows`
    // is the machine's packing over every tile, so this
    // file looks each id up and draws it. Nothing here is allowed to disagree
    // with `HomeView.swift`, because neither of them chooses.
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = PAGE_MARGIN)
            .padding(top = 10.dp, bottom = 24.dp),
    ) {
        TileGrid(data, loading, onOpen)
    }
}

/**
 * EVERY APP IS A TILE (R-ONBOARD-11), in the rows the machine packed: an app
 * with nothing in it draws what to do, so Docs, Agenda and People are
 * always here to open. Shared by the springboard and day one.
 */
@Composable
private fun TileGrid(data: HomeData, loading: String, onOpen: (Route) -> Unit) {
    val byId = data.tiles.associateBy { it.app_id }
    Column(
        Modifier.fillMaxWidth().testTag("home-grid"),
        verticalArrangement = Arrangement.spacedBy(TILE_GAP),
    ) {
        for (row in data.grid_rows) {
            val tiles = row.app_ids.mapNotNull { byId[it] }
            if (tiles.isEmpty()) continue
            Row(horizontalArrangement = Arrangement.spacedBy(TILE_GAP)) {
                for (tile in tiles) {
                    TileCard(tile, Modifier.weight(1f), loading, onOpen)
                }
                // A lone small keeps its column rather than stretching over
                // both: a tile that changed width with its neighbours'
                // arrival would be layout overruling the body rule that
                // chose its size.
                if (tiles.size == 1 && !tiles[0].wide) Spacer(Modifier.weight(1f))
            }
        }
    }
}

/**
 * One tile: THE HEADER IS INVARIANT — icon chip, name, count, in that order.
 *
 * It is what makes eight unlike bodies read as one grid. Home itself takes no
 * identity hue; the hue belongs to the app a tile previews, and it appears on
 * the chip alone.
 */
@Composable
private fun TileCard(tile: HomeTile, modifier: Modifier, loading: String, onOpen: (Route) -> Unit) {
    val name = tile.name
    val count = countText(tile)
    // The em dash is a glyph; a screen reader gets `accessibility_label`.
    Column(
        modifier
            .heightIn(min = TILE_MIN_HEIGHT)
            .clip(RoundedCornerShape(TILE_RADIUS))
            .background(centraidColor("bgElev"))
            .border(HAIRLINE, centraidColor("line"), RoundedCornerShape(TILE_RADIUS))
            // WHERE A TAP GOES is the tile's own route; Kotlin names no destination.
            // A TILE WITH NO ROUTE (it is still reading, or could not be) is not a control.
            .clickable(enabled = tile.route != null) { tile.route?.let(onOpen) }
            .padding(TILE_PAD)
            // Keyed on the app id. The label carries the live count, so it
            // changes with the vault; the id does not.
            .testTag("home-tile-${tile.app_id}")
            .semantics { contentDescription = tile.accessibility_label },
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            AppMark(appId = tile.app_id, size = 22.dp)
            Text(
                name,
                style = centraidType("smallStrong"),
                color = centraidColor("text"),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(count, style = centraidType("mono"), color = centraidColor("textFaint"))
        }
        TileBodyView(tile, loading)
    }
}

/**
 * A count a read ACTUALLY RETURNED, or the withheld glyph.
 *
 * The em dash is the honest half: Locker withholds its count by design, and a
 * `0` there would be a lie about how many secrets a member holds. A capped count
 * says `N+` rather than printing its ceiling as a fact.
 */
private fun countText(tile: HomeTile): String {
    val count = tile.count ?: return "—"
    return if (count.capped) "${count.value_}+" else "${count.value_}"
}

@Composable
private fun ColumnScope.TileBodyView(tile: HomeTile, loading: String) {
    val body = tile.body
    // Locker's body is a STATE and not a query result, and Photos draws its own
    // waiting state cell by cell — neither falls through to the generic skeleton
    // or to the invitation, because for both of them the generic answer is
    // wrong rather than merely plain.
    when {
        body?.locker != null || body?.photos != null -> FilledBody(body)
        tile.status == HomeTileStatus.HOME_TILE_STATUS_LOADING -> Skeleton(body, loading)
        tile.status != HomeTileStatus.HOME_TILE_STATUS_CONTENT -> Text(
            // What to DO, never what is missing. A quiet tile is an invitation.
            tile.empty_copy,
            style = centraidType("control"),
            color = centraidColor("textFaint"),
            modifier = Modifier.weight(1f, fill = true),
        )
        body != null -> FilledBody(body)
    }
}

/**
 * NOTES' SHELF (`HomeNotesTile`): the notebooks holding notes in soft ink, each
 * with its count, and the newest note's title alone at the foot. A vault with
 * nothing filed draws its newest notes instead, and no foot — the first of them
 * IS the newest. Quiet on purpose: two inks and air, every line one line.
 * Matches SwiftUI's `NotesShelf`, which says why.
 */
@Composable
private fun NotesShelf(notes: HomeTileBody.Notes, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (notes.notebooks.isEmpty()) {
            notes.recent.forEach { note ->
                Text(
                    note.title,
                    style = centraidType("small"),
                    color = centraidColor("text"),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            return@Column
        }
        notes.notebooks.forEach { notebook ->
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    notebook.name,
                    style = centraidType("small"),
                    color = centraidColor("textSoft"),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    notebook.note_count.toString(),
                    style = centraidType("mono"),
                    color = centraidColor("textFaint"),
                )
            }
        }
        // Pinned to the foot: the shelf leaves its slack above.
        Spacer(Modifier.weight(1f))
        Text(
            notes.title,
            style = centraidType("smallStrong"),
            color = centraidColor("text"),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun ColumnScope.FilledBody(body: HomeTileBody) {
    val column = Modifier.weight(1f, fill = true).fillMaxWidth()
    val photos = body.photos
    val docs = body.docs
    val notes = body.notes
    val agenda = body.agenda
    val people = body.people
    val locker = body.locker
    val spent = body.money
    val health = body.health
    when {
        photos != null -> {
            val cells = photos.cells
            // `thumbnail_path` is OPTIONAL in the schema, and absent is not
            // the same as empty: absent means the asset exists and its bytes
            // are not addressable on this device yet.
            val waiting = cells.isNotEmpty() && cells.all { it.thumbnail_path.isNullOrEmpty() }
            Column(column, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        // NO TOP OF ITS OWN. `mosaicCss`'s `R.gap.s` is not an
                        // extra 8 — it is the half this tile does not otherwise
                        // get. Every other body is wrapped in `bodyWrapCss`
                        // (`padding-top: R.gap.s`); the mosaic is a DIRECT
                        // child of the tile wrap. Both therefore read 16 under
                        // the head, and our `spacedBy(16.dp)` already spends
                        // both halves at once. Matches SwiftUI's `PhotoMosaic`.
                        // THE STRIP IS THE CARD'S SLACK-TAKER (`mosaicCss` is
                        // `flex:1;min-height:0`), and this is the weight that
                        // says so: whatever the card's 152 floor leaves over
                        // after the head goes to the photographs, never to a
                        // band of card ground beneath them.
                        .weight(1f)
                        // The CELLS are the mosaic: no ground, no min height.
                        // The bleed cancels `TILE_PAD` on the sides AND on the
                        // floor, so the strip is flush with the card's edge.
                        .bleed(TILE_PAD, toFloor = !waiting),
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    repeat(MOSAIC_SLOTS) { index ->
                        val cell = cells.getOrNull(index)
                        Box(
                            Modifier
                                .weight(1f)
                                // A FLOOR, NEVER A HEIGHT: the strip stretches
                                // (`grid-auto-rows:1fr`) and 88 is only the
                                // rung below which a cell will not go — which
                                // it needs, because a percentage-width cell has
                                // no intrinsic height and can resolve to zero.
                                .heightIn(min = MOSAIC_CELL_HEIGHT)
                                .fillMaxHeight()
                                // THE GROUND UNDER THE PHOTOGRAPH, and the whole
                                // cell when there is none. A cell with no
                                // addressable bytes is STILL A CELL: dropping it
                                // reflows ten photographs as one blank under a
                                // "10", and keeping the slot is what stops the
                                // mosaic reflowing as thumbnails land.
                                .background(
                                    centraidColor(if (cell == null) "skel" else "bgSunken"),
                                ),
                        ) {
                            val path = cell?.thumbnail_path
                            if (!path.isNullOrEmpty()) {
                                ContentImage(path)
                            }
                        }
                    }
                }
                // Grey squares with no explanation read as a failed render.
                if (waiting && photos.absent_line.isNotEmpty()) {
                    // IT DOES NOT NAME THE GATEWAY any more, and did before:
                    // with the byte door built, a vault placed on the device
                    // holds its own photographs, and "these fill in when it is
                    // back" was a sentence about a connection that is not the
                    // reason. What is true in every case is that the bytes are
                    // not here yet.
                    Text(
                        photos.absent_line,
                        style = centraidType("mono"),
                        color = centraidColor("textFaint"),
                    )
                }
            }
        }

        docs != null -> Column(column) {
            // RULED ROWS — Docs is a file list, and the rule is what says so.
            docs.rows.forEachIndexed { index, row ->
                if (index > 0) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(HAIRLINE)
                            .background(centraidColor("line")),
                    )
                }
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        row.name,
                        style = centraidType("small"),
                        color = centraidColor("text"),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    // No recorded size renders NOTHING, never a zero.
                    if (row.size.isNotEmpty()) {
                        Text(
                            row.size,
                            style = centraidType("mono"),
                            color = centraidColor("textFaint"),
                        )
                    }
                }
            }
        }

        notes != null -> NotesShelf(notes, column)

        agenda != null -> Column(column, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (agenda.at.isNotEmpty()) {
                Text(agenda.at, style = centraidType("mono"), color = centraidColor("textSoft"))
            }
            Text(
                agenda.title,
                style = centraidType("smallStrong"),
                color = centraidColor("text"),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            // Pinned to the foot: the sparse tiles leave their slack above.
            Spacer(Modifier.weight(1f))
            // TODAY'S DUE TASKS (#1128): the machine's words, drawn after a round
            // mark. INK, never the app's hue — a hue-filled circle is a second identity.
            if (agenda.due_count > 0) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Box(
                        Modifier
                            .size(13.dp)
                            .clip(CircleShape)
                            .border(HAIRLINE, centraidColor("lineStrong"), CircleShape),
                    )
                    Text(
                        agenda.due_label,
                        style = centraidType("small"),
                        color = centraidColor("text"),
                        maxLines = 1,
                    )
                    Text(
                        agenda.due_title,
                        style = centraidType("small"),
                        color = centraidColor("textFaint"),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
            if (agenda.after.isNotEmpty()) {
                Text(
                    agenda.after,
                    style = centraidType("small"),
                    color = centraidColor("textFaint"),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        people != null -> Column(column, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy((-7).dp),
            ) {
                // SATURATED discs, overlapping by a LOGICAL inset so the stack
                // mirrors under RTL rather than stacking the wrong way.
                people.faces.forEach { face ->
                    // THE PARTY'S OWN HUE, not a grey disc. `face.color` is the
                    // key Rust already resolved with the one port of the
                    // identity wheel; all this does is spell the emitted role.
                    // An unrecognised key draws the neutral disc rather than
                    // reaching `centraidColor`, which fails LOUDLY by design —
                    // a tile is not the place to take a shell down over a hue.
                    val hue = face.color?.let { PARTY_HUE_ROLES[it] }
                    Box(
                        Modifier
                            .size(30.dp)
                            .clip(RoundedCornerShape((LocalCentraidTokens.current.radii["pill"] ?: 0).dp))
                            .background(centraidColor(hue ?: "bgSunken"))
                            .border(1.5.dp, centraidColor("bgElev"), RoundedCornerShape((LocalCentraidTokens.current.radii["pill"] ?: 0).dp)),
                        contentAlignment = Alignment.Center,
                    ) {
                        // THE INITIALS STAY INSIDE THEIR OWN DISC (iOS's
                        // `HomeView` twin): inset by the 7dp the next disc
                        // covers ON BOTH SIDES, one line, shrunk to fit — two
                        // letters at their natural width ran under the next
                        // disc and read as one word ("GRMACO").
                        val initialsStyle = centraidType("smallStrong")
                        androidx.compose.foundation.text.BasicText(
                            face.initials,
                            // `textInv` is the SOLVED foreground for a filled
                            // identity disc (`DESIGN.md`'s rule 7 — `onAccent`
                            // in the hand-off's role map). Ink on a saturated
                            // fill is the contrast failure this tile had.
                            style = initialsStyle.copy(
                                color = centraidColor(if (hue != null) "textInv" else "text"),
                                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                            ),
                            maxLines = 1,
                            softWrap = false,
                            autoSize = androidx.compose.foundation.text.TextAutoSize.StepBased(
                                minFontSize = initialsStyle.fontSize * 0.5f,
                                maxFontSize = initialsStyle.fontSize,
                            ),
                            modifier = Modifier.padding(horizontal = 7.dp),
                        )
                    }
                }
            }
            Spacer(Modifier.weight(1f))
            Text(
                // The machine's words for `more` (off the header total).
                people.more_label,
                style = centraidType("small"),
                color = centraidColor("text"),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        // THIS MONTH'S SPENDING, one figure per currency and never a sum across them.
        // The amounts are the core's and the caption is the machine's.
        spent != null -> Column(column, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            spent.amounts.forEach { amount ->
                Text(
                    amount,
                    style = centraidType("mono"),
                    color = centraidColor("text"),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.weight(1f))
            Text(
                spent.caption,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        // TODAY'S STEPS AND LAST NIGHT'S SLEEP (#1129). The figure is the machine's, in text ink:
        // Health's hue stays on its mark (R-1129-10). No figure is an empty string, never a 0.
        health != null -> Column(column, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (health.figure.isNotEmpty()) {
                Text(health.figure, style = centraidType("title"), color = centraidColor("text"), maxLines = 1)
            }
            Text(
                health.caption,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.weight(1f))
            if (health.line.isNotEmpty()) {
                Text(
                    health.line,
                    style = centraidType("small"),
                    color = centraidColor("textSoft"),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        locker != null -> Column(column, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            // No lock glyph beside "Locked" — that says it twice. A STATE
            // label, not a control, so the chip is an outline and not a fill.
            Box(
                Modifier
                    .clip(RoundedCornerShape(CONTROL_RADIUS))
                    .border(
                        HAIRLINE,
                        centraidColor("lineStrong"),
                        RoundedCornerShape(CONTROL_RADIUS),
                    )
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            ) {
                // THE MACHINE'S WORD (R-1047-L7): "Locked" / "Open".
                Text(
                    locker.state_label,
                    style = centraidType("eyebrow"),
                    color = appHue("locker"),
                )
            }
            Spacer(Modifier.weight(1f))
            Text(
                // Instructional, and the machine's — never a title from inside.
                locker.line,
                style = centraidType("small"),
                color = centraidColor("text"),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * The one place an app's hue appears in a BODY, and it is a word.
 *
 * Locker's chip label is the state itself; everywhere else the hue stays on the
 * mark, because a second hue-bearing element is a second identity.
 */
@Composable
private fun appHue(appId: String): Color {
    val marks = if (centraidDark()) CentraidCatalog.darkMarks else CentraidCatalog.lightMarks
    return marks[appId]?.let { Color(it.hue) } ?: centraidColor("text")
}

/**
 * STATIC BARS, NEVER A SPINNER.
 *
 * A read in flight holds its slot at full geometry, and the bars stand where the
 * lines will: a spinner over a tile that is about to hold three lines of prose
 * is motion that tells a member nothing and then relayouts under them.
 */
@Composable
private fun ColumnScope.Skeleton(body: HomeTileBody?, loading: String) {
    // Key by POSITION, not width — People's skeleton is two bars of the SAME width.
    val widths = if (body?.people != null) listOf(0.46f, 0.46f) else listOf(0.88f, 0.70f, 0.54f)
    Column(
        Modifier
            .weight(1f, fill = true)
            .fillMaxWidth()
            .padding(top = 4.dp)
            .semantics { contentDescription = loading },
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        widths.forEach { fraction ->
            Box(
                Modifier
                    .fillMaxWidth(fraction)
                    .height(10.dp)
                    .clip(RoundedCornerShape(SUB_RADIUS))
                    .background(centraidColor("bgSunken")),
            )
        }
    }
}

/**
 * Day one: the vault holds nothing anywhere.
 *
 * Reached ONLY when every readable tile has settled and is empty. A still-loading
 * vault, or an unreachable replica, gets the ordinary grid — this page is a claim
 * about the vault, and an unanswered read has not earned it.
 */
@Composable
private fun DayOne(data: HomeData, loading: String, onOpen: (Route) -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(PAGE_MARGIN)
            .testTag("home-day-one"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(data.day_one_title, style = centraidType("title"), color = centraidColor("text"))
        Text(
            data.day_one_body,
            style = centraidType("small"),
            color = centraidColor("textSoft"),
        )
        TileGrid(data, loading, onOpen)
    }
}

