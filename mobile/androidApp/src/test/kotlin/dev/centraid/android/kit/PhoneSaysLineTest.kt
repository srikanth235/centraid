package dev.centraid.android.kit

import centraid.core.v1.PhoneSays
import centraid.core.v1.PhoneSaysTake
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** THE PHONE-SAYS LINE (#1183): when it is drawn at all, and the ids a flow finds it by. */
class PhoneSaysLineTest {
    private val line = PhoneSays(
        lead = "Phone says Ada Lovelase",
        action_label = "Use phone’s",
        accessibility_label = "Use the name your phone has, Ada Lovelase",
        take = PhoneSaysTake(field = "name"),
    )

    @Test
    fun anAbsentLineDrawsNothing() {
        assertFalse(phoneSaysDrawn(null))
    }

    @Test
    fun aLineWithoutWordsDrawsNothing() {
        assertFalse(phoneSaysDrawn(PhoneSays()))
        assertFalse(phoneSaysDrawn(line.copy(lead = "")))
        assertFalse(phoneSaysDrawn(line.copy(action_label = "")))
    }

    @Test
    fun aLineWithWordsIsDrawn() {
        assertTrue(phoneSaysDrawn(line))
    }

    @Test
    fun aWholeFieldIsIdentifiedByItsFieldAlone() {
        val ids = phoneSaysIds(line.take)
        assertEquals("phone-says-name", ids.line)
        assertEquals("phone-says-take-name", ids.take)
    }

    @Test
    fun anItemOfAFieldIsIdentifiedByFieldAndItem() {
        val ids = phoneSaysIds(PhoneSaysTake(field = "channels", item_key = "email:ada@lovelace.example"))
        assertEquals("phone-says-channels-email:ada@lovelace.example", ids.line)
        assertEquals("phone-says-take-channels-email:ada@lovelace.example", ids.take)
    }

    @Test
    fun aTakeWithNothingNamedStillHasStableIds() {
        assertEquals("phone-says", phoneSaysIds(null).line)
        assertEquals("phone-says-take", phoneSaysIds(PhoneSaysTake()).take)
    }
}
