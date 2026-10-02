package dev.centraid.shared

import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import centraid.screen.v1.LaptopPairing
import centraid.screen.v1.SeatState
import centraid.screen.v1.TileCount
import centraid.screen.v1.TileStatus
import centraid.screen.v1.VaultLockup
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.shell.HomeMachine
import dev.centraid.shared.shell.HomeWords
import dev.centraid.shared.shell.SpringboardPolicy
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * "THIS VAULT HAS NO BACKUP YET" — the one persistent, dismissable line.
 *
 * What is proved here is the machine's: WHEN the line is drawn, what it says,
 * and that putting it away is remembered for one vault and for no other. What
 * the session adds — reading `laptop_paired` off the core and keeping the
 * dismissal in the secure store — is wired in `HomeSession` and has no core to
 * answer on the JVM (no `jna.library.path` in `:shared`); the pure halves it
 * calls are asserted below.
 */
class HomeBackupNudgeSpec : StringSpec({

    val ready = SeatState(
        availability = SeatState.Availability.AVAILABILITY_READY,
        durability = SeatState.Durability.DURABILITY_AUTHORITATIVE,
    )

    fun send(state: HomeState, event: HomeEvent) = HomeMachine.reduce(state, event)

    fun vault(id: String = "v1", name: String = "My vault") =
        HomeEvent(vault_changed = HomeEvent.VaultChanged(VaultLockup(vault_id = id, vault_name = name)))

    fun pairing(p: LaptopPairing, dismissed: Boolean = false) =
        HomeEvent(backup_known = HomeEvent.BackupKnown(pairing = p, dismissed = dismissed))

    /** A Home the session has opened over vault `v1`, in the order `rebind` sends it. */
    fun opened(): HomeState {
        var state = send(HomeMachine.initial(), HomeEvent(seat_changed = HomeEvent.SeatChanged(ready))).state
        state = send(state, vault()).state
        return send(state, HomeEvent(opened = HomeEvent.Opened())).state
    }

    fun arrive(state: HomeState, app: String, status: TileStatus): HomeState =
        send(
            state,
            HomeEvent(
                tile = HomeEvent.TileArrived(
                    app_id = app,
                    status = status,
                    count = TileCount(value_ = if (status == TileStatus.TILE_STATUS_CONTENT) 3 else 0),
                ),
            ),
        ).state

    fun HomeState.nudge() = data_!!.backup_nudge

    "a vault with content and no laptop shows the line, in the machine's words" {
        val state = arrive(send(opened(), pairing(LaptopPairing.LAPTOP_PAIRING_NONE)).state, "docs", TileStatus.TILE_STATUS_CONTENT)
        val nudge = state.nudge().shouldNotBeNull()
        nudge.copy shouldBe "This vault has no backup yet"
        nudge.action shouldBe "Pair with your laptop"
        nudge.dismiss_label shouldBe HomeWords.NO_BACKUP_DISMISS
    }

    "the fact can arrive after the content, and the content after the fact" {
        val contentFirst = send(
            arrive(opened(), "docs", TileStatus.TILE_STATUS_CONTENT),
            pairing(LaptopPairing.LAPTOP_PAIRING_NONE),
        ).state
        contentFirst.nudge().shouldNotBeNull()
    }

    "a vault with nothing in it is not nudged: there is nothing to lose yet" {
        var state = send(opened(), pairing(LaptopPairing.LAPTOP_PAIRING_NONE)).state
        for (app in state.data_!!.tiles.map { it.app_id }) {
            state = arrive(state, app, TileStatus.TILE_STATUS_EMPTY)
        }
        state.nudge().shouldBeNull()
    }

    "tiles that could not be read are not content, so they do not nudge" {
        var state = send(opened(), pairing(LaptopPairing.LAPTOP_PAIRING_NONE)).state
        for (app in state.data_!!.tiles.map { it.app_id }) {
            state = send(
                state,
                HomeEvent(tile_refused = HomeEvent.TileRefused(app_id = app)),
            ).state
        }
        state.nudge().shouldBeNull()
    }

    "a paired laptop takes the line away" {
        val nudged = arrive(send(opened(), pairing(LaptopPairing.LAPTOP_PAIRING_NONE)).state, "docs", TileStatus.TILE_STATUS_CONTENT)
        nudged.nudge().shouldNotBeNull()
        send(nudged, pairing(LaptopPairing.LAPTOP_PAIRING_PAIRED)).state.nudge().shouldBeNull()
    }

    "a core that would not say is never read as no laptop" {
        // UNSPECIFIED is the default and what a failed `backup_status` becomes:
        // nudging on it would tell a member with a working backup they have none.
        arrive(opened(), "docs", TileStatus.TILE_STATUS_CONTENT).nudge().shouldBeNull()
        SpringboardPolicy.showsBackupNudge(
            tiles = arrive(opened(), "docs", TileStatus.TILE_STATUS_CONTENT).data_!!.tiles,
            laptop = LaptopPairing.LAPTOP_PAIRING_UNSPECIFIED,
            dismissed = false,
        ) shouldBe false
    }

    "dismissing puts it away at once and asks the session to remember it for this vault" {
        val nudged = arrive(send(opened(), pairing(LaptopPairing.LAPTOP_PAIRING_NONE)).state, "docs", TileStatus.TILE_STATUS_CONTENT)
        val step = send(nudged, HomeEvent(backup_nudge_dismissed = HomeEvent.BackupNudgeDismissed()))
        step.state.nudge().shouldBeNull()
        step.state.backup_nudge_dismissed shouldBe true
        step.effects shouldBe listOf(ScreenEffect.DismissBackupNudge("v1"))
    }

    "a dismissal survives tiles landing, a refresh and a reopen" {
        var state = send(opened(), pairing(LaptopPairing.LAPTOP_PAIRING_NONE)).state
        state = send(state, HomeEvent(backup_nudge_dismissed = HomeEvent.BackupNudgeDismissed())).state
        state = arrive(state, "docs", TileStatus.TILE_STATUS_CONTENT)
        state.nudge().shouldBeNull()
        // A reload drops what was read and keeps what was told.
        state = send(state, HomeEvent(opened = HomeEvent.Opened())).state
        state.laptop shouldBe LaptopPairing.LAPTOP_PAIRING_NONE
        state.backup_nudge_dismissed shouldBe true
        arrive(state, "docs", TileStatus.TILE_STATUS_CONTENT).nudge().shouldBeNull()
    }

    "the session's stored dismissal comes back on the next launch" {
        val state = arrive(
            send(opened(), pairing(LaptopPairing.LAPTOP_PAIRING_NONE, dismissed = true)).state,
            "docs",
            TileStatus.TILE_STATUS_CONTENT,
        )
        state.nudge().shouldBeNull()
    }

    "a switch to another vault drops what was told about the first" {
        var state = send(opened(), pairing(LaptopPairing.LAPTOP_PAIRING_NONE, dismissed = true)).state
        state = arrive(state, "docs", TileStatus.TILE_STATUS_CONTENT)
        val switched = send(state, vault(id = "v2", name = "Work")).state
        switched.laptop shouldBe LaptopPairing.LAPTOP_PAIRING_UNSPECIFIED
        switched.backup_nudge_dismissed shouldBe false
        // And the new vault's own answer is what decides, undimmed by the old one.
        arrive(send(switched, pairing(LaptopPairing.LAPTOP_PAIRING_NONE)).state, "docs", TileStatus.TILE_STATUS_CONTENT)
            .nudge().shouldNotBeNull()
    }

    "a lockup that changes only its state is not a switch and keeps the facts" {
        var state = send(opened(), pairing(LaptopPairing.LAPTOP_PAIRING_NONE)).state
        state = arrive(state, "docs", TileStatus.TILE_STATUS_CONTENT)
        val again = send(
            state,
            HomeEvent(
                vault_changed = HomeEvent.VaultChanged(
                    VaultLockup(vault_id = "v1", vault_name = "My vault", state = VaultLockup.State.STATE_ONLINE),
                ),
            ),
        ).state
        again.nudge().shouldNotBeNull()
    }

    "dismissing on a lockup with no id cannot be remembered, and is not refused" {
        val bare = send(HomeMachine.initial(), HomeEvent(seat_changed = HomeEvent.SeatChanged(ready))).state
        val step = send(bare, HomeEvent(backup_nudge_dismissed = HomeEvent.BackupNudgeDismissed()))
        step.effects.shouldBeEmpty()
        step.state.backup_nudge_dismissed shouldBe true
    }
})
