package dev.centraid.android.session

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import androidx.annotation.RequiresApi
import java.net.InetAddress
import java.util.concurrent.Executor

// THE PLATFORM'S HALF OF THE GATEWAY BROWSE: `NsdManager` over `_centraid-gateway._tcp`.
//
// THE PHONE ONLY BROWSES. `discoverServices` sends a multicast question and reads the answers;
// nothing here is `registerService`, a `ServerSocket` or an `accept`, and the phone advertises
// nothing. (`no-listening-socket` scans Rust, and this is not Rust; the doctrine is SECURITY.md's,
// and this file is where it is kept on Android.) A browse needs no connect of its own: `NsdManager`
// resolves a service to its address and its TXT record, so unlike iOS no TCP handshake is made.
//
// NOTHING HERE IS TRUSTED. An address in a sighting is what some machine on the network said;
// Rust's `pairing::matching` drops names, loopback, multicast and IPv6 link-local ones, and the core
// proves identity by the pinned certificate and `/v2/info` before it keeps any.

/**
 * `NsdManager.discoverServices` for the gateway type, with a multicast lock held for exactly as
 * long as the window runs: many handsets drop mDNS replies without one. The lock is acquired by
 * [start] and released by [stop], which a window always calls, however it ends.
 */
internal class NsdServiceFinder(context: Context) : ServiceFinder {
    private val context: Context = context.applicationContext
    private val manager = this.context.getSystemService(Context.NSD_SERVICE) as NsdManager

    private var listener: NsdManager.DiscoveryListener? = null
    private var lock: WifiManager.MulticastLock? = null

    /** Every service seen so far, by instance name (the same service shows once per interface on some builds). */
    private val seen = LinkedHashMap<String, FoundService>()

    @Volatile private var live = false

    @Synchronized
    override fun start(found: (List<FoundService>) -> Unit, failed: () -> Unit) {
        live = true
        lock = runCatching {
            val wifi = context.getSystemService(Context.WIFI_SERVICE) as WifiManager
            wifi.createMulticastLock(LOCK_TAG).apply {
                setReferenceCounted(false)
                acquire()
            }
        }.getOrNull()
        val discovery = object : NsdManager.DiscoveryListener {
            override fun onServiceFound(info: NsdServiceInfo) {
                if (!live) return
                val all = synchronized(seen) {
                    seen.getOrPut(info.serviceName) { FoundService(name = info.serviceName, handle = info) }
                    seen.values.toList()
                }
                found(all)
            }

            override fun onServiceLost(info: NsdServiceInfo) = Unit

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                if (live) failed()
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit

            override fun onDiscoveryStarted(serviceType: String) = Unit

            override fun onDiscoveryStopped(serviceType: String) = Unit
        }
        listener = discovery
        // A refused start is a window that found less, never one that raises.
        runCatching {
            manager.discoverServices(GatewayBrowse.SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discovery)
        }.onFailure { failed() }
    }

    @Synchronized
    override fun stop() {
        live = false
        // Stopping a discovery the platform has not yet started throws; either way it is over.
        listener?.let { runCatching { manager.stopServiceDiscovery(it) } }
        listener = null
        lock?.let { runCatching { if (it.isHeld) it.release() } }
        lock = null
    }

    private companion object {
        const val LOCK_TAG = "centraid-gateway-browse"
    }
}

/**
 * `NsdManager`'s resolve, for the TXT record and the addresses a found service carries.
 *
 * From Android 14 a service-info callback reports every address as it is learned, so one
 * advertisement may answer more than once and [GatewayBrowseRun] merges the answers. Before it,
 * `resolveService` gives one address and runs one at a time (`FAILURE_ALREADY_ACTIVE` otherwise),
 * so the resolves queue behind each other; a resolve the platform refuses is left out of this window
 * and asked again by the next. Window-bounded like everything else: [cancelAll] withdraws what is
 * out and drops what is queued.
 */
internal class NsdAddressResolver(context: Context) : AddressResolver {
    private val manager = context.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val line = OneAtATime()
    private val callbacks = mutableListOf<Any>()

    @Volatile private var cancelled = false

    override fun resolve(service: FoundService, completion: (Resolution) -> Unit) {
        val info = service.handle as? NsdServiceInfo ?: return
        if (cancelled) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            watch(info, completion)
        } else {
            line.submit { release -> resolveOnce(info, completion, release) }
        }
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private fun watch(info: NsdServiceInfo, completion: (Resolution) -> Unit) {
        val callback = object : NsdManager.ServiceInfoCallback {
            override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) = Unit

            override fun onServiceUpdated(updated: NsdServiceInfo) {
                if (!cancelled) completion(read(updated, updated.hostAddresses))
            }

            override fun onServiceLost() = Unit

            override fun onServiceInfoCallbackUnregistered() = Unit
        }
        synchronized(callbacks) { callbacks += callback }
        runCatching { manager.registerServiceInfoCallback(info, DIRECT, callback) }
    }

    @Suppress("DEPRECATION")
    private fun resolveOnce(info: NsdServiceInfo, completion: (Resolution) -> Unit, release: () -> Unit) {
        val listener = object : NsdManager.ResolveListener {
            override fun onResolveFailed(failed: NsdServiceInfo, errorCode: Int) = release()

            override fun onServiceResolved(resolved: NsdServiceInfo) {
                release()
                if (!cancelled) completion(read(resolved, listOfNotNull(resolved.host)))
            }
        }
        runCatching { manager.resolveService(info, listener) }.onFailure { release() }
    }

    override fun cancelAll() {
        cancelled = true
        line.clear()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val held = synchronized(callbacks) { callbacks.toList().also { callbacks.clear() } }
            held.forEach { callback ->
                (callback as? NsdManager.ServiceInfoCallback)?.let { runCatching { manager.unregisterServiceInfoCallback(it) } }
            }
        }
    }

    /** The TXT record and `host:port` for each of [addresses], as the platform resolved them. */
    private fun read(info: NsdServiceInfo, addresses: List<InetAddress>): Resolution = Resolution(
        txt = GatewayBrowse.txtOf(info.attributes),
        addresses = addresses.mapNotNull { GatewayBrowse.spelling(it, info.port) }.distinct(),
    )

    private companion object {
        /** The callback only queues the answer; it needs no thread of its own. */
        val DIRECT = Executor { it.run() }
    }
}
