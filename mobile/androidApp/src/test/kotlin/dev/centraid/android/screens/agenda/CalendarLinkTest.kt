package dev.centraid.android.screens.agenda

import org.junit.Assert.assertEquals
import org.junit.Test

/** AN EVENT'S LINK IN THE PHONE'S DESCRIPTION: what the writer joins, the reader splits back. */
class CalendarLinkTest {
    @Test
    fun theLinkIsTheLastParagraphAndComesBackApart() {
        val description = CalendarLink.join("Bring slides", "https://example.com/offsite")
        assertEquals("Bring slides\n\nhttps://example.com/offsite", description)
        assertEquals("Bring slides" to "https://example.com/offsite", CalendarLink.split(description))
    }

    @Test
    fun aLinkWithNoNotesIsTheWholeDescription() {
        val description = CalendarLink.join("", "https://example.com/a")
        assertEquals("https://example.com/a", description)
        assertEquals("" to "https://example.com/a", CalendarLink.split(description))
    }

    @Test
    fun noLinkLeavesTheNotesAsTheyAre() {
        assertEquals("Bring slides", CalendarLink.join("Bring slides", ""))
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

    @Test
    fun writingWhatWasReadChangesNothing() {
        for (description in listOf("", "Notes", "Notes\n\nhttps://example.com/x", "https://example.com/x", "a\n\nb\n\nhttp://h/p?q=1")) {
            val (notes, url) = CalendarLink.split(description)
            assertEquals(description, CalendarLink.join(notes, url))
        }
    }
}
