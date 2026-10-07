package dev.centraid.shared.kit.time

/**
 * ARITHMETIC ON A CIVIL DAY, AND NOTHING THAT NEEDS A ZONE (#1046).
 *
 * The core answers civil time already placed — every Agenda occurrence carries
 * `local_start` and `local_days`, and every answer carries `today` — so which
 * day an instant falls on is never decided here (`agenda.proto`'s file header).
 * What is left to a surface is arithmetic on a `YYYY-MM-DD` it was handed:
 * which weekday it is, and which day is seven after it. Both have one right
 * answer in the proleptic Gregorian calendar and neither depends on where the
 * phone is, so they are pure functions and not a calendar.
 *
 * Howard Hinnant's `days_from_civil`, the inverse of [civilFromDays] below, for the reason that file gives: the March-first year makes
 * the leap day fall out of the arithmetic instead of a table.
 *
 * **A DAY THAT DOES NOT PARSE IS NULL, never a guess.** `2026-02-31` is not the
 * 3rd of March, and a caller told so draws nothing rather than the wrong date.
 */

/** Days since 1970-01-01 for `YYYY-MM-DD`, or null when it is not one real day. */
public fun epochDayOf(day: String): Long? {
    if (day.length != 10 || day[4] != '-' || day[7] != '-') return null
    val year = day.substring(0, 4).toIntOrNull() ?: return null
    val month = day.substring(5, 7).toIntOrNull() ?: return null
    val dayOfMonth = day.substring(8, 10).toIntOrNull() ?: return null
    if (month !in 1..12 || dayOfMonth !in 1..31) return null
    val epochDay = daysFromCivil(year.toLong(), month.toLong(), dayOfMonth.toLong())
    // THE ROUND TRIP IS THE VALIDATION. The formula accepts the 31st of any
    // month and answers the day after the month's last, so a date that does
    // not come back as itself was never a date.
    return epochDay.takeIf { civilDayOf(it) == day }
}

/** `YYYY-MM-DD` for days since 1970-01-01. Years before 1000 are zero-padded. */
public fun civilDayOf(epochDay: Long): String {
    val (year, month, day) = civilFromDays(epochDay)
    return year.toString().padStart(4, '0') + '-' +
        month.toString().padStart(2, '0') + '-' +
        day.toString().padStart(2, '0')
}

/** [day] moved by [days], or null when [day] does not parse. */
public fun plusDays(day: String, days: Int): String? =
    epochDayOf(day)?.let { civilDayOf(it + days) }

/**
 * The ISO weekday of [day] — 1 is Monday, 7 is Sunday — or null.
 *
 * 1970-01-01 was a Thursday, ISO 4, which is where the `+ 3` comes from.
 */
public fun isoWeekdayOf(day: String): Int? = epochDayOf(day)?.let { epochDay ->
    // FLOOR MODULO, so a day before 1970 is still a weekday and not a negative.
    val shifted = epochDay + 3
    (shifted - floorDiv(shifted, 7) * 7).toInt() + 1
}

/** The day of the month of [day], 1 to 31, or null. */
public fun dayOfMonthOf(day: String): Int? =
    epochDayOf(day)?.let { day.substring(8, 10).toInt() }

private fun daysFromCivil(year: Long, month: Long, day: Long): Long {
    // January and February belong to the PREVIOUS March-first year.
    val y = if (month <= 2) year - 1 else year
    val era = floorDiv(y, 400)
    val yearOfEra = y - era * 400
    val monthPrime = if (month > 2) month - 3 else month + 9
    val dayOfYear = (153 * monthPrime + 2) / 5 + day - 1
    val dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
    return era * 146_097 + dayOfEra - 719_468
}

/** Floor division: rounds toward negative infinity, so a day before 1970 is still a day. */
public fun floorDiv(value: Long, divisor: Long): Long {
    val quotient = value / divisor
    return if (value % divisor != 0L && (value xor divisor) < 0) quotient - 1 else quotient
}

/**
 * Days since 1970-01-01 as `(year, month, day)`, proleptic Gregorian.
 *
 * Howard Hinnant's `civil_from_days`, which is the algorithm `java.time` and
 * every other correct implementation uses. It is written out rather than
 * cited-and-approximated because the shift-the-year-to-March trick is what
 * makes leap years fall out of the arithmetic instead of needing a table, and
 * a hand-rolled approximation of it is the classic source of an off-by-one on
 * the 29th of February.
 */
public fun civilFromDays(days: Long): Triple<Int, Int, Int> {
    // Shift the epoch to 0000-03-01, so a leap day is the LAST day of the year
    // and every other month's length is regular.
    val shifted = days + 719_468
    val era = floorDiv(shifted, 146_097)
    val dayOfEra = shifted - era * 146_097
    val yearOfEra = (dayOfEra - dayOfEra / 1_460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
    val year = yearOfEra + era * 400
    val dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
    val monthPrime = (5 * dayOfYear + 2) / 153
    val day = dayOfYear - (153 * monthPrime + 2) / 5 + 1
    val month = if (monthPrime < 10) monthPrime + 3 else monthPrime - 9
    return Triple(
        (if (month <= 2) year + 1 else year).toInt(),
        month.toInt(),
        day.toInt(),
    )
}
