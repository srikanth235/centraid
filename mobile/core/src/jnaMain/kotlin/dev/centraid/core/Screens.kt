package dev.centraid.core

import centraid.core.v1.AppLifecycle
import centraid.core.v1.EffectRequest
import centraid.core.v1.EffectResult
import centraid.core.v1.Envelope
import centraid.core.v1.Environment
import centraid.core.v1.MemoryWarning
import centraid.core.v1.InstanceEvent
import centraid.core.v1.NavEvent
import centraid.core.v1.Navigation
import centraid.core.v1.Request
import centraid.core.v1.ScreenEvent
import centraid.core.v1.ScreenRequest
import centraid.core.v1.ScreenUpdate
import centraid.core.v1.ShellFact
import centraid.core.v1.SnapshotRequest
import centraid.core.v1.ViewState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

/**
 * THE SHELL'S WHOLE VIEW OF THE SCREEN RUNTIME (#1135, lane C2).
 *
 * Every decision a person sees is made in Rust (`crates/screens`); this class
 * only carries it. It sends events, keeps the latest [Navigation] and
 * [ViewState] per screen instance for Compose to draw, and hands the platform
 * work Rust asks for ([effects]) to the shell, which answers with [answer].
 * There is no copy, no count and no timer here, and nothing in this file names
 * a screen: a view state is a `ViewState` whichever screen made it.
 *
 * Updates arrive two ways — as the answer to a request and as a push on the
 * core's event stream ([attach]) — and both go through [apply], which drops
 * anything older than what is already held (each view carries a revision, each
 * navigation too), so a push that overtakes a response is not undone by it.
 *
 * Plain Kotlin over the existing JNA binding: no multiplatform type appears
 * here, so this file moves unchanged when `:core` stops being KMP.
 */
public class Screens(
    /** The core the runtime stands on: the shell's effect performers reach its doors through it. */
    public val core: CentraidCore,
    private val scope: CoroutineScope,
) {
    private val navigationState = MutableStateFlow<Navigation?>(null)
    private val viewStates = MutableStateFlow<Map<Long, ViewState>>(emptyMap())
    private val pendingEffects = Channel<EffectRequest>(Channel.UNLIMITED)

    /** Instances Rust closed: a late push for one must not bring it back. */
    private val closedInstances = mutableSetOf<Long>()

    /** The route stack per tab and the selected tab, or `null` before [start]. */
    public val navigation: StateFlow<Navigation?> = navigationState.asStateFlow()

    /** The latest view state of every open screen instance, by instance id. */
    public val views: StateFlow<Map<Long, ViewState>> = viewStates.asStateFlow()

    /** Platform work Rust asks for; each is answered once with [answer]. */
    public val effects: Flow<EffectRequest> = pendingEffects.receiveAsFlow()

    /** Start applying the updates the core pushes. Call once, before [start]. */
    public fun attach(): Job = scope.launch {
        core.events.collect { event -> event.screen?.let(::apply) }
    }

    /** Open the tabs' roots (the first call) and fetch everything. */
    public suspend fun start(): CoreOutcome<Unit> =
        request(ScreenRequest(snapshot = SnapshotRequest()))

    /** Send an event to one screen instance. */
    public suspend fun send(instance: Long, event: ScreenEvent): CoreOutcome<Unit> =
        request(ScreenRequest(send = InstanceEvent(instance = instance, event = event)))

    /** Report a tap on a link or a back-swipe; Rust moves the stack. */
    public suspend fun navigate(event: NavEvent): CoreOutcome<Unit> =
        request(ScreenRequest(nav = event))

    /** Report the device's locale and zone; Rust formats from them. */
    public suspend fun environment(locale: String, zone: String, platform: String = "android"): CoreOutcome<Unit> =
        request(ScreenRequest(environment = Environment(locale = locale, zone = zone, platform = platform)))

    /** Report the app's foreground or background; Rust's screens and the Locker's relock hear it. */
    public suspend fun lifecycle(foreground: Boolean): CoreOutcome<Unit> =
        request(ScreenRequest(lifecycle = AppLifecycle(foreground = foreground)))

    /**
     * Report a fact about the phone: the link, a background window the OS granted, the vaults
     * held, an upload the OS finished. The pass scheduler in Rust decides what it means.
     */
    public suspend fun shellFact(fact: ShellFact): CoreOutcome<Unit> =
        request(ScreenRequest(shell_fact = fact))

    /**
     * The operating system is asking for memory back (iOS `didReceiveMemoryWarning`,
     * Android `onTrimMemory`): the shelf closes every vault's core but the one in front.
     */
    public suspend fun memoryWarning(): CoreOutcome<Unit> =
        request(ScreenRequest(memory_warning = MemoryWarning()))

    /** Answer an effect the shell performed. */
    public suspend fun answer(effect: EffectRequest, result: EffectResult): CoreOutcome<Unit> =
        send(
            effect.instance,
            ScreenEvent(effect_result = result.copy(effect_id = effect.effect_id)),
        )

    private suspend fun request(screen: ScreenRequest): CoreOutcome<Unit> =
        when (val outcome = core.call(Envelope(request_id = 0, request = Request(screen = screen)))) {
            is CoreOutcome.Failed -> outcome
            is CoreOutcome.Answered -> {
                outcome.value.response?.screen?.update?.let(::apply)
                CoreOutcome.Answered(Unit)
            }
        }

    private fun apply(update: ScreenUpdate) {
        update.navigation?.let { incoming ->
            navigationState.value = navigationState.value
                ?.takeIf { it.revision > incoming.revision }
                ?: incoming
        }
        if (update.views.isNotEmpty() || update.closed.isNotEmpty()) {
            viewStates.value = viewStates.value.toMutableMap().apply {
                update.closed.forEach {
                    closedInstances.add(it)
                    remove(it)
                }
                update.views.forEach { view ->
                    if (view.instance !in closedInstances &&
                        (this[view.instance]?.revision ?: -1L) < view.revision
                    ) {
                        this[view.instance] = view
                    }
                }
            }
        }
        update.effects.forEach { pendingEffects.trySend(it) }
    }
}
