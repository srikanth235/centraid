package dev.centraid.android.room

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomTextStateTest {
    @Test
    fun editIncrementsSeqAndSuppressesNoOp() {
        val state = RoomTextState("hello", initialRev = 1L)
        assertNull(state.onEdit("hello"))
        assertEquals(1L, state.seq)

        val first = state.onEdit("hello!")
        assertEquals("hello!" to 2L, first)
        assertEquals("hello!", state.value)
        assertEquals(2L, state.seq)
    }

    @Test
    fun staleRustEchoDoesNotOverwriteNewerLocalEdit() {
        val state = RoomTextState("a", initialRev = 0L)
        assertEquals("ab" to 1L, state.onEdit("ab"))
        assertEquals("abc" to 2L, state.onEdit("abc"))

        assertFalse(state.onRustUpdate("ab", rev = 1L))
        assertEquals("abc", state.value)
    }

    @Test
    fun rustUpdateAtOrAboveLastSentSeqIsAdoptedWhenDifferent() {
        val state = RoomTextState("a", initialRev = 0L)
        assertEquals("ab" to 1L, state.onEdit("ab"))

        assertFalse(state.onRustUpdate("ab", rev = 1L))
        assertTrue(state.onRustUpdate("cleared", rev = 2L))
        assertEquals("cleared", state.value)
        assertEquals(2L, state.seq)
    }

    @Test
    fun maxCharsBoundsCommittedText() {
        val state = RoomTextState("", initialRev = 0L)
        val edit = state.onEdit("abcdef", maxChars = 4)
        assertEquals("abcd" to 1L, edit)
        assertEquals("abcd", state.value)
    }
}
