package dev.centraid.android.kit

import org.junit.Assert.assertEquals
import org.junit.Test

/** A player's time as `m:ss`: the shared module's `MediaFormatSpec` clock cases, kept with the type they became (#1135). */
class MediaClockTest {
    @Test
    fun aLengthReadsMinutesAndSecondsAndHoursPastTheHour() {
        assertEquals("0:00", MediaClock.clock(0L))
        assertEquals("0:04", MediaClock.clock(4L))
        assertEquals("1:04", MediaClock.clock(64L))
        assertEquals("12:07", MediaClock.clock(727L))
        assertEquals("59:59", MediaClock.clock(3_599L))
        assertEquals("1:00:00", MediaClock.clock(3_600L))
        // A 61-minute recording is not `61:40`.
        assertEquals("1:01:40", MediaClock.clock(3_700L))
        assertEquals("0:00", MediaClock.clock(-5L))
    }

    @Test
    fun aPlayersFractionOfASecondIsTruncatedAndAStreamThatHasNotLoadedIsNought() {
        assertEquals("0:04", MediaClock.clockOf(4.9))
        assertEquals("1:01:40", MediaClock.clockOf(3_700.2))
        assertEquals("0:00", MediaClock.clockOf(Double.NaN))
        assertEquals("0:00", MediaClock.clockOf(Double.POSITIVE_INFINITY))
        assertEquals("0:00", MediaClock.clockOf(-1.0))
    }
}
