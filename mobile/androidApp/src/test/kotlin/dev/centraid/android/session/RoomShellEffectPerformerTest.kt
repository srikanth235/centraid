package dev.centraid.android.session

import centraid.core.v1.ShellClipboardCopy
import centraid.core.v1.ShellDone
import centraid.core.v1.ShellEffect
import centraid.core.v1.ShellEffectResult
import centraid.core.v1.ShellGrant
import centraid.core.v1.ShellModelDownload
import centraid.core.v1.ShellOpenSettings
import centraid.core.v1.ShellOwnerCheck
import centraid.core.v1.ShellPermissionStatus
import centraid.core.v1.ShellPicked
import centraid.core.v1.ShellPickedItem
import centraid.core.v1.ShellPhoneWatch
import centraid.core.v1.ShellPhotoDelete
import centraid.core.v1.ShellPickFile
import centraid.core.v1.ShellPickPhoto
import centraid.core.v1.ShellReleaseGrant
import centraid.core.v1.ShellSaveFile
import centraid.core.v1.ShellScanDocument
import centraid.core.v1.ShellShare
import centraid.core.v1.ShellStoreRead
import centraid.core.v1.FollowGrant
import centraid.core.v1.FollowRequest
import centraid.core.v1.FollowVerb
import centraid.core.v1.Envelope
import centraid.core.v1.Response
import centraid.core.v1.RoomResponse
import centraid.core.v1.RoomEvent
import centraid.core.v1.RoomTap
import centraid.core.v1.ShellOwner
import centraid.core.v1.ShellFailed
import dev.centraid.core.ShellEffectAnswers
import dev.centraid.core.CoreOutcome
import dev.centraid.android.room.RoomClient
import dev.centraid.android.kit.EffectReason
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.ExperimentalCoroutinesApi
import org.junit.Assert.assertEquals
import org.junit.Test

class RoomShellEffectPerformerTest {
    @Test
    @OptIn(ExperimentalCoroutinesApi::class)
    fun roomClientRoutesEveryEffectToOneTypedCoreAnswer() = runTest {
        val effects = effectFixture()
        val requests = mutableListOf<Envelope>()
        var deliveredEffects = false
        val client = RoomClient({ request ->
            requests += request
            val roomSend = request.request?.room?.send
            val responseEffects = if (roomSend != null && !deliveredEffects) {
                deliveredEffects = true
                effects + effects[1]
            } else emptyList()
            CoreOutcome.Answered(Envelope(response = Response(room = RoomResponse(effects = responseEffects))))
        }, this)
        val nativeCalls = mutableMapOf<Long, Int>()
        client.shellEffectPerformer = { effect ->
            nativeCalls[effect.effect_id] = nativeCalls.getOrDefault(effect.effect_id, 0) + 1
            (when {
                effect.owner_check != null -> ShellEffectResult(owner = ShellOwner(passed = true))
                effect.share != null -> error("simulated share failure")
                effect.pick_file != null || effect.pick_photo != null || effect.scan_document != null ->
                    ShellEffectResult(picked = ShellPicked(items = listOf(ShellPickedItem(path = "/cache/item", name = "item.pdf", size = 4))))
                effect.photo_delete != null -> ShellEffectResult(done = ShellDone())
                effect.permission_status != null -> ShellEffectResult(grant = ShellGrant(grant = FollowGrant.FOLLOW_GRANT_GRANTED))
                effect.model_download != null -> ShellEffectResult(failed = ShellFailed(reason = EffectReason.FAILED))
                else -> ShellEffectResult(done = ShellDone())
            }).copy(effect_id = effect.effect_id)
        }
        client.followReadPerformer = { effect ->
            FollowRequest(
                verb = FollowVerb.FOLLOW_VERB_PASS,
                system = effect.store_read!!.system,
                ask_id = effect.effect_id,
                grant = FollowGrant.FOLLOW_GRANT_GRANTED,
                input_json = "{\"origin\":{\"ref\":\"phone\",\"label\":\"Phone\"},\"records\":[{\"external_id\":\"contact:1\",\"fields\":{\"title\":\"Ada\"}}],\"complete\":true}",
            )
        }

        client.send(41, RoomEvent(tap = RoomTap(selector_id = "start")))
        advanceUntilIdle()

        val results = requests.mapNotNull { request ->
            request.request?.room?.send?.event?.effect_result
        }
        val follow = requests.mapNotNull { it.request?.follow }
        val roomEffects = effects.filter { it.store_read == null }
        assertEquals(roomEffects.map { it.effect_id }.distinct().sorted(), results.map { it.effect_id }.sorted())
        assertEquals(roomEffects.map { it.effect_id }.distinct().size, results.distinctBy { it.effect_id }.size)
        assertEquals(1, nativeCalls[2L])
        assertEquals(listOf(5L), results.filter { it.owner != null }.map { it.effect_id })
        assertEquals(3, results.count { it.picked?.items?.isNotEmpty() == true })
        assertEquals(6, results.count { it.done != null })
        assertEquals(1, results.count { it.grant?.grant == FollowGrant.FOLLOW_GRANT_GRANTED })
        assertEquals(listOf(6L, 13L), results.filter { it.failed?.reason == EffectReason.FAILED }.map { it.effect_id }.sorted())
        assertEquals(listOf(1L), follow.map { it.ask_id })
        assertEquals(1, follow.size)
    }

    @Test
    fun eachShellEffectGetsOneTypedResultWithItsEffectId() = runTest {
        val effects = listOf(
            ShellEffect(effect_id = 1, store_read = ShellStoreRead(system = "contacts")),
            ShellEffect(effect_id = 2, phone_watch = ShellPhoneWatch(system = "contacts", on = true)),
            ShellEffect(effect_id = 3, open_settings = ShellOpenSettings(system = "photos")),
            ShellEffect(effect_id = 4, release_grant = ShellReleaseGrant(ref = "content://folder")),
            ShellEffect(effect_id = 5, owner_check = ShellOwnerCheck(reason = "Unlock")),
            ShellEffect(effect_id = 6, share = ShellShare(subject = "Notes")),
            ShellEffect(effect_id = 7, save_file = ShellSaveFile(path = "/tmp/export", name = "notes.txt")),
            ShellEffect(effect_id = 8, pick_file = ShellPickFile()),
            ShellEffect(effect_id = 9, pick_photo = ShellPickPhoto()),
            ShellEffect(effect_id = 10, scan_document = ShellScanDocument()),
            ShellEffect(effect_id = 11, clipboard_copy = ShellClipboardCopy(text = "text", lease_s = 10)),
            ShellEffect(effect_id = 12, photo_delete = ShellPhotoDelete(ids = listOf("photo"))),
            ShellEffect(effect_id = 13, model_download = ShellModelDownload(name = "model")),
            ShellEffect(effect_id = 14, permission_status = ShellPermissionStatus(kind = "photos")),
        )
        val fakeCore = FakeRoomCore()
        val performer = RoomShellEffectPerformer { effect ->
            when {
                effect.owner_check != null -> ShellEffectResult(effect_id = effect.effect_id, owner = centraid.core.v1.ShellOwner(passed = true))
                effect.pick_file != null || effect.pick_photo != null || effect.scan_document != null ->
                    ShellEffectResult(
                        effect_id = effect.effect_id,
                        picked = ShellPicked(items = listOf(ShellPickedItem(path = "/cache/picked", name = "picked.txt", size = 4))),
                    )
                effect.permission_status != null -> ShellEffectResult(
                    effect_id = effect.effect_id,
                    grant = ShellGrant(grant = FollowGrant.FOLLOW_GRANT_GRANTED),
                )
                effect.store_read != null -> error("store_read must answer through FollowRequest")
                else -> ShellEffectResult(effect_id = effect.effect_id, done = ShellDone())
            }
        }

        val roomEffects = effects.filter { it.store_read == null }
        roomEffects.forEach { effect -> performer.answer(41, effect, fakeCore::sendRoomResult) }
        val storeRead = effects.single { it.store_read != null }
        fakeCore.sendFollowAnswer(
            ShellEffectAnswers.coreAnswer(
                storeRead,
                FollowRequest(
                    verb = FollowVerb.FOLLOW_VERB_PASS,
                    system = storeRead.store_read!!.system,
                    ask_id = storeRead.effect_id,
                    grant = FollowGrant.FOLLOW_GRANT_GRANTED,
                    input_json = "{\"origin\":{\"ref\":\"phone\",\"label\":\"Phone\"},\"records\":[{\"external_id\":\"contact:1\",\"fields\":{\"title\":\"Ada\"}}],\"complete\":true}",
                ),
            ),
        )

        assertEquals(roomEffects.map { it.effect_id }, fakeCore.roomResults.map { it.effect_result!!.effect_id })
        assertEquals(1, fakeCore.followAnswers.size)
        assertEquals(storeRead.effect_id, fakeCore.followAnswers.single().ask_id)
        assertEquals(effects.size, (fakeCore.roomResults.size + fakeCore.followAnswers.size))
        assertEquals(effects.size, (fakeCore.roomResults.map { it.effect_result!!.effect_id } + fakeCore.followAnswers.map { it.ask_id }).distinct().size)
        assertEquals(1, fakeCore.roomResults.count { it.effect_result?.owner?.passed == true })
        assertEquals(3, fakeCore.roomResults.count { it.effect_result?.picked != null })
        assertEquals(1, fakeCore.roomResults.count { it.effect_result?.grant?.grant == FollowGrant.FOLLOW_GRANT_GRANTED })
    }
}

private fun effectFixture() = listOf(
    ShellEffect(effect_id = 1, store_read = ShellStoreRead(system = "contacts")),
    ShellEffect(effect_id = 2, phone_watch = ShellPhoneWatch(system = "contacts", on = true)),
    ShellEffect(effect_id = 3, open_settings = ShellOpenSettings(system = "photos")),
    ShellEffect(effect_id = 4, release_grant = ShellReleaseGrant(ref = "content://folder")),
    ShellEffect(effect_id = 5, owner_check = ShellOwnerCheck(reason = "Unlock")),
    ShellEffect(effect_id = 6, share = ShellShare(subject = "Notes")),
    ShellEffect(effect_id = 7, save_file = ShellSaveFile(path = "/tmp/export", name = "notes.txt")),
    ShellEffect(effect_id = 8, pick_file = ShellPickFile()),
    ShellEffect(effect_id = 9, pick_photo = ShellPickPhoto()),
    ShellEffect(effect_id = 10, scan_document = ShellScanDocument()),
    ShellEffect(effect_id = 11, clipboard_copy = ShellClipboardCopy(text = "text", lease_s = 10)),
    ShellEffect(effect_id = 12, photo_delete = ShellPhotoDelete(ids = listOf("photo"))),
    ShellEffect(effect_id = 13, model_download = ShellModelDownload(name = "model")),
    ShellEffect(effect_id = 14, permission_status = ShellPermissionStatus(kind = "photos")),
)

private class FakeRoomCore {
    val roomResults = mutableListOf<centraid.core.v1.RoomEvent>()
    val followAnswers = mutableListOf<FollowRequest>()

    suspend fun sendRoomResult(instance: Long, event: centraid.core.v1.RoomEvent) {
        assertEquals(41L, instance)
        roomResults += event
    }

    fun sendFollowAnswer(answer: FollowRequest) {
        followAnswers += answer
    }
}
