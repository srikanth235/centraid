package dev.centraid.android.session

import centraid.core.v1.ClipboardClearOwned
import centraid.core.v1.ClipboardSet
import centraid.core.v1.Effect
import centraid.core.v1.EffectRequest
import centraid.core.v1.ScheduleNotifications
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class EffectRequestQueuesTest {
    @Test
    fun clipboardCopyAndLockClearStayOrderedAcrossScreens() = runTest {
        val blockerStarted = CompletableDeferred<Unit>()
        val releaseBlocker = CompletableDeferred<Unit>()
        val completed = mutableListOf<Long>()
        var clipboardText = ""
        var clipboardOwner = ""
        val queues = EffectRequestQueues(backgroundScope) { request ->
            val effect = request.effect!!
            val set = effect.clipboard_set
            val clear = effect.clipboard_clear
            val clearOwned = effect.clipboard_clear_owned
            when {
                effect.schedule_notifications != null -> {
                    blockerStarted.complete(Unit)
                    releaseBlocker.await()
                }
                set != null -> {
                    clipboardText = set.text
                    clipboardOwner = set.owner_vault_id
                }
                clear != null -> {
                    if (clipboardText == clear.expected_text) clipboardText = ""
                }
                clearOwned != null -> {
                    if (clipboardOwner == clearOwned.vault_id) {
                        clipboardText = ""
                        clipboardOwner = ""
                    }
                }
            }
            completed += request.effect_id
        }

        queues.submit(
            EffectRequest(
                effect_id = 1,
                instance = 41,
                effect = Effect(schedule_notifications = ScheduleNotifications()),
            ),
        )
        runCurrent()
        assertTrue(blockerStarted.isCompleted)

        // The item screen's pending Copy is followed by Home's Lock clear.
        queues.submit(
            EffectRequest(
                effect_id = 2,
                instance = 41,
                effect = Effect(clipboard_set = ClipboardSet(text = CLIP, sensitive = true, owner_vault_id = VAULT)),
            ),
        )
        queues.submit(
            EffectRequest(
                effect_id = 3,
                instance = 7,
                effect = Effect(clipboard_clear_owned = ClipboardClearOwned(vault_id = VAULT)),
            ),
        )
        runCurrent()

        releaseBlocker.complete(Unit)
        runCurrent()

        assertEquals(listOf(2L, 3L), completed.filter { it != 1L })
        assertEquals("", clipboardText)
        assertEquals("", clipboardOwner)
    }

    private companion object {
        const val CLIP = "synthetic Locker copy"
        const val VAULT = "vault-fixture"
    }
}
