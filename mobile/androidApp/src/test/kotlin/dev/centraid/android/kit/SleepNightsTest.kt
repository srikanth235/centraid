package dev.centraid.android.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A NIGHT IS COUNTED ONCE (#1129). The Android half of iOS's `HealthSleepMergeTests`: the watch's
 * stages and the phone's unstaged "asleep" overlap, [SleepNights] makes one night of them, and the
 * minutes are the union's. The day a night counts on is the one it ends (its rule, pinned here).
 */
class SleepNightsTest {
    private val minute = 60_000L
    private val day = 24 * 60 * minute

    /** A fake local calendar: the day number, so a test names the day by `end / day`. */
    private val dayOf: (Long) -> String = { "day-${it / day}" }

    private fun at(minutes: Long): Long = minutes * minute

    private fun span(from: Long, to: Long) = at(from) to at(to)

    /** A session over [from, to] minutes; with no [asleep] spans, the whole of it is asleep. */
    private fun session(from: Long, to: Long, vararg asleep: Pair<Long, Long>) =
        SleepNights.Session(
            at(from),
            at(to),
            if (asleep.isEmpty()) listOf(span(from, to)) else asleep.map { span(it.first, it.second) },
        )

    @Test
    fun overlappingSourcesAreOneNight() {
        val nights = SleepNights.minutesByEnd(
            listOf(
                // The watch's three stages, touching.
                session(0, 420, 0L to 120L, 120L to 240L, 240L to 420L),
                // The phone's interval, inside them.
                session(10, 410),
            ),
            dayOf,
        )
        assertEquals(mapOf("day-0" to 420.0), nights)
    }

    @Test
    fun aGapAwakeIsTwoRunsAndUnsortedSpansAreSortedAndAnEmptyOneCountsForNothing() {
        val nights = SleepNights.minutesByEnd(
            listOf(session(0, 400, 300L to 400L, 0L to 200L, 50L to 100L, 10L to 10L)),
            dayOf,
        )
        // 200 + 100 asleep; the 100 awake between them and the zero-length span are not counted.
        assertEquals(mapOf("day-0" to 300.0), nights)
    }

    @Test
    fun unsortedSessionsFoldTheSameAsSortedOnes() {
        val a = session(0, 420)
        val b = session(10, 410)
        assertEquals(SleepNights.minutesByEnd(listOf(a, b), dayOf), SleepNights.minutesByEnd(listOf(b, a), dayOf))
    }

    @Test
    fun aNightCountsOnTheDayItsLastSessionEnds() {
        val nights = SleepNights.minutesByEnd(
            listOf(
                // The phone saw 22:00 to 23:30; the watch saw 22:30 to 01:00 the next day: one night.
                session(22 * 60, 23 * 60 + 30),
                session(22 * 60 + 30, 24 * 60 + 60),
            ),
            dayOf,
        )
        // 22:00 to 01:00 asleep, counted whole on the day the night ends, none of it on the first.
        assertEquals(mapOf("day-1" to 180.0), nights)
    }

    @Test
    fun aSessionThatStartsWhereAnotherEndedIsANightOfItsOwn() {
        val nights = SleepNights.minutesByEnd(
            listOf(
                session(22 * 60, 23 * 60 + 30),
                session(23 * 60 + 30, 24 * 60 + 60),
            ),
            dayOf,
        )
        // Touching is not overlapping: each night counts on its own day.
        assertEquals(mapOf("day-0" to 90.0, "day-1" to 90.0), nights)
    }

    @Test
    fun twoNightsOnTwoDaysStayTwoDays() {
        val nights = SleepNights.minutesByEnd(
            listOf(session(0, 300), session(24 * 60, 24 * 60 + 360)),
            dayOf,
        )
        assertEquals(mapOf("day-0" to 300.0, "day-1" to 360.0), nights)
    }

    @Test
    fun aNightWithNoAsleepTimeIsNotANight() {
        val awakeOnly = SleepNights.Session(at(0), at(300), emptyList())
        assertTrue(SleepNights.minutesByEnd(listOf(awakeOnly), dayOf).isEmpty())
        assertTrue(SleepNights.minutesByEnd(emptyList(), dayOf).isEmpty())
    }
}
