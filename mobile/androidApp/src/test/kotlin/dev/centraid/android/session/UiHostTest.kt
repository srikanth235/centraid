package dev.centraid.android.session

import centraid.core.v1.EffectDone
import centraid.core.v1.EffectRequest
import centraid.core.v1.EffectResult
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class UiHostTest {
    @Test
    fun aDeferredPickerIsNotCancelledBeforeItsReply() = runTest {
        var reply: ((EffectResult) -> Unit)? = null
        val host = object : UiHost {
            override suspend fun perform(request: EffectRequest, answer: (EffectResult) -> Unit): EffectResult? {
                reply = answer
                return null
            }
            override suspend fun askMedia() = Unit
            override suspend fun ask(permission: String) = false
        }
        val answers = mutableListOf<EffectResult>()
        val immediate = performUiEffect(host, EffectRequest(), answers::add)
        assertNull(immediate)
        assertTrue(answers.isEmpty())
        val terminal = EffectResult(done = EffectDone())
        reply!!(terminal)
        assertEquals(listOf(terminal), answers)
    }

    @Test
    fun anAbsentWindowCancelsWithoutInvokingTheCallback() = runTest {
        var callbacks = 0
        val answer = performUiEffect(null, EffectRequest()) { callbacks += 1 }
        assertTrue(answer!!.failed!!.cancelled)
        assertEquals(0, callbacks)
    }

    @Test
    fun anImmediateHostReplyIsForwarded() = runTest {
        val terminal = EffectResult(done = EffectDone())
        val host = object : UiHost {
            override suspend fun perform(request: EffectRequest, answer: (EffectResult) -> Unit) = terminal
            override suspend fun askMedia() = Unit
            override suspend fun ask(permission: String) = false
        }
        assertSame(terminal, performUiEffect(host, EffectRequest()) { error("no callback expected") })
    }
}
