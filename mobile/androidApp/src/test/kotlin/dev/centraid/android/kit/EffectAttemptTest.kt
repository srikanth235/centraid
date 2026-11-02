package dev.centraid.android.kit

import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.ExperimentalCoroutinesApi
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class EffectAttemptTest {
    @Test
    fun platformFailureCanBeAnswered() {
        val failure = IOException("read failed")
        assertSame(failure, effectAttempt { throw failure }.exceptionOrNull())
    }

    @Test
    fun cancelledPlatformWorkDoesNotBecomeAFailureAnswer() = runTest {
        var answered = false
        val work = launch {
            effectAttempt<Unit> { awaitCancellation() }.getOrElse { answered = true }
        }
        runCurrent()
        work.cancel(CancellationException("session closed"))
        work.join()
        assertFalse(answered)
    }
}
