package dev.centraid.android.screens.agenda

import org.junit.Assert.assertEquals
import org.junit.Test

/** AN EVENT'S LINK IN THE PHONE'S DESCRIPTION: the reader splits it out of the notes. */
class CalendarLinkTest {
    @Test
    fun theLinkIsTheLastParagraphAndComesOutApart() {
        assertEquals(
            "Bring slides" to "https://example.com/offsite",
            CalendarLink.split("Bring slides\n\nhttps://example.com/offsite"),
        )
    }

    @Test
    fun aLinkWithNoNotesIsTheWholeDescription() {
        assertEquals("" to "https://example.com/a", CalendarLink.split("https://example.com/a"))
    }

    @Test
    fun noLinkLeavesTheNotesAsTheyAre() {
        assertEquals("Bring slides" to "", CalendarLink.split("Bring slides"))
        assertEquals("" to "", CalendarLink.split(""))
    }

    @Test
    fun onlyAWebAddressInItsOwnLastParagraphIsALink() {
        // A sentence that ends in an address, or an address mid-notes, stays in the notes.
        assertEquals("See https://example.com/a" to "", CalendarLink.split("See https://example.com/a"))
        assertEquals("https://example.com/a\n\nthen lunch" to "", CalendarLink.split("https://example.com/a\n\nthen lunch"))
        assertEquals("call 555-0100" to "", CalendarLink.split("call 555-0100"))
        assertEquals("https://" to "", CalendarLink.split("https://"))
    }
}
