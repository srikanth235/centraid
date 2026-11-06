package dev.centraid.android.notifications

import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class NotificationPermissionPromptTest {
    @get:Rule val temporary = TemporaryFolder()

    private fun record() = File(temporary.root, "permission-requested")

    @Test fun denialIsRememberedByANewSessionWithoutPromptingAgain() = runTest {
        val file = record()
        var prompts = 0
        NotificationPermissionPrompt(file).requestIfNeeded(needed = true, granted = false) {
            prompts += 1
            false
        }
        assertTrue(file.isFile)

        NotificationPermissionPrompt(file).requestIfNeeded(needed = true, granted = false) {
            prompts += 1
            false
        }
        assertEquals(1, prompts)
    }

    @Test fun noForegroundUiLeavesTheFirstRequestAvailable() = runTest {
        val file = record()
        val permission = NotificationPermissionPrompt(file)
        permission.requestIfNeeded(needed = true, granted = false, prompt = null)
        assertFalse(file.exists())

        var prompts = 0
        permission.requestIfNeeded(needed = true, granted = false) {
            prompts += 1
            true
        }
        assertEquals(1, prompts)
        assertTrue(file.isFile)
    }

    @Test fun anExistingGrantOrAnUnneededAlertDoesNotConsumeTheFirstRequest() = runTest {
        val file = record()
        val permission = NotificationPermissionPrompt(file)
        var prompts = 0
        val prompt: suspend () -> Boolean = { prompts += 1; false }
        permission.requestIfNeeded(needed = true, granted = true, prompt = prompt)
        permission.requestIfNeeded(needed = false, granted = false, prompt = prompt)
        assertEquals(0, prompts)
        assertFalse(file.exists())
    }

    @Test fun aCancelledLauncherDoesNotClaimThePermissionWasAsked() = runTest {
        val file = record()
        val permission = NotificationPermissionPrompt(file)
        var cancelled = false
        try {
            permission.requestIfNeeded(needed = true, granted = false) {
                throw CancellationException("launcher detached")
            }
        } catch (_: CancellationException) {
            cancelled = true
        }
        assertTrue(cancelled)
        assertFalse(file.exists())

        var prompts = 0
        permission.requestIfNeeded(needed = true, granted = false) {
            prompts += 1
            false
        }
        assertEquals(1, prompts)
        assertTrue(file.isFile)
    }

    @Test fun cancellationAfterTheSystemAnswerStillPersistsTheRequest() = runTest {
        val file = record()
        val io = StandardTestDispatcher(testScheduler)
        val permission = NotificationPermissionPrompt(file, io)
        val effect = launch {
            permission.requestIfNeeded(needed = true, granted = false) {
                currentCoroutineContext().cancel()
                false
            }
        }
        effect.join()
        assertTrue(effect.isCancelled)
        assertTrue(file.isFile)

        var prompts = 0
        NotificationPermissionPrompt(file, io).requestIfNeeded(needed = true, granted = false) {
            prompts += 1
            false
        }
        assertEquals(0, prompts)
    }

    @Test fun overlappingRequestsShareTheFirstPendingSystemPrompt() = runTest {
        val file = record()
        val permission = NotificationPermissionPrompt(file, StandardTestDispatcher(testScheduler))
        val answer = CompletableDeferred<Boolean>()
        var prompts = 0
        val first = launch {
            permission.requestIfNeeded(needed = true, granted = false) {
                prompts += 1
                answer.await()
            }
        }
        runCurrent()
        assertEquals(1, prompts)
        val second = launch {
            permission.requestIfNeeded(needed = true, granted = false) {
                prompts += 1
                false
            }
        }
        runCurrent()
        assertEquals(1, prompts)
        assertFalse(file.exists())

        answer.complete(false)
        joinAll(first, second)
        assertEquals(1, prompts)
        assertTrue(file.isFile)
    }
}
