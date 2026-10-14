package dev.centraid.shared

import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import centraid.screen.v1.SeatState
import centraid.screen.v1.TileCount
import centraid.screen.v1.TileStatus
import centraid.screen.v1.VaultLockup
import dev.centraid.shared.shell.CoreDispatcher
import dev.centraid.shared.shell.HomeMachine
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * HOME ACROSS A SWITCH (docs/decisions.md, "Onboarding without sample data").
 *
 * The sample vault that shared Home's one notice slot with the backup line is
 * retired, so the slot is the backup line's alone and nothing here settles it.
 * What Home still owes: a lockup naming another vault is a switch — every tile
 * read out of the vault before it is dropped, never relabelled — and switching
 * back is a switch too.
 */
class HomeNoticeSpec : StringSpec({

    val ready = SeatState(
        availability = SeatState.Availability.AVAILABILITY_READY,
        durability = SeatState.Durability.DURABILITY_AUTHORITATIVE,
    )

    val own = VaultLockup(vault_id = "own", vault_name = "My vault")
    val work = VaultLockup(vault_id = "work", vault_name = "Work")

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

    // --- a switch ---------------------------------------------------------

    "another vault's lockup is a switch: the tiles are dropped and the new vault's asked for" {
        val before = withContent(opened(own, listOf(own, work)))
        before.data_ shouldNotBe null
        val step = HomeMachine.reduce(before, HomeEvent(vault_changed = HomeEvent.VaultChanged(work)))
        // NOTHING READ OUT OF ONE VAULT IS RELABELLED AS ANOTHER'S: every tile
        // is LOADING again, to be read from the vault now in front.
        step.state.data_!!.tiles.all { it.status == TileStatus.TILE_STATUS_LOADING } shouldBe true
        step.state.vault shouldBe work
        step.effects.isEmpty() shouldBe false
        step.state.vaults shouldBe listOf(own, work)
    }

    "switching back is a switch too" {
        val inWork = withContent(send(opened(own, listOf(own, work)), HomeEvent(vault_changed = HomeEvent.VaultChanged(work))))
        val back = HomeMachine.reduce(inWork, HomeEvent(vault_changed = HomeEvent.VaultChanged(own)))
        back.state.vault shouldBe own
        back.state.data_!!.tiles.all { it.status == TileStatus.TILE_STATUS_LOADING } shouldBe true
        back.effects.isEmpty() shouldBe false
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
