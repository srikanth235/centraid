package dev.centraid.shared.screen

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

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
public class ScreenHost<S, E>(private val machine: ScreenMachine<S, E>) {
    private val _state = MutableStateFlow(machine.initial())
    private val _effects = MutableSharedFlow<ScreenEffect>(
        replay = 0,
        extraBufferCapacity = EFFECT_BUFFER,
    )
    private var _revision: ULong = 0uL

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
        val step = machine.reduce(_state.value, event)
        _revision += 1uL
        _state.value = step.state
        step.effects.forEach { _effects.emit(it) }
    }

    public companion object {
        /**
         * A screen's effects are a handful per event. The buffer exists so
         * `send` does not suspend on a shell that has not attached its runner
         * yet during a screen's first frame.
         */
        public const val EFFECT_BUFFER: Int = 32
    }
}
