package dev.centraid.shared

import centraid.screen.v1.WordsShowEvent
import centraid.screen.v1.WordsShowState
import dev.centraid.design.copy.WordsCopy
import dev.centraid.shared.custody.ShowEffect
import dev.centraid.shared.custody.ShowInput
import dev.centraid.shared.custody.Shown
import dev.centraid.shared.custody.VaultSecrets
import dev.centraid.shared.custody.WordsShowFlow
import dev.centraid.shared.custody.WordsShowMachine
import dev.centraid.shared.platform.FakePlatformServices
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest

/**
 * `words.show`: SETTINGS SHOWS THE 24 WORDS AGAIN (#1047 E4, Q-1047-19).
 *
 * The words are read only after the phone's owner check passed, are on a
 * secure screen only while shown, and are dropped on leaving. A phone whose
 * seed came by sync has none and says where they are.
 */
class WordsShowSpec : StringSpec({

    val words = List(24) { "abandon" }.dropLast(1) + "art"

    fun reduce(model: Shown, input: ShowInput) = WordsShowMachine.reduce(model, input)

    fun event(event: WordsShowEvent) = ShowInput.View(event)

    val opened = event(WordsShowEvent(opened = WordsShowEvent.Opened()))
    val verified = event(WordsShowEvent(verified = WordsShowEvent.Verified()))
    val primary = event(WordsShowEvent(primary = WordsShowEvent.Primary()))

    fun asking(): Shown = reduce(WordsShowMachine.initial(), opened).model

    "opening asks first, reads nothing, and shows nothing secret" {
        val step = reduce(WordsShowMachine.initial(), opened)
        step.effects.shouldBeEmpty()
        step.model.state.phase shouldBe WordsShowState.Phase.PHASE_ASK
        step.model.state.secure shouldBe false
        step.model.state.verify_reason shouldBe WordsCopy.SHOW_AGAIN_REASON
        // ASK's primary is the view's owner check, never a read.
        reduce(step.model, primary).effects.shouldBeEmpty()
        reduce(step.model, primary).model.state.phase shouldBe WordsShowState.Phase.PHASE_ASK
    }

    "a failed owner check keeps the words hidden and says so" {
        val failed = reduce(asking(), event(WordsShowEvent(verify_failed = WordsShowEvent.VerifyFailed()))).model
        failed.state.phase shouldBe WordsShowState.Phase.PHASE_ASK
        failed.state.notice shouldBe WordsCopy.SHOW_AGAIN_VERIFY_FAILED
        failed.holdsWords shouldBe false
    }

    "verified reads the store; the words are shown on a secure screen, and Done drops them" {
        val loading = reduce(asking(), verified)
        loading.effects shouldBe listOf(ShowEffect.Load)
        val shown = reduce(loading.model, ShowInput.Loaded(words, seedHeld = true)).model
        shown.state.phase shouldBe WordsShowState.Phase.PHASE_SHOW
        shown.state.secure shouldBe true
        shown.state.words shouldHaveSize 24
        shown.state.words.last().word shouldBe "art"
        shown.toString() shouldNotContain "abandon"

        val done = reduce(shown, primary).model
        done.state.phase shouldBe WordsShowState.Phase.PHASE_CLOSED
        done.holdsWords shouldBe false
        reduce(shown, event(WordsShowEvent(dismissed = WordsShowEvent.Dismissed()))).model.holdsWords shouldBe false
    }

    "no words here: a synced seed says where they are; no seed at all says to make or restore" {
        val loading = reduce(asking(), verified).model
        val synced = reduce(loading, ShowInput.Loaded(null, seedHeld = true)).model.state
        synced.phase shouldBe WordsShowState.Phase.PHASE_NONE_HERE
        synced.body shouldBe WordsCopy.SHOW_AGAIN_NONE_SYNCED
        synced.words.shouldBeEmpty()
        reduce(loading, ShowInput.Loaded(null, seedHeld = false)).model.state.body shouldBe WordsCopy.SHOW_AGAIN_NONE
    }

    "running over the store: the words the phone kept are what is shown" {
        runTest {
            val services = FakePlatformServices()
            val secrets = VaultSecrets(services.secureStore, services.syncedSecrets)
            secrets.rememberWords(words)
            val flow = WordsShowFlow({ secrets }, CoroutineScope(Dispatchers.Unconfined))
            flow.reduce(opened)
            flow.reduce(verified)
            flow.state.value.phase shouldBe WordsShowState.Phase.PHASE_SHOW
            flow.state.value.words.map { it.word } shouldBe words
        }
    }
})
