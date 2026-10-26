package dev.centraid.android.session

import org.junit.Assert.assertEquals
import org.junit.Test

/** The capture's zone from `OffsetTimeOriginal` (D-1025-S7-77): zero for anything not a zone. */
class ExifOffsetTest {
    @Test
    fun theThreeSpellingsOfAZoneAreMinutesEast() {
        assertEquals(330, LibraryRoll.offsetMinutes("+05:30"))
        assertEquals(-480, LibraryRoll.offsetMinutes("-0800"))
        assertEquals(60, LibraryRoll.offsetMinutes("+01"))
        assertEquals(0, LibraryRoll.offsetMinutes("Z"))
    }

    @Test
    fun aMalformedOrOutOfBoundsTagIsZero() {
        assertEquals(0, LibraryRoll.offsetMinutes(null))
        assertEquals(0, LibraryRoll.offsetMinutes(""))
        assertEquals(0, LibraryRoll.offsetMinutes("05:30"))
        assertEquals(0, LibraryRoll.offsetMinutes("+05:60"))
        assertEquals(0, LibraryRoll.offsetMinutes("+19:00"))
        assertEquals(0, LibraryRoll.offsetMinutes("+٠٥:٣٠"))
        assertEquals(-60, LibraryRoll.offsetMinutes(" -01:00\u0000"))
    }
}
