package dev.centraid.shared.shell

import centraid.screen.v1.SeatState
import centraid.screen.v1.HomeData
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import centraid.screen.v1.HomeStatus
import centraid.screen.v1.HomeTile
import centraid.screen.v1.Loading
import centraid.screen.v1.TileRow
import centraid.screen.v1.TileStatus
import centraid.screen.v1.VaultLockup
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * Home — the graded springboard (#1020, wave A).
 *
 * The hardest single screen in the product, and the one every other screen is
 * reached through. v0's is 376 lines of `Home.tsx` over ~9,400 lines of parts;
 * what ports is the part that decides things, which v0 had already pulled into
 * two pure modules after `#905` (see [SpringboardPolicy] and [FirstMoves]).
 *
 * ## Home fans out; it does not wait
 *
 * Every other screen in this module reads ONE thing. Home reads one per app, and
 * they land independently — so a tile is an EVENT ([HomeEvent.TileArrived]) and
 * not a field of one big answer. A Home that waited for the slowest app would be
 * a Home nobody sees, and a Home that rendered the fast ones as `EMPTY` while the
 * rest were in flight would be a Home that lies. The seed below is what makes
 * both impossible: every app starts `LOADING`, in [SpringboardPolicy.SPRINGBOARD_ORDER],
 * and a tile only ever leaves that state because its own read said something.
 *
 * ## Where the derived verdicts live
 *
 * `earns_grid`, `springboard`, `things` and `every_tile_unreadable` are computed
 * HERE and written onto the state. The views own nothing: SwiftUI and Compose
 * render a finished message, and two shells cannot disagree about which Home
 * they are drawing because neither of them decides.
 */
public object HomeMachine : ScreenMachine<HomeState, HomeEvent> {
    public const val SCREEN_ID: String = "home"

    override fun initial(): HomeState = HomeState(loading = Loading(first_load = true))

    override fun reduce(state: HomeState, event: HomeEvent): Step<HomeState> =
        when {
            event.opened != null -> state.reloaded()

            // A REFRESH OVER A GRID DOES NOT REPLACE IT WITH A SPINNER, and the
            // reason is sharper here than on a list: Home IS the navigation, so
            // blanking it takes away every destination the member was reaching
            // for. The tiles keep their last true content and each re-reads.
            event.refreshed != null ->
                if (state.data_ == null) {
                    state.reloaded()
                } else {
                    Step(state, listOf(readAllTiles()))
                }

            event.tile != null -> {
                val arrival = event.tile
                Step(
                    regrade(state) { tiles ->
                        tiles.replace(arrival.app_id) {
                            it.copy(
                                status = arrival.status,
                                // ABSENT STAYS ABSENT. A tile that withholds its
                                // count hands us no `TileCount`, and writing a
                                // zero here is the fabricated count the whole
                                // message shape exists to prevent.
                                count = arrival.count,
                                count_label = arrival.count_label,
                                body = arrival.body,
                            )
                        }
                    },
                )
            }

            // A FAILED READ IS `UNKNOWN`, NEVER `EMPTY`. This is the whole point
            // of the fourth state: a tile whose read failed has not learned that
            // its app holds nothing, and a springboard that graded it `EMPTY`
            // would put the app into first moves and tell the member to start
            // filling something that may already be full.
            event.tile_refused != null -> Step(
                regrade(state) { tiles ->
                    tiles.replace(event.tile_refused.app_id) {
                        it.copy(
                            status = TileStatus.TILE_STATUS_UNKNOWN,
                            // The count goes with the claim it supported. A
                            // stale number under a tile that has just admitted
                            // it cannot read is a number presented as current.
                            count = null,
                        )
                    }
                },
                // NO RETRY EFFECT FROM HERE, on any screen. A retry is a wake —
                // a reachability change, a foreground, a freed disk — and the
                // shell's scheduler owns those.
            )

            event.status != null -> Step(
                state.copy(data_ = state.data_?.copy(status = event.status.status)),
            )

            // THE ALL-APPS LISTING IS A SHEET, NEVER A DESTINATION. It is not a
            // second Home, it does not get a route, and it survives no
            // navigation — the same law the Photos grid's `more` follows.
            event.all_apps != null ->
                Step(state.copy(all_apps_sheet_open = event.all_apps.open_))

            event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

            // A VAULT SWITCH RE-POINTS THE WHOLE APP, so Home reloads rather
            // than keeping its tiles: every tile it is holding was read out of
            // the vault the member just left, and re-labelling them under a new
            // name would be the worst kind of stale — content attributed to the
            // wrong vault. The lockup itself carries over into the fresh state,
            // because the new vault's name is the one fact we already know.
            // THE ROSTER IS SHELL KNOWLEDGE and is simply recorded. Home does
            // not sort it, does not drop the active vault out of it, and does
            // not decide that a vault it cannot identify is not there: a row
            // with no id draws as unswitchable, which is what it is.
            event.roster_changed != null ->
                Step(state.copy(vaults = event.roster_changed.vaults))

            event.vault_changed != null -> {
                val vault = event.vault_changed.vault
                // THE FIRST LOCKUP IS NOT A SWITCH. A state with no vault in it
                // is a Home whose name has not been read yet, not a Home that
                // was looking at some other vault — so the read that finally
                // names it must not throw away the tiles that were landing
                // beside it. Only a name that CHANGES is a switch.
                val known = state.vault
                if (known == null || known.sameVaultAs(vault)) {
                    // Same vault, changed gateway or reachability: the tiles are
                    // still this vault's, so only the lockup moves.
                    Step(state.copy(vault = vault))
                } else {
                    state.reloaded(vault = vault)
                }
            }

            // The member pressed the lockup: the switcher OPENS. It is a sheet
            // and not a destination — the same law the all-apps listing follows
            // — so there is no effect here and nothing to navigate to.
            event.vault_switch != null -> Step(state.copy(vault_sheet_open = true))

            // The member chose one. The sheet shuts NOW and the vault changes
            // when the core has actually re-pointed, which arrives as
            // `VaultChanged`. Choosing the vault already open is a dismissal
            // and nothing else: re-opening the same file would throw away every
            // tile that had landed, to arrive back at the same rows.
            event.vault_picked != null -> {
                val picked = event.vault_picked.vault_id
                val shut = state.copy(vault_sheet_open = false)
                when {
                    picked.isEmpty() || picked == state.vault?.vault_id -> Step(shut)
                    else -> Step(shut, listOf(ScreenEffect.SwitchVault(picked)))
                }
            }

            // A picked move is a NAVIGATION, and Home does not navigate: it says
            // where, and the shell's navigator takes it there. Keeping it an
            // effect is what lets a test assert which destination a move chose
            // without a navigator in the room.
            event.move_picked != null ->
                Step(state, listOf(ScreenEffect.ReadPage(event.move_picked.move_id, null)))

            else -> Step(state)
        }

    /**
     * A FRESH GRID OVER EVERYTHING THE SHELL ALREADY TOLD US.
     *
     * Home's state holds two unlike kinds of fact. The tiles were READ, and
     * re-reading them is the whole point of a reload. The seat, the lockup, the
     * vault roster and the sheet flags were TOLD to Home by the shell, are not
     * re-sent on their own, and are lost for good if a reload drops them.
     *
     * `firstLoad` builds a state from nothing and therefore drops all four —
     * and every caller that had to remember to copy one back got it wrong in
     * turn. `Opened` losing the lockup put "No vault yet" over a vault Home had
     * just named. The fix copied `vault` at that ONE call site, so `Opened`
     * then lost the roster instead and the switcher said "this device holds one
     * vault" over a device holding two. The fix for THAT copied two fields at
     * the same one call site, so the switch branch lost the roster and the
     * second switch had nothing to switch to. Three simulator runs, one defect,
     * because the rule lived at the call sites.
     *
     * It lives here now: a reload replaces what was read and carries what was
     * told. [vault] is a parameter because a vault SWITCH is the one reload
     * where the lockup is genuinely new.
     */
    private fun HomeState.reloaded(vault: VaultLockup? = this.vault): Step<HomeState> {
        val fresh = firstLoad()
        return Step(
            fresh.state.copy(
                seat = seat,
                vault = vault,
                vaults = vaults,
                all_apps_sheet_open = all_apps_sheet_open,
                vault_sheet_open = vault_sheet_open,
            ),
            fresh.effects,
        )
    }

    /**
     * Whether two lockups name the SAME vault.
     *
     * By id when both have one, because two vaults may share a display name and
     * a member who founded "Personal" twice is not a member whose switch should
     * silently do nothing. By name when they do not, because an unidentified
     * lockup is still a lockup and the alternative — treating every gateway or
     * reachability update as a switch — reloads Home on a flicker.
     */
    private fun VaultLockup.sameVaultAs(other: VaultLockup?): Boolean {
        val mine = vault_id
        val theirs = other?.vault_id
        if (mine.isNotEmpty() && !theirs.isNullOrEmpty()) return mine == theirs
        return vault_name == other?.vault_name
    }

    /**
     * Every app seeded `LOADING`, in springboard order.
     *
     * Seeding — rather than letting tiles appear as they arrive — is what keeps
     * the grid still while it fills. `SPRINGBOARD_ORDER` decides where a tile
     * sits and freshness decides what is in it; a grid built from arrival order
     * would reorder itself under the member's thumb as reads landed.
     *
     * **Nothing calls this but [reloaded].** See its header for why.
     */
    private fun firstLoad(): Step<HomeState> = Step(
        HomeState(
            data_ = regraded(
                HomeData(
                    tiles = SpringboardPolicy.SPRINGBOARD_ORDER.map { appId ->
                        HomeTile(
                            app_id = appId,
                            status = TileStatus.TILE_STATUS_LOADING,
                            size = SpringboardPolicy.tileSize(appId),
                            wide = SpringboardPolicy.isWide(appId),
                            empty_copy = SpringboardPolicy.TILE_EMPTY_COPY[appId] ?: "",
                        )
                    },
                    status = HomeStatus(tone = HomeStatus.Tone.TONE_QUIET),
                ),
            ),
        ),
        listOf(readAllTiles()),
    )

    private fun readAllTiles(): ScreenEffect =
        ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)

    private fun regrade(
        state: HomeState,
        edit: (List<HomeTile>) -> List<HomeTile>,
    ): HomeState {
        val data = state.data_ ?: return state
        return state.copy(data_ = regraded(data.copy(tiles = edit(data.tiles))))
    }

    /**
     * Re-derive every verdict from the tiles, on every change.
     *
     * Recomputing the whole verdict rather than patching it is deliberate: each
     * of these four is a statement about the springboard AS A WHOLE, and three
     * of them can flip on a single tile's arrival. A `first-run` Home that stayed
     * `first-run` after one app reported content would be telling a member their
     * vault is empty while showing them what is in it.
     */
    private fun regraded(data: HomeData): HomeData {
        val graded = data.tiles.map { tile ->
            tile.copy(earns_grid = SpringboardPolicy.earnsGrid(tile.status, tile.body))
        }
        val membership = SpringboardPolicy.gridMembership(graded)
        val unreadable = SpringboardPolicy.everyTileUnreadable(graded)
        // WHICH TILES ARE DRAWN, AND IN WHICH ROWS, IS ALSO A DECISION. Every
        // tile unreadable shows them all — demoting one unreadable tile beside
        // readable neighbours is right, demoting them ALL leaves a launcher with
        // no tiles — and the packer then closes the holes a small-before-wide
        // leaves. Both answers are written here, so neither renderer has to
        // reach one, and the two cannot reach different ones.
        val shown = if (unreadable) graded else membership.earned
        return data.copy(
            tiles = graded,
            springboard = SpringboardPolicy.springboardState(graded),
            things = SpringboardPolicy.countThings(graded),
            every_tile_unreadable = unreadable,
            first_moves = FirstMoves.forIdle(membership.idleAppIds),
            grid_rows = SpringboardPolicy.rows(shown).map { row ->
                TileRow(app_ids = row.map { it.app_id })
            },
        )
    }

    private fun List<HomeTile>.replace(
        appId: String,
        edit: (HomeTile) -> HomeTile,
    ): List<HomeTile> = map { if (it.app_id == appId) edit(it) else it }

    /**
     * A ROW MOVED SOMEWHERE HOME COUNTS (#1025 S5).
     *
     * **Every tile re-reads, not the one whose table moved**, and that is a
     * decision rather than laziness. Home is not seven independent cards: the
     * springboard's grading — `earns_grid`, `things`, `every_tile_unreadable`
     * and the grid packing — is computed ACROSS all seven in [tilesArrived], so
     * recomputing it from one fresh tile and six stale ones would draw a
     * springboard that is a mixture of two moments. Seven reads is the price of
     * one truthful grid, and the core's event queue coalesces a tailing pass's
     * thousands of rows into one event per table before it ever gets here.
     *
     * A table Home does not read moves nothing.
     */
    override fun rowsChanged(table: String, keys: List<String>): HomeEvent? =
        if (table in HomeReads.TABLES) HomeEvent(refreshed = HomeEvent.Refreshed()) else null

    override fun seatChanged(seat: SeatState): HomeEvent = HomeEvent(seat_changed = HomeEvent.SeatChanged(seat = seat))
}
