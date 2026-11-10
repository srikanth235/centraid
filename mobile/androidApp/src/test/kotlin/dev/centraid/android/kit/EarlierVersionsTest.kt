package dev.centraid.android.kit

import centraid.core.v1.EarlierEntry
import centraid.core.v1.EarlierRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** THE EARLIER-VERSIONS ENTRY AND ROWS (#1185): when each is drawn, and the ids a flow finds them by. */
class EarlierVersionsTest {
    private val entry = EarlierEntry(
        label = "Earlier versions",
        count_label = "2",
        accessibility_label = "Earlier versions, 2",
    )
    private val current = EarlierRow(seq = 0, label = "Wed 4 November · 09:12", current = true, current_label = "Current")
    private val earlier = EarlierRow(seq = 7, label = "Tue 27 October · 20:40", restore_label = "Restore")

    @Test
    fun anAbsentEntryDrawsNothing() {
        assertFalse(earlierEntryDrawn(null))
        assertFalse(earlierEntryDrawn(EarlierEntry()))
    }

    @Test
    fun anEntryWithWordsIsDrawnUnderItsId() {
        assertTrue(earlierEntryDrawn(entry))
        assertEquals("earlier-entry", EARLIER_ENTRY_TAG)
    }

    @Test
    fun theCurrentRowHasItsTagAndNoRestore() {
        assertTrue(earlierShowsCurrentTag(current))
        assertFalse(earlierShowsRestore(current))
    }

    @Test
    fun anEarlierRowRestoresAndHasNoTag() {
        assertFalse(earlierShowsCurrentTag(earlier))
        assertTrue(earlierShowsRestore(earlier))
        assertFalse(earlierShowsRestore(earlier.copy(restore_label = "")))
    }

    @Test
    fun rowsAreIdentifiedBySeq() {
        assertEquals("earlier-row-7", earlierRowTag(7))
        assertEquals("earlier-restore-7", earlierRestoreTag(7))
    }
}
