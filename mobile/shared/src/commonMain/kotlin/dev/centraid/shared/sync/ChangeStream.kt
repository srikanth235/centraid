package dev.centraid.shared.sync

import centraid.core.v1.Event
import centraid.core.v1.RecordKey
import centraid.screen.v1.SeatState
import dev.centraid.core.CentraidCore
import dev.centraid.shared.screen.ScreenHost
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * THE CHANGE STREAM, CONSUMED (#1025 S5, D-1025-S5-3).
 *
 * ## What was wrong, stated plainly
 *
 * A row that arrived from sync did not move the screen. Not "it was slow" —
 * **nothing in this repository read the change stream at all.** Every piece of
 * the path existed and no two of them were joined:
 *
 * * `crates/core`'s [Event] queue coalesces, stalls and never drops, with nine
 *   tests over it, and until #1025 S5 nothing ever PUSHED a change into it.
 * * `dev.centraid.core.CentraidCore.startReader` runs the `next_event` loop and
 *   publishes [CentraidCore.events], and nothing in `mobile/shared` called it.
 * * `centraid.screen.v1.TallyListEvent.RowsChanged` has existed since #1020,
 *   and `TallyListMachine` already reduces it correctly — re-read the first
 *   page, because a patched row in the wrong position is a list that disagrees
 *   with its own sort — and **no producer ever sent one.**
 *
 * So a member watching a screen saw a gateway's write when they next relaunched
 * the app or pulled to refresh, and a shell that showed a spinner would at
 * least have been honest. This class is the join.
 *
 * ## One coroutine, and where the other one is
 *
 * [start] launches ONE coroutine in the shared module. It is the only thing in
 * `mobile/` that collects [CentraidCore.events], and it also starts the core's
 * own reader — the coroutine that actually blocks in `centraid_next_event` —
 * because a reader nobody started is a queue that fills until sync stalls, and
 * a stall reported to nobody is the worst of the three outcomes.
 *
 * The two are not one coroutine and cannot be: the reader hops to the core
 * dispatcher and blocks on the ABI, and this one delivers into
 * [ScreenHost.send], which suspends on a reduce lock a shell's tap also takes.
 * Doing both on one coroutine would let a screen's own event block the drain of
 * the queue that is telling it to redraw.
 *
 * ## Routing is the machine's decision, not this class's
 *
 * [ScreenMachine.rowsChanged] is asked; `null` is "not mine". This class holds
 * no table names. A router with a table map in it would be a second place every
 * screen's reads are written down, and the two would part company the first
 * time a screen added a query.
 */
public class ChangeStream {
    private val routes = mutableListOf<Route<*, *>>()
    private val _health = MutableStateFlow(Health())
    private val _seat = MutableStateFlow<SeatState?>(null)

    /**
     * How the core is coping, for a screen that renders it.
     *
     * `stalled` is a STATE a member is told about (`crates/core`'s event queue:
     * "slow is a state a member can be told about; wrong is not"), and `behind`
     * is a distance in log positions — never in rows and never in seconds.
     */
    public data class Health(
        public val queueDepth: Int = 0,
        public val capacity: Int = 0,
        public val stalled: Boolean = false,
        public val behind: ULong = 0uL,
    )

    public val health: StateFlow<Health> = _health.asStateFlow()

    private class Route<S, E>(val host: ScreenHost<S, E>) {
        suspend fun deliver(table: String, keys: List<String>, commitSeq: ULong) {
            host.machine.rowsChanged(table, keys, commitSeq)?.let { host.send(it) }
        }

        suspend fun deliver(seat: SeatState) {
            host.machine.seatChanged(seat)?.let { host.send(it) }
        }
    }

    /**
     * Put a screen on the stream. Every routed screen is offered every change;
     * the machine says whether it is its.
     *
     * Registration is additive and there is no removal, because a
     * [ScreenHost] outlives the screen's appearance on screen — a list the
     * member has scrolled away from is a list that must be right when they come
     * back, and un-routing it would make "the screen is stale exactly as long
     * as it was not visible" a thing that can happen.
     */
    public fun <S, E> route(host: ScreenHost<S, E>) {
        routes += Route(host)
    }

    /**
     * TELL EVERY ROUTED SCREEN WHAT THIS SEAT IS (#1025 S5, D-1025-S5-6).
     *
     * Nothing sent a `SeatChanged` before this, on either shell, so every
     * screen held a null `SeatState` for its whole life. What that broke was
     * the write gate, which is gone with the gateway it chose between
     * (#1029 §1); what it still decides is what a screen DRAWS about this
     * device.
     *
     * It is published here rather than by each screen's runtime because it is
     * ONE fact about the device and not one per screen: two screens disagreeing
     * about whether this seat can reach its gateway is not a state the product
     * has.
     */
    public suspend fun publishSeat(seat: SeatState) {
        _seat.value = seat
        routes.toList().forEach { it.deliver(seat) }
    }

    /** The seat as last published, for a shell that renders it directly. */
    public val seat: StateFlow<SeatState?> = _seat.asStateFlow()

    /**
     * Deliver one event to every routed screen.
     *
     * Public because it is the whole behaviour of this class and the only way
     * to test it without an ABI: [start] is four lines of plumbing over it.
     */
    public suspend fun deliver(event: Event) {
        event.health?.let { report ->
            _health.value = Health(
                queueDepth = report.queue_depth,
                capacity = report.capacity,
                stalled = report.stalled,
                // WIRE LOWERS `uint64` TO A SIGNED `Long`. A distance is never
                // negative, so it is carried unsigned above this line and the
                // conversion happens once, here, rather than at every reader.
                behind = report.behind.toULong(),
            )
        }
        val change = event.change ?: return
        // THE KEYS ARE THE EVENT. A change never carries values — that is what
        // makes the core's coalescing lossless — so what a screen gets is the
        // set of keys it should re-read, and re-reading is what it does.
        val keys = change.pk_set.mapNotNull(::textKeyOf)
        // A COPY, BECAUSE DELIVERY SUSPENDS. `host.send` takes a reduce lock and
        // a screen's own effect runner may route another screen while it waits.
        routes.toList().forEach { it.deliver(change.table, keys, change.commit_seq.toULong()) }
    }

    /**
     * A single-column TEXT key, as the one string a screen recognises its own
     * rows by.
     *
     * A `RecordKey` is a LIST of values in declared key order, because a
     * composite key's identity is the whole list — and a composite key has no
     * single string spelling that a screen could compare against an id it is
     * holding. Every table these screens read has a single TEXT primary key
     * (`contracts/schema/vault-ddl.sql`), so a key that is not one is dropped
     * rather than flattened with a separator nothing else in the product uses:
     * an invented spelling would match nothing and would look like a screen
     * that simply does not refresh.
     *
     * The consequence is stated rather than hidden: a screen over a composite
     * key would not move on sync, and it would need a shape for its own ids
     * before it could.
     */
    private fun textKeyOf(key: RecordKey): String? =
        key.values.singleOrNull()?.text

    /**
     * Start the one consumer, and the core's reader under it.
     *
     * Idempotent at the core's end — `startReader` is — and the returned [Job]
     * is cancelled with the scope it was launched in, which for a session is
     * the session's.
     */
    public fun start(core: CentraidCore, scope: CoroutineScope): Job {
        core.startReader()
        return scope.launch {
            core.events.collect { deliver(it) }
        }
    }
}
