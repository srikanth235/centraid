package dev.centraid.shared.apps.health

import centraid.screen.v1.HealthConnectEvent
import centraid.screen.v1.HealthConnectState
import centraid.screen.v1.HealthDevice
import centraid.screen.v1.HealthHomeEvent
import centraid.screen.v1.HealthHomeState
import centraid.screen.v1.HealthMetricEvent
import centraid.screen.v1.HealthWorkoutEvent
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavMove
import dev.centraid.shared.nav.ScreenMove
import dev.centraid.shared.nav.ScreenMoves

/**
 * WHERE HEALTH'S INTENTS GO, ONCE (#1129). A Health machine that emits Connect, a metric, a
 * workout or "Choose what to read" changes nothing on them; the shell moves. Android applies the
 * [NavMove]; iOS asks [route] for the same move spelled. Every push hands the pushed page the
 * pushing page's own title as its `parent` (empty reads "Health").
 *
 * Two intents are not moves and are the shell's own acts: `HealthHomeEvent.StopConfirmed` is
 * `HealthConnectBridge.stop`, and `HealthConnectEvent.ConnectTapped` is the OS's authorization
 * for `HealthConnectState.chosen` followed by `HealthConnectBridge.connect`; the shell reports the
 * outcome back as `Connected` (which pops) or `Failed`.
 */
public object HealthRouting {
    public fun home(event: HealthHomeEvent, state: HealthHomeState): Destination? {
        val here = state.chrome?.title.orEmpty()
        return when {
            event.connect != null -> Destination.HealthConnect(parent = here)
            event.more?.key == HealthHomeMachine.MORE_CHOOSE -> Destination.HealthConnect(parent = here)
            event.metric != null -> HealthMetrics.ofKey(event.metric.metric)?.let { Destination.HealthMetric(it.key, here) }
            event.workout != null -> event.workout.activity_id.takeIf { it.isNotEmpty() }?.let { Destination.HealthWorkout(it, here) }
            else -> null
        }
    }

    /** Connected is the pop back to where Connect was opened from. */
    public fun connect(event: HealthConnectEvent, state: HealthConnectState): NavMove? =
        if (event.connected != null) NavMove.Pop else null

    /**
     * THE SAME DECISIONS FOR A SHELL THAT SENDS BYTES: [event] is what screen [screenId] just
     * forwarded and [state] that screen's own state. Null for an event that moves nothing, a
     * screen that is not Health's, or bytes that do not decode.
     */
    public fun route(screenId: String, event: ByteArray, state: ByteArray): ScreenMove? {
        val move = runCatching {
            when (screenId) {
                HealthHomeMachine.SCREEN_ID ->
                    home(HealthHomeEvent.ADAPTER.decode(event), HealthHomeState.ADAPTER.decode(state))?.let(NavMove::push)
                HealthConnectMachine.SCREEN_ID ->
                    connect(HealthConnectEvent.ADAPTER.decode(event), HealthConnectState.ADAPTER.decode(state))
                else -> null
            }
        }.getOrNull()
        return ScreenMoves.of(move)
    }

    /**
     * A ROUTE'S `Opened`, AS IT IS SENT ON ARRIVAL, with the phone's facts ([HealthDevices]) stamped
     * on it — what each bridge's `open(...)` does for Android, so a shell that sends bytes never
     * spells them. Every other screen's event, and bytes that do not decode, come back as they are.
     */
    public fun opened(screenId: String, opened: ByteArray): ByteArray = runCatching {
        val device: HealthDevice = HealthDevices.current
        when (screenId) {
            HealthHomeMachine.SCREEN_ID -> HealthHomeEvent.ADAPTER.decode(opened).let { e ->
                e.copy(opened = e.opened?.copy(device = device)).encode()
            }
            HealthMetricMachine.SCREEN_ID -> HealthMetricEvent.ADAPTER.decode(opened).let { e ->
                e.copy(opened = e.opened?.copy(device = device)).encode()
            }
            HealthWorkoutMachine.SCREEN_ID -> HealthWorkoutEvent.ADAPTER.decode(opened).let { e ->
                e.copy(opened = e.opened?.copy(device = device)).encode()
            }
            HealthConnectMachine.SCREEN_ID -> HealthConnectEvent.ADAPTER.decode(opened).let { e ->
                e.copy(opened = e.opened?.copy(device = device)).encode()
            }
            else -> opened
        }
    }.getOrDefault(opened)
}
