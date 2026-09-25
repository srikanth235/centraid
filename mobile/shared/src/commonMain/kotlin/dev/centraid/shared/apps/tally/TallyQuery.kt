package dev.centraid.shared.apps.tally

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.TallyDashboard
import centraid.core.v1.TallyExpense
import centraid.core.v1.TallyFriendLedger
import centraid.core.v1.TallyGroupLedger
import centraid.core.v1.TallyRecurring
import centraid.core.v1.TallySearch
import centraid.core.v1.TallySettleUp
import centraid.core.v1.TallySpending
import centraid.screen.v1.Denied
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import centraid.screen.v1.WriteSettled
import com.squareup.wire.Message
import com.squareup.wire.ProtoAdapter
import dev.centraid.design.copy.TallyCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.platform.DeviceClock
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
 * WHAT A TALLY MACHINE HOLDS (#1046): the state a view draws, and what never
 * reaches one — Agenda's shape (`AgendaHome`), once for all nine screens.
 *
 * - [answers] are the core's RAW typed answers, kept so a local change (a band
 *   tab, Show more, a split method, a typed amount) re-folds without a read.
 *   They cannot ride a screen event: `screen.proto` cannot import
 *   `centraid.core.v1` (Agenda's header says why).
 * - [reading] and [readQueued] keep ONE read in flight. An answer does not say
 *   which request it answers, so a read asked while another is out is queued,
 *   and the older answer is dropped rather than drawn under a state it was not
 *   for.
 */
public data class TallyHeld<S>(
    public val screen: S,
    public val answers: TallyAnswers = TallyAnswers(),
    public val reading: Boolean = false,
    public val readQueued: Boolean = false,
)

/** The last answer of each arm this screen asked for. */
public data class TallyAnswers(
    public val dashboard: TallyDashboard? = null,
    public val group: TallyGroupLedger? = null,
    public val friend: TallyFriendLedger? = null,
    public val expense: TallyExpense? = null,
    public val settleUp: TallySettleUp? = null,
    public val recurring: TallyRecurring? = null,
    public val spending: TallySpending? = null,
    public val search: TallySearch? = null,
) {
    /** These answers, with every arm [responses] carries replacing the held one. */
    public fun with(responses: List<AppQueryResponse>): TallyAnswers = TallyAnswers(
        dashboard = responses.firstNotNullOfOrNull { it.tally_dashboard } ?: dashboard,
        group = responses.firstNotNullOfOrNull { it.tally_group } ?: group,
        friend = responses.firstNotNullOfOrNull { it.tally_friend } ?: friend,
        expense = responses.firstNotNullOfOrNull { it.tally_expense } ?: expense,
        settleUp = responses.firstNotNullOfOrNull { it.tally_settle_up } ?: settleUp,
        recurring = responses.firstNotNullOfOrNull { it.tally_recurring } ?: recurring,
        spending = responses.firstNotNullOfOrNull { it.tally_spending } ?: spending,
        search = responses.firstNotNullOfOrNull { it.tally_search } ?: search,
    )
}

/**
 * WHAT REACHES A TALLY MACHINE. A view sends only [View]; everything else is
 * the runtime's — the answer, the refusal, the denial, a change event, the
 * seat, a write's settle — and is Kotlin-side for [TallyHeld]'s reason.
 */
public sealed interface TallyInput<out E> {
    public data class View<E>(public val event: E) : TallyInput<E>

    public data class Answered(public val answers: List<AppQueryResponse>) : TallyInput<Nothing>

    public data class Refused(public val failure: ReadFailure) : TallyInput<Nothing>

    public data class Denied(public val denial: AppQueryDenial) : TallyInput<Nothing>

    /** A change event touched [table], one of the screen's `tables`. */
    public data class Changed(public val table: String) : TallyInput<Nothing>

    public data class Seat(public val seat: SeatState) : TallyInput<Nothing>

    public data class Settled(public val settled: WriteSettled) : TallyInput<Nothing>
}

/**
 * THE READ LOOP EVERY TALLY SCREEN RUNS: one read in flight, a refusal and a
 * denial as states, a change event as a re-read over the rows on screen, and
 * the fold from the held answers. A screen supplies its events ([view]) and
 * its fold ([fold]); the laws are here once.
 */
public abstract class TallyQueryMachine<S, E, D>(
    public val screenId: String,
    /** Every table this screen's queries read; `rowsChanged` answers for exactly these. */
    public val tables: Set<String>,
) : ScreenMachine<TallyHeld<S>, TallyInput<E>> {
    /** The screen's `content` oneof. */
    protected abstract val lens: ContentLens<S, D>

    /** The screen as it opens, before anything is asked. */
    protected abstract fun blank(): S

    /** A view's event. */
    protected abstract fun view(held: TallyHeld<S>, event: E): Step<TallyHeld<S>>

    /** The data case out of the held answers, or null when they cannot make one. */
    protected abstract fun fold(held: TallyHeld<S>): D?

    /** What every state carries beside the content: chrome, flags. */
    protected open fun decorate(held: TallyHeld<S>): S = held.screen

    protected abstract fun withSeat(screen: S, seat: SeatState): S

    /**
     * The answers just landed, before the fold: a screen whose own state is
     * seeded from them (the editor's form) does it here.
     */
    protected open fun absorb(held: TallyHeld<S>): TallyHeld<S> = held

    /** A write's settle. Screens with no write keep the default. */
    protected open fun settled(held: TallyHeld<S>, settled: WriteSettled): Step<TallyHeld<S>> = Step(held)

    override fun initial(): TallyHeld<S> = finish(TallyHeld(screen = lens.with(blank(), ReadContent.Loading(firstLoad = true))))

    override fun reduce(state: TallyHeld<S>, event: TallyInput<E>): Step<TallyHeld<S>> {
        val step = when (event) {
            is TallyInput.View -> view(state, event.event)
            is TallyInput.Answered -> answered(state, event.answers)
            is TallyInput.Refused -> ended(state, ReadContent.Failed(event.failure))
            is TallyInput.Denied -> ended(state, ReadContent.Denied(denied()))
            // A ROW MOVED: read again over what is on screen.
            is TallyInput.Changed -> read(overRows(state))
            is TallyInput.Seat -> Step(state.copy(screen = withSeat(state.screen, event.seat)))
            is TallyInput.Settled -> settled(state, event.settled)
        }
        return Step(finish(step.state), step.effects)
    }

    private fun finish(held: TallyHeld<S>): TallyHeld<S> = held.copy(screen = decorate(held))

    override fun rowsChanged(table: String, keys: List<String>): TallyInput<E>? =
        if (table in tables) TallyInput.Changed(table) else null

    override fun seatChanged(seat: SeatState): TallyInput<E> = TallyInput.Seat(seat)

    /** Ask for a read, or queue one behind the read already out. */
    protected fun read(held: TallyHeld<S>): Step<TallyHeld<S>> =
        if (held.reading) {
            Step(held.copy(readQueued = true))
        } else {
            Step(
                held.copy(reading = true, readQueued = false),
                listOf(ScreenEffect.ReadPage(screenId, afterCursor = null)),
            )
        }

    /** A fresh subject: skeletons and a read, and nothing held from before. */
    protected fun reload(held: TallyHeld<S>): Step<TallyHeld<S>> = read(
        held.copy(
            screen = lens.with(held.screen, ReadContent.Loading(firstLoad = true)),
            answers = TallyAnswers(),
        ),
    )

    /** A read that keeps the rows on screen when there are rows, else skeletons. */
    protected fun overRows(held: TallyHeld<S>): TallyHeld<S> =
        if (lens.content(held.screen) is ReadContent.Data) {
            held
        } else {
            held.copy(screen = lens.with(held.screen, ReadContent.Loading(firstLoad = true)))
        }

    /**
     * FOLD THE HELD ANSWERS AGAIN — only over a screen already drawing data:
     * a local change during a skeleton or a failure must not conjure rows.
     */
    protected fun refold(held: TallyHeld<S>): Step<TallyHeld<S>> {
        if (lens.content(held.screen) !is ReadContent.Data) return Step(held)
        val data = fold(held) ?: return Step(held)
        return Step(held.copy(screen = lens.with(held.screen, ReadContent.Data(data))))
    }

    private fun reissue(held: TallyHeld<S>): Step<TallyHeld<S>> = Step(
        held.copy(reading = true, readQueued = false),
        listOf(ScreenEffect.ReadPage(screenId, afterCursor = null)),
    )

    private fun answered(held: TallyHeld<S>, responses: List<AppQueryResponse>): Step<TallyHeld<S>> {
        if (held.readQueued) return reissue(held)
        val next = absorb(held.copy(answers = held.answers.with(responses), reading = false))
        val data = fold(next)
            // A SHORT ANSWER IS NOT A WHOLE ONE, and none is made up.
            ?: return Step(next.copy(screen = lens.with(next.screen, ReadContent.Failed(incomplete()))))
        return Step(next.copy(screen = lens.with(next.screen, ReadContent.Data(data))))
    }

    /** A refusal or a denial: the state, unless a newer read is queued. */
    private fun ended(held: TallyHeld<S>, content: ReadContent<D>): Step<TallyHeld<S>> {
        if (held.readQueued) return reissue(held)
        return Step(held.copy(reading = false, screen = lens.with(held.screen, content)))
    }

    public companion object {
        /** The gate's words (the handoff's denied state, less the sharing line). */
        public fun denied(): Denied = Denied(
            title = TallyCopy.DENIED_TITLE,
            body = "${TallyCopy.DENIED_BODY} ${TallyCopy.DENIED_REGRANT}",
            receipt = TallyCopy.DENIED_SCOPE,
        )

        internal fun incomplete(): ReadFailure =
            dev.centraid.shared.screen.Reads.refused(TallyCopy.READ_INCOMPLETE)
    }
}

/**
 * WHAT ONE TALLY SCREEN ASKS THE CORE, AND HOW ITS WRITES SETTLE — one object
 * per screen, [requests] its only difference.
 */
public open class TallyQueries<S, E>(
    override val screenId: String,
    override val tables: Set<String>,
    private val ask: (state: TallyHeld<S>, now: DeviceClock.Reading) -> List<AppQueryRequest>?,
) : ScreenQueries<TallyHeld<S>, TallyInput<E>>, ScreenWrites<TallyHeld<S>, TallyInput<E>> {
    override val appId: String = "tally"

    override fun requests(state: TallyHeld<S>, now: DeviceClock.Reading): List<AppQueryRequest>? = ask(state, now)

    override fun arrived(answers: List<AppQueryResponse>): TallyInput<E> = TallyInput.Answered(answers)

    override fun refused(failure: ReadFailure): TallyInput<E> = TallyInput.Refused(failure)

    /** The handoff's gate, a state (`Denied`), not a refusal. */
    override fun denied(denial: AppQueryDenial): TallyInput<E> = TallyInput.Denied(denial)

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): TallyInput<E> =
        TallyInput.Settled(WriteLaw.settledOf(status, sentence, invokeKey))
}

/**
 * WHAT BOTH SHELLS HOLD FOR ONE TALLY SCREEN. `AgendaBridge`'s shape: bytes
 * across to SwiftUI, nothing `suspend`, and only [screen] ever leaves — the
 * raw answers stay in [TallyHeld]. Each screen names a subclass so the Swift
 * symbol is the screen's own (`TallyHomeBridge`, …).
 */
public open class TallyScreenBridge<S : Message<S, *>, E : Message<E, *>>(
    machine: ScreenMachine<TallyHeld<S>, TallyInput<E>>,
    private val events: ProtoAdapter<E>,
    private val queries: TallyQueries<S, E>,
) {
    /** One host per bridge, never re-created (`ChangeStream.route` holds it). */
    public val host: ScreenHost<TallyHeld<S>, TallyInput<E>> = ScreenHost(machine)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var onState: ((ByteArray) -> Unit)? = null

    @kotlin.concurrent.Volatile
    private var hasLeft: Boolean = false

    /** Put this screen on the session's core, once per bridge, and publish. */
    public fun attach(session: HomeSession) {
        session.attachQueries(host, queries, queries, left = { hasLeft })
        scope.launch {
            host.state.map { it.screen }.distinctUntilChanged().collect { screen ->
                onState?.invoke(screen.encode())
            }
        }
    }

    /** The screen a view draws, now (Compose). */
    public val screen: S get() = host.state.value.screen

    /** Publish every screen state to [onState], starting with the current one. */
    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        onState(screen.encode())
    }

    /** Forward one event, encoded (SwiftUI). */
    public fun send(event: ByteArray) {
        forward(events.decode(event))
    }

    /** Forward one event (Compose). Named apart from [send] so Swift sees one `send(event:)`. */
    public fun forward(event: E) {
        hasLeft = false
        scope.launch { host.send(TallyInput.View(event)) }
    }

    /** The current screen state, encoded. */
    public fun current(): ByteArray = screen.encode()

    /** The screen closed and the bridge stays: a write in flight is reported as stranded if it fails. */
    public fun departed() {
        hasLeft = true
    }

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        hasLeft = true
        scope.cancel()
    }
}

/**
 * THE TABLES A LEDGER READ FOLDS. `load_tally` reads every one of them for any
 * of the ledger queries (`crates/apps/tally/src/queries.rs`), so a change to
 * any of them can move any figure on any ledger screen.
 */
public val TALLY_LEDGER_TABLES: Set<String> = setOf(
    "tally_expense",
    "tally_expense_split",
    "tally_expense_payer",
    "tally_expense_line_item",
    "tally_expense_line_allocation",
    "tally_settlement",
    "tally_group",
    "tally_friend",
    "tally_obligation",
    "social_circle",
    "social_circle_member",
    "core_party",
)
