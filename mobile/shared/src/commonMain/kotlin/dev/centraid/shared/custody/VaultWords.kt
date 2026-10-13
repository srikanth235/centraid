package dev.centraid.shared.custody

import centraid.screen.v1.VaultWordsEvent
import centraid.screen.v1.VaultWordsState
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
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * MAKE A VAULT, AND ITS 24 WORDS (#1047 E1, R-1047-E1/E2) — as a pure machine.
 *
 * `words.make`. The order is [Enrollment]'s: what this phone already holds is
 * read first; a phone with no seed MINTS the words (the core's CSPRNG) and
 * has the core turn them into the seed that is stored and settled; the vault
 * is founded after that, keyed from its first commit.
 *
 * **THE KEY IS SHOWN ONLY WHERE NOTHING ELSE WILL HOLD IT (R-ONBOARD-10).** A
 * phone whose synchronised store takes the seed (iCloud Keychain, Google's
 * Block Store) keeps it there without a word to the member: the vault comes
 * back on their next phone the way their passwords do, and the Backup tab
 * says where the key is and offers to keep it off the keychain. Only a phone
 * whose key would stay on it alone SHOWS the words once on a secure screen
 * and waits for "I've saved it" — and a vault on its own key always does. A phone whose seed is its own makes
 * the vault at the next index with no words at all. A phone holding a seed
 * that arrived from elsewhere is sent to restore first.
 *
 * **There is no framing screen.** The words are shown straight away, and the
 * screen itself says what they are for and offers to save a copy of them
 * (`save_label`, drawn and performed by the shell): the phone's own copy lives
 * and dies with the phone, so a copy kept elsewhere is the only way back from a
 * lost one. A phone that makes its vault from a seed it already holds shows no
 * words, and restoring and showing the words again are other machines
 * (`WordsEntryMachine`, `WordsShowMachine`).
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
            is WordsInput.Kept -> kept(model, input.refusal, input.own)
            is WordsInput.Made -> made(model, input.result)
        }
    }

    private fun view(model: Words, event: VaultWordsEvent): WordsStep {
        val phase = model.phase
        return when {
            event.opened != null -> WordsStep(render(Words(phase = VaultWordsState.Phase.PHASE_CHECKING)), listOf(WordsEffect.Assess))
            event.dismissed != null -> leave(model)
            event.own != null && phase == VaultWordsState.Phase.PHASE_CHOOSE ->
                WordsStep(render(model.copy(own = event.own.on)))
            event.name != null && phase == VaultWordsState.Phase.PHASE_CHOOSE ->
                WordsStep(render(model.copy(name = event.name.text)))
            event.primary != null -> primary(model)
            event.secondary != null -> secondary(model)
            // `restore` IS AN INTENT: the shell opens words.enter.
            else -> WordsStep(model)
        }
    }

    private fun primary(model: Words): WordsStep = when (model.phase) {
        // "MAKE VAULT": on the member's words now, or — kept on its own —
        // after fresh words are minted and shown (R-1047-E18).
        VaultWordsState.Phase.PHASE_CHOOSE -> when {
            !model.own -> WordsStep(render(model.copy(phase = VaultWordsState.Phase.PHASE_MAKING)), listOf(make(model)))
            model.name.isBlank() -> WordsStep(model)
            else -> WordsStep(render(model.copy(phase = VaultWordsState.Phase.PHASE_CHECKING)), listOf(WordsEffect.Mint))
        }
        // "I HAVE SAVED THEM": the core turns the words into the seed and keeps it.
        VaultWordsState.Phase.PHASE_SHOW -> WordsStep(
            render(model.copy(phase = VaultWordsState.Phase.PHASE_MAKING, notice = "")),
            listOf(keep(model)),
        )
        VaultWordsState.Phase.PHASE_MADE -> WordsStep(closed())
        VaultWordsState.Phase.PHASE_FAILED -> when (model.retry) {
            Retry.MINT -> WordsStep(render(Words(phase = VaultWordsState.Phase.PHASE_CHECKING)), listOf(WordsEffect.Assess))
            Retry.KEEP -> WordsStep(
                render(model.copy(phase = VaultWordsState.Phase.PHASE_MAKING, notice = "")),
                listOf(keep(model)),
            )
            Retry.MAKE -> WordsStep(render(model.copy(phase = VaultWordsState.Phase.PHASE_MAKING, notice = "")), listOf(make(model)))
            Retry.NONE -> leave(model)
        }
        else -> WordsStep(model)
    }

    private fun secondary(model: Words): WordsStep = when (model.phase) {
        VaultWordsState.Phase.PHASE_CHOOSE,
        VaultWordsState.Phase.PHASE_SHOW,
        VaultWordsState.Phase.PHASE_FAILED,
        VaultWordsState.Phase.PHASE_RESTORE_FIRST,
        -> leave(model)
        else -> WordsStep(model)
    }

    /** Keep the shown words: as the member's seed, or as this vault's own. */
    private fun keep(model: Words): WordsEffect =
        if (model.own) WordsEffect.KeepOwn(model.phrase, model.name.trim()) else WordsEffect.Keep(model.phrase)

    private fun make(model: Words): WordsEffect.Make =
        WordsEffect.Make(own = model.ownId, name = model.name.trim().takeIf { it.isNotEmpty() })

    /**
     * CLOSE, and drop an entry kept for a vault that was never made: words the
     * member wrote down for a found that did not happen key nothing.
     */
    private fun leave(model: Words): WordsStep {
        val orphan = model.ownId?.takeIf { model.phase != VaultWordsState.Phase.PHASE_MADE }
        return WordsStep(closed(), listOfNotNull(orphan?.let { WordsEffect.DropOwn(it) }))
    }

    private fun standing(model: Words, input: WordsInput.Standing): WordsStep {
        if (model.phase != VaultWordsState.Phase.PHASE_CHECKING) return WordsStep(model)
        return when (input.standing) {
            // NO WORDS YET: mint them now, and keep the custody sentence for
            // the show that follows. `minted` answers in CHECKING.
            Enrollment.Standing.NO_SEED ->
                WordsStep(render(model.copy(custody = input.custody, quiet = input.synchronizing)), listOf(WordsEffect.Mint))
            // THE WORDS ALREADY ROOT THIS PHONE'S VAULTS: a name, and the
            // choice to keep this one on its own words (R-1047-E18); not
            // ticked, the next index with no words.
            Enrollment.Standing.SETTLED ->
                WordsStep(
                    render(
                        model.copy(
                            phase = VaultWordsState.Phase.PHASE_CHOOSE,
                            custody = input.custody,
                            quiet = input.synchronizing,
                        ),
                    ),
                )
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
        // THE KEYCHAIN WILL HOLD IT: kept without being shown (R-ONBOARD-10).
        // A vault on its own key is always shown — its key is filed in the
        // main vault's Locker too, but that is a copy the member should know of.
        if (model.quiet && !model.own) {
            val next = model.copy(phase = VaultWordsState.Phase.PHASE_MAKING, phrase = words)
            return WordsStep(render(next), listOf(WordsEffect.Keep(words, sync = true, shown = false)))
        }
        return WordsStep(render(model.copy(phase = VaultWordsState.Phase.PHASE_SHOW, phrase = words)))
    }

    private fun kept(model: Words, refusal: Enrollment.Refusal?, own: String? = null): WordsStep {
        if (model.phase != VaultWordsState.Phase.PHASE_MAKING) return WordsStep(model)
        return when (refusal) {
            // KEPT: the words are dropped here, and the vault is founded —
            // on its own entry when it has one.
            null -> {
                val next = model.copy(phrase = emptyList(), ownId = own ?: model.ownId)
                WordsStep(render(next), listOf(make(next)))
            }
            Enrollment.Refusal.DIFFERENT_WORDS -> WordsStep(failed(model.copy(phrase = emptyList()), WordsCopy.DIFFERENT_WORDS, Retry.NONE))
            Enrollment.Refusal.NOT_A_PHRASE -> WordsStep(failed(model.copy(phrase = emptyList()), WordsCopy.MINT_FAILED, Retry.MINT))
            Enrollment.Refusal.STORE_REFUSED -> WordsStep(failed(model, WordsCopy.KEEP_FAILED, Retry.KEEP))
        }
    }

    private fun made(model: Words, result: FoundResult): WordsStep {
        if (model.phase != VaultWordsState.Phase.PHASE_MAKING) return WordsStep(model)
        return when (result) {
            // NO "VAULT READY" SCREEN: the sheet closes onto Home, and the
            // sentence it would have said rides on the closed state for
            // Home's status line to take.
            is FoundResult.Made -> {
                val said = render(model.copy(phase = VaultWordsState.Phase.PHASE_MADE, vaultName = result.vaultName)).state.body
                val gone = closed()
                WordsStep(gone.copy(state = gone.state.copy(body = said)))
            }
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
        val secure = phase == VaultWordsState.Phase.PHASE_SHOW
        val ownName = model.name.trim()
        val title = when (phase) {
            VaultWordsState.Phase.PHASE_CHOOSE -> WordsCopy.CHOOSE_TITLE
            VaultWordsState.Phase.PHASE_SHOW -> if (model.own) WordsCopy.SHOW_OWN_TITLE.replace("{name}", ownName) else WordsCopy.SHOW_TITLE
            VaultWordsState.Phase.PHASE_MADE -> WordsCopy.MADE_TITLE
            VaultWordsState.Phase.PHASE_FAILED -> WordsCopy.FAILED_TITLE
            VaultWordsState.Phase.PHASE_RESTORE_FIRST -> WordsCopy.RESTORE_FIRST_TITLE
            VaultWordsState.Phase.PHASE_CLOSED -> ""
            else -> WordsCopy.MAKING_TITLE
        }
        val body = when (phase) {
            VaultWordsState.Phase.PHASE_CHOOSE -> if (model.own) WordsCopy.CHOOSE_OWN_BODY else WordsCopy.CHOOSE_BODY
            VaultWordsState.Phase.PHASE_SHOW -> if (model.own) WordsCopy.SHOW_OWN_BODY.replace("{name}", ownName) else WordsCopy.SHOW_BODY
            VaultWordsState.Phase.PHASE_MADE ->
                (if (model.own) WordsCopy.MADE_OWN_BODY else WordsCopy.MADE_BODY).replace("{name}", model.vaultName)
            VaultWordsState.Phase.PHASE_RESTORE_FIRST -> WordsCopy.RESTORE_FIRST_BODY
            VaultWordsState.Phase.PHASE_MAKING, VaultWordsState.Phase.PHASE_CHECKING -> WordsCopy.MAKING_BODY
            else -> ""
        }
        val primary = when (phase) {
            VaultWordsState.Phase.PHASE_CHOOSE -> WordsCopy.CHOOSE_PRIMARY
            VaultWordsState.Phase.PHASE_SHOW -> WordsCopy.SHOW_PRIMARY
            VaultWordsState.Phase.PHASE_MADE -> WordsCopy.DONE
            VaultWordsState.Phase.PHASE_FAILED -> if (model.retry == Retry.NONE) WordsCopy.DONE else WordsCopy.TRY_AGAIN
            else -> ""
        }
        val secondary = when (phase) {
            VaultWordsState.Phase.PHASE_CHOOSE,
            VaultWordsState.Phase.PHASE_SHOW,
            VaultWordsState.Phase.PHASE_RESTORE_FIRST,
            -> WordsCopy.CANCEL
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
        // A VAULT ON ITS OWN WORDS NEEDS A NAME: it is how a restore lists it.
        val enabled = primary.isNotEmpty() &&
            !(phase == VaultWordsState.Phase.PHASE_CHOOSE && model.own && ownName.isEmpty())
        val accessibility = when (phase) {
            VaultWordsState.Phase.PHASE_SHOW -> WordsCopy.SHOW_A11Y
            else -> listOf(title, model.notice).filter { it.isNotEmpty() }.joinToString(". ")
        }
        return model.copy(
            state = VaultWordsState(
                phase = phase,
                secure = secure,
                title = title,
                body = body,
                words = words,
                primary_label = primary,
                primary_enabled = enabled,
                secondary_label = secondary,
                notice = model.notice,
                // NO CHECKBOX (R-ONBOARD-10): the words are shown only where
                // the keychain will not hold the key, and the platform's
                // sentence says so; keeping it off the keychain is the Backup
                // tab's, after the vault exists.
                custody = if (phase == VaultWordsState.Phase.PHASE_SHOW && !model.own) model.custody else "",
                save_label = if (phase == VaultWordsState.Phase.PHASE_SHOW) WordsCopy.SAVE_LABEL else "",
                own_label = if (phase == VaultWordsState.Phase.PHASE_CHOOSE) WordsCopy.OWN_LABEL else "",
                own_on = phase == VaultWordsState.Phase.PHASE_CHOOSE && model.own,
                name_label = if (phase == VaultWordsState.Phase.PHASE_CHOOSE) WordsCopy.NAME_LABEL else "",
                name = if (phase == VaultWordsState.Phase.PHASE_CHOOSE) model.name else "",
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
 * The machine's whole model. **Redacted**: [phrase] is the
 * member's words, and a model that reached a log line or a crash report would
 * carry every vault they have.
 */
public data class Words(
    public val phase: VaultWordsState.Phase = VaultWordsState.Phase.PHASE_CHECKING,
    public val state: VaultWordsState = VaultWordsState(),
    internal val phrase: List<String> = emptyList(),
    public val custody: String = "",
    /**
     * The synchronised store will take the key, so it is kept without being
     * shown (R-ONBOARD-10).
     */
    public val quiet: Boolean = false,
    public val notice: String = "",
    public val retry: Retry = Retry.NONE,
    public val vaultName: String = "",
    /** CHOOSE: keep this vault on its own words (R-1047-E18). */
    public val own: Boolean = false,
    /** CHOOSE: the name typed for the vault. */
    public val name: String = "",
    /** The entry this vault's own seed was kept under, once kept. */
    public val ownId: String? = null,
) {
    /** Whether the words are held right now. For the specs; never the words. */
    public val holdsWords: Boolean get() = phrase.isNotEmpty()

    override fun toString(): String = "Words(phase=$phase, retry=$retry, <redacted>)"
}

public sealed interface WordsInput {
    public data class View(public val event: VaultWordsEvent) : WordsInput {
        override fun toString(): String = "View(<redacted>)"
    }

    /**
     * What this phone holds; [custody] is the platform's sentence about its
     * key, and [synchronizing] whether its synchronised store will take it.
     */
    public data class Standing(
        public val standing: Enrollment.Standing,
        public val custody: String,
        public val synchronizing: Boolean = false,
    ) : WordsInput

    /** The core's words; null is a refused mint. */
    public class Minted(public val words: List<String>?) : WordsInput {
        override fun toString(): String = "Minted(<redacted>)"
    }

    /** The seed was kept (null), or why not; [own] is the entry a vault's own seed went under. */
    public data class Kept(public val refusal: Enrollment.Refusal?, public val own: String? = null) : WordsInput

    public data class Made(public val result: FoundResult) : WordsInput
}

public sealed interface WordsEffect {
    /** Read [Enrollment.standing] and the custody sentence. */
    public data object Assess : WordsEffect

    /** Mint the words through the core. */
    public data object Mint : WordsEffect

    /**
     * Have the core seed [words], and store and settle the seed — synced when
     * [sync]; [shown] when the member saw them and said they saved them.
     */
    public class Keep(internal val words: List<String>, public val sync: Boolean = true, public val shown: Boolean = true) : WordsEffect {
        override fun toString(): String = "Keep(<redacted>)"
    }

    /** Have the core seed [words] and keep the seed for one vault alone, labelled [name] (R-1047-E18). */
    public class KeepOwn(internal val words: List<String>, public val name: String) : WordsEffect {
        override fun toString(): String = "KeepOwn(<redacted>)"
    }

    /** Found the vault: at the next index, or on entry [own]'s seed; named [name] when given. */
    public data class Make(public val own: String? = null, public val name: String? = null) : WordsEffect

    /** Forget entry [id]: kept for a vault that was never made. */
    public data class DropOwn(public val id: String) : WordsEffect
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

    private val madeSignal = MutableSharedFlow<String>(extraBufferCapacity = 1)

    /**
     * A VAULT WAS MADE, once per make, carrying the sentence the closed state
     * also carries. Its own signal and not a reading of [state]: the closed
     * state is followed at once by the sheet's own dismissal, and a collector
     * that is conflated to the last state would never see the made one. The
     * shells' status line and the camera-roll ask (R-ONBOARD-8) take this.
     */
    public val made: SharedFlow<String> get() = madeSignal.asSharedFlow()

    /** The model, for specs. */
    public val current: Words get() = model.value

    public fun send(event: VaultWordsEvent) {
        scope.launch { reduce(WordsInput.View(event)) }
    }

    /** Reduce now and serve what it asks; suspends until every effect has answered. */
    public suspend fun reduce(input: WordsInput) {
        val effects = lock.withLock {
            val before = model.value.phase
            val step = VaultWordsMachine.reduce(model.value, input)
            model.value = step.model
            published.value = step.model.state
            val after = step.model.state
            if (before == VaultWordsState.Phase.PHASE_MAKING &&
                after.phase == VaultWordsState.Phase.PHASE_CLOSED &&
                after.body.isNotEmpty()
            ) {
                madeSignal.tryEmit(after.body)
            }
            step.effects
        }
        effects.forEach { run(it) }
    }

    private suspend fun run(effect: WordsEffect) {
        val enrolled = enrollment()
        val next: WordsInput = when (effect) {
            WordsEffect.Assess -> {
                val availability = runCatching { services.syncedSecrets.availability() }.getOrNull()
                WordsInput.Standing(
                    standing = enrolled?.standing() ?: Enrollment.Standing.NO_SEED,
                    custody = availability?.let { PhraseMachine.custodySentence(it) }.orEmpty(),
                    synchronizing = availability?.synchronizing == true,
                )
            }
            WordsEffect.Mint -> WordsInput.Minted(words = enrolled?.mint())
            // NULL IS "KEPT", so no enrollment at all is its own refusal
            // rather than an elvis that would read a success as one.
            is WordsEffect.Keep -> WordsInput.Kept(
                if (enrolled == null) Enrollment.Refusal.STORE_REFUSED else enrolled.keep(effect.words, effect.sync, effect.shown),
            )
            is WordsEffect.KeepOwn -> when (val kept = enrolled?.keepOwn(effect.words, effect.name)) {
                null -> WordsInput.Kept(Enrollment.Refusal.STORE_REFUSED)
                is Enrollment.OwnKept.Kept -> WordsInput.Kept(null, kept.id)
                is Enrollment.OwnKept.Refused -> WordsInput.Kept(kept.because)
            }
            is WordsEffect.Make -> WordsInput.Made(enrolled?.make(effect.own, effect.name) ?: FoundResult.NoSession)
            is WordsEffect.DropOwn -> {
                enrolled?.dropOwn(effect.id)
                return
            }
        }
        reduce(next)
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
        scope.launch { flow.made.collect { onMade?.invoke(it) } }
    }

    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        onState(flow.state.value.encode())
    }

    /** The state now (Compose collects [states]). */
    public val screen: VaultWordsState get() = flow.state.value

    public val states: StateFlow<VaultWordsState> get() = flow.state

    /** A vault was made: its sentence, once per make ([VaultWordsFlow.made]). */
    public val made: SharedFlow<String> get() = flow.made

    private var onMade: ((String) -> Unit)? = null

    /** Swift's door to [made]: called on the main thread, once per make. */
    public fun observeMade(onMade: (String) -> Unit) {
        this.onMade = onMade
    }

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
