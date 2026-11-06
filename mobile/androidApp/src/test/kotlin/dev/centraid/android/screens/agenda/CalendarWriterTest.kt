package dev.centraid.android.screens.agenda

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CalendarWriterTest {
    @Test
    fun civilTimesUseTheEventsZoneAndRejectTheSpringGap() {
        assertEquals(Instant.parse("2026-03-08T13:30:00Z").toEpochMilli(), calendarMillis("2026-03-08T09:30", false, "America/New_York"))
        assertNull(calendarMillis("2026-03-08T02:30:00", false, "America/New_York"))
        assertNull(calendarMillis("2026-03-08T09:30", false, "invalid/zone"))
    }

    @Test
    fun repeatedTimesChooseTheFirstInstantAndRetainFractions() {
        assertEquals(Instant.parse("2026-11-01T05:30:00Z").toEpochMilli(), calendarMillis("2026-11-01T01:30:00", false, "America/New_York"))
        assertEquals(Instant.parse("2026-11-01T05:30:00.125Z").toEpochMilli(), calendarMillis("2026-11-01T01:30:00.125", false, "America/New_York"))
    }

    @Test
    fun allDayProviderTimesAreUtcAndTheLastDayIsInclusive() {
        assertEquals(Instant.parse("2026-03-08T00:00:00Z").toEpochMilli(), calendarMillis("2026-03-08", true, "America/New_York"))
        assertEquals(Instant.parse("2026-03-09T00:00:00Z").toEpochMilli(), calendarMillis("2026-03-08", true, "America/New_York", inclusiveEnd = true))
        assertNull(calendarMillis("2026-02-30", true, "UTC"))
    }
}
