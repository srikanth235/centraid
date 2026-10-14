package dev.centraid.android.screens.agenda

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A REPEATING EVENT'S LENGTH, as `CalendarContract` holds it: no `DTEND`, an
 * RFC 5545 `DURATION` instead — which is how a series' own first occurrence
 * gets its end ([durationMs]).
 */
class CalendarDurationTest {
    @Test
    fun theProvidersSpellingsParse() {
        assertEquals(3_600_000L, durationMs("P3600S"))
        assertEquals(5_400_000L, durationMs("PT1H30M"))
        assertEquals(86_400_000L, durationMs("P1D"))
        assertEquals(7 * 86_400_000L, durationMs("P1W"))
        assertEquals(-900_000L, durationMs("-PT15M"))
    }

    @Test
    fun anythingElseIsNoDuration() {
        assertNull(durationMs(null))
        assertNull(durationMs(""))
        assertNull(durationMs("P"))
        assertNull(durationMs("1 hour"))
    }
}
