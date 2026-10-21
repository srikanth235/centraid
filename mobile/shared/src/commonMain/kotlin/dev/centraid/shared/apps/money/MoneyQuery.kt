package dev.centraid.shared.apps.money

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.MoneyAccounts
import centraid.core.v1.MoneyActivity
import centraid.core.v1.MoneyCashflow
import centraid.core.v1.MoneyCategories
import centraid.core.v1.MoneyImportPlan
import centraid.core.v1.MoneyRecurring
import centraid.core.v1.MoneyRules
import centraid.core.v1.MoneySearch
import centraid.core.v1.MoneySpending
import centraid.core.v1.MoneyTargetSheet
import centraid.core.v1.MoneyTransaction
import centraid.screen.v1.Denied
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import centraid.screen.v1.WriteSettled
import dev.centraid.design.copy.MoneyCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/**
 * WHAT A MONEY MACHINE HOLDS (#1099): the state a view draws, and what never
 * reaches one. The shape is Tasks' and Agenda's.
 *
 * - [answers] are the core's RAW typed answers, kept so a local change (a
 *   sheet, Show more, a typed amount) re-folds without a read. They cannot ride
 *   a screen event: `screen.proto` cannot import `centraid.core.v1`.
 * - [reading] and [readQueued] keep ONE read in flight. An answer does not say
 *   which request it answers, so a read asked while another is out is queued,
 *   and the older answer is dropped rather than drawn under a state it was not
 *   for.
 * - [file], [plan], [job] and [pending] are the import page's: the picked
 *   statement, its plan, the plan or publish being worked, and the commands
 *   still to send. Statement bytes live here and are dropped on leaving; they
 *   are never drawn and never stored.
 */
public data class MoneyHeld<S>(
    public val screen: S,
    public val answers: MoneyAnswers = MoneyAnswers(),
    public val reading: Boolean = false,
    public val readQueued: Boolean = false,
    public val file: MoneyFile? = null,
    public val plan: MoneyImportPlan? = null,
    public val job: MoneyJob? = null,
    public val tokens: Long = 0L,
    public val pending: List<String> = emptyList(),
)

/** A statement as picked: its name and its bytes. Not a `data class`, so the bytes never print. */
public class MoneyFile(public val name: String, public val bytes: ByteArray) {
    override fun toString(): String = "MoneyFile($name, ${bytes.size} bytes)"
}

/** A plan in flight, run once per [token] by the bridge. */
public data class MoneyJob(public val token: Long)

/** The last answer of each arm this screen asked for. */
public data class MoneyAnswers(
    public val spending: MoneySpending? = null,
    public val activity: MoneyActivity? = null,
    public val transaction: MoneyTransaction? = null,
    public val cashflow: MoneyCashflow? = null,
    public val accounts: MoneyAccounts? = null,
    public val rules: MoneyRules? = null,
    public val categories: MoneyCategories? = null,
    public val target: MoneyTargetSheet? = null,
    public val recurring: MoneyRecurring? = null,
    public val search: MoneySearch? = null,
) {
    /** These answers, with every arm [responses] carries replacing the held one. */
    public fun with(responses: List<AppQueryResponse>): MoneyAnswers = MoneyAnswers(
        spending = responses.firstNotNullOfOrNull { it.money_spending } ?: spending,
        activity = responses.firstNotNullOfOrNull { it.money_activity } ?: activity,
        transaction = responses.firstNotNullOfOrNull { it.money_transaction } ?: transaction,
        cashflow = responses.firstNotNullOfOrNull { it.money_cashflow } ?: cashflow,
        accounts = responses.firstNotNullOfOrNull { it.money_accounts } ?: accounts,
        rules = responses.firstNotNullOfOrNull { it.money_rules } ?: rules,
        categories = responses.firstNotNullOfOrNull { it.money_categories } ?: categories,
        target = responses.firstNotNullOfOrNull { it.money_target_sheet } ?: target,
        recurring = responses.firstNotNullOfOrNull { it.money_recurring } ?: recurring,
        search = responses.firstNotNullOfOrNull { it.money_search } ?: search,
    )
}

/**
 * WHAT REACHES A MONEY MACHINE. A view sends only [View]; everything else is
 * the runtime's: the answer, the refusal, the denial, a change event, the seat,
 * a write's settle, and the import page's picked file and plan.
 */
public sealed interface MoneyInput<out E> {
    public data class View<E>(public val event: E) : MoneyInput<E>

    public data class Answered(public val answers: List<AppQueryResponse>) : MoneyInput<Nothing>

    public data class Refused(public val failure: ReadFailure) : MoneyInput<Nothing>

    public data class Denied(public val denial: AppQueryDenial) : MoneyInput<Nothing>

    /** A change event touched [table], one of the screen's `tables`. */
    public data class Changed(public val table: String) : MoneyInput<Nothing>

    public data class Seat(public val seat: SeatState) : MoneyInput<Nothing>

    public data class Settled(public val settled: WriteSettled) : MoneyInput<Nothing>

    /** The OS picker's file. */
    public class Picked(public val name: String, public val bytes: ByteArray) : MoneyInput<Nothing> {
        override fun toString(): String = "Picked($name, ${bytes.size} bytes)"
    }

    /** The plan [token] asked for came back (or the core could not be asked). */
    public data class Planned(public val token: Long, public val outcome: MoneyPlanOutcome) : MoneyInput<Nothing>
}

/** What planning a statement came back as. */
public sealed interface MoneyPlanOutcome {
    public data class Plan(public val plan: MoneyImportPlan) : MoneyPlanOutcome

    public data class Unreachable(public val sentence: String) : MoneyPlanOutcome
}

/**
 * THE READ LOOP EVERY MONEY SCREEN RUNS: one read in flight, a refusal and a
 * denial as states, a change event as a re-read over the rows on screen, and
 * the fold from the held answers. A screen supplies its events ([view]) and its
 * fold ([fold]); the laws are here once.
 */
public abstract class MoneyQueryMachine<S, E, D>(
    public val screenId: String,
    /** Every table this screen's queries read; `rowsChanged` answers for exactly these. */
    public val tables: Set<String>,
) : ScreenMachine<MoneyHeld<S>, MoneyInput<E>> {
    /** The screen's `content` oneof. */
    protected abstract val lens: ContentLens<S, D>

    /** The screen as it opens, before anything is asked. */
    protected abstract fun blank(): S

    /** A view's event. */
    protected abstract fun view(held: MoneyHeld<S>, event: E): Step<MoneyHeld<S>>

    /** The data case out of the held answers, or null when they cannot make one. */
    protected abstract fun fold(held: MoneyHeld<S>): D?

    /** What every state carries beside the content: chrome, flags. */
    protected open fun decorate(held: MoneyHeld<S>): S = held.screen

    protected abstract fun withSeat(screen: S, seat: SeatState): S

    /** The answers just landed, before the fold: a screen seeded from them does it here. */
    protected open fun absorb(held: MoneyHeld<S>): MoneyHeld<S> = held

    /** The read was REFUSED or DENIED: what the last answer left on the state is no longer on screen. */
    protected open fun unanswered(held: MoneyHeld<S>): MoneyHeld<S> = held

    /**
     * DOES A VIEW EVENT RE-FOLD THE HELD ANSWERS? Yes by default: a sheet, a
     * draft, a dismissed offer or a typed amount changes what the data case
     * says, and a screen that waited for the next read to say it would draw
     * the old words. A search says no: its rows answer the term they were read
     * for, not the one being typed.
     */
    protected open val refoldsOnView: Boolean get() = true

    /** Has this screen nothing to read right now (a search with no term)? A change then asks nothing. */
    protected open fun idle(held: MoneyHeld<S>): Boolean = false

    /** A write's settle. Screens with no write keep the default. */
    protected open fun settled(held: MoneyHeld<S>, settled: WriteSettled): Step<MoneyHeld<S>> = Step(held)

    /** The OS picker's file. Only the import page takes one. */
    protected open fun picked(held: MoneyHeld<S>, input: MoneyInput.Picked): Step<MoneyHeld<S>> = Step(held)

    /** A plan came back. Only the import page asks for one. */
    protected open fun planned(held: MoneyHeld<S>, input: MoneyInput.Planned): Step<MoneyHeld<S>> = Step(held)

    override fun initial(): MoneyHeld<S> = finish(MoneyHeld(screen = lens.with(blank(), ReadContent.Loading(firstLoad = true))))

    override fun reduce(state: MoneyHeld<S>, event: MoneyInput<E>): Step<MoneyHeld<S>> {
        val step = when (event) {
            is MoneyInput.View -> refoldView(view(state, event.event))
            is MoneyInput.Answered -> answered(state, event.answers)
            is MoneyInput.Refused -> ended(state, ReadContent.Failed(event.failure))
            is MoneyInput.Denied -> ended(state, ReadContent.Denied(denied()))
            // A ROW MOVED: read again over what is on screen.
            is MoneyInput.Changed -> if (idle(state)) Step(state) else read(overRows(state))
            is MoneyInput.Seat -> Step(state.copy(screen = withSeat(state.screen, event.seat)))
            is MoneyInput.Settled -> settled(state, event.settled)
            is MoneyInput.Picked -> picked(state, event)
            is MoneyInput.Planned -> if (state.job?.token == event.token) planned(state, event) else Step(state)
        }
        return Step(finish(step.state), step.effects)
    }

    private fun finish(held: MoneyHeld<S>): MoneyHeld<S> = held.copy(screen = decorate(held))

    private fun refoldView(step: Step<MoneyHeld<S>>): Step<MoneyHeld<S>> {
        if (!refoldsOnView) return step
        val held = step.state
        if (lens.content(held.screen) !is ReadContent.Data) return step
        val data = fold(held) ?: return step
        return Step(held.copy(screen = lens.with(held.screen, ReadContent.Data(data))), step.effects)
    }

    override fun rowsChanged(table: String, keys: List<String>): MoneyInput<E>? =
        if (table in tables) MoneyInput.Changed(table) else null

    override fun seatChanged(seat: SeatState): MoneyInput<E> = MoneyInput.Seat(seat)

    /** Ask for a read, or queue one behind the read already out. */
    protected fun read(held: MoneyHeld<S>): Step<MoneyHeld<S>> =
        if (held.reading) {
            Step(held.copy(readQueued = true))
        } else {
            Step(
                held.copy(reading = true, readQueued = false),
                listOf(ScreenEffect.ReadPage(screenId, afterCursor = null)),
            )
        }

    /** A fresh subject: skeletons and a read, and nothing held from before. */
    protected fun reload(held: MoneyHeld<S>): Step<MoneyHeld<S>> = read(
        held.copy(
            screen = lens.with(held.screen, ReadContent.Loading(firstLoad = true)),
            answers = MoneyAnswers(),
        ),
    )

    /** A read that keeps the rows on screen when there are rows, else skeletons. */
    protected fun overRows(held: MoneyHeld<S>): MoneyHeld<S> =
        if (lens.content(held.screen) is ReadContent.Data) {
            held
        } else {
            held.copy(screen = lens.with(held.screen, ReadContent.Loading(firstLoad = true)))
        }

    /**
     * FOLD THE HELD ANSWERS AGAIN: only over a screen already drawing data, so a
     * local change during a skeleton or a failure does not conjure rows.
     */
    protected fun refold(held: MoneyHeld<S>): Step<MoneyHeld<S>> {
        if (lens.content(held.screen) !is ReadContent.Data) return Step(held)
        val data = fold(held) ?: return Step(held)
        return Step(held.copy(screen = lens.with(held.screen, ReadContent.Data(data))))
    }

    private fun reissue(held: MoneyHeld<S>): Step<MoneyHeld<S>> = Step(
        held.copy(reading = true, readQueued = false),
        listOf(ScreenEffect.ReadPage(screenId, afterCursor = null)),
    )

    private fun answered(held: MoneyHeld<S>, responses: List<AppQueryResponse>): Step<MoneyHeld<S>> {
        if (held.readQueued) return reissue(held)
        val next = absorb(held.copy(answers = held.answers.with(responses), reading = false))
        val data = fold(next)
            // A SHORT ANSWER IS NOT A WHOLE ONE, and none is made up.
            ?: return Step(next.copy(screen = lens.with(next.screen, ReadContent.Failed(incomplete()))))
        return Step(next.copy(screen = lens.with(next.screen, ReadContent.Data(data))))
    }

    /** A refusal or a denial: the state, unless a newer read is queued. */
    private fun ended(held: MoneyHeld<S>, content: ReadContent<D>): Step<MoneyHeld<S>> {
        if (held.readQueued) return reissue(held)
        val cleared = unanswered(held)
        return Step(cleared.copy(reading = false, screen = lens.with(cleared.screen, content)))
    }

    public companion object {
        /** The gate's words. */
        public fun denied(): Denied = Denied(
            title = MoneyCopy.DENIED_TITLE,
            body = MoneyCopy.DENIED_BODY,
            receipt = MoneyCopy.DENIED_SCOPE,
        )

        internal fun incomplete(): ReadFailure =
            dev.centraid.shared.screen.Reads.refused(MoneyCopy.READ_INCOMPLETE)
    }
}

/**
 * WHAT ONE MONEY SCREEN ASKS THE CORE, AND HOW ITS WRITES SETTLE: one object per
 * screen, [ask] its only difference.
 */
public open class MoneyQueries<S, E>(
    override val screenId: String,
    override val tables: Set<String>,
    private val ask: (state: MoneyHeld<S>, now: DeviceClock.Reading) -> List<AppQueryRequest>?,
) : ScreenQueries<MoneyHeld<S>, MoneyInput<E>>, ScreenWrites<MoneyHeld<S>, MoneyInput<E>> {
    override val appId: String = "money"

    override fun requests(state: MoneyHeld<S>, now: DeviceClock.Reading): List<AppQueryRequest>? = ask(state, now)

    override fun arrived(answers: List<AppQueryResponse>): MoneyInput<E> = MoneyInput.Answered(answers)

    override fun refused(failure: ReadFailure): MoneyInput<E> = MoneyInput.Refused(failure)

    /** The gate, a state (`Denied`), not a refusal. */
    override fun denied(denial: AppQueryDenial): MoneyInput<E> = MoneyInput.Denied(denial)

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): MoneyInput<E> =
        MoneyInput.Settled(WriteLaw.settledOf(status, sentence, invokeKey))
}

/**
 * EVERY TABLE A MONEY SCREEN'S QUERIES READ (`crates/apps/money/src/queries.rs`):
 * the lines (`txn`), their names and trash (`entity`), what the bank said
 * (`source`), the accounts (`account`) with their bank numbers and layouts
 * (`origin`), the archived flag (`edge`), the categories (`concept`), the plans
 * (`budget`), the rules (`rule`) and the balances the bank stated
 * (`checkpoint`), so a change to any of them can move any figure on any Money
 * screen. It is the manifest's read scopes, no more.
 */
public val MONEY_TABLES: Set<String> = setOf(
    "account",
    "budget",
    "checkpoint",
    "concept",
    "edge",
    "entity",
    "origin",
    "rule",
    "source",
    "txn",
)
