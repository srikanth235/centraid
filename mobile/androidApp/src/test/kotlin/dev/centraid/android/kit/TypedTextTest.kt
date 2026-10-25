package dev.centraid.android.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE FIELD'S TYPING AGAINST THE MACHINE'S ECHOES (#1047 walk, B1): a value the
 * machine says replaces what the member typed only when it is not an echo of the
 * field's own typing. The ten cases of the shared module's `TypedTextSpec`, kept
 * with the type it became (#1135).
 */
class TypedTextTest {
    private fun typed(initial: String, vararg keys: String): TypedText =
        TypedText(initial).also { t -> keys.forEach { t.edited(it) } }

    @Test
    fun aSaveThatLandsMidTypingDoesNotTakeBackTheKeystrokesTypedSince() {
        val t = typed("", "Body of the w", "Body of the wa", "Body of the wal")
        assertNull(t.answer("Body of the w", shown = "Body of the wal", open = false))
        // The save of "Body of the w" lands: CLEAN, a new baseline, the reload gate opens.
        assertNull(t.answer("Body of the w", shown = "Body of the wal", open = true))
        assertNull(t.answer("Body of the wa", shown = "Body of the wal", open = false))
        assertNull(t.answer("Body of the wal", shown = "Body of the wal", open = true))
    }

    @Test
    fun theFirstSaveThatMintsTheIdDoesNotTakeBackWhatWasTypedAfterIt() {
        val t = typed("", "W", "Wa", "Wal")
        assertNull(t.answer("W", shown = "Wal", open = false))
        assertNull(t.answer("W", shown = "Wal", open = true))
    }

    @Test
    fun aLateEchoWhileTypingIsNeverAdopted() {
        val t = typed("", "a", "ab", "abc")
        assertNull(t.answer("a", shown = "abc"))
        assertNull(t.answer("ab", shown = "abc"))
    }

    @Test
    fun anEchoOfAnEmptiedFieldIsNotAClear() {
        // Typed x, erased it, typed y.
        val t = typed("", "x", "", "y")
        assertNull(t.answer("x", shown = "y"))
        assertNull(t.answer("", shown = "y"))
        assertNull(t.answer("y", shown = "y"))
    }

    @Test
    fun aClearAfterSubmitLandsEvenToAValueTheMemberOnceTyped() {
        val t = typed("", "W", "", "Work")
        assertNull(t.answer("Work", shown = "Work"))
        assertEquals("", t.answer("", shown = "Work"))
    }

    @Test
    fun aClearLandsWhenTheStatesBetweenWereConflatedAway() {
        val t = typed("", "a", "ab", "a")
        // The view only ever saw the final echo: every keystroke is heard.
        assertNull(t.answer("a", shown = "a"))
        assertEquals("", t.answer("", shown = "a"))
    }

    @Test
    fun aValueTheMemberDidNotTypeLands() {
        // A splice, a remote load, a generated value.
        val t = typed("abc", "abcd")
        assertNull(t.answer("abcd", shown = "abcd"))
        assertEquals("abcd [[Plan]]", t.answer("abcd [[Plan]]", shown = "abcd"))
    }

    @Test
    fun aClosedGateHoldsAValueTheMemberDidNotType() {
        val t = typed("abc")
        assertNull(t.answer("xyz", shown = "abc", open = false))
        assertEquals("xyz", t.answer("xyz", shown = "abc", open = true))
    }

    @Test
    fun typingBackToTheMachinesStaleValueIsStillSent() {
        val t = TypedText("a")
        assertTrue(t.edited("ab"))
        assertTrue(t.edited("a"))
        assertFalse(t.edited("a"))
        assertNull(t.answer("ab", shown = "a"))
        assertNull(t.answer("a", shown = "a"))
    }

    @Test
    fun afterAnAdoptionTheAdoptedValueIsNotResent() {
        val t = typed("", "a")
        assertNull(t.answer("a", shown = "a"))
        assertEquals("loaded", t.answer("loaded", shown = "a"))
        assertFalse(t.edited("loaded"))
        assertTrue(t.edited("loaded!"))
    }
}
