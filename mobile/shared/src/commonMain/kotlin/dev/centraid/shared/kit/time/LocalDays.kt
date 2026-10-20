package dev.centraid.shared.kit.time

import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.sync.rfc3339FromEpochMillis

/**
 * THE PHONE'S DAY, PLACED THROUGH THE PLATFORM'S OWN ZONE DATABASE (#1129).
 *
 * Health's days are the health store's, reckoned in the device's zone when it
 * read them, and its queries take the caller's day and the UTC instants that
 * day begins and ends (`health.proto`): the core reads no zone for them. So a
 * Health reads object, Home's Health tile and the Health follower place the
 * day here, and nothing else does. The arithmetic is milliseconds; the one
 * fact about the zone is [DeviceClock.offsetMinutesAt], which each platform
 * answers from its own database, so a day across a daylight-saving change is
 * placed exactly.
 *
 * A machine never calls this: it is handed the words (`today`, a workout's
 * local wall clock) as data, which keeps it pure.
 */
public object LocalDays {
    public const val DAY_MS: Long = 86_400_000L
    private const val MINUTE_MS: Long = 60_000L

    /** `YYYY-MM-DD` of [now] in the phone's zone. */
    public fun today(now: DeviceClock.Reading): String =
        civilDayOf(floorDiv(now.epochMillis + now.utcOffsetMinutes * MINUTE_MS, DAY_MS))

    /**
     * The instant [day] begins on this phone, epoch milliseconds, or null when
     * [day] is not a day. Placed twice: once with the offset at UTC midnight,
     * then with the offset at that first guess, which is the local midnight's
     * own offset everywhere but a zone whose midnight itself is skipped.
     */
    public fun startOf(day: String, clock: DeviceClock): Long? {
        val utcMidnight = (epochDayOf(day) ?: return null) * DAY_MS
        val guess = utcMidnight - clock.offsetMinutesAt(utcMidnight) * MINUTE_MS
        return utcMidnight - clock.offsetMinutesAt(guess) * MINUTE_MS
    }

    /** [startOf] as the instant a query states, `YYYY-MM-DDTHH:MM:SS.sssZ`. */
    public fun startInstant(day: String, clock: DeviceClock): String? = startOf(day, clock)?.let(::rfc3339FromEpochMillis)

    /** The wall clock of [epochMillis] on this phone: `YYYY-MM-DDTHH:MM`. */
    public fun localOf(epochMillis: Long, clock: DeviceClock): String {
        val local = epochMillis + clock.offsetMinutesAt(epochMillis) * MINUTE_MS
        val day = floorDiv(local, DAY_MS)
        val minute = (local - day * DAY_MS) / MINUTE_MS
        return civilDayOf(day) + "T" + (minute / MINUTES_PER_HOUR).toString().padStart(2, '0') + ":" +
            (minute % MINUTES_PER_HOUR).toString().padStart(2, '0')
    }

    /**
     * Epoch milliseconds of an instant the vault spells (`2026-10-20T07:10:00.000Z`,
     * fraction optional), or null for anything else: an instant with an offset
     * is not one the health commands take.
     */
    public fun epochMillisOf(instant: String): Long? {
        if (instant.length < SECONDS_END + 1 || !instant.endsWith("Z") || instant[DAY_END] != 'T') return null
        if (instant[HOUR_END] != ':' || instant[MINUTE_END] != ':') return null
        val day = epochDayOf(instant.substring(0, DAY_END)) ?: return null
        val hour = instant.substring(DAY_END + 1, HOUR_END).toIntOrNull()?.takeIf { it in 0..23 } ?: return null
        val minute = instant.substring(HOUR_END + 1, MINUTE_END).toIntOrNull()?.takeIf { it in 0..59 } ?: return null
        val second = instant.substring(MINUTE_END + 1, SECONDS_END).toIntOrNull()?.takeIf { it in 0..59 } ?: return null
        val rest = instant.substring(SECONDS_END, instant.length - 1)
        val millis = when {
            rest.isEmpty() -> 0
            rest.length > 1 && rest[0] == '.' && rest.drop(1).all { it in '0'..'9' } -> rest.drop(1).padEnd(3, '0').take(3).toInt()
            else -> return null
        }
        return day * DAY_MS + ((hour * MINUTES_PER_HOUR + minute) * SECONDS_PER_MINUTE + second) * 1_000L + millis
    }

    private const val DAY_END: Int = 10
    private const val HOUR_END: Int = 13
    private const val MINUTE_END: Int = 16
    private const val SECONDS_END: Int = 19
    private const val MINUTES_PER_HOUR: Long = 60L
    private const val SECONDS_PER_MINUTE: Long = 60L
}
