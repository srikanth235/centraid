package dev.centraid.android.session

import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeoutOrNull

// THE ANDROID HALF OF Q-1080-D3: ASK THE LAN WHERE A GATEWAY WENT.
//
// Rust decides WHEN to browse (the screen that asked, `BrowseGateways`), WHICH sighting is which
// gateway (the TXT `gw`, never the instance name; `crates/screens/src/pairing/matching.rs`) and what
// the core does with the answer (`refresh_destination` dials each offered address with the pinned
// certificate and keeps only the ones that answer as that gateway). This file is the browse's pure
// rules and its one window, over two seams (`ServiceFinder`, `AddressResolver`) that `NsdBrowse.kt`
// fills with `NsdManager` and the unit tests fill with fakes. It is the mirror of iOS's
// `GatewayBrowser.swift`.
//
// ANDROID RESOLVES BEFORE IT FILTERS. A discovered `NsdServiceInfo` carries a name and no TXT record:
// the attributes arrive only with the resolve. So every advertisement of the gateway service type is
// resolved, and the ones whose TXT carries no `gw` are dropped THEN, where iOS drops them before it
// connects. The outcome is the same (a result with no `gw` is never reported); the cost is one
// resolve for an advertisement that cannot be a gateway the core would accept.

/** THE BROWSE'S PURE RULES: what a TXT record must carry, and how a resolved endpoint is spelled. */
internal object GatewayBrowse {
    /** The service type `serve` advertises (Rust's `pairing::matching`). */
    const val SERVICE_TYPE = "_centraid-gateway._tcp"

    /** The TXT key carrying the gateway's id (Rust's `pairing::matching`). */
    const val ID_KEY = "gw"

    /**
     * Whether a TXT record claims an id at all. This is only the filter that decides what is worth
     * reporting; whether the id is the paired gateway's is Rust's (`pairing::matching`), and whether
     * the machine IS that gateway is the core's.
     */
    fun claimsGateway(txt: Map<String, String>): Boolean =
        txt.any { (key, value) -> key.equals(ID_KEY, ignoreCase = true) && value.isNotBlank() }

    /**
     * `a.b.c.d:port` or `[v6]:port`, with an interface scope (`%wlan0`) removed, or null for a port
     * no socket has. A scoped link-local address is spelled without its scope and so dropped by
     * `pairing::matching`, which is the rule: it cannot be dialled from an advertisement's own words.
     * (An `InetAddress` built from a resolve is a literal, never a name: nothing here looks one up.)
     */
    fun spelling(address: InetAddress, port: Int): String? {
        if (port !in 1..MAX_PORT) return null
        val host = address.hostAddress ?: return null
        return when (address) {
            is Inet4Address -> "$host:$port"
            is Inet6Address -> "[${host.substringBefore('%')}]:$port"
            else -> null
        }
    }

    /** A TXT map as `NsdServiceInfo.attributes` gives it (UTF-8 bytes, a flag key with no value is null) as text. */
    fun txtOf(attributes: Map<String, ByteArray?>): Map<String, String> =
        attributes.mapValues { (_, value) -> value?.toString(Charsets.UTF_8).orEmpty() }

    private const val MAX_PORT = 65_535
}

/** One service the browse saw, before it is resolved. [key] tells two sightings of one advertisement apart. */
internal data class FoundService(
    /** The DNS-SD instance name. Never an identity. */
    val name: String,
    val key: String = name,
    /** What the platform needs back to resolve it (an `NsdServiceInfo`); nothing the rules read. */
    val handle: Any? = null,
)

/** What one resolve gave: the TXT record, and `host:port` for each address. */
internal data class Resolution(val txt: Map<String, String>, val addresses: List<String>)

/** One advertisement as resolved: what a `GatewaySighting` carries to Rust. */
internal data class ResolvedService(
    val serviceName: String,
    val txt: Map<String, String>,
    val addresses: List<String>,
)

/** WHAT FINDS ADVERTISEMENTS: `NsdManager` discovery in production, a fake in tests. */
internal interface ServiceFinder {
    /**
     * Begin. [found] is given every service seen so far each time the set changes; [failed] is
     * called if the browse cannot run. Either may be called from any thread.
     */
    fun start(found: (List<FoundService>) -> Unit, failed: () -> Unit)

    /** End, and drop every handler. Idempotent. */
    fun stop()
}

/** WHAT TURNS A FOUND SERVICE INTO A TXT RECORD AND ADDRESSES: `NsdManager`'s resolve, or a fake. */
internal interface AddressResolver {
    /**
     * Resolve [service]. [completion] is called with each answer as it arrives (a platform that
     * reports addresses as they are learned may answer more than once), possibly never (an
     * advertisement that no longer answers), and never after [cancelAll]. May be called from any thread.
     */
    fun resolve(service: FoundService, completion: (Resolution) -> Unit)

    /** Cancel everything in flight. Idempotent. */
    fun cancelAll()
}

/**
 * ONE BROWSE WINDOW, FROM START TO ITS ONE ANSWER. Everything the platform says is queued and read
 * by [run] alone, so no state here is shared between threads.
 *
 * Whatever ends the window first (the clock, a finder that failed) wins; a resolve that has not
 * answered by then is left out, not waited for, and anything said later is never read. A window
 * that found nothing is an empty answer.
 */
internal class GatewayBrowseRun(
    private val finder: ServiceFinder,
    private val resolver: AddressResolver,
    private val windowMs: Long,
) {
    private sealed interface Event {
        class Saw(val services: List<FoundService>) : Event
        class Resolved(val service: FoundService, val resolution: Resolution) : Event
        data object Failed : Event
    }

    private val events = Channel<Event>(Channel.UNLIMITED)
    private val seen = mutableSetOf<String>()

    /** Instance name to what resolved so far, in first-seen order. */
    private val resolved = LinkedHashMap<String, ResolvedService>()

    /** The window's one answer. Cancelling the caller ends the window early and answers nothing. */
    suspend fun run(): List<ResolvedService> {
        try {
            finder.start(
                found = { services -> events.trySend(Event.Saw(services)) },
                failed = { events.trySend(Event.Failed) },
            )
            withTimeoutOrNull(windowMs) {
                for (event in events) {
                    when (event) {
                        is Event.Saw -> saw(event.services)
                        is Event.Resolved -> merge(event.service, event.resolution)
                        Event.Failed -> break
                    }
                }
            }
        } finally {
            finder.stop()
            resolver.cancelAll()
            events.close()
        }
        return resolved.values.toList()
    }

    private fun saw(services: List<FoundService>) {
        for (service in services) {
            if (seen.add(service.key)) {
                resolver.resolve(service) { resolution -> events.trySend(Event.Resolved(service, resolution)) }
            }
        }
    }

    private fun merge(service: FoundService, resolution: Resolution) {
        if (resolution.addresses.isEmpty() || !GatewayBrowse.claimsGateway(resolution.txt)) return
        val held = resolved[service.name]
        resolved[service.name] = if (held == null) {
            ResolvedService(service.name, resolution.txt, resolution.addresses.distinct())
        } else {
            // The same instance on another interface or family, or a later answer: one sighting.
            held.copy(addresses = held.addresses + resolution.addresses.filter { it !in held.addresses }.distinct())
        }
    }
}

/**
 * RUNS RESOLVES ONE AT A TIME: before Android 14 `NsdManager.resolveService` refuses a second
 * resolve while one is out (`FAILURE_ALREADY_ACTIVE`). A job is given a `release` to call when its
 * resolve has answered or failed; the next job starts then. [clear] drops what has not started.
 */
internal class OneAtATime {
    private val waiting = ArrayDeque<(release: () -> Unit) -> Unit>()
    private var busy = false
    private var closed = false

    /** Start [job] now, or when every job before it has released. */
    fun submit(job: (release: () -> Unit) -> Unit) {
        synchronized(this) {
            if (closed) return
            waiting.addLast(job)
        }
        next()
    }

    /** Drop every job that has not started and start none again. */
    fun clear() {
        synchronized(this) {
            closed = true
            waiting.clear()
        }
    }

    private fun next() {
        val job: ((release: () -> Unit) -> Unit)
        val release: () -> Unit
        synchronized(this) {
            if (busy || closed) return
            job = waiting.removeFirstOrNull() ?: return
            busy = true
            var released = false
            release = {
                val again = synchronized(this) {
                    // A second call from one job releases nothing.
                    if (released) false else { released = true; busy = false; true }
                }
                if (again) next()
            }
        }
        // A job that throws must not hold the line.
        runCatching { job(release) }.onFailure { release() }
    }
}
