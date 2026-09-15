package dev.centraid.shared

import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import centraid.screen.v1.HomeStatus
import centraid.screen.v1.HomeTile
import centraid.screen.v1.Springboard
import centraid.screen.v1.TileBody
import centraid.screen.v1.TileCount
import centraid.screen.v1.TileSize
import centraid.screen.v1.TileStatus
import centraid.screen.v1.VaultLockup
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.shell.FirstMoves
import dev.centraid.shared.shell.HomeMachine
import dev.centraid.shared.shell.SpringboardPolicy
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe

/**
 * Home, the graded springboard (#1020, wave A).
 *
 * The laws here are v0's, and every one of them is a defect v0 shipped and then
 * fixed — which is why they are pinned rather than described. The fourth read
 * state (`UNKNOWN`) is the spine of most of them: an empty answer and an
 * unanswered read are different screens, and Home is where confusing them tells
 * a member their whole vault is empty.
 */
class HomeMachineSpec : StringSpec({

    fun opened(): HomeState =
        HomeMachine.reduce(HomeMachine.initial(), HomeEvent(opened = HomeEvent.Opened())).state

    fun arrive(
        state: HomeState,
        appId: String,
        status: TileStatus,
        count: TileCount? = null,
        body: TileBody? = null,
    ): HomeState = HomeMachine.reduce(
        state,
        HomeEvent(
            tile = HomeEvent.TileArrived(
                app_id = appId,
                status = status,
                count = count,
                body = body,
            ),
        ),
    ).state

    fun refuse(state: HomeState, appId: String): HomeState = HomeMachine.reduce(
        state,
        HomeEvent(
            tile_refused = HomeEvent.TileRefused(
                app_id = appId,
                failure = Reads.noCopyYet(),
            ),
        ),
    ).state

    fun settleAllEmpty(state: HomeState): HomeState =
        SpringboardPolicy.SPRINGBOARD_ORDER.fold(state) { acc, appId ->
            arrive(acc, appId, TileStatus.TILE_STATUS_EMPTY)
        }

    // --- the seed ---------------------------------------------------------

    "opening seeds every app LOADING, in springboard order and not arrival order" {
        val data = opened().data_!!
        data.tiles.map { it.app_id } shouldContainExactly SpringboardPolicy.SPRINGBOARD_ORDER
        data.tiles.all { it.status == TileStatus.TILE_STATUS_LOADING }.shouldBeTrue()
        data.springboard shouldBe Springboard.SPRINGBOARD_LOADING
    }

    "a tile's size follows its BODY and never its importance" {
        val tiles = opened().data_!!.tiles.associateBy { it.app_id }
        // The mosaic takes the corner because it is the one body that needs area.
        tiles.getValue("photos").size shouldBe TileSize.TILE_SIZE_LARGE
        // Prose needs measure.
        tiles.getValue("docs").size shouldBe TileSize.TILE_SIZE_MEDIUM
        tiles.getValue("notes").size shouldBe TileSize.TILE_SIZE_MEDIUM
        // A figure or a chip needs neither.
        tiles.getValue("tally").size shouldBe TileSize.TILE_SIZE_SMALL
        tiles.getValue("locker").size shouldBe TileSize.TILE_SIZE_SMALL
        // `LARGE` flattens to full width on the two-column phone grid.
        tiles.getValue("photos").wide.shouldBeTrue()
        tiles.getValue("tally").wide.shouldBeFalse()
    }

    // --- the fourth state -------------------------------------------------

    "a REFUSED tile is UNKNOWN and never EMPTY" {
        // The defect this prevents: a failed read grading as `EMPTY` puts the
        // app into first moves, telling a member to start filling something
        // that may already be full.
        val refused = refuse(opened(), "photos")
        val photos = refused.data_!!.tiles.first { it.app_id == "photos" }
        photos.status shouldBe TileStatus.TILE_STATUS_UNKNOWN
    }

    "a refused tile drops the count it can no longer stand behind" {
        val withCount = arrive(
            opened(),
            "docs",
            TileStatus.TILE_STATUS_CONTENT,
            count = TileCount(value_ = 12),
        )
        withCount.data_!!.tiles.first { it.app_id == "docs" }.count!!.value_ shouldBe 12
        // A stale number under a tile that has just admitted it cannot read is
        // a number presented as current.
        refuse(withCount, "docs").data_!!.tiles.first { it.app_id == "docs" }.count.shouldBeNull()
    }

    "an UNKNOWN tile never votes the vault empty" {
        // Seven settled-empty and one unreadable is NOT first run: we do not
        // know what the eighth holds.
        var state = opened()
        state = refuse(state, "photos")
        for (appId in SpringboardPolicy.SPRINGBOARD_ORDER.filterNot { it == "photos" }) {
            state = arrive(state, appId, TileStatus.TILE_STATUS_EMPTY)
        }
        state.data_!!.springboard shouldBe Springboard.SPRINGBOARD_FIRST_RUN
    }

    "EVERY tile unreadable shows the grid anyway, and does not claim first run" {
        // Demoting one unreadable tile beside readable neighbours is right;
        // demoting them ALL leaves a launcher with no tiles.
        var state = opened()
        for (appId in SpringboardPolicy.SPRINGBOARD_ORDER) state = refuse(state, appId)
        val data = state.data_!!
        data.every_tile_unreadable.shouldBeTrue()
        data.springboard shouldBe Springboard.SPRINGBOARD_CONTENT
        SpringboardPolicy.gridMembership(data.tiles).earned.size shouldBe
            SpringboardPolicy.SPRINGBOARD_ORDER.size
    }

    "a still-loading vault has not earned the first-run claim" {
        // Day one is a claim about the vault, and an unsettled read has not
        // earned it — even when every tile that HAS answered answered empty.
        var state = opened()
        state = arrive(state, "photos", TileStatus.TILE_STATUS_EMPTY)
        state.data_!!.springboard shouldBe Springboard.SPRINGBOARD_LOADING
    }

    "one app with content is enough for the grid" {
        var state = settleAllEmpty(opened())
        state.data_!!.springboard shouldBe Springboard.SPRINGBOARD_FIRST_RUN
        state = arrive(state, "notes", TileStatus.TILE_STATUS_CONTENT)
        state.data_!!.springboard shouldBe Springboard.SPRINGBOARD_CONTENT
    }

    // --- grading ----------------------------------------------------------

    "a read in flight holds its slot at full geometry" {
        // Demoting and re-promoting a beat later is a relayout the member
        // watches, so `LOADING` earns the grid.
        opened().data_!!.tiles.all { it.earns_grid }.shouldBeTrue()
    }

    "Locker always earns the grid: its body is a STATE, not a query result" {
        val state = arrive(
            settleAllEmpty(opened()),
            "locker",
            TileStatus.TILE_STATUS_EMPTY,
            body = TileBody(locker = TileBody.Locker(locked = true)),
        )
        val locker = state.data_!!.tiles.first { it.app_id == "locker" }
        locker.status shouldBe TileStatus.TILE_STATUS_EMPTY
        // Empty, and still on the grid — it has something true to say and is
        // never an invitation to fill it.
        locker.earns_grid.shouldBeTrue()
        SpringboardPolicy.gridMembership(state.data_!!.tiles)
            .idleAppIds.contains("locker").shouldBeFalse()
    }

    "a lockup already read SURVIVES the open that follows it" {
        // The read that names the vault and the screen that opens it are a
        // race, and the loser used to win: `Opened` built a fresh state and a
        // fresh state has no vault, so Home went back to "No vault yet" over a
        // vault it had just named. Seen on a simulator against a real seeded
        // vault, not reasoned about.
        val named = HomeMachine.reduce(
            HomeMachine.initial(),
            HomeEvent(
                vault_changed = HomeEvent.VaultChanged(
                    vault = VaultLockup(vault_name = "Demo vault"),
                ),
            ),
        ).state
        named.vault!!.vault_name shouldBe "Demo vault"
        val opened = HomeMachine.reduce(named, HomeEvent(opened = HomeEvent.Opened())).state
        opened.vault!!.vault_name shouldBe "Demo vault"
        // And the grid is still freshly seeded, which is the other half of what
        // `Opened` is for.
        opened.data_!!.tiles.all { it.status == TileStatus.TILE_STATUS_LOADING }.shouldBeTrue()
    }

    "a switch to a DIFFERENT vault reloads, because the tiles belong to the old one" {
        // NAMED FIRST. A Home with no vault in it has not read its name yet;
        // the switch this test is about is a member moving between two vaults
        // they already have.
        var state = HomeMachine.reduce(
            opened(),
            HomeEvent(
                vault_changed = HomeEvent.VaultChanged(
                    vault = VaultLockup(vault_name = "Demo vault"),
                ),
            ),
        ).state
        state = arrive(state, "docs", TileStatus.TILE_STATUS_CONTENT, TileCount(value_ = 3))
        state = HomeMachine.reduce(
            state,
            HomeEvent(
                vault_changed = HomeEvent.VaultChanged(
                    vault = VaultLockup(vault_name = "Another vault"),
                ),
            ),
        ).state
        // Re-labelling somebody else's rows under a new vault's name is the
        // worst kind of stale: content attributed to the wrong vault.
        state.data_!!.tiles.first { it.app_id == "docs" }.status shouldBe
            TileStatus.TILE_STATUS_LOADING
        state.vault!!.vault_name shouldBe "Another vault"
    }

    "the same vault going offline moves the LOCKUP and nothing else" {
        val named = HomeMachine.reduce(
            opened(),
            HomeEvent(
                vault_changed = HomeEvent.VaultChanged(
                    vault = VaultLockup(
                        vault_name = "Demo vault",
                        state = VaultLockup.State.STATE_ONLINE,
                    ),
                ),
            ),
        ).state
        val filled = arrive(named, "docs", TileStatus.TILE_STATUS_CONTENT, TileCount(value_ = 3))
        val offline = HomeMachine.reduce(
            filled,
            HomeEvent(
                vault_changed = HomeEvent.VaultChanged(
                    vault = VaultLockup(
                        vault_name = "Demo vault",
                        state = VaultLockup.State.STATE_OFFLINE,
                    ),
                ),
            ),
        ).state
        // Same vault (both unnamed here), changed reachability: the tiles are
        // still this vault's rows and blanking them would be a refresh that
        // took away every destination the member was reaching for.
        offline.data_!!.tiles.first { it.app_id == "docs" }.status shouldBe
            TileStatus.TILE_STATUS_CONTENT
        offline.vault!!.state shouldBe VaultLockup.State.STATE_OFFLINE
    }

    // --- the packed grid --------------------------------------------------

    "the machine packs the grid, so neither shell has to and neither can differ" {
        // The first build of wave A packed rows in SwiftUI and let Compose's
        // span logic pack them on Android; `.gridCellColumns` is silently
        // ignored outside a `Grid`, so one shell drew Photos full width and the
        // other drew it at a half. Two packers for one grid was the defect.
        val rows = opened().data_!!.grid_rows.map { it.app_ids }
        rows shouldContainExactly listOf(
            // A wide tile takes a whole line.
            listOf("photos"),
            listOf("docs"),
            listOf("notes"),
            // Smalls pair.
            listOf("agenda", "tasks"),
            listOf("people", "tally"),
            // A lone small at the END is not a hole.
            listOf("locker"),
        )
    }

    "the grid rows carry only the tiles that earned the grid" {
        // `tiles` is still all eight — the sheet lists them — but the grid
        // draws what grading let in.
        val filled = arrive(
            settleAllEmpty(opened()),
            "notes",
            TileStatus.TILE_STATUS_CONTENT,
        )
        // Locker is absent because this fixture settles it EMPTY with no body:
        // what earns Locker the grid is having a state to show, not being
        // Locker. A tile with nothing to say is an invitation like any other.
        val drawn = filled.data_!!.grid_rows.flatMap { it.app_ids }
        drawn shouldContainExactly listOf("notes")
        filled.data_!!.tiles.size shouldBe SpringboardPolicy.SPRINGBOARD_ORDER.size
    }

    "every tile unreadable draws them all rather than an empty launcher" {
        var state = opened()
        for (appId in SpringboardPolicy.SPRINGBOARD_ORDER) state = refuse(state, appId)
        state.data_!!.grid_rows.flatMap { it.app_ids } shouldContainExactly
            SpringboardPolicy.SPRINGBOARD_ORDER
    }

    "a small before a wide is PULLED FORWARD, so no row ends half empty" {
        // Today's roster never reaches this: `SPRINGBOARD_ORDER` puts all three
        // wide tiles first, so a small never precedes one. Pins are what
        // reorder the grid (v0 `home-pins.ts`, not yet ported), and the moment
        // they do, a pinned small ahead of Photos would otherwise leave a
        // half-empty row followed by a full-width tile. The rule is pinned here
        // rather than discovered then.
        fun tile(appId: String) = HomeTile(app_id = appId, wide = SpringboardPolicy.isWide(appId))
        val pinned = listOf("tally", "photos", "locker", "docs")
        SpringboardPolicy.packTiles(pinned.map(::tile)).map { it.app_id } shouldContainExactly
            listOf("tally", "locker", "photos", "docs")
        SpringboardPolicy.rows(pinned.map(::tile)).map { row -> row.map { it.app_id } } shouldBe
            listOf(listOf("tally", "locker"), listOf("photos"), listOf("docs"))
    }

    "packing never resizes, drops or demotes a tile to make a row come out even" {
        val everything = SpringboardPolicy.SPRINGBOARD_ORDER.reversed().map {
            HomeTile(app_id = it, wide = SpringboardPolicy.isWide(it))
        }
        val packed = SpringboardPolicy.packTiles(everything)
        packed.map { it.app_id }.toSet() shouldBe everything.map { it.app_id }.toSet()
        packed.size shouldBe everything.size
        packed.forEach { it.wide shouldBe SpringboardPolicy.isWide(it.app_id) }
    }

    // --- the one number ---------------------------------------------------

    "a withheld count is omitted from the total, never counted as zero" {
        var state = opened()
        state = arrive(state, "docs", TileStatus.TILE_STATUS_CONTENT, TileCount(value_ = 4))
        // Locker withholds: it hands over no count at all.
        state = arrive(state, "locker", TileStatus.TILE_STATUS_CONTENT, count = null)
        for (appId in SpringboardPolicy.SPRINGBOARD_ORDER.filterNot { it in setOf("docs", "locker") }) {
            state = arrive(state, appId, TileStatus.TILE_STATUS_EMPTY)
        }
        val things = state.data_!!.things!!
        things.total shouldBe 4
        things.settled.shouldBeTrue()
        things.capped.shouldBeFalse()
    }

    "a capped count contributes its ceiling and says the total is 'at least'" {
        var state = settleAllEmpty(opened())
        state = arrive(
            state,
            "photos",
            TileStatus.TILE_STATUS_CONTENT,
            TileCount(value_ = 500, capped = true),
        )
        val things = state.data_!!.things!!
        things.total shouldBe 500
        things.capped.shouldBeTrue()
    }

    "an unsettled total says so, so nothing renders a moving number as final" {
        val state = arrive(opened(), "docs", TileStatus.TILE_STATUS_CONTENT, TileCount(value_ = 9))
        state.data_!!.things!!.settled.shouldBeFalse()
    }

    // --- first moves ------------------------------------------------------

    "an idle app becomes a first move, capped at three" {
        val moves = settleAllEmpty(opened()).data_!!.first_moves
        // A nudge as tall as its grid is no nudge.
        moves.size shouldBe FirstMoves.LIMIT
        // Leverage order, not springboard order: one connection fills several.
        moves.first().id shouldBe FirstMoves.CONNECTORS
        moves.all { it.label.isNotEmpty() && it.hint.isNotEmpty() }.shouldBeTrue()
    }

    "a vault with nothing idle offers no moves" {
        var state = opened()
        for (appId in SpringboardPolicy.SPRINGBOARD_ORDER) {
            state = arrive(state, appId, TileStatus.TILE_STATUS_CONTENT)
        }
        state.data_!!.first_moves.shouldBeEmpty()
    }

    // --- refresh and the sheet -------------------------------------------

    "a refresh over a filled Home does not blank it" {
        // Home IS the navigation: blanking it takes away every destination the
        // member was reaching for.
        val filled = arrive(opened(), "docs", TileStatus.TILE_STATUS_CONTENT, TileCount(value_ = 3))
        val refreshed = HomeMachine.reduce(filled, HomeEvent(refreshed = HomeEvent.Refreshed()))
        refreshed.state.data_!!.tiles.first { it.app_id == "docs" }.status shouldBe
            TileStatus.TILE_STATUS_CONTENT
        refreshed.effects.size shouldBe 1
    }

    "the all-apps listing is a sheet, and toggling it disturbs no tile" {
        val filled = arrive(opened(), "docs", TileStatus.TILE_STATUS_CONTENT)
        val open = HomeMachine.reduce(
            filled,
            HomeEvent(all_apps = HomeEvent.AllAppsSheetToggled(open_ = true)),
        ).state
        open.all_apps_sheet_open.shouldBeTrue()
        open.data_ shouldBe filled.data_
    }

    "a refused tile emits no retry effect" {
        // A retry is a wake — a reachability change, a foreground, a freed disk
        // — and the shell's scheduler owns those.
        HomeMachine.reduce(
            opened(),
            HomeEvent(tile_refused = HomeEvent.TileRefused("photos", Reads.noCopyYet())),
        ).effects.shouldBeEmpty()
    }

    "the status line replaces itself without touching the tiles" {
        val filled = arrive(opened(), "docs", TileStatus.TILE_STATUS_CONTENT)
        val loud = HomeMachine.reduce(
            filled,
            HomeEvent(
                status = HomeEvent.StatusChanged(
                    HomeStatus(
                        tone = HomeStatus.Tone.TONE_URGENT,
                        copy = "Your gateway has not answered since yesterday.",
                        action = "Check it",
                        destination = HomeStatus.Destination.DESTINATION_BACKUP,
                    ),
                ),
            ),
        ).state
        loud.data_!!.status!!.tone shouldBe HomeStatus.Tone.TONE_URGENT
        loud.data_!!.tiles shouldBe filled.data_!!.tiles
    }

    // --- the vault switcher -------------------------------------------------

    "pressing the lockup OPENS A SHEET and asks for nothing" {
        val step = HomeMachine.reduce(
            opened(),
            HomeEvent(vault_switch = HomeEvent.VaultSwitchRequested()),
        )
        step.state.vault_sheet_open.shouldBeTrue()
        // A sheet is not a destination: there is nothing to navigate to and
        // nothing to read. The first build emitted a `ReadPage("vaults")` here,
        // which no runner served and no screen drew.
        step.effects.shouldBeEmpty()
    }

    "a roster already published SURVIVES the open that follows it" {
        // The same defect the lockup had, one field over: `firstLoad` builds a
        // fresh state, and an `Opened` landing after the roster left the
        // switcher saying "this device holds one vault" over a device holding
        // two. Seen on a simulator against two real seeded vaults.
        val listed = HomeMachine.reduce(
            HomeMachine.initial(),
            HomeEvent(
                roster_changed = HomeEvent.RosterChanged(
                    vaults = listOf(
                        VaultLockup(vault_id = "v1", vault_name = "Demo vault"),
                        VaultLockup(vault_id = "v2", vault_name = "Work"),
                    ),
                ),
            ),
        ).state
        val opened = HomeMachine.reduce(listed, HomeEvent(opened = HomeEvent.Opened())).state
        opened.vaults.map { it.vault_name } shouldContainExactly listOf("Demo vault", "Work")
        // And the grid is still freshly seeded, which is the other half of what
        // `Opened` is for: the roster was told to Home, the tiles were read.
        opened.data_!!.tiles.all { it.status == TileStatus.TILE_STATUS_LOADING }.shouldBeTrue()
    }

    "a SWITCH keeps the roster too, or the second switch has nowhere to go" {
        // The third run of one defect: `firstLoad` drops everything the shell
        // told Home, and each call site had to remember to copy it back. Fixing
        // `Opened` twice still left the switch branch losing the roster, so the
        // switcher came back saying "this device holds one vault" the moment a
        // member used it once. Seen on a simulator, in that order.
        var state = HomeMachine.reduce(
            named("v1", "Demo vault"),
            HomeEvent(
                roster_changed = HomeEvent.RosterChanged(
                    vaults = listOf(
                        VaultLockup(vault_id = "v1", vault_name = "Demo vault"),
                        VaultLockup(vault_id = "v2", vault_name = "Work"),
                    ),
                ),
            ),
        ).state
        state = HomeMachine.reduce(
            state,
            HomeEvent(
                vault_changed = HomeEvent.VaultChanged(
                    vault = VaultLockup(vault_id = "v2", vault_name = "Work"),
                ),
            ),
        ).state
        state.vault!!.vault_name shouldBe "Work"
        state.vaults.map { it.vault_id } shouldContainExactly listOf("v1", "v2")
        // And the tiles ARE thrown away: they were read out of the vault the
        // member just left.
        state.data_!!.tiles.all { it.status == TileStatus.TILE_STATUS_LOADING }.shouldBeTrue()
    }

    "the roster lists EVERY vault, the open one included" {
        // A switcher that listed only the others would never show a member
        // where they already are — which is the fact most of them open it to
        // check.
        val state = HomeMachine.reduce(
            opened(),
            HomeEvent(
                roster_changed = HomeEvent.RosterChanged(
                    vaults = listOf(
                        VaultLockup(vault_id = "v1", vault_name = "Demo vault"),
                        VaultLockup(vault_id = "v2", vault_name = "Work"),
                    ),
                ),
            ),
        ).state
        state.vaults.map { it.vault_name } shouldContainExactly listOf("Demo vault", "Work")
    }

    "a roster REPUBLISHED replaces the one Home holds, membership and all" {
        // THE DEFECT THIS EVENT EXISTS FOR (#1025 S7-9). `VaultsListed` was sent
        // ONCE, from a survey taken before the active core opened, so a vault
        // admitted a minute later did not exist to the switcher until the app
        // was relaunched — and a vault whose state moved kept whatever the
        // survey had guessed about it. The shelf publishes on every membership
        // or state change now, and the reducer simply takes the newest list.
        var state = HomeMachine.reduce(
            named("v1", "Tahoe Demo"),
            HomeEvent(
                roster_changed = HomeEvent.RosterChanged(
                    vaults = listOf(
                        VaultLockup(
                            vault_id = "v1",
                            vault_name = "Tahoe Demo",
                            state = VaultLockup.State.STATE_ONLINE,
                        ),
                    ),
                ),
            ),
        ).state
        state.vaults.map { it.vault_id } shouldContainExactly listOf("v1")
        // A SECOND VAULT ADMITTED, with no relaunch and no survey.
        state = HomeMachine.reduce(
            state,
            HomeEvent(
                roster_changed = HomeEvent.RosterChanged(
                    vaults = listOf(
                        VaultLockup(
                            vault_id = "v1",
                            vault_name = "Tahoe Demo",
                            state = VaultLockup.State.STATE_ONLINE,
                        ),
                        VaultLockup(
                            vault_id = "v2",
                            vault_name = "Second Vault",
                            state = VaultLockup.State.STATE_SYNCING,
                        ),
                    ),
                ),
            ),
        ).state
        state.vaults.map { it.vault_name } shouldContainExactly
            listOf("Tahoe Demo", "Second Vault")
        state.vaults.last().state shouldBe VaultLockup.State.STATE_SYNCING
        // AND ONE FORGOTTEN, which is the inverse and the same mechanism.
        state = HomeMachine.reduce(
            state,
            HomeEvent(
                roster_changed = HomeEvent.RosterChanged(
                    vaults = listOf(
                        VaultLockup(
                            vault_id = "v2",
                            vault_name = "Second Vault",
                            state = VaultLockup.State.STATE_ONLINE,
                        ),
                    ),
                ),
            ),
        ).state
        state.vaults.map { it.vault_id } shouldContainExactly listOf("v2")
        // THE TILES ARE NOT THROWN AWAY. A roster moving is not a vault
        // switch: the member is still reading the vault they were reading, and
        // a reload here would blank the springboard every time a background
        // vault's pass reported.
        state.data_!!.tiles.all { it.status == TileStatus.TILE_STATUS_LOADING }.shouldBeTrue()
    }

    "picking ANOTHER vault shuts the sheet and asks the shell to re-point" {
        val open = HomeMachine.reduce(
            named("v1", "Demo vault"),
            HomeEvent(vault_switch = HomeEvent.VaultSwitchRequested()),
        ).state
        val step = HomeMachine.reduce(
            open,
            HomeEvent(vault_picked = HomeEvent.VaultPicked(vault_id = "v2")),
        )
        step.state.vault_sheet_open.shouldBeFalse()
        // THE LOCKUP DOES NOT MOVE HERE. Re-pointing is I/O that can fail, and
        // a state that renamed the vault on the tap would name one that is not
        // open yet. `VaultChanged` is what says it landed.
        step.state.vault!!.vault_name shouldBe "Demo vault"
        step.effects shouldContainExactly listOf(ScreenEffect.SwitchVault("v2"))
    }

    "picking the vault ALREADY OPEN is a dismissal and nothing else" {
        // Re-opening the same file would throw away every tile that had landed
        // to arrive back at the same rows — a visible, pointless reload.
        val filled = arrive(
            named("v1", "Demo vault"),
            "docs",
            TileStatus.TILE_STATUS_CONTENT,
            TileCount(value_ = 3),
        )
        val step = HomeMachine.reduce(
            filled,
            HomeEvent(vault_picked = HomeEvent.VaultPicked(vault_id = "v1")),
        )
        step.state.vault_sheet_open.shouldBeFalse()
        step.effects.shouldBeEmpty()
        step.state.data_!!.tiles.first { it.app_id == "docs" }.status shouldBe
            TileStatus.TILE_STATUS_CONTENT
    }

    "a dismissal carries no id, and changes no vault" {
        // The swipe and the tap go through ONE door: a sheet dismissed by swipe
        // sends a pick with no id rather than a second event nobody tests.
        val step = HomeMachine.reduce(
            HomeMachine.reduce(
                named("v1", "Demo vault"),
                HomeEvent(vault_switch = HomeEvent.VaultSwitchRequested()),
            ).state,
            HomeEvent(vault_picked = HomeEvent.VaultPicked(vault_id = "")),
        )
        step.state.vault_sheet_open.shouldBeFalse()
        step.effects.shouldBeEmpty()
        step.state.vault!!.vault_id shouldBe "v1"
    }

    "two vaults SHARING A NAME are still two vaults" {
        // Identity is the id when there is one. A member who founded "Personal"
        // twice is not a member whose switch should silently do nothing — and
        // comparing names alone is what would have made it do exactly that.
        val filled = arrive(
            named("v1", "Personal"),
            "docs",
            TileStatus.TILE_STATUS_CONTENT,
            TileCount(value_ = 3),
        )
        val switched = HomeMachine.reduce(
            filled,
            HomeEvent(
                vault_changed = HomeEvent.VaultChanged(
                    vault = VaultLockup(vault_id = "v2", vault_name = "Personal"),
                ),
            ),
        ).state
        switched.data_!!.tiles.first { it.app_id == "docs" }.status shouldBe
            TileStatus.TILE_STATUS_LOADING
        switched.vault!!.vault_id shouldBe "v2"
    }

    "the SAME vault re-reported keeps its tiles, id or no id" {
        val filled = arrive(
            named("v1", "Demo vault"),
            "docs",
            TileStatus.TILE_STATUS_CONTENT,
            TileCount(value_ = 3),
        )
        val again = HomeMachine.reduce(
            filled,
            HomeEvent(
                vault_changed = HomeEvent.VaultChanged(
                    vault = VaultLockup(
                        vault_id = "v1",
                        vault_name = "Demo vault",
                        state = VaultLockup.State.STATE_ONLINE,
                    ),
                ),
            ),
        ).state
        again.data_!!.tiles.first { it.app_id == "docs" }.status shouldBe
            TileStatus.TILE_STATUS_CONTENT
        again.vault!!.state shouldBe VaultLockup.State.STATE_ONLINE
    }
})

/** An opened Home that has already read its own lockup. */
private fun named(id: String, name: String): HomeState = HomeMachine.reduce(
    HomeMachine.reduce(HomeMachine.initial(), HomeEvent(opened = HomeEvent.Opened())).state,
    HomeEvent(
        vault_changed = HomeEvent.VaultChanged(
            vault = VaultLockup(vault_id = id, vault_name = name),
        ),
    ),
).state
