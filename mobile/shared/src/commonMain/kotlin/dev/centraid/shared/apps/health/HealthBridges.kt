package dev.centraid.shared.apps.health

import centraid.screen.v1.HealthConnectEvent
import centraid.screen.v1.HealthConnectState
import centraid.screen.v1.HealthHomeEvent
import centraid.screen.v1.HealthHomeState
import centraid.screen.v1.HealthMetricEvent
import centraid.screen.v1.HealthMetricState
import centraid.screen.v1.HealthWorkoutEvent
import centraid.screen.v1.HealthWorkoutState
import com.squareup.wire.Message
import com.squareup.wire.ProtoAdapter
import dev.centraid.shared.kit.ScreenBridge
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * WHAT BOTH SHELLS HOLD FOR ONE HEALTH SCREEN THAT READS (#1129). Money's bridge shape: bytes
 * across to SwiftUI, nothing `suspend`, and only the screen ever leaves; the raw answers stay in
 * [HealthHeld]. Each screen names a subclass so the Swift symbol is the screen's own.
 */
public open class HealthBridge<S : Message<S, *>, E : Message<E, *>>(
    machine: ScreenMachine<HealthHeld<S>, HealthInput<E>>,
    private val events: ProtoAdapter<E>,
    private val wire: (HomeSession, ScreenHost<HealthHeld<S>, HealthInput<E>>, () -> Boolean) -> Unit,
    dispatcher: CoroutineDispatcher = Dispatchers.Main,
) {
    /** One host per bridge, never re-created (`ChangeStream.route` holds it). */
    public val host: ScreenHost<HealthHeld<S>, HealthInput<E>> = ScreenHost(machine)

    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + dispatcher)
    private var onState: ((ByteArray) -> Unit)? = null
    private var outliving: CoroutineScope? = null

    @kotlin.concurrent.Volatile
    private var hasLeft: Boolean = false

    /** Put this screen on the session's core, once per bridge, and publish. */
    public fun attach(session: HomeSession) {
        outliving = session.outliving
        wire(session, host) { hasLeft }
        scope.launch {
            host.state.map { it.screen }.distinctUntilChanged().collect { onState?.invoke(it.encode()) }
        }
    }

    /** The screen a view draws, now (Compose). */
    public val screen: S get() = host.state.value.screen

    /** Publish every screen state to [onState], starting with the current one. */
    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        onState(screen.encode())
    }

    /** Forward one event, encoded (SwiftUI). */
    public fun send(event: ByteArray) {
        forward(events.decode(event))
    }

    /** Forward one event (Compose). */
    public fun forward(event: E) {
        hasLeft = false
        scope.launch { host.send(HealthInput.View(event)) }
    }

    /** The current screen state, encoded. */
    public fun current(): ByteArray = screen.encode()

    /** Close = done: the machine's `left` runs on the session's scope, then the bridge's is released. */
    public fun leave() {
        hasLeft = true
        val event = host.machine.left()
        if (event != null) outliving?.launch(start = CoroutineStart.UNDISPATCHED) { host.send(event) }
        scope.cancel()
    }
}

public class HealthHomeBridge :
    HealthBridge<HealthHomeState, HealthHomeEvent>(
        machine = HealthHomeMachine,
        events = HealthHomeEvent.ADAPTER,
        wire = { session, host, left -> session.attachQueries(host, HealthHomeReads, left = left) },
    ) {
    /** Land on [destination], with the phone's facts as the shell last stated them. */
    public fun open(destination: HealthHomeState.Destination) {
        forward(HealthHomeEvent(opened = HealthHomeEvent.Opened(destination = destination, device = HealthDevices.current)))
    }

    /** Swift cannot omit a Kotlin default argument: this is Today, spelled out. */
    public fun open() {
        open(HealthHomeState.Destination.DESTINATION_TODAY)
    }
}

public class HealthMetricBridge :
    HealthBridge<HealthMetricState, HealthMetricEvent>(
        machine = HealthMetricMachine,
        events = HealthMetricEvent.ADAPTER,
        wire = { session, host, left -> session.attachQueries(host, HealthMetricReads, left = left) },
    ) {
    /** [metric] is its key (`steps`); [parent] is the pushing page's own title. */
    public fun open(metric: String, parent: String) {
        forward(HealthMetricEvent(opened = HealthMetricEvent.Opened(metric = metric, parent = parent, device = HealthDevices.current)))
    }
}

public class HealthWorkoutBridge :
    HealthBridge<HealthWorkoutState, HealthWorkoutEvent>(
        machine = HealthWorkoutMachine,
        events = HealthWorkoutEvent.ADAPTER,
        wire = { session, host, left -> session.attachQueries(host, HealthWorkoutReads, left = left) },
    ) {
    public fun open(activityId: String, parent: String) {
        forward(HealthWorkoutEvent(opened = HealthWorkoutEvent.Opened(activity_id = activityId, parent = parent, device = HealthDevices.current)))
    }
}

/**
 * `health.connect`, both shells. It reads nothing; `ConnectTapped` is the shell's cue to ask the
 * OS for `HealthConnectState.chosen` and then call [HealthConnectBridge.connect], and to report
 * back with [connected] or [failed].
 */
public class HealthConnectScreenBridge :
    ScreenBridge<HealthConnectState, HealthConnectEvent>(
        machine = HealthConnectMachine,
        events = HealthConnectEvent.ADAPTER,
        wire = { },
    ) {
    public fun open(parent: String) {
        forward(HealthConnectEvent(opened = HealthConnectEvent.Opened(parent = parent, device = HealthDevices.current)))
    }

    /** The store is connected and the first read ran. */
    public fun connected() {
        forward(HealthConnectEvent(connected = HealthConnectEvent.Connected()))
    }

    /** The OS or the vault refused; [sentence] is the shell's own words, or empty for Health's. */
    public fun failed(sentence: String) {
        forward(HealthConnectEvent(failed = HealthConnectEvent.Failed(sentence = sentence)))
    }
}
