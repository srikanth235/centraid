package dev.centraid.shared

import app.cash.turbine.test
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.Loading
import centraid.screen.v1.TrashListData
import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.TrashRow
import centraid.screen.v1.TileCount
import centraid.screen.v1.TileStatus
import dev.centraid.shared.kit.TrashMachine
import dev.centraid.shared.kit.TrashSpec
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeMachine
import dev.centraid.shared.shell.SpringboardPolicy
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.withContext

/**
 * The first screens, as state machines (#1020, D-1020-E3) — a paged list
 * (the kit's), the Photos grid, the Notes editor and the host.
 *
 * Every test here is `(state, event) -> (state, effects)` and nothing else: no
 * dispatcher, no clock, no core. That is the whole reason the screens are pure
 * — it is what makes them provable on a machine with no device.
 */
class ScreenMachineSpec : StringSpec({

    // --- A paged list (the kit's, as every app's trash draws it) ----------

    "a list: a refused read clears the rows and is NOT an empty list" {
        val loaded = list.reduce(
            list.initial(),
            TrashListEvent(data_ = TrashListEvent.DataArrived(TrashListData(rows = twoRows()))),
        ).state
        loaded.data_.shouldNotBeNull().rows.size shouldBe 2

        val refused = list.reduce(
            loaded,
            TrashListEvent(refused = TrashListEvent.ReadRefused(Reads.refused("This is not yours to read."))),
        )
        refused.state.data_.shouldBeNull()
        refused.state.failure.shouldNotBeNull().sentence shouldBe "This is not yours to read."
        // AND NO RE-READ. A retry is a wake, not a reducer's reflex; a reducer
        // that re-read on its own refusal is the 1 s loop the low-disk park
        // exists to stop.
        refused.effects.shouldBeEmpty()
    }

    "a list: an empty list is data with no rows, and the two are different states" {
        val empty = list.reduce(
            list.initial(),
            TrashListEvent(data_ = TrashListEvent.DataArrived(TrashListData())),
        ).state
        empty.data_.shouldNotBeNull().rows.shouldBeEmpty()
        empty.failure.shouldBeNull()

        val refused = list.reduce(
            list.initial(),
            TrashListEvent(refused = TrashListEvent.ReadRefused(Reads.refused("no"))),
        ).state
        (empty == refused).shouldBeFalse()
    }

    "a list: a refresh over rows does not replace them with a spinner" {
        val loaded = list.reduce(
            list.initial(),
            TrashListEvent(data_ = TrashListEvent.DataArrived(TrashListData(rows = twoRows()))),
        ).state
        val refreshed = list.reduce(loaded, TrashListEvent(refreshed = TrashListEvent.Refreshed()))
        refreshed.state.data_.shouldNotBeNull().rows.size shouldBe 2
        refreshed.state.loading.shouldBeNull()
        refreshed.effects shouldBe listOf(ScreenEffect.ReadPage(list.screenId, afterCursor = null))
    }

    "a list: a refresh with nothing to refresh over IS a first load" {
        val refreshed = list.reduce(list.initial(), TrashListEvent(refreshed = TrashListEvent.Refreshed()))
        refreshed.state.loading shouldBe Loading(first_load = true)
    }

    "a list: a later page appends and never duplicates; a first load clears" {
        var state = list.reduce(
            list.initial(),
            TrashListEvent(data_ = TrashListEvent.DataArrived(TrashListData(rows = twoRows(), next_cursor = "c1"))),
        ).state
        // The second page repeats one row, as a page boundary can.
        state = list.reduce(
            state,
            TrashListEvent(data_ = TrashListEvent.DataArrived(TrashListData(rows = listOf(twoRows()[1], row("t-0003"))))),
        ).state
        state.data_.shouldNotBeNull().rows.map { it.id } shouldBe listOf("t-0001", "t-0002", "t-0003")

        // A first load clears, so the next page REPLACES rather than appending.
        list.reduce(state, TrashListEvent(opened = TrashListEvent.Opened())).state.data_.shouldBeNull()
    }

    "a list: a change event for rows this screen is not showing costs nothing" {
        val loaded = list.reduce(
            list.initial(),
            TrashListEvent(data_ = TrashListEvent.DataArrived(TrashListData(rows = twoRows()))),
        ).state
        list.reduce(loaded, TrashListEvent(rows_changed = TrashListEvent.RowsChanged(listOf("t-9999")))).effects.shouldBeEmpty()
        list.reduce(loaded, TrashListEvent(rows_changed = TrashListEvent.RowsChanged(listOf("t-0002")))).effects.size shouldBe 1
    }

    // --- The host ---------------------------------------------------------

    "the host publishes a finished state before it emits the effect that asked for it" {
        val host = ScreenHost(list)
        host.effects.test {
            host.send(TrashListEvent(opened = TrashListEvent.Opened()))
            // The state is already the loading state by the time the effect
            // arrives, so an answer delivered synchronously cannot beat it.
            host.state.value.loading.shouldNotBeNull().first_load.shouldBeTrue()
            awaitItem() shouldBe ScreenEffect.ReadPage(list.screenId, null)
        }
        host.revision shouldBe 1uL
    }

    "the host's revision is monotonic per instance" {
        val host = ScreenHost(list)
        host.send(TrashListEvent(opened = TrashListEvent.Opened()))
        host.send(TrashListEvent(data_ = TrashListEvent.DataArrived(data_ = TrashListData(rows = twoRows()), answered_cursor = "")))
        host.revision shouldBe 2uL
    }

    "CONCURRENT SENDS DO NOT LOSE ONE ANOTHER'S STATE" {
        // Home fans out one read per app and the answers land on whatever
        // threads the core's dispatcher gave them. Before `ScreenHost` took a
        // lock, two answers read the same state, reduced their own event onto
        // it, and the second write threw the first away — so a tile that had
        // arrived went back to LOADING and stayed there. It was invisible on a
        // single-threaded dispatcher and showed up the first time a real core
        // answered from a pool.
        val host = ScreenHost(HomeMachine)
        host.send(HomeEvent(opened = HomeEvent.Opened()))
        val apps = SpringboardPolicy.SPRINGBOARD_ORDER
        withContext(Dispatchers.Default) {
            apps.map { appId ->
                async {
                    host.send(
                        HomeEvent(
                            tile = HomeEvent.TileArrived(
                                app_id = appId,
                                status = TileStatus.TILE_STATUS_CONTENT,
                                count = TileCount(value_ = 1),
                            ),
                        ),
                    )
                }
            }.awaitAll()
        }
        // EVERY one of them, not most of them. A lost update is a tile that
        // never leaves `LOADING`, and the shape of the bug is that it is
        // usually only one or two.
        host.state.value.data_!!.tiles.forEach { tile ->
            withClue(tile.app_id) {
                tile.status shouldBe TileStatus.TILE_STATUS_CONTENT
            }
        }
    }
}) {
    companion object {
        /** A paged list: the kit's trash machine, as every app's trash draws it. */
        val list: TrashMachine = TrashMachine(
            TrashSpec(
                appId = "kit",
                table = "entity",
                restoreCommand = "entity.restore",
                purgeCommand = null,
                emptyCommand = null,
                idColumn = "id",
                titleColumn = "title",
                purgeWindowDays = 30,
            ),
        )

        fun row(id: String): TrashRow = TrashRow(id = id, title = id)

        fun twoRows(): List<TrashRow> = listOf(row("t-0001"), row("t-0002"))
    }
}
