package dev.centraid.shared.shell

import dev.centraid.shared.kit.time.epochDayOf
import dev.centraid.shared.kit.time.floorDiv
import dev.centraid.shared.platform.DeviceClock

/**
 * WAS THIS VAULT FOUNDED TODAY, in the device's local calendar (R-SAMPLE-8).
 *
 * The one question Home's notice slot asks of time: the sample line owns the
 * slot on a member's own vault for the day the vault was founded, and the
 * backup line (#1080) takes it after that. `core_vault.created_at` is a UTC instant
 * and "today" is a local day, so the two are placed on the same civil calendar
 * by [DeviceClock.Reading.utcOffsetMinutes] — the offset right now, for both
 * instants. A daylight-saving change between founding and now can move the
 * answer by an hour at the edge of midnight; a notice slot is not worth a zone
 * database in `commonMain` (`sync/Instants.kt`).
 *
 * **An instant that does not parse is NOT today.** The sample line is the
 * transient notice and the nudge is the one that protects a member's rows, so
 * a founding time this cannot read lets the nudge through rather than holding
 * the slot on a guess.
 */
public object FoundingDay {
    private const val MILLIS_PER_DAY: Long = 86_400_000
    private const val MILLIS_PER_MINUTE: Long = 60_000
    private const val DATE_CHARS: Int = 10

    /** `YYYY-MM-DDTHH:MM:SS` is nineteen characters; a fraction and `Z` may follow. */
    private const val SECOND_END: Int = 19

    /** [foundedAt] is `core_vault.created_at`, e.g. `2026-10-01T17:04:09.123Z`. */
    public fun isToday(foundedAt: String, now: DeviceClock.Reading): Boolean {
        val founded = epochMillisOf(foundedAt) ?: return false
        val shift = now.utcOffsetMinutes * MILLIS_PER_MINUTE
        return floorDiv(founded + shift, MILLIS_PER_DAY) == floorDiv(now.epochMillis + shift, MILLIS_PER_DAY)
    }

    /** Epoch milliseconds (whole seconds) of an RFC 3339 UTC instant, or null. */
    internal fun epochMillisOf(instant: String): Long? {
        if (instant.length < SECOND_END || instant[DATE_CHARS] != 'T') return null
        val day = epochDayOf(instant.substring(0, DATE_CHARS)) ?: return null
        if (instant[13] != ':' || instant[16] != ':') return null
        val hour = instant.substring(11, 13).toIntOrNull() ?: return null
        val minute = instant.substring(14, 16).toIntOrNull() ?: return null
        val second = instant.substring(17, SECOND_END).toIntOrNull() ?: return null
        if (hour !in 0..23 || minute !in 0..59 || second !in 0..60) return null
        return day * MILLIS_PER_DAY + ((hour * 60L + minute) * 60L + second) * 1_000L
    }
}
