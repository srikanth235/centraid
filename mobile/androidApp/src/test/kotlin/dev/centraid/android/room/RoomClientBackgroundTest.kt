package dev.centraid.android.room

import centraid.core.v1.Envelope
import centraid.core.v1.Request
import centraid.core.v1.Response
import centraid.core.v1.Room
import centraid.core.v1.RoomLifecycle
import centraid.core.v1.RoomOpen
import centraid.core.v1.RoomRequest
import centraid.core.v1.RoomResponse
import centraid.core.v1.RoomShown
import centraid.core.v1.Event
import centraid.core.v1.ShellDone
import centraid.core.v1.ShellEffect
import centraid.core.v1.ShellEffectResult
import centraid.core.v1.ShellOwnerCheck
import dev.centraid.core.CoreOutcome
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.cancel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomClientBackgroundTest {
    @Test
    @OptIn(ExperimentalCoroutinesApi::class)
    fun backgroundMasksSecureCachedRoomBeforeCoreAndPerformsReturnedOwnerCancelOnce() = runTest {
        lateinit var client: RoomClient
        var sawMaskedCache = false
        val coreAnswers = mutableListOf<ShellEffectResult>()
        val ownerCancel = ShellEffect(effect_id = 77, owner_check = ShellOwnerCheck(reason = "Unlock", cancel = true))
        client = RoomClient({ request ->
            val room = request.request?.room
            request.request?.room?.send?.event?.effect_result?.let(coreAnswers::add)
            val response = when {
                room?.open_?.key == "locker/item/secret" -> RoomResponse(secure_epoch = 1, shown = listOf(
                    RoomShown(tab = "locker", instance = 7, secure_epoch = 1, room = Room(secure = true)),
                ))
                room?.open_?.key == "calendar" -> RoomResponse(secure_epoch = 1, shown = listOf(
                    RoomShown(tab = "calendar", instance = 8, secure_epoch = 1, room = Room(secure = false)),
                ))
                room?.lifecycle?.phase == RoomLifecycle.Phase.BACKGROUND -> {
                    sawMaskedCache = client.tabs.value["locker"] == null && client.tabs.value["calendar"] != null
                    RoomResponse(
                        secure_epoch = 2,
                        shown = listOf(RoomShown(tab = "locker", instance = 7, secure_epoch = 2, room = Room(secure = true))),
                        effects = listOf(ownerCancel),
                    )
                }
                else -> RoomResponse()
            }
            CoreOutcome.Answered(Envelope(response = Response(room = response)))
        }, this)
        val performed = mutableListOf<ShellEffect>()
        client.shellEffectPerformer = { effect ->
            performed += effect
            ShellEffectResult(effect_id = effect.effect_id, done = ShellDone())
        }
        client.open("locker/item/secret", tab = "locker")
        client.open("calendar", tab = "calendar")
        client.background()
        advanceUntilIdle()

        assertTrue(sawMaskedCache)
        assertNull(client.tabs.value["locker"])
        assertTrue(client.tabs.value.containsKey("calendar"))
        assertEquals(listOf(ownerCancel), performed)
        assertEquals(77L, coreAnswers.single().effect_id)
        assertEquals(1, coreAnswers.size)
    }

    @Test
    @OptIn(ExperimentalCoroutinesApi::class)
    fun foregroundRebuildsLockedWallAndRejectsLatePreBackgroundSecureSnapshot() = runTest {
        val events = MutableSharedFlow<Event>(extraBufferCapacity = 4)
        val performed = mutableListOf<ShellEffect>()
        val client = RoomClient(events, { request ->
            val lifecycle = request.request?.room?.lifecycle
            val openKey = request.request?.room?.open_?.key
            val response = when (lifecycle?.phase) {
                RoomLifecycle.Phase.BACKGROUND -> RoomResponse(
                    secure_epoch = 2,
                    shown = listOf(RoomShown(tab = "locker", instance = 22, secure_epoch = 2, room = Room(secure = true))),
                )
                RoomLifecycle.Phase.FOREGROUND -> RoomResponse(
                    secure_epoch = 2,
                    shown = listOf(RoomShown(tab = "locker", instance = 23, secure_epoch = 2, room = Room(secure = true))),
                )
                else -> when (openKey) {
                    "locker/item/unlocked" -> RoomResponse(
                        secure_epoch = 1,
                        shown = listOf(RoomShown(tab = "locker", instance = 21, secure_epoch = 1, room = Room(secure = true))),
                    )
                    "calendar" -> RoomResponse(
                        secure_epoch = 1,
                        shown = listOf(RoomShown(tab = "calendar", instance = 30, secure_epoch = 1, room = Room(secure = false))),
                    )
                    "stale" -> RoomResponse(
                        secure_epoch = 1,
                        shown = listOf(RoomShown(tab = "locker", instance = 24, secure_epoch = 1, room = Room(secure = true))),
                        effects = listOf(
                            ShellEffect(effect_id = 25, owner_check = ShellOwnerCheck(reason = "Unlock")),
                            ShellEffect(effect_id = 26, clipboard_copy = centraid.core.v1.ShellClipboardCopy(text = "secret", sealed_ = true)),
                        ),
                    )
                    else -> RoomResponse()
                }
            }
            CoreOutcome.Answered(Envelope(response = Response(room = response)))
        }, this)
        client.shellEffectPerformer = { effect ->
            performed += effect
            ShellEffectResult(effect_id = effect.effect_id, done = ShellDone())
        }
        val attachment = client.attach()
        runCurrent()
        client.open("locker/item/unlocked", tab = "locker")
        client.open("calendar", tab = "calendar")
        events.emit(Event(room = RoomShown(tab = "locker", instance = 21, secure_epoch = 1, room = Room(secure = true))))
        client.background()
        assertNull(client.tabs.value["locker"])
        assertTrue(client.tabs.value.containsKey("calendar"))

        client.foreground()
        assertEquals(23L, client.tabs.value["locker"]?.instance)
        assertEquals(2L, client.tabs.value["locker"]?.secure_epoch)
        assertTrue(client.tabs.value.containsKey("calendar"))

        val stale = client.open("stale", tab = "locker")
        advanceUntilIdle()
        assertTrue(stale is CoreOutcome.Answered)
        assertEquals(23L, client.tabs.value["locker"]?.instance)
        assertTrue("stale secure effects must not reach native owner prompts", performed.isEmpty())

        // A previously queued reveal arrives after foreground. Its epoch must remain stale.
        events.emit(Event(room = RoomShown(tab = "locker", instance = 21, secure_epoch = 1, room = Room(secure = true))))
        advanceUntilIdle()
        assertEquals(23L, client.tabs.value["locker"]?.instance)
        assertEquals(2L, client.tabs.value["locker"]?.secure_epoch)
        attachment.cancel()
    }

    @Test
    @OptIn(ExperimentalCoroutinesApi::class)
    fun queuedPreBackgroundOwnerPromptIsDroppedAfterEpochAdvancesButRelockCancelRuns() = runTest {
        val performed = mutableListOf<ShellEffect>()
        val client = RoomClient({ request ->
            val response = if (request.request?.room?.lifecycle?.phase == RoomLifecycle.Phase.BACKGROUND) {
                RoomResponse(
                    secure_epoch = 2,
                    shown = listOf(RoomShown(tab = "locker", instance = 2, secure_epoch = 2, room = Room(secure = true))),
                    effects = listOf(ShellEffect(effect_id = 11, owner_check = ShellOwnerCheck(reason = "Unlock", cancel = true))),
                )
            } else {
                RoomResponse(
                    secure_epoch = 1,
                    shown = listOf(RoomShown(tab = "locker", instance = 1, secure_epoch = 1, room = Room(secure = true))),
                    effects = listOf(ShellEffect(effect_id = 10, owner_check = ShellOwnerCheck(reason = "Unlock"))),
                )
            }
            CoreOutcome.Answered(Envelope(response = Response(room = response)))
        }, this)
        client.shellEffectPerformer = { effect ->
            performed += effect
            ShellEffectResult(effect_id = effect.effect_id, done = ShellDone())
        }

        client.open("locker/item/pending", tab = "locker") // queues owner prompt at epoch 1
        client.background() // raises the floor and returns the explicit owner-cancel at epoch 2
        advanceUntilIdle()

        assertEquals(listOf(11L), performed.map { it.effect_id })
    }
}
