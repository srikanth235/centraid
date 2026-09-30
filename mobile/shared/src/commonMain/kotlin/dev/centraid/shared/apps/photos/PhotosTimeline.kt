package dev.centraid.shared.apps.photos

import centraid.screen.v1.PhotosGridState

/**
 * THE LIBRARY'S CALENDAR AND ITS TILE SIZES, AS DATA (#1029, photos port).
 *
 * v0's `timeline-model.ts`, `timeline-grains.ts` and `photos-rungs.ts`, reduced
 * to the parts that are DECISIONS rather than layout: which day a photograph
 * belongs to, which grain is next when a member pinches or taps a card, and
 * which rung a pinch lands on. The layout — justified rows, headers, the rail —
 * is each shell's, because it is arithmetic over a width only the shell knows;
 * what a day IS must not be, or the two shells would file one photograph under
 * two dates.
 */
public object PhotosTimeline {
    /**
     * THE CAPTURE-LOCAL DAY, `YYYY-MM-DD`, or empty when there is no capture
     * time (v0's `captureLocalDay`).
     *
     * `captured_at` is a UTC instant and `tz_offset_min` is the zone the shutter
     * fired in, so the day is the instant moved by the offset — never the
     * reader's zone, which would move a photograph a day for a traveller, and
     * never the raw UTC date, which files a 20:00-local photograph in California
     * under the next morning.
     *
     * Parsed by hand because `commonMain` carries no date library, and the
     * shape is narrow: RFC 3339 with an optional fraction and a `Z` or `±hh:mm`
     * suffix, which is what `media.add_asset` stores. A string this cannot read
     * is UNDATED rather than guessed at — a photograph filed under the wrong
     * day is worse than one filed under none.
     */
    public fun captureDay(capturedAt: String, offsetMinutes: Int): String {
        val instant = epochMinutes(capturedAt) ?: return ""
        val local = instant + offsetMinutes
        val days = floorDiv(local, MINUTES_PER_DAY)
        val (year, month, day) = civilFromDays(days)
        return year.toString().padStart(4, '0') + "-" +
            month.toString().padStart(2, '0') + "-" +
            day.toString().padStart(2, '0')
    }

    /**
     * THE PHONE'S TILE HEIGHTS, XS to L (`photos-rungs.ts`' `phone` column).
     * The numbers are v0's and are restated in each shell only where the SPM
     * host build cannot read Kotlin.
     */
    public val RUNG_HEIGHTS: List<Int> = listOf(64, 88, 120, 168)

    /** The labels the tile-size menu shows, in rung order. */
    public val RUNG_LABELS: List<String> = listOf("XS", "S", "M", "L")

    /** v0's `DEFAULT_RUNG`: M. */
    public const val DEFAULT_RUNG: Int = 2

    /** The key the rung is stored under (`photos-rung-store.ts`' `RUNG_KEY`). */
    public const val RUNG_KEY: String = "photos.tileSize"

    /** A stored or requested rung, clamped into the table. */
    public fun clampRung(rung: Int): Int = rung.coerceIn(0, RUNG_HEIGHTS.size - 1)

    /**
     * A PINCH IS A STEPPER PRESS, NOT A CONTINUOUS ZOOM (v0 §4.2), and past
     * the table's ends it moves the GRAIN — Apple Photos' pinch, which zooms
     * out of the smallest tiles into Months and on into Years, and back in the
     * other way. Thresholds are v0's `PINCH_OUT_THRESHOLD`/`PINCH_IN_THRESHOLD`.
     */
    public fun pinch(grain: PhotosGridState.Grain, rung: Int, scale: Float): Pinch {
        val out = scale >= PINCH_OUT
        val `in` = scale <= PINCH_IN
        if (!out && !`in`) return Pinch(grain, rung)
        return when (grain) {
            PhotosGridState.Grain.GRAIN_YEARS ->
                if (out) Pinch(PhotosGridState.Grain.GRAIN_MONTHS, rung) else Pinch(grain, rung)
            PhotosGridState.Grain.GRAIN_MONTHS ->
                if (out) {
                    Pinch(PhotosGridState.Grain.GRAIN_ALL, rung)
                } else {
                    Pinch(PhotosGridState.Grain.GRAIN_YEARS, rung)
                }
            PhotosGridState.Grain.GRAIN_ALL,
            PhotosGridState.Grain.GRAIN_UNSPECIFIED,
            -> when {
                out -> Pinch(PhotosGridState.Grain.GRAIN_ALL, clampRung(rung + 1))
                rung > 0 -> Pinch(PhotosGridState.Grain.GRAIN_ALL, rung - 1)
                else -> Pinch(PhotosGridState.Grain.GRAIN_MONTHS, rung)
            }
        }
    }

    /** Where a pinch lands. */
    public data class Pinch(val grain: PhotosGridState.Grain, val rung: Int)

    /**
     * ONE GRAIN NARROWER — what a period card opens (v0's `openPeriod`: Years
     * to Months, Months to All).
     */
    public fun narrower(grain: PhotosGridState.Grain): PhotosGridState.Grain = when (grain) {
        PhotosGridState.Grain.GRAIN_YEARS -> PhotosGridState.Grain.GRAIN_MONTHS
        else -> PhotosGridState.Grain.GRAIN_ALL
    }

    /**
     * THE DAY A GRAIN LANDS ON (v0's `anchorForGrain`, by reverse anchoring).
     *
     * A period's key is a PREFIX of every day it holds — `2026` of
     * `2026-08-14`, `2026-08` of the same — so the period containing a day is
     * the day cut to the key's width, and its anchor is the NEWEST loaded day
     * with that prefix, which is where the period starts in the newest-first
     * order every grain draws. One rule, so Years→Months→All and back cannot
     * drift apart. Empty — the top — for no day or the undated tail, which is
     * no stretch of time.
     */
    public fun anchor(grain: PhotosGridState.Grain, day: String, days: List<String>): String {
        if (day.isEmpty()) return ""
        val width = when (grain) {
            PhotosGridState.Grain.GRAIN_YEARS -> 4
            PhotosGridState.Grain.GRAIN_MONTHS -> 7
            else -> return day
        }
        val prefix = day.take(width)
        return days.firstOrNull { it.isNotEmpty() && it.startsWith(prefix) } ?: ""
    }

    private const val PINCH_OUT: Float = 1.15f
    private const val PINCH_IN: Float = 0.86f

    private const val MINUTES_PER_DAY: Long = 1_440

    /**
     * Minutes since the epoch, or null for anything but the narrow RFC 3339
     * shape described on [captureDay].
     */
    private fun epochMinutes(text: String): Long? {
        if (text.length < 20) return null
        if (text[4] != '-' || text[7] != '-' || (text[10] != 'T' && text[10] != ' ')) return null
        if (text[13] != ':' || text[16] != ':') return null
        val year = text.substring(0, 4).toIntOrNull() ?: return null
        val month = text.substring(5, 7).toIntOrNull() ?: return null
        val day = text.substring(8, 10).toIntOrNull() ?: return null
        val hour = text.substring(11, 13).toIntOrNull() ?: return null
        val minute = text.substring(14, 16).toIntOrNull() ?: return null
        if (month !in 1..12 || day !in 1..31 || hour !in 0..23 || minute !in 0..59) return null
        // The seconds and any fraction do not move a minute into another day,
        // so the suffix is found past them rather than parsed out of them.
        var at = 19
        if (at < text.length && text[at] == '.') {
            at += 1
            while (at < text.length && text[at].isDigit()) at += 1
        }
        if (at >= text.length) return null
        val zone = when (text[at]) {
            'Z', 'z' -> 0
            '+', '-' -> {
                if (text.length < at + 6 || text[at + 3] != ':') return null
                val hours = text.substring(at + 1, at + 3).toIntOrNull() ?: return null
                val minutes = text.substring(at + 4, at + 6).toIntOrNull() ?: return null
                val signed = hours * 60 + minutes
                if (text[at] == '+') signed else -signed
            }
            else -> return null
        }
        val days = daysFromCivil(year, month, day)
        return days * MINUTES_PER_DAY + hour * 60 + minute - zone
    }

    private fun floorDiv(value: Long, divisor: Long): Long {
        val quotient = value / divisor
        return if ((value % divisor != 0L) && ((value < 0) != (divisor < 0))) quotient - 1 else quotient
    }

    /** Howard Hinnant's `days_from_civil`, the inverse of the one below. */
    private fun daysFromCivil(year: Int, month: Int, day: Int): Long {
        val y = (if (month <= 2) year - 1 else year).toLong()
        val era = floorDiv(y, 400)
        val yearOfEra = y - era * 400
        val monthPrime = if (month > 2) month - 3 else month + 9
        val dayOfYear = (153 * monthPrime + 2) / 5 + day - 1
        val dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146_097 + dayOfEra - 719_468
    }

    /** `sync/Instants.kt`'s derivation, private there and restated here. */
    private fun civilFromDays(days: Long): Triple<Int, Int, Int> {
        val shifted = days + 719_468
        val era = floorDiv(shifted, 146_097)
        val dayOfEra = shifted - era * 146_097
        val yearOfEra = (dayOfEra - dayOfEra / 1_460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
        val year = yearOfEra + era * 400
        val dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        val monthPrime = (5 * dayOfYear + 2) / 153
        val day = dayOfYear - (153 * monthPrime + 2) / 5 + 1
        val month = if (monthPrime < 10) monthPrime + 3 else monthPrime - 9
        return Triple((if (month <= 2) year + 1 else year).toInt(), month.toInt(), day.toInt())
    }
}
