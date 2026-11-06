package dev.centraid.android.widgets

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue

class AgendaWidgetSizingTest {
    @Test fun smallWidgetKeepsItsActionAndTimestampVisible() {
        assertEquals(1, AgendaWidgetSizing.at(180, 1f).eventLines)
        assertFalse(AgendaWidgetSizing.at(180, 1f).showReminders)
        assertTrue(AgendaWidgetSizing.at(300, 1f).showReminders)
    }

    @Test fun accessibilityTextReflowsToTheCompactSummary() {
        assertFalse(AgendaWidgetSizing.at(300, 2f).showReminders)
        assertEquals(1, AgendaWidgetSizing.at(300, 2f).eventLines)
        assertTrue(AgendaWidgetSizing.at(600, 2f).showReminders)
    }
}
