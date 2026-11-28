package dev.centraid.android.room

import centraid.core.v1.Envelope
import centraid.core.v1.Event
import centraid.core.v1.FollowGrant
import centraid.core.v1.FollowRequest
import centraid.core.v1.FollowVerb
import centraid.core.v1.Request
import centraid.core.v1.Response
import centraid.core.v1.Room
import centraid.core.v1.RoomOpen
import centraid.core.v1.RoomRequest
import centraid.core.v1.RoomResponse
import centraid.core.v1.RoomShown
import centraid.core.v1.ShellClipboardCopy
import centraid.core.v1.ShellDone
import centraid.core.v1.ShellEffect
import centraid.core.v1.ShellEffectResult
import centraid.core.v1.ShellOwnerCheck
import centraid.core.v1.ShellStoreRead
import dev.centraid.core.CoreOutcome
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomClientGlobalEffectTest {
    @Test
    @OptIn(ExperimentalCoroutinesApi::class)
    fun globalOwnerCancelAndOwnedClipboardClearAreOneWayAndIdempotent() = runTest {
        val events = MutableSharedFlow<Event>(extraBufferCapacity = 8)
        val roomResults = mutableListOf<Long>()
        val client = RoomClient(events, { request ->
            request.request?.room?.send?.event?.effect_result?.let { roomResults += it.effect_id }
            CoreOutcome.Answered(Envelope(response = Response(room = RoomResponse())))
        }, this)
        val performed = mutableListOf<ShellEffect>()
        client.shellEffectPerformer = { effect ->
            performed += effect
            ShellEffectResult(effect_id = effect.effect_id, done = ShellDone())
        }
        val attach = client.attach()
        runCurrent()

        val ownerCancel = ShellEffect(effect_id = 701, owner_check = ShellOwnerCheck(reason = "Unlock", cancel = true))
        val clearOwned = ShellEffect(
            effect_id = 702,
            clipboard_copy = ShellClipboardCopy(owner_vault_id = "old-vault", clear_owned = true),
        )
        events.emit(Event(effect = ownerCancel))
        events.emit(Event(effect = ownerCancel))
        events.emit(Event(effect = clearOwned))
        events.emit(Event(effect = clearOwned))
        advanceUntilIdle()

        assertEquals(listOf(ownerCancel, clearOwned), performed)
        assertEquals("old-vault", performed.last().clipboard_copy?.owner_vault_id)
        assertTrue(performed.last().clipboard_copy?.clear_owned == true)
        assertTrue("front-core controls do not send RoomEvent.effect_result", roomResults.isEmpty())
        attach.cancel()
    }

    @Test
    @OptIn(ExperimentalCoroutinesApi::class)
    fun globalOwnerCancelRunsBesideBlockedStoreReadAndSuppressesLatePromptAnswer() = runTest {
        val events = MutableSharedFlow<Event>(extraBufferCapacity = 8)
        val readStarted = CompletableDeferred<Unit>()
        val readRelease = CompletableDeferred<Unit>()
        val ownerStarted = CompletableDeferred<Unit>()
        val ownerRelease = CompletableDeferred<ShellEffectResult>()
        val cancelReachedNative = CompletableDeferred<Unit>()
        val roomResults = mutableListOf<Long>()
        val ownerAsk = ShellEffect(effect_id = 711, owner_check = ShellOwnerCheck(reason = "Unlock"))
        val client = RoomClient(events, { request ->
            val room = request.request?.room
            room?.send?.event?.effect_result?.let { roomResults += it.effect_id }
            val response = if (room?.open_?.key == "locker/item/old") {
                RoomResponse(
                    secure_epoch = 1,
                    shown = listOf(RoomShown(tab = "locker", instance = 71, secure_epoch = 1, room = Room(secure = true))),
                    effects = listOf(ownerAsk),
                )
            } else {
                RoomResponse()
            }
            CoreOutcome.Answered(Envelope(response = Response(room = response)))
        }, this)
        client.followReadPerformer = {
            readStarted.complete(Unit)
            readRelease.await()
            FollowRequest(
                verb = FollowVerb.FOLLOW_VERB_PASS,
                system = "contacts",
                ask_id = it.effect_id,
                grant = FollowGrant.FOLLOW_GRANT_GRANTED,
            )
        }
        client.shellEffectPerformer = { effect ->
            when {
                effect.owner_check?.cancel == true -> {
                    cancelReachedNative.complete(Unit)
                    ShellEffectResult(effect_id = effect.effect_id, done = ShellDone())
                }
                effect.owner_check != null -> {
                    ownerStarted.complete(Unit)
                    ownerRelease.await()
                }
                else -> ShellEffectResult(effect_id = effect.effect_id, done = ShellDone())
            }
        }

        val attach = client.attach()
        runCurrent()
        events.emit(Event(effect = ShellEffect(effect_id = 710, store_read = ShellStoreRead(system = "contacts"))))
        runCurrent()
        assertTrue(readStarted.isCompleted)

        client.open("locker/item/old", tab = "locker")
        runCurrent()
        assertTrue(ownerStarted.isCompleted)

        events.emit(Event(effect = ShellEffect(effect_id = 712, owner_check = ShellOwnerCheck(reason = "Unlock", cancel = true))))
        runCurrent()
        assertTrue("cancel bypasses the still-pending StoreRead", cancelReachedNative.isCompleted)
        assertFalse(readRelease.isCompleted)

        ownerRelease.complete(ShellEffectResult(effect_id = ownerAsk.effect_id, done = ShellDone()))
        advanceUntilIdle()
        assertTrue("late owner callback from the evicted room is suppressed", roomResults.isEmpty())

        readRelease.complete(Unit)
        advanceUntilIdle()
        attach.cancel()
    }
}
