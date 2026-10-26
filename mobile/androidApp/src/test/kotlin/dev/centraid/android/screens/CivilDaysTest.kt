package dev.centraid.android.screens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The date picker's day arithmetic: `YYYY-MM-DD` to whole days since the epoch and back. */
class CivilDaysTest {
    @Test
    fun theEpochAndItsNeighboursAreDayZeroAndOne() {
        assertEquals(0L, epochDayOf("1970-01-01"))
        assertEquals(1L, epochDayOf("1970-01-02"))
        assertEquals(-1L, epochDayOf("1969-12-31"))
        assertEquals("1970-01-01", civilDayOf(0))
        assertEquals("1969-12-31", civilDayOf(-1))
    }

    @Test
    fun aLeapDayRoundTripsAndANonDayIsNone() {
        val leap = epochDayOf("2024-02-29")!!
        assertEquals("2024-02-29", civilDayOf(leap))
        assertEquals("2024-03-01", civilDayOf(leap + 1))
        assertNull(epochDayOf("2023-02-29"))
        assertNull(epochDayOf("2024-13-01"))
        assertNull(epochDayOf("not a day"))
    }

    @Test
    fun aPickersMillisFallInTheirDay() {
        val millis = millisOfDay("2026-10-25")!!
        assertEquals("2026-10-25", dayOfMillis(millis))
        assertEquals("2026-10-25", dayOfMillis(millis + 86_399_999L))
        assertEquals("2026-10-24", dayOfMillis(millis - 1))
    }
}
