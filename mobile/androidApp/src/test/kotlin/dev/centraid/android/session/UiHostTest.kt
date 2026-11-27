package dev.centraid.android.session

import centraid.core.v1.EffectDone
import centraid.core.v1.EffectRequest
import centraid.core.v1.EffectResult
import centraid.core.v1.FollowGrant
import centraid.core.v1.OwnerChecked
import centraid.core.v1.ShellOwnerCheck
import dev.centraid.android.kit.EffectReason
import dev.centraid.android.kit.ownerCheckRequest
import dev.centraid.android.kit.shellOwnerAnswer
import dev.centraid.android.kit.OwnerPrompt
import androidx.biometric.BiometricPrompt
import centraid.core.v1.ShellEffect
import centraid.core.v1.ShellEffectResult
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class UiHostTest {
    @Test
    fun healthLimitedAccessStillReadsGrantedTypes() {
        assertTrue(grantAllowsSnapshot("health", FollowGrant.FOLLOW_GRANT_LIMITED))
        assertEquals(false, grantAllowsSnapshot("calendar", FollowGrant.FOLLOW_GRANT_LIMITED))
        assertEquals(false, grantAllowsSnapshot("health", FollowGrant.FOLLOW_GRANT_REFUSED))
    }

    @Test
    fun ownerCancelRequestsCancelPromptAndNeverBecomeUnlockFailure() {
        val cancel = ownerCheckRequest(ShellOwnerCheck(reason = "Unlock", cancel = true))
        assertTrue(cancel.cancel)
        assertEquals(false, cancel.ask)
        assertTrue(shellOwnerAnswer(true, EffectResult()).done != null)
        val unavailable = shellOwnerAnswer(
            false,
            EffectResult(owner_checked = OwnerChecked(available = false, outcome = OwnerChecked.Outcome.OUTCOME_UNAVAILABLE)),
        )
        assertEquals(EffectReason.UNAVAILABLE, unavailable.failed?.reason)
        assertEquals(OwnerChecked.Outcome.OUTCOME_UNAVAILABLE, OwnerPrompt.outcomeOf(BiometricPrompt.ERROR_HW_UNAVAILABLE))
        assertEquals(OwnerChecked.Outcome.OUTCOME_UNAVAILABLE, OwnerPrompt.outcomeOf(BiometricPrompt.ERROR_UNABLE_TO_PROCESS))
        assertEquals(OwnerChecked.Outcome.OUTCOME_LOCKED_OUT, OwnerPrompt.outcomeOf(BiometricPrompt.ERROR_LOCKOUT))
    }

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
            override suspend fun performShell(effect: ShellEffect) = ShellEffectResult()
            override suspend fun followCameraRoll(askPermission: Boolean) = FollowGrant.FOLLOW_GRANT_UNAVAILABLE
            override suspend fun pickFollowFolder() = FollowFolderPick(FollowGrant.FOLLOW_GRANT_UNAVAILABLE)
            override suspend fun askHealthPermissions(permissions: Set<String>) = emptySet<String>()
            override suspend fun askStorePermission(system: String, askPermission: Boolean) = false
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
            override suspend fun performShell(effect: ShellEffect) = ShellEffectResult()
            override suspend fun followCameraRoll(askPermission: Boolean) = FollowGrant.FOLLOW_GRANT_UNAVAILABLE
            override suspend fun pickFollowFolder() = FollowFolderPick(FollowGrant.FOLLOW_GRANT_UNAVAILABLE)
            override suspend fun askHealthPermissions(permissions: Set<String>) = emptySet<String>()
            override suspend fun askStorePermission(system: String, askPermission: Boolean) = false
        }
        assertSame(terminal, performUiEffect(host, EffectRequest()) { error("no callback expected") })
    }
}
