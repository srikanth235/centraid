package dev.centraid.shared.custody

import centraid.screen.v1.WordCell
import centraid.screen.v1.WordsShowEvent
import centraid.screen.v1.WordsShowState
import dev.centraid.design.copy.WordsCopy
import dev.centraid.shared.platform.platformServices
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
 * SHOW THE 24 WORDS AGAIN, FROM SETTINGS (#1047 E4, Q-1047-19) — as a pure
 * machine.
 *
 * `words.show`. The words are kept in this phone's device-only store beside
 * the seed ([VaultSecrets.rememberWords]); this screen reads them only after
 * the phone's own owner check passed — the view's to run, the posture Locker's
 * unlock has (Q-1047-12) — and holds them only while PHASE_SHOW is up.
 * Dismissing, leaving the foreground or tapping Done drops them. A phone whose
 * seed arrived through the synchronised keychain has no words, and says so
 * rather than showing an empty grid.
 */
public object WordsShowMachine {
    public fun initial(): Shown = render(Shown())

    public fun reduce(model: Shown, input: ShowInput): ShowStep {
        if (model.phase == WordsShowState.Phase.PHASE_CLOSED &&
            !(input is ShowInput.View && input.event.opened != null)
        ) {
            return ShowStep(model)
        }
        return when (input) {
            is ShowInput.View -> view(model, input.event)
            is ShowInput.Loaded -> loaded(model, input)
        }
    }

    private fun view(model: Shown, event: WordsShowEvent): ShowStep {
        val asking = model.phase == WordsShowState.Phase.PHASE_ASK
        return when {
            event.opened != null -> ShowStep(render(Shown(phase = WordsShowState.Phase.PHASE_ASK)))
            event.dismissed != null -> ShowStep(closed())
            // THE WORDS ARE READ ONLY AFTER THE PHONE SAID IT IS ITS OWNER.
            event.verified != null && asking ->
                ShowStep(render(model.copy(phase = WordsShowState.Phase.PHASE_LOADING, notice = "")), listOf(ShowEffect.Load))
            event.verify_failed != null && asking -> ShowStep(render(model.copy(notice = WordsCopy.SHOW_AGAIN_VERIFY_FAILED)))
            // ASK's primary is the view's intent (it runs the owner check).
            event.primary != null && !asking && model.phase != WordsShowState.Phase.PHASE_LOADING -> ShowStep(closed())
            event.secondary != null -> ShowStep(closed())
            else -> ShowStep(model)
        }
    }

    private fun loaded(model: Shown, input: ShowInput.Loaded): ShowStep {
        if (model.phase != WordsShowState.Phase.PHASE_LOADING) return ShowStep(model)
        val words = input.words
        return if (words != null && words.size == VaultSecrets.WORDS) {
            ShowStep(render(model.copy(phase = WordsShowState.Phase.PHASE_SHOW, words = words)))
        } else {
            ShowStep(render(model.copy(phase = WordsShowState.Phase.PHASE_NONE_HERE, seedHeld = input.seedHeld)))
        }
    }

    private fun closed(): Shown = render(Shown(phase = WordsShowState.Phase.PHASE_CLOSED))

    internal fun render(model: Shown): Shown {
        val phase = model.phase
        val show = phase == WordsShowState.Phase.PHASE_SHOW
        val title = when (phase) {
            WordsShowState.Phase.PHASE_NONE_HERE -> WordsCopy.SHOW_AGAIN_NONE_TITLE
            WordsShowState.Phase.PHASE_CLOSED -> ""
            else -> WordsCopy.SHOW_AGAIN_TITLE
        }
        val body = when (phase) {
            WordsShowState.Phase.PHASE_ASK -> WordsCopy.SHOW_AGAIN_ASK_BODY
            WordsShowState.Phase.PHASE_SHOW -> WordsCopy.SHOW_AGAIN_BODY
            WordsShowState.Phase.PHASE_NONE_HERE ->
                if (model.seedHeld) WordsCopy.SHOW_AGAIN_NONE_SYNCED else WordsCopy.SHOW_AGAIN_NONE
            else -> ""
        }
        val primary = when (phase) {
            WordsShowState.Phase.PHASE_ASK -> WordsCopy.SHOW_AGAIN_PRIMARY
            WordsShowState.Phase.PHASE_SHOW, WordsShowState.Phase.PHASE_NONE_HERE -> WordsCopy.DONE
            else -> ""
        }
        return model.copy(
            state = WordsShowState(
                phase = phase,
                secure = show,
                title = title,
                body = body,
                words = if (show) {
                    model.words.mapIndexed { at, word ->
                        WordCell(
                            position = at + 1,
                            word = word,
                            accessibility_label = WordsCopy.WORD_SPOKEN.replace("{n}", "${at + 1}").replace("{word}", word),
                        )
                    }
                } else {
                    emptyList()
                },
                primary_label = primary,
                secondary_label = if (phase == WordsShowState.Phase.PHASE_ASK) WordsCopy.CANCEL else "",
                notice = model.notice,
                accessibility_label = if (show) {
                    WordsCopy.SHOW_A11Y
                } else {
                    listOf(title, model.notice).filter { it.isNotEmpty() }.joinToString(". ")
                },
                verify_reason = if (phase == WordsShowState.Phase.PHASE_ASK) WordsCopy.SHOW_AGAIN_REASON else "",
            ),
        )
    }
}

/** The model. **Redacted**: [words] are the member's words. */
public data class Shown(
    public val phase: WordsShowState.Phase = WordsShowState.Phase.PHASE_CLOSED,
    public val state: WordsShowState = WordsShowState(),
    internal val words: List<String> = emptyList(),
    /** NONE_HERE: a seed is held (it came by sync), so the sentence says where the words are. */
    public val seedHeld: Boolean = false,
    public val notice: String = "",
) {
    /** Whether the words are held right now. For the specs; never the words. */
    public val holdsWords: Boolean get() = words.isNotEmpty()

    override fun toString(): String = "Shown(phase=$phase, <redacted>)"
}

public sealed interface ShowInput {
    public data class View(public val event: WordsShowEvent) : ShowInput {
        override fun toString(): String = "View(<redacted>)"
    }

    /** What the store holds: the words or null, and whether a seed is held. */
    public class Loaded(public val words: List<String>?, public val seedHeld: Boolean) : ShowInput {
        override fun toString(): String = "Loaded(<redacted>)"
    }
}

public sealed interface ShowEffect {
    public data object Load : ShowEffect
}

public data class ShowStep(public val model: Shown, public val effects: List<ShowEffect> = emptyList())

/** THE MACHINE, RUNNING over [VaultSecrets]. */
public class WordsShowFlow(
    private val secrets: () -> VaultSecrets,
    private val scope: CoroutineScope,
) {
    private val model = MutableStateFlow(WordsShowMachine.initial())
    private val lock = Mutex()
    private val published = MutableStateFlow(model.value.state)

    public val state: StateFlow<WordsShowState> get() = published.asStateFlow()

    /** The model, for specs. */
    public val current: Shown get() = model.value

    public fun send(event: WordsShowEvent) {
        scope.launch { reduce(ShowInput.View(event)) }
    }

    public suspend fun reduce(input: ShowInput) {
        val effects = lock.withLock {
            val step = WordsShowMachine.reduce(model.value, input)
            model.value = step.model
            published.value = step.model.state
            step.effects
        }
        effects.forEach { run(it) }
    }

    private suspend fun run(effect: ShowEffect) {
        val next: ShowInput = when (effect) {
            ShowEffect.Load -> {
                val store = secrets()
                ShowInput.Loaded(
                    words = runCatching { store.words() }.getOrNull(),
                    seedHeld = runCatching { store.seed() != null }.getOrDefault(false),
                )
            }
        }
        reduce(next)
    }
}

/**
 * `words.show`'s BRIDGE — Swift holds bytes, Compose the `StateFlow`.
 *
 * A shell presents it from the More sheet's "Show my 24 words" row
 * (`WordsCopy.SHOW_AGAIN_ROW`) and:
 *
 * 1. calls [open];
 * 2. in PHASE_ASK, on the primary control, runs the owner check with
 *    `verify_reason` (iOS `LAContext` `.deviceOwnerAuthentication`, Android
 *    `BiometricPrompt` with `DEVICE_CREDENTIAL`) and forwards `Verified` or
 *    `VerifyFailed` — never `Primary` from ASK;
 * 3. while `secure` is set, keeps the three platform duties (`screen.proto`'s
 *    words section), and forwards `Dismissed` on swipe-away AND when the app
 *    leaves the foreground;
 * 4. closes when the phase is `PHASE_CLOSED`.
 */
public class WordsShowBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val flow by lazy {
        WordsShowFlow(
            secrets = { VaultSecrets(platformServices().secureStore, platformServices().syncedSecrets) },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
        )
    }
    private var onState: ((ByteArray) -> Unit)? = null
    private var collecting = false

    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        if (!collecting) {
            collecting = true
            scope.launch { flow.state.collect { this@WordsShowBridge.onState?.invoke(it.encode()) } }
        }
        onState(flow.state.value.encode())
    }

    public val screen: WordsShowState get() = flow.state.value

    public val states: StateFlow<WordsShowState> get() = flow.state

    public fun open() {
        forward(WordsShowEvent(opened = WordsShowEvent.Opened()))
    }

    public fun send(event: ByteArray) {
        forward(WordsShowEvent.ADAPTER.decode(event))
    }

    public fun forward(event: WordsShowEvent) {
        flow.send(event)
    }

    public fun current(): ByteArray = flow.state.value.encode()
}
