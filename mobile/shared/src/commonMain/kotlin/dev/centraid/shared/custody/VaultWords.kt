package dev.centraid.shared.custody

import centraid.screen.v1.VaultWordsEvent
import centraid.screen.v1.VaultWordsState
import centraid.screen.v1.WordAsk
import centraid.screen.v1.WordCell
import centraid.screen.v1.WordsEntryState
import dev.centraid.design.copy.WordsCopy
import dev.centraid.shared.platform.PlatformServices
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.shell.FoundResult
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
 * MAKE A VAULT, AND ITS 24 WORDS (#1047 E1, R-1047-E1/E2) — as a pure machine.
 *
 * `words.make`. The order is [Enrollment]'s: what this phone already holds is
 * read first; a phone with no seed FRAMES the words (one sentence to have
 * paper ready, and Continue), MINTS them (the core's CSPRNG), SHOWS
 * them once on a secure screen, asks three back, and only then has the core
 * turn them into the seed that is stored and settled; the vault is founded
 * after that, keyed from its first commit. A phone whose seed is its own makes
 * the vault at the next index with no words at all. A phone holding a seed
 * that arrived from elsewhere is sent to restore first.
 *
 * **The framing comes before the mint, so no word exists while it is up**, and
 * it is only for NEW words: a phone that makes its vault from a seed it already
 * holds shows no words and no framing, and restoring and showing the words
 * again are other machines (`WordsEntryMachine`, `WordsShowMachine`) whose
 * members already know what the words are. It is no step of [Enrollment]'s
 * order — nothing is stored or founded by it (R-1047-E1's order is untouched).
 *
 * **The words live in [Words.phrase] from the mint until the seed is kept**,
 * and in the drawn state only while [VaultWordsState.Phase.PHASE_SHOW] is up.
 * Cancelling, dismissing or keeping them drops them; nothing writes them.
 */
public object VaultWordsMachine {
    public fun initial(): Words = render(Words())

    public fun reduce(model: Words, input: WordsInput): WordsStep {
        val phase = model.phase
        // A CLOSED FLOW HEARS ONLY A NEW OPEN: an answer that arrives after the
        // member left changes nothing they can see.
        if (phase == VaultWordsState.Phase.PHASE_CLOSED &&
            !(input is WordsInput.View && input.event.opened != null)
        ) {
            return WordsStep(model)
        }
        return when (input) {
            is WordsInput.View -> view(model, input.event)
            is WordsInput.Standing -> standing(model, input)
            is WordsInput.Minted -> minted(model, input)
            is WordsInput.Kept -> kept(model, input.refusal)
            is WordsInput.Made -> made(model, input.result)
        }
    }

    private fun view(model: Words, event: VaultWordsEvent): WordsStep {
        val phase = model.phase
        return when {
            event.opened != null -> WordsStep(render(Words(phase = VaultWordsState.Phase.PHASE_CHECKING)), listOf(WordsEffect.Assess))
            event.dismissed != null -> WordsStep(closed())
            event.typed != null && phase == VaultWordsState.Phase.PHASE_CONFIRM -> {
                val at = event.typed.position
                if (at !in model.asking) return WordsStep(model)
                WordsStep(
                    render(
                        model.copy(
                            typed = model.typed + (at to event.typed.text),
                            marks = model.marks + (at to WordAsk.Mark.MARK_UNANSWERED),
                            notice = "",
                        ),
                    ),
                )
            }
            event.primary != null -> primary(model)
            event.secondary != null -> secondary(model)
            // `restore` IS AN INTENT: the shell opens words.enter.
            else -> WordsStep(model)
        }
    }

    private fun primary(model: Words): WordsStep = when (model.phase) {
        // CONTINUE: only now are the words minted. Back to CHECKING, which is
        // the phase `minted` answers in, with the custody sentence kept.
        VaultWordsState.Phase.PHASE_FRAMING -> WordsStep(
            render(model.copy(phase = VaultWordsState.Phase.PHASE_CHECKING)),
            listOf(WordsEffect.Mint),
        )
        VaultWordsState.Phase.PHASE_SHOW -> WordsStep(
            render(model.copy(phase = VaultWordsState.Phase.PHASE_CONFIRM, typed = emptyMap(), marks = emptyMap(), notice = "")),
        )
        VaultWordsState.Phase.PHASE_CONFIRM -> {
            val marks = model.asking.associateWith { at ->
                if (PhraseMachine.matches(model.phrase, at, model.typed[at].orEmpty())) {
                    WordAsk.Mark.MARK_RIGHT
                } else {
                    WordAsk.Mark.MARK_WRONG
                }
            }
            if (marks.values.all { it == WordAsk.Mark.MARK_RIGHT }) {
                WordsStep(
                    render(model.copy(phase = VaultWordsState.Phase.PHASE_MAKING, marks = marks, notice = "")),
                    listOf(WordsEffect.Keep(model.phrase)),
                )
            } else {
                WordsStep(render(model.copy(marks = marks, notice = WordsCopy.CHECK_WRONG)))
            }
        }
        VaultWordsState.Phase.PHASE_MADE -> WordsStep(closed())
        VaultWordsState.Phase.PHASE_FAILED -> when (model.retry) {
            Retry.MINT -> WordsStep(render(Words(phase = VaultWordsState.Phase.PHASE_CHECKING)), listOf(WordsEffect.Assess))
            Retry.KEEP -> WordsStep(
                render(model.copy(phase = VaultWordsState.Phase.PHASE_MAKING, notice = "")),
                listOf(WordsEffect.Keep(model.phrase)),
            )
            Retry.MAKE -> WordsStep(render(model.copy(phase = VaultWordsState.Phase.PHASE_MAKING, notice = "")), listOf(WordsEffect.Make))
            Retry.NONE -> WordsStep(closed())
        }
        else -> WordsStep(model)
    }

    private fun secondary(model: Words): WordsStep = when (model.phase) {
        // "SHOW THE WORDS AGAIN": back to the list, the typing dropped.
        VaultWordsState.Phase.PHASE_CONFIRM -> WordsStep(
            render(model.copy(phase = VaultWordsState.Phase.PHASE_SHOW, typed = emptyMap(), marks = emptyMap(), notice = "")),
        )
        VaultWordsState.Phase.PHASE_FRAMING,
        VaultWordsState.Phase.PHASE_SHOW,
        VaultWordsState.Phase.PHASE_FAILED,
        VaultWordsState.Phase.PHASE_RESTORE_FIRST,
        -> WordsStep(closed())
        else -> WordsStep(model)
    }

    private fun standing(model: Words, input: WordsInput.Standing): WordsStep {
        if (model.phase != VaultWordsState.Phase.PHASE_CHECKING) return WordsStep(model)
        return when (input.standing) {
            // NO WORDS YET: frame them first, and mint when the member says
            // Continue (see the header).
            Enrollment.Standing.NO_SEED ->
                WordsStep(render(model.copy(phase = VaultWordsState.Phase.PHASE_FRAMING, custody = input.custody)))
            // THE WORDS ALREADY ROOT THIS PHONE'S VAULTS: the next index, no words.
            Enrollment.Standing.SETTLED ->
                WordsStep(render(model.copy(phase = VaultWordsState.Phase.PHASE_MAKING)), listOf(WordsEffect.Make))
            Enrollment.Standing.UNSETTLED ->
                WordsStep(render(model.copy(phase = VaultWordsState.Phase.PHASE_RESTORE_FIRST)))
        }
    }

    private fun minted(model: Words, input: WordsInput.Minted): WordsStep {
        if (model.phase != VaultWordsState.Phase.PHASE_CHECKING) return WordsStep(model)
        val words = input.words
        if (words == null || words.size != PhraseMachine.WORDS) {
            return WordsStep(failed(model, WordsCopy.MINT_FAILED, Retry.MINT))
        }
        return WordsStep(render(model.copy(phase = VaultWordsState.Phase.PHASE_SHOW, phrase = words, asking = input.asking)))
    }

    private fun kept(model: Words, refusal: Enrollment.Refusal?): WordsStep {
        if (model.phase != VaultWordsState.Phase.PHASE_MAKING) return WordsStep(model)
        return when (refusal) {
            // KEPT: the words are dropped here, and the vault is founded.
            null -> WordsStep(render(model.copy(phrase = emptyList(), typed = emptyMap())), listOf(WordsEffect.Make))
            Enrollment.Refusal.DIFFERENT_WORDS -> WordsStep(failed(model.copy(phrase = emptyList()), WordsCopy.DIFFERENT_WORDS, Retry.NONE))
            Enrollment.Refusal.NOT_A_PHRASE -> WordsStep(failed(model.copy(phrase = emptyList()), WordsCopy.MINT_FAILED, Retry.MINT))
            Enrollment.Refusal.STORE_REFUSED -> WordsStep(failed(model, WordsCopy.KEEP_FAILED, Retry.KEEP))
        }
    }

    private fun made(model: Words, result: FoundResult): WordsStep {
        if (model.phase != VaultWordsState.Phase.PHASE_MAKING) return WordsStep(model)
        return when (result) {
            is FoundResult.Made -> WordsStep(render(model.copy(phase = VaultWordsState.Phase.PHASE_MADE, vaultName = result.vaultName)))
            is FoundResult.Refused -> WordsStep(failed(model, result.sentence, Retry.MAKE))
            FoundResult.NoSession -> WordsStep(failed(model, WordsCopy.STILL_OPENING, Retry.MAKE))
        }
    }

    private fun failed(model: Words, notice: String, retry: Retry): Words =
        render(model.copy(phase = VaultWordsState.Phase.PHASE_FAILED, notice = notice, retry = retry))

    private fun closed(): Words = render(Words(phase = VaultWordsState.Phase.PHASE_CLOSED))

    /** Every word the screen says, for the model's phase. */
    internal fun render(model: Words): Words {
        val phase = model.phase
        val secure = phase == VaultWordsState.Phase.PHASE_SHOW || phase == VaultWordsState.Phase.PHASE_CONFIRM
        val title = when (phase) {
            VaultWordsState.Phase.PHASE_FRAMING -> WordsCopy.FRAMING_TITLE
            VaultWordsState.Phase.PHASE_SHOW -> WordsCopy.SHOW_TITLE
            VaultWordsState.Phase.PHASE_CONFIRM -> WordsCopy.CHECK_TITLE
            VaultWordsState.Phase.PHASE_MADE -> WordsCopy.MADE_TITLE
            VaultWordsState.Phase.PHASE_FAILED -> WordsCopy.FAILED_TITLE
            VaultWordsState.Phase.PHASE_RESTORE_FIRST -> WordsCopy.RESTORE_FIRST_TITLE
            VaultWordsState.Phase.PHASE_CLOSED -> ""
            else -> WordsCopy.MAKING_TITLE
        }
        val body = when (phase) {
            VaultWordsState.Phase.PHASE_FRAMING -> WordsCopy.FRAMING_BODY
            VaultWordsState.Phase.PHASE_SHOW -> WordsCopy.SHOW_BODY
            VaultWordsState.Phase.PHASE_CONFIRM ->
                WordsCopy.CHECK_BODY.replace("{positions}", model.asking.joinToString(", "))
            VaultWordsState.Phase.PHASE_MADE -> WordsCopy.MADE_BODY.replace("{name}", model.vaultName)
            VaultWordsState.Phase.PHASE_RESTORE_FIRST -> WordsCopy.RESTORE_FIRST_BODY
            VaultWordsState.Phase.PHASE_MAKING, VaultWordsState.Phase.PHASE_CHECKING -> WordsCopy.MAKING_BODY
            else -> ""
        }
        val primary = when (phase) {
            VaultWordsState.Phase.PHASE_FRAMING -> WordsCopy.FRAMING_PRIMARY
            VaultWordsState.Phase.PHASE_SHOW -> WordsCopy.SHOW_PRIMARY
            VaultWordsState.Phase.PHASE_CONFIRM -> WordsCopy.CHECK_PRIMARY
            VaultWordsState.Phase.PHASE_MADE -> WordsCopy.DONE
            VaultWordsState.Phase.PHASE_FAILED -> if (model.retry == Retry.NONE) WordsCopy.DONE else WordsCopy.TRY_AGAIN
            else -> ""
        }
        val secondary = when (phase) {
            VaultWordsState.Phase.PHASE_FRAMING,
            VaultWordsState.Phase.PHASE_SHOW,
            VaultWordsState.Phase.PHASE_RESTORE_FIRST,
            -> WordsCopy.CANCEL
            VaultWordsState.Phase.PHASE_CONFIRM -> WordsCopy.CHECK_SECONDARY
            VaultWordsState.Phase.PHASE_FAILED -> if (model.retry == Retry.NONE) "" else WordsCopy.CANCEL
            else -> ""
        }
        val words = if (phase == VaultWordsState.Phase.PHASE_SHOW) {
            model.phrase.mapIndexed { at, word ->
                WordCell(
                    position = at + 1,
                    word = word,
                    accessibility_label = WordsCopy.WORD_SPOKEN.replace("{n}", "${at + 1}").replace("{word}", word),
                )
            }
        } else {
            emptyList()
        }
        val asks = if (phase == VaultWordsState.Phase.PHASE_CONFIRM) {
            model.asking.map { at ->
                WordAsk(
                    position = at,
                    prompt = WordsCopy.CHECK_PROMPT.replace("{n}", "$at"),
                    typed = model.typed[at].orEmpty(),
                    mark = model.marks[at] ?: WordAsk.Mark.MARK_UNANSWERED,
                )
            }
        } else {
            emptyList()
        }
        val enabled = when (phase) {
            VaultWordsState.Phase.PHASE_CONFIRM -> model.asking.all { model.typed[it].orEmpty().isNotBlank() }
            else -> primary.isNotEmpty()
        }
        val accessibility = when (phase) {
            VaultWordsState.Phase.PHASE_SHOW -> WordsCopy.SHOW_A11Y
            VaultWordsState.Phase.PHASE_FRAMING -> listOf(title, body).joinToString(". ")
            else -> listOf(title, model.notice).filter { it.isNotEmpty() }.joinToString(". ")
        }
        return model.copy(
            state = VaultWordsState(
                phase = phase,
                secure = secure,
                title = title,
                body = body,
                words = words,
                asks = asks,
                primary_label = primary,
                primary_enabled = enabled,
                secondary_label = secondary,
                notice = model.notice,
                custody = if (phase == VaultWordsState.Phase.PHASE_SHOW) model.custody else "",
                restore_label = if (phase == VaultWordsState.Phase.PHASE_RESTORE_FIRST) WordsCopy.RESTORE_FIRST_ACTION else "",
                accessibility_label = accessibility,
                // RESTORE_FIRST MEANS A SEED IS HERE (UNSETTLED), so the restore
                // runs from it with no words typed (Q-1047-18).
                restore_purpose = if (phase == VaultWordsState.Phase.PHASE_RESTORE_FIRST) {
                    WordsEntryState.Purpose.PURPOSE_RESTORE_HELD
                } else {
                    WordsEntryState.Purpose.PURPOSE_UNSPECIFIED
                },
            ),
        )
    }
}

/** What "Try again" does from FAILED. */
public enum class Retry { NONE, MINT, KEEP, MAKE }

/**
 * The machine's whole model. **Redacted**: [phrase] and [typed] are the
 * member's words, and a model that reached a log line or a crash report would
 * carry every vault they have.
 */
public data class Words(
    public val phase: VaultWordsState.Phase = VaultWordsState.Phase.PHASE_CHECKING,
    public val state: VaultWordsState = VaultWordsState(),
    internal val phrase: List<String> = emptyList(),
    public val asking: List<Int> = emptyList(),
    internal val typed: Map<Int, String> = emptyMap(),
    public val marks: Map<Int, WordAsk.Mark> = emptyMap(),
    public val custody: String = "",
    public val notice: String = "",
    public val retry: Retry = Retry.NONE,
    public val vaultName: String = "",
) {
    /** Whether the words are held right now. For the specs; never the words. */
    public val holdsWords: Boolean get() = phrase.isNotEmpty()

    override fun toString(): String = "Words(phase=$phase, asking=$asking, retry=$retry, <redacted>)"
}

public sealed interface WordsInput {
    public data class View(public val event: VaultWordsEvent) : WordsInput {
        override fun toString(): String = "View(<redacted>)"
    }

    /** What this phone holds; [custody] is the platform's sentence about its key. */
    public data class Standing(public val standing: Enrollment.Standing, public val custody: String) : WordsInput

    /** The core's words and the positions drawn to ask; null words is a refused mint. */
    public class Minted(public val words: List<String>?, public val asking: List<Int>) : WordsInput {
        override fun toString(): String = "Minted(<redacted>)"
    }

    /** The seed was kept (null), or why not. */
    public data class Kept(public val refusal: Enrollment.Refusal?) : WordsInput

    public data class Made(public val result: FoundResult) : WordsInput
}

public sealed interface WordsEffect {
    /** Read [Enrollment.standing] and the custody sentence. */
    public data object Assess : WordsEffect

    /** Mint through the core and draw the positions from the platform CSPRNG. */
    public data object Mint : WordsEffect

    /** Have the core seed [words], and store and settle the seed. */
    public class Keep(internal val words: List<String>) : WordsEffect {
        override fun toString(): String = "Keep(<redacted>)"
    }

    /** Found the vault at the next index. */
    public data object Make : WordsEffect
}

public data class WordsStep(public val model: Words, public val effects: List<WordsEffect> = emptyList())

/**
 * THE MACHINE, RUNNING over an [Enrollment]: one reduction at a time, its
 * effects served in order, the state published.
 */
public class VaultWordsFlow(
    private val enrollment: () -> Enrollment?,
    private val services: PlatformServices,
    private val scope: CoroutineScope,
) {
    private val model = MutableStateFlow(VaultWordsMachine.initial())
    private val lock = Mutex()
    private val published = MutableStateFlow(model.value.state)

    public val state: StateFlow<VaultWordsState> get() = published.asStateFlow()

    /** The model, for specs. */
    public val current: Words get() = model.value

    public fun send(event: VaultWordsEvent) {
        scope.launch { reduce(WordsInput.View(event)) }
    }

    /** Reduce now and serve what it asks; suspends until every effect has answered. */
    public suspend fun reduce(input: WordsInput) {
        val effects = lock.withLock {
            val step = VaultWordsMachine.reduce(model.value, input)
            model.value = step.model
            published.value = step.model.state
            step.effects
        }
        effects.forEach { run(it) }
    }

    private suspend fun run(effect: WordsEffect) {
        val enrolled = enrollment()
        val next: WordsInput = when (effect) {
            WordsEffect.Assess -> WordsInput.Standing(
                standing = enrolled?.standing() ?: Enrollment.Standing.NO_SEED,
                custody = runCatching { services.syncedSecrets.availability() }
                    .map { PhraseMachine.custodySentence(it) }
                    .getOrDefault(""),
            )
            WordsEffect.Mint -> WordsInput.Minted(
                words = enrolled?.mint(),
                asking = PhraseMachine.positions { bound -> draw(bound) },
            )
            // NULL IS "KEPT", so no enrollment at all is its own refusal
            // rather than an elvis that would read a success as one.
            is WordsEffect.Keep -> WordsInput.Kept(
                if (enrolled == null) Enrollment.Refusal.STORE_REFUSED else enrolled.keep(effect.words),
            )
            WordsEffect.Make -> WordsInput.Made(enrolled?.make() ?: FoundResult.NoSession)
        }
        reduce(next)
    }

    /** A value below [bound] from the platform CSPRNG, by rejection so no position is favoured. */
    private fun draw(bound: Int): Int {
        val limit = (65_536 / bound) * bound
        while (true) {
            val bytes = services.secureRandom.bytes(2)
            val value = ((bytes[0].toInt() and 0xFF) shl 8) or (bytes[1].toInt() and 0xFF)
            if (value < limit) return value % bound
        }
    }
}

/**
 * `words.make`'s BRIDGE — Swift holds bytes, Compose the `StateFlow`.
 *
 * A shell presents it as a sheet from the make-vault control and:
 *
 * 1. calls [attach] with the session, then [open];
 * 2. draws every state; while `secure` is set, shields the screen (see
 *    `screen.proto`'s words section for the three platform duties);
 * 3. forwards `Primary`, `Secondary`, `WordTyped` and `Dismissed`;
 * 4. on `RestoreTapped` (the intent `restore_label` offers), opens words.enter
 *    with the state's `restore_purpose` (`PURPOSE_RESTORE_HELD`: this phone
 *    holds a seed and restores from it, Q-1047-18);
 * 5. closes the sheet when the phase is `PHASE_CLOSED`.
 */
public class VaultWordsBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: HomeSession? = null
    // LAZY: `platformServices()` is installed by the shell at launch, and a
    // bridge a view constructs early must not read it before then.
    private val flow by lazy {
        VaultWordsFlow(
            enrollment = { session?.let { Enrollment.over(it, platformServices()) } },
            services = platformServices(),
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

    /** The state now (Compose collects [states]). */
    public val screen: VaultWordsState get() = flow.state.value

    public val states: StateFlow<VaultWordsState> get() = flow.state

    public fun open() {
        forward(VaultWordsEvent(opened = VaultWordsEvent.Opened()))
    }

    public fun send(event: ByteArray) {
        forward(VaultWordsEvent.ADAPTER.decode(event))
    }

    public fun forward(event: VaultWordsEvent) {
        flow.send(event)
    }

    public fun current(): ByteArray = flow.state.value.encode()
}
