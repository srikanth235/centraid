package dev.centraid.shared.screen

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.withLock

/**
 * What holds a [ScreenMachine] while a screen is on the screen
 * (#1020, D-1020-E3).
 *
 * The reducer is pure; this is the one mutable thing per screen instance, and
 * it is deliberately tiny: a [StateFlow] of finished states for the view, and a
 * [SharedFlow] of effects for the shell's effect runner.
 *
 * **The view only ever receives a finished state** (#1020 Execution model).
 * SwiftUI and Compose render `state.value` and forward events; neither ever
 * sees an effect, a handle or a coroutine.
 *
 * `revision` is monotonic per instance so a renderer can drop a state it has
 * already surpassed rather than re-rendering out of order — the field
 * `centraid.screen.v1.ScreenState` carries for the same reason.
 */
public class ScreenHost<S, E>(public val machine: ScreenMachine<S, E>) {
    private val _state = MutableStateFlow(machine.initial())
    private val _effects = MutableSharedFlow<ScreenEffect>(
        replay = 0,
        extraBufferCapacity = EFFECT_BUFFER,
    )
    private var _revision: ULong = 0uL

    /**
     * ONE REDUCE AT A TIME (#1020, wave A).
     *
     * `send` is read-modify-write over `_state` and `_revision`, and Home fans
     * out ONE READ PER APP: seven answers land independently, on whatever
     * threads the core's dispatcher gave them. Without this lock two of them
     * read the same state, reduced their own event onto it, and the second
     * write threw the first away — so a tile that had arrived went back to
     * `LOADING` and stayed there.
     *
     * It was invisible on a single-threaded dispatcher and appeared the moment
     * a real core answered from a pool: Docs, People and Tally sat loading on a
     * simulator while Notes, Agenda and Tasks drew their rows, every run.
     *
     * A `Mutex` and not a single-threaded dispatcher, because which dispatcher
     * a shell owns is the shell's decision — the same reason `start_endpoint`
     * is handed a runtime rather than making one.
     */
    private val reducing = kotlinx.coroutines.sync.Mutex()

    public val state: StateFlow<S> = _state.asStateFlow()

    public val effects: SharedFlow<ScreenEffect> = _effects.asSharedFlow()

    public val revision: ULong get() = _revision

    /**
     * One event in, one state out, and the effects after the state.
     *
     * **The state is published BEFORE the effects are emitted.** A shell that
     * ran an effect first could deliver its answer as an event before the state
     * that asked for it was visible, and the reducer would then be handed an
     * answer to a question it had not yet been recorded as asking.
     */
    public suspend fun send(event: E) {
        val step = reducing.withLock {
            val step = machine.reduce(_state.value, event)
            _revision += 1uL
            _state.value = step.state
            step
        }
        // THE EFFECTS ARE EMITTED OUTSIDE THE LOCK. `emit` suspends when the
        // buffer is full, and suspending there would hold the reduce lock while
        // waiting for a runner that may itself be trying to send — which is the
        // deadlock this ordering exists to avoid. The state is already
        // published, so the claim above ("the state is visible before the
        // effects") still holds.
        step.effects.forEach { _effects.emit(it) }
    }

    public companion object {
        /**
         * A screen's effects are a handful per event. The buffer is what keeps
         * [send] from suspending while a runner that IS collecting is busy
         * serving the last one.
         *
         * **It is not a mailbox for a runner that has not subscribed yet, and
         * it never was.** `replay = 0` means an effect emitted with no
         * collector is dropped, buffer or no buffer — this doc used to claim
         * the opposite ("so `send` does not suspend on a shell that has not
         * attached its runner yet"), and on that reading two runners started
         * their collectors with a plain `launch` and raced the screen's first
         * `ReadPage`. Home's tiles sat `LOADING` for ever on the launches the
         * race lost. Both start `UNDISPATCHED` now; `HomeRuntime.start` carries
         * the argument.
         */
        public const val EFFECT_BUFFER: Int = 32
    }
}
