package dev.centraid.shared.screen

import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * What SwiftUI holds instead of a `StateFlow` (#1020, wave A).
 *
 * `ScreenHost` is the right shape for Kotlin and the wrong shape for Swift:
 * `send` is `suspend` and `state` is a `StateFlow`, neither of which crosses the
 * Kotlin/Native boundary as anything a SwiftUI view can use. This is the
 * adapter, and it is deliberately the only one — `mobile/README.md` names
 * "the bridge from SwiftUI to `ScreenHost`" as the first thing an iOS session
 * connects.
 *
 * **BYTES, NOT OBJECTS.** The state crosses as an encoded `HomeState` and the
 * event arrives as an encoded `HomeEvent`, which is the same choice
 * `centraid.screen.v1.ScreenState` makes for the same reason: Swift decodes it
 * with SwiftProtobuf from the same schema Wire reads here, so one fixture
 * proves both sides. Handing Swift a Kotlin object instead would put an
 * Objective-C bridging layer between the two shells and give the contract two
 * shapes.
 *
 * Android does NOT use this: Compose collects the `StateFlow` directly, because
 * on that side it already is the right shape.
 */
public class HomeBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /**
     * The live session, once the core is open.
     *
     * Null until then, and the view draws `HomeMachine.initial()` in the
     * meantime — which is the loading grid, and is true.
     */
    private var session: HomeSession? = null
    private var onState: ((ByteArray) -> Unit)? = null

    /**
     * OPEN A VAULT, AND START PUBLISHING.
     *
     * Not in the constructor: opening a core is I/O that asserts it is not on
     * the UI thread, and a Swift `let` that blocked the main thread on SQLite
     * is the frozen app the assertion exists to catch. The paths come from the
     * shell because only the shell knows where its own data directory is.
     *
     * A LIST, because a device holds as many vaults as have been put on it and
     * the switcher needs all of them. The first that identifies is the one Home
     * opens; see [HomeSession.open].
     */
    public fun open(vaultPaths: List<String>) {
        scope.launch {
            val opened = HomeSession.open(
                vaultPaths = vaultPaths,
                dispatcher = Dispatchers.Default,
                uiThreadName = "main",
            )
            session = opened
            opened.state.collect { state -> onState?.invoke(state.encode()) }
        }
    }

    /**
     * Publish every state to [onState], starting with the current one.
     *
     * The callback fires on the main dispatcher because its only caller is a
     * SwiftUI `@Published` setter, and SwiftUI requires that. Nothing expensive
     * runs here — the reduce already happened.
     */
    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        // The FIRST state, immediately. A view that subscribed and then waited
        // for a change would draw nothing at all until a read landed.
        onState(HomeMachine.initial().encode())
    }

    /**
     * Forward one encoded event.
     *
     * Not `suspend`: a SwiftUI button cannot await, and a view that could await
     * a reducer would be a view holding the main thread while a screen thinks.
     * The launch is what keeps `send`'s ordering — one coroutine, one queue —
     * without the caller knowing there is one.
     */
    public fun send(event: ByteArray) {
        session?.send(HomeEvent.ADAPTER.decode(event))
    }

    /**
     * Redeem a pairing ticket, and call back with what happened (#1020,
     * D-1020-B7).
     *
     * Not `suspend`, for the same reason [send] is not: a SwiftUI button cannot
     * await. The callback fires on the main dispatcher because its only caller
     * is a `@Published` setter.
     *
     * A session with no core answers [PairOutcome.NoCore] rather than throwing.
     * That is the state a device is in before a vault is placed on it, and it
     * is not an error.
     */
    public fun pair(
        ticket: String,
        deviceName: String,
        platform: String,
        onOutcome: (PairOutcome) -> Unit,
    ) {
        val session = this.session ?: return onOutcome(PairOutcome.NoCore)
        scope.launch { onOutcome(session.pair(ticket, deviceName, platform)) }
    }

    /**
     * Run one sync pass.
     *
     * The pass BLOCKS the core's dispatcher for its duration — it is network
     * I/O — which is why it is launched rather than awaited and why nothing
     * here touches the UI thread beyond the callback.
     */
    public fun syncNow(onOutcome: (SyncOutcome) -> Unit) {
        val session = this.session
            ?: return onOutcome(SyncOutcome(unreachable = true, sentence = "No vault is open."))
        scope.launch { onOutcome(session.syncNow()) }
    }

    /** The current state, for a view that needs one before it subscribes. */
    public fun current(): ByteArray =
        (session?.state?.value ?: HomeMachine.initial()).encode()

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        session?.close()
        session = null
        scope.cancel()
    }

    private fun HomeState.encode(): ByteArray = HomeState.ADAPTER.encode(this)
}
