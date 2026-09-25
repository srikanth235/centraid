package dev.centraid.android.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
// `var x by mutableStateOf(...)` needs BOTH operators in scope; importing
// only `getValue` compiles the read and fails the write (#1020, wave A).
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import centraid.screen.v1.FirstMove
import centraid.screen.v1.HomeData
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import centraid.screen.v1.HomeStatus
import centraid.screen.v1.HomeTile
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.Springboard
import centraid.screen.v1.ThingCount
import centraid.screen.v1.TileBody
import centraid.screen.v1.TileStatus
import centraid.screen.v1.VaultLockup
import dev.centraid.android.kit.AppMark
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ContentImage
import dev.centraid.android.kit.HomeBand
import dev.centraid.android.kit.HomeTitleRow
import dev.centraid.android.kit.VaultHeader
import dev.centraid.android.kit.stateLine
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.android.theme.formatMoney
import dev.centraid.design.CentraidCatalog
import dev.centraid.design.CentraidGeometry

/**
 * Home, the graded springboard (#1020, wave A).
 *
 * **THIS VIEW DECIDES NOTHING.** `earns_grid`, `springboard`, `things` and
 * `every_tile_unreadable` arrive already decided by `HomeMachine`, and the rows
 * come out of `SpringboardPolicy.rows`. That is what lets this file and
 * `HomeView.swift` draw the same Home: not discipline, but the absence of
 * anywhere for the two to disagree.
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
    onEvent: (HomeEvent) -> Unit,
    onForget: (String) -> Unit,
    /**
     * Open the transfer-rules sheet (#1025 S4). Defaulted so a preview renders
     * this screen without one.
     */
    onDownloadSettings: () -> Unit = {},
    /**
     * Open the vault sheet (#1025 live-shell, R-SHELL-3; #1029 §1).
     *
     * It was "open the Gateway / pair sheet", and the empty-device switcher is
     * still an onboarding surface — what it offers now is MAKING a vault
     * rather than pairing with one, because there is nothing to pair with.
     */
    onMakeVault: () -> Unit = {},
) {
    Column(
        Modifier
            .fillMaxSize()
            .background(centraidColor("bg")),
    ) {
        // THE LOCKUP FIRST, ALWAYS. It is chrome for every route, and it is
        // drawn above the three-branch switch on purpose: a Home that failed to
        // read still has to say which vault failed.
        VaultHeader(
            vault = state.vault,
            onSwitchVault = {
                onEvent(HomeEvent(vault_switch = HomeEvent.VaultSwitchRequested()))
            },
            onDownloadSettings = onDownloadSettings,
        )
        HomeTitleRow(onSettings = onMakeVault)
        StatusRibbon(state.data_?.status, onEvent)
        val failure = state.failure
        val data = state.data_
        // THE PAGE TAKES THE SLACK, THE BAND TAKES ITS OWN HEIGHT. The band is
        // never scrolled away, so it is a sibling of the scrolling page and not
        // a part of it, and nothing subtracts its height from the page because
        // it is a flex peer.
        Box(Modifier.weight(1f)) {
            when {
                failure != null -> FailureBody(failure)
                data == null -> SpringboardGrid(HomeData(), onEvent)
                data.springboard == Springboard.SPRINGBOARD_FIRST_RUN -> DayOne(data, onEvent)
                else -> SpringboardGrid(data, onEvent)
            }
        }
        HomeBand(
            active = "home",
            onSelect = { target ->
                // Every band press but Home's lands in a place this wave has not
                // built. `more` opens the one thing that does exist.
                if (target == "more") {
                    onEvent(HomeEvent(all_apps = HomeEvent.AllAppsSheetToggled(open_ = true)))
                }
            },
        )
    }
    // THE SWITCHER IS A SHEET and never a destination — the same law the
    // all-apps listing follows. It is a sibling of the column above rather than
    // a child of it, because a sheet inside a scrolling page would scroll.
    if (state.vault_sheet_open) {
        VaultSheet(
            vaults = state.vaults,
            active = state.vault,
            onPick = { id ->
                onEvent(HomeEvent(vault_picked = HomeEvent.VaultPicked(vault_id = id)))
            },
            onForget = onForget,
            onMakeVault = onMakeVault,
        )
    }
    // THE ALL-APPS LISTING. The band's `more` has set this flag since wave A
    // and nothing drew it, so the press did nothing a member could see.
    if (state.all_apps_sheet_open) {
        AllAppsSheet(tiles = state.data_?.tiles.orEmpty(), onEvent = onEvent)
    }
}

/**
 * THE ALL-APPS LISTING is a SHEET and never a destination.
 *
 * A row sends the same pick its tile sends, so the listing and the springboard
 * cannot disagree about where an app goes; the navigation, and the closing that
 * goes with it, are the activity's, which is where the routes live. Dismissing
 * tells the machine the sheet is shut — without that the flag stays set over a
 * sheet that is gone, and the next `more` sets a flag already set and draws
 * nothing.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun AllAppsSheet(tiles: List<HomeTile>, onEvent: (HomeEvent) -> Unit) {
    androidx.compose.material3.ModalBottomSheet(
        onDismissRequest = {
            onEvent(HomeEvent(all_apps = HomeEvent.AllAppsSheetToggled(open_ = false)))
        },
        containerColor = centraidColor("bg"),
    ) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp).testTag("home-all-apps-sheet")) {
            for (tile in tiles) {
                val name = CentraidCatalog.byId[tile.app_id]?.name
                    ?: tile.app_id.replaceFirstChar { it.uppercase() }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable {
                            onEvent(HomeEvent(move_picked = HomeEvent.MovePicked(move_id = tile.app_id)))
                        }
                        .heightIn(min = 48.dp)
                        .padding(horizontal = PAGE_MARGIN)
                        .testTag("home-all-apps-row-${tile.app_id}")
                        .semantics { contentDescription = "Open $name" },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    AppMark(appId = tile.app_id, size = 22.dp)
                    Text(name, style = centraidType("smallStrong"), color = centraidColor("text"))
                }
            }
        }
    }
}

/**
 * THE VAULT SWITCHER (#1020, wave A).
 *
 * It lists EVERY vault the device holds, the open one included and ticked. A
 * switcher that listed only the others would never show a member where they
 * already are, which is the fact most of them opened it to check.
 *
 * Dismissing sends a pick with NO ID, which the machine reads as exactly what
 * it is: shut the sheet, change no vault. The swipe and the tap therefore go
 * through one door rather than two.
 *
 * **EVERY ROW SAYS WHERE ITS VAULT STANDS (#1025 S7-9).** The caption is
 * [stateLine] — the header's own table, called and not restated — so the lockup
 * and the row a member compares it against cannot word one `State` two ways.
 *
 * **AND EVERY ROW CAN BE FORGOTTEN.** Forgetting DELETES the vault: the file,
 * its byte store and its sidecars. That is why it is one tap behind a dialog
 * that NAMES the vault rather than a bare icon — a destructive act that a
 * mis-hit thumb can complete is a destructive act that will be completed by
 * mis-hit thumbs.
 *
 * **It used to be a LOCAL removal** — the gateway kept the vault and kept this
 * device enrolled, so a forget cost a copy and a re-pair got it back. The phone
 * is the vault (#1029 §1). There is no copy anywhere else, so the dialog has to
 * say what it now does.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun VaultSheet(
    vaults: List<VaultLockup>,
    active: VaultLockup?,
    onPick: (String) -> Unit,
    onForget: (String) -> Unit,
    onMakeVault: () -> Unit = {},
) {
    // WHICH VAULT THE MEMBER IS BEING ASKED ABOUT, held by the sheet and not by
    // the row: a dialog owned by a row would be unmounted the instant the
    // roster changed under it, and the roster changes on its own now that
    // `RosterChanged` streams.
    var pendingForget by androidx.compose.runtime.remember {
        androidx.compose.runtime.mutableStateOf<VaultLockup?>(null)
    }
    androidx.compose.material3.ModalBottomSheet(
        onDismissRequest = { onPick("") },
        containerColor = centraidColor("bg"),
    ) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp).testTag("home-vault-sheet")) {
            Text(
                text = "Vaults",
                style = centraidType("title"),
                color = centraidColor("text"),
                modifier = Modifier.padding(horizontal = PAGE_MARGIN, vertical = 8.dp),
            )
            // ZERO IS NOT ONE (R-SHELL-3). Empty device → honest copy and a
            // way out of it; one vault keeps the old sentence.
            when {
                vaults.isEmpty() -> {
                    Text(
                        text = "This device holds no vault.",
                        style = centraidType("small"),
                        color = centraidColor("textSoft"),
                        modifier = Modifier.padding(horizontal = PAGE_MARGIN),
                    )
                    Text(
                        text = "Make a vault",
                        style = centraidType("smallStrong"),
                        color = centraidColor("link"),
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                onPick("")
                                onMakeVault()
                            }
                            .padding(horizontal = PAGE_MARGIN, vertical = 12.dp)
                            .heightIn(min = 44.dp)
                            .testTag("vault-sheet-make")
                            .semantics { contentDescription = "Make a vault on this phone" },
                    )
                }
                vaults.size == 1 -> {
                    Text(
                        text = "This device holds one vault.",
                        style = centraidType("small"),
                        color = centraidColor("textSoft"),
                        modifier = Modifier.padding(horizontal = PAGE_MARGIN),
                    )
                }
            }
            for (vault in vaults) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onPick(vault.vault_id) }
                        .heightIn(min = 48.dp)
                        .padding(horizontal = PAGE_MARGIN)
                        .testTag("vault-row-${vault.vault_id}"),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        text = vault.vault_name.take(1).uppercase(),
                        style = centraidType("smallStrong"),
                        color = centraidColor("text"),
                        modifier = Modifier
                            .size(30.dp)
                            .clip(RoundedCornerShape(7.dp))
                            .background(centraidColor("bgSunken"))
                            .padding(top = 6.dp),
                    )
                    Column(Modifier.weight(1f)) {
                        Text(
                            text = vault.vault_name.ifEmpty { "Unnamed vault" },
                            style = centraidType("smallStrong"),
                            color = centraidColor("text"),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        // The same sentence the lockup draws, from the same
                        // function. `STATE_UNSPECIFIED` is never emitted and
                        // draws nothing, so the row is a name alone rather
                        // than a name over a blank caption.
                        val line = stateLine(vault.state)
                        if (line.isNotEmpty()) {
                            Text(
                                text = line,
                                style = centraidType("mono"),
                                color = centraidColor("textFaint"),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    // THE TICK IS THE WHOLE POINT of listing the open one.
                    if (vault.vault_id == active?.vault_id) {
                        CentraidIcon(
                            iconKey = "Check",
                            tint = centraidColor("link"),
                            size = 18.dp,
                        )
                    }
                    // OUTSIDE the row's own `clickable`, with its own 44dp
                    // target: a forget that shared the row's tap area would be
                    // a switch and a deletion behind one gesture.
                    Box(
                        Modifier
                            .size(44.dp)
                            .clickable { pendingForget = vault }
                            .testTag("vault-forget-${vault.vault_id}")
                            .semantics {
                                contentDescription =
                                    "Forget ${vault.vault_name.ifEmpty { "this vault" }}"
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        CentraidIcon(
                            iconKey = "Trash",
                            tint = centraidColor("textSoft"),
                            size = 18.dp,
                        )
                    }
                }
            }
        }
    }
    val pending = pendingForget
    if (pending != null) {
        val spoken = pending.vault_name.ifEmpty { "this vault" }
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { pendingForget = null },
            // IT NAMES THE VAULT. A confirmation that says "this vault" in a
            // sheet listing several is a confirmation that confirms nothing.
            title = { Text("Forget $spoken?") },
            text = {
                Text(
                    "This deletes $spoken and everything in it — its rows and " +
                        "its files. There is no copy anywhere else.",
                )
            },
            confirmButton = {
                androidx.compose.material3.TextButton(
                    onClick = {
                        // The sheet shuts FIRST and with no pick, so the
                        // machine changes no vault: the shelf brings the next
                        // holding forward by itself, and a sheet still open
                        // over a roster being rebuilt is a sheet drawing a
                        // vault that no longer exists.
                        pendingForget = null
                        onPick("")
                        onForget(pending.vault_id)
                    },
                    modifier = Modifier.testTag("vault-forget-confirm"),
                ) {
                    Text("Forget", color = centraidColor("danger"))
                }
            },
            dismissButton = {
                androidx.compose.material3.TextButton(onClick = { pendingForget = null }) {
                    Text("Keep")
                }
            },
            containerColor = centraidColor("bg"),
        )
    }
}

/**
 * The vault at a glance, and how it stands on this device.
 *
 * The ONLY feedback channel on this screen — no spinner, no toast, no badge, no
 * red dot. `QUIET` is deliberately ignorable and earns no rule; the other two
 * earn one rule and one action, never a filled warning plate.
 */
@Composable
private fun StatusRibbon(status: HomeStatus?, onEvent: (HomeEvent) -> Unit) {
    if (status == null) return
    val loud = status.tone != HomeStatus.Tone.TONE_QUIET
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = if (loud) 40.dp else 32.dp)
            .padding(horizontal = PAGE_MARGIN)
            .testTag("home-status")
            .semantics {
                contentDescription =
                    listOf(status.copy, status.action).filter { it.isNotEmpty() }
                        .joinToString(". ")
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
                        if (status.tone == HomeStatus.Tone.TONE_URGENT) {
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
        // The all-apps listing is a SHEET, opened here and never routed to.
        Text(
            "All apps",
            style = centraidType("control"),
            // The LINK role, not Material's primary. A `TextButton` takes the
            // colour scheme's primary, which this table maps to `accent` — so
            // the same control read as ink on Android and as a link on iOS,
            // which is the shells disagreeing about what a link is.
            color = centraidColor("link"),
            modifier = Modifier
                .clickable {
                    onEvent(HomeEvent(all_apps = HomeEvent.AllAppsSheetToggled(open_ = true)))
                }
                .padding(horizontal = 8.dp, vertical = 8.dp)
                .testTag("home-all-apps"),
        )
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
private fun FailureBody(failure: ReadFailure) {
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
 * `PartyHueWheel` decides WHICH of the eight a face gets and `HomeReads` puts
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
private fun SpringboardGrid(data: HomeData, onEvent: (HomeEvent) -> Unit) {
    // WHICH tiles are drawn and in WHICH rows both arrive decided: `grid_rows`
    // is the machine's packing over the tiles that earned the grid, so this
    // file looks each id up and draws it. Nothing here is allowed to disagree
    // with `HomeView.swift`, because neither of them chooses.
    val byId = data.tiles.associateBy { it.app_id }
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = PAGE_MARGIN)
            .padding(top = 4.dp, bottom = 24.dp),
    ) {
        Column(
            Modifier.fillMaxWidth().testTag("home-grid"),
            verticalArrangement = Arrangement.spacedBy(TILE_GAP),
        ) {
            for (row in data.grid_rows) {
                val tiles = row.app_ids.mapNotNull { byId[it] }
                if (tiles.isEmpty()) continue
                Row(horizontalArrangement = Arrangement.spacedBy(TILE_GAP)) {
                    for (tile in tiles) {
                        TileCard(tile, Modifier.weight(1f), onEvent)
                    }
                    // A lone small keeps its column rather than stretching over
                    // both: a tile that changed width with its neighbours'
                    // arrival would be layout overruling the body rule that
                    // chose its size.
                    if (tiles.size == 1 && !tiles[0].wide) Spacer(Modifier.weight(1f))
                }
            }
        }
        if (data.first_moves.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            FirstMovesBand(data.first_moves, onEvent)
        }
        ThingsFoot(data.things)
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
private fun TileCard(tile: HomeTile, modifier: Modifier, onEvent: (HomeEvent) -> Unit) {
    val app = CentraidCatalog.byId[tile.app_id]
    val name = app?.name ?: tile.app_id.replaceFirstChar { it.uppercase() }
    val count = countText(tile)
    // The em dash is a glyph; a screen reader gets the label alone.
    val spoken = if (tile.count == null) tile.count_label else "$count ${tile.count_label}"
    Column(
        modifier
            .heightIn(min = TILE_MIN_HEIGHT)
            .clip(RoundedCornerShape(TILE_RADIUS))
            .background(centraidColor("bgElev"))
            .border(HAIRLINE, centraidColor("line"), RoundedCornerShape(TILE_RADIUS))
            .clickable {
                onEvent(HomeEvent(move_picked = HomeEvent.MovePicked(move_id = tile.app_id)))
            }
            .padding(TILE_PAD)
            // Keyed on the app id. The label carries the live count, so it
            // changes with the vault; the id does not.
            .testTag("home-tile-${tile.app_id}")
            .semantics { contentDescription = "Open $name, $spoken".trim().removeSuffix(",") },
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
        TileBodyView(tile)
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
private fun ColumnScope.TileBodyView(tile: HomeTile) {
    val body = tile.body
    // Locker's body is a STATE and not a query result, and Photos draws its own
    // waiting state cell by cell — neither falls through to the generic skeleton
    // or to the invitation, because for both of them the generic answer is
    // wrong rather than merely plain.
    when {
        body?.locker != null || body?.photos != null -> FilledBody(body)
        tile.status == TileStatus.TILE_STATUS_LOADING -> Skeleton(body)
        tile.status != TileStatus.TILE_STATUS_CONTENT -> Text(
            // What to DO, never what is missing. A quiet tile is an invitation.
            tile.empty_copy,
            style = centraidType("control"),
            color = centraidColor("textFaint"),
            modifier = Modifier.weight(1f, fill = true),
        )
        body != null -> FilledBody(body)
    }
}

@Composable
private fun ColumnScope.FilledBody(body: TileBody) {
    val column = Modifier.weight(1f, fill = true).fillMaxWidth()
    val photos = body.photos
    val docs = body.docs
    val notes = body.notes
    val agenda = body.agenda
    val people = body.people
    val tasks = body.tasks
    val tally = body.tally
    val locker = body.locker
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
                if (waiting) {
                    // IT DOES NOT NAME THE GATEWAY any more, and did before:
                    // with the byte door built, a vault placed on the device
                    // holds its own photographs, and "these fill in when it is
                    // back" was a sentence about a connection that is not the
                    // reason. What is true in every case is that the bytes are
                    // not here yet.
                    Text(
                        "These photographs are not on this device yet.",
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

        notes != null -> Column(column, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            // PROSE — a title over an opening line. Notes and Docs shared one
            // body shape in an early draft and the two were indistinguishable.
            Text(
                notes.title,
                style = centraidType("smallStrong"),
                color = centraidColor("text"),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (notes.excerpt.isNotEmpty()) {
                // SOFT INK, NOT FULL: `readBodyCss` is `color: t.ink2`, which
                // the handoff's role map spells `--text-soft`. At full `text`
                // the excerpt weighed the same as its title and the tile read
                // as two headings.
                Text(
                    notes.excerpt,
                    style = centraidType("small"),
                    color = centraidColor("textSoft"),
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        agenda != null -> Column(column, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(agenda.at, style = centraidType("mono"), color = centraidColor("textSoft"))
            Text(
                agenda.title,
                style = centraidType("smallStrong"),
                color = centraidColor("text"),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            // Pinned to the foot: the sparse tiles leave their slack above.
            Spacer(Modifier.weight(1f))
            Text(
                agenda.after,
                style = centraidType("small"),
                color = centraidColor("textFaint"),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
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
                    // key `HomeReads` already resolved with the one port of the
                    // identity wheel; all this does is spell the emitted role.
                    // An unrecognised key draws the neutral disc rather than
                    // reaching `centraidColor`, which fails LOUDLY by design —
                    // a tile is not the place to take a shell down over a hue.
                    val hue = face.color?.let { PARTY_HUE_ROLES[it] }
                    Box(
                        Modifier
                            .size(30.dp)
                            .clip(RoundedCornerShape(999.dp))
                            .background(centraidColor(hue ?: "bgSunken"))
                            .border(1.5.dp, centraidColor("bgElev"), RoundedCornerShape(999.dp)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            face.initials,
                            style = centraidType("smallStrong"),
                            // `textInv` is the SOLVED foreground for a filled
                            // identity disc (`DESIGN.md`'s rule 7 — `onAccent`
                            // in the hand-off's role map). Ink on a saturated
                            // fill is the contrast failure this tile had.
                            color = centraidColor(if (hue != null) "textInv" else "text"),
                        )
                    }
                }
            }
            Spacer(Modifier.weight(1f))
            Text(
                // `more` comes off the header total — never a fabricated 0; an
                // exhausted directory says so plainly.
                if (people.more > 0) {
                    "+${people.more} more in your directory"
                } else {
                    "That's everyone in your directory"
                },
                style = centraidType("small"),
                color = centraidColor("text"),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        tasks != null -> Column(column, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            tasks.rows.forEach { row ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    // INK, never the app's hue — a hue-filled box is a second
                    // identity. Done is a filled box with NO glyph.
                    Box(
                        Modifier
                            .size(13.dp)
                            .clip(RoundedCornerShape(SUB_RADIUS))
                            .background(if (row.done) centraidColor("accent") else Color.Transparent)
                            .border(
                                HAIRLINE,
                                if (row.done) {
                                    centraidColor("accent")
                                } else {
                                    centraidColor("lineStrong")
                                },
                                RoundedCornerShape(SUB_RADIUS),
                            ),
                    )
                    Text(
                        row.title,
                        style = centraidType("small"),
                        color = if (row.done) centraidColor("textFaint") else centraidColor("text"),
                        textDecoration = if (row.done) TextDecoration.LineThrough else null,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }

        tally != null -> Column(column, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                tally.figure?.let { formatMoney(it) } ?: "",
                style = centraidType("display"),
                color = centraidColor("text"),
                maxLines = 1,
            )
            Text(tally.caption, style = centraidType("small"), color = centraidColor("textSoft"))
            // Rendered only when the caller has something true to say — the
            // rolling comparison is an optional field, and absent is silence.
            val after = tally.after
            if (!after.isNullOrEmpty()) {
                Spacer(Modifier.weight(1f))
                Text(
                    after,
                    style = centraidType("small"),
                    color = centraidColor("textFaint"),
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
                Text(
                    if (locker.locked) "Locked" else "Unlocked",
                    style = centraidType("eyebrow"),
                    color = appHue("locker"),
                )
            }
            Spacer(Modifier.weight(1f))
            Text(
                // Instructional — never claim a shelf count this tile cannot read.
                if (locker.locked) "Opens with your passphrase" else "Open on this device",
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
    val marks = if (isSystemInDarkTheme()) CentraidCatalog.darkMarks else CentraidCatalog.lightMarks
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
private fun ColumnScope.Skeleton(body: TileBody?) {
    // Key by POSITION, not width — People's skeleton is two bars of the SAME width.
    val widths = if (body?.people != null) listOf(0.46f, 0.46f) else listOf(0.88f, 0.70f, 0.54f)
    Column(
        Modifier
            .weight(1f, fill = true)
            .fillMaxWidth()
            .padding(top = 4.dp)
            .semantics { contentDescription = "Loading" },
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
private fun DayOne(data: HomeData, onEvent: (HomeEvent) -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(PAGE_MARGIN)
            .testTag("home-day-one"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Nothing in here yet", style = centraidType("title"), color = centraidColor("text"))
        Text(
            "Bring your photographs and documents in and this becomes the front of " +
                "your own archive.",
            style = centraidType("small"),
            color = centraidColor("textSoft"),
        )
        data.first_moves.forEach { MoveRow(it, onEvent) }
        ThingsFoot(data.things)
    }
}

/**
 * Deliberately absent: dashed placeholder cards. They scale to identical
 * apologies and they open empty apps. Every move here lands somewhere that can
 * TAKE content.
 */
@Composable
private fun FirstMovesBand(moves: List<FirstMove>, onEvent: (HomeEvent) -> Unit) {
    Column(
        Modifier.fillMaxWidth().testTag("home-first-moves"),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("Fill this out", style = centraidType("eyebrow"), color = centraidColor("textFaint"))
        moves.forEach { MoveRow(it, onEvent) }
    }
}

@Composable
private fun MoveRow(move: FirstMove, onEvent: (HomeEvent) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            // The coarse target minimum, from the table — a nudge you cannot hit
            // is not a nudge.
            .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
            .clickable {
                onEvent(HomeEvent(move_picked = HomeEvent.MovePicked(move_id = move.id)))
            }
            .padding(vertical = 4.dp)
            .semantics { contentDescription = "${move.label}. ${move.hint}" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // A move carries its OWN icon key: `connectors` is a move and not an
        // app, so there is no mark to look up for it.
        CentraidIcon(
            iconKey = move.icon_key,
            tint = centraidColor("textSoft"),
            size = 16.dp,
        )
        Column(Modifier.weight(1f)) {
            Text(move.label, style = centraidType("smallStrong"), color = centraidColor("text"))
            Text(move.hint, style = centraidType("mono"), color = centraidColor("textFaint"))
        }
    }
}

/**
 * The one number describing the whole vault, assembled from numbers each true.
 *
 * It says "at least" when anything is capped, and says nothing at all until every
 * tile has settled — a moving total rendered as final is a number a member would
 * quote back.
 */
@Composable
private fun ThingsFoot(things: ThingCount?) {
    if (things == null || !things.settled) return
    Text(
        if (things.capped) "at least ${things.total} things" else "${things.total} things",
        style = centraidType("mono"),
        color = centraidColor("textFaint"),
        modifier = Modifier.padding(top = 16.dp),
    )
}
