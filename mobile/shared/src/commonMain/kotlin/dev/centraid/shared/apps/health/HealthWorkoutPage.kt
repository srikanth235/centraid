package dev.centraid.shared.apps.health

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.HealthWorkoutRequest
import centraid.screen.v1.EmptyState
import centraid.screen.v1.HealthDevice
import centraid.screen.v1.HealthFigure
import centraid.screen.v1.HealthPageChrome
import centraid.screen.v1.HealthWorkoutData
import centraid.screen.v1.HealthWorkoutEvent
import centraid.screen.v1.HealthWorkoutState
import centraid.screen.v1.Loading
import centraid.screen.v1.SeatState
import dev.centraid.design.copy.HealthCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.nav.ScreenIds
import dev.centraid.shared.screen.Step

/** Every table one workout's read touches. */
public val HEALTH_WORKOUT_TABLES: Set<String> = setOf("workout", "activity", "concept", "entity")

/**
 * ONE WORKOUT (#1129): its kind, when, and every figure the store measured — distance, time, pace,
 * energy, heart rate, climb, each only when there is one — and who recorded it. Splits are not
 * here (R-1129-9): they would be a live store read with route samples, a later wave. There is no
 * "Write a note about it": Notes has no opening for a new note that links a row, so the verb would
 * open nothing.
 */
public object HealthWorkoutMachine :
    HealthQueryMachine<HealthWorkoutState, HealthWorkoutEvent, HealthWorkoutData>(ScreenIds.HEALTH_WORKOUT, HEALTH_WORKOUT_TABLES) {
    public const val SCREEN_ID: String = ScreenIds.HEALTH_WORKOUT

    override val lens: ContentLens<HealthWorkoutState, HealthWorkoutData> = Lens

    override fun blank(): HealthWorkoutState = HealthWorkoutState(device = HealthDevice(units = HealthDevice.Units.UNITS_METRIC))

    override fun withSeat(screen: HealthWorkoutState, seat: SeatState): HealthWorkoutState = screen.copy(seat = seat)

    override fun view(held: HealthHeld<HealthWorkoutState>, event: HealthWorkoutEvent): Step<HealthHeld<HealthWorkoutState>> = when {
        event.opened != null -> reload(
            held.copy(
                screen = held.screen.copy(
                    activity_id = event.opened.activity_id,
                    chrome = HealthPageChrome(back_label = event.opened.parent.ifEmpty { HealthCopy.APP_TITLE }, retry = HealthCopy.RETRY),
                    device = event.opened.device ?: held.screen.device,
                ),
            ),
        )
        event.refreshed != null -> read(overRows(held))
        else -> Step(held)
    }

    override fun fold(held: HealthHeld<HealthWorkoutState>): HealthWorkoutData? {
        val answer = held.answers.workout ?: return null
        val row = answer.workout ?: return HealthWorkoutData(gone = EmptyState(headline = HealthCopy.WORKOUT_GONE))
        if (row.activity_id != held.screen.activity_id) return null
        val device = HealthFold.device(held.screen.device)
        val units = device.units
        val start = row.local_start
        val end = row.local_end
        val seconds = row.length_sec.takeIf { it > 0 }
        val figures = buildList {
            row.distance_m?.takeIf { it > 0.0 }?.let { metres ->
                HealthFold.distance(metres, units).let { (n, u) -> add(HealthFigure(label = HealthCopy.FIGURE_DISTANCE, value_ = n, unit = u)) }
            }
            seconds?.takeIf { it > 0 }?.let { add(HealthFigure(label = HealthCopy.FIGURE_TIME, value_ = HealthFold.stopwatch(it))) }
            if (row.kind_key in PACED) {
                val metres = row.distance_m
                if (seconds != null && metres != null) {
                    HealthFold.pace(seconds, metres, units)?.let { (n, u) -> add(HealthFigure(label = HealthCopy.FIGURE_PACE, value_ = n, unit = u)) }
                }
            }
            row.energy_kcal?.let { add(HealthFigure(label = HealthCopy.FIGURE_ENERGY, value_ = HealthFold.figure(HealthMetrics.ENERGY, it, units).first, unit = HealthCopy.UNIT_KCAL)) }
            row.avg_hr_bpm?.let { add(HealthFigure(label = HealthCopy.FIGURE_HEART, value_ = it.toString(), unit = HealthCopy.UNIT_BPM)) }
            row.elevation_gain_m?.let { metres ->
                HealthFold.climb(metres, units).let { (n, u) -> add(HealthFigure(label = HealthCopy.FIGURE_ELEVATION, value_ = n, unit = u)) }
            }
        }
        val store = HealthFold.store(device)
        val foot = listOf(
            row.recorded_by?.takeIf { it.isNotBlank() }?.let { HealthFold.fill(HealthCopy.WORKOUT_FOOT_BY, "recorder" to it, "store" to store) }
                ?: HealthFold.fill(HealthCopy.WORKOUT_FOOT, "store" to store),
            HealthFold.fill(HealthCopy.WORKOUT_SAMPLES, "store" to store),
        ).joinToString(" ")
        return HealthWorkoutData(
            kind_label = HealthFold.kindWord(row.kind_key),
            title = HealthFold.title(row.kind_key, CivilWords.clock(start)),
            when_label = if (start.isEmpty()) {
                ""
            } else {
                HealthFold.fill(
                    HealthCopy.WORKOUT_WHEN,
                    "day" to CivilWords.dayMonth(start.take(DAY)),
                    "start" to CivilWords.clock(start),
                    "end" to CivilWords.clock(end),
                )
            },
            figures = figures,
            foot = foot,
        )
    }

    override fun decorate(held: HealthHeld<HealthWorkoutState>): HealthWorkoutState {
        val title = held.answers.workout?.workout?.kind_key?.let(HealthFold::kindWord) ?: HealthCopy.BAND_WORKOUTS
        return held.screen.copy(chrome = (held.screen.chrome ?: HealthPageChrome()).copy(title = title, retry = HealthCopy.RETRY))
    }

    /** The kinds a pace means something for. */
    private val PACED = setOf(HealthKinds.RUN, HealthKinds.WALK, HealthKinds.HIKE)
    private const val DAY: Int = 10

    internal object Lens : ContentLens<HealthWorkoutState, HealthWorkoutData> {
        override fun content(state: HealthWorkoutState): ReadContent<HealthWorkoutData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: HealthWorkoutState, content: ReadContent<HealthWorkoutData>): HealthWorkoutState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

/** What a workout page asks: the one workout. */
public object HealthWorkoutReads : HealthQueries<HealthWorkoutState, HealthWorkoutEvent>(
    screenId = HealthWorkoutMachine.SCREEN_ID,
    tables = HEALTH_WORKOUT_TABLES,
    ask = { held, tz ->
        held.screen.activity_id.takeIf { it.isNotEmpty() }?.let {
            listOf(AppQueryRequest(health_workout = HealthWorkoutRequest(activity_id = it, tz = tz)))
        }
    },
)
