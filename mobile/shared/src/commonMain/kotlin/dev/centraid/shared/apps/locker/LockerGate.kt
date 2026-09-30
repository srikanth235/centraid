package dev.centraid.shared.apps.locker

import centraid.screen.v1.HomeEvent
import centraid.screen.v1.LockerBiometry
import centraid.screen.v1.LockerFact
import centraid.screen.v1.LockerLockEvent
import centraid.screen.v1.LockerLockState
import centraid.screen.v1.LockerPrompt
import dev.centraid.design.copy.LockerCopy
import dev.centraid.shared.shell.HomeReads
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
 * THE LOCK, AS A PURE MACHINE (#1047, D-5).
 *
 * D-5 rules the gesture — the phone's biometric, the device passcode as
 * fallback, a relock when Centraid leaves the foreground, no Locker
 * passphrase. This machine owns the lock's five phases and every word on the
 * wall; a shell performs only what a machine cannot: it raises the OS prompt
 * when [LockerLockState.prompt] carries a new token, reports the answer, and
 * reports the app leaving the foreground.
 *
 * **The OS saying yes is not the Locker opening.** A succeeded prompt moves to
 * UNLOCKING and asks the core to open its session ([GateEffect.Unlock]); only
 * the core's answer makes the phase UNLOCKED. So a core that could not load
 * `K` leaves the member at FAILED with its sentence, never at an open Locker
 * that then refuses every reveal.
 */
public object LockerLockMachine {
    public fun initial(): Gate = worded(Gate(state = LockerLockState()), LockerLockState.Phase.PHASE_LOCKED)

    /** One input, and what the runner must do about it. */
    public fun reduce(gate: Gate, input: GateInput): GateStep = when (input) {
        is GateInput.View -> view(gate, input.event)
        is GateInput.Core -> core(gate, input)
        is GateInput.Keys -> keys(gate, input.keyed)
        GateInput.Expired -> GateStep(lockedBy(gate, notice = LockerCopy.LOCK_EXPIRED))
    }

    private fun view(gate: Gate, event: LockerLockEvent): GateStep {
        val phase = gate.state.phase
        return when {
            event.attached != null -> attached(gate, event.attached)
            event.unlock != null -> when (phase) {
                LockerLockState.Phase.PHASE_LOCKED, LockerLockState.Phase.PHASE_FAILED ->
                    if (!gate.available || !gate.keyed) {
                        GateStep(to(gate, LockerLockState.Phase.PHASE_UNAVAILABLE))
                    } else {
                        val token = gate.tokens + 1
                        GateStep(to(gate.copy(tokens = token, asking = token), LockerLockState.Phase.PHASE_UNLOCKING))
                    }
                else -> GateStep(gate)
            }
            event.answered != null -> answered(gate, event.answered)
            // LEAVING THE FOREGROUND RELOCKS AT ONCE, and drops a prompt that
            // was up: an answer to it arrives for a token nobody is asking.
            event.backgrounded != null ->
                if (phase == LockerLockState.Phase.PHASE_UNAVAILABLE) {
                    GateStep(gate.copy(asking = 0L))
                } else {
                    GateStep(lockedBy(gate), listOf(GateEffect.Relock))
                }
            event.foregrounded != null ->
                if (phase == LockerLockState.Phase.PHASE_UNLOCKED) GateStep(gate, listOf(GateEffect.Check)) else GateStep(gate)
            // THE MEMBER LOCKED (the Lock row, or a vault switch): the wall
            // also asks the shell to take Locker's own copy off the clipboard.
            // A background relock does not — a copy is made to be pasted in
            // another app, and it expires by itself.
            event.lock != null -> GateStep(lockedBy(gate.copy(clears = gate.clears + 1)), listOf(GateEffect.Relock))
            // `words` IS AN INTENT the shell routes (words.enter, PURPOSE_REKEY);
            // the gate changes nothing until the shelf reopens the core keyed.
            else -> GateStep(gate)
        }
    }

    private fun attached(gate: Gate, attached: LockerLockEvent.Attached): GateStep {
        val next = gate.copy(available = attached.available, biometry = attached.biometry)
        return when {
            // A PHONE WITH NO PASSCODE HAS NO LOCK OF ITS OWN, so Locker has
            // nothing to stand on: unavailable, and anything open is closed.
            !attached.available -> GateStep(
                to(next.copy(asking = 0L), LockerLockState.Phase.PHASE_UNAVAILABLE),
                if (gate.state.phase == LockerLockState.Phase.PHASE_UNLOCKED) listOf(GateEffect.Relock) else emptyList(),
            )
            // NO WORDS ON THIS PHONE FOR THIS VAULT: a passcode does not help,
            // so the wall stays unavailable with the words' sentence.
            !next.keyed -> GateStep(to(next.copy(asking = 0L), LockerLockState.Phase.PHASE_UNAVAILABLE))
            gate.state.phase == LockerLockState.Phase.PHASE_UNAVAILABLE ->
                GateStep(to(next, LockerLockState.Phase.PHASE_LOCKED))
            // Re-read the core: idle may have ended a session this machine
            // still thinks is open, and a re-attached shell must not draw one.
            gate.state.phase == LockerLockState.Phase.PHASE_UNLOCKED ->
                GateStep(to(next, LockerLockState.Phase.PHASE_UNLOCKED), listOf(GateEffect.Check))
            else -> GateStep(to(next, gate.state.phase))
        }
    }

    private fun answered(gate: Gate, answered: LockerLockEvent.PromptAnswered): GateStep {
        // AN ANSWER TO A PROMPT NOBODY IS ASKING is a late one — the app went
        // to the background under it, or it was answered twice.
        if (answered.token == 0L || answered.token != gate.asking) return GateStep(gate)
        val asked = gate.copy(asking = 0L)
        return when (answered.outcome) {
            LockerLockEvent.PromptAnswered.Outcome.OUTCOME_SUCCEEDED ->
                GateStep(to(asked.copy(opening = true), LockerLockState.Phase.PHASE_UNLOCKING), listOf(GateEffect.Unlock))
            LockerLockEvent.PromptAnswered.Outcome.OUTCOME_CANCELLED ->
                GateStep(to(asked, LockerLockState.Phase.PHASE_LOCKED))
            LockerLockEvent.PromptAnswered.Outcome.OUTCOME_UNAVAILABLE ->
                GateStep(to(asked.copy(available = false), LockerLockState.Phase.PHASE_UNAVAILABLE))
            LockerLockEvent.PromptAnswered.Outcome.OUTCOME_LOCKED_OUT ->
                GateStep(to(asked.copy(notice = LockerCopy.LOCK_LOCKED_OUT), LockerLockState.Phase.PHASE_FAILED))
            else -> GateStep(to(asked.copy(notice = failedSentence(gate.biometry)), LockerLockState.Phase.PHASE_FAILED))
        }
    }

    private fun core(gate: Gate, answer: GateInput.Core): GateStep {
        val phase = gate.state.phase
        return when {
            // THE UNLOCK'S ANSWER: only the core opens the Locker.
            gate.opening -> when {
                answer.sentence != null ->
                    GateStep(to(gate.copy(opening = false, notice = answer.sentence), LockerLockState.Phase.PHASE_FAILED))
                answer.open -> GateStep(to(gate.copy(opening = false), LockerLockState.Phase.PHASE_UNLOCKED))
                else -> GateStep(to(gate.copy(opening = false, notice = LockerCopy.LOCK_DID_NOT_OPEN), LockerLockState.Phase.PHASE_FAILED))
            }
            // A CHECK THAT FOUND THE SESSION ENDED (idle, a vault switch).
            phase == LockerLockState.Phase.PHASE_UNLOCKED && !answer.open && answer.sentence == null ->
                GateStep(lockedBy(gate, notice = LockerCopy.LOCK_EXPIRED))
            else -> GateStep(gate)
        }
    }

    /**
     * WHETHER THE FOREGROUND CORE HOLDS THIS VAULT'S KEYS (#1047 W2, D-6).
     *
     * `K` is derived from the seed at open, so a core opened without it
     * refuses every unlock. Asking would raise Face ID only to fail with the
     * core's generic refusal; the wall says why instead, before any prompt.
     */
    private fun keys(gate: Gate, keyed: Boolean): GateStep {
        if (gate.keyed == keyed) return GateStep(gate)
        val next = gate.copy(keyed = keyed)
        return when {
            !keyed -> GateStep(
                to(next.copy(asking = 0L, opening = false), LockerLockState.Phase.PHASE_UNAVAILABLE),
                if (gate.open) listOf(GateEffect.Relock) else emptyList(),
            )
            gate.state.phase == LockerLockState.Phase.PHASE_UNAVAILABLE && next.available ->
                GateStep(to(next, LockerLockState.Phase.PHASE_LOCKED))
            else -> GateStep(to(next, gate.state.phase))
        }
    }

    private fun lockedBy(gate: Gate, notice: String = ""): Gate {
        if (gate.state.phase == LockerLockState.Phase.PHASE_UNAVAILABLE) return gate
        return to(gate.copy(asking = 0L, opening = false, notice = notice), LockerLockState.Phase.PHASE_LOCKED)
    }

    private fun to(gate: Gate, phase: LockerLockState.Phase): Gate {
        val kept = if (phase == LockerLockState.Phase.PHASE_FAILED || phase == LockerLockState.Phase.PHASE_LOCKED) gate.notice else ""
        return worded(gate.copy(notice = kept), phase)
    }

    /** Every word the wall says, for [phase] and this phone's biometry. */
    private fun worded(gate: Gate, phase: LockerLockState.Phase): Gate {
        val method = methodOf(gate.biometry)
        val prompt = gate.asking.takeIf { it != 0L }?.let {
            LockerPrompt(
                token = it,
                reason = LockerCopy.PROMPT_REASON,
                title = LockerCopy.PROMPT_TITLE,
                subtitle = LockerCopy.PROMPT_SUBTITLE,
            )
        }
        val unlockLabel = when (phase) {
            LockerLockState.Phase.PHASE_LOCKED -> "${LockerCopy.UNLOCK_WITH} $method"
            LockerLockState.Phase.PHASE_FAILED -> LockerCopy.UNLOCK_AGAIN
            else -> ""
        }
        val title = when (phase) {
            LockerLockState.Phase.PHASE_UNAVAILABLE ->
                if (gate.keyed) LockerCopy.LOCK_UNAVAILABLE_TITLE else LockerCopy.LOCK_NO_WORDS_TITLE
            LockerLockState.Phase.PHASE_UNLOCKING -> LockerCopy.LOCK_UNLOCKING_TITLE
            LockerLockState.Phase.PHASE_UNLOCKED -> LockerCopy.LOCK_OPEN_TITLE
            else -> LockerCopy.LOCK_TITLE
        }
        val body = when (phase) {
            LockerLockState.Phase.PHASE_UNAVAILABLE ->
                if (gate.keyed) LockerCopy.LOCK_UNAVAILABLE_BODY else LockerCopy.LOCK_NO_WORDS_BODY
            else -> "${LockerCopy.LOCK_BODY_LEAD} $method${LockerCopy.LOCK_BODY_TAIL}"
        }
        val notice = when (phase) {
            LockerLockState.Phase.PHASE_UNAVAILABLE ->
                if (gate.keyed) LockerCopy.LOCK_UNAVAILABLE_NOTICE else LockerCopy.LOCK_NO_WORDS_NOTICE
            else -> gate.notice
        }
        return gate.copy(
            state = LockerLockState(
                phase = phase,
                cover = phase != LockerLockState.Phase.PHASE_UNLOCKED,
                // THE CAPTURE SHIELD IS THE COVER'S COMPLEMENT: while a Locker
                // screen may show an item, the shell keeps it out of
                // screenshots, recordings and the app switcher; on a relock it
                // drops the shield with the page.
                secure = phase == LockerLockState.Phase.PHASE_UNLOCKED,
                clipboard_clear = gate.clears,
                title = title,
                body = body,
                unlock_label = unlockLabel,
                facts = FACTS,
                notice = notice,
                prompt = prompt,
                // THE WAY OUT OF THE NO-WORDS WALL (#1047 E1): an intent the
                // shell routes to words.enter for PURPOSE_REKEY. A passcode
                // wall has no such way out, so it is empty there.
                words_label = if (phase == LockerLockState.Phase.PHASE_UNAVAILABLE && !gate.keyed) {
                    LockerCopy.LOCK_NO_WORDS_ACTION
                } else {
                    ""
                },
                accessibility_label = listOf(title, notice).filter { it.isNotEmpty() }.joinToString(". "),
            ),
        )
    }

    /** "your face", "your fingerprint", "your passcode" — never a brand a platform owns. */
    internal fun methodOf(biometry: LockerBiometry): String = when (biometry) {
        LockerBiometry.LOCKER_BIOMETRY_FACE -> LockerCopy.METHOD_FACE
        LockerBiometry.LOCKER_BIOMETRY_FINGERPRINT, LockerBiometry.LOCKER_BIOMETRY_TOUCH -> LockerCopy.METHOD_FINGERPRINT
        LockerBiometry.LOCKER_BIOMETRY_OPTIC -> LockerCopy.METHOD_OPTIC
        else -> LockerCopy.METHOD_PASSCODE
    }

    private fun failedSentence(biometry: LockerBiometry): String = when (biometry) {
        LockerBiometry.LOCKER_BIOMETRY_PASSCODE, LockerBiometry.LOCKER_BIOMETRY_UNSPECIFIED -> LockerCopy.LOCK_FAILED_PASSCODE
        else -> LockerCopy.LOCK_FAILED
    }

    private val FACTS: List<LockerFact> = listOf(
        LockerFact(label = LockerCopy.FACT_SESSION, detail = LockerCopy.FACT_SESSION_DETAIL),
        LockerFact(label = LockerCopy.FACT_LEAVING, detail = LockerCopy.FACT_LEAVING_DETAIL),
        LockerFact(label = LockerCopy.FACT_REVEAL, detail = LockerCopy.FACT_REVEAL_DETAIL),
        LockerFact(label = LockerCopy.FACT_KEY, detail = LockerCopy.FACT_KEY_DETAIL),
    )
}

/** The gate's whole state: what a view draws, and what it never sees. */
public data class Gate(
    public val state: LockerLockState,
    /** A passcode is set on this phone. Assumed until the shell says otherwise. */
    public val available: Boolean = true,
    /**
     * The foreground core was opened with the seed and this vault's index, so
     * it holds `K` (#1047 W2). Assumed until the runner says otherwise.
     */
    public val keyed: Boolean = true,
    public val biometry: LockerBiometry = LockerBiometry.LOCKER_BIOMETRY_UNSPECIFIED,
    /** The last prompt token minted. */
    public val tokens: Long = 0L,
    /** The token of the prompt being asked, or 0. */
    public val asking: Long = 0L,
    /** The core is opening the session. */
    public val opening: Boolean = false,
    /** How many times the member locked: the wall's `clipboard_clear`. */
    public val clears: Long = 0L,
    public val notice: String = "",
) {
    public val open: Boolean get() = state.phase == LockerLockState.Phase.PHASE_UNLOCKED
}

/** What reaches the gate: a view's event, the core's answer, or a screen's "the session ended". */
public sealed interface GateInput {
    public data class View(public val event: LockerLockEvent) : GateInput

    /** The session is [open]; [sentence] is set when the core could not be asked. */
    public data class Core(public val open: Boolean, public val sentence: String? = null) : GateInput

    /** A reveal answered LOCKED: idle ended the session under a screen. */
    public data object Expired : GateInput

    /** Whether the foreground core is KEYED; see [Gate.keyed]. The runner's, before every view event. */
    public data class Keys(public val keyed: Boolean) : GateInput
}

/** What the runner must ask the core. */
public sealed interface GateEffect {
    public data object Unlock : GateEffect

    public data object Relock : GateEffect

    public data object Check : GateEffect
}

public data class GateStep(public val gate: Gate, public val effects: List<GateEffect> = emptyList())

/**
 * THE GATE, RUNNING: [LockerLockMachine] over a [LockerDoor], one reduction at
 * a time, published as [state] and [open].
 *
 * **One gate per process.** Centraid has one foreground vault and one app
 * lifecycle, and the lock is about the member's presence at this phone, not
 * about a screen — so every Locker screen and the Home tile read the same
 * gate ([shared]). A vault switch binds the gate to the new session and
 * relocks: a session on one vault never opens another's secrets.
 */
public class LockerGate(
    private val door: LockerDoor,
    private val scope: CoroutineScope,
    /** Whether the foreground core is keyed, read fresh before every view event. */
    private val keyed: () -> Boolean = { true },
) {
    private val gate = MutableStateFlow(LockerLockMachine.initial())
    private val lock = Mutex()

    /** What the wall draws. */
    public val state: StateFlow<LockerLockState> get() = lockState

    private val lockState = MutableStateFlow(gate.value.state)

    /** The Locker is open: its screens may read. */
    public val open: StateFlow<Boolean> get() = isOpen.asStateFlow()

    private val isOpen = MutableStateFlow(false)

    /** Every phase change, for a listener that must redraw (Home's tile). */
    internal var changed: (Boolean) -> Unit = {}

    /** The door, for a screen's reveal. */
    public val doorway: LockerDoor get() = door

    public fun send(event: LockerLockEvent) {
        input(GateInput.View(event))
    }

    /** A screen's reveal answered LOCKED. */
    public fun expired() {
        input(GateInput.Expired)
    }

    internal fun input(input: GateInput) {
        scope.launch { reduce(input) }
    }

    /** Reduce now, and run what it asks. Suspends until the effects have answered. */
    public suspend fun reduce(input: GateInput) {
        val effects = lock.withLock {
            // KEYED IS RE-READ BEFORE EVERY VIEW EVENT, not pushed on a switch:
            // entering Locker sends `Attached`, so the wall is right for
            // whichever vault is in front at the moment the member looks.
            val pre = if (input is GateInput.View) {
                LockerLockMachine.reduce(gate.value, GateInput.Keys(keyed()))
            } else {
                GateStep(gate.value)
            }
            val step = LockerLockMachine.reduce(pre.gate, input)
            publish(step.gate)
            pre.effects + step.effects
        }
        effects.forEach { run(it) }
    }

    private fun publish(next: Gate) {
        val wasOpen = gate.value.open
        gate.value = next
        lockState.value = next.state
        isOpen.value = next.open
        if (wasOpen != next.open) changed(next.open)
    }

    private suspend fun run(effect: GateEffect) {
        val answer = when (effect) {
            GateEffect.Unlock -> door.unlock()
            GateEffect.Relock -> door.relock()
            GateEffect.Check -> door.state()
        }
        if (effect == GateEffect.Relock) return
        reduce(
            when (answer) {
                is LockerDoorAnswer.Session -> GateInput.Core(open = answer.open)
                is LockerDoorAnswer.Unreachable -> GateInput.Core(open = false, sentence = answer.sentence)
            },
        )
    }

    public companion object {
        private var bound: HomeSession? = null

        /**
         * THE PROCESS'S GATE, over whichever session is bound. Swift and
         * Compose construct bridges with no arguments, so the gate they share
         * has to be reachable without one.
         */
        public val shared: LockerGate by lazy {
            LockerGate(
                CoreLockerDoor { bound?.shelf?.core() },
                CoroutineScope(SupervisorJob() + Dispatchers.Default),
                keyed = { bound?.shelf?.foregroundHolding()?.keyed ?: true },
            ).also { gate ->
                // THE HOME TILE SAYS WHETHER LOCKER IS OPEN, and nothing else
                // of it: the shell asks through a slot it owns, and a change
                // redraws Home.
                HomeReads.lockerOpen = { gate.open.value }
                gate.changed = { bound?.send(HomeEvent(refreshed = HomeEvent.Refreshed())) }
            }
        }

        /** Bind [shared] to [session]. A different session relocks first. */
        public fun bind(session: HomeSession) {
            if (bound === session) return
            val previous = bound
            bound = session
            if (previous != null) shared.send(LockerLockEvent(lock = LockerLockEvent.LockTapped()))
        }
    }
}

/**
 * THE LOCK WALL'S BRIDGE (#1047, D-5) — and the platform seam.
 *
 * A shell holds one for the app's lifetime and does four things with it:
 *
 * 1. **On entering Locker and on every return to the foreground**, reads its
 *    capability and sends `Attached(available, biometry)` — iOS
 *    `LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error:)` and
 *    `biometryType`; Android `BiometricManager.canAuthenticate(BIOMETRIC_STRONG
 *    or DEVICE_CREDENTIAL) == BIOMETRIC_SUCCESS` and the device's biometric.
 * 2. **When a state carries a `prompt` with a token it has not raised**, raises
 *    the OS prompt with its words — iOS `evaluatePolicy(.deviceOwnerAuthentication,
 *    localizedReason: prompt.reason)`; Android `BiometricPrompt` with
 *    `setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)`,
 *    `prompt.title` and `prompt.subtitle` — and answers `PromptAnswered(token,
 *    outcome)`.
 * 3. **On leaving the foreground** sends `Backgrounded` (iOS `.background`,
 *    Android `ON_STOP` — not `.inactive`/`ON_PAUSE`, which the prompt itself
 *    causes), and `Foregrounded` on the way back.
 * 4. **While `cover` is set**, draws this wall over every Locker screen.
 * 5. **While `secure` is set** (exactly UNLOCKED), shields every Locker page
 *    and dialog from capture — Android `FLAG_SECURE`, iOS the words screens'
 *    `WordsShield` — and drops it on relock and on leaving Locker.
 *
 * Nothing else: the phases, the words and the core's session are the
 * machine's.
 */
public class LockerLockBridge(private val gate: LockerGate = LockerGate.shared) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var onState: ((ByteArray) -> Unit)? = null

    /** Bind the process's gate to [session] and start publishing. */
    public fun attach(session: HomeSession) {
        LockerGate.bind(session)
        scope.launch { gate.state.collect { onState?.invoke(it.encode()) } }
    }

    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        onState(gate.state.value.encode())
    }

    /** The wall's state now (Compose). */
    public val lock: LockerLockState get() = gate.state.value

    public fun send(event: ByteArray) {
        forward(LockerLockEvent.ADAPTER.decode(event))
    }

    public fun forward(event: LockerLockEvent) {
        gate.send(event)
    }

    public fun current(): ByteArray = gate.state.value.encode()

    /** Swift's `scenePhase` hook, spelled as a call. */
    public fun backgrounded() {
        forward(LockerLockEvent(backgrounded = LockerLockEvent.Backgrounded()))
    }

    public fun foregrounded() {
        forward(LockerLockEvent(foregrounded = LockerLockEvent.Foregrounded()))
    }
}
