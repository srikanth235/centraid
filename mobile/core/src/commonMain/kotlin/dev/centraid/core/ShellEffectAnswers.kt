package dev.centraid.core

import centraid.core.v1.FollowRequest
import centraid.core.v1.RoomEvent
import centraid.core.v1.ShellEffect
import centraid.core.v1.ShellEffectResult

object ShellEffectAnswers {
    fun roomResult(effect: ShellEffect, result: ShellEffectResult): RoomEvent {
        require(result.effect_id == effect.effect_id)
        require(
            listOf(result.done, result.failed, result.picked, result.grant, result.owner).count { it != null } == 1,
        )
        return RoomEvent(effect_result = result)
    }

    fun coreAnswer(effect: ShellEffect, answer: FollowRequest): FollowRequest {
        val read = requireNotNull(effect.store_read)
        require(answer.ask_id == effect.effect_id)
        require(answer.system == read.system)
        return answer
    }
}
