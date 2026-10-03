package dev.centraid.shared

import centraid.screen.v1.VaultWordsEvent
import centraid.screen.v1.VaultWordsState
import centraid.screen.v1.WordsEntryState
import centraid.screen.v1.WordAsk
import dev.centraid.design.copy.WordsCopy
import dev.centraid.shared.custody.Enrollment
import dev.centraid.shared.custody.PhraseDoor
import dev.centraid.shared.custody.PhraseVerdict
import dev.centraid.shared.custody.RestoreAnswer
import dev.centraid.shared.custody.RestoreDoor
import dev.centraid.shared.custody.RestoreRefusal
import dev.centraid.shared.custody.RestoreResult
import dev.centraid.shared.custody.VaultSecrets
import dev.centraid.shared.custody.VaultWordsFlow
import dev.centraid.shared.custody.VaultWordsMachine
import dev.centraid.shared.custody.Words
import dev.centraid.shared.custody.WordsEffect
import dev.centraid.shared.custody.WordsInput
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.shell.FoundResult
import dev.centraid.shared.shell.Shelf
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest

/**
 * `words.make`: MAKE A VAULT, AND ITS WORDS (#1047 E1, R-1047-E1/E2).
 *
 * The pure machine first — every phase, what is drawn, what is secure, and
 * when the words are dropped — then the flow over a real [Enrollment] with a
 * fake core behind it, for the order of the effects.
 */
class VaultWordsSpec : StringSpec({

    val minted = listOf(
        "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract",
        "absurd", "abuse", "access", "accident", "account", "accuse", "achieve", "acid",
        "acoustic", "acquire", "across", "act", "action", "actor", "actress", "actual",
    )

    fun reduce(model: Words, input: WordsInput) = VaultWordsMachine.reduce(model, input)

    fun view(event: VaultWordsEvent) = WordsInput.View(event)

    val opened = view(VaultWordsEvent(opened = VaultWordsEvent.Opened()))
    val primary = view(VaultWordsEvent(primary = VaultWordsEvent.Primary()))
    val secondary = view(VaultWordsEvent(secondary = VaultWordsEvent.Secondary()))

    fun typed(position: Int, text: String) =
        view(VaultWordsEvent(typed = VaultWordsEvent.WordTyped(position = position, text = text)))

    /** Opened, no seed, minted, asking 2, 9 and 20. */
    fun shown(): Words {
        val open = reduce(VaultWordsMachine.initial(), opened)
        open.effects shouldBe listOf(WordsEffect.Assess)
        val assessed = reduce(open.model, WordsInput.Standing(Enrollment.Standing.NO_SEED, "Only on this iPhone."))
        assessed.effects shouldBe listOf(WordsEffect.Mint)
        return reduce(assessed.model, WordsInput.Minted(minted, listOf(2, 9, 20))).model
    }

    "the words are shown once, on a SECURE screen, with the custody sentence" {
        val show = shown().state
        show.phase shouldBe VaultWordsState.Phase.PHASE_SHOW
        show.secure shouldBe true
        show.words.map { it.word } shouldBe minted
        show.words.first().accessibility_label shouldBe "Word 1, abandon"
        show.custody shouldBe "Only on this iPhone."
        show.primary_label shouldBe WordsCopy.SHOW_PRIMARY
        show.secondary_label shouldBe WordsCopy.CANCEL
    }

    "the check asks three positions and draws no word of the phrase" {
        val confirm = reduce(shown(), primary).model
        confirm.state.phase shouldBe VaultWordsState.Phase.PHASE_CONFIRM
        confirm.state.secure shouldBe true
        confirm.state.words.shouldBeEmpty()
        confirm.state.asks.map { it.position } shouldBe listOf(2, 9, 20)
        confirm.state.asks.map { it.prompt } shouldBe listOf("Word 2", "Word 9", "Word 20")
        confirm.state.body shouldBe "Type words 2, 9, 20 from what you wrote down."
        // NOTHING TYPED, NOTHING TO CHECK.
        confirm.state.primary_enabled shouldBe false
    }

    "a wrong word is marked, keeps nothing, and the words can be shown again" {
        var model = reduce(shown(), primary).model
        model = reduce(model, typed(2, "ability")).model
        model = reduce(model, typed(9, "abuse")).model
        model = reduce(model, typed(20, "act")).model
        val step = reduce(model, primary)
        step.effects.shouldBeEmpty()
        step.model.state.phase shouldBe VaultWordsState.Phase.PHASE_CONFIRM
        step.model.state.notice shouldBe WordsCopy.CHECK_WRONG
        step.model.state.asks.map { it.mark } shouldBe
            listOf(WordAsk.Mark.MARK_RIGHT, WordAsk.Mark.MARK_WRONG, WordAsk.Mark.MARK_RIGHT)

        val again = reduce(step.model, secondary).model
        again.state.phase shouldBe VaultWordsState.Phase.PHASE_SHOW
        again.state.words shouldHaveSize 24
    }

    "three right words KEEP the phrase, which is then dropped before the vault is made" {
        var model = reduce(shown(), primary).model
        model = reduce(model, typed(2, " Ability ")).model
        model = reduce(model, typed(9, "absurd")).model
        model = reduce(model, typed(20, "act")).model
        model.state.primary_enabled shouldBe true
        val keep = reduce(model, primary)
        keep.model.state.phase shouldBe VaultWordsState.Phase.PHASE_MAKING
        keep.model.state.secure shouldBe false
        keep.effects.single().shouldBeKeep()

        val kept = reduce(keep.model, WordsInput.Kept(null))
        kept.effects shouldBe listOf(WordsEffect.Make)
        kept.model.holdsWords shouldBe false

        val made = reduce(kept.model, WordsInput.Made(FoundResult.Made("My vault"))).model
        made.state.phase shouldBe VaultWordsState.Phase.PHASE_MADE
        made.state.body shouldBe "My vault is on this phone, and your 24 words bring it back."
        reduce(made, primary).model.state.phase shouldBe VaultWordsState.Phase.PHASE_CLOSED
    }

    "cancelling or dismissing drops the words and keeps nothing" {
        val cancelled = reduce(shown(), secondary)
        cancelled.effects.shouldBeEmpty()
        cancelled.model.state.phase shouldBe VaultWordsState.Phase.PHASE_CLOSED
        cancelled.model.holdsWords shouldBe false

        val dismissed = reduce(reduce(shown(), primary).model, view(VaultWordsEvent(dismissed = VaultWordsEvent.Dismissed())))
        dismissed.model.holdsWords shouldBe false
        // A LATE ANSWER TO A CLOSED FLOW changes nothing.
        reduce(dismissed.model, WordsInput.Kept(null)).effects.shouldBeEmpty()
    }

    "a phone whose seed is settled makes the vault with no words; an unsettled one is sent to restore" {
        val open = reduce(VaultWordsMachine.initial(), opened).model
        val settled = reduce(open, WordsInput.Standing(Enrollment.Standing.SETTLED, ""))
        settled.effects shouldBe listOf(WordsEffect.Make)
        settled.model.state.words.shouldBeEmpty()

        val unsettled = reduce(open, WordsInput.Standing(Enrollment.Standing.UNSETTLED, "")).model.state
        unsettled.phase shouldBe VaultWordsState.Phase.PHASE_RESTORE_FIRST
        unsettled.restore_label shouldBe WordsCopy.RESTORE_FIRST_ACTION
        unsettled.primary_label shouldBe ""
        // THE SEED IS HERE, so the restore it opens needs no words (Q-1047-18).
        unsettled.restore_purpose shouldBe WordsEntryState.Purpose.PURPOSE_RESTORE_HELD
    }

    "a refused mint and a refused keep each say so and offer the right retry" {
        val open = reduce(VaultWordsMachine.initial(), opened).model
        val noMint = reduce(reduce(open, WordsInput.Standing(Enrollment.Standing.NO_SEED, "")).model, WordsInput.Minted(null, emptyList()))
        noMint.model.state.phase shouldBe VaultWordsState.Phase.PHASE_FAILED
        noMint.model.state.notice shouldBe WordsCopy.MINT_FAILED
        reduce(noMint.model, primary).effects shouldBe listOf(WordsEffect.Assess)

        var model = reduce(shown(), primary).model
        listOf(2 to "ability", 9 to "absurd", 20 to "act").forEach { (at, word) -> model = reduce(model, typed(at, word)).model }
        val refused = reduce(reduce(model, primary).model, WordsInput.Kept(Enrollment.Refusal.STORE_REFUSED)).model
        refused.state.notice shouldBe WordsCopy.KEEP_FAILED
        // THE WORDS ARE STILL HELD, so "Try again" keeps the same ones.
        refused.holdsWords shouldBe true
        reduce(refused, primary).effects.single().shouldBeKeep()
    }

    "no model, input or effect prints a word" {
        shown().toString() shouldNotContain "abandon"
        WordsInput.Minted(minted, listOf(1)).toString() shouldNotContain "abandon"
        WordsEffect.Keep(minted).toString() shouldNotContain "abandon"
    }

    // --- the flow over an enrollment -----------------------------------------

    "running: mint, show, check, then the seed is stored and settled BEFORE the vault is founded" {
        runTest {
            val services = FakePlatformServices()
            val secrets = VaultSecrets(services.secureStore, services.syncedSecrets)
            val order = mutableListOf<String>()
            val enrollment = Enrollment(
                secrets = secrets,
                phrase = object : PhraseDoor {
                    override suspend fun mint(): List<String> = minted.also { order += "mint" }
                    override suspend fun check(words: List<String>): PhraseVerdict? = null
                    override suspend fun seed(words: List<String>): String =
                        "ab".repeat(64).also { order += "seed" }
                },
                restoreDoor = object : RestoreDoor {
                    override suspend fun restore(words: List<String>, payload: String?): RestoreResult =
                        RestoreResult.Refused(RestoreRefusal.UNREACHABLE)
                    override suspend fun restoreSeed(seedHex: String, payload: String?): RestoreResult =
                        RestoreResult.Refused(RestoreRefusal.UNREACHABLE)
                    override suspend fun restoreStayed(seedHex: String, payload: String?, indices: List<Int>): RestoreResult =
                        RestoreResult.Refused(RestoreRefusal.UNREACHABLE)
                },
                keeper = object : Enrollment.Keeper {
                    override suspend fun found(): FoundResult {
                        order += "found stored=${secrets.seed() != null}"
                        return FoundResult.Made("My vault")
                    }
                    override suspend fun adoptRestored(restored: List<Shelf.Restored>) = 0
                    override suspend fun rekey() = 0
                    override suspend fun indexedHoldings() = 0
                },
            )
            val flow = VaultWordsFlow({ enrollment }, services, CoroutineScope(Dispatchers.Unconfined))
            flow.reduce(opened)
            flow.state.value.phase shouldBe VaultWordsState.Phase.PHASE_SHOW
            val asked = flow.current.asking
            asked shouldHaveSize 3
            flow.reduce(primary)
            asked.forEach { flow.reduce(typed(it, minted[it - 1])) }
            flow.reduce(primary)
            withClue(flow.state.value.notice) { flow.state.value.phase shouldBe VaultWordsState.Phase.PHASE_MADE }
            order shouldBe listOf("mint", "seed", "found stored=true")
            secrets.seedSettled() shouldBe true
            flow.current.holdsWords shouldBe false
        }
    }
})

private fun WordsEffect.shouldBeKeep() {
    (this is WordsEffect.Keep) shouldBe true
}
