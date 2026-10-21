package dev.centraid.shared.apps.health

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.HealthSeries
import centraid.core.v1.HealthToday
import centraid.core.v1.HealthTrends
import centraid.core.v1.HealthWorkout
import centraid.core.v1.HealthWorkouts
import centraid.screen.v1.Denied
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import dev.centraid.design.copy.HealthCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ScreenQueries

/**
 * WHAT A HEALTH MACHINE HOLDS (#1129): the state a view draws, the core's raw typed answers
 * (kept so a tab, a range or a sheet re-folds without a read; `screen.proto` cannot import
 * `centraid.core.v1`), and ONE read in flight — Money's shape. Everything civil in an answer
 * (today, a workout's wall clock) is the core's, placed in the zone the request stated.
 */
public data class HealthHeld<S>(
    public val screen: S,
    public val answers: HealthAnswers = HealthAnswers(),
    public val reading: Boolean = false,
    public val readQueued: Boolean = false,
)

/** The last answer of each arm a screen asked for. */
public data class HealthAnswers(
    public val today: HealthToday? = null,
    public val series: HealthSeries? = null,
    public val trends: HealthTrends? = null,
    public val workouts: HealthWorkouts? = null,
    public val workout: HealthWorkout? = null,
) {
    public fun with(responses: List<AppQueryResponse>): HealthAnswers = HealthAnswers(
        today = responses.firstNotNullOfOrNull { it.health_today } ?: today,
        series = responses.firstNotNullOfOrNull { it.health_series } ?: series,
        trends = responses.firstNotNullOfOrNull { it.health_trends } ?: trends,
        workouts = responses.firstNotNullOfOrNull { it.health_workouts } ?: workouts,
        workout = responses.firstNotNullOfOrNull { it.health_workout } ?: workout,
    )
}

/** WHAT REACHES A HEALTH MACHINE. A view sends only [View]; the rest is the runtime's. */
public sealed interface HealthInput<out E> {
    public data class View<E>(public val event: E) : HealthInput<E>

    public data class Answered(public val answers: List<AppQueryResponse>) : HealthInput<Nothing>

    public data class Refused(public val failure: ReadFailure) : HealthInput<Nothing>

    public data class Denied(public val denial: AppQueryDenial) : HealthInput<Nothing>

    /** A change event touched [table], one of the screen's `tables`. */
    public data class Changed(public val table: String) : HealthInput<Nothing>

    public data class Seat(public val seat: SeatState) : HealthInput<Nothing>
}

/**
 * THE READ LOOP EVERY HEALTH SCREEN RUNS: one read in flight, a refusal and a denial as states, a
 * change event as a re-read over the rows on screen, and the fold from the held answers. A screen
 * supplies its events ([view]) and its fold ([fold]).
 */
public abstract class HealthQueryMachine<S, E, D>(
    public val screenId: String,
    /** Every table this screen's queries read; `rowsChanged` answers for exactly these. */
    public val tables: Set<String>,
) : ScreenMachine<HealthHeld<S>, HealthInput<E>> {
    protected abstract val lens: ContentLens<S, D>

    protected abstract fun blank(): S

    protected abstract fun view(held: HealthHeld<S>, event: E): Step<HealthHeld<S>>

    /** The data case out of the held answers, or null when they cannot make one. */
    protected abstract fun fold(held: HealthHeld<S>): D?

    /** What every state carries beside the content: chrome, band, sheets. */
    protected open fun decorate(held: HealthHeld<S>): S = held.screen

    protected abstract fun withSeat(screen: S, seat: SeatState): S

    override fun initial(): HealthHeld<S> = finish(HealthHeld(screen = lens.with(blank(), ReadContent.Loading(firstLoad = true))))

    override fun reduce(state: HealthHeld<S>, event: HealthInput<E>): Step<HealthHeld<S>> {
        val step = when (event) {
            is HealthInput.View -> refoldView(view(state, event.event))
            is HealthInput.Answered -> answered(state, event.answers)
            is HealthInput.Refused -> ended(state, ReadContent.Failed(event.failure))
            is HealthInput.Denied -> ended(state, ReadContent.Denied(denied()))
            is HealthInput.Changed -> read(overRows(state))
            is HealthInput.Seat -> Step(state.copy(screen = withSeat(state.screen, event.seat)))
        }
        return Step(finish(step.state), step.effects)
    }

    private fun finish(held: HealthHeld<S>): HealthHeld<S> = held.copy(screen = decorate(held))

    private fun refoldView(step: Step<HealthHeld<S>>): Step<HealthHeld<S>> {
        val held = step.state
        if (lens.content(held.screen) !is ReadContent.Data) return step
        val data = fold(held) ?: return step
        return Step(held.copy(screen = lens.with(held.screen, ReadContent.Data(data))), step.effects)
    }

    override fun rowsChanged(table: String, keys: List<String>): HealthInput<E>? =
        if (table in tables) HealthInput.Changed(table) else null

    override fun seatChanged(seat: SeatState): HealthInput<E> = HealthInput.Seat(seat)

    /** Ask for a read, or queue one behind the read already out. */
    protected fun read(held: HealthHeld<S>): Step<HealthHeld<S>> =
        if (held.reading) {
            Step(held.copy(readQueued = true))
        } else {
            Step(held.copy(reading = true, readQueued = false), listOf(ScreenEffect.ReadPage(screenId, afterCursor = null)))
        }

    /** A fresh subject: skeletons and a read, nothing held from before. */
    protected fun reload(held: HealthHeld<S>): Step<HealthHeld<S>> = read(
        held.copy(screen = lens.with(held.screen, ReadContent.Loading(firstLoad = true)), answers = HealthAnswers()),
    )

    /** A read that keeps the rows on screen when there are rows, else skeletons. */
    protected fun overRows(held: HealthHeld<S>): HealthHeld<S> =
        if (lens.content(held.screen) is ReadContent.Data) {
            held
        } else {
            held.copy(screen = lens.with(held.screen, ReadContent.Loading(firstLoad = true)))
        }

    private fun answered(held: HealthHeld<S>, responses: List<AppQueryResponse>): Step<HealthHeld<S>> {
        if (held.readQueued) return reissue(held)
        val next = held.copy(answers = held.answers.with(responses), reading = false)
        val data = fold(next)
            // A SHORT ANSWER IS NOT A WHOLE ONE, and none is made up.
            ?: return Step(next.copy(screen = lens.with(next.screen, ReadContent.Failed(incomplete()))))
        return Step(next.copy(screen = lens.with(next.screen, ReadContent.Data(data))))
    }

    private fun reissue(held: HealthHeld<S>): Step<HealthHeld<S>> = Step(
        held.copy(reading = true, readQueued = false),
        listOf(ScreenEffect.ReadPage(screenId, afterCursor = null)),
    )

    private fun ended(held: HealthHeld<S>, content: ReadContent<D>): Step<HealthHeld<S>> {
        if (held.readQueued) return reissue(held)
        return Step(held.copy(reading = false, screen = lens.with(held.screen, content)))
    }

    public companion object {
        public fun denied(): Denied = Denied(
            title = HealthCopy.DENIED_TITLE,
            body = HealthCopy.DENIED_BODY,
            receipt = HealthCopy.DENIED_SCOPE,
        )

        internal fun incomplete(): ReadFailure = dev.centraid.shared.screen.Reads.refused(HealthCopy.READ_INCOMPLETE)
    }
}

/**
 * WHAT ONE HEALTH SCREEN ASKS THE CORE: one object per screen, [ask] its only difference. Every
 * request states the device's zone, and the core places today, a day's bounds and each
 * workout's wall clock in it (RP-K-2): nothing here does date arithmetic.
 */
public open class HealthQueries<S, E>(
    override val screenId: String,
    override val tables: Set<String>,
    private val ask: (state: HealthHeld<S>, tz: String) -> List<AppQueryRequest>?,
) : ScreenQueries<HealthHeld<S>, HealthInput<E>> {
    override fun requests(state: HealthHeld<S>, now: DeviceClock.Reading): List<AppQueryRequest>? = ask(state, now.zone)

    override fun arrived(answers: List<AppQueryResponse>, requests: List<AppQueryRequest>): HealthInput<E> =
        HealthInput.Answered(answers)

    override fun refused(failure: ReadFailure): HealthInput<E> = HealthInput.Refused(failure)

    override fun denied(denial: AppQueryDenial): HealthInput<E> = HealthInput.Denied(denial)
}
