package dev.centraid.shared

import centraid.screen.v1.WordEntry
import centraid.screen.v1.WordsEntryEvent
import centraid.screen.v1.WordsEntryState
import dev.centraid.design.copy.WordsCopy
import dev.centraid.shared.custody.Enrollment
import dev.centraid.shared.custody.Entry
import dev.centraid.shared.custody.EntryEffect
import dev.centraid.shared.custody.EntryInput
import dev.centraid.shared.custody.PhraseVerdict
import dev.centraid.shared.custody.RestoreAnswer
import dev.centraid.shared.custody.RestoredVaultAt
import dev.centraid.shared.custody.UnclaimedVaultAt
import dev.centraid.shared.custody.WordsEntryMachine
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain

/**
 * `words.enter`: TYPE THE 24 WORDS BACK (#1047 E1, R-1047-E3/E5).
 *
 * The grid is judged by the core as it is typed; these drive the pure machine
 * with the core's verdicts as inputs, so what is asserted is what the screen
 * says and when its one control opens.
 */
class WordsEntrySpec : StringSpec({

    fun reduce(model: Entry, input: EntryInput) = WordsEntryMachine.reduce(model, input)

    fun open(purpose: WordsEntryState.Purpose): Entry =
        reduce(WordsEntryMachine.initial(), EntryInput.View(WordsEntryEvent(opened = WordsEntryEvent.Opened(purpose = purpose)))).model

    fun typed(position: Int, text: String) =
        EntryInput.View(WordsEntryEvent(typed = WordsEntryEvent.WordTyped(position = position, text = text)))

    val primary = EntryInput.View(WordsEntryEvent(primary = WordsEntryEvent.Primary()))

    fun verdict(verdict: PhraseVerdict.Verdict, firstUnknown: Int = 0, suggestions: List<String> = emptyList()) =
        PhraseVerdict(
            cells = List(24) { at ->
                PhraseVerdict.Cell(at + 1, empty = false, known = at + 1 != firstUnknown, suggestions = if (at + 1 == firstUnknown) suggestions else emptyList())
            },
            verdict = verdict,
            firstUnknown = firstUnknown,
        )

    /** A gateway's pairing code, as pasted (#1080 A1). */
    val code = """{"v":2,"gw":"gw-1"}"""

    fun coded(model: Entry, text: String = code): Entry =
        reduce(model, EntryInput.View(WordsEntryEvent(endpoint = WordsEntryEvent.EndpointTyped(text = text)))).model

    /**
     * All 24 cells typed at once (a space moves to the next cell) and judged
     * [answer]; a restore's pairing [pasted] first, which a re-key has no field for.
     */
    fun filled(
        purpose: WordsEntryState.Purpose,
        answer: PhraseVerdict.Verdict = PhraseVerdict.Verdict.VALID,
        pasted: String = if (purpose == WordsEntryState.Purpose.PURPOSE_REKEY) "" else code,
    ): Entry {
        val opened = open(purpose).let { if (pasted.isEmpty()) it else coded(it, pasted) }
        val step = reduce(opened, typed(1, List(24) { "abandon" }.joinToString(" ")))
        val check = step.effects.single() as EntryEffect.Check
        return reduce(step.model, EntryInput.Checked(check.revision, verdict(answer))).model
    }

    "the grid opens empty and secure, with the purpose's words and the pairing code's field only for a restore" {
        val restore = open(WordsEntryState.Purpose.PURPOSE_RESTORE).state
        restore.phase shouldBe WordsEntryState.Phase.PHASE_ENTERING
        restore.secure shouldBe true
        restore.cells shouldHaveSize 24
        restore.cells.all { it.mark == WordEntry.Mark.MARK_EMPTY } shouldBe true
        restore.title shouldBe WordsCopy.RESTORE_TITLE
        restore.endpoint_label shouldBe WordsCopy.ENDPOINT_LABEL
        restore.primary_enabled shouldBe false

        val rekey = open(WordsEntryState.Purpose.PURPOSE_REKEY).state
        rekey.title shouldBe WordsCopy.REKEY_TITLE
        rekey.endpoint_label shouldBe ""
        rekey.primary_label shouldBe WordsCopy.REKEY_PRIMARY
    }

    "typing asks the core, and a space runs on into the next cells" {
        val step = reduce(open(WordsEntryState.Purpose.PURPOSE_RESTORE), typed(3, "abandon ability "))
        val check = step.effects.single() as EntryEffect.Check
        check.revision shouldBe 1L
        step.model.state.cells[2].typed shouldBe "abandon"
        step.model.state.cells[3].typed shouldBe "ability"
        step.model.state.cells[4].typed shouldBe ""
    }

    "an answer for words no longer on screen is dropped, so the button never opens on stale words" {
        val first = reduce(open(WordsEntryState.Purpose.PURPOSE_RESTORE), typed(1, "abandon"))
        val second = reduce(first.model, typed(2, "zzz"))
        val stale = reduce(second.model, EntryInput.Checked(1L, verdict(PhraseVerdict.Verdict.VALID))).model
        stale.valid shouldBe false
        stale.state.primary_enabled shouldBe false
    }

    "the verdict speaks in order: the count, an unknown word by place with suggestions, then the checksum" {
        val some = reduce(open(WordsEntryState.Purpose.PURPOSE_RESTORE), typed(1, "abandon ability"))
        val counted = reduce(
            some.model,
            EntryInput.Checked(1L, PhraseVerdict(emptyList(), PhraseVerdict.Verdict.INCOMPLETE, 0)),
        ).model.state
        counted.notice shouldBe "Centraid needs 24 words. There are 2 here."

        val unknown = filled(WordsEntryState.Purpose.PURPOSE_RESTORE, PhraseVerdict.Verdict.UNKNOWN_WORD)
        unknown.state.primary_enabled shouldBe false
        val badChecksum = filled(WordsEntryState.Purpose.PURPOSE_RESTORE, PhraseVerdict.Verdict.BAD_CHECKSUM)
        badChecksum.state.notice shouldBe WordsCopy.BAD_CHECKSUM

        val step = reduce(open(WordsEntryState.Purpose.PURPOSE_RESTORE), typed(1, List(24) { "abandon" }.joinToString(" ")))
        val judged = reduce(
            step.model,
            EntryInput.Checked(1L, verdict(PhraseVerdict.Verdict.UNKNOWN_WORD, firstUnknown = 5, suggestions = listOf("abandon"))),
        ).model.state
        judged.notice shouldBe "Word 5 is not on the list of words Centraid uses. Check its spelling."
        judged.cells[4].mark shouldBe WordEntry.Mark.MARK_UNKNOWN
        judged.cells[4].suggestions shouldBe listOf("abandon")
        judged.cells[0].mark shouldBe WordEntry.Mark.MARK_KNOWN
    }

    "a restore waits for its gateway's pairing code: valid words alone leave the control closed (#1080 A23)" {
        val noCode = filled(WordsEntryState.Purpose.PURPOSE_RESTORE, pasted = "")
        noCode.valid shouldBe true
        noCode.state.endpoint_label shouldBe WordsCopy.ENDPOINT_LABEL
        noCode.state.primary_enabled shouldBe false
        // A STRAY TAP ASKS NOTHING: the core would refuse a restore that names
        // no gateway, and the member would read "could not reach your laptop".
        val tapped = reduce(noCode, primary)
        tapped.effects.shouldBeEmpty()
        tapped.model.state.phase shouldBe WordsEntryState.Phase.PHASE_ENTERING
        // BLANK IS NO CODE.
        coded(noCode, "   ").state.primary_enabled shouldBe false
        val withCode = coded(noCode)
        withCode.state.primary_enabled shouldBe true
        (reduce(withCode, primary).effects.single() as EntryEffect.Restore).endpoint shouldBe code
    }

    "a valid phrase opens the one control; a restore runs, and its answer drops every word" {
        val ready = filled(WordsEntryState.Purpose.PURPOSE_RESTORE)
        ready.state.primary_enabled shouldBe true
        val working = reduce(ready, primary)
        working.model.state.phase shouldBe WordsEntryState.Phase.PHASE_WORKING
        working.model.state.progress shouldBe WordsCopy.RESTORING
        (working.effects.single() is EntryEffect.Restore) shouldBe true

        val answer = RestoreAnswer(
            vaults = listOf(RestoredVaultAt("/v/a/vault.db", 0, rows = 1_204, safetyNumber = "12345 67890")),
        )
        val done = reduce(working.model, EntryInput.Restored(Enrollment.Restored.Done(answer, 1))).model
        done.state.phase shouldBe WordsEntryState.Phase.PHASE_DONE
        done.state.secure shouldBe false
        done.state.cells.shouldBeEmpty()
        done.holdsWords shouldBe false
        done.state.restored.single().line shouldBe "Vault 1: 1,204 rows."
        // ONE ROW IS A ROW (#1047 walk's plural sweep).
        val one = RestoreAnswer(
            vaults = listOf(RestoredVaultAt("/v/a/vault.db", 0, rows = 1, safetyNumber = "")),
        )
        reduce(working.model, EntryInput.Restored(Enrollment.Restored.Done(one, 1))).model.state.restored.single().line shouldBe
            "Vault 1: 1 row."
        done.state.restored.single().safety_number shouldBe "12345 67890"
        done.state.restored.single().safety_label shouldBe WordsCopy.RESTORED_SAFETY
    }

    "a vault that stayed with the other phone is named, numbered with the ones that came back, and offers a retry" {
        // R-1047-R5: a claim failed after another landed. The claimed vaults are
        // answered; the rest are `unclaimed`, their writer epochs still the old phone's.
        val working = reduce(filled(WordsEntryState.Purpose.PURPOSE_RESTORE), primary).model
        val answer = RestoreAnswer(
            vaults = listOf(
                RestoredVaultAt("/v/a/vault.db", 0, rows = 3),
                RestoredVaultAt("/v/c/vault.db", 2, rows = 1),
            ),
            unclaimed = listOf(UnclaimedVaultAt(index = 1, vaultId = "ab".repeat(32))),
        )
        val done = reduce(working, EntryInput.Restored(Enrollment.Restored.Done(answer, 2))).model.state
        done.phase shouldBe WordsEntryState.Phase.PHASE_DONE
        // NOT "YOUR VAULTS ARE BACK" when one of them is not.
        done.title shouldBe WordsCopy.RESTORED_SOME_TITLE
        done.body shouldBe WordsCopy.RESTORED_STAYED_BODY
        // ONE SEQUENCE BY INDEX: index 1 is "Vault 2" on the stayed list, so the
        // vault at index 2 is "Vault 3", not a second "Vault 2".
        done.restored.map { it.line } shouldBe listOf("Vault 1: 3 rows.", "Vault 3: 1 row.")
        done.stayed shouldBe listOf(WordsCopy.RESTORED_STAYED.replace("{index}", "2"))
        // A RETRY for what stayed (R-1047-R6); Done still closes.
        done.primary_label shouldBe WordsCopy.DONE
        done.secondary_label shouldBe ""
        done.retry_label shouldBe WordsCopy.RESTORED_STAYED_RETRY
        // THE CORE'S REASON IS A SUPPORT LOG, never a member's sentence.
        done.stayed.single() shouldNotContain "ab".repeat(32)

        // THE ORDINARY ANSWER says nothing of a vault that stayed.
        val whole = reduce(
            working,
            EntryInput.Restored(Enrollment.Restored.Done(RestoreAnswer(listOf(RestoredVaultAt("/v/a/vault.db", 0))), 1)),
        ).model.state
        whole.title shouldBe WordsCopy.RESTORED_TITLE
        whole.body shouldBe ""
        whole.stayed.shouldBeEmpty()
        whole.retry_label shouldBe ""
    }

    "a retry asks for the vaults that stayed alone, keeps what came back, and a refusal leaves both lists standing" {
        // R-1047-R6: vaults 0 and 2 came back, vault 1 stayed. The retry names
        // index 1 and the pairing code the member typed; the words are gone.
        val typedCode = reduce(
            filled(WordsEntryState.Purpose.PURPOSE_RESTORE),
            EntryInput.View(WordsEntryEvent(endpoint = WordsEntryEvent.EndpointTyped(text = "ab"))),
        ).model
        val working = reduce(typedCode, primary).model
        val first = RestoreAnswer(
            vaults = listOf(RestoredVaultAt("/v/a/vault.db", 0, rows = 3), RestoredVaultAt("/v/c/vault.db", 2, rows = 1)),
            unclaimed = listOf(UnclaimedVaultAt(index = 1, vaultId = "ab".repeat(32))),
        )
        val done = reduce(working, EntryInput.Restored(Enrollment.Restored.Done(first, 2))).model
        done.holdsWords shouldBe false

        val retry = EntryInput.View(WordsEntryEvent(retry = WordsEntryEvent.Retry()))
        val retrying = reduce(done, retry)
        retrying.effects shouldBe listOf(EntryEffect.RestoreStayed(listOf(1), "ab"))
        retrying.model.state.phase shouldBe WordsEntryState.Phase.PHASE_WORKING
        retrying.model.state.progress shouldBe WordsCopy.RESTORING
        // NO GRID COMES BACK: the words are gone and nothing secret is drawn.
        retrying.model.state.cells.shouldBeEmpty()
        retrying.model.state.secure shouldBe false
        retrying.model.state.retry_label shouldBe ""
        retrying.model.state.stayed shouldHaveSize 1
        // A SECOND TAP WHILE ONE RUNS asks nothing.
        reduce(retrying.model, retry).effects.shouldBeEmpty()

        // STILL REFUSED: back to DONE, both lists standing, the retry offered.
        val still = reduce(retrying.model, EntryInput.Restored(Enrollment.Restored.NotTaken)).model.state
        still.phase shouldBe WordsEntryState.Phase.PHASE_DONE
        still.notice shouldBe WordsCopy.RESTORE_STAYED_STILL
        still.restored.map { it.line } shouldBe listOf("Vault 1: 3 rows.", "Vault 3: 1 row.")
        still.stayed shouldBe listOf(WordsCopy.RESTORED_STAYED.replace("{index}", "2"))
        still.retry_label shouldBe WordsCopy.RESTORED_STAYED_RETRY
        reduce(retrying.model, EntryInput.Restored(Enrollment.Restored.Unreachable)).model.state.notice shouldBe
            WordsCopy.RESTORE_UNREACHABLE

        // IT CAME BACK: one list, numbered as before, and the whole title.
        val back = RestoreAnswer(vaults = listOf(RestoredVaultAt("/v/b/vault.db", 1, rows = 5)))
        val whole = reduce(retrying.model, EntryInput.Restored(Enrollment.Restored.Done(back, 1))).model.state
        whole.phase shouldBe WordsEntryState.Phase.PHASE_DONE
        whole.title shouldBe WordsCopy.RESTORED_TITLE
        whole.notice shouldBe ""
        whole.restored.map { it.line } shouldBe listOf("Vault 1: 3 rows.", "Vault 2: 5 rows.", "Vault 3: 1 row.")
        whole.stayed.shouldBeEmpty()
        whole.retry_label shouldBe ""
        whole.primary_label shouldBe WordsCopy.DONE
    }

    "an unreachable laptop and an empty one keep the words on screen, with the sentence and a way on" {
        val working = reduce(filled(WordsEntryState.Purpose.PURPOSE_RESTORE), primary).model
        val unreachable = reduce(working, EntryInput.Restored(Enrollment.Restored.Unreachable)).model
        unreachable.state.phase shouldBe WordsEntryState.Phase.PHASE_ENTERING
        unreachable.state.notice shouldBe WordsCopy.RESTORE_UNREACHABLE
        unreachable.holdsWords shouldBe true
        reduce(working, EntryInput.Restored(Enrollment.Restored.NothingHeld)).model.state.notice shouldBe
            WordsCopy.RESTORE_NOTHING_HELD
        reduce(working, EntryInput.Restored(Enrollment.Restored.NotTaken)).model.state.notice shouldBe
            WordsCopy.RESTORE_NOT_TAKEN
        // A BACKUP THIS PHONE WOULD NOT ACCEPT says so, and says the other phone
        // still backs up — never "could not reach your laptop" (#1047 R3).
        val refused = reduce(working, EntryInput.Restored(Enrollment.Restored.DidNotCheck)).model
        refused.state.notice shouldBe WordsCopy.RESTORE_DID_NOT_CHECK
        refused.state.phase shouldBe WordsEntryState.Phase.PHASE_ENTERING
        refused.holdsWords shouldBe true
        reduce(working, EntryInput.Restored(Enrollment.Restored.Refused(Enrollment.Refusal.DIFFERENT_WORDS)))
            .model.state.notice shouldBe WordsCopy.DIFFERENT_WORDS
    }

    "re-keying: done says the words are back; nothing to key offers the restore with the words kept" {
        val working = reduce(filled(WordsEntryState.Purpose.PURPOSE_REKEY), primary)
        (working.effects.single() is EntryEffect.Rekey) shouldBe true
        working.model.state.progress shouldBe WordsCopy.REKEYING

        val done = reduce(working.model, EntryInput.Rekeyed(Enrollment.Rekeyed.Done(1))).model.state
        done.title shouldBe WordsCopy.REKEYED_TITLE
        done.cells.shouldBeEmpty()

        val none = reduce(working.model, EntryInput.Rekeyed(Enrollment.Rekeyed.NoneToKey)).model
        none.state.notice shouldBe WordsCopy.REKEY_NONE
        none.state.primary_label shouldBe WordsCopy.REKEY_NONE_ACTION
        // THE OFFERED RESTORE DRAWS THE CODE'S FIELD AND WAITS FOR IT (#1080
        // A23): the re-key had no field, and the restore it offers needs one.
        none.state.endpoint_label shouldBe WordsCopy.ENDPOINT_LABEL
        none.state.primary_enabled shouldBe false
        reduce(none, primary).effects.shouldBeEmpty()
        val ready = coded(none)
        ready.state.primary_enabled shouldBe true
        ready.holdsWords shouldBe true
        val restoring = reduce(ready, primary)
        restoring.model.purpose shouldBe WordsEntryState.Purpose.PURPOSE_RESTORE
        (restoring.effects.single() as EntryEffect.Restore).endpoint shouldBe code
    }

    "a re-key explains itself in its door's words: pairing's, Locker's, and a restore's own (#1047 F5)" {
        fun rekeyFrom(origin: WordsEntryState.Origin): Entry = reduce(
            WordsEntryMachine.initial(),
            EntryInput.View(WordsEntryEvent(opened = WordsEntryEvent.Opened(purpose = WordsEntryState.Purpose.PURPOSE_REKEY, origin = origin))),
        ).model
        val pairing = rekeyFrom(WordsEntryState.Origin.ORIGIN_PAIRING)
        pairing.state.origin shouldBe WordsEntryState.Origin.ORIGIN_PAIRING
        pairing.state.body shouldBe WordsCopy.REKEY_PAIR_BODY
        rekeyFrom(WordsEntryState.Origin.ORIGIN_LOCKER).state.body shouldBe WordsCopy.REKEY_BODY
        // Locker's wall was the first door: an unnamed one reads as it.
        open(WordsEntryState.Purpose.PURPOSE_REKEY).state.body shouldBe WordsCopy.REKEY_BODY
        // A restore has one door, whoever opened it.
        reduce(
            WordsEntryMachine.initial(),
            EntryInput.View(WordsEntryEvent(opened = WordsEntryEvent.Opened(purpose = WordsEntryState.Purpose.PURPOSE_RESTORE, origin = WordsEntryState.Origin.ORIGIN_PAIRING))),
        ).model.state.body shouldBe WordsCopy.RESTORE_BODY
        // THE DOOR IS KEPT THROUGH DONE: pairing's done points back at the laptop.
        val step = reduce(pairing, typed(1, List(24) { "abandon" }.joinToString(" ")))
        val check = step.effects.single() as EntryEffect.Check
        val valid = reduce(step.model, EntryInput.Checked(check.revision, verdict(PhraseVerdict.Verdict.VALID))).model
        val working = reduce(valid, primary).model
        val done = reduce(working, EntryInput.Rekeyed(Enrollment.Rekeyed.Done(1))).model.state
        done.body shouldBe WordsCopy.REKEYED_PAIR_BODY
        done.origin shouldBe WordsEntryState.Origin.ORIGIN_PAIRING
        val lockerDone = reduce(
            reduce(filled(WordsEntryState.Purpose.PURPOSE_REKEY), primary).model,
            EntryInput.Rekeyed(Enrollment.Rekeyed.Done(1)),
        ).model.state
        lockerDone.body shouldBe WordsCopy.REKEYED_BODY
    }

    "a held-seed restore has no grid and nothing secret: only the code's field, and the control waits for it" {
        val held = open(WordsEntryState.Purpose.PURPOSE_RESTORE_HELD)
        held.state.cells.shouldBeEmpty()
        held.state.secure shouldBe false
        held.state.title shouldBe WordsCopy.RESTORE_HELD_TITLE
        held.state.endpoint_label shouldBe WordsCopy.ENDPOINT_LABEL
        // NO CODE, NO RESTORE (#1080 A23).
        held.state.primary_enabled shouldBe false
        reduce(held, primary).effects.shouldBeEmpty()
        // A typed word has nowhere to land.
        reduce(held, typed(1, "abandon")).effects.shouldBeEmpty()

        val withCode = reduce(held, EntryInput.View(WordsEntryEvent(endpoint = WordsEntryEvent.EndpointTyped(text = " ab "))))
        withCode.model.state.primary_enabled shouldBe true
        val working = reduce(withCode.model, primary)
        working.model.state.phase shouldBe WordsEntryState.Phase.PHASE_WORKING
        working.effects shouldBe listOf(EntryEffect.RestoreHeld(" ab "))

        val done = reduce(
            working.model,
            EntryInput.Restored(Enrollment.Restored.Done(RestoreAnswer(listOf(RestoredVaultAt("/v/a/vault.db", 0, rows = 3))), 1)),
        ).model.state
        done.phase shouldBe WordsEntryState.Phase.PHASE_DONE
        done.restored shouldHaveSize 1

        val nothing = reduce(working.model, EntryInput.Restored(Enrollment.Restored.NothingHeld)).model.state
        nothing.phase shouldBe WordsEntryState.Phase.PHASE_ENTERING
        nothing.notice shouldBe WordsCopy.RESTORE_NOTHING_HELD
    }

    "leaving drops every word" {
        val closed = reduce(filled(WordsEntryState.Purpose.PURPOSE_RESTORE), EntryInput.View(WordsEntryEvent(secondary = WordsEntryEvent.Secondary()))).model
        closed.state.phase shouldBe WordsEntryState.Phase.PHASE_CLOSED
        closed.holdsWords shouldBe false
    }

    "no model or effect prints a word" {
        val ready = filled(WordsEntryState.Purpose.PURPOSE_RESTORE)
        ready.toString() shouldNotContain "abandon"
        reduce(ready, primary).effects.single().toString() shouldNotContain "abandon"
    }
})
