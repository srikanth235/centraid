package dev.centraid.android.session

import centraid.core.v1.ShellEffect
import centraid.core.v1.ShellEffectResult
import centraid.core.v1.RoomEvent
import dev.centraid.core.ShellEffectAnswers

internal class RoomShellEffectPerformer(
    private val run: suspend (ShellEffect) -> ShellEffectResult,
) {
    suspend fun perform(effect: ShellEffect): ShellEffectResult = when {
        effect.store_read != null -> run(effect)
        effect.phone_watch != null -> run(effect)
        effect.open_settings != null -> run(effect)
        effect.release_grant != null -> run(effect)
        effect.owner_check != null -> run(effect)
        effect.share != null -> run(effect)
        effect.save_file != null -> run(effect)
        effect.pick_file != null -> run(effect)
        effect.pick_photo != null -> run(effect)
        effect.scan_document != null -> run(effect)
        effect.clipboard_copy != null -> run(effect)
        effect.photo_delete != null -> run(effect)
        effect.model_download != null -> run(effect)
        effect.permission_status != null -> run(effect)
        else -> error("ShellEffect has no selected variant")
    }

    suspend fun answer(
        instance: Long,
        effect: ShellEffect,
        send: suspend (Long, RoomEvent) -> Unit,
    ) {
        val result = perform(effect)
        send(instance, ShellEffectAnswers.roomResult(effect, result))
    }
}
