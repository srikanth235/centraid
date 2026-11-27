package dev.centraid.core

import centraid.core.v1.FollowGrant
import centraid.core.v1.FollowRequest
import centraid.core.v1.FollowVerb
import centraid.core.v1.RoomEvent
import centraid.core.v1.ShellEffect
import centraid.core.v1.ShellEffectResult
import centraid.core.v1.ShellFailed

object ShellEffectAnswers {
    fun roomResult(effect: ShellEffect, unavailableReason: String): RoomEvent = RoomEvent(
        effect_result = ShellEffectResult(
            effect_id = effect.effect_id,
            failed = ShellFailed(grant = FollowGrant.FOLLOW_GRANT_UNAVAILABLE, reason = unavailableReason),
        ),
    )

    fun coreAnswer(effect: ShellEffect): FollowRequest? {
        val read = effect.store_read ?: return null
        return FollowRequest(
            verb = FollowVerb.FOLLOW_VERB_PASS,
            system = read.system,
            ask_id = effect.effect_id,
            grant = FollowGrant.FOLLOW_GRANT_UNAVAILABLE,
        )
    }
}
