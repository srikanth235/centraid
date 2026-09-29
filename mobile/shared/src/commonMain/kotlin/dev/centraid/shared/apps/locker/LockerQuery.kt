package dev.centraid.shared.apps.locker

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.LockerItemDetail
import centraid.core.v1.LockerItems
import centraid.core.v1.LockerReview
import centraid.core.v1.LockerSearch
import centraid.screen.v1.Denied
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import centraid.screen.v1.WriteSettled
import com.squareup.wire.Message
import com.squareup.wire.ProtoAdapter
import dev.centraid.design.copy.LockerCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * WHAT A LOCKER MACHINE HOLDS (#1047): Tally's shape (`TallyHeld`), plus the
 * two things only Locker has — whether the gate is [open], and a reveal.
 *
 * - [answers] are the core's raw typed answers, kept so a filter or a band tab
 *   re-folds without a read.
 * - [open] is the gate's, delivered as [LockerInput.Lock]. **Nothing is read
 *   while it is false**, and turning it false drops every answer and every
 *   revealed value the machine held (D-5: relock is a wipe, not a curtain).
 * - [asking] is a reveal the bridge must run through the core ([LockerAsk]);
 *   [shown] is one the core answered, with its life.
 */
public data class LockerHeld<S>(
    public val screen: S,
    public val answers: LockerAnswers = LockerAnswers(),
    public val reading: Boolean = false,
    public val readQueued: Boolean = false,
    public val open: Boolean = false,
    public val asking: LockerAsk? = null,
    public val shown: LockerShown? = null,
    /** The last token minted for an ask, a tick or a clipboard. */
    public val tokens: Long = 0L,
)

/** The last answer of each arm a Locker screen asked for. */
public data class LockerAnswers(
    public val items: LockerItems? = null,
    public val item: LockerItemDetail? = null,
    public val search: LockerSearch? = null,
    public val review: LockerReview? = null,
) {
    public fun with(responses: List<AppQueryResponse>): LockerAnswers = LockerAnswers(
        items = responses.firstNotNullOfOrNull { it.locker_items } ?: items,
        item = responses.firstNotNullOfOrNull { it.locker_item } ?: item,
        search = responses.firstNotNullOfOrNull { it.locker_search } ?: search,
        review = responses.firstNotNullOfOrNull { it.locker_review } ?: review,
    )
}

/** A reveal the bridge is to ask the core for: one cell, and why. */
public data class LockerAsk(
    public val token: Long,
    public val itemId: String,
    public val column: String,
    /** Put it on the clipboard instead of on screen. */
    public val copy: Boolean,
    /** Ask for the one-time code the seed makes, not for the cell (Q-1047-16). */
    public val code: Boolean = false,
    /** A shown code that rolls asks once more for the next one (see [LockerShown.follow]). */
    public val follow: Boolean = false,
)

/**
 * A REVEALED VALUE, WITH ITS LIFE. Not a `data class` for [LockerDoorAnswer.Revealed]'s
 * reason: a generated `toString` is a secret in a log line.
 */
public class LockerShown(
    public val itemId: String,
    public val column: String,
    public val value: String,
    public val token: Long,
    /** Seconds the value has left on screen. */
    public val secondsLeft: Int,
    /** A one-time code rather than a cell's plaintext; [secondsLeft] is its step's. */
    public val code: Boolean = false,
    /** The step's length, for a code's countdown. */
    public val period: Int = 0,
    /**
     * When this code rolls, ask for the next one once. A code shown with a
     * few seconds left would otherwise vanish before it could be typed, so the
     * first code follows the roll and the second conceals: every tap shows
     * between one and two steps, and each code is its own receipt.
     */
    public val follow: Boolean = false,
) {
    public fun ticked(): LockerShown = LockerShown(itemId, column, value, token, secondsLeft - 1, code, period, follow)

    override fun toString(): String = "LockerShown($itemId, $column, «concealed», $secondsLeft s)"
}

/**
 * WHAT REACHES A LOCKER MACHINE. A view sends only [View]; everything else is
 * the runtime's or the bridge's, Kotlin-side for Tally's reason.
 */
public sealed interface LockerInput<out E> {
    /**
     * A member's act. [entropy] is fresh CSPRNG bytes the bridge attaches for
     * a screen that generates (`commonMain` has no CSPRNG; a spec passes its
     * own).
     */
    public class View<E>(public val event: E, public val entropy: ByteArray = ByteArray(0)) : LockerInput<E>

    public data class Answered(public val answers: List<AppQueryResponse>) : LockerInput<Nothing>

    public data class Refused(public val failure: ReadFailure) : LockerInput<Nothing>

    public data class Denied(public val denial: AppQueryDenial) : LockerInput<Nothing>

    public data class Changed(public val table: String) : LockerInput<Nothing>

    public data class Seat(public val seat: SeatState) : LockerInput<Nothing>

    public data class Settled(public val settled: WriteSettled) : LockerInput<Nothing>

    /** The gate opened or closed. */
    public data class Lock(public val open: Boolean) : LockerInput<Nothing>

    /** The core answered the reveal asked under [token]. */
    public data class Revealed(public val token: Long, public val answer: LockerDoorAnswer) : LockerInput<Nothing>

    /** A `ScreenEffect.Schedule` came due. */
    public data class Tick(public val token: String) : LockerInput<Nothing>
}

/**
 * THE READ LOOP EVERY LOCKER SCREEN RUNS — Tally's (`TallyQueryMachine`) with
 * the gate in it: a read happens only while [LockerHeld.open]; an answer, a
 * refusal or a denial that lands after a relock is dropped; a relock wipes.
 */
public abstract class LockerQueryMachine<S, E, D>(
    public val screenId: String,
    public val tables: Set<String>,
) : ScreenMachine<LockerHeld<S>, LockerInput<E>> {
    protected abstract val lens: ContentLens<S, D>

    protected abstract fun blank(): S

    protected abstract fun view(held: LockerHeld<S>, event: E, entropy: ByteArray): Step<LockerHeld<S>>

    protected abstract fun fold(held: LockerHeld<S>): D?

    protected open fun decorate(held: LockerHeld<S>): S = held.screen

    protected abstract fun withSeat(screen: S, seat: SeatState): S

    protected open fun absorb(held: LockerHeld<S>): LockerHeld<S> = held

    protected open fun settled(held: LockerHeld<S>, settled: WriteSettled): Step<LockerHeld<S>> = Step(held)

    protected open fun revealed(held: LockerHeld<S>, input: LockerInput.Revealed): Step<LockerHeld<S>> = Step(held)

    protected open fun tick(held: LockerHeld<S>, token: String): Step<LockerHeld<S>> = Step(held)

    /** A row moved under the screen: read again over what is on it. */
    protected open fun changed(held: LockerHeld<S>): Step<LockerHeld<S>> = read(overRows(held))

    /** The gate opened: read what the screen shows. */
    protected open fun reopened(held: LockerHeld<S>): Step<LockerHeld<S>> = reload(held)

    /** What a relock leaves of the screen: its blank, with nothing held. */
    protected open fun wiped(held: LockerHeld<S>): S = lens.with(blank(), ReadContent.Loading(firstLoad = true))

    override fun initial(): LockerHeld<S> = finish(LockerHeld(screen = lens.with(blank(), ReadContent.Loading(firstLoad = true))))

    override fun reduce(state: LockerHeld<S>, event: LockerInput<E>): Step<LockerHeld<S>> {
        val step = when (event) {
            is LockerInput.View -> view(state, event.event, event.entropy)
            is LockerInput.Lock -> lock(state, event.open)
            // A LATE ANSWER TO A LOCKED LOCKER IS DROPPED: it was asked while
            // open and must not paint a covered screen.
            is LockerInput.Answered -> if (state.open) answered(state, event.answers) else Step(state.copy(reading = false))
            is LockerInput.Refused -> if (state.open) ended(state, ReadContent.Failed(event.failure)) else Step(state.copy(reading = false))
            is LockerInput.Denied -> if (state.open) ended(state, ReadContent.Denied(denied())) else Step(state.copy(reading = false))
            is LockerInput.Changed -> changed(state)
            is LockerInput.Seat -> Step(state.copy(screen = withSeat(state.screen, event.seat)))
            is LockerInput.Settled -> settled(state, event.settled)
            is LockerInput.Revealed -> if (state.open && state.asking?.token == event.token) revealed(state, event) else Step(state)
            is LockerInput.Tick -> if (state.open) tick(state, event.token) else Step(state)
        }
        return Step(finish(step.state), step.effects)
    }

    private fun finish(held: LockerHeld<S>): LockerHeld<S> = held.copy(screen = decorate(held))

    override fun rowsChanged(table: String, keys: List<String>): LockerInput<E>? =
        if (table in tables) LockerInput.Changed(table) else null

    override fun seatChanged(seat: SeatState): LockerInput<E> = LockerInput.Seat(seat)

    override fun ticked(token: String): LockerInput<E> = LockerInput.Tick(token)

    private fun lock(held: LockerHeld<S>, open: Boolean): Step<LockerHeld<S>> = when {
        open && !held.open -> reopened(held.copy(open = true))
        open -> Step(held)
        // RELOCK IS A WIPE: every answer, every revealed value and every ask
        // goes, and the screen is its blank until the gate opens again.
        else -> Step(
            LockerHeld(
                screen = withSeat(wiped(held), seatOf(held.screen)),
                open = false,
                tokens = held.tokens,
            ),
        )
    }

    /** The seat the screen is drawing, kept across a wipe. */
    protected abstract fun seatOf(screen: S): SeatState

    /** Ask for a read — only while open — or queue one behind the read out. */
    protected fun read(held: LockerHeld<S>): Step<LockerHeld<S>> = when {
        !held.open -> Step(held)
        held.reading -> Step(held.copy(readQueued = true))
        else -> Step(held.copy(reading = true, readQueued = false), listOf(ScreenEffect.ReadPage(screenId, afterCursor = null)))
    }

    protected fun reload(held: LockerHeld<S>): Step<LockerHeld<S>> = read(
        held.copy(screen = lens.with(held.screen, ReadContent.Loading(firstLoad = true)), answers = LockerAnswers()),
    )

    protected fun overRows(held: LockerHeld<S>): LockerHeld<S> =
        if (lens.content(held.screen) is ReadContent.Data) {
            held
        } else {
            held.copy(screen = lens.with(held.screen, ReadContent.Loading(firstLoad = true)))
        }

    protected fun refold(held: LockerHeld<S>): Step<LockerHeld<S>> {
        if (lens.content(held.screen) !is ReadContent.Data) return Step(held)
        val data = fold(held) ?: return Step(held)
        return Step(held.copy(screen = lens.with(held.screen, ReadContent.Data(data))))
    }

    private fun reissue(held: LockerHeld<S>): Step<LockerHeld<S>> = Step(
        held.copy(reading = true, readQueued = false),
        listOf(ScreenEffect.ReadPage(screenId, afterCursor = null)),
    )

    private fun answered(held: LockerHeld<S>, responses: List<AppQueryResponse>): Step<LockerHeld<S>> {
        if (held.readQueued) return reissue(held)
        val next = absorb(held.copy(answers = held.answers.with(responses), reading = false))
        val data = fold(next)
            ?: return Step(next.copy(screen = lens.with(next.screen, ReadContent.Failed(incomplete()))))
        return Step(next.copy(screen = lens.with(next.screen, ReadContent.Data(data))))
    }

    private fun ended(held: LockerHeld<S>, content: ReadContent<D>): Step<LockerHeld<S>> {
        if (held.readQueued) return reissue(held)
        return Step(held.copy(reading = false, screen = lens.with(held.screen, content)))
    }

    public companion object {
        public fun denied(): Denied = Denied(
            title = LockerCopy.DENIED_TITLE,
            body = LockerCopy.DENIED_BODY,
            receipt = LockerCopy.DENIED_SCOPE,
        )

        internal fun incomplete(): ReadFailure = dev.centraid.shared.screen.Reads.refused(LockerCopy.READ_INCOMPLETE)
    }
}

/**
 * WHAT ONE LOCKER SCREEN ASKS THE CORE, AND HOW ITS WRITES SETTLE.
 *
 * **Nothing while locked**: [requests] answers null when the gate is closed,
 * the second wall behind the machine's own (it emits no read while closed).
 */
public open class LockerQueries<S, E>(
    override val screenId: String,
    override val tables: Set<String>,
    private val ask: (state: LockerHeld<S>, now: DeviceClock.Reading) -> List<AppQueryRequest>?,
) : ScreenQueries<LockerHeld<S>, LockerInput<E>>, ScreenWrites<LockerHeld<S>, LockerInput<E>> {
    override val appId: String = "locker"

    override fun requests(state: LockerHeld<S>, now: DeviceClock.Reading): List<AppQueryRequest>? =
        if (state.open) ask(state, now) else null

    override fun arrived(answers: List<AppQueryResponse>): LockerInput<E> = LockerInput.Answered(answers)

    override fun refused(failure: ReadFailure): LockerInput<E> = LockerInput.Refused(failure)

    override fun denied(denial: AppQueryDenial): LockerInput<E> = LockerInput.Denied(denial)

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): LockerInput<E> =
        LockerInput.Settled(WriteLaw.settledOf(status, sentence, invokeKey))
}

/**
 * WHAT BOTH SHELLS HOLD FOR ONE LOCKER SCREEN — `TallyScreenBridge`'s surface
 * (`attach`, `observe`, `send`, `forward`, `current`, `departed`, `close`),
 * plus the two things a Locker screen needs a runner for:
 *
 * - **the gate**: [gate]'s `open` is forwarded as [LockerInput.Lock], so a
 *   screen reads when the Locker opens and wipes when it closes;
 * - **a reveal**: when the held state carries a new [LockerAsk], the bridge
 *   asks the core through the gate's door and answers [LockerInput.Revealed];
 *   an answer of LOCKED tells the gate the session ended.
 *
 * [entropy] attaches fresh CSPRNG bytes to every view event, for a screen that
 * generates a password.
 */
public open class LockerScreenBridge<S : Message<S, *>, E : Message<E, *>>(
    machine: ScreenMachine<LockerHeld<S>, LockerInput<E>>,
    private val events: ProtoAdapter<E>,
    private val queries: LockerQueries<S, E>,
    private val gate: LockerGate = LockerGate.shared,
    private val entropy: Int = 0,
) {
    public val host: ScreenHost<LockerHeld<S>, LockerInput<E>> = ScreenHost(machine)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var onState: ((ByteArray) -> Unit)? = null
    private var asked: Long = 0L

    @kotlin.concurrent.Volatile
    private var hasLeft: Boolean = false

    public fun attach(session: HomeSession) {
        LockerGate.bind(session)
        session.attachQueries(host, queries, queries, left = { hasLeft })
        start()
    }

    /** [attach] without a session: the gate and the reveal runner only (a spec's seam). */
    internal fun start() {
        scope.launch { gate.open.collect { host.send(LockerInput.Lock(it)) } }
        scope.launch { host.state.map { it.screen }.distinctUntilChanged().collect { onState?.invoke(it.encode()) } }
        scope.launch {
            host.state.map { it.asking }.distinctUntilChanged().collect { ask ->
                if (ask != null && ask.token > asked) {
                    asked = ask.token
                    val answer = if (ask.code) gate.doorway.totp(ask.itemId) else gate.doorway.reveal(ask.itemId, ask.column)
                    if (answer is LockerDoorAnswer.Session &&
                        answer.refusal == centraid.core.v1.LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_LOCKED
                    ) {
                        gate.expired()
                    }
                    host.send(LockerInput.Revealed(ask.token, answer))
                }
            }
        }
    }

    public val screen: S get() = host.state.value.screen

    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        onState(screen.encode())
    }

    public fun send(event: ByteArray) {
        forward(events.decode(event))
    }

    public fun forward(event: E) {
        hasLeft = false
        val bytes = if (entropy > 0) platformServices().secureRandom.bytes(entropy) else ByteArray(0)
        scope.launch { host.send(LockerInput.View(event, bytes)) }
    }

    public fun current(): ByteArray = screen.encode()

    /** The screen closed and the bridge stays: its `Left` conceals what it showed. */
    public fun departed() {
        hasLeft = true
        host.machine.left()?.let { event -> scope.launch { host.send(event) } }
    }

    public fun close() {
        hasLeft = true
        scope.cancel()
    }
}
