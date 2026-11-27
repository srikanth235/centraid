package dev.centraid.core

import centraid.core.v1.FollowGrant
import centraid.core.v1.FollowVerb
import centraid.core.v1.ShellEffect
import centraid.core.v1.ShellOpenSettings
import centraid.core.v1.ShellStoreRead
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

class ShellEffectAnswersSpec : StringSpec({
    "a room's effect is answered with its id and an unavailable grant" {
        val answer = ShellEffectAnswers.roomResult(
            ShellEffect(effect_id = 7, open_settings = ShellOpenSettings(system = "photos")),
        )
        val result = answer.effect_result!!
        result.effect_id shouldBe 7L
        result.failed!!.grant shouldBe FollowGrant.FOLLOW_GRANT_UNAVAILABLE
        result.failed!!.reason shouldBe ShellEffectAnswers.UNAVAILABLE_REASON
        result.done shouldBe null
    }

    "a store read the core asked is passed back unavailable, naming its ask" {
        val request = ShellEffectAnswers.coreAnswer(
            ShellEffect(effect_id = 9, store_read = ShellStoreRead(system = "calendar")),
        )!!
        request.verb shouldBe FollowVerb.FOLLOW_VERB_PASS
        request.system shouldBe "calendar"
        request.ask_id shouldBe 9L
        request.grant shouldBe FollowGrant.FOLLOW_GRANT_UNAVAILABLE
    }

    "an effect the core asked that is not a store read has no answer" {
        ShellEffectAnswers.coreAnswer(ShellEffect(effect_id = 3, open_settings = ShellOpenSettings())) shouldBe null
    }
})
