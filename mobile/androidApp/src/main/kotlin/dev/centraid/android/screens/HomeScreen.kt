package dev.centraid.android.screens

import dev.centraid.android.kit.LocalShellLine
import dev.centraid.android.kit.ReadStateView
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
import centraid.core.v1.Confirm
import dev.centraid.android.kit.AppMark
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.ContentImage
import dev.centraid.android.kit.HomeBand
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.VaultHeader
import dev.centraid.android.kit.rememberLargestText
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidDark
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidCatalog
import dev.centraid.design.CentraidGeometry
// TRANSITIONAL (lane H2 deletes it with the Backup tab): the one place Home still
// words a place Rust does not own yet.
import dev.centraid.android.kit.TransferRulesSheet
import dev.centraid.android.screens.words.FirstLaunchScreen

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
 * reasons — the two shells are drawn from one `design/tokens.toml`, and a number
 * typed into a view is a number nobody chose.
 */
@Composable
public fun HomeScreen(
    state: HomeState,
    /** The band Rust framed this root with, or null before it says. */
    band: ShellBand?,
    onEvent: (HomeEvent) -> Unit,
    /** Push a route a row or the search key carried. */
    onOpen: (Route) -> Unit,
    /** A press on a band place Rust owns: the runtime selects the tab. */
    onSelectTab: (String) -> Unit,
) {
    // A PHONE THAT HOLDS NO VAULT opens onto the way to make one, not onto a Home with
    // nothing to read: Rust's gate, drawn in place of Home.
    state.first_launch?.let { gate ->
        FirstLaunchScreen(
            gate = gate,
            onMake = { onEvent(HomeEvent(make = HomeEvent.MakePressed())) },
            onRestore = { onEvent(HomeEvent(restore = HomeEvent.RestorePressed())) },
        )
        return
    }
    val bar = state.bar
    // A phone that holds no vault is the page's final failure (below).
    val failed = state.page?.failed != null
    // BARE PAPER UNTIL THE LOCKUP LANDS. The shelf says it holds a vault a
    // moment before the session tells Home that vault, and Home drawn in that
    // moment said "No vault yet" for a frame between first launch and the
    // springboard — a flicker. A shelf that holds a vault always has one
    // in front, so the empty lockup is only ever that moment (and a phone that
    // holds none is a failure, below).
    if (bar?.vault?.vault_id.isNullOrEmpty() && !failed) {
        Box(Modifier.fillMaxSize().background(centraidColor("bg")))
        return
    }
    // THE BACKUP LINE'S DOOR: the backup tab, which Rust selects.
    val openBackup = { onEvent(HomeEvent(backup = HomeEvent.BackupPressed())) }
    val search: () -> Unit = { bar?.search_route?.let(onOpen) }
    val settings: (() -> Unit)? = state.bar?.settings_route?.let { route -> { onOpen(route) } }
    // AT THE LARGEST TEXT THE LOCKUP IS TALL: it scrolls with the page (the first thing in it)
    // instead of staying pinned and taking a third of the screen.
    val scrolling = rememberLargestText()
    val lockup: @Composable () -> Unit = {
        if (bar != null) {
            VaultHeader(
                bar = bar,
                onSwitchVault = { onEvent(HomeEvent(vault = HomeEvent.VaultPressed())) },
                onDownloadSettings = { onEvent(HomeEvent(transfer_rules_pressed = HomeEvent.TransferRulesPressed())) },
                // THE LOCKUP'S SECOND LINE IS THE BACKUP'S STATUS (R-ONBOARD-11),
                // and its door. Nothing between it and the grid: no backup
                // sentence, no "Home" title (the band says where the member is),
                // no settings gear.
                onOpenBackup = openBackup,
                // HOME'S SEARCH KEY (R-CHROME-6), at the lockup's trailing edge;
                // a tap pushes the search over every app. Not on the
                // Backup tab, which is the backup's and not the springboard's.
                onSearch = search,
                onSettings = settings,
            )
        }
    }
    Column(
        Modifier
            .fillMaxSize()
            .background(centraidColor("bg")),
    ) {
        // THE LOCKUP FIRST, ALWAYS. It is chrome for every route, and it is
        // drawn above the three-branch switch on purpose: a Home that failed to
        // read still has to say which vault failed.
        if (!scrolling) lockup()
        StatusRibbon(state.status, onEvent)
        val data = state.data_
        // THE PAGE TAKES THE SLACK, THE BAND TAKES ITS OWN HEIGHT. The band is
        // never scrolled away, so it is a sibling of the scrolling page and not
        // a part of it, and nothing subtracts its height from the page because
        // it is a flex peer.
        Box(Modifier.weight(1f)) {
            Column {
                // A HOME THAT FAILED STILL NAMES ITS VAULT, scrolled or pinned.
                if (failed && scrolling) lockup()
                ReadStateView(
                    page = state.page!!,
                    // No vault is a final failure: the first-launch gate is the way on, not Retry.
                    onRetry = null,
                    skeleton = { SpringboardGrid(HomeData(), state.loading_label, onOpen, header = if (scrolling) lockup else null) },
                ) {
                    val ready = data ?: return@ReadStateView
                    if (ready.springboard == HomeSpringboard.HOME_SPRINGBOARD_FIRST_RUN) {
                        DayOne(ready, state.loading_label, onOpen, header = if (scrolling) lockup else null)
                    } else {
                        SpringboardGrid(ready, state.loading_label, onOpen, header = if (scrolling) lockup else null)
                    }
                }
            }
        }
        // THE IMPORT'S LINE, on the band (product-intuition/references/design-behaviour.md § Status line).
        LocalShellLine.current?.invoke()
        Band(band, onSelectTab)
    }
    // THE SWITCHER IS A SHEET and never a destination. It is a sibling of the
    // column above rather than a child of it, because a sheet inside a
    // scrolling page would scroll.
    val sheet = state.sheet
    if (sheet != null) VaultSheet(sheet, onEvent)
    state.transfer_sheet?.let { rules ->
        TransferRulesSheet(
            sheet = rules,
            onPick = { stored -> onEvent(HomeEvent(transfer_rule_chosen = HomeEvent.TransferRuleChosen(stored = stored))) },
            onDismiss = { onEvent(HomeEvent(transfer_rules_closed = HomeEvent.TransferRulesClosed())) },
        )
    }
}

/** THE BAND: Rust's places, its words and its lit place; a press selects that tab. */
@Composable
internal fun Band(band: ShellBand?, onSelectTab: (String) -> Unit) {
    HomeBand(tabs = band?.tabs.orEmpty(), onSelect = onSelectTab)
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
            SwitcherAction(sheet.make_label, "Plus", "vault-found-button", spoken = sheet.make_spoken) {
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

/**
 * One of the switcher's two acts: a mark and a label, a full-width row. [spoken]
 * is what TalkBack reads in place of [label] when Rust carries a longer one
 * (`HomeVaultSheet.make_spoken`); empty, the label is read.
 */
@Composable
private fun SwitcherAction(label: String, iconKey: String, testTag: String, spoken: String = "", onPress: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onPress)
            .semantics { if (spoken.isNotEmpty()) contentDescription = spoken }
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
            .clickable(enabled = status.action.isNotEmpty()) { onEvent(HomeEvent(status = HomeEvent.StatusPressed())) }
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

/** `R.margin.m` — the phone's page margin, emitted beside the tokens. */
private val PAGE_MARGIN = CentraidGeometry.PAGE_MARGIN.dp

/** THE WIDGET GRID in the page's scroll (`WidgetGrid`), with the board's margin. */
@Composable
private fun SpringboardGrid(data: HomeData, loading: String, onOpen: (Route) -> Unit, header: (@Composable () -> Unit)? = null) {
    // WHICH widgets are drawn and in WHICH rows both arrive decided: `grid_rows`
    // is the machine's packing over every widget, so this file looks each id up
    // and draws it. Nothing here is allowed to disagree with `HomeView.swift`,
    // because neither of them chooses.
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
        header?.invoke()
        Column(Modifier.padding(horizontal = PAGE_MARGIN).padding(top = 10.dp, bottom = 24.dp)) {
            WidgetGrid(data, loading, onOpen)
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
private fun DayOne(data: HomeData, loading: String, onOpen: (Route) -> Unit, header: (@Composable () -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).testTag("home-day-one")) {
        header?.invoke()
        Column(
            Modifier.padding(PAGE_MARGIN),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(data.day_one_title, style = centraidType("title"), color = centraidColor("text"))
            Text(
                data.day_one_body,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
            )
            WidgetGrid(data, loading, onOpen)
        }
    }
}

