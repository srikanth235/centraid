package dev.centraid.android.session

import android.content.Context
import centraid.core.v1.BrowseGateways
import centraid.core.v1.EffectDone
import centraid.core.v1.EffectResult
import centraid.core.v1.GatewaySighting
import centraid.core.v1.GatewaysSighted
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * THE PERFORMER OF `BrowseGateways` (#1135, #1152). `on: true` starts a browse for the screen that
 * asked and keeps it going until `on: false` or that screen is closed: one window of `window_ms`,
 * answered as `GatewaysSighted` with everything it resolved, then again every `repeat_ms` (0: once),
 * all under the one effect id. A window that finds nothing is an empty answer. The window, the
 * cadence and what the sightings mean are Rust's; this runs the browse and reports.
 *
 * A browse belongs to the screen INSTANCE that asked: a second `BrowseGateways` from it replaces its
 * first, and [retain] ends the browse of every instance the runtime closed. [window] is the one
 * window over `NsdManager` in production, a fake in tests.
 */
internal class GatewayBrowsing(
    private val scope: CoroutineScope,
    private val window: suspend (windowMs: Long) -> List<ResolvedService>,
) {
    constructor(context: Context, scope: CoroutineScope) : this(scope, { windowMs ->
        GatewayBrowseRun(NsdServiceFinder(context), NsdAddressResolver(context), windowMs).run()
    })

    private val browses = HashMap<Long, Job>()

    /** Begin [browse] for [instance] (replacing its earlier one), answering through [answer]; or end it on `on: false`. */
    fun perform(instance: Long, browse: BrowseGateways, answer: (EffectResult) -> Unit): EffectResult? {
        stop(instance)
        if (!browse.on) return EffectResult(done = EffectDone())
        val windowMs = Integer.toUnsignedLong(browse.window_ms)
        val repeatMs = Integer.toUnsignedLong(browse.repeat_ms)
        val job = scope.launch {
            while (true) {
                val found = window(windowMs)
                // A browse stopped during its window answers nothing.
                ensureActive()
                answer(EffectResult(gateways_sighted = GatewaysSighted(sightings = found.map(::sighting))))
                if (repeatMs == 0L) break
                delay(repeatMs)
            }
        }
        synchronized(browses) { browses[instance] = job }
        // A once-browse that has answered is done; its entry goes with it.
        job.invokeOnCompletion { synchronized(browses) { if (browses[instance] === job) browses.remove(instance) } }
        return null
    }

    /** End [instance]'s browse, if it has one. */
    fun stop(instance: Long) {
        synchronized(browses) { browses.remove(instance) }?.cancel()
    }

    /** A BROWSE LASTS AS LONG AS THE SCREEN THAT ASKED FOR IT: end every one whose instance is not in [open]. */
    fun retain(open: Set<Long>) {
        val closed = synchronized(browses) { browses.keys.filter { it !in open } }
        closed.forEach(::stop)
    }

    private fun sighting(service: ResolvedService) = GatewaySighting(
        service_name = service.serviceName,
        txt = service.txt,
        addresses = service.addresses,
    )
}
