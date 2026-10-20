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
import dev.centraid.shared.kit.time.LocalDays
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ScreenQueries

/**
 * WHERE THE PHONE'S CLOCK PUT THINGS, for one answer (#1129): the phone's [today] and each
 * instant the answer carries as the phone's wall clock (`YYYY-MM-DDTHH:MM`). Placed by the reads
 * object through [LocalDays], never by a machine, which is handed them as data and stays pure.
 */
public data class HealthPlaces(
    public val today: String = "",
    public val local: Map<String, String> = emptyMap(),
) {
    /** [instant] on the phone's wall clock, or empty when it was not placed. */
    public fun localOf(instant: String): String = local[instant].orEmpty()
}

/**
 * WHAT A HEALTH MACHINE HOLDS (#1129): the state a view draws, the core's raw typed answers
 * (kept so a tab, a range or a sheet re-folds without a read; `screen.proto` cannot import
 * `centraid.core.v1`), where the clock put them, and ONE read in flight — Money's shape.
 */
public data class HealthHeld<S>(
    public val screen: S,
    public val answers: HealthAnswers = HealthAnswers(),
    public val places: HealthPlaces = HealthPlaces(),
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

    public data class Answered(public val answers: List<AppQueryResponse>, public val places: HealthPlaces) : HealthInput<Nothing>

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
            is HealthInput.Answered -> answered(state, event.answers, event.places)
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

    private fun answered(held: HealthHeld<S>, responses: List<AppQueryResponse>, places: HealthPlaces): Step<HealthHeld<S>> {
        if (held.readQueued) return reissue(held)
        val next = held.copy(
            answers = held.answers.with(responses),
            places = HealthPlaces(
                today = places.today.ifEmpty { held.places.today },
                local = held.places.local + places.local,
            ),
            reading = false,
        )
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
 * WHAT ONE HEALTH SCREEN ASKS THE CORE: one object per screen, [ask] its only difference. The
 * phone's day and its bounds are placed here, at every read, through the platform's zone
 * ([LocalDays]); every instant an answer carries is placed on the phone's wall clock before the
 * machine sees it.
 */
public open class HealthQueries<S, E>(
    override val screenId: String,
    override val tables: Set<String>,
    private val clock: () -> DeviceClock = { platformServices().clock },
    private val ask: (state: HealthHeld<S>, day: HealthDay) -> List<AppQueryRequest>?,
) : ScreenQueries<HealthHeld<S>, HealthInput<E>> {
    /** The phone's day for one read, and the UTC instants it begins and the next begins. */
    public data class HealthDay(val today: String, val start: String, val end: String)

    override fun requests(state: HealthHeld<S>, now: DeviceClock.Reading): List<AppQueryRequest>? {
        val today = LocalDays.today(now)
        val clock = clock()
        val start = LocalDays.startInstant(today, clock) ?: return null
        val next = dev.centraid.shared.kit.time.plusDays(today, 1) ?: return null
        val end = LocalDays.startInstant(next, clock) ?: return null
        return ask(state, HealthDay(today, start, end))
    }

    override fun arrived(answers: List<AppQueryResponse>, requests: List<AppQueryRequest>): HealthInput<E> {
        val today = requests.firstNotNullOfOrNull { it.health_today?.today ?: it.health_series?.today ?: it.health_trends?.today }
            ?: LocalDays.today(clock().read())
        val instants = answers.flatMap { answer ->
            answer.health_today?.workouts.orEmpty() + answer.health_workouts?.workouts.orEmpty() +
                listOfNotNull(answer.health_workout?.workout)
        }.flatMap { listOf(it.started_at, it.ended_at) }
        val clock = clock()
        val local = instants.distinct().mapNotNull { instant ->
            LocalDays.epochMillisOf(instant)?.let { instant to LocalDays.localOf(it, clock) }
        }.toMap()
        return HealthInput.Answered(answers, HealthPlaces(today, local))
    }

    override fun refused(failure: ReadFailure): HealthInput<E> = HealthInput.Refused(failure)

    override fun denied(denial: AppQueryDenial): HealthInput<E> = HealthInput.Denied(denial)
}
