package dev.centraid.shared

import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import centraid.screen.v1.LaptopPairing
import centraid.screen.v1.SeatState
import centraid.screen.v1.TileCount
import centraid.screen.v1.TileStatus
import centraid.screen.v1.VaultLockup
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.platform.FakeDeviceClock
import dev.centraid.shared.shell.CoreDispatcher
import dev.centraid.shared.shell.FirstMoves
import dev.centraid.shared.shell.FoundingDay
import dev.centraid.shared.shell.HomeMachine
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * HOME'S ONE NOTICE SLOT (R-SAMPLE-8) — who holds it, and when.
 *
 * The sample line and the backup nudge both want the line above the grid:
 *
 *  - on the SAMPLE vault the sample line always has it and the nudge never does
 *    (the core says `laptop_paired=false` for a sample, and that is "never",
 *    not "not yet");
 *  - on a member's OWN vault the sample line has it for the day the vault was
 *    founded, while a sample is held, and the nudge has it from the next day;
 *  - Settings' Remove/Add sample is a different door and is not here.
 *
 * Machine only: what the session adds (reading the founding time off the vault
 * and the zone off the platform) is `FoundingDay` and the lockup's
 * `founded_at`, asserted below and in `SampleVaultSpec`.
 */
class HomeNoticeSpec : StringSpec({

    val ready = SeatState(
        availability = SeatState.Availability.AVAILABILITY_READY,
        durability = SeatState.Durability.DURABILITY_AUTHORITATIVE,
    )

    val own = VaultLockup(vault_id = "own", vault_name = "My vault")
    val sample = VaultLockup(vault_id = "sample", vault_name = "Sample", sample = true)

    fun send(state: HomeState, event: HomeEvent) = HomeMachine.reduce(state, event).state

    fun roster(vararg vaults: VaultLockup) =
        HomeEvent(roster_changed = HomeEvent.RosterChanged(vaults = vaults.toList()))

    fun told(pairing: LaptopPairing, foundedToday: Boolean = false) = HomeEvent(
        backup_known = HomeEvent.BackupKnown(pairing = pairing, founded_today = foundedToday),
    )

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

    fun HomeState.sampleNotice() = data_!!.sample_notice

    fun HomeState.nudge() = data_!!.backup_nudge

    // --- the member's own vault ---------------------------------------------

    "on the day the vault was founded the sample line holds the slot and the nudge waits" {
        val state = withContent(
            send(opened(own, listOf(own, sample)), told(LaptopPairing.LAPTOP_PAIRING_NONE, foundedToday = true)),
        )
        state.sampleNotice() shouldBe true
        state.nudge().shouldBeNull()
        // Waiting is not dismissing: the member has not put the nudge away.
        state.backup_nudge_dismissed shouldBe false
    }

    "after that day the nudge takes the slot, though the sample is still held" {
        val state = withContent(
            send(opened(own, listOf(own, sample)), told(LaptopPairing.LAPTOP_PAIRING_NONE, foundedToday = false)),
        )
        state.sampleNotice() shouldBe false
        state.nudge().shouldNotBeNull()
    }

    "with no sample held the nudge is the only candidate, founding day or not" {
        val state = withContent(
            send(opened(own, listOf(own)), told(LaptopPairing.LAPTOP_PAIRING_NONE, foundedToday = true)),
        )
        state.sampleNotice() shouldBe false
        state.nudge().shouldNotBeNull()
    }

    "removing the sample on the founding day gives the slot back to the nudge" {
        var state = withContent(
            send(opened(own, listOf(own, sample)), told(LaptopPairing.LAPTOP_PAIRING_NONE, foundedToday = true)),
        )
        state.nudge().shouldBeNull()
        state = send(state, roster(own))
        state.sampleNotice() shouldBe false
        state.nudge().shouldNotBeNull()
    }

    "adding the sample back on a later day does not take the slot from the nudge" {
        var state = withContent(
            send(opened(own, listOf(own)), told(LaptopPairing.LAPTOP_PAIRING_NONE, foundedToday = false)),
        )
        state.nudge().shouldNotBeNull()
        state = send(state, roster(own, sample))
        state.sampleNotice() shouldBe false
        state.nudge().shouldNotBeNull()
    }

    // --- the sample vault ---------------------------------------------------

    "on the sample vault the sample line always holds the slot" {
        // Whatever the day: founded_today is the member's vault's fact.
        listOf(true, false).forEach { today ->
            val state = withContent(
                send(opened(sample, listOf(own, sample)), told(LaptopPairing.LAPTOP_PAIRING_NONE, foundedToday = today)),
            )
            state.sampleNotice() shouldBe true
            state.nudge().shouldBeNull()
        }
    }

    "the machine never sets the backup nudge for a sample, whatever the core said about its laptop" {
        // `laptop_paired=false` is what the core answers for a sample; every
        // pairing the session could report, with content, still shows no nudge.
        listOf(
            LaptopPairing.LAPTOP_PAIRING_NONE,
            LaptopPairing.LAPTOP_PAIRING_PAIRED,
            LaptopPairing.LAPTOP_PAIRING_UNSPECIFIED,
        ).forEach { pairing ->
            val state = withContent(send(opened(sample, listOf(sample)), told(pairing)))
            state.nudge().shouldBeNull()
        }
        // And in either order: the fact before the content, and the content before the fact.
        val contentFirst = send(withContent(opened(sample, listOf(own, sample))), told(LaptopPairing.LAPTOP_PAIRING_NONE))
        contentFirst.nudge().shouldBeNull()
    }

    "the sample line also holds the slot when the sample is the only vault" {
        withContent(opened(sample, listOf(sample))).sampleNotice() shouldBe true
    }

    "switching from the sample to the member's own vault drops what was told about the first" {
        var state = withContent(
            send(opened(sample, listOf(own, sample)), told(LaptopPairing.LAPTOP_PAIRING_NONE, foundedToday = true)),
        )
        state.founded_today shouldBe true
        state = send(state, HomeEvent(vault_changed = HomeEvent.VaultChanged(own)))
        state.founded_today shouldBe false
        withContent(state).sampleNotice() shouldBe false
    }

    "a reload on the same vault keeps the founding day it was told" {
        var state = send(opened(own, listOf(own, sample)), told(LaptopPairing.LAPTOP_PAIRING_NONE, foundedToday = true))
        state = send(state, HomeEvent(opened = HomeEvent.Opened()))
        state.founded_today shouldBe true
        withContent(state).sampleNotice() shouldBe true
    }

    // --- first moves --------------------------------------------------------

    "the sample is offered moves like any vault: no app is excluded from them" {
        // Every app idle but Docs: on a member's vault the three leverage-order
        // moves are Photos, Notes and Agenda...
        fun idleMoves(front: VaultLockup): List<String> {
            var state = opened(front, listOf(own, sample))
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
            return state.data_!!.first_moves.map { it.id }
        }
        // Locker is last in leverage order, so only a vault with few idle apps
        // offers it. The sample's Locker holds fake items, so it is not idle
        // there; the sample keeps no exclusion of its own (R-SAMPLE-2, amended).
        FirstMoves.forIdle(listOf("tally", "locker", "people")).map { it.id } shouldBe listOf("people", "tally", "locker")
        idleMoves(sample) shouldBe idleMoves(own)
        idleMoves(own).size shouldBe 3
    }

    // --- founding day -------------------------------------------------------

    "founded today is the LOCAL calendar day, by the device's offset at the time" {
        // It is 2026-10-01T02:30:00Z, which is 22:30 on 30 September in New York.
        val now = DeviceClock.Reading(zone = "America/New_York", epochMillis = 1_790_821_800_000L, utcOffsetMinutes = -240)
        // Twenty minutes earlier, the same local evening.
        FoundingDay.isToday("2026-10-01T02:10:00.000Z", now) shouldBe true
        // Mid-morning on the 30th, local.
        FoundingDay.isToday("2026-09-30T14:00:00.000Z", now) shouldBe true
        // 23:59:59 on the 29th, local: the day before.
        FoundingDay.isToday("2026-09-30T03:59:59.000Z", now) shouldBe false
        // The 1st in UTC is still the 30th here, so it IS today.
        FoundingDay.isToday("2026-10-01T00:00:00.000Z", now) shouldBe true
        FoundingDay.isToday("2026-09-29T23:00:00.000Z", now) shouldBe false
    }

    "founded today in UTC, and a founding time that does not parse is not today" {
        val clock = FakeDeviceClock(zone = "UTC", epochMillis = 1_790_856_000_000L) // 2026-10-01T12:00:00Z
        val now = clock.read()
        FoundingDay.isToday("2026-10-01T00:00:00.000Z", now) shouldBe true
        FoundingDay.isToday("2026-09-30T23:59:59.999Z", now) shouldBe false
        FoundingDay.isToday("", now) shouldBe false
        FoundingDay.isToday("yesterday", now) shouldBe false
        FoundingDay.isToday("2026-13-01T00:00:00Z", now) shouldBe false
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
