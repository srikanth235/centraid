package dev.centraid.shared

import centraid.core.v1.ChangeEvent
import centraid.core.v1.Event
import centraid.core.v1.HealthEvent
import centraid.core.v1.RecordKey
import centraid.core.v1.Value
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ChangeStream
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * A ROW THAT ARRIVES FROM SYNC MOVES THE SCREEN (#1025 S5, D-1025-S5-3).
 *
 * The property the whole change-stream path exists for, asserted without an
 * ABI: [ChangeStream.deliver] is the behaviour and [ChangeStream.start] is four
 * lines of plumbing over it, so the fake core here is a
 * `centraid.core.v1.Event` — which is exactly what a real one hands over.
 *
 * What makes these worth having is that every PIECE of this path already
 * existed and passed its own tests while the path as a whole did nothing at
 * all: a list's `RowsChanged` was reduced correctly since #1020 with no
 * producer anywhere, and `crates/core`'s event queue has nine tests and,
 * until this umbrella, nothing that ever pushed into it. A test of a reducer or
 * of a queue cannot see that; only a test that joins them can.
 */
class ChangeStreamSpec : StringSpec({

    // THE COMMIT-SEQ FIELD IS NOT SET HERE, AND NOT READ (#1029 §1). This
    // fake set it to 7 because the stream passed the number to every machine
    // and no machine ever used it — it was the position a SEAT's overlay
    // settled against, and the overlay left with the log plane. The field is
    // still on the wire, because `crates/api-proto` is another lane's, and no
    // line of this shell reads it.
    fun change(table: String, vararg keys: String): Event = Event(
        change = ChangeEvent(
            table = table,
            pk_set = keys.map { RecordKey(values = listOf(Value(text = it))) },
        ),
    )

    /** Collect a host's effects from now on. Unconfined, so it is live at once. */
    fun watch(host: ScreenHost<*, *>, into: MutableList<ScreenEffect>): Job =
        CoroutineScope(Dispatchers.Unconfined).launch {
            host.effects.collect { into += it }
        }

    /** A paged list showing [ids]. */
    suspend fun listShowing(vararg ids: String): ScreenHost<*, ShownRows.Event> {
        val host = ScreenHost(ShownRows)
        host.send(ShownRows.Event.Shown(ids.toSet()))
        return host
    }

    suspend fun gridShowing(): ScreenHost<*, String> = ScreenHost(RuleAwareGrid)

    "a row a list is showing moves it, with no relaunch and no gesture" {
        val host = listShowing("t-1")
        val effects = mutableListOf<ScreenEffect>()
        val watcher = watch(host, effects)

        val stream = ChangeStream()
        stream.route(host)
        stream.deliver(change("entity", "t-1"))

        // THE SCREEN ASKED FOR ITS PAGE AGAIN. Not "the state changed" — the
        // state cannot change until rows are read, and the re-read IS the
        // deliverable: without it a member sees a gateway's write on the next
        // relaunch.
        effects shouldBe listOf(ScreenEffect.ReadPage(ShownRows.ID, null))
        watcher.cancel()
    }

    "a row the list is not showing moves nothing" {
        val host = listShowing("t-1")
        val effects = mutableListOf<ScreenEffect>()
        val watcher = watch(host, effects)

        val stream = ChangeStream()
        stream.route(host)
        stream.deliver(change("entity", "t-99"))

        // A TAILING PASS APPLIES THOUSANDS OF ROWS. If every one of them made
        // every open screen re-read its page, catching up would cost a page
        // read per row, which is what makes a first sync unusable.
        effects shouldBe emptyList()
        watcher.cancel()
    }

    "a table a screen does not read is not that screen's event" {
        // The routing decision is the MACHINE's, so it is asserted on the
        // machine: a stream holding its own table map would be a second place
        // every screen's reads are written down.
        ShownRows.rowsChanged("media_asset", listOf("ast-1")).shouldBeNull()
        RuleAwareGrid.rowsChanged("note", listOf("t-1")).shouldBeNull()
        RuleAwareGrid.rowsChanged("media_asset", listOf("ast-1")).shouldBeNull()
        RuleAwareGrid.rowsChanged("entity", listOf("t-1")).shouldNotBeNull()
    }

    "a changed rule makes the grid read its page again, and a list does not" {
        // THE RULE IS NOT A ROW (#1080). No `photo` row moved when the
        // member chose a rule, yet every cell's download arrow was derived
        // under the old one; the grid is offered the change through its
        // machine, and a screen whose rows say nothing about what this phone
        // holds answers null and reads nothing.
        val list = listShowing("t-1")
        val photos = gridShowing()
        val listEffects = mutableListOf<ScreenEffect>()
        val photosEffects = mutableListOf<ScreenEffect>()
        val a = watch(list, listEffects)
        val b = watch(photos, photosEffects)

        val stream = ChangeStream()
        stream.route(list)
        stream.route(photos)
        stream.conditionsChanged()

        photosEffects shouldBe listOf(ScreenEffect.ReadPage(RuleAwareGrid.ID, null))
        listEffects shouldBe emptyList()
        ShownRows.conditionsChanged().shouldBeNull()
        RuleAwareGrid.conditionsChanged().shouldNotBeNull()
        a.cancel()
        b.cancel()
    }

    "one change reaches every screen that cares and no others" {
        val list = listShowing("t-1")
        val photos = gridShowing()
        val seen = mutableListOf<String>()
        val scope = CoroutineScope(Dispatchers.Unconfined)
        val a = scope.launch { list.effects.collect { seen += "list" } }
        val b = scope.launch { photos.effects.collect { seen += "photos" } }

        val stream = ChangeStream()
        stream.route(list)
        stream.route(photos)
        stream.deliver(change("photo", "ast-1"))

        seen shouldBe listOf("photos")
        a.cancel()
        b.cancel()
    }

    "a stall is a state the shell can render" {
        val stream = ChangeStream()
        stream.health.value.stalled.shouldBeFalse()
        stream.deliver(
            Event(
                health = HealthEvent(
                    queue_depth = 1024,
                    capacity = 1024,
                    stalled = true,
                    behind = 4_000L,
                ),
            ),
        )
        // `behind` IS A DISTANCE IN LOG POSITIONS, never rows and never
        // seconds: the shell renders "catching up" and never a time remaining.
        stream.health.value shouldBe ChangeStream.Health(
            queueDepth = 1024,
            capacity = 1024,
            stalled = true,
            behind = 4_000uL,
        )
    }
})

/**
 * A GENERIC SCREEN THAT IS A "GRID": it re-reads on a `photo` change and on a
 * changed transfer rule, the two routings Photos' library grid used to
 * exercise here. Photos is Rust's now, so the routing law is asserted on this
 * stand-in; the Rust side is pinned by `crates/screens/tests/photos_home.rs`
 * (its `DataChanged` re-read) and `crates/core/src/events.rs`
 * (`bytes_landing_are_a_change_on_the_photographs_that_own_them`).
 */
private object RuleAwareGrid : ScreenMachine<Int, String> {
    val ID: String = "test.grid"
    override fun initial(): Int = 0
    override fun reduce(state: Int, event: String): Step<Int> =
        Step(state + 1, listOf(ScreenEffect.ReadPage(ID, null)))
    override fun rowsChanged(table: String, keys: List<String>): String? =
        if (table == "photo" || table == "entity") "rows" else null
    override fun seatChanged(seat: centraid.screen.v1.SeatState): String? = null
    override fun conditionsChanged(): String = "conditions"
}

/**
 * A GENERIC SCREEN THAT IS A "LIST": it re-reads on an `entity` change that
 * names a row it shows (or names none), and on nothing else. The kit's trash
 * screen was the stand-in the routing law was first pinned through; it is
 * Rust's now (`kit::trash`, re-rendered by `DataChanged` on the tables its
 * loads read), so the law is asserted on this one.
 */
private object ShownRows : ScreenMachine<Set<String>, ShownRows.Event> {
    const val ID: String = "test.list"

    sealed interface Event {
        data class Shown(val ids: Set<String>) : Event
        data class RowsChanged(val ids: List<String>) : Event
    }

    override fun initial(): Set<String> = emptySet()

    override fun reduce(state: Set<String>, event: Event): Step<Set<String>> = when (event) {
        is Event.Shown -> Step(event.ids)
        is Event.RowsChanged ->
            if (event.ids.isNotEmpty() && event.ids.none { it in state }) {
                Step(state)
            } else {
                Step(state, listOf(ScreenEffect.ReadPage(ID, null)))
            }
    }

    override fun rowsChanged(table: String, keys: List<String>): Event? =
        if (table == "entity") Event.RowsChanged(keys) else null

    override fun seatChanged(seat: centraid.screen.v1.SeatState): Event? = null
}
