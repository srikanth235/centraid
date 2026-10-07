package dev.centraid.shared.kit.time

import dev.centraid.design.copy.SharedCopy

/**
 * A CIVIL DAY, IN WORDS — one way for every app (was re-derived per surface:
 * five date formats in the #1015 audit).
 *
 * Pure: every input is a `YYYY-MM-DD` (or `YYYY-MM-DDTHH:MM`) the core already
 * placed in the member's zone, and `today` is the core's answer or
 * `DeviceClock.Reading`'s zone — **never `epochMillis / 86_400_000`**, which is
 * UTC's today and was the v0 Tasks defect. A day that does not parse comes back
 * as itself rather than as a guess.
 */
public object CivilWords {
    /** `Wed`, or empty for a day that does not parse. */
    public fun weekdayShort(day: String): String =
        isoWeekdayOf(day)?.let { WEEKDAYS[it - 1] } ?: ""

    /** `March` for 3, or empty outside 1..12. */
    public fun monthName(month: Int): String = MONTHS.getOrNull(month - 1) ?: ""

    /** `Wed 11` — weekday AND day of month, because a bare weekday is ambiguous past a week. */
    public fun dated(day: String): String {
        val weekday = isoWeekdayOf(day)?.let { WEEKDAYS[it - 1] } ?: return day
        return "$weekday ${dayOfMonthOf(day)}"
    }

    /** `Today`, `Tomorrow`, `Yesterday`, else `Wed 11 March`. */
    public fun relativeDay(day: String, today: String): String = when (day) {
        today -> SharedCopy.TODAY
        plusDays(today, 1) -> SharedCopy.TOMORROW
        plusDays(today, -1) -> SharedCopy.YESTERDAY
        else -> dayMonth(day)
    }

    /** `Wed 11 March`, or the input when it is not a day. */
    public fun dayMonth(day: String): String {
        val weekday = weekdayShort(day).ifEmpty { return day }
        val month = day.substring(MONTH_FROM, MONTH_TO).toIntOrNull()?.let(::monthName) ?: ""
        return "$weekday ${dayOfMonthOf(day)} $month"
    }

    /** `1st`, `2nd`, `3rd`, `4th` … `11th`, `12th`, `13th` … `21st`, `22nd`, `23rd` … `31st`. */
    public fun ordinal(n: Int): String {
        val suffix = when {
            n % 100 in 11..13 -> "th"
            n % 10 == 1 -> "st"
            n % 10 == 2 -> "nd"
            n % 10 == 3 -> "rd"
            else -> "th"
        }
        return "$n$suffix"
    }

    /** `08:15` out of `YYYY-MM-DDTHH:MM…`, or empty. */
    public fun clock(localIso: String): String =
        if (localIso.length >= CLOCK_TO && localIso[DAY] == 'T') localIso.substring(DAY + 1, CLOCK_TO) else ""

    /** `08:15 – 09:45`, `08:15` with no end, or `All day`. */
    public fun span(start: String, end: String, allDay: Boolean): String {
        if (allDay) return SharedCopy.ALL_DAY
        val from = clock(start)
        val to = clock(end)
        return if (to.isEmpty()) from else "$from – $to"
    }

    /** ISO order, Monday first, so `WEEKDAYS[isoWeekday - 1]`. */
    private val WEEKDAYS: List<String> = listOf(
        SharedCopy.WEEKDAY_MON,
        SharedCopy.WEEKDAY_TUE,
        SharedCopy.WEEKDAY_WED,
        SharedCopy.WEEKDAY_THU,
        SharedCopy.WEEKDAY_FRI,
        SharedCopy.WEEKDAY_SAT,
        SharedCopy.WEEKDAY_SUN,
    )

    private val MONTHS: List<String> = listOf(
        SharedCopy.MONTH_01,
        SharedCopy.MONTH_02,
        SharedCopy.MONTH_03,
        SharedCopy.MONTH_04,
        SharedCopy.MONTH_05,
        SharedCopy.MONTH_06,
        SharedCopy.MONTH_07,
        SharedCopy.MONTH_08,
        SharedCopy.MONTH_09,
        SharedCopy.MONTH_10,
        SharedCopy.MONTH_11,
        SharedCopy.MONTH_12,
    )

    /** `YYYY-MM-DD`: the month's digits, and where a `T` sits. */
    private const val MONTH_FROM: Int = 5
    private const val MONTH_TO: Int = 7
    private const val DAY: Int = 10

    /** `YYYY-MM-DDTHH:MM`. */
    private const val CLOCK_TO: Int = 16
}
