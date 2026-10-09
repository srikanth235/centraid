package dev.centraid.shared.custody

import centraid.screen.v1.PairLaptopEvent
import centraid.screen.v1.PairLaptopState
import dev.centraid.design.copy.WordsCopy
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.sync.CorePairDoor
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
 * PAIR THIS PHONE'S VAULT WITH ONE OF THE MEMBER'S GATEWAYS (#1080; #1047 E4)
 * — as a pure machine.
 *
 * `pair.laptop`. The gateway prints a pairing payload (`centraid-gateway
 * pair`): a square to scan and the same text to paste, carrying its addresses,
 * its certificate's fingerprint and a one-use secret. The core connects with
 * that pin, pairs, and keeps the gateway as one more backup destination; the
 * screen shows the gateway's label and address and the pairing's safety
 * number — 60 digits in 12 groups of 5, the digits the gateway prints when the
 * pairing lands — and the comparison is the member's (seam contract A7). A
 * second gateway pairs the same way.
 *
 * **Only a KEYED vault can pair.** A pairing is signed for by the vault's
 * identity key, which only a core opened with the seed and the vault's index
 * holds; an unkeyed vault is sent to its words first
 * ([PairLaptopState.Phase.PHASE_NEEDS_WORDS], with `words_label` — the intent
 * `WordsTapped` the shell routes to words.enter's re-key) rather than refused
 * by a core error a member cannot act on.
 */
public object PairLaptopMachine {
    public fun initial(): Pairing = render(Pairing())

    public fun reduce(model: Pairing, input: PairInput): PairStep {
        if (model.phase == PairLaptopState.Phase.PHASE_CLOSED &&
            !(input is PairInput.View && input.event.opened != null)
        ) {
            return PairStep(model)
        }
        return when (input) {
            is PairInput.View -> view(model, input.event)
            is PairInput.Readiness -> ready(model, input.readiness)
            is PairInput.Answered -> answered(model, input.result)
        }
    }

    private fun view(model: Pairing, event: PairLaptopEvent): PairStep {
        val waiting = model.phase == PairLaptopState.Phase.PHASE_WAITING ||
            model.phase == PairLaptopState.Phase.PHASE_FAILED
        return when {
            event.opened != null -> PairStep(
                render(Pairing(phase = PairLaptopState.Phase.PHASE_UNSPECIFIED, camera = event.opened.camera)),
                listOf(PairEffect.Assess),
            )
            event.dismissed != null -> PairStep(closed())
            event.typed != null && waiting ->
                PairStep(render(model.copy(phase = PairLaptopState.Phase.PHASE_WAITING, payload = event.typed.text, notice = "")))
            // A SCAN IS A DELIBERATE ACT: it pairs at once.
            event.scanned != null && waiting -> pair(model.copy(payload = event.scanned.payload))
            event.primary != null -> when (model.phase) {
                PairLaptopState.Phase.PHASE_WAITING, PairLaptopState.Phase.PHASE_FAILED -> pair(model)
                PairLaptopState.Phase.PHASE_PAIRED,
                PairLaptopState.Phase.PHASE_NEEDS_WORDS,
                -> PairStep(closed())
                else -> PairStep(model)
            }
            event.secondary != null && model.phase != PairLaptopState.Phase.PHASE_PAIRING -> PairStep(closed())
            // `WordsTapped` IS AN INTENT: the shell opens words.enter for a
            // re-key in this screen's place, so the pairing closes. It is
            // heard only where the door was drawn.
            event.words != null && model.phase == PairLaptopState.Phase.PHASE_NEEDS_WORDS && model.rekey ->
                PairStep(closed())
            // `scan` IS AN INTENT: the shell opens its camera.
            else -> PairStep(model)
        }
    }

    /**
     * THE TEXT, AS THE CORE WILL READ IT. Trimmed, and the laptop's own `pair`
     * label dropped when the member pasted the whole printed line — that label
     * is the terminal's, not the ticket's. Nothing else: the ticket's shape is
     * the core's to judge (`centraid_identity::ticket::decode`), and a second
     * parser here would disagree with it the day either changed.
     */
    internal fun ticketOf(payload: String): String {
        val trimmed = payload.trim()
        val label = "pair"
        return if (trimmed.startsWith(label) && trimmed.length > label.length && trimmed[label.length].isWhitespace()) {
            trimmed.substring(label.length).trim()
        } else {
            trimmed
        }
    }

    private fun pair(model: Pairing): PairStep {
        val ticket = ticketOf(model.payload)
        if (ticket.isEmpty()) {
            return PairStep(render(model.copy(phase = PairLaptopState.Phase.PHASE_WAITING, notice = CustodyCopy.PAIR_EMPTY)))
        }
        return PairStep(
            render(model.copy(phase = PairLaptopState.Phase.PHASE_PAIRING, notice = "")),
            listOf(PairEffect.Pair(ticket)),
        )
    }

    private fun ready(model: Pairing, readiness: Readiness): PairStep {
        if (model.phase != PairLaptopState.Phase.PHASE_UNSPECIFIED) return PairStep(model)
        return PairStep(
            render(
                when (readiness) {
                    Readiness.READY -> model.copy(phase = PairLaptopState.Phase.PHASE_WAITING)
                    Readiness.NEEDS_WORDS ->
                        model.copy(phase = PairLaptopState.Phase.PHASE_NEEDS_WORDS, notice = CustodyCopy.PAIR_NEEDS_WORDS, rekey = true)
                    Readiness.NO_VAULT -> model.copy(phase = PairLaptopState.Phase.PHASE_NEEDS_WORDS, notice = CustodyCopy.PAIR_NO_VAULT)
                    // A SAMPLE VAULT NEVER PAIRS (the core refuses it), so the
                    // screen closes on a sentence rather than taking a code.
                    Readiness.SAMPLE -> model.copy(phase = PairLaptopState.Phase.PHASE_NEEDS_WORDS, notice = CustodyCopy.PAIR_SAMPLE)
                },
            ),
        )
    }

    private fun answered(model: Pairing, result: PairResult): PairStep {
        if (model.phase != PairLaptopState.Phase.PHASE_PAIRING) return PairStep(model)
        val failed = model.copy(phase = PairLaptopState.Phase.PHASE_FAILED)
        return PairStep(
            render(
                when (result) {
                    // EACH REFUSAL ITS OWN SENTENCE (#1047 E5): a code the laptop
                    // did not take wants a new code, not a laptop woken up.
                    is PairResult.Refused -> failed.copy(
                        notice = when (result.because) {
                            PairRefusal.UNREACHABLE -> CustodyCopy.PAIR_UNREACHABLE
                            PairRefusal.NOT_A_CODE -> WordsCopy.PAIR_NOT_A_CODE
                            PairRefusal.NOT_TAKEN -> WordsCopy.PAIR_NOT_TAKEN
                            PairRefusal.MOVED -> WordsCopy.PAIR_MOVED
                        },
                    )
                    // A PAIRING WITH NOTHING TO COMPARE IS NOT ONE A MEMBER CAN
                    // CHECK, so it is refused rather than shown: the core
                    // answers an empty safety number when it could not make one.
                    is PairResult.Paired -> if (result.answer.safetyNumber.isBlank()) {
                        failed.copy(notice = CustodyCopy.PAIR_NOTHING_TO_COMPARE)
                    } else {
                        model.copy(phase = PairLaptopState.Phase.PHASE_PAIRED, payload = "", answer = result.answer, notice = "")
                    }
                },
            ),
        )
    }

    private fun closed(): Pairing = render(Pairing(phase = PairLaptopState.Phase.PHASE_CLOSED))

    internal fun render(model: Pairing): Pairing {
        val phase = model.phase
        val answer = model.answer
        val title = when (phase) {
            PairLaptopState.Phase.PHASE_PAIRED -> CustodyCopy.PAIRED_TITLE
            PairLaptopState.Phase.PHASE_FAILED -> CustodyCopy.PAIR_FAILED_TITLE
            // "Your words come first" only where words ARE the way out (the
            // re-key door below); no vault, or the sample in front, keeps the
            // screen's own title over its one sentence.
            PairLaptopState.Phase.PHASE_NEEDS_WORDS ->
                if (model.rekey) CustodyCopy.PAIR_NEEDS_WORDS_TITLE else CustodyCopy.PAIR_TITLE
            PairLaptopState.Phase.PHASE_CLOSED -> ""
            else -> CustodyCopy.PAIR_TITLE
        }
        val body = when (phase) {
            PairLaptopState.Phase.PHASE_WAITING,
            PairLaptopState.Phase.PHASE_FAILED,
            PairLaptopState.Phase.PHASE_PAIRING,
            -> CustodyCopy.PAIR_ASK
            PairLaptopState.Phase.PHASE_PAIRED -> if (answer == null) "" else CustodyCopy.pairedLine(answer)
            else -> ""
        }
        val entering = phase == PairLaptopState.Phase.PHASE_WAITING || phase == PairLaptopState.Phase.PHASE_FAILED
        val primary = when (phase) {
            PairLaptopState.Phase.PHASE_WAITING -> CustodyCopy.PAIR_PRIMARY
            PairLaptopState.Phase.PHASE_FAILED -> CustodyCopy.TRY_AGAIN
            PairLaptopState.Phase.PHASE_PAIRED, PairLaptopState.Phase.PHASE_NEEDS_WORDS -> CustodyCopy.DONE
            else -> ""
        }
        return model.copy(
            state = PairLaptopState(
                phase = phase,
                title = title,
                body = body,
                payload = if (entering) model.payload else "",
                payload_label = if (entering) CustodyCopy.PAIR_PASTE_LABEL else "",
                // NO CAMERA, NO SCAN CONTROL: the shell said so on Opened.
                scan_label = if (entering && model.camera) CustodyCopy.PAIR_SCAN else "",
                safety_number = if (phase == PairLaptopState.Phase.PHASE_PAIRED && answer != null) {
                    answer.safetyNumber
                } else {
                    ""
                },
                // THE WAY OUT OF NEEDS_WORDS, as Locker's wall has it: a vault
                // that opened without its words gets them back through re-key.
                // A phone with no vault has no words to enter, so no door.
                words_label = if (phase == PairLaptopState.Phase.PHASE_NEEDS_WORDS && model.rekey) {
                    WordsCopy.PAIR_WORDS_ACTION
                } else {
                    ""
                },
                notice = model.notice,
                primary_label = primary,
                primary_enabled = when {
                    entering -> ticketOf(model.payload).isNotEmpty()
                    else -> primary.isNotEmpty()
                },
                secondary_label = if (entering) CustodyCopy.CANCEL else "",
                progress = if (phase == PairLaptopState.Phase.PHASE_PAIRING) CustodyCopy.PAIRING else "",
                accessibility_label = listOf(title, model.notice).filter { it.isNotEmpty() }.joinToString(". "),
            ),
        )
    }
}

/** Whether the foreground vault can pair. */
public enum class Readiness {
    READY,
    NEEDS_WORDS,
    NO_VAULT,

    /** The vault in front is the sample vault, which never pairs. */
    SAMPLE,
}

/** The machine's model. The pairing code's secret is spent on first use, and the code is still never printed. */
public data class Pairing(
    public val phase: PairLaptopState.Phase = PairLaptopState.Phase.PHASE_UNSPECIFIED,
    public val state: PairLaptopState = PairLaptopState(),
    internal val payload: String = "",
    public val answer: PairAnswer? = null,
    public val notice: String = "",
    /** Whether the shell can scan (`Opened.camera`). */
    public val camera: Boolean = false,
    /** NEEDS_WORDS because the vault opened without its words, so re-key is the way on. */
    public val rekey: Boolean = false,
) {
    override fun toString(): String = "Pairing(phase=$phase, <redacted>)"
}

public sealed interface PairInput {
    public data class View(public val event: PairLaptopEvent) : PairInput {
        override fun toString(): String = "View(<redacted>)"
    }

    public data class Readiness(public val readiness: dev.centraid.shared.custody.Readiness) : PairInput

    /** The core's answer, or which refusal it was. */
    public data class Answered(public val result: PairResult) : PairInput
}

public sealed interface PairEffect {
    /** Is there a foreground vault, and is it keyed? */
    public data object Assess : PairEffect

    public class Pair(internal val ticket: String) : PairEffect {
        override fun toString(): String = "Pair(<redacted>)"
    }
}

public data class PairStep(public val model: Pairing, public val effects: List<PairEffect> = emptyList())

/**
 * THE MACHINE, RUNNING: [readiness] answers Assess; [door] pairs; [after]
 * runs once a pair answered with something to compare — the session re-reads
 * the backup status, so the new destination is on the backup line at once.
 */
public class PairLaptopFlow(
    private val readiness: suspend () -> Readiness,
    private val door: () -> PairDoor?,
    private val after: suspend () -> Unit,
    private val scope: CoroutineScope,
) {
    private val model = MutableStateFlow(PairLaptopMachine.initial())
    private val lock = Mutex()
    private val published = MutableStateFlow(model.value.state)

    public val state: StateFlow<PairLaptopState> get() = published.asStateFlow()

    /** The model, for specs. */
    public val current: Pairing get() = model.value

    public fun send(event: PairLaptopEvent) {
        scope.launch { reduce(PairInput.View(event)) }
    }

    public suspend fun reduce(input: PairInput) {
        val effects = lock.withLock {
            val step = PairLaptopMachine.reduce(model.value, input)
            model.value = step.model
            published.value = step.model.state
            step.effects
        }
        effects.forEach { run(it) }
    }

    private suspend fun run(effect: PairEffect) {
        val next: PairInput = when (effect) {
            PairEffect.Assess -> PairInput.Readiness(readiness())
            is PairEffect.Pair -> {
                val result = door()?.pair(effect.ticket) ?: PairResult.Refused(PairRefusal.UNREACHABLE)
                if (result is PairResult.Paired && result.answer.safetyNumber.isNotBlank()) runCatching { after() }
                PairInput.Answered(result)
            }
        }
        reduce(next)
    }
}

/**
 * `pair.laptop`'s BRIDGE — Swift holds bytes, Compose the `StateFlow`.
 *
 * A shell presents it from the More sheet's pairing row and:
 *
 * 1. calls [attach] with the session, then [open] with whether the phone has
 *    a camera (without one `scan_label` is empty and the screen is paste-only);
 * 2. draws every state: `payload` in a paste field (`PayloadTyped` on every
 *    change), `scan_label` as a camera control (`ScanTapped` is an intent;
 *    the shell's camera sends `Scanned` with what it read), `safety_number`
 *    in a monospaced face in its groups, `progress` with a spinner, and
 *    `words_label` as a control;
 * 3. forwards `Primary`, `Secondary`, `Dismissed` and `WordsTapped` — the last
 *    an intent: the shell opens words.enter's `openRekey()` in this screen's
 *    place (the machine closes);
 * 4. closes when the phase is `PHASE_CLOSED`.
 */
public class PairLaptopBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: HomeSession? = null
    private val flow by lazy {
        PairLaptopFlow(
            readiness = {
                val holding = session?.shelf?.foregroundHolding()
                when {
                    holding == null -> Readiness.NO_VAULT
                    holding.sample -> Readiness.SAMPLE
                    holding.keyed -> Readiness.READY
                    else -> Readiness.NEEDS_WORDS
                }
            },
            door = {
                val open = session
                if (open?.shelf?.foregroundHolding() == null) null else CorePairDoor({ open.shelf.core() })
            },
            after = { session?.backupStatus?.refreshForeground() },
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

    public val screen: PairLaptopState get() = flow.state.value

    public val states: StateFlow<PairLaptopState> get() = flow.state

    /** [camera]: whether this phone has a camera to scan the square with. */
    public fun open(camera: Boolean) {
        forward(PairLaptopEvent(opened = PairLaptopEvent.Opened(camera = camera)))
    }

    public fun send(event: ByteArray) {
        forward(PairLaptopEvent.ADAPTER.decode(event))
    }

    public fun forward(event: PairLaptopEvent) {
        flow.send(event)
    }

    public fun current(): ByteArray = flow.state.value.encode()
}
