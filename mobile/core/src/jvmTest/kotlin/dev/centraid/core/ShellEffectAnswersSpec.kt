package dev.centraid.core

import centraid.core.v1.FollowRequest
import centraid.core.v1.FollowVerb
import centraid.core.v1.ShellDone
import centraid.core.v1.ShellEffect
import centraid.core.v1.ShellEffectResult
import centraid.core.v1.ShellOwnerCheck
import centraid.core.v1.ShellStoreRead
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

class ShellEffectAnswersSpec : StringSpec({
    "a room effect carries one result naming that effect" {
        val event = ShellEffectAnswers.roomResult(
            ShellEffect(effect_id = 7, open_settings = centraid.core.v1.ShellOpenSettings(system = "photos")),
            ShellEffectResult(effect_id = 7, done = ShellDone()),
        )
        event.effect_result!!.effect_id shouldBe 7L
        event.effect_result!!.done shouldBe ShellDone()
    }

    "a result for another effect is refused" {
        shouldThrow<IllegalArgumentException> {
            ShellEffectAnswers.roomResult(
                ShellEffect(effect_id = 7, owner_check = ShellOwnerCheck()),
                ShellEffectResult(effect_id = 8, done = ShellDone()),
            )
        }
    }

    "a missing outcome is refused" {
        shouldThrow<IllegalArgumentException> {
            ShellEffectAnswers.roomResult(
                ShellEffect(effect_id = 7, owner_check = ShellOwnerCheck()),
                ShellEffectResult(effect_id = 7),
            )
        }
    }

    "a followed store answer names the effect ask and system" {
        val effect = ShellEffect(effect_id = 9, store_read = ShellStoreRead(system = "calendar"))
        val answer = ShellEffectAnswers.coreAnswer(
            effect,
            FollowRequest(verb = FollowVerb.FOLLOW_VERB_PASS, system = "calendar", ask_id = 9),
        )
        answer.ask_id shouldBe 9L
        answer.system shouldBe "calendar"
    }

    "a followed store answer for another ask is refused" {
        shouldThrow<IllegalArgumentException> {
            ShellEffectAnswers.coreAnswer(
                ShellEffect(effect_id = 9, store_read = ShellStoreRead(system = "calendar")),
                FollowRequest(verb = FollowVerb.FOLLOW_VERB_PASS, system = "calendar", ask_id = 8),
            )
        }
    }
})
