package dev.centraid.shared.sync

/**
 * EPOCH MILLISECONDS AS AN RFC 3339 INSTANT, IN UTC (#1029 W5).
 *
 * `commonMain` has no calendar. The gateway's refusals and the lease speak
 * `int64` milliseconds since the Unix epoch (`lease.proto`, `gateway.proto`)
 * and `Shelf.Moved.atIso` wants RFC 3339, because `Shelf.Holding.frozenLine`
 * takes its first ten characters as the date part. Something has to do the
 * conversion.
 *
 * **A CONVERSION AND NOT A FORMAT.** It is deliberately not locale-aware and
 * deliberately not the member's time zone: this is a machine instant being
 * written down in the one spelling every layer in this repository already uses,
 * and a shell that wants to show a member their own Tuesday has the raw
 * milliseconds beside it. Rendering a localised date is a platform's job — iOS
 * has `DateFormatter`, Android has `java.time` — and doing it here would be
 * `commonMain` guessing at a zone nobody told it.
 *
 * **No dependency.** Adding `kotlinx-datetime` to `commonMain` to turn one
 * `Long` into one string would be a library on every shell's link line, on iOS
 * as a Kotlin/Native binary, for twenty lines of arithmetic that has one right
 * answer.
 */

/** Seconds in a day. */
private const val SECONDS_PER_DAY: Long = 86_400

private const val MILLIS_PER_SECOND: Long = 1_000

/**
 * `YYYY-MM-DDTHH:MM:SSZ` for [epochMillis], UTC, proleptic Gregorian.
 *
 * Negative values — an instant before 1970 — are handled rather than clamped:
 * a clock that is badly wrong is exactly the case that produces one, and a
 * function that answered `1970-01-01` for every one of them would make a broken
 * clock look like a missing value.
 */
public fun rfc3339FromEpochMillis(epochMillis: Long): String {
    // FLOOR DIVISION, not truncation. Kotlin's `/` rounds toward zero, so
    // -1 ms would become second 0 and day 0 — an instant before the epoch
    // rendering as the epoch itself.
    val totalSeconds = floorDiv(epochMillis, MILLIS_PER_SECOND)
    val days = floorDiv(totalSeconds, SECONDS_PER_DAY)
    val secondOfDay = totalSeconds - days * SECONDS_PER_DAY
    val (year, month, day) = civilFromDays(days)
    val hour = secondOfDay / 3_600
    val minute = (secondOfDay % 3_600) / 60
    val second = secondOfDay % 60
    return buildString {
        append(pad(year.toLong(), width = 4))
        append('-')
        append(pad(month.toLong(), width = 2))
        append('-')
        append(pad(day.toLong(), width = 2))
        append('T')
        append(pad(hour, width = 2))
        append(':')
        append(pad(minute, width = 2))
        append(':')
        append(pad(second, width = 2))
        append('Z')
    }
}

private fun floorDiv(value: Long, divisor: Long): Long {
    val quotient = value / divisor
    return if (value % divisor != 0L && (value xor divisor) < 0) quotient - 1 else quotient
}

private fun pad(value: Long, width: Int): String {
    val negative = value < 0
    val digits = (if (negative) -value else value).toString().padStart(width, '0')
    return if (negative) "-$digits" else digits
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
private fun civilFromDays(days: Long): Triple<Int, Int, Int> {
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
