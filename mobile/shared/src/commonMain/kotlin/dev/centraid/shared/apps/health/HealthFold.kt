package dev.centraid.shared.apps.health

import centraid.core.v1.HealthWorkoutRow
import centraid.screen.v1.HealthDevice
import centraid.screen.v1.HealthWorkoutLine
import dev.centraid.design.copy.HealthCopy
import dev.centraid.shared.kit.groupedDigits
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.kit.time.LocalDays
import dev.centraid.shared.kit.time.epochDayOf
import dev.centraid.shared.kit.time.plusDays
import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * HEALTH'S WORDS FOR A FIGURE (#1129). Every figure here is the core's (R-1129-12); this only
 * FORMATS it in the member's units, which are the phone's (`HealthDevice.units`) and never the
 * vault's (owner answer 4). Pure: no clock, no locale lookup, every input handed in.
 */
public object HealthFold {
    public const val BP: Int = 10_000
    private const val KG_TO_LB: Double = 2.204_622_621_8
    private const val M_PER_MI: Double = 1_609.344
    private const val M_TO_FT: Double = 3.280_839_895
    private const val MINUTES_PER_HOUR: Long = 60L
    private const val SECONDS_PER_MINUTE: Long = 60L

    /** `{name}` slots filled. */
    public fun fill(template: String, vararg slots: Pair<String, String>): String =
        slots.fold(template) { text, (name, value) -> text.replace("{$name}", value) }

    /** The shell's facts, or metric units and no store when the shell has not said. */
    public fun device(device: HealthDevice?): HealthDevice = device ?: HealthDevice(units = HealthDevice.Units.UNITS_METRIC)

    public fun metric(units: HealthDevice.Units): Boolean = units != HealthDevice.Units.UNITS_IMPERIAL

    /** The store's name on this phone: "Apple Health", "Health Connect", or a plain phrase. */
    public fun store(device: HealthDevice): String = when (device.store) {
        HealthDevice.Store.STORE_APPLE_HEALTH -> HealthCopy.STORE_APPLE_HEALTH
        HealthDevice.Store.STORE_HEALTH_CONNECT -> HealthCopy.STORE_HEALTH_CONNECT
        else -> HealthCopy.STORE_ANY
    }

    /** A metric's name. */
    public fun label(metric: HealthMetrics): String = when (metric) {
        HealthMetrics.STEPS -> HealthCopy.METRIC_STEPS
        HealthMetrics.SLEEP -> HealthCopy.METRIC_SLEEP
        HealthMetrics.ENERGY -> HealthCopy.METRIC_ENERGY
        HealthMetrics.EXERCISE -> HealthCopy.METRIC_EXERCISE
        HealthMetrics.RESTING_HR -> HealthCopy.METRIC_RESTING_HR
        HealthMetrics.WEIGHT -> HealthCopy.METRIC_WEIGHT
    }

    /** A figure and its unit word, apart: `"8,412" ""`, `"7 h 12 m" ""`, `"412" "kcal"`, `"157.4" "lb"`. */
    public fun figure(metric: HealthMetrics, value: Double, units: HealthDevice.Units): Pair<String, String> = when (metric) {
        HealthMetrics.STEPS -> groupedDigits(value.roundToLong()) to ""
        HealthMetrics.SLEEP -> duration(value) to ""
        HealthMetrics.ENERGY -> groupedDigits(value.roundToLong()) to HealthCopy.UNIT_KCAL
        HealthMetrics.EXERCISE -> groupedDigits(value.roundToLong()) to HealthCopy.UNIT_MIN
        HealthMetrics.RESTING_HR -> groupedDigits(value.roundToLong()) to HealthCopy.UNIT_BPM
        HealthMetrics.WEIGHT -> if (metric(units)) tenths(value) to HealthCopy.UNIT_KG else tenths(value * KG_TO_LB) to HealthCopy.UNIT_LB
    }

    /** A figure with its unit, as one phrase: `8,412`, `412 kcal`. */
    public fun phrase(metric: HealthMetrics, value: Double, units: HealthDevice.Units): String =
        figure(metric, value, units).let { (number, unit) -> if (unit.isEmpty()) number else "$number $unit" }

    /** Minutes asleep as `7 h 12 m`, or `48 m`. */
    public fun duration(minutes: Double): String {
        val total = minutes.roundToLong().coerceAtLeast(0L)
        val hours = total / MINUTES_PER_HOUR
        val rest = total % MINUTES_PER_HOUR
        return if (hours == 0L) {
            fill(HealthCopy.DURATION_MINUTES, "m" to rest.toString())
        } else {
            fill(HealthCopy.DURATION_HOURS, "h" to hours.toString(), "m" to rest.toString())
        }
    }

    /** A workout's span as `31 min` or `1 h 06 min`. */
    public fun span(seconds: Long): String {
        val minutes = (seconds + SECONDS_PER_MINUTE / 2) / SECONDS_PER_MINUTE
        val hours = minutes / MINUTES_PER_HOUR
        val rest = minutes % MINUTES_PER_HOUR
        return if (hours == 0L) {
            fill(HealthCopy.SPAN_MINUTES, "m" to rest.toString())
        } else {
            fill(HealthCopy.SPAN_HOURS, "h" to hours.toString(), "m" to rest.toString().padStart(2, '0'))
        }
    }

    /** A stopwatch: `31:04`, `1:06:12`. */
    public fun stopwatch(seconds: Long): String {
        val s = seconds.coerceAtLeast(0L)
        val hours = s / (MINUTES_PER_HOUR * SECONDS_PER_MINUTE)
        val minutes = (s / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR
        val rest = s % SECONDS_PER_MINUTE
        val tail = rest.toString().padStart(2, '0')
        return if (hours == 0L) "$minutes:$tail" else "$hours:${minutes.toString().padStart(2, '0')}:$tail"
    }

    /** A distance in metres as `5.2` and `km` (or `mi`). */
    public fun distance(metres: Double, units: HealthDevice.Units): Pair<String, String> =
        if (metric(units)) tenths(metres / 1_000.0) to HealthCopy.UNIT_KM else tenths(metres / M_PER_MI) to HealthCopy.UNIT_MI

    /** A climb in metres as `42` and `m` (or `ft`). */
    public fun climb(metres: Double, units: HealthDevice.Units): Pair<String, String> =
        if (metric(units)) groupedDigits(metres.roundToLong()) to HealthCopy.UNIT_M else groupedDigits((metres * M_TO_FT).roundToLong()) to HealthCopy.UNIT_FT

    /** Time per kilometre (or mile) as `6:00` and `/km`, or null with no distance to divide by. */
    public fun pace(seconds: Long, metres: Double, units: HealthDevice.Units): Pair<String, String>? {
        val per = if (metric(units)) 1_000.0 else M_PER_MI
        if (metres <= 0.0 || seconds <= 0L) return null
        val pace = (seconds * per / metres).roundToLong()
        return stopwatch(pace) to if (metric(units)) HealthCopy.UNIT_PER_KM else HealthCopy.UNIT_PER_MI
    }

    /** One decimal, its zero kept: `71.4`, `5.0`, `1,204.3`. */
    public fun tenths(value: Double): String {
        val scaled = (abs(value) * 10.0).roundToLong()
        val text = groupedDigits(scaled / 10) + "." + (scaled % 10)
        return if (value < 0 && scaled != 0L) "−$text" else text
    }

    /**
     * THE DIFFERENCE OF TWO OF THE CORE'S FIGURES, IN WORDS, and its sign (−1, 0, 1). Steps and
     * active energy say a percentage; minutes, beats and kilograms say themselves (`+12 min`).
     * Zero when the difference rounds to nothing in the words it would be said in.
     */
    public fun delta(metric: HealthMetrics, now: Double, before: Double, units: HealthDevice.Units): Pair<String, Int> {
        val percent = metric == HealthMetrics.STEPS || metric == HealthMetrics.ENERGY
        val (magnitude, words) = if (percent) {
            if (before == 0.0) return "" to 0
            val p = ((now - before) / before * 100.0).roundToLong()
            abs(p) to "${abs(p)}%"
        } else {
            val d = now - before
            when (metric) {
                HealthMetrics.SLEEP, HealthMetrics.EXERCISE -> abs(d.roundToLong()).let { it to "$it ${HealthCopy.UNIT_MIN}" }
                HealthMetrics.RESTING_HR -> abs(d.roundToLong()).let { it to "$it ${HealthCopy.UNIT_BPM}" }
                else -> {
                    val (number, unit) = figure(HealthMetrics.WEIGHT, abs(d), units)
                    (if (number.trimStart('0', '.').isEmpty()) 0L else 1L) to "$number $unit"
                }
            }
        }
        val sign = if (magnitude == 0L) 0 else if (now > before) 1 else -1
        return when (sign) {
            0 -> words to 0
            1 -> "+$words" to 1
            else -> "−$words" to -1
        }
    }

    /** A bar's length: [value] over [scale], in basis points, clamped. */
    public fun bp(value: Double, scale: Double): Int =
        if (scale <= 0.0) 0 else (value / scale * BP).roundToLong().coerceIn(0L, BP.toLong()).toInt()

    /** A drawing scale a little past [top], rounded to two significant figures, so the bar's end is a round number. */
    public fun scaleOver(top: Double): Double {
        if (top <= 0.0) return 1.0
        val raw = top * 1.25
        var unit = 1.0
        while (raw / unit >= 100.0) unit *= 10.0
        return kotlin.math.ceil(raw / unit) * unit
    }

    /** A kind key's word: `Run`; one the seed does not name is a plain `Workout`. */
    public fun kindWord(key: String): String = when (key) {
        HealthKinds.RUN -> HealthCopy.KIND_RUN
        HealthKinds.WALK -> HealthCopy.KIND_WALK
        HealthKinds.CYCLE -> HealthCopy.KIND_CYCLE
        HealthKinds.STRENGTH -> HealthCopy.KIND_STRENGTH
        HealthKinds.SWIM -> HealthCopy.KIND_SWIM
        HealthKinds.HIKE -> HealthCopy.KIND_HIKE
        HealthKinds.YOGA -> HealthCopy.KIND_YOGA
        else -> HealthCopy.KIND_OTHER
    }

    /** A kind key's chip: `Runs`; one the seed does not name is the vault's own label for it. */
    public fun kindChip(key: String, label: String): String = when (key) {
        HealthKinds.RUN -> HealthCopy.CHIP_RUN
        HealthKinds.WALK -> HealthCopy.CHIP_WALK
        HealthKinds.CYCLE -> HealthCopy.CHIP_CYCLE
        HealthKinds.STRENGTH -> HealthCopy.CHIP_STRENGTH
        HealthKinds.SWIM -> HealthCopy.CHIP_SWIM
        HealthKinds.HIKE -> HealthCopy.CHIP_HIKE
        HealthKinds.YOGA -> HealthCopy.CHIP_YOGA
        HealthKinds.OTHER -> HealthCopy.CHIP_OTHER
        else -> label.ifEmpty { HealthCopy.CHIP_OTHER }
    }

    /** "Morning run": the kind and the part of the day it started in, on the phone's clock (`HH:MM`). */
    public fun title(kind: String, clock: String): String {
        val hour = clock.take(2).toIntOrNull() ?: return kindWord(kind)
        val part = when (hour) {
            in MORNING -> HealthCopy.PART_MORNING
            in AFTERNOON -> HealthCopy.PART_AFTERNOON
            in EVENING -> HealthCopy.PART_EVENING
            else -> HealthCopy.PART_NIGHT
        }
        return fill(part, "kind" to kindWord(kind).lowercase())
    }

    /** A workout's length in seconds: its moving time, else its span. */
    public fun seconds(row: HealthWorkoutRow): Long? = row.moving_sec ?: run {
        val start = LocalDays.epochMillisOf(row.started_at) ?: return null
        val end = LocalDays.epochMillisOf(row.ended_at) ?: return null
        (end - start) / 1_000L
    }

    /** `11 Oct`. */
    public fun shortDate(day: String): String {
        val month = day.drop(MONTH_AT).take(2).toIntOrNull()?.let(CivilWords::monthName)?.take(3) ?: return day
        return "${day.drop(DAY_AT).toIntOrNull() ?: return day} $month"
    }

    /** `October`, or `September 2025` outside [today]'s year. */
    public fun monthHeading(day: String, today: String): String {
        val month = day.drop(MONTH_AT).take(2).toIntOrNull()?.let(CivilWords::monthName) ?: return day
        return if (day.take(4) == today.take(4)) month else "$month ${day.take(4)}"
    }

    /** One workout as a list draws it; [local] is its start on the phone's wall clock. */
    public fun line(row: HealthWorkoutRow, local: String, today: String, units: HealthDevice.Units): HealthWorkoutLine {
        val day = local.take(DAY)
        val clock = CivilWords.clock(local)
        val meta = listOfNotNull(
            row.distance_m?.takeIf { it > 0.0 }?.let { distance(it, units).let { (n, u) -> "$n $u" } },
            seconds(row)?.takeIf { it > 0 }?.let(::span),
        ).joinToString(" · ")
        val week = plusDays(today, -WEEK_BACK) ?: today
        val whenWords = when {
            day.isEmpty() -> ""
            day == today -> clock
            day >= week && epochDayOf(day) != null -> CivilWords.weekdayShort(day)
            else -> shortDate(day)
        }
        val title = title(row.kind_key, clock)
        return HealthWorkoutLine(
            activity_id = row.activity_id,
            title = title,
            meta = meta,
            when_label = whenWords,
            icon_key = WORKOUT_ICON,
            accessibility_label = listOf(title, meta, whenWords).filter { it.isNotEmpty() }.joinToString(", "),
        )
    }

    public const val WORKOUT_ICON: String = "Gym"
    private val MORNING = 5..11
    private val AFTERNOON = 12..16
    private val EVENING = 17..21
    private const val WEEK_BACK: Int = 6
    private const val DAY: Int = 10
    private const val MONTH_AT: Int = 5
    private const val DAY_AT: Int = 8
}
