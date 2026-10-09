package dev.centraid.shared

import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import centraid.screen.v1.SeatState
import centraid.screen.v1.TileCount
import centraid.screen.v1.TileStatus
import centraid.screen.v1.VaultLockup
import dev.centraid.shared.shell.CoreDispatcher
import dev.centraid.shared.shell.FirstMoves
import dev.centraid.shared.shell.HomeMachine
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * HOME OVER AN EXAMPLE, AND THE FIRST MOVES (docs/decisions.md, "Onboarding
 * without sample data").
 *
 * The sample vault that shared Home's one notice slot with the backup line is
 * retired, so the slot is the backup line's alone and nothing here settles it.
 * What Home still owes onboarding:
 *
 *  - "See an example" publishes the example's own lockup (`example` set), which
 *    Home treats as a switch — every tile it read out of the member's vault is
 *    dropped, never relabelled — and leaving the example is a switch back;
 *  - the first moves are offered from the idle apps alone.
 */
class HomeNoticeSpec : StringSpec({

    val ready = SeatState(
        availability = SeatState.Availability.AVAILABILITY_READY,
        durability = SeatState.Durability.DURABILITY_AUTHORITATIVE,
    )

    val own = VaultLockup(vault_id = "own", vault_name = "My vault")
    val example = VaultLockup(vault_id = "example", vault_name = "Example", example = true)

    fun send(state: HomeState, event: HomeEvent) = HomeMachine.reduce(state, event).state

    fun roster(vararg vaults: VaultLockup) =
        HomeEvent(roster_changed = HomeEvent.RosterChanged(vaults = vaults.toList()))

    /** Home opened over [front], the roster as the shelf publishes it, in `rebind`'s order. */
    fun opened(front: VaultLockup, held: List<VaultLockup>): HomeState {
        var state = send(HomeMachine.initial(), HomeEvent(seat_changed = HomeEvent.SeatChanged(ready)))
        state = send(state, roster(*held.toTypedArray()))
        state = send(state, HomeEvent(vault_changed = HomeEvent.VaultChanged(front)))
        return send(state, HomeEvent(opened = HomeEvent.Opened()))
    }

    fun withContent(state: HomeState): HomeState = send(
        state,
        HomeEvent(
            tile = HomeEvent.TileArrived(
                app_id = "docs",
                status = TileStatus.TILE_STATUS_CONTENT,
                count = TileCount(value_ = 3),
            ),
        ),
    )

    // --- the example -------------------------------------------------------

    "opening the example is a switch: the member's tiles are dropped and the example's asked for" {
        val before = withContent(opened(own, listOf(own)))
        before.data_ shouldNotBe null
        val step = HomeMachine.reduce(before, HomeEvent(vault_changed = HomeEvent.VaultChanged(example)))
        // NOTHING READ OUT OF THE MEMBER'S VAULT IS RELABELLED AS THE EXAMPLE'S:
        // every tile is LOADING again, to be read from the example.
        step.state.data_!!.tiles.all { it.status == TileStatus.TILE_STATUS_LOADING } shouldBe true
        step.state.vault shouldBe example
        step.state.vault?.example shouldBe true
        step.effects.isEmpty() shouldBe false
        // THE ROSTER IS THE MEMBER'S: the example is never on it.
        step.state.vaults shouldBe listOf(own)
    }

    "leaving the example is a switch back onto the member's own vault" {
        val inExample = withContent(send(opened(own, listOf(own)), HomeEvent(vault_changed = HomeEvent.VaultChanged(example))))
        val back = HomeMachine.reduce(inExample, HomeEvent(vault_changed = HomeEvent.VaultChanged(own)))
        back.state.vault shouldBe own
        back.state.vault?.example shouldBe false
        back.state.data_!!.tiles.all { it.status == TileStatus.TILE_STATUS_LOADING } shouldBe true
        back.effects.isEmpty() shouldBe false
    }

    // --- first moves --------------------------------------------------------

    "the first moves are the idle apps', in leverage order, at most three" {
        var state = opened(own, listOf(own))
        for (id in state.data_!!.tiles.map { it.app_id }) {
            state = send(
                state,
                HomeEvent(
                    tile = HomeEvent.TileArrived(
                        app_id = id,
                        status = if (id == "photos") TileStatus.TILE_STATUS_CONTENT else TileStatus.TILE_STATUS_EMPTY,
                        count = TileCount(value_ = if (id == "photos") 3 else 0),
                    ),
                ),
            )
        }
        FirstMoves.forIdle(listOf("tally", "locker", "people")).map { it.id } shouldBe listOf("people", "tally", "locker")
        state.data_!!.first_moves.size shouldBe 3
    }

    // --- the core's dispatcher ----------------------------------------------

    "the core's pool runs at least three blocked calls at once" {
        // The reader, a running chat send and the cancel that must overtake it:
        // each blocks its thread, so three must be on three threads together.
        CoreDispatcher.THREADS shouldBe 8
        val arrived = CountDownLatch(3)
        val release = CountDownLatch(1)
        val threads = java.util.Collections.synchronizedSet(mutableSetOf<String>())
        runBlocking {
            repeat(3) {
                launch(CoreDispatcher.dispatcher) {
                    threads += Thread.currentThread().name
                    arrived.countDown()
                    release.await(10, TimeUnit.SECONDS)
                }
            }
            val together = arrived.await(10, TimeUnit.SECONDS)
            release.countDown()
            together shouldBe true
        }
        threads.size shouldBe 3
        threads.all { it.startsWith("centraid-core") } shouldBe true
    }
})
