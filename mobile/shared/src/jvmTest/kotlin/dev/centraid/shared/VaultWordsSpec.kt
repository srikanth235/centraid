package dev.centraid.shared

import io.kotest.matchers.types.shouldBeInstanceOf
import centraid.screen.v1.VaultWordsEvent
import centraid.screen.v1.VaultWordsState
import centraid.screen.v1.WordsEntryState
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
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
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

    /** Opened, no seed, minted at once. */
    fun shown(): Words {
        val open = reduce(VaultWordsMachine.initial(), opened)
        open.effects shouldBe listOf(WordsEffect.Assess)
        val assessed = reduce(open.model, WordsInput.Standing(Enrollment.Standing.NO_SEED, "Only on this iPhone."))
        assessed.effects shouldBe listOf(WordsEffect.Mint)
        return reduce(assessed.model, WordsInput.Minted(minted)).model
    }

    "a phone with no seed mints at once: no framing screen, and the words show with the custody sentence and Save a copy" {
        val open = reduce(VaultWordsMachine.initial(), opened)
        val assessed = reduce(open.model, WordsInput.Standing(Enrollment.Standing.NO_SEED, "Only on this iPhone."))
        assessed.effects shouldBe listOf(WordsEffect.Mint)
        assessed.model.state.phase shouldBe VaultWordsState.Phase.PHASE_CHECKING
        assessed.model.state.save_label shouldBe ""
        val show = reduce(assessed.model, WordsInput.Minted(minted)).model.state
        show.phase shouldBe VaultWordsState.Phase.PHASE_SHOW
        show.custody shouldBe "Only on this iPhone."
        show.save_label shouldBe WordsCopy.SAVE_LABEL
        show.primary_label shouldBe WordsCopy.SHOW_PRIMARY
    }

    "cancelling or swiping away the shown words closes the flow and drops them, keeping nothing" {
        val cancelled = reduce(shown(), secondary)
        cancelled.effects.shouldBeEmpty()
        cancelled.model.state.phase shouldBe VaultWordsState.Phase.PHASE_CLOSED
        cancelled.model.holdsWords shouldBe false

        val dismissed = reduce(shown(), view(VaultWordsEvent(dismissed = VaultWordsEvent.Dismissed())))
        dismissed.effects.shouldBeEmpty()
        dismissed.model.state.phase shouldBe VaultWordsState.Phase.PHASE_CLOSED
        // A MINT THAT ANSWERS AFTER THE MEMBER LEFT changes nothing.
        reduce(dismissed.model, WordsInput.Minted(minted)).model.holdsWords shouldBe false
    }

    "the words are for NEW seeds only: a settled or unsettled seed never sees them" {
        val open = reduce(VaultWordsMachine.initial(), opened).model
        reduce(open, WordsInput.Standing(Enrollment.Standing.SETTLED, "")).model.state.words.shouldBeEmpty()
        reduce(open, WordsInput.Standing(Enrollment.Standing.SETTLED, "")).model.state.phase shouldBe
            VaultWordsState.Phase.PHASE_CHOOSE
        reduce(open, WordsInput.Standing(Enrollment.Standing.UNSETTLED, "")).model.state.phase shouldBe
            VaultWordsState.Phase.PHASE_RESTORE_FIRST
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

    "I HAVE SAVED THEM keeps the phrase at once, which is then dropped before the vault is made" {
        val keep = reduce(shown(), primary)
        keep.model.state.phase shouldBe VaultWordsState.Phase.PHASE_MAKING
        keep.model.state.secure shouldBe false
        keep.model.state.words.shouldBeEmpty()
        keep.effects.single().shouldBeKeep()

        val kept = reduce(keep.model, WordsInput.Kept(null))
        kept.effects shouldBe listOf(WordsEffect.Make())
        kept.model.holdsWords shouldBe false

        val made = reduce(kept.model, WordsInput.Made(FoundResult.Made("My vault"))).model
        // NO "READY" SCREEN: the sheet closes, the sentence rides along for Home.
        made.state.phase shouldBe VaultWordsState.Phase.PHASE_CLOSED
        made.state.body shouldBe "My vault is on this phone, and your recovery key brings it back."
    }

    "a keychain that will hold the key keeps it WITHOUT showing the words (R-ONBOARD-10)" {
        val open = reduce(VaultWordsMachine.initial(), opened).model
        val assessed = reduce(open, WordsInput.Standing(Enrollment.Standing.NO_SEED, "Saved in iCloud Keychain.", synchronizing = true))
        assessed.effects shouldBe listOf(WordsEffect.Mint)
        val quiet = reduce(assessed.model, WordsInput.Minted(minted))
        quiet.model.state.phase shouldBe VaultWordsState.Phase.PHASE_MAKING
        quiet.model.state.words.shouldBeEmpty()
        quiet.model.state.secure shouldBe false
        val keep = quiet.effects.single() as WordsEffect.Keep
        keep.sync shouldBe true
        // NOT SHOWN, SO NOT SAVED: the Backup tab still offers the key.
        keep.shown shouldBe false
        val kept = reduce(quiet.model, WordsInput.Kept(null))
        kept.effects shouldBe listOf(WordsEffect.Make())
        kept.model.holdsWords shouldBe false
    }

    "a phone whose key would stay on it alone shows the words, with no checkbox, and the keep counts as saved" {
        val show = shown()
        show.state.phase shouldBe VaultWordsState.Phase.PHASE_SHOW
        show.state.custody shouldBe "Only on this iPhone."
        val keep = reduce(show, primary).effects.single() as WordsEffect.Keep
        keep.sync shouldBe true
        keep.shown shouldBe true
    }

    "cancelling or dismissing drops the words and keeps nothing" {
        val cancelled = reduce(shown(), secondary)
        cancelled.effects.shouldBeEmpty()
        cancelled.model.state.phase shouldBe VaultWordsState.Phase.PHASE_CLOSED
        cancelled.model.holdsWords shouldBe false

        val dismissed = reduce(shown(), view(VaultWordsEvent(dismissed = VaultWordsEvent.Dismissed())))
        dismissed.model.holdsWords shouldBe false
        // A LATE ANSWER TO A CLOSED FLOW changes nothing.
        reduce(dismissed.model, WordsInput.Kept(null)).effects.shouldBeEmpty()
    }

    "a phone whose seed is settled makes the vault with no words; an unsettled one is sent to restore" {
        val open = reduce(VaultWordsMachine.initial(), opened).model
        val settled = reduce(open, WordsInput.Standing(Enrollment.Standing.SETTLED, ""))
        // A NAME AND THE OWN-WORDS CHOICE FIRST (R-1047-E18); unticked, no words.
        settled.effects.shouldBeEmpty()
        settled.model.state.phase shouldBe VaultWordsState.Phase.PHASE_CHOOSE
        settled.model.state.own_on shouldBe false
        val made = reduce(settled.model, primary)
        made.effects shouldBe listOf(WordsEffect.Make())
        made.model.state.words.shouldBeEmpty()

        val unsettled = reduce(open, WordsInput.Standing(Enrollment.Standing.UNSETTLED, "")).model.state
        unsettled.phase shouldBe VaultWordsState.Phase.PHASE_RESTORE_FIRST
        unsettled.restore_label shouldBe WordsCopy.RESTORE_FIRST_ACTION
        unsettled.primary_label shouldBe ""
        // THE SEED IS HERE, so the restore it opens needs no words (Q-1047-18).
        unsettled.restore_purpose shouldBe WordsEntryState.Purpose.PURPOSE_RESTORE_HELD
    }

    "a refused mint and a refused keep each say so and offer the right retry" {
        val minting = reduce(
            reduce(VaultWordsMachine.initial(), opened).model,
            WordsInput.Standing(Enrollment.Standing.NO_SEED, "Only on this iPhone."),
        ).model
        val noMint = reduce(minting, WordsInput.Minted(null))
        noMint.model.state.phase shouldBe VaultWordsState.Phase.PHASE_FAILED
        noMint.model.state.notice shouldBe WordsCopy.MINT_FAILED
        reduce(noMint.model, primary).effects shouldBe listOf(WordsEffect.Assess)

        val refused = reduce(reduce(shown(), primary).model, WordsInput.Kept(Enrollment.Refusal.STORE_REFUSED)).model
        refused.state.notice shouldBe WordsCopy.KEEP_FAILED
        // THE WORDS ARE STILL HELD, so "Try again" keeps the same ones.
        refused.holdsWords shouldBe true
        reduce(refused, primary).effects.single().shouldBeKeep()
    }

    "no model, input or effect prints a word" {
        shown().toString() shouldNotContain "abandon"
        WordsInput.Minted(minted).toString() shouldNotContain "abandon"
        WordsEffect.Keep(minted).toString() shouldNotContain "abandon"
    }

    // --- the flow over an enrollment -----------------------------------------

    "running: mint, show, keep, then the seed is stored and settled BEFORE the vault is founded" {
        runTest {
            val services = FakePlatformServices()
            // NO KEYCHAIN: the words are shown, and "I've saved it" is recorded.
            (services.syncedSecrets as dev.centraid.shared.platform.FakeSyncedSecrets).availability =
                dev.centraid.shared.platform.SyncedSecrets.Availability(
                    synchronizing = false,
                    sentence = "Only on this iPhone.",
                    restoresAfterSetup = true,
                )
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
                    override suspend fun found(own: String?, name: String?): FoundResult {
                        order += "found stored=${secrets.seed() != null}"
                        return FoundResult.Made("My vault")
                    }
                    override suspend fun adoptRestored(restored: List<Shelf.Restored>) = 0
                    override suspend fun rekey() = 0
                    override suspend fun indexedHoldings() = 0
                },
            )
            val flow = VaultWordsFlow({ enrollment }, services, CoroutineScope(Dispatchers.Unconfined))
            // THE MADE SIGNAL, once per make: what the shells' status line and
            // the camera-roll ask take (R-ONBOARD-8).
            val made = mutableListOf<String>()
            val watching = CoroutineScope(Dispatchers.Unconfined).launch { flow.made.collect { made += it } }
            flow.reduce(opened)
            // THE WORDS COME STRAIGHT AWAY: there is no framing step to continue past.
            flow.state.value.phase shouldBe VaultWordsState.Phase.PHASE_SHOW
            flow.reduce(primary)
            withClue(flow.state.value.notice) { flow.state.value.phase shouldBe VaultWordsState.Phase.PHASE_CLOSED }
            made.size shouldBe 1
            watching.cancel()
            order shouldBe listOf("mint", "seed", "found stored=true")
            secrets.seedSettled() shouldBe true
            secrets.wordsSaved() shouldBe true
            secrets.seedSynced() shouldBe false
            flow.current.holdsWords shouldBe false
        }
    }

    "running with a keychain: mint, keep, found — no words shown, the key synchronised, nothing claimed saved" {
        runTest {
            val services = FakePlatformServices()
            val secrets = VaultSecrets(services.secureStore, services.syncedSecrets)
            val enrollment = Enrollment(
                secrets = secrets,
                phrase = object : PhraseDoor {
                    override suspend fun mint(): List<String> = minted
                    override suspend fun check(words: List<String>): PhraseVerdict? = null
                    override suspend fun seed(words: List<String>): String = "ab".repeat(64)
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
                    override suspend fun found(own: String?, name: String?): FoundResult = FoundResult.Made("My vault")
                    override suspend fun adoptRestored(restored: List<Shelf.Restored>) = 0
                    override suspend fun rekey() = 0
                    override suspend fun indexedHoldings() = 0
                },
            )
            val flow = VaultWordsFlow({ enrollment }, services, CoroutineScope(Dispatchers.Unconfined))
            val phases = mutableListOf<VaultWordsState.Phase>()
            val watching = CoroutineScope(Dispatchers.Unconfined).launch { flow.state.collect { phases += it.phase } }
            flow.reduce(opened)
            flow.state.value.phase shouldBe VaultWordsState.Phase.PHASE_CLOSED
            (VaultWordsState.Phase.PHASE_SHOW in phases) shouldBe false
            watching.cancel()
            secrets.seedSynced() shouldBe true
            secrets.wordsSaved() shouldBe false
            // THE WORDS ARE STILL KEPT ON THIS PHONE, so the Backup tab can show them.
            secrets.words() shouldBe minted
        }
    }
    "a vault on its own words: named, minted, shown as its own, kept under its entry and made on it" {
        val open = reduce(VaultWordsMachine.initial(), opened).model
        val choose = reduce(open, WordsInput.Standing(Enrollment.Standing.SETTLED, "Saved in iCloud.", synchronizing = true)).model
        choose.state.own_label shouldBe WordsCopy.OWN_LABEL
        choose.state.name_label shouldBe WordsCopy.NAME_LABEL
        val ticked = reduce(choose, view(VaultWordsEvent(own = VaultWordsEvent.OwnToggled(on = true)))).model
        ticked.state.own_on shouldBe true
        ticked.state.body shouldBe WordsCopy.CHOOSE_OWN_BODY
        // NO NAME, NO VAULT: the name is how a restore lists it.
        ticked.state.primary_enabled shouldBe false
        reduce(ticked, primary).effects.shouldBeEmpty()

        val named = reduce(ticked, view(VaultWordsEvent(name = VaultWordsEvent.NameTyped(text = "Family")))).model
        named.state.primary_enabled shouldBe true
        val minting = reduce(named, primary)
        minting.effects shouldBe listOf(WordsEffect.Mint)
        val show = reduce(minting.model, WordsInput.Minted(minted)).model
        // A VAULT ON ITS OWN KEY IS ALWAYS SHOWN, keychain or not.
        show.state.phase shouldBe VaultWordsState.Phase.PHASE_SHOW
        show.state.title shouldBe WordsCopy.SHOW_OWN_TITLE.replace("{name}", "Family")
        show.state.custody shouldBe ""

        val keep = reduce(show, primary)
        keep.effects.single().shouldBeInstanceOf<WordsEffect.KeepOwn>().name shouldBe "Family"
        val kept = reduce(keep.model, WordsInput.Kept(null, own = "0123456789abcdef"))
        kept.effects shouldBe listOf(WordsEffect.Make(own = "0123456789abcdef", name = "Family"))
        kept.model.holdsWords shouldBe false
        val made = reduce(kept.model, WordsInput.Made(FoundResult.Made("Family"))).model.state
        made.body shouldBe WordsCopy.MADE_OWN_BODY.replace("{name}", "Family")
    }

    "an entry kept for a vault that was never made is dropped when the member walks away" {
        val open = reduce(VaultWordsMachine.initial(), opened).model
        val choose = reduce(open, WordsInput.Standing(Enrollment.Standing.SETTLED, "")).model
        val named = reduce(
            reduce(choose, view(VaultWordsEvent(own = VaultWordsEvent.OwnToggled(on = true)))).model,
            view(VaultWordsEvent(name = VaultWordsEvent.NameTyped(text = "Work"))),
        ).model
        val show = reduce(reduce(named, primary).model, WordsInput.Minted(minted)).model
        val kept = reduce(reduce(show, primary).model, WordsInput.Kept(null, own = "0123456789abcdef")).model
        val failed = reduce(kept, WordsInput.Made(FoundResult.Refused("No."))).model
        failed.state.phase shouldBe VaultWordsState.Phase.PHASE_FAILED
        // TRY AGAIN founds on the same entry; Cancel drops it.
        reduce(failed, primary).effects shouldBe listOf(WordsEffect.Make(own = "0123456789abcdef", name = "Work"))
        reduce(failed, secondary).effects shouldBe listOf(WordsEffect.DropOwn("0123456789abcdef"))
        // A plain vault keeps no entry, so leaving drops nothing.
        reduce(choose, secondary).effects.shouldBeEmpty()
    }
})

private fun WordsEffect.shouldBeKeep() {
    (this is WordsEffect.Keep) shouldBe true
}
