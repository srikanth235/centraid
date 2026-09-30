package dev.centraid.shared.custody

import centraid.screen.v1.RestoredVaultLine
import centraid.screen.v1.WordEntry
import centraid.screen.v1.WordsEntryEvent
import centraid.screen.v1.WordsEntryState
import dev.centraid.design.copy.WordsCopy
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * TYPE THE 24 WORDS BACK (#1047 E1, R-1047-E3/E5) — as a pure machine.
 *
 * `words.enter`, for two purposes over one grid:
 *
 * * **PURPOSE_RESTORE** — a fresh install, or a phone told to restore first:
 *   the words bring every vault back from the laptop ([Enrollment.restore]).
 * * **PURPOSE_REKEY** — Locker's "needs your 24 words" wall, or pairing's
 *   NEEDS_WORDS: the words go back to this phone's own vaults, which reopen
 *   keyed ([Enrollment.rekey]). The `origin` names which door, and the body
 *   explains the words in that door's terms (#1047 F5). When no vault here
 *   has an index to key, the screen offers the restore instead, keeping what
 *   was typed.
 * * **PURPOSE_RESTORE_HELD** — the phone already holds a seed the
 *   synchronised keychain carried here (words.make's RESTORE_FIRST): no grid,
 *   only the optional laptop address, and the restore runs from that seed
 *   ([Enrollment.restoreHeld], Q-1047-18).
 *
 * Every cell is judged by the CORE as it is typed (`PhraseRequest.check`): a
 * list word or not, suggestions for a prefix, and the phrase's verdict — count,
 * then an unknown word, then the checksum. The primary control opens only on a
 * VALID verdict for exactly what is on screen. The words are dropped the moment
 * a restore or a re-key succeeds, and on leaving.
 *
 * A restore's DONE that names vaults which stayed with the old phone offers
 * `retry_label`: it asks the laptop again for those indices alone, from the
 * seed the restore stored ([Enrollment.restoreStayed], R-1047-R6), over the
 * lists already drawn — never the grid again.
 */
public object WordsEntryMachine {
    public const val CELLS: Int = 24

    public fun initial(): Entry = render(Entry())

    public fun reduce(model: Entry, input: EntryInput): EntryStep {
        if (model.phase == WordsEntryState.Phase.PHASE_CLOSED &&
            !(input is EntryInput.View && input.event.opened != null)
        ) {
            return EntryStep(model)
        }
        return when (input) {
            is EntryInput.View -> view(model, input.event)
            is EntryInput.Checked -> checked(model, input)
            is EntryInput.Restored -> restored(model, input.outcome)
            is EntryInput.Rekeyed -> rekeyed(model, input.outcome)
        }
    }

    private fun view(model: Entry, event: WordsEntryEvent): EntryStep {
        val entering = model.phase == WordsEntryState.Phase.PHASE_ENTERING
        // A HELD-SEED RESTORE HAS NO GRID: a typed word has nowhere to land.
        val typing = entering && model.purpose != WordsEntryState.Purpose.PURPOSE_RESTORE_HELD
        return when {
            event.opened != null -> EntryStep(
                render(
                    Entry(
                        phase = WordsEntryState.Phase.PHASE_ENTERING,
                        purpose = event.opened.purpose.takeIf { it != WordsEntryState.Purpose.PURPOSE_UNSPECIFIED }
                            ?: WordsEntryState.Purpose.PURPOSE_RESTORE,
                        origin = event.opened.origin,
                    ),
                ),
            )
            event.typed != null && typing -> edited(model, spread(model.cells, event.typed.position, event.typed.text))
            event.picked != null && typing -> {
                val at = event.picked.position
                if (at !in 1..CELLS) return EntryStep(model)
                edited(model, model.cells.toMutableList().also { it[at - 1] = event.picked.word })
            }
            event.endpoint != null && entering -> EntryStep(render(model.copy(endpoint = event.endpoint.text)))
            event.primary != null -> primary(model)
            event.secondary != null -> EntryStep(closed())
            event.retry != null -> retry(model)
            else -> EntryStep(model)
        }
    }

    /**
     * A CELL TYPED, AND THE WORDS THAT RAN ON. Typing "abandon ability" into
     * cell 3 fills 3 and 4: the space is how a member moves to the next word,
     * and a grid that swallowed it would make them tap 24 boxes. Nothing here
     * reads the clipboard; this is what the keyboard sent.
     */
    private fun spread(cells: List<String>, position: Int, text: String): List<String> {
        if (position !in 1..CELLS) return cells
        val next = cells.toMutableList()
        val parts = text.split(' ', '\n', '\t')
        if (parts.size <= 1) {
            next[position - 1] = text
            return next
        }
        var at = position - 1
        parts.forEachIndexed { index, part ->
            if (at >= CELLS) return next
            if (part.isEmpty() && index > 0) return@forEachIndexed
            next[at] = part
            at += 1
        }
        return next
    }

    private fun edited(model: Entry, cells: List<String>): EntryStep {
        val revision = model.revision + 1
        return EntryStep(
            render(model.copy(cells = cells, revision = revision, notice = "", offerRestore = false)),
            listOf(EntryEffect.Check(revision, cells)),
        )
    }

    private fun checked(model: Entry, input: EntryInput.Checked): EntryStep {
        // AN ANSWER FOR WORDS NO LONGER ON SCREEN is dropped: the button opens
        // only on a verdict for exactly what is there.
        if (input.revision != model.revision) return EntryStep(model)
        return EntryStep(render(model.copy(verdict = input.verdict, verdictRevision = input.revision)))
    }

    private fun primary(model: Entry): EntryStep = when (model.phase) {
        WordsEntryState.Phase.PHASE_ENTERING -> when {
            model.offerRestore -> EntryStep(
                render(
                    model.copy(
                        purpose = WordsEntryState.Purpose.PURPOSE_RESTORE,
                        phase = WordsEntryState.Phase.PHASE_WORKING,
                        offerRestore = false,
                        notice = "",
                    ),
                ),
                listOf(EntryEffect.Restore(model.cells, model.endpoint)),
            )
            model.purpose == WordsEntryState.Purpose.PURPOSE_RESTORE_HELD -> EntryStep(
                render(model.copy(phase = WordsEntryState.Phase.PHASE_WORKING, notice = "")),
                listOf(EntryEffect.RestoreHeld(model.endpoint)),
            )
            !model.valid -> EntryStep(model)
            model.purpose == WordsEntryState.Purpose.PURPOSE_REKEY -> EntryStep(
                render(model.copy(phase = WordsEntryState.Phase.PHASE_WORKING, notice = "")),
                listOf(EntryEffect.Rekey(model.cells)),
            )
            else -> EntryStep(
                render(model.copy(phase = WordsEntryState.Phase.PHASE_WORKING, notice = "")),
                listOf(EntryEffect.Restore(model.cells, model.endpoint)),
            )
        }
        WordsEntryState.Phase.PHASE_DONE -> EntryStep(closed())
        else -> EntryStep(model)
    }

    private fun restored(model: Entry, outcome: Enrollment.Restored): EntryStep {
        if (model.phase != WordsEntryState.Phase.PHASE_WORKING) return EntryStep(model)
        if (model.retrying) return retried(model, outcome)
        return when (outcome) {
            // THE WORDS GO; the laptop address stays, for a retry of what stayed.
            is Enrollment.Restored.Done -> EntryStep(
                settled(
                    Entry(
                        phase = WordsEntryState.Phase.PHASE_DONE,
                        purpose = WordsEntryState.Purpose.PURPOSE_RESTORE,
                        endpoint = model.endpoint,
                    ),
                    outcome.answer.vaults,
                    outcome.answer.unclaimed.map { it.index },
                ),
            )
            Enrollment.Restored.Unreachable -> back(model, WordsCopy.RESTORE_UNREACHABLE)
            Enrollment.Restored.NothingHeld -> back(model, WordsCopy.RESTORE_NOTHING_HELD)
            Enrollment.Restored.NotTaken -> back(model, WordsCopy.RESTORE_NOT_TAKEN)
            Enrollment.Restored.DidNotCheck -> back(model, WordsCopy.RESTORE_DID_NOT_CHECK)
            is Enrollment.Restored.Refused -> back(model, refusal(outcome.because))
        }
    }

    /**
     * ASK AGAIN FOR WHAT STAYED (R-1047-R6): DONE with any vault that stayed,
     * and no retry already running. The indices are the ones the core named;
     * the vaults already here are not asked for.
     */
    private fun retry(model: Entry): EntryStep {
        if (model.phase != WordsEntryState.Phase.PHASE_DONE || model.stayedAt.isEmpty()) return EntryStep(model)
        return EntryStep(
            render(model.copy(phase = WordsEntryState.Phase.PHASE_WORKING, retrying = true, notice = "")),
            listOf(EntryEffect.RestoreStayed(model.stayedAt, model.endpoint)),
        )
    }

    /**
     * A RETRY'S ANSWER. What came back joins the vaults already here; what did
     * not still stayed. A refusal changes neither list and says why, and the
     * retry is offered again.
     */
    private fun retried(model: Entry, outcome: Enrollment.Restored): EntryStep {
        val done = model.copy(phase = WordsEntryState.Phase.PHASE_DONE, retrying = false)
        return EntryStep(
            when (outcome) {
                is Enrollment.Restored.Done -> {
                    val back = outcome.answer.vaults.map { it.index }.toSet()
                    settled(
                        done.copy(notice = ""),
                        (model.restoredAt.filter { it.index !in back } + outcome.answer.vaults).sortedBy { it.index },
                        model.stayedAt.filter { it !in back },
                    )
                }
                Enrollment.Restored.Unreachable -> render(done.copy(notice = WordsCopy.RESTORE_UNREACHABLE))
                else -> render(done.copy(notice = WordsCopy.RESTORE_STAYED_STILL))
            },
        )
    }

    /**
     * DONE after a restore: the vaults here and the ones that stayed.
     *
     * "VAULT N" IS ONE SEQUENCE over both, ordered by derivation index
     * (R-1047-R5), so a vault that stayed is never given the number of one
     * that came back. Never the index itself: a member made "Vault 1", not
     * "index 0".
     */
    private fun settled(model: Entry, restoredAt: List<RestoredVaultAt>, stayedAt: List<Int>): Entry {
        val sequence = (restoredAt.map { it.index } + stayedAt).sorted()
        fun ordinal(index: Int): Int = sequence.indexOf(index) + 1
        return render(
            model.copy(
                restoredAt = restoredAt,
                stayedAt = stayedAt,
                restored = restoredAt.map { vault -> line(ordinal(vault.index), vault) },
                stayed = stayedAt.map { index -> WordsCopy.RESTORED_STAYED.replace("{index}", "${ordinal(index)}") },
            ),
        )
    }

    private fun rekeyed(model: Entry, outcome: Enrollment.Rekeyed): EntryStep {
        if (model.phase != WordsEntryState.Phase.PHASE_WORKING) return EntryStep(model)
        return when (outcome) {
            is Enrollment.Rekeyed.Done -> EntryStep(
                render(Entry(phase = WordsEntryState.Phase.PHASE_DONE, purpose = WordsEntryState.Purpose.PURPOSE_REKEY, origin = model.origin)),
            )
            // THE WORDS ARE KEPT ON SCREEN and the restore is offered: the
            // member typed 24 good words, and making them type them again to
            // reach the laptop would be a wall of our own making.
            Enrollment.Rekeyed.NoneToKey -> EntryStep(
                render(model.copy(phase = WordsEntryState.Phase.PHASE_ENTERING, notice = WordsCopy.REKEY_NONE, offerRestore = true)),
            )
            is Enrollment.Rekeyed.Refused -> back(model, refusal(outcome.because))
        }
    }

    private fun refusal(because: Enrollment.Refusal): String = when (because) {
        Enrollment.Refusal.NOT_A_PHRASE -> WordsCopy.NOT_A_PHRASE
        Enrollment.Refusal.DIFFERENT_WORDS -> WordsCopy.DIFFERENT_WORDS
        Enrollment.Refusal.STORE_REFUSED -> WordsCopy.KEEP_FAILED
    }

    private fun back(model: Entry, notice: String): EntryStep =
        EntryStep(render(model.copy(phase = WordsEntryState.Phase.PHASE_ENTERING, notice = notice)))

    private fun line(number: Int, vault: RestoredVaultAt): RestoredVaultLine = RestoredVaultLine(
        line = when {
            vault.rows == 1L -> WordsCopy.RESTORED_LINE_ONE.replace("{index}", "$number")
            vault.rows > 0 ->
                WordsCopy.RESTORED_LINE_MANY.replace("{index}", "$number").replace("{rows}", CustodyCopy.grouped(vault.rows))
            else -> WordsCopy.RESTORED_LINE_NONE.replace("{index}", "$number")
        },
        safety_number = vault.safetyNumber,
        safety_label = if (vault.safetyNumber.isEmpty()) "" else WordsCopy.RESTORED_SAFETY,
    )

    private fun closed(): Entry = render(Entry(phase = WordsEntryState.Phase.PHASE_CLOSED))

    /** The verdict sentence, when the words on screen have one worth saying. */
    private fun verdictNotice(model: Entry): String {
        val verdict = model.currentVerdict ?: return ""
        val filled = model.cells.count { it.isNotBlank() }
        return when (verdict.verdict) {
            PhraseVerdict.Verdict.VALID -> ""
            PhraseVerdict.Verdict.INCOMPLETE -> when (filled) {
                0 -> ""
                1 -> WordsCopy.COUNT_ONE
                else -> WordsCopy.COUNT_MANY.replace("{n}", "$filled")
            }
            PhraseVerdict.Verdict.UNKNOWN_WORD -> WordsCopy.UNKNOWN_WORD.replace("{n}", "${verdict.firstUnknown}")
            PhraseVerdict.Verdict.BAD_CHECKSUM -> WordsCopy.BAD_CHECKSUM
            PhraseVerdict.Verdict.TOO_MANY -> WordsCopy.COUNT_TOO_MANY
        }
    }

    internal fun render(model: Entry): Entry {
        val phase = model.phase
        val rekey = model.purpose == WordsEntryState.Purpose.PURPOSE_REKEY
        // WHICH DOOR opened the re-key; an unnamed one is Locker's, the first.
        val fromPairing = rekey && model.origin == WordsEntryState.Origin.ORIGIN_PAIRING
        val held = model.purpose == WordsEntryState.Purpose.PURPOSE_RESTORE_HELD
        val done = phase == WordsEntryState.Phase.PHASE_DONE
        // A RETRY OF WHAT STAYED draws DONE's lists under its progress: the
        // words are gone, so no grid and no address box come back.
        val answered = done || model.retrying
        val verdict = model.currentVerdict
        val grid = !held && !model.retrying &&
            (phase == WordsEntryState.Phase.PHASE_ENTERING || phase == WordsEntryState.Phase.PHASE_WORKING)
        val cells = if (grid) {
            model.cells.mapIndexed { at, typed ->
                val judged = verdict?.cells?.getOrNull(at)
                val prompt = WordsCopy.WORD_PROMPT.replace("{n}", "${at + 1}")
                WordEntry(
                    position = at + 1,
                    prompt = prompt,
                    typed = typed,
                    mark = when {
                        typed.isBlank() -> WordEntry.Mark.MARK_EMPTY
                        judged?.known == true -> WordEntry.Mark.MARK_KNOWN
                        else -> WordEntry.Mark.MARK_UNKNOWN
                    },
                    suggestions = if (typed.isBlank()) emptyList() else judged?.suggestions.orEmpty(),
                    accessibility_label = prompt,
                )
            }
        } else {
            emptyList()
        }
        val title = when {
            phase == WordsEntryState.Phase.PHASE_CLOSED -> ""
            done && rekey -> WordsCopy.REKEYED_TITLE
            // NOT "YOUR VAULTS ARE BACK" when one of them is not (R-1047-R5).
            answered && model.stayed.isNotEmpty() -> WordsCopy.RESTORED_SOME_TITLE
            done -> WordsCopy.RESTORED_TITLE
            rekey -> WordsCopy.REKEY_TITLE
            held -> WordsCopy.RESTORE_HELD_TITLE
            else -> WordsCopy.RESTORE_TITLE
        }
        val body = when {
            phase == WordsEntryState.Phase.PHASE_CLOSED -> ""
            done && fromPairing -> WordsCopy.REKEYED_PAIR_BODY
            done && rekey -> WordsCopy.REKEYED_BODY
            // WHAT BECOMES OF WHAT STAYED, and that it can be asked for again.
            answered && model.stayed.isNotEmpty() -> WordsCopy.RESTORED_STAYED_BODY
            done -> ""
            fromPairing -> WordsCopy.REKEY_PAIR_BODY
            rekey -> WordsCopy.REKEY_BODY
            held -> WordsCopy.RESTORE_HELD_BODY
            else -> WordsCopy.RESTORE_BODY
        }
        val primary = when (phase) {
            WordsEntryState.Phase.PHASE_ENTERING -> when {
                model.offerRestore -> WordsCopy.REKEY_NONE_ACTION
                rekey -> WordsCopy.REKEY_PRIMARY
                else -> WordsCopy.RESTORE_PRIMARY
            }
            WordsEntryState.Phase.PHASE_DONE -> WordsCopy.DONE
            else -> ""
        }
        val notice = model.notice.ifEmpty { if (phase == WordsEntryState.Phase.PHASE_ENTERING && !held) verdictNotice(model) else "" }
        return model.copy(
            state = WordsEntryState(
                phase = phase,
                purpose = model.purpose,
                origin = if (rekey) model.origin else WordsEntryState.Origin.ORIGIN_UNSPECIFIED,
                // NOTHING SECRET IS ON A HELD-SEED RESTORE: no word, no seed.
                secure = grid,
                title = title,
                body = body,
                cells = cells,
                endpoint_label = if (!rekey && !answered && phase != WordsEntryState.Phase.PHASE_CLOSED) WordsCopy.ENDPOINT_LABEL else "",
                endpoint = if (!rekey && !answered) model.endpoint else "",
                notice = notice,
                primary_label = primary,
                primary_enabled = when (phase) {
                    WordsEntryState.Phase.PHASE_ENTERING -> held || model.offerRestore || model.valid
                    WordsEntryState.Phase.PHASE_DONE -> true
                    else -> false
                },
                secondary_label = if (phase == WordsEntryState.Phase.PHASE_ENTERING) WordsCopy.CANCEL else "",
                progress = if (phase == WordsEntryState.Phase.PHASE_WORKING) {
                    if (rekey) WordsCopy.REKEYING else WordsCopy.RESTORING
                } else {
                    ""
                },
                restored = model.restored,
                stayed = model.stayed,
                retry_label = if (done && !rekey && model.stayedAt.isNotEmpty()) WordsCopy.RESTORED_STAYED_RETRY else "",
                accessibility_label = listOf(title, notice).filter { it.isNotEmpty() }.joinToString(". "),
            ),
        )
    }
}

/** The machine's model. **Redacted**: [cells] are the member's words. */
public data class Entry(
    public val phase: WordsEntryState.Phase = WordsEntryState.Phase.PHASE_CLOSED,
    public val purpose: WordsEntryState.Purpose = WordsEntryState.Purpose.PURPOSE_RESTORE,
    /** The re-key's door (#1047 F5); a restore ignores it. */
    public val origin: WordsEntryState.Origin = WordsEntryState.Origin.ORIGIN_UNSPECIFIED,
    public val state: WordsEntryState = WordsEntryState(),
    internal val cells: List<String> = List(WordsEntryMachine.CELLS) { "" },
    public val endpoint: String = "",
    /** Bumped on every edit; a check answers for one revision. */
    public val revision: Long = 0,
    internal val verdict: PhraseVerdict? = null,
    public val verdictRevision: Long = -1,
    public val notice: String = "",
    /** A re-key found nothing to key; the primary control restores instead. */
    public val offerRestore: Boolean = false,
    public val restored: List<RestoredVaultLine> = emptyList(),
    /** One sentence per vault that stayed with the other phone (R-1047-R5). */
    public val stayed: List<String> = emptyList(),
    /** DONE after a restore: every vault here, as the core answered it. Carries no secret. */
    internal val restoredAt: List<RestoredVaultAt> = emptyList(),
    /** DONE after a restore: the index of every vault that stayed (R-1047-R6). */
    internal val stayedAt: List<Int> = emptyList(),
    /** WORKING on a retry of what stayed, over DONE's lists (R-1047-R6). */
    public val retrying: Boolean = false,
) {
    /** The verdict for exactly the words on screen, or null while one is in flight. */
    internal val currentVerdict: PhraseVerdict? get() = verdict?.takeIf { verdictRevision == revision }

    /** The core called exactly these words a phrase. */
    public val valid: Boolean get() = currentVerdict?.verdict == PhraseVerdict.Verdict.VALID

    /** Whether any word is held. For the specs; never the words. */
    public val holdsWords: Boolean get() = cells.any { it.isNotEmpty() }

    override fun toString(): String = "Entry(phase=$phase, purpose=$purpose, revision=$revision, <redacted>)"
}

public sealed interface EntryInput {
    public data class View(public val event: WordsEntryEvent) : EntryInput {
        override fun toString(): String = "View(<redacted>)"
    }

    public data class Checked(public val revision: Long, public val verdict: PhraseVerdict?) : EntryInput

    public data class Restored(public val outcome: Enrollment.Restored) : EntryInput

    public data class Rekeyed(public val outcome: Enrollment.Rekeyed) : EntryInput
}

public sealed interface EntryEffect {
    public class Check(public val revision: Long, internal val words: List<String>) : EntryEffect {
        override fun toString(): String = "Check($revision, <redacted>)"
    }

    public class Restore(internal val words: List<String>, internal val endpoint: String) : EntryEffect {
        override fun toString(): String = "Restore(<redacted>)"
    }

    public class Rekey(internal val words: List<String>) : EntryEffect {
        override fun toString(): String = "Rekey(<redacted>)"
    }

    /** Restore from the seed this phone holds (Q-1047-18); no words. */
    public data class RestoreHeld(val endpoint: String) : EntryEffect

    /** Ask again for the vaults that stayed, by index (R-1047-R6); no words. */
    public data class RestoreStayed(val indices: List<Int>, val endpoint: String) : EntryEffect
}

public data class EntryStep(public val model: Entry, public val effects: List<EntryEffect> = emptyList())

/** THE MACHINE, RUNNING over a [PhraseDoor] and an [Enrollment]. */
public class WordsEntryFlow(
    private val phrase: () -> PhraseDoor?,
    private val enrollment: () -> Enrollment?,
    private val scope: CoroutineScope,
) {
    private val model = MutableStateFlow(WordsEntryMachine.initial())
    private val lock = Mutex()
    private val published = MutableStateFlow(model.value.state)

    public val state: StateFlow<WordsEntryState> get() = published.asStateFlow()

    /** The model, for specs. */
    public val current: Entry get() = model.value

    public fun send(event: WordsEntryEvent) {
        scope.launch { reduce(EntryInput.View(event)) }
    }

    public suspend fun reduce(input: EntryInput) {
        val effects = lock.withLock {
            val step = WordsEntryMachine.reduce(model.value, input)
            model.value = step.model
            published.value = step.model.state
            step.effects
        }
        effects.forEach { run(it) }
    }

    private suspend fun run(effect: EntryEffect) {
        val next: EntryInput = when (effect) {
            is EntryEffect.Check -> EntryInput.Checked(effect.revision, phrase()?.check(effect.words))
            is EntryEffect.Restore -> EntryInput.Restored(
                enrollment()?.restore(effect.words.map { it.trim() }, effect.endpoint.trim().ifEmpty { null })
                    ?: Enrollment.Restored.Unreachable,
            )
            is EntryEffect.RestoreHeld -> EntryInput.Restored(
                enrollment()?.restoreHeld(effect.endpoint.trim().ifEmpty { null })
                    ?: Enrollment.Restored.Unreachable,
            )
            is EntryEffect.RestoreStayed -> EntryInput.Restored(
                enrollment()?.restoreStayed(effect.indices, effect.endpoint.trim().ifEmpty { null })
                    ?: Enrollment.Restored.Unreachable,
            )
            is EntryEffect.Rekey -> EntryInput.Rekeyed(
                enrollment()?.rekey(effect.words.map { it.trim() })
                    ?: Enrollment.Rekeyed.Refused(Enrollment.Refusal.STORE_REFUSED),
            )
        }
        reduce(next)
    }
}

/**
 * `words.enter`'s BRIDGE — Swift holds bytes, Compose the `StateFlow`.
 *
 * A shell pushes it from the empty shelf's Restore control, from words.make's
 * `RestoreTapped` (PURPOSE_RESTORE), from Locker's `WordsTapped`
 * (PURPOSE_REKEY, ORIGIN_LOCKER) or from pair.laptop's `WordsTapped`
 * (PURPOSE_REKEY, ORIGIN_PAIRING), and:
 *
 * 1. calls [attach] with the session, then [open] with the purpose;
 * 2. draws the 24 cells, their marks and suggestions; while `secure` is set,
 *    shields the screen, and every cell is a no-autocorrect, no-learning field
 *    with no clipboard (`screen.proto`'s words section);
 * 3. forwards `WordTyped` on every change, `SuggestionPicked`, `EndpointTyped`,
 *    `Primary`, `Secondary`, and `Retry` from `retry_label`'s control;
 * 4. closes the screen when the phase is `PHASE_CLOSED`.
 */
public class WordsEntryBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: HomeSession? = null
    // LAZY, for `VaultWordsBridge`'s reason.
    private val flow by lazy {
        WordsEntryFlow(
            phrase = { session?.let { open -> CorePhraseDoor { open.shelf.core() ?: open.shelf.custodyCore() } } },
            enrollment = { session?.let { Enrollment.over(it, platformServices()) } },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
        )
    }
    private var onState: ((ByteArray) -> Unit)? = null

    public fun attach(session: HomeSession) {
        this.session = session
        scope.launch { flow.state.collect { onState?.invoke(it.encode()) } }
    }

    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        onState(flow.state.value.encode())
    }

    public val screen: WordsEntryState get() = flow.state.value

    public val states: StateFlow<WordsEntryState> get() = flow.state

    public fun open(
        purpose: WordsEntryState.Purpose,
        origin: WordsEntryState.Origin = WordsEntryState.Origin.ORIGIN_UNSPECIFIED,
    ) {
        forward(WordsEntryEvent(opened = WordsEntryEvent.Opened(purpose = purpose, origin = origin)))
    }

    /** Swift: restore onto this phone. */
    public fun openRestore() {
        open(WordsEntryState.Purpose.PURPOSE_RESTORE)
    }

    /** Swift: restore with the seed this phone already holds (words.make's RESTORE_FIRST). */
    public fun openRestoreHeld() {
        open(WordsEntryState.Purpose.PURPOSE_RESTORE_HELD)
    }

    /** Swift: hand the words back to this phone's vaults (Locker's wall). */
    public fun openRekey() {
        open(WordsEntryState.Purpose.PURPOSE_REKEY, WordsEntryState.Origin.ORIGIN_LOCKER)
    }

    /** Swift: the same re-key, from pair.laptop's NEEDS_WORDS (#1047 F5). */
    public fun openRekeyForPairing() {
        open(WordsEntryState.Purpose.PURPOSE_REKEY, WordsEntryState.Origin.ORIGIN_PAIRING)
    }

    public fun send(event: ByteArray) {
        forward(WordsEntryEvent.ADAPTER.decode(event))
    }

    public fun forward(event: WordsEntryEvent) {
        flow.send(event)
    }

    public fun current(): ByteArray = flow.state.value.encode()
}
