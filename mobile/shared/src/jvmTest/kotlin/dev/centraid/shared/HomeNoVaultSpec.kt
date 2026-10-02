package dev.centraid.shared

import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import centraid.screen.v1.LaptopPairing
import centraid.screen.v1.ReadFailureKind
import centraid.screen.v1.SeatState
import centraid.screen.v1.TileStatus
import centraid.screen.v1.VaultLockup
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.shell.HomeMachine
import dev.centraid.shared.shell.HomeSession
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import kotlin.io.path.createTempDirectory

/**
 * A HOME WITH NO VAULT IS NOT A HOME THAT IS LOADING.
 *
 * Seen on a simulator with a fresh install: "No vault yet" in the header over
 * eight tiles on their seeded `LOADING` skeletons, for ever. `HomeSession`
 * starts no [dev.centraid.shared.shell.HomeRuntime] while the shelf has no core,
 * so the read the open asked for was never answered — and an app opened from
 * the same Home said "No vault is open on this device." The three-state read
 * law has a third state for exactly this and Home never reached it.
 *
 * The answer is the FAILED branch and not an empty grid: with no vault there is
 * nothing for a tile to have read, and eight `EMPTY` tiles — or a Day One page —
 * would be a claim about a vault that does not exist.
 */
class HomeNoVaultSpec : StringSpec({

    val waiting = SeatState(
        availability = SeatState.Availability.AVAILABILITY_WAITING_FOR_MOUNT,
        durability = SeatState.Durability.DURABILITY_AUTHORITATIVE,
    )
    val ready = waiting.copy(availability = SeatState.Availability.AVAILABILITY_READY)

    fun send(state: HomeState, event: HomeEvent) = HomeMachine.reduce(state, event)

    "a session over an empty vault directory settles on the failed branch, not LOADING" {
        // The real wiring, end to end: an empty directory is the ordinary first
        // run (`HomeSession.open`'s own header), and nothing in it opens a core.
        val dir = createTempDirectory("home-no-vault").toFile()
        try {
            val session = HomeSession.open(
                vaultDir = dir.absolutePath,
                services = FakePlatformServices(),
                dispatcher = Dispatchers.Default,
                uiThreadName = "test",
            )
            val settled = withTimeout(5_000) {
                session.state.first { it.data_ == null || it.data_.tiles.none { t -> t.status == TileStatus.TILE_STATUS_LOADING } }
            }
            settled.data_.shouldBeNull()
            settled.loading.shouldBeNull()
            settled.failure.shouldNotBeNull().sentence shouldBe Reads.NO_VAULT
            // No vault, no laptop to know about: never a nudge.
            settled.laptop shouldBe LaptopPairing.LAPTOP_PAIRING_UNSPECIFIED
            session.close()
        } finally {
            dir.deleteRecursively()
        }
    }

    "opening Home while the seat waits for a vault reads nothing and says so" {
        val told = send(HomeMachine.initial(), HomeEvent(seat_changed = HomeEvent.SeatChanged(seat = waiting))).state
        val step = send(told, HomeEvent(opened = HomeEvent.Opened()))

        step.state.data_.shouldBeNull()
        step.state.loading.shouldBeNull()
        val failure = step.state.failure.shouldNotBeNull()
        failure.kind shouldBe ReadFailureKind.READ_FAILURE_KIND_REFUSED
        failure.sentence shouldBe Reads.NO_VAULT
        // A read with no vault to read from is a read nobody answers.
        step.effects.shouldBeEmpty()
        // What the shell told Home survives the reload, as it does everywhere.
        step.state.seat shouldBe waiting
    }

    "a refresh with no vault stays failed instead of re-seeding LOADING" {
        val failed = send(
            send(HomeMachine.initial(), HomeEvent(seat_changed = HomeEvent.SeatChanged(seat = waiting))).state,
            HomeEvent(opened = HomeEvent.Opened()),
        ).state
        val step = send(failed, HomeEvent(refreshed = HomeEvent.Refreshed()))
        step.state.failure.shouldNotBeNull()
        step.state.data_.shouldBeNull()
        step.effects.shouldBeEmpty()
    }

    "founding a vault leaves the failed branch: tiles seed LOADING and ask to be read" {
        val failed = send(
            send(HomeMachine.initial(), HomeEvent(seat_changed = HomeEvent.SeatChanged(seat = waiting))).state,
            HomeEvent(opened = HomeEvent.Opened()),
        ).state
        // `HomeSession.rebind` publishes the seat and THEN the lockup.
        val seated = send(failed, HomeEvent(seat_changed = HomeEvent.SeatChanged(seat = ready))).state
        val step = send(
            seated,
            HomeEvent(vault_changed = HomeEvent.VaultChanged(VaultLockup(vault_id = "v1", vault_name = "My vault"))),
        )

        step.state.failure.shouldBeNull()
        val tiles = step.state.data_.shouldNotBeNull().tiles
        tiles.all { it.status == TileStatus.TILE_STATUS_LOADING } shouldBe true
        step.effects shouldHaveSize 1
        (step.effects.single() as ScreenEffect.ReadPage).screenId shouldBe HomeMachine.SCREEN_ID
    }

    "an empty vault, once read, reaches Day One" {
        val failed = send(
            send(HomeMachine.initial(), HomeEvent(seat_changed = HomeEvent.SeatChanged(seat = waiting))).state,
            HomeEvent(opened = HomeEvent.Opened()),
        ).state
        var state = send(failed, HomeEvent(seat_changed = HomeEvent.SeatChanged(seat = ready))).state
        state = send(
            state,
            HomeEvent(vault_changed = HomeEvent.VaultChanged(VaultLockup(vault_id = "v1", vault_name = "My vault"))),
        ).state
        for (app in state.data_!!.tiles.map { it.app_id }) {
            state = send(
                state,
                HomeEvent(tile = HomeEvent.TileArrived(app_id = app, status = TileStatus.TILE_STATUS_EMPTY)),
            ).state
        }
        state.data_!!.springboard shouldBe centraid.screen.v1.Springboard.SPRINGBOARD_FIRST_RUN
    }
})
