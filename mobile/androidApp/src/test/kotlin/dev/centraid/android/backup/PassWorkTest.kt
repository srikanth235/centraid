package dev.centraid.android.backup

import centraid.core.v1.ShellFact
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A WINDOW'S TWO ENDS, AS THE PASS SCHEDULER HEARS THEM (#1152; `ShellFact.window` and `.expired`).
 *
 * `PassWork.granted` is the one place a `CoroutineWorker` meets Rust: it reports the grant, then
 * waits for `PassWindowDone`. WorkManager's stop reaches it only as cancellation (the worker's own
 * `onStopped` is final), so the expiry the proto names for "WorkManager's stop" is sent from there,
 * once, after the grant, and the cancellation is not swallowed. Each rule has its negative beside
 * it: a window that ends normally reports no expiry, and the expiry names the window that stopped.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class PassWorkTest {
    @Test
    fun aStoppedWindowIsReportedExpiredAfterItsGrantAndTheStopGoesOn() = runTest {
        val facts = mutableListOf<ShellFact>()
        val pass = async(start = CoroutineStart.UNDISPATCHED) {
            PassWork.granted("centraid-sync-pass", 540_000L) { facts += it }
        }
        runCurrent()
        assertEquals(1, facts.size)
        assertEquals(540_000L, facts[0].window?.deadline_ms)

        pass.cancel()
        runCurrent()

        assertTrue("the stop must reach the caller, not become an answer", pass.isCancelled)
        assertEquals(2, facts.size)
        assertEquals("centraid-sync-pass", facts[1].expired?.window)
        assertNull("an expiry is not a grant", facts[1].window)
        val thrown = runCatching { pass.await() }.exceptionOrNull()
        assertTrue(thrown is CancellationException)
    }

    @Test
    fun aWindowRustEndsReportsNoExpiryAndAnswersWhetherItDrained() = runTest {
        val facts = mutableListOf<ShellFact>()
        val pass = async(start = CoroutineStart.UNDISPATCHED) {
            PassWork.granted("centraid-sync-nightly", 540_000L) { facts += it }
        }
        runCurrent()
        PassWork.windowDone("centraid-sync-nightly", drained = true)
        runCurrent()

        assertTrue(pass.await())
        assertEquals(1, facts.size)
        assertNotNull(facts[0].window)
        assertFalse(facts.any { it.expired != null })
    }
}
