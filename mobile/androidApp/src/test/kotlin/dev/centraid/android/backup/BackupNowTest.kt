package dev.centraid.android.backup

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * "BACK UP NOW" RUNS UNTIL THE PASS ENDS OR THE SYSTEM STOPS IT (#1188, B8).
 *
 * The run used to hold the process for thirty minutes and then end, whether or not Rust's pass
 * had finished. It has no clock of its own now: its end is Rust's `LongRun(false)` (`stop`) or the
 * system cancelling the job. Virtual time, so no test waits on a wall clock.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class BackupNowTest {
    @Test
    fun theRunOutlastsAnyBudgetItOnceHad() = runTest {
        val run = async(start = CoroutineStart.UNDISPATCHED) { BackupNow.holdUntilStopped() }
        advanceTimeBy(24L * 60L * 60L * 1_000L)
        runCurrent()
        assertTrue("a day on, the run still holds the process", run.isActive)
        run.cancel()
    }

    @Test
    fun theSystemStoppingTheJobEndsTheRun() = runTest {
        val run = async(start = CoroutineStart.UNDISPATCHED) { BackupNow.holdUntilStopped() }
        run.cancel()
        runCurrent()
        assertFalse(run.isActive)
        assertTrue(run.isCancelled)
    }
}
